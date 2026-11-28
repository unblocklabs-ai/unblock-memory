import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { detectSentimentDrift } from "./emotion-baselines.js";
import { ExpectationsStore } from "./expectations-store.js";
import { summarizeCrystals } from "./memory-crystals.js";
import { readTableColumns, tableExists } from "./memory-database.js";
import { summarizeOutcomeMetrics } from "./outcome-ledger.js";
import { listSkillProposals, SKILL_PROPOSAL_KINDS } from "./skill-proposals-store.js";
const HOUR_MS = 3_600_000;
const VERDICTS = ["helped", "ignored", "hurt"];
const SAFE_RECIPES = new Set([
    "default", "actr_v1", "outcome_v1", "emotion_v1",
    "brightness:actr_v1", "brightness:outcome_v1", "brightness:emotion_v1",
]);
// Never use arbitrary DB text as a Prometheus kind label: only the store's own kinds, anything else is "other".
const PROPOSAL_KINDS = new Set([...SKILL_PROPOSAL_KINDS, "other"]);
const looksPrivate = (value) => /[\/@]|[a-zA-Z]:\\|^\\\\|\b[ABCDEGTUW](?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b|\b[a-fA-F\d]{8}(?:-[a-fA-F\d]{4}){3}-[a-fA-F\d]{12}\b/u.test(value) ||
    /^(?:sk-|xox[baprs]-|gh[pousr]_|github_pat_)[a-z0-9]|^[cudgwb]0[a-z0-9]{7,}\b|^\+?(?:\d[.()-]?){7,14}\d$/iu.test(value);
/** Prometheus label and hub row keys stay short; `maxLength` 0 = unlimited. */
export const isFleetAlias = (value, maxLength = 64) => typeof value === "string" && (!maxLength || value.length <= maxLength) &&
    /^[a-z0-9][a-z0-9_.:-]*$/iu.test(value) && !looksPrivate(value);
export const isFleetRecipeHash = (value) => SAFE_RECIPES.has(value) || /^[0-9a-f]{64}$/u.test(value);
export const isFleetProposalKind = (value) => PROPOSAL_KINDS.has(value);
const recipeLabel = (value) => isFleetRecipeHash(value) ? value : createHash("sha256").update(value).digest("hex");
const kindLabel = (value) => isFleetProposalKind(value) ? value : "other";
function read(source, fn) {
    if (typeof source !== "string")
        return fn(source);
    return ExpectationsStore.readOnly(source, undefined, fn) ?? fn();
}
function identity({ nodeId, agentId, nowMs = Date.now() }) {
    if (!isFleetAlias(nodeId) || !isFleetAlias(agentId))
        throw new TypeError("Expected fleet node and agent aliases");
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
        throw new RangeError("Invalid collection time");
    return { schemaVersion: 1, nodeId, agentId, collectedAtMs: nowMs };
}
function hours(value, name) {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * HOUR_MS))) {
        throw new RangeError(`Invalid ${name}`);
    }
    return value;
}
const emptyOutcome = () => ({
    total: 0, helped: 0, ignored: 0, hurt: 0,
    whisperUsedRate: null, skillOpenRate: null, shortfallsPer100Turns: null,
});
function outcomeMetrics(row) {
    return {
        total: row.totalOutcomes, helped: row.byVerdict.helped, ignored: row.byVerdict.ignored, hurt: row.byVerdict.hurt,
        whisperUsedRate: row.whisperUsedRate, skillOpenRate: row.skillOpenRate, shortfallsPer100Turns: row.shortfallsPer100Turns,
    };
}
function readOutcomes(db, agentId, sinceMs, untilMs) {
    if (!db || !tableExists(db, "memory_outcomes"))
        return { ...emptyOutcome(), byRecipe: {} };
    db.exec("SAVEPOINT fleet_outcomes");
    try {
        const summary = summarizeOutcomeMetrics(db, { agentId, sinceMs, untilMs });
        // Match the ledger's populations in the same read snapshot; outcome counts are not valid weights.
        const rows = db.prepare(`SELECT recipe_hash,
      count(*) FILTER (WHERE subject_kind='memory_hit' AND json_extract(signals_json,'$.delivered')=1) AS delivered,
      count(*) FILTER (WHERE subject_kind='skill') AS skills,
      count(DISTINCT coalesce(json_extract(signals_json,'$.turnId'),evidence_turn_id)) AS turns
      FROM memory_outcomes WHERE agent_id=? AND measured_at>=? AND measured_at<? GROUP BY recipe_hash`).all(agentId, sinceMs, untilMs);
        return {
            ...outcomeMetrics(summary),
            byRecipe: Object.fromEntries(rows.map(row => {
                const raw = String(row.recipe_hash);
                return [recipeLabel(raw), {
                        ...outcomeMetrics(summary.byRecipe[raw]),
                        denominators: { deliveredMemoryHits: Number(row.delivered), suggestedSkills: Number(row.skills), turns: Number(row.turns) },
                    }];
            })),
        };
    }
    finally {
        db.exec("RELEASE fleet_outcomes");
    }
}
/** Pending proposals through the store's own reader (`skill-proposals-store.ts`); a missing table reads as none. */
const pendingProposals = (db, agentId) => listSkillProposals(db, { agentId, status: "pending" });
function hasColumns(columns, names) {
    return names.every(name => columns.has(name));
}
function flaggedDrift(db, drift, now) {
    return db ? detectSentimentDrift(db, { ...drift, now }).filter(report => report.flagged) : [];
}
/** Reads the local store without migrations. A missing file or component contributes zeros. */
export function buildNodeTelemetrySnapshot(source, options) {
    const ids = identity(options), now = ids.collectedAtMs, agentId = options.sourceAgentId ?? ids.agentId;
    const sinceHours = hours(options.sinceHours ?? 24, "sinceHours");
    return read(source, db => {
        const crystal = db && summarizeCrystals(db, agentId);
        const expectation = db && ExpectationsStore.summarize(db, agentId, now);
        const derived = db && tableExists(db, "derived_observations") ? db.prepare(`SELECT
      count(*) FILTER (WHERE status='fresh') fresh, count(*) FILTER (WHERE status='stale') stale,
      coalesce(sum(hit_count),0) hits FROM derived_observations WHERE agent_id=?`).get(agentId) : undefined;
        const byKind = {};
        let pending = 0;
        for (const proposal of db ? pendingProposals(db, agentId) : []) {
            const kind = kindLabel(proposal.kind);
            byKind[kind] = (byKind[kind] ?? 0) + 1;
            pending += 1;
        }
        // work_items and sentiment evidence have no agent_id; these counts describe the supplied node DB.
        const quarantined = db && tableExists(db, "work_items")
            ? db.prepare("SELECT count(*) n FROM work_items WHERE status='quarantined'").get()?.n : 0;
        return {
            ...ids, sinceHours,
            outcomes: readOutcomes(db, agentId, sinceHours ? now - Math.round(sinceHours * HOUR_MS) : Number.MIN_SAFE_INTEGER, now),
            crystals: { stm: crystal?.activeByTier.stm ?? 0, ltm: crystal?.activeByTier.ltm ?? 0, coreMemories: crystal?.coreMemoriesCount ?? 0 },
            expectations: {
                open: expectation?.byStatus.open ?? 0, kept: expectation?.byStatus.kept ?? 0,
                broken: expectation?.byStatus.broken ?? 0, overdue: expectation?.overdue ?? 0,
            },
            derivedObservations: { fresh: Number(derived?.fresh ?? 0), stale: Number(derived?.stale ?? 0), totalHits: Number(derived?.hits ?? 0) },
            skillProposals: { pending, byKind },
            sentimentDriftFlaggedCount: flaggedDrift(db, options.drift, now).length,
            quarantinedWorkItems: Number(quarantined),
        };
    });
}
function openBlockers(db, agentId, limit) {
    const columns = readTableColumns(db, "captains_log_entries");
    if (!columns.size)
        return [];
    // Same open-blocker selection/order as listOpenBlockers, without loading its TypeBox-backed steward pass.
    const salience = hasColumns(columns, ["salience_signals_json", "salience_score"])
        ? "CASE WHEN json_extract(salience_signals_json,'$.highSalience')=1 THEN salience_score END DESC NULLS LAST," : "";
    return db.prepare(`SELECT topic,summary,captured_at_ms FROM captains_log_entries
    WHERE agent_id=? AND blocked=1 AND resolved_at_ms IS NULL
    ORDER BY ${salience} captured_at_ms DESC,section_hash,ordinal LIMIT ?`).all(agentId, limit)
        .map(row => ({ topic: String(row.topic), summary: String(row.summary), capturedAtMs: Number(row.captured_at_ms) }));
}
/** Private operator channel. Never use these rows as metrics labels or telemetry fields. */
export function buildNodeBriefSnapshot(source, options) {
    const ids = identity(options), now = ids.collectedAtMs, agentId = options.sourceAgentId ?? ids.agentId;
    const dueSoonHours = hours(options.dueSoonHours ?? 24, "dueSoonHours");
    const limit = options.limit ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 0)
        throw new RangeError("Invalid brief limit");
    const sqlLimit = limit || -1;
    return read(source, db => {
        const brief = {
            ...ids, operatorOnly: true, blockers: [], overdueExpectations: [], dueSoonExpectations: [],
            sentimentDrift: [], skillProposals: [], quarantinedWorkItems: [],
        };
        if (!db)
            return brief;
        brief.blockers = openBlockers(db, agentId, sqlLimit);
        if (tableExists(db, "expectations")) {
            const due = db.prepare(`SELECT kind,summary,due_at_ms FROM expectations
        WHERE agent_id=? AND status='open' AND due_at_ms>=? AND due_at_ms<=?
        ORDER BY due_at_ms,created_at_ms,id LIMIT ?`);
            const range = (from, to) => due.all(agentId, from, to, sqlLimit)
                .map(row => ({ kind: String(row.kind), summary: String(row.summary), dueAtMs: Number(row.due_at_ms) }));
            brief.overdueExpectations = range(Number.MIN_SAFE_INTEGER, now - 1);
            if (dueSoonHours)
                brief.dueSoonExpectations = range(now, now + Math.round(dueSoonHours * HOUR_MS));
        }
        const drift = flaggedDrift(db, options.drift, now);
        brief.sentimentDrift = (limit ? drift.slice(0, limit) : drift).map(({ personId, metric, reason }) => ({ personId, metric, reason }));
        // Replay-validated proposals first (by recall gain from `replay_metrics_json`), then unmeasured ones.
        const proposals = pendingProposals(db, agentId).map(proposal => ({
            kind: proposal.kind, skillName: proposal.skillName, title: proposal.title,
            recallGainPp: Number.isFinite(proposal.replayMetrics?.recallGainPp) ? proposal.replayMetrics.recallGainPp : null,
        })).sort((a, b) => (b.recallGainPp ?? -Infinity) - (a.recallGainPp ?? -Infinity) ||
            a.kind.localeCompare(b.kind) || a.skillName.localeCompare(b.skillName) || a.title.localeCompare(b.title));
        brief.skillProposals = limit ? proposals.slice(0, limit) : proposals;
        if (tableExists(db, "work_items")) {
            brief.quarantinedWorkItems = db.prepare(`SELECT kind,scope,strikes,last_error FROM work_items WHERE status='quarantined'
        ORDER BY strikes DESC,kind,scope LIMIT ?`).all(sqlLimit).map(row => ({
                kind: String(row.kind), scope: String(row.scope), strikes: Number(row.strikes),
                lastError: typeof row.last_error === "string" ? row.last_error : null,
            }));
        }
        return brief;
    });
}
const RATE_WEIGHTS = {
    whisperUsedRate: "deliveredMemoryHits", skillOpenRate: "suggestedSkills", shortfallsPer100Turns: "turns",
};
const RATE_KEYS = ["whisperUsedRate", "skillOpenRate", "shortfallsPer100Turns"];
/**
 * Rolls recipes up per `sinceHours` window: a 24h snapshot and an all-history (`0`) snapshot are different
 * populations, so they never share a row. `coverageFromMs`/`coverageToMs` bound the outcomes the row can include
 * (`coverageFromMs` null = all history).
 */
