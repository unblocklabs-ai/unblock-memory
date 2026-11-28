import { setImmediate } from "node:timers/promises";
import { DEFAULTS } from "./defaults.js";
import { INSIDE_OUT_VALENCE_SQL } from "./emotion-baselines.js";
import { jsonHash } from "./json-hash.js";
import { immediateTransaction, openMemoryDatabase, readTableColumns, tableExists } from "./memory-database.js";
import { responseOutcome } from "./response-outcome.js";
import { WorkFenceLostError } from "./work-store.js";
export const OUTCOME_LEDGER_KIND = "outcome_ledger";
const DAY_MS = 86_400_000;
/** Wall-clock slice after which the scoring loop yields to the event loop. */
const YIELD_SLICE_MS = 15;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_outcomes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK(subject_kind IN ('memory_hit','skill','person_whisper')),
    subject_id TEXT NOT NULL,
    recipe_hash TEXT NOT NULL DEFAULT 'default',
    verdict TEXT NOT NULL CHECK(verdict IN ('helped','ignored','hurt')),
    confidence REAL NOT NULL CHECK(confidence BETWEEN 0.0 AND 1.0),
    evidence_turn_id TEXT NOT NULL,
    session_id TEXT,
    signals_json TEXT NOT NULL CHECK(json_valid(signals_json)),
    measured_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_outcomes_agent_time ON memory_outcomes(agent_id, measured_at);
  CREATE INDEX IF NOT EXISTS memory_outcomes_subject ON memory_outcomes(agent_id, subject_kind, subject_id);
  CREATE INDEX IF NOT EXISTS memory_outcomes_recipe ON memory_outcomes(agent_id, recipe_hash, verdict);
