import { DEFAULTS } from "./defaults.js";
import { randomUUID } from "node:crypto";
import { immediateTransaction, openMemoryDatabase } from "./memory-database.js";
import { validateCachedStage } from "./response-judge.js";
import { responseOutcome, RESPONSE_REPORT_VERSION } from "./response-outcome.js";
import { ResponsePeople } from "./response-identity.js";
import { ResponseReviews, RESPONSE_REVIEW_POLICY } from "./response-reviews.js";
const MAX_RETRY_ATTEMPTS = DEFAULTS.responseAudit.maxRetries;
const RETRY_BACKOFF_MS = DEFAULTS.responseAudit.retryBackoffMs;
/** Operator-only tables: not a memory corpus and never injected into agent prompts. */
export class ResponseAuditStore {
    #db;
    reviews;
    constructor(path) {
        this.#db = openMemoryDatabase(path);
        try {
            this.reviews = immediateTransaction(this.#db, () => {
                const version = this.#db.prepare("SELECT version FROM memory_schema WHERE component='responses'").get()?.version;
                if (version !== undefined && version !== 1)
                    throw new Error("Unsupported response audit schema version");
                this.#db.exec(`
          CREATE TABLE IF NOT EXISTS response_lease (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, expires INTEGER);
          CREATE TABLE IF NOT EXISTS response_results (
            cohort TEXT, id TEXT, session_id TEXT NOT NULL, input_hash TEXT NOT NULL,
            episode_at INTEGER NOT NULL, active INTEGER NOT NULL, status TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, attempted_at INTEGER, assessed_at INTEGER, result TEXT,
            PRIMARY KEY(cohort,id));
          CREATE TABLE IF NOT EXISTS response_scans (cohort TEXT PRIMARY KEY, observed_at INTEGER, coverage TEXT);
          CREATE INDEX IF NOT EXISTS response_results_time ON response_results(cohort,episode_at);
          CREATE INDEX IF NOT EXISTS response_results_session ON response_results(cohort,session_id,episode_at);`);
                this.#db.exec(`CREATE TABLE IF NOT EXISTS response_checkpoints (
          cohort TEXT NOT NULL, session_id TEXT NOT NULL, revision TEXT NOT NULL, coverage TEXT NOT NULL,
          PRIMARY KEY(cohort,session_id));
          CREATE TABLE IF NOT EXISTS response_cursors (cohort TEXT PRIMARY KEY,cursor TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS response_schedule (
            id INTEGER PRIMARY KEY CHECK(id=1), interval_ms INTEGER NOT NULL, next_due INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS response_stages (
            key TEXT PRIMARY KEY, stage TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0, attempted_at INTEGER, assessed_at INTEGER, result TEXT);
          CREATE TABLE IF NOT EXISTS response_stage_links (
            cohort TEXT NOT NULL, episode_id TEXT NOT NULL, input_hash TEXT NOT NULL, stage TEXT NOT NULL, key TEXT NOT NULL,
            PRIMARY KEY(cohort,episode_id,stage));`);
                const reviews = new ResponseReviews(this.#db);
                this.#db.exec("INSERT OR IGNORE INTO memory_schema VALUES ('responses',1)");
                return reviews;
            });
        }
        catch (error) {
            this.#db.close();
            throw error;
        }
    }
    /** Claim one bounded scheduled attempt, never replay every missed interval. */
    claimScheduled(now, intervalMs) {
        return immediateTransaction(this.#db, () => {
            this.#db.prepare(`INSERT INTO response_schedule VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET
        next_due=next_due + excluded.interval_ms - interval_ms, interval_ms=excluded.interval_ms`)
                .run(intervalMs, now + intervalMs);
            const claimed = this.#db.prepare("UPDATE response_schedule SET next_due=? WHERE id=1 AND next_due<=?")
                .run(now + intervalMs, now).changes > 0;
            return claimed;
        });
    }
    acquire(now) {
        const token = randomUUID();
        const result = this.#db.prepare(`INSERT INTO response_lease VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE response_lease.expires < ?`)
            .run(token, now + DEFAULTS.responseAudit.leaseMs, now);
        return result.changes ? token : undefined;
    }
    release(token) { this.#db.prepare("DELETE FROM response_lease WHERE token=?").run(token); }
    activeSessions(cohort, since) {
        return this.#db.prepare(`SELECT DISTINCT session_id FROM response_results
      WHERE cohort=? AND active=1 AND episode_at>=? ORDER BY session_id`).all(cohort, since).map(row => String(row.session_id));
    }
    observe(cohort, sessionId, episodes) {
        immediateTransaction(this.#db, () => {
            this.#db.prepare("UPDATE response_results SET active=0 WHERE cohort=? AND session_id=?").run(cohort, sessionId);
            const insert = this.#db.prepare(`INSERT INTO response_results(cohort,id,session_id,input_hash,episode_at,active,status)
        VALUES(?,?,?,?,?,1,'pending') ON CONFLICT(cohort,id) DO UPDATE SET active=1,
        input_hash=excluded.input_hash,episode_at=excluded.episode_at,
        status=CASE WHEN input_hash=excluded.input_hash THEN status ELSE 'pending' END,
        attempts=CASE WHEN input_hash=excluded.input_hash THEN attempts ELSE 0 END,
        attempted_at=CASE WHEN input_hash=excluded.input_hash THEN attempted_at ELSE NULL END,
        assessed_at=CASE WHEN input_hash=excluded.input_hash THEN assessed_at ELSE NULL END,
        result=CASE WHEN input_hash=excluded.input_hash THEN result ELSE NULL END`);
            for (const e of episodes)
                insert.run(cohort, e.id, sessionId, e.inputHash, e.timestamp);
            this.reviews.reconcile(cohort, sessionId);
        });
    }
    needsJudgment(cohort, e, now) {
        const row = this.#db.prepare(`SELECT 1 FROM response_results
      WHERE cohort=? AND id=? AND input_hash=? AND active=1
      AND (status!='ok' OR json_extract(result,'$.memory.status')='unavailable')
      AND attempts<? AND (attempted_at IS NULL OR attempted_at<=?)`)
            .get(cohort, e.id, e.inputHash, MAX_RETRY_ATTEMPTS, now - RETRY_BACKOFF_MS);
        return !!row;
    }
    memoryRetryResult(cohort, e) {
        const row = this.#db.prepare(`SELECT result FROM response_results r
      WHERE cohort=? AND id=? AND input_hash=? AND active=1 AND status='ok'
      AND json_extract(result,'$.memory.status')='unavailable'
      AND NOT EXISTS (
        SELECT 1 FROM response_stage_links l LEFT JOIN response_stages s ON s.key=l.key
        WHERE l.cohort=r.cohort AND l.episode_id=r.id AND l.input_hash=r.input_hash
          AND l.stage!='memory' AND (s.status IS NULL OR s.status!='ok')
      )`).get(cohort, e.id, e.inputHash);
        return row && typeof row.result === "string" ? JSON.parse(row.result) : undefined;
    }
    attempted(cohort, e, now) {
        this.#db.prepare(`UPDATE response_results SET attempts=attempts+1,attempted_at=?,
      status=CASE WHEN status='ok' THEN 'ok' ELSE 'failed' END
      WHERE cohort=? AND id=? AND input_hash=?`)
            .run(now, cohort, e.id, e.inputHash);
    }
    stale(cohort, e) {
        // Snapshot races are not provider failures and must not exhaust their retry budget.
        this.#db.prepare(`UPDATE response_results SET attempts=MAX(0,attempts-1),attempted_at=NULL,
      status=CASE WHEN status='ok' THEN 'ok' ELSE 'pending' END
      WHERE cohort=? AND id=? AND input_hash=? AND active=1
      AND (status='failed' OR (status='ok' AND json_extract(result,'$.memory.status')='unavailable'))`)
            .run(cohort, e.id, e.inputHash);
    }
    save(cohort, e, result, now) {
        result = { ...result, human: result.human ?? new ResponsePeople().resolve(e) };
        const memoryUnavailable = result.memory.status === "unavailable" ? 1 : 0;
        immediateTransaction(this.#db, () => {
            const changed = this.#db.prepare(`UPDATE response_results SET
        attempts=CASE WHEN ?=1 AND (status!='ok' OR COALESCE(json_extract(result,'$.memory.status'),'')!='unavailable') THEN 1 ELSE attempts END,
        attempted_at=CASE WHEN ?=1 THEN ? ELSE attempted_at END,
        status='ok',assessed_at=?,result=? WHERE cohort=? AND id=? AND input_hash=? AND active=1`)
                .run(memoryUnavailable, memoryUnavailable, now, now, JSON.stringify(result), cohort, e.id, e.inputHash).changes;
            if (changed)
                this.reviews.sync(cohort, e.id, e.inputHash, result, now);
        });
    }
    cursor(cohort) { return String(this.#db.prepare("SELECT cursor FROM response_cursors WHERE cohort=?").get(cohort)?.cursor ?? ""); }
    advance(cohort, cursor) {
        this.#db.prepare("INSERT INTO response_cursors VALUES(?,?) ON CONFLICT(cohort) DO UPDATE SET cursor=excluded.cursor").run(cohort, cursor);
    }
    checkpoint(cohort, session) {
        const row = this.#db.prepare("SELECT revision,coverage FROM response_checkpoints WHERE cohort=? AND session_id=?").get(cohort, session);
        return row ? { revision: String(row.revision), coverage: JSON.parse(String(row.coverage)) } : undefined;
    }
    checkpointSave(cohort, session, revision, coverage) {
        this.#db.prepare("INSERT INTO response_checkpoints VALUES(?,?,?,?) ON CONFLICT(cohort,session_id) DO UPDATE SET revision=excluded.revision,coverage=excluded.coverage")
            .run(cohort, session, revision, JSON.stringify(coverage));
    }
    checkpointForget(cohort, session) {
        this.#db.prepare("DELETE FROM response_checkpoints WHERE cohort=? AND session_id=?").run(cohort, session);
    }
    sessionWork(cohort, session, since, now) {
        const row = this.#db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN (status!='ok' OR json_extract(result,'$.memory.status')='unavailable')
      AND attempts<? AND (attempted_at IS NULL OR attempted_at<=?) THEN 1 ELSE 0 END) due FROM response_results
      WHERE cohort=? AND session_id=? AND active=1 AND episode_at>=?`)
            .get(MAX_RETRY_ATTEMPTS, now - RETRY_BACKOFF_MS, cohort, session, since);
        return { total: Number(row.total), due: Number(row.due ?? 0) };
    }
    pendingWork(cohort, since, now) {
        return Number(this.#db.prepare(`SELECT COUNT(*) n FROM response_results WHERE cohort=? AND active=1 AND episode_at>=?
      AND (status!='ok' OR json_extract(result,'$.memory.status')='unavailable')
      AND attempts<? AND (attempted_at IS NULL OR attempted_at<=?)`)
            .get(cohort, since, MAX_RETRY_ATTEMPTS, now - RETRY_BACKOFF_MS).n);
    }
    /** Retry eligibility is not completion: include backoff and exhausted work. */
    unresolvedWork(cohort, since, until) {
        return Number(this.#db.prepare(`SELECT COUNT(*) n FROM response_results r WHERE cohort=? AND active=1
      AND episode_at>=? AND episode_at<? AND (status!='ok' OR json_extract(result,'$.memory.status')='unavailable' OR EXISTS (
        SELECT 1 FROM response_stage_links l LEFT JOIN response_stages s ON s.key=l.key
        WHERE l.cohort=r.cohort AND l.episode_id=r.id AND l.input_hash=r.input_hash AND (s.status IS NULL OR s.status!='ok')))`)
            .get(cohort, since, until).n);
    }
    stage(cohort, e, stage, key, contract) {
        return immediateTransaction(this.#db, () => {
            this.#db.prepare("INSERT OR IGNORE INTO response_stages(key,stage) VALUES(?,?)").run(key, stage);
            this.#db.prepare(`INSERT INTO response_stage_links VALUES(?,?,?,?,?) ON CONFLICT(cohort,episode_id,stage)
        DO UPDATE SET input_hash=excluded.input_hash,key=excluded.key`).run(cohort, e.id, e.inputHash, stage, key);
            const row = this.#db.prepare("SELECT result FROM response_stages WHERE key=? AND status='ok'").get(key);
            if (!row)
                return undefined;
            try {
                if (typeof row.result !== "string")
                    throw new Error("Missing cached response stage payload");
                const effectiveContract = (contract !== undefined
                    ? contract
                    : stage === "retrospective" && e.followup
                        ? { status: e.followup.status }
                        : undefined);
                return validateCachedStage(stage, JSON.parse(row.result), effectiveContract);
            }
            catch {
                // Evict only this corrupted cached stage so valid siblings remain cached and this stage can recompute cleanly.
                this.#db.prepare(`UPDATE response_stages
          SET status='pending',attempts=0,attempted_at=NULL,assessed_at=NULL,result=NULL
          WHERE key=? AND status='ok'`).run(key);
                return undefined;
            }
        });
    }
    stageBegin(keys, now) {
        immediateTransaction(this.#db, () => {
            for (const key of keys) {
                const changed = this.#db.prepare(`UPDATE response_stages SET attempts=attempts+1,attempted_at=?,status='failed'
          WHERE key=? AND status!='ok' AND attempts<? AND (attempted_at IS NULL OR attempted_at<=?)`)
                    .run(now, key, MAX_RETRY_ATTEMPTS, now - RETRY_BACKOFF_MS).changes;
                if (!changed)
                    throw new Error("Response stage in backoff or retry exhausted");
            }
        });
    }
    stageSave(key, result, now) {
        this.#db.prepare("UPDATE response_stages SET status='ok',result=?,assessed_at=? WHERE key=?").run(JSON.stringify(result), now, key);
    }
    retryFailed(cohort) {
        return immediateTransaction(this.#db, () => {
            const memoryOnly = this.#db.prepare(`UPDATE response_results AS r SET attempts=0,attempted_at=NULL
        WHERE cohort=? AND active=1 AND status='ok' AND json_extract(result,'$.memory.status')='unavailable'
        AND NOT EXISTS (
          SELECT 1 FROM response_stage_links l LEFT JOIN response_stages s ON s.key=l.key
          WHERE l.cohort=r.cohort AND l.episode_id=r.id AND l.input_hash=r.input_hash
            AND l.stage!='memory' AND (s.status IS NULL OR s.status!='ok')
        )`).run(cohort).changes;
            const reset = this.#db.prepare(`UPDATE response_results AS r
        SET attempts=0,attempted_at=NULL,assessed_at=NULL,result=NULL,status='pending'
        WHERE cohort=? AND active=1 AND (
          status!='ok'
          OR (NOT (status='ok' AND COALESCE(json_extract(result,'$.memory.status'),'')='unavailable') AND EXISTS (
            SELECT 1 FROM response_stage_links l LEFT JOIN response_stages s ON s.key=l.key
            WHERE l.cohort=r.cohort AND l.episode_id=r.id AND l.input_hash=r.input_hash
              AND (s.status IS NULL OR s.status!='ok')
          ))
          OR EXISTS (
            SELECT 1 FROM response_stage_links l LEFT JOIN response_stages s ON s.key=l.key
            WHERE l.cohort=r.cohort AND l.episode_id=r.id AND l.input_hash=r.input_hash
              AND l.stage!='memory' AND (s.status IS NULL OR s.status!='ok')
          )
        )`).run(cohort).changes;
            const stages = this.#db.prepare(`UPDATE response_stages SET attempts=0,attempted_at=NULL,assessed_at=NULL,result=NULL,status='pending'
        WHERE status!='ok' AND key IN (SELECT l.key FROM response_stage_links l JOIN response_results r
        ON r.cohort=l.cohort AND r.id=l.episode_id AND r.input_hash=l.input_hash WHERE r.cohort=? AND r.active=1)`)
                .run(cohort).changes;
            return { stages: Number(stages), episodes: Number(memoryOnly) + Number(reset) };
        });
    }
    scan(cohort, coverage, now) {
        this.#db.prepare("INSERT INTO response_scans VALUES(?,?,?) ON CONFLICT(cohort) DO UPDATE SET observed_at=excluded.observed_at,coverage=excluded.coverage")
            .run(cohort, now, JSON.stringify(coverage));
    }
    report(cohort, since, id, options = {}) {
        const until = options.until ?? Number.MAX_SAFE_INTEGER, bucket = options.bucket ?? "week";
        if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since || !["day", "week"].includes(bucket))
            throw new Error("Invalid response report range");
        if (!!options.senderId !== !!options.accountScope)
            throw new Error("Sender reports require both sender ID and account scope");
        const filters = [
            ["$.human.senderId", options.senderId], ["$.human.accountScope", options.accountScope], ["$.human.personId", options.personId],
            ["$.quality.taskType.choice", options.taskType], ["$.agentModel", options.agentModel],
        ].filter((pair) => pair[1] !== undefined);
        const rows = this.#db.prepare(`SELECT id,episode_at,assessed_at,status,result FROM response_results
      WHERE cohort=? AND active=1 AND episode_at>=? AND episode_at<? ${id ? "AND id=?" : ""}
      ${filters.map(() => "AND json_extract(result,?)=?").join(" ")}
      ORDER BY episode_at DESC,id LIMIT 10001`).all(cohort, since, until, ...(id ? [id] : []), ...filters.flat());
        const scan = this.#db.prepare("SELECT observed_at,coverage FROM response_scans WHERE cohort=?").get(cohort);
        const groups = new Map();
        const examples = [];
        for (const row of rows.slice(0, 10000)) {
            if (row.status !== "ok" || typeof row.result !== "string")
                continue;
            const r = JSON.parse(row.result);
            const date = new Date(Number(row.episode_at));
            if (bucket === "week")
                date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
            const week = date.toISOString().slice(0, 10);
            const taskType = r.quality.taskType.confidence >= DEFAULTS.responseAudit.scoreHigh ? r.quality.taskType.choice : "uncertain";
            const human = r.human ?? null;
            const key = JSON.stringify([week, taskType, r.agentModel, human?.key ?? null]);
            const g = groups.get(key) ?? createReportGroup(week, human, taskType, r.agentModel);
            const { signals, outcome } = recordEpisodeInGroup(g, r);
            groups.set(key, g);
            if (signals.length && examples.length < 20)
                examples.push({ id: String(row.id), episodeAt: Number(row.episode_at), assessedAt: Number(row.assessed_at), signals, outcome });
        }
        const summaries = [...groups.values()].map(summarizeGroup);
        const trends = computeTrends(summaries);
        const stages = this.#db.prepare(`SELECT s.stage,s.status,COUNT(*) count,
      SUM(CASE WHEN s.status!='ok' AND s.attempts>=? THEN 1 ELSE 0 END) exhausted
      FROM response_stage_links l JOIN response_stages s ON s.key=l.key JOIN response_results r
      ON r.cohort=l.cohort AND r.id=l.episode_id AND r.input_hash=l.input_hash
      WHERE r.cohort=? AND r.active=1 AND r.episode_at>=? AND r.episode_at<? GROUP BY s.stage,s.status`).all(MAX_RETRY_ATTEMPTS, cohort, since, until);
        return { cohort, reportVersion: RESPONSE_REPORT_VERSION, reviewPolicy: RESPONSE_REVIEW_POLICY, bucket, since, until,
            annotations: this.reviews.annotations(since, until), stages, stageCountsScope: "cohort_and_date_range_before_person_filters",
            rubricScope: "Responded-to exchanges only; observational, not factual verification or causal performance attribution.",
            coverage: scan ? { observedAt: scan.observed_at, ...JSON.parse(String(scan.coverage)) } : null,
            stored: rows.length, reportCapped: rows.length > 10000,
            failedOrPending: rows.filter(r => r.status !== "ok").length,
            groups: summaries, trends, examples,
            ...(id ? { episode: rows[0] ? { ...rows[0], result: rows[0].result ? JSON.parse(String(rows[0].result)) : null } : null } : {}),
            limitations: ["Confidence cutoffs are provisional and need human calibration.", "Unseen artifacts and external correctness are not scored as verified.",
                "Sentiment is expressed reaction, not verified agent fault. Annoyance and frustration may overlap. Intensity is not confidence or failure severity.",
                "Sentiment rates are confident positive signals among sentiment-assessed exchanges (mixed includes dissatisfaction). Read unknown counts/rates alongside them; disabled or legacy-missing fields are not neutral. Emotion rates have their own assessed and uncertain counts.",
                "Observed success is acknowledgment among known outcomes, not all responses or verified task success. Unknowns are excluded; changes in coverage can change this rate. Reasons can overlap.",
                "Week buckets can be partial and repeated exchanges in a session are not independent. Intervals are descriptive, not calibrated uncertainty about the agent's overall performance.",
                "Score deltas require 20 confident samples per dimension in both periods and unchanged scored coverage. Rate deltas require 20 evaluated exchanges per period; acknowledgment, shortfall and unknown rates share that denominator and must be read together.",
                "Coverage flags and fixed rubric/report versions do not eliminate judge threshold variability or selection bias. Deltas are descriptive, not statistical change-point or causal evidence.",
                "No feedback is not success. Compare like task types and judge versions; score movement alone is not proof of improvement.",
                "Evidence references describe the assessed snapshot; transcript rewrites are reconciled on the next in-scope scan."] };
    }
    close() { this.#db.close(); }
}
function createReportGroup(week, human, taskType, agentModel) {
    return {
        week, human, taskType, agentModel, evaluated: 0, assessable: 0, fitAssessable: 0,
        fulfillmentScored: 0, deliverableFitScored: 0,
        fulfillmentSum: 0, deliverableSum: 0, feedbackCertain: 0, accepted: 0, reworkCertain: 0, rework: 0, memoryGap: 0, dissatisfied: 0,
        sentimentAssessed: 0, sentimentCertain: 0, emotionAssessed: 0, annoyed: 0, frustrated: 0,
        annoyanceUncertain: 0, frustrationUncertain: 0, dissatisfactionIntensityScored: 0, intensitySum: 0,
        underdeliveryCertain: 0, underdelivery: 0, failureReasons: {},
        feedbackTargets: {}, retrospectiveAssessed: 0, laterCorrections: 0, deliveryAdmissions: 0,
        outcomeKnown: 0, acknowledgedSuccess: 0, reportedShortfall: 0, outcomeReasons: {},
    };
}
function recordEpisodeInGroup(g, r) {
    g.evaluated++;
    const underdelivery = r.quality.underdelivery.noul >= DEFAULTS.responseAudit.scoreHigh;
    if (r.quality.underdelivery.noul <= DEFAULTS.responseAudit.scoreLow || underdelivery)
        g.underdeliveryCertain++;
    if (underdelivery) {
        g.underdelivery++;
        const reason = r.quality.failureReason.confidence >= DEFAULTS.responseAudit.scoreHigh ? r.quality.failureReason.choice : "uncertain";
        g.failureReasons[reason] = (g.failureReasons[reason] ?? 0) + 1;
    }
    if (r.quality.assessability.choice === "assessable" && r.quality.assessability.confidence >= DEFAULTS.responseAudit.scoreHigh) {
        g.assessable++;
        if (r.quality.fulfillment.confidence >= DEFAULTS.responseAudit.scoreHigh) {
            g.fulfillmentScored++;
            g.fulfillmentSum += r.quality.fulfillment.score;
        }
    }
    if (r.quality.fitAssessability.choice === "assessable" && r.quality.fitAssessability.confidence >= DEFAULTS.responseAudit.scoreHigh) {
        g.fitAssessable++;
        if (r.quality.deliverableFit.confidence >= DEFAULTS.responseAudit.scoreHigh) {
            g.deliverableFitScored++;
            g.deliverableSum += r.quality.deliverableFit.score;
        }
    }
    const target = r.feedback.target.confidence >= DEFAULTS.responseAudit.scoreHigh ? r.feedback.target.choice : "uncertain";
    g.feedbackTargets[target] = (g.feedbackTargets[target] ?? 0) + 1;
    const laterCorrection = (r.retrospective.judgment?.correction.noul ?? 0) >= DEFAULTS.responseAudit.scoreHigh;
    const deliveryAdmission = (r.retrospective.judgment?.deliveryAdmission.noul ?? 0) >= DEFAULTS.responseAudit.scoreHigh;
    const outcome = responseOutcome(r);
    const reportedShortfall = outcome.status === "reported_shortfall";
    if (reportedShortfall || outcome.status === "acknowledged_success") {
        g.outcomeKnown++;
        if (reportedShortfall) {
            g.reportedShortfall++;
            for (const label of outcome.reasons.length ? outcome.reasons : ["uncertain"]) {
                g.outcomeReasons[label] = (g.outcomeReasons[label] ?? 0) + 1;
            }
        }
        else
            g.acknowledgedSuccess++;
    }
    if (r.retrospective.judgment)
        g.retrospectiveAssessed++;
    if (laterCorrection)
        g.laterCorrections++;
    if (deliveryAdmission)
        g.deliveryAdmissions++;
    if (r.feedback.feedbackType.confidence >= DEFAULTS.responseAudit.scoreHigh) {
        g.feedbackCertain++;
        if (r.feedback.feedbackType.choice === "acceptance")
            g.accepted++;
    }
    const burden = r.feedback.avoidableRework.noul;
    if (burden <= DEFAULTS.responseAudit.scoreLow || burden >= DEFAULTS.responseAudit.scoreHigh) {
        g.reworkCertain++;
        if (burden >= DEFAULTS.responseAudit.scoreHigh)
            g.rework++;
    }
    const memoryGap = r.feedback.memoryGap.noul >= DEFAULTS.responseAudit.scoreHigh;
    const sentiment = r.feedback.sentiment;
    const sentimentCertain = !!sentiment && sentiment.confidence >= DEFAULTS.responseAudit.scoreHigh && sentiment.choice !== "unclear";
    const dissatisfied = sentimentCertain && ["dissatisfied", "mixed"].includes(sentiment.choice);
    if (sentiment)
        g.sentimentAssessed++;
    if (sentimentCertain)
        g.sentimentCertain++;
    const { annoyance, frustration, dissatisfactionIntensity: intensity } = r.feedback;
    const annoyed = !!annoyance && annoyance.noul >= DEFAULTS.responseAudit.scoreHigh;
    const frustrated = !!frustration && frustration.noul >= DEFAULTS.responseAudit.scoreHigh;
    if (annoyance && frustration) {
        g.emotionAssessed++;
        if (annoyed)
            g.annoyed++;
        if (frustrated)
            g.frustrated++;
        if (annoyance.noul > DEFAULTS.responseAudit.scoreLow && annoyance.noul < DEFAULTS.responseAudit.scoreHigh)
            g.annoyanceUncertain++;
        if (frustration.noul > DEFAULTS.responseAudit.scoreLow && frustration.noul < DEFAULTS.responseAudit.scoreHigh)
            g.frustrationUncertain++;
    }
    if (intensity && intensity.confidence >= DEFAULTS.responseAudit.scoreHigh) {
        g.dissatisfactionIntensityScored++;
        g.intensitySum += intensity.score;
    }
    if (memoryGap)
        g.memoryGap++;
    if (dissatisfied)
        g.dissatisfied++;
    const signals = [underdelivery ? "clear_underdelivery" : "", burden >= DEFAULTS.responseAudit.scoreHigh ? "avoidable_rework" : "", memoryGap ? "reported_memory_gap" : "", dissatisfied ? `dissatisfied:${target}` : "",
        annoyed ? `annoyed:${target}` : "", frustrated ? `frustrated:${target}` : "",
        laterCorrection ? "later_correction" : "", deliveryAdmission ? "delivery_admission" : "", reportedShortfall ? "reported_shortfall" : ""].filter(Boolean);
    return { signals, outcome };
}
function summarizeGroup({ fulfillmentSum, deliverableSum, intensitySum, ...g }) {
    return {
        ...g,
        periodStart: g.week,
        fulfillmentMean: g.fulfillmentScored ? fulfillmentSum / g.fulfillmentScored : null,
        deliverableFitMean: g.deliverableFitScored ? deliverableSum / g.deliverableFitScored : null,
        sentimentNotAssessed: g.evaluated - g.sentimentAssessed,
        sentimentUnknown: g.sentimentAssessed - g.sentimentCertain,
        sentimentCoverage: g.sentimentAssessed / g.evaluated,
        // Observed rates include uncertainty in their denominator, never silently label it neutral.
        dissatisfactionRate: g.sentimentAssessed ? g.dissatisfied / g.sentimentAssessed : null,
        sentimentUnknownRate: g.sentimentAssessed ? (g.sentimentAssessed - g.sentimentCertain) / g.sentimentAssessed : null,
        annoyanceRate: g.emotionAssessed ? g.annoyed / g.emotionAssessed : null,
        frustrationRate: g.emotionAssessed ? g.frustrated / g.emotionAssessed : null,
        dissatisfactionIntensityMean: g.dissatisfactionIntensityScored ? intensitySum / g.dissatisfactionIntensityScored : null,
        observedSuccessRate: g.outcomeKnown ? g.acknowledgedSuccess / g.outcomeKnown : null,
        observedSuccessRate95Interval: wilson(g.acknowledgedSuccess, g.outcomeKnown),
        outcomeUnknown: g.evaluated - g.outcomeKnown,
        outcomeCoverage: g.outcomeKnown / g.evaluated,
        acknowledgedRate: g.acknowledgedSuccess / g.evaluated,
        reportedShortfallRate: g.reportedShortfall / g.evaluated,
        unknownRate: (g.evaluated - g.outcomeKnown) / g.evaluated,
        underdeliveryRate: g.underdeliveryCertain ? g.underdelivery / g.underdeliveryCertain : null,
        underdeliveryRate95Interval: wilson(g.underdelivery, g.underdeliveryCertain),
        reworkRate: g.reworkCertain ? g.rework / g.reworkCertain : null,
        reworkRate95Interval: wilson(g.rework, g.reworkCertain),
        smallSample: g.evaluated < 20,
    };
}
const TREND_DIMENSIONS = [
    { dimension: "fulfillment", sampleKey: "fulfillmentScored", valueKey: "fulfillmentMean", assessedSubset: true,
        denominator: "confident_assessable_exchanges", scale: "0_to_3_visible_quality" },
    { dimension: "deliverableFit", sampleKey: "deliverableFitScored", valueKey: "deliverableFitMean", assessedSubset: true,
        denominator: "confident_assessable_exchanges", scale: "0_to_3_visible_quality" },
    { dimension: "acknowledgedRate", sampleKey: "evaluated", valueKey: "acknowledgedRate", assessedSubset: false,
        denominator: "all_evaluated_exchanges", scale: "0_to_1_observed_rate" },
    { dimension: "reportedShortfallRate", sampleKey: "evaluated", valueKey: "reportedShortfallRate", assessedSubset: false,
        denominator: "all_evaluated_exchanges", scale: "0_to_1_observed_rate" },
    { dimension: "unknownRate", sampleKey: "evaluated", valueKey: "unknownRate", assessedSubset: false,
        denominator: "all_evaluated_exchanges", scale: "0_to_1_observed_rate" },
    { dimension: "dissatisfactionRate", sampleKey: "sentimentAssessed", valueKey: "dissatisfactionRate", assessedSubset: true,
        denominator: "sentiment_assessed_exchanges", scale: "0_to_1_observed_rate" },
    { dimension: "sentimentUnknownRate", sampleKey: "sentimentAssessed", valueKey: "sentimentUnknownRate", assessedSubset: true,
        denominator: "sentiment_assessed_exchanges", scale: "0_to_1_observed_rate" },
    { dimension: "annoyanceRate", sampleKey: "emotionAssessed", valueKey: "annoyanceRate", assessedSubset: true,
        denominator: "emotion_assessed_exchanges", scale: "0_to_1_observed_rate" },
    { dimension: "frustrationRate", sampleKey: "emotionAssessed", valueKey: "frustrationRate", assessedSubset: true,
        denominator: "emotion_assessed_exchanges", scale: "0_to_1_observed_rate" },
    { dimension: "dissatisfactionIntensity", sampleKey: "dissatisfactionIntensityScored", valueKey: "dissatisfactionIntensityMean", assessedSubset: true,
        denominator: "confident_intensity_exchanges", scale: "0_to_3_expressed_dissatisfaction" },
];
function computeTrends(summaries) {
    const byStratum = new Map();
    for (const summary of summaries) {
        const stratumKey = JSON.stringify([summary.taskType, summary.agentModel, summary.human?.key ?? null]);
        const list = byStratum.get(stratumKey);
        if (list)
            list.push(summary);
        else
            byStratum.set(stratumKey, [summary]);
    }
    const previousBySummary = new Map();
    for (const periods of byStratum.values()) {
        if (periods.length < 2)
            continue;
        periods.sort((a, b) => a.week.localeCompare(b.week));
        for (let i = 1; i < periods.length; i++)
            previousBySummary.set(periods[i], periods[i - 1]);
    }
    return summaries.flatMap(current => {
        const previous = previousBySummary.get(current);
        if (!previous)
            return [];
        const unknownStratum = !current.human || !current.human.accountScope || current.taskType === "uncertain" || current.agentModel === "unknown";
        return TREND_DIMENSIONS.map(spec => {
            const beforeN = previous[spec.sampleKey];
            const afterN = current[spec.sampleKey];
            const before = previous[spec.valueKey];
            const after = current[spec.valueKey];
            const beforeCoverage = spec.assessedSubset ? beforeN / previous.evaluated : previous.outcomeCoverage;
            const afterCoverage = spec.assessedSubset ? afterN / current.evaluated : current.outcomeCoverage;
            const coverageChanged = beforeCoverage !== afterCoverage;
            const status = unknownStratum ? "unknown_stratum"
                : beforeN < 20 || afterN < 20 ? "insufficient_samples"
                    : spec.assessedSubset && coverageChanged ? "coverage_changed"
                        : "descriptive_comparison";
            return {
                fromWeek: previous.week, toWeek: current.week, taskType: current.taskType, agentModel: current.agentModel,
                fromPeriod: previous.week, toPeriod: current.week, human: current.human,
                dimension: spec.dimension, beforeN, afterN, status,
                before, after, beforeEvaluated: previous.evaluated, afterEvaluated: current.evaluated,
                beforeCoverage, afterCoverage, coverageChanged,
                denominator: spec.denominator, scale: spec.scale,
                delta: status === "descriptive_comparison" ? after - before : null,
            };
        });
    });
}
function wilson(successes, total) {
    if (!total)
        return null;
    const z = 1.96, p = successes / total, denominator = 1 + z * z / total;
    const center = (p + z * z / (2 * total)) / denominator;
    const half = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
    return [Math.max(0, center - half), Math.min(1, center + half)];
}