export function aggregateAbLeaderboard(snapshots) {
    const recipes = new Map();
    for (const { outcomes, nodeId, sinceHours, collectedAtMs } of snapshots) {
        const fromMs = sinceHours ? collectedAtMs - Math.round(sinceHours * HOUR_MS) : null;
        for (const [recipeHash, metrics] of Object.entries(outcomes.byRecipe)) {
            const key = JSON.stringify([sinceHours, recipeHash]);
            let recipe = recipes.get(key)?.recipe;
            if (!recipe) {
                recipe = {
                    counts: { total: 0, helped: 0, ignored: 0, hurt: 0 }, nodes: new Set(),
                    weighted: { whisperUsedRate: 0, skillOpenRate: 0, shortfallsPer100Turns: 0 },
                    weights: { whisperUsedRate: 0, skillOpenRate: 0, shortfallsPer100Turns: 0 },
                    coverageFromMs: fromMs, coverageToMs: collectedAtMs,
                };
                recipes.set(key, { sinceHours, recipeHash, recipe });
            }
            recipe.nodes.add(nodeId);
            if (fromMs !== null && recipe.coverageFromMs !== null)
                recipe.coverageFromMs = Math.min(recipe.coverageFromMs, fromMs);
            recipe.coverageToMs = Math.max(recipe.coverageToMs, collectedAtMs);
            recipe.counts.total += metrics.total;
            for (const verdict of VERDICTS)
                recipe.counts[verdict] += metrics[verdict];
            for (const key of RATE_KEYS) {
                const value = metrics[key], weight = metrics.denominators[RATE_WEIGHTS[key]];
                if (value !== null) {
                    recipe.weighted[key] += value * weight;
                    recipe.weights[key] += weight;
                }
            }
        }
    }
    // Bounded windows first (shortest first), all history last; then by volume.
    const windowOrder = (hours) => hours || Infinity;
    return [...recipes.values()].map(({ sinceHours, recipeHash, recipe: { counts, weighted, weights, nodes, coverageFromMs, coverageToMs } }) => {
        const rate = (name) => weights[name] ? weighted[name] / weights[name] : null;
        return {
            sinceHours, recipeHash, ...counts, whisperUsedRate: rate("whisperUsedRate"), skillOpenRate: rate("skillOpenRate"),
            shortfallsPer100Turns: rate("shortfallsPer100Turns"), nodeCount: nodes.size, nodes: [...nodes].sort(), coverageFromMs, coverageToMs,
        };
    }).sort((a, b) => windowOrder(a.sinceHours) - windowOrder(b.sinceHours) || b.total - a.total || a.recipeHash.localeCompare(b.recipeHash));
}
const label = (value) => value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
// Snapshot gauges: sliding windows and row retention can reduce even the *_total values.
const METRIC_HELP = {
    whisper_used_rate: "Share of delivered memory hits used.",
    skill_open_rate: "Share of suggested skills opened with an attributed outcome.",
    shortfalls_per_100_turns: "Reported shortfalls per 100 measured turns.",
    outcomes_total: "Outcomes in the collection window.",
    crystals_active: "Active memory crystals.",
    core_memories_total: "Stored core memories.",
    expectations_total: "Recorded expectations by status; overdue is a subset of open.",
    derived_observations_hits_total: "Hits on currently stored derived observations.",
    skill_proposals_pending: "Pending skill proposals.",
    sentiment_drift_flagged: "Flagged sentiment drift reports.",
    quarantined_work_items: "Quarantined work items.",
};
export function formatPrometheusMetrics(snapshots) {
    const families = new Map(Object.entries(METRIC_HELP).map(([name, help]) => {
        const metric = `unblock_memory_${name}`;
        return [name, [`# HELP ${metric} ${help}`, `# TYPE ${metric} gauge`]];
    }));
    const emit = (name, labels, value) => {
        if (value === null || !Number.isFinite(value))
            return;
        families.get(name)?.push(`unblock_memory_${name}{${Object.entries(labels).map(([k, v]) => `${k}="${label(v)}"`).join(",")}} ${value}`);
    };
    const latest = new Map();
    for (const s of snapshots) {
        if (looksPrivate(s.nodeId) || looksPrivate(s.agentId))
            continue;
        const key = JSON.stringify([s.nodeId, s.agentId]);
        if (s.collectedAtMs >= (latest.get(key)?.collectedAtMs ?? -1))
            latest.set(key, s);
    }
    for (const s of latest.values()) {
        const node = { node: s.nodeId, agent: s.agentId };
        for (const [recipe, row] of Object.entries(s.outcomes.byRecipe)) {
            if (!isFleetRecipeHash(recipe))
                continue;
            const labels = { ...node, recipe };
            emit("whisper_used_rate", labels, row.whisperUsedRate);
            emit("skill_open_rate", labels, row.skillOpenRate);
            emit("shortfalls_per_100_turns", labels, row.shortfallsPer100Turns);
            for (const verdict of VERDICTS)
                emit("outcomes_total", { ...labels, verdict }, row[verdict]);
        }
        for (const tier of ["stm", "ltm"])
            emit("crystals_active", { ...node, tier }, s.crystals[tier]);
        emit("core_memories_total", node, s.crystals.coreMemories);
        for (const status of ["open", "kept", "broken", "overdue"]) {
            emit("expectations_total", { ...node, status }, s.expectations[status]);
        }
        emit("derived_observations_hits_total", node, s.derivedObservations.totalHits);
        for (const [kind, count] of Object.entries(s.skillProposals.byKind)) {
            if (isFleetProposalKind(kind))
                emit("skill_proposals_pending", { ...node, kind }, count);
        }
        emit("sentiment_drift_flagged", node, s.sentimentDriftFlaggedCount);
        emit("quarantined_work_items", node, s.quarantinedWorkItems);
    }
    return [...families.values()].flat().join("\n") + "\n";
}
const inline = (text) => text.replace(/\s+/gu, " ").trim()
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_[\]()|~]/gu, "\\$&");
const percent = (rate) => rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
const tally = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
export function renderFleetMorningBrief(briefs, telemetry) {
    const count = (key) => briefs.reduce((sum, brief) => sum + brief[key].length, 0);
    const node = (brief) => `${inline(brief.nodeId)} / ${inline(brief.agentId)}`;
    const none = (lines) => lines.length ? lines : ["None."];
    const redFlags = briefs.flatMap(brief => [
        ...brief.quarantinedWorkItems.map(item => `- **Quarantined · ${node(brief)}:** ${inline(item.kind)} / ${inline(item.scope)} (${item.strikes} strikes)${item.lastError ? ` — ${inline(item.lastError)}` : ""}`),
        ...brief.sentimentDrift.map(item => `- **Drift · ${node(brief)}:** ${inline(item.personId)} — ${inline(item.reason)}`),
        ...brief.overdueExpectations.map(item => `- **Overdue · ${node(brief)}:** ${inline(item.summary)}`),
    ]);
    const dueSoon = briefs.flatMap(brief => brief.dueSoonExpectations.map(item => `- **${node(brief)}:** ${inline(item.summary)}`));
    const blockers = briefs.flatMap(brief => brief.blockers.length ? [
        `### ${node(brief)}`,
        ...brief.blockers.map(item => `- **${inline(item.topic)}:** ${inline(item.summary)}`),
    ] : []);
    const proposals = briefs.flatMap(brief => brief.skillProposals.map(item => `- **${node(brief)}:** ${inline(item.title)} (${inline(item.kind)} · ${inline(item.skillName)})${item.recallGainPp === null ? "" : ` — ${item.recallGainPp} pp recall`}`));
    const lines = [
        "# Fleet Morning Brief", "", "**Internal · operator only**", "",
        `**${tally(new Set(briefs.map(b => b.nodeId)).size, "node")} reporting** · ${tally(count("blockers"), "blocker")} · ${count("overdueExpectations")} overdue · ${tally(count("sentimentDrift"), "drift alert")} · ${count("quarantinedWorkItems")} quarantined · ${tally(count("skillProposals"), "pending skill approval")}`,
        "", "## Red Flags", ...none(redFlags),
        ...(dueSoon.length ? ["", "### Due Soon", ...dueSoon] : []),
        "", "## Active [BLOCKED] Items by Node", ...none(blockers),
        "", "## Pending Self-Writing Skill Proposals", ...none(proposals),
    ];
    if (telemetry) {
        const leaderboard = aggregateAbLeaderboard(telemetry);
        lines.push("", "## Brightness A/B Lab Leaderboard");
        if (!leaderboard.length)
            lines.push("No measured outcomes.");
        else
            lines.push("| Window | Recipe | Nodes | Outcomes | Whisper used | Skill opened | Shortfalls / 100 turns |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |", ...leaderboard.map(row => `| ${row.sinceHours ? `${row.sinceHours}h` : "all"} | ${inline(row.recipeHash)} | ${row.nodeCount} | ${row.total} | ${percent(row.whisperUsedRate)} | ${percent(row.skillOpenRate)} | ${row.shortfallsPer100Turns?.toFixed(1) ?? "—"} |`));
    }
    return lines.join("\n") + "\n";
}
/** POST to the exact telemetry or brief endpoint. Do not follow redirects with an operator payload. */
export async function pushNodeSnapshot(snapshot, options) {
    const { apiKeyFile, timeoutMs = 0 } = options;
    const endpoint = new URL(options.endpoint);
    // Plain HTTP would expose the bearer and the operator payload: loopback only.
    const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(endpoint.hostname);
    if (!(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback))) {
        throw new Error("Fleet hub endpoint must use https:// (plain http:// is allowed for loopback only)");
    }
    const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    const signal = options.signal && timeout ? AbortSignal.any([options.signal, timeout]) : options.signal ?? timeout;
    signal?.throwIfAborted();
    const key = (options.apiKey ?? (apiKeyFile ? await readFile(apiKeyFile, { encoding: "utf8", signal }) : undefined))?.trim();
    if (!key && (options.apiKey !== undefined || apiKeyFile !== undefined))
        throw new Error("Empty fleet hub API key");
    const response = await fetch(endpoint, {
        method: "POST", redirect: "error", signal, body: JSON.stringify(snapshot),
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    });
    await response.body?.cancel();
    if (!response.ok)
        throw new Error(`Fleet hub rejected snapshot (HTTP ${response.status})`);
}