`;
function ensureOutcomeSchema(db) {
    // This checkout keeps the component registry in memory-database.ts.
    const ready = () => {
        if (!tableExists(db, "memory_schema"))
            return false;
        const version = db.prepare("SELECT version FROM memory_schema WHERE component=?").get(OUTCOME_LEDGER_KIND)?.version;
        if (version !== undefined && version !== 1)
            throw new Error("Unsupported outcome ledger schema version");
        return version === 1 && tableExists(db, "memory_outcomes");
    };
    if (ready())
        return;
    immediateTransaction(db, () => {
        if (ready())
            return;
        db.exec("CREATE TABLE IF NOT EXISTS memory_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT");
        db.exec(SCHEMA);
        db.prepare("INSERT OR IGNORE INTO memory_schema(component,version) VALUES (?,1)").run(OUTCOME_LEDGER_KIND);
    });
}
export class OutcomeLedgerStore {
    db;
    #owned;
    constructor(database, options = {}) {
        this.#owned = typeof database === "string";
        this.db = typeof database === "string" ? openMemoryDatabase(database, options) : database;
        try {
            ensureOutcomeSchema(this.db);
        }
        catch (error) {
            if (this.#owned)
                this.db.close();
            throw error;
        }
    }
    close() { if (this.#owned)
        this.db.close(); }
}
const stringOrNull = (value) => typeof value === "string" && value !== "" ? value : null;
function readWatermark(json) {
    if (json === null)
        return { schemaVersion: 1, lastMeasuredAtMs: 0 };
    const value = JSON.parse(json);
    const sweep = value?.sweep;
    if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.lastMeasuredAtMs) ||
        (value.valenceAttributionRepaired !== undefined && value.valenceAttributionRepaired !== true) ||
        (sweep && (!Number.isSafeInteger(sweep.from) || !Number.isSafeInteger(sweep.through) ||
            !sweep.after || !Number.isSafeInteger(sweep.after.at) ||
            !["memory_hit", "skill", "person_whisper"].includes(sweep.after.kind) ||
            typeof sweep.after.evidence !== "string" || typeof sweep.after.subject !== "string"))) {
        throw new Error("Invalid outcome ledger watermark");
    }
    return value;
}
/** Read one page of distinct subjects. The tuple cursor also works when a turn contributes more rows than the cap. */
function exposures(db, agentId, sweep, limit) {
    const sources = [];
    if (tableExists(db, "recall_queries") && tableExists(db, "recall_hits")) {
        const recipe = readTableColumns(db, "recall_queries").has("recipe_hash") ? "q.recipe_hash" : "NULL";
        sources.push(`SELECT q.created_at_ms at, 'memory_hit' kind, 'query:'||q.event_key evidence, h.source_path subject,
      q.id source_id, q.session_id session, q.session_key session_key, q.run_id run, ${recipe} recipe,
      max(h.disposition IN ('emitted','returned')) delivered, q.provider, q.account_id account, q.sender_id sender
      FROM recall_queries q JOIN recall_hits h ON h.query_id=q.id, bounds b
      WHERE q.agent_id=b.agent AND q.source!='drift_rerun' AND q.created_at_ms BETWEEN b.since AND b.until
      GROUP BY q.id,h.source_path`);
    }
    if (tableExists(db, "skill_routing_events")) {
        const recipe = readTableColumns(db, "skill_routing_events").has("recipe_hash") ? "s.recipe_hash" : "NULL";
        sources.push(`SELECT DISTINCT s.created_at_ms, 'skill', 'route:'||s.event_key, j.value,
      s.id, s.session_id, s.session_key, s.run_id, ${recipe}, 1, NULL, NULL, NULL
      FROM skill_routing_events s JOIN json_each(s.emitted_json) j, bounds b
      WHERE s.agent_id=b.agent AND s.created_at_ms BETWEEN b.since AND b.until AND j.type='text' AND j.value!=''`);
    }
    if (tableExists(db, "person_whisper_receipts")) {
        const recipe = readTableColumns(db, "person_whisper_receipts").has("recipe_hash") ? "p.recipe_hash" : "NULL";
        sources.push(`SELECT CAST(round(unixepoch(min(p.injected_at),'subsec')*1000) AS INTEGER), 'person_whisper',
      'receipt:'||p.run_id, p.person_id,
      0, NULL, NULL, p.run_id, ${recipe}, 1, NULL, NULL, NULL
      FROM person_whisper_receipts p GROUP BY p.person_id,p.run_id`);
    }
    if (!sources.length)
        return [];
    const c = sweep.after;
    return db.prepare(`WITH bounds(agent,since,until) AS (VALUES (?,?,?)),
    exposures(at,kind,evidence,subject,source_id,session,session_key,run,recipe,delivered,provider,account,sender) AS (
      ${sources.join(" UNION ALL ")}
    )
    SELECT e.* FROM exposures e, bounds b WHERE e.at BETWEEN b.since AND b.until
      AND (e.at,e.kind,e.evidence,e.subject)>(?,?,?,?)
    ORDER BY e.at,e.kind,e.evidence,e.subject LIMIT ?`)
        .all(agentId, Math.max(sweep.from, c?.at ?? sweep.from), sweep.through, c?.at ?? sweep.from - 1, c?.kind ?? "", c?.evidence ?? "", c?.subject ?? "", limit);
}
function decodeExposure(row) {
    return {
        at: Number(row.at), kind: row.kind, evidence: String(row.evidence), subject: String(row.subject),
        sourceId: Number(row.source_id), session: stringOrNull(row.session), sessionKey: stringOrNull(row.session_key),
        run: stringOrNull(row.run), recipe: typeof row.recipe === "string" ? row.recipe : null, delivered: row.delivered === 1,
        provider: stringOrNull(row.provider), account: stringOrNull(row.account), sender: stringOrNull(row.sender),
    };
}
function evidenceReader(db, options, windowMs, lookbackMs) {
    const { agentId } = options;
    const routes = tableExists(db, "skill_routing_events");
    const queries = tableExists(db, "recall_queries");
    const reads = tableExists(db, "recall_reads");
    const opens = tableExists(db, "skill_open_events");
    const clocks = [
        ...(routes ? ["SELECT run_id,session_id,created_at_ms at FROM skill_routing_events WHERE agent_id=:agent AND created_at_ms BETWEEN :from AND :through"] : []),
        ...(queries ? ["SELECT run_id,session_id,created_at_ms at FROM recall_queries WHERE agent_id=:agent AND created_at_ms BETWEEN :from AND :through AND source='whisperer'"] : []),
    ];
    const nextTurn = clocks.length ? db.prepare(`SELECT min(at) at FROM (${clocks.join(" UNION ALL ")})
    WHERE session_id=:session AND nullif(run_id,'') IS NOT NULL AND run_id IS NOT :run`) : undefined;
    const runSessions = [
        ...clocks,
        ...(queries ? ["SELECT run_id,session_id,created_at_ms at FROM recall_queries WHERE agent_id=:agent AND created_at_ms BETWEEN :from AND :through AND source='tool'"] : []),
        ...(reads ? ["SELECT run_id,session_id,read_at_ms at FROM recall_reads WHERE agent_id=:agent AND read_at_ms BETWEEN :from AND :through"] : []),
        ...(opens ? ["SELECT run_id,session_id,created_at_ms at FROM skill_open_events WHERE agent_id=:agent AND created_at_ms BETWEEN :from AND :through"] : []),
    ];
    const resolveSession = runSessions.length ? db.prepare(`SELECT min(session_id) session FROM (${runSessions.join(" UNION ALL ")})
    WHERE run_id=:run AND nullif(session_id,'') IS NOT NULL HAVING count(DISTINCT session_id)=1`) : undefined;
    const matchRead = reads && queries && tableExists(db, "recall_hits") ? db.prepare(`SELECT 1 FROM recall_reads r
    WHERE r.agent_id=:agent AND r.source_path=:path AND r.status='ok' AND r.read_at_ms BETWEEN :from AND :through
    AND (nullif(r.run_id,'') IS NULL OR :run IS NULL OR r.run_id=:run)
    AND (nullif(r.session_id,'') IS NULL OR :session IS NULL OR r.session_id=:session)
    AND (r.session_id=:session OR r.run_id=:run)
    AND EXISTS (SELECT 1 FROM recall_hits h WHERE h.query_id=:query AND h.source_path=r.source_path
      AND coalesce(r.start_line,1)<=h.end_line AND (r.line_count IS NULL
        OR (r.line_count>0 AND coalesce(r.start_line,1)+r.line_count-1>=h.start_line)))
    LIMIT 1`) : undefined;
    const matchOpen = opens ? db.prepare(`SELECT 1 FROM skill_open_events s
    WHERE s.agent_id=:agent AND s.skill_path=:path AND s.created_at_ms BETWEEN :from AND :through
    AND (nullif(s.run_id,'') IS NULL OR :run IS NULL OR s.run_id=:run)
    AND (nullif(s.session_id,'') IS NULL OR :session IS NULL OR s.session_id=:session)
    AND (s.session_id=:session OR s.run_id=:run OR s.session_key=:sessionKey)
    LIMIT 1`) : undefined;
    // Without a configured cohort Response Audit is disabled; historical cohorts are not current evidence.
    const audit = options.responseCohort !== undefined && tableExists(db, "response_results")
        ? db.prepare(`SELECT id,episode_at,CASE WHEN status='ok' THEN result END result FROM response_results
    WHERE cohort=:cohort AND session_id=:session AND episode_at BETWEEN :from AND :through AND active=1
    ORDER BY episode_at, assessed_at DESC, id LIMIT 1`) : undefined;
    const insideOut = tableExists(db, "inside_out");
    // Per-exposure grade lookups are keyed by session and time; keep them off a full table scan.
    if (insideOut)
        db.exec("CREATE INDEX IF NOT EXISTS idx_inside_out_session_target ON inside_out(session_id, target_at)");
    const insideOutColumns = readTableColumns(db, "inside_out");
    const hasPerson = insideOutColumns.has("person_id");
    const valence = INSIDE_OUT_VALENCE_SQL;
    // Unsigned 0..3 intensity exists only on grades written since it was added; NULL is unknown, never calm.
    const intensity = insideOutColumns.has("intensity") ? "intensity" : "NULL";
    const grade = insideOut ? db.prepare(`SELECT interaction_id,rubric,human_key,${hasPerson ? "person_id" : "NULL"} person_id,
    channel,sender_id,${valence} valence,${intensity} intensity FROM inside_out
    WHERE session_id=:session AND target_at BETWEEN :from AND :through AND error IS NULL AND (${valence}) IS NOT NULL
    ORDER BY target_at,reviewed_at DESC,interaction_id,rubric LIMIT 1`) : undefined;
    const baseline = insideOut ? db.prepare(`SELECT count(*) n, avg(v) mean, avg(v*v) squareMean FROM (
    SELECT ${valence} v FROM inside_out
    WHERE ${hasPerson ? "person_id=:person" : "0 AND :person IS NOT NULL"}
      AND rubric=:rubric AND target_at>=:since AND target_at<:before AND interaction_id!=:interaction AND error IS NULL
    UNION ALL
    SELECT ${valence} v FROM inside_out
    WHERE (:person IS NULL${hasPerson ? " OR person_id IS NULL" : ""}) AND human_key=:human
      AND rubric=:rubric AND target_at>=:since AND target_at<:before AND interaction_id!=:interaction AND error IS NULL
  ) WHERE v IS NOT NULL`) : undefined;
    /** Returns null for a memory candidate the model never saw (not delivered and not read): it is not an exposure. */
    return (exposure, observedThrough) => {
        const { kind, subject, at, run } = exposure;
        const through = Math.min(observedThrough, at + windowMs);
        const session = exposure.session ?? (run ? stringOrNull(resolveSession?.get({
            agent: agentId, run, from: at - windowMs, through,
        })?.session) : null);
        const following = session && run && through > at ? nextTurn?.get({
            agent: agentId, session, run, from: at + 1, through,
        })?.at : null;
        const stop = typeof following === "number" ? following - 1 : through;
        const match = { agent: agentId, session, run, from: at, through: stop, path: subject };
        const read = kind === "memory_hit" && !!matchRead?.get({ ...match, query: exposure.sourceId });
        if (kind === "memory_hit" && !exposure.delivered && !read)
            return null;
        const opened = kind === "skill" && !!matchOpen?.get({ ...match, sessionKey: exposure.sessionKey });
        const episode = session ? audit?.get({ cohort: options.responseCohort, session, from: at, through: stop }) : undefined;
        const response = parseResponse(episode?.result);
        // Inside Out grades the human reply, not the assistant answer. It can arrive at the
        // next turn's start, but must not come from a subsequent exchange.
        const current = session ? grade?.get({ session, from: Math.max(at + 1, Number(episode?.episode_at ?? at) + 1),
            through: typeof following === "number" ? following : through }) : undefined;
        let insideOutDelta = null;
        let insideOutValence = null;
        let insideOutIntensity = null;
        let baselineCount = 0;
        let sharpDrop = false;
        if (current && baseline && typeof current.valence === "number" &&
            (kind !== "person_whisper" || current.person_id === subject) &&
            (!exposure.sender || exposure.sender === current.sender_id) &&
            (!exposure.provider || exposure.provider === current.channel) &&
            (!exposure.account || exposure.account === identityAccount(current.human_key))) {
            insideOutValence = current.valence;
            insideOutIntensity = typeof current.intensity === "number" ? current.intensity : null;
            const history = baseline.get({
                person: current.person_id, human: current.human_key, rubric: current.rubric,
                since: at - lookbackMs, before: at, interaction: current.interaction_id,
            });
            baselineCount = Number(history.n);
            if (baselineCount >= (options.baselineMinInteractions ?? DEFAULTS.insideOut.defaultBaselineMinInteractions)) {
                const mean = Number(history.mean);
                insideOutDelta = current.valence - mean;
                sharpDrop = insideOutDelta <= -Math.max(0.25, 2 * Math.sqrt(Math.max(0, Number(history.squareMean) - mean * mean)));
            }
        }
        const { verdict, reason, confidence, negative } = scoreOutcome(kind, { delivered: exposure.delivered, read, opened, response });
        const episodeId = stringOrNull(episode?.id);
        const turnId = episodeId ? `episode:${episodeId}` : run ? `run:${run}` : exposure.evidence;
        return {
            session, verdict, confidence,
            signals: { delivered: exposure.delivered, opened, read, responseOutcome: response?.status ?? null,
                responseEpisodeId: episodeId, responseBasis: response?.basis ?? [],
                insideOutDelta, insideOutValence, insideOutIntensity, baselineCount, sharpDrop, negative, turnId, reason },
        };
    };
}
/** Pure verdict rules for one exposure, from whether it was used and what the audited response reported. */
function scoreOutcome(kind, evidence) {
    const { delivered, read, opened, response } = evidence;
    // Only agent-attributed evidence is negative. An Inside Out valence drop is the human's own emotion about
    // anything (grief, bad news, a crisis), so it stays observational telemetry and never blames recalled memory.
    const negative = response?.status === "reported_shortfall";
    const positive = response?.status === "acknowledged_success";
    const used = kind === "skill" ? opened : kind === "memory_hit" ? read || delivered : delivered;
    const explicitUse = read || opened;
    const verdict = negative && used ? "hurt"
        : !negative && (explicitUse || (used && positive)) ? "helped" : "ignored";
    const reason = negative ? !used ? "negative_without_exposure" : "reported_shortfall"
        : read ? "read" : opened ? "opened" : used && positive ? "acknowledged_success" : "no_use_or_outcome_signal";
    const confidence = verdict === "hurt" ? 0.9
        : verdict === "helped" ? (explicitUse && positive ? 0.95 : 0.8) : explicitUse || !used ? 0.8 : 0.5;
    return { verdict, reason, confidence, negative };
}
/**
 * Earlier versions let an Inside Out valence drop alone mark a used subject `hurt`. Rows outside the rescan
 * window are never re-scored, so restate them from their own stored signals with the same verdict rules
 * (`used` was necessarily true for that reason). Idempotent; touches only rows still carrying the old reason.
 */
function repairValenceAttribution(db, agentId) {
    const explicit = "(json_extract(signals_json,'$.read')=1 OR json_extract(signals_json,'$.opened')=1)";
    const positive = "json_extract(signals_json,'$.responseOutcome') IS 'acknowledged_success'";
    return Number(db.prepare(`UPDATE memory_outcomes SET
      verdict=CASE WHEN ${explicit} OR ${positive} THEN 'helped' ELSE 'ignored' END,
      confidence=CASE WHEN ${explicit} AND ${positive} THEN 0.95 WHEN ${explicit} OR ${positive} THEN 0.8 ELSE 0.5 END,
      signals_json=json_set(signals_json,'$.negative',json('false'),'$.sharpDrop',json('true'),
        '$.reason',CASE WHEN json_extract(signals_json,'$.read')=1 THEN 'read'
          WHEN json_extract(signals_json,'$.opened')=1 THEN 'opened'
          WHEN ${positive} THEN 'acknowledged_success' ELSE 'no_use_or_outcome_signal' END,
        '$.attributionRepair','valence_drop_not_agent_fault')
    WHERE agent_id=? AND json_extract(signals_json,'$.reason')='personal_valence_drop'`).run(agentId).changes);
}
function identityAccount(json) {
    if (typeof json !== "string")
        return null;
    try {
        const value = JSON.parse(json);
        return Array.isArray(value) ? value[1] : null;
    }
    catch {
        return null;
    }
}
function parseResponse(json) {
    if (typeof json !== "string")
        return null;
    try {
        return responseOutcome(JSON.parse(json));
    }
    catch (error) {
        // Legacy or interrupted audit records are not outcome evidence.
        if (error instanceof SyntaxError || error instanceof TypeError)
            return null;
        throw error;
    }
}
/** No model call. Read first, then atomically publish outcomes, retention and the sweep cursor under the lease fence. */
export async function runOutcomeLedgerPass(options) {
    const { agentId, owner, workStore, signal, now = Date.now } = options;
    const intervalMs = (options.intervalMinutes ?? 60) * 60_000;
    const lookbackMs = options.lookbackMs ?? 7 * DAY_MS;
    const rescanMs = options.lateEvidenceRescanMs ?? Math.min(lookbackMs, 2 * DAY_MS);
    const maxRows = options.maxRowsPerPass ?? 0;
    const windowMs = options.matchWindowMs ?? 30 * 60_000;
    const retentionMs = (options.retentionDays ?? 0) * DAY_MS;
    const leaseMs = options.leaseMs ?? DEFAULTS.steward.leaseMs;
    const heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(leaseMs / 3));
    for (const [field, value, minimum] of [
        ["intervalMinutes", intervalMs, 1], ["lookbackMs", lookbackMs, 1], ["lateEvidenceRescanMs", rescanMs, 0],
        ["maxRowsPerPass", maxRows, 0],
        ["matchWindowMs", windowMs, 1], ["retentionDays", retentionMs, 0], ["leaseMs", leaseMs, 1],
        ["heartbeatMs", heartbeatMs, 1], ["baselineMinInteractions", options.baselineMinInteractions ?? 1, 1],
    ]) {
        if (!Number.isSafeInteger(value) || value < minimum)
            throw new RangeError(`Invalid outcome ledger ${field}`);
    }
    if (heartbeatMs > leaseMs)
        throw new RangeError("Outcome ledger heartbeat must not exceed the lease");
    if (signal?.aborted)
        return { status: "aborted" };
    const startedAt = now();
    const nextDueAt = startedAt + intervalMs;
    const key = { kind: OUTCOME_LEDGER_KIND, scope: agentId, mode: "run" };
    const recipeHash = options.recipeHash || "default";
    workStore.enqueue({ ...key, recipeHash, now: startedAt });
    const claim = workStore.claim({ ...key, owner, leaseMs, now: startedAt, expectedRecipeHash: recipeHash });
    if (!claim)
        return { status: workStore.get(key.kind, key.scope)?.status === "running" ? "already_running" : "not_due" };
    try {
        const { db } = new OutcomeLedgerStore(workStore.db);
        const watermark = readWatermark(claim.artifactJson);
        const retentionFloor = retentionMs ? startedAt - retentionMs : Number.MIN_SAFE_INTEGER;
        // Leave the full match window open before first scoring. The first sweep covers the lookback;
        // later sweeps re-score a bounded window behind the watermark because audit results and
        // Inside Out grades can be backfilled asynchronously.
        const through = startedAt - windowMs;
        const sweep = watermark.sweep ?? { through, from: watermark.lastMeasuredAtMs
                ? Math.min(through, watermark.lastMeasuredAtMs - (rescanMs || lookbackMs))
                : through - lookbackMs };
        let heartbeatAt = performance.now();
        let yieldAt = heartbeatAt;
        const page = exposures(db, agentId, { ...sweep, from: Math.max(sweep.from, retentionFloor) }, maxRows ? maxRows + 1 : -1);
        const hasMore = maxRows > 0 && page.length > maxRows;
        if (hasMore)
            page.pop();
        const evaluate = evidenceReader(db, options, windowMs, lookbackMs);
        const outcomes = [];
        const unexposed = [];
        let last;
        for (const row of page) {
            if (performance.now() - yieldAt >= YIELD_SLICE_MS) {
                await setImmediate();
                signal?.throwIfAborted();
                yieldAt = performance.now();
            }
            if (performance.now() - heartbeatAt >= heartbeatMs) {
                workStore.renew(claim, leaseMs, now());
                heartbeatAt = performance.now();
            }
            const exposure = last = decodeExposure(row);
            const evidence = evaluate(exposure, startedAt);
            const recipe = exposure.kind === "person_whisper" ? exposure.recipe || recipeHash : exposure.recipe ?? "default";
            const id = jsonHash([agentId, exposure.kind, exposure.subject, exposure.evidence, recipe]);
            // Drop rows earlier versions scored for candidates that were never shown to the model.
            if (evidence)
                outcomes.push({ ...evidence, id, recipe, exposure });
            else
                unexposed.push(id);
        }
        const cursor = last && { at: last.at, kind: last.kind, evidence: last.evidence, subject: last.subject };
        const lastMeasuredAtMs = Math.max(watermark.lastMeasuredAtMs, hasMore && cursor ? cursor.at : sweep.through);
        const artifact = { schemaVersion: 1, lastMeasuredAtMs,
            ...(hasMore && cursor ? { sweep: { from: sweep.from, through: sweep.through, after: cursor } } : {}),
            valenceAttributionRepaired: true };
        signal?.throwIfAborted();
        const pruned = workStore.commitWithDomain(claim, { nextDueAt, keepArtifact: true, now: now() }, () => {
            const put = db.prepare(`INSERT INTO memory_outcomes
        (id,agent_id,subject_kind,subject_id,recipe_hash,verdict,confidence,evidence_turn_id,session_id,signals_json,measured_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET verdict=excluded.verdict,confidence=excluded.confidence,
        session_id=excluded.session_id,signals_json=excluded.signals_json
        WHERE (verdict,confidence,session_id,signals_json) IS NOT
          (excluded.verdict,excluded.confidence,excluded.session_id,excluded.signals_json)`);
            for (const { id, recipe, exposure, verdict, confidence, session, signals } of outcomes) {
                put.run(id, agentId, exposure.kind, exposure.subject, recipe, verdict, confidence, exposure.evidence, session, JSON.stringify(signals), exposure.at);
            }
            const drop = db.prepare("DELETE FROM memory_outcomes WHERE id=? AND subject_kind='memory_hit'");
            for (const id of unexposed)
                drop.run(id);
            // One-time: current scoring never writes the legacy reason, so a stamped watermark skips the json_extract scan.
            if (!watermark.valenceAttributionRepaired)
                repairValenceAttribution(db, agentId);
            const removed = retentionMs ? db.prepare("DELETE FROM memory_outcomes WHERE agent_id=? AND measured_at<?")
                .run(agentId, retentionFloor).changes : 0;
            workStore.stageArtifact(claim, { stage: "watermark", artifactJson: JSON.stringify(artifact), now: now() });
            return Number(removed);
        });
        return { status: "ok", measured: outcomes.length, pruned, lastMeasuredAtMs, nextDueAt };
    }
    catch (error) {
        const reason = signal?.aborted ? "aborted" : error instanceof WorkFenceLostError ? "fence_lost"
            : error instanceof Error ? error.message : String(error);
        try {
            workStore.fail(claim, { error: reason, retryAt: nextDueAt, now: now() });
        }
        catch (failure) {
            if (!(failure instanceof WorkFenceLostError))
                throw failure;
        }
        return signal?.aborted ? { status: "aborted" } : { status: "failed", reason };
    }
}
function verdictCounts(row) {
    return { helped: Number(row?.helped ?? 0), ignored: Number(row?.ignored ?? 0), hurt: Number(row?.hurt ?? 0) };
}
function metrics(row) {
    const memory = Number(row?.memory_hit ?? 0), skills = Number(row?.skill ?? 0), turns = Number(row?.turns ?? 0);
    const delivered = Number(row?.delivered_memory ?? 0);
    return {
        totalOutcomes: Number(row?.total ?? 0),
        byVerdict: verdictCounts(row),
        bySubjectKind: { memory_hit: memory, skill: skills, person_whisper: Number(row?.person_whisper ?? 0) },
        /** Share of delivered memory hits the turn went on to use. */
        whisperUsedRate: delivered ? Number(row?.used_memory) / delivered : null,
        skillOpenRate: skills ? Number(row?.opened_skills) / skills : null,
        shortfallsPer100Turns: turns ? 100 * Number(row?.shortfalls) / turns : null,
    };
}
function dbFor(dbOrStore) {
    return dbOrStore instanceof OutcomeLedgerStore ? dbOrStore.db : dbOrStore;
}
/** Range is [sinceMs, untilMs) on exposure time, so re-evaluation doesn't move an outcome between buckets. */
export function summarizeOutcomeMetrics(dbOrStore, options) {
    const db = dbFor(dbOrStore);
    if (!tableExists(db, "memory_outcomes"))
        return { ...metrics(), byRecipe: {} };
    const rows = db.prepare(`WITH selected AS (
    SELECT recipe_hash,verdict,subject_kind,coalesce(json_extract(signals_json,'$.turnId'),evidence_turn_id) turn,
      json_extract(signals_json,'$.opened') opened,json_extract(signals_json,'$.delivered') delivered,
      -- Shortfalls are agent-attributed audit evidence only; legacy rows also set negative on a valence drop.
      json_extract(signals_json,'$.responseOutcome') IS 'reported_shortfall' negative
    FROM memory_outcomes WHERE agent_id=:agent AND measured_at>=:since AND measured_at<:until
      AND (:recipe IS NULL OR recipe_hash=:recipe)
  ), grouped AS (
    SELECT NULL recipe,* FROM selected UNION ALL SELECT recipe_hash,* FROM selected
  )
  SELECT recipe,count(*) total,count(*) FILTER (WHERE verdict='helped') helped,
    count(*) FILTER (WHERE verdict='ignored') ignored,count(*) FILTER (WHERE verdict='hurt') hurt,
    count(*) FILTER (WHERE subject_kind='memory_hit') memory_hit,count(*) FILTER (WHERE subject_kind='skill') skill,
    count(*) FILTER (WHERE subject_kind='person_whisper') person_whisper,
    count(*) FILTER (WHERE subject_kind='memory_hit' AND delivered=1) delivered_memory,
    count(*) FILTER (WHERE subject_kind='memory_hit' AND delivered=1 AND verdict='helped') used_memory,
    count(*) FILTER (WHERE subject_kind='skill' AND verdict IN ('helped','hurt') AND opened=1) opened_skills,
    count(DISTINCT turn) turns,count(DISTINCT turn) FILTER (WHERE negative=1) shortfalls
  FROM grouped GROUP BY recipe`).all({
        agent: options.agentId, since: options.sinceMs ?? Number.MIN_SAFE_INTEGER,
        until: options.untilMs ?? Number.MAX_SAFE_INTEGER, recipe: options.recipeHash ?? null,
    });
    return {
        ...metrics(rows.find(row => row.recipe === null)),
        byRecipe: Object.fromEntries(rows.flatMap(row => typeof row.recipe === "string" ? [[row.recipe, metrics(row)]] : [])),
    };
}
/** Net score is the signed count of helpful minus harmful outcomes; ignored is neutral. */
export function getSubjectOutcomeStats(dbOrStore, options) {
    const db = dbFor(dbOrStore);
    const row = tableExists(db, "memory_outcomes") ? db.prepare(`SELECT
    count(*) FILTER (WHERE verdict='helped') helped, count(*) FILTER (WHERE verdict='ignored') ignored,
    count(*) FILTER (WHERE verdict='hurt') hurt FROM memory_outcomes
    WHERE agent_id=? AND subject_kind=? AND subject_id=? AND measured_at>=?`)
        .get(options.agentId, options.subjectKind, options.subjectId, options.sinceMs ?? Number.MIN_SAFE_INTEGER) : undefined;
    const counts = verdictCounts(row);
    return { ...counts, netScore: counts.helped - counts.hurt };
}
