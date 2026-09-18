import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ResponseEpisode } from "./response-episodes.js";
import type { ResponseJudgment, ResponseStages, judgeMemoryOpportunity, judgeResponseFollowup } from "./response-judge.js";
import { responseOutcome, RESPONSE_REPORT_VERSION } from "./response-outcome.js";
import type { ResponseHuman } from "./response-identity.js";
import { ResponsePeople } from "./response-identity.js";
import { ResponseReviews, RESPONSE_REVIEW_POLICY } from "./response-reviews.js";

export type ResponseResult = ResponseJudgment & {
  references: { sessionId: string; request: number[]; answer: number[]; feedback: number[]; followup: number[]; inputHash: string };
  retrospective: Awaited<ReturnType<typeof judgeResponseFollowup>>;
  agentModel: string;
  human?: ResponseHuman;
  contextLimited: boolean;
  memorySearchCalls: number;
  memory: { status: "not_requested" | "unavailable" | "checked"; candidates: Awaited<ReturnType<typeof judgeMemoryOpportunity>> };
};
export type ResponseReportOptions = {
  until?: number; bucket?: "day" | "week"; senderId?: string; accountScope?: string;
  personId?: string; taskType?: string; agentModel?: string;
};

/** Separate operator-only database: not a memory corpus and never injected into agent prompts. */
export class ResponseAuditStore {
  readonly #db: DatabaseSync;
  readonly reviews: ResponseReviews;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS response_lease (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS response_results (
        cohort TEXT, id TEXT, session_id TEXT NOT NULL, input_hash TEXT NOT NULL,
        episode_at INTEGER NOT NULL, active INTEGER NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, attempted_at INTEGER, assessed_at INTEGER, result TEXT,
        PRIMARY KEY(cohort,id));
      CREATE TABLE IF NOT EXISTS response_scans (cohort TEXT PRIMARY KEY, observed_at INTEGER, coverage TEXT);
      CREATE INDEX IF NOT EXISTS response_results_time ON response_results(cohort,episode_at);`);
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
    this.reviews = new ResponseReviews(this.#db);
  }
  /** Claim one bounded scheduled attempt, never replay every missed interval. */
  claimScheduled(now: number, intervalMs: number): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`INSERT INTO response_schedule VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET
        next_due=next_due + excluded.interval_ms - interval_ms, interval_ms=excluded.interval_ms`)
        .run(intervalMs, now + intervalMs);
      const claimed = this.#db.prepare("UPDATE response_schedule SET next_due=? WHERE id=1 AND next_due<=?")
        .run(now + intervalMs, now).changes > 0;
      this.#db.exec("COMMIT");
      return claimed;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  acquire(now: number): string | undefined {
    const token = randomUUID();
    const result = this.#db.prepare(`INSERT INTO response_lease VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE response_lease.expires < ?`)
      .run(token, now + 180_000, now);
    return result.changes ? token : undefined;
  }
  release(token: string) { this.#db.prepare("DELETE FROM response_lease WHERE token=?").run(token); }
  activeSessions(cohort: string, since: number) {
    return this.#db.prepare(`SELECT DISTINCT session_id FROM response_results
      WHERE cohort=? AND active=1 AND episode_at>=? ORDER BY session_id`).all(cohort, since).map(row => String(row.session_id));
  }
  observe(cohort: string, sessionId: string, episodes: readonly ResponseEpisode[]) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE response_results SET active=0 WHERE cohort=? AND session_id=?").run(cohort, sessionId);
      const insert = this.#db.prepare(`INSERT INTO response_results(cohort,id,session_id,input_hash,episode_at,active,status)
        VALUES(?,?,?,?,?,1,'pending') ON CONFLICT(cohort,id) DO UPDATE SET active=1,
        input_hash=excluded.input_hash,episode_at=excluded.episode_at,
        status=CASE WHEN input_hash=excluded.input_hash THEN status ELSE 'pending' END,
        attempts=CASE WHEN input_hash=excluded.input_hash THEN attempts ELSE 0 END,
        attempted_at=CASE WHEN input_hash=excluded.input_hash THEN attempted_at ELSE NULL END,
        assessed_at=CASE WHEN input_hash=excluded.input_hash THEN assessed_at ELSE NULL END,
        result=CASE WHEN input_hash=excluded.input_hash THEN result ELSE NULL END`);
      for (const e of episodes) insert.run(cohort, e.id, sessionId, e.inputHash, e.timestamp);
      this.reviews.reconcile(cohort);
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  needsJudgment(cohort: string, e: ResponseEpisode, now: number) {
    const row = this.#db.prepare("SELECT status,attempts,attempted_at FROM response_results WHERE cohort=? AND id=? AND input_hash=? AND active=1")
      .get(cohort, e.id, e.inputHash);
    return !!row && row.status !== "ok" && Number(row.attempts) < 3 && (!row.attempted_at || now - Number(row.attempted_at) >= 600_000);
  }
  attempted(cohort: string, e: ResponseEpisode, now: number) {
    this.#db.prepare("UPDATE response_results SET attempts=attempts+1,attempted_at=?,status='failed' WHERE cohort=? AND id=? AND input_hash=?")
      .run(now, cohort, e.id, e.inputHash);
  }
  stale(cohort: string, e: ResponseEpisode) {
    // Snapshot races are not provider failures and must not exhaust their retry budget.
    this.#db.prepare(`UPDATE response_results SET attempts=MAX(0,attempts-1),attempted_at=NULL,status='pending'
      WHERE cohort=? AND id=? AND input_hash=? AND active=1 AND status='failed'`).run(cohort, e.id, e.inputHash);
  }
  save(cohort: string, e: ResponseEpisode, result: ResponseResult, now: number) {
    result = { ...result, human: result.human ?? new ResponsePeople().resolve(e) };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.#db.prepare("UPDATE response_results SET status='ok',assessed_at=?,result=? WHERE cohort=? AND id=? AND input_hash=? AND active=1")
        .run(now, JSON.stringify(result), cohort, e.id, e.inputHash).changes;
      if (changed) this.reviews.sync(cohort, e.id, e.inputHash, result, now);
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  cursor(cohort: string) { return String(this.#db.prepare("SELECT cursor FROM response_cursors WHERE cohort=?").get(cohort)?.cursor ?? ""); }
  advance(cohort: string, cursor: string) {
    this.#db.prepare("INSERT INTO response_cursors VALUES(?,?) ON CONFLICT(cohort) DO UPDATE SET cursor=excluded.cursor").run(cohort, cursor);
  }
  checkpoint(cohort: string, session: string) {
    const row = this.#db.prepare("SELECT revision,coverage FROM response_checkpoints WHERE cohort=? AND session_id=?").get(cohort, session);
    return row ? { revision: String(row.revision), coverage: JSON.parse(String(row.coverage)) as ReturnType<typeof import("./response-episodes.js").responseEpisodes>["coverage"] } : undefined;
  }
  checkpointSave(cohort: string, session: string, revision: string, coverage: object) {
    this.#db.prepare("INSERT INTO response_checkpoints VALUES(?,?,?,?) ON CONFLICT(cohort,session_id) DO UPDATE SET revision=excluded.revision,coverage=excluded.coverage")
      .run(cohort, session, revision, JSON.stringify(coverage));
  }
  checkpointForget(cohort: string, session: string) {
    this.#db.prepare("DELETE FROM response_checkpoints WHERE cohort=? AND session_id=?").run(cohort, session);
  }
  sessionWork(cohort: string, session: string, since: number, now: number) {
    const row = this.#db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN status!='ok' AND attempts<3 AND
      (attempted_at IS NULL OR attempted_at<=?) THEN 1 ELSE 0 END) due FROM response_results
      WHERE cohort=? AND session_id=? AND active=1 AND episode_at>=?`).get(now - 600_000, cohort, session, since)!;
    return { total: Number(row.total), due: Number(row.due ?? 0) };
  }
  pendingWork(cohort: string, since: number, now: number) {
    return Number(this.#db.prepare(`SELECT COUNT(*) n FROM response_results WHERE cohort=? AND active=1 AND episode_at>=?
      AND status!='ok' AND attempts<3 AND (attempted_at IS NULL OR attempted_at<=?)`).get(cohort, since, now - 600_000)!.n);
  }
  stage<K extends keyof ResponseStages>(cohort: string, e: ResponseEpisode, stage: K, key: string): ResponseStages[K] | undefined {
    this.#db.prepare("INSERT OR IGNORE INTO response_stages(key,stage) VALUES(?,?)").run(key, stage);
    this.#db.prepare(`INSERT INTO response_stage_links VALUES(?,?,?,?,?) ON CONFLICT(cohort,episode_id,stage)
      DO UPDATE SET input_hash=excluded.input_hash,key=excluded.key`).run(cohort, e.id, e.inputHash, stage, key);
    const row = this.#db.prepare("SELECT result FROM response_stages WHERE key=? AND status='ok'").get(key);
    return row ? JSON.parse(String(row.result)) as ResponseStages[K] : undefined;
  }
  stageBegin(keys: string[], now: number) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const key of keys) {
        const changed = this.#db.prepare(`UPDATE response_stages SET attempts=attempts+1,attempted_at=?,status='failed'
          WHERE key=? AND status!='ok' AND attempts<3 AND (attempted_at IS NULL OR attempted_at<=?)`).run(now, key, now - 600_000).changes;
        if (!changed) throw new Error("Response stage in backoff or retry exhausted");
      }
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  stageSave<K extends keyof ResponseStages>(key: string, result: ResponseStages[K], now: number) {
    this.#db.prepare("UPDATE response_stages SET status='ok',result=?,assessed_at=? WHERE key=?").run(JSON.stringify(result), now, key);
  }
  retryFailed(cohort: string) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const episodes = this.#db.prepare(`UPDATE response_results AS r SET attempts=0,attempted_at=NULL,status='pending'
        WHERE cohort=? AND active=1 AND (status!='ok' OR json_extract(result,'$.memory.status')='unavailable' OR EXISTS (
          SELECT 1 FROM response_stage_links l JOIN response_stages s ON s.key=l.key
          WHERE l.cohort=r.cohort AND l.episode_id=r.id AND l.input_hash=r.input_hash AND s.status!='ok'))`).run(cohort).changes;
      const stages = this.#db.prepare(`UPDATE response_stages SET attempts=0,attempted_at=NULL,status='pending'
        WHERE status!='ok' AND key IN (SELECT l.key FROM response_stage_links l JOIN response_results r
        ON r.cohort=l.cohort AND r.id=l.episode_id AND r.input_hash=l.input_hash WHERE r.cohort=? AND r.active=1)`)
        .run(cohort).changes;
      this.#db.exec("COMMIT"); return { stages, episodes };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  scan(cohort: string, coverage: object, now: number) {
    this.#db.prepare("INSERT INTO response_scans VALUES(?,?,?) ON CONFLICT(cohort) DO UPDATE SET observed_at=excluded.observed_at,coverage=excluded.coverage")
      .run(cohort, now, JSON.stringify(coverage));
  }
  report(cohort: string, since: number, id?: string, options: ResponseReportOptions = {}) {
    const until = options.until ?? Number.MAX_SAFE_INTEGER, bucket = options.bucket ?? "week";
    if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since || !["day", "week"].includes(bucket)) throw new Error("Invalid response report range");
    if (!!options.senderId !== !!options.accountScope) throw new Error("Sender reports require both sender ID and account scope");
    const filters = [
      ["$.human.senderId", options.senderId], ["$.human.accountScope", options.accountScope], ["$.human.personId", options.personId],
      ["$.quality.taskType.choice", options.taskType], ["$.agentModel", options.agentModel],
    ].filter((pair): pair is [string, string] => pair[1] !== undefined);
    const rows = this.#db.prepare(`SELECT id,episode_at,assessed_at,status,result FROM response_results
      WHERE cohort=? AND active=1 AND episode_at>=? AND episode_at<? ${id ? "AND id=?" : ""}
      ${filters.map(() => "AND json_extract(result,?)=?").join(" ")}
      ORDER BY episode_at DESC,id LIMIT 10001`).all(cohort, since, until, ...(id ? [id] : []), ...filters.flat());
    const scan = this.#db.prepare("SELECT observed_at,coverage FROM response_scans WHERE cohort=?").get(cohort);
    const groups = new Map<string, { week: string; human: ResponseHuman | null; taskType: string; agentModel: string; evaluated: number;
      assessable: number; fitAssessable: number; fulfillmentScored: number; deliverableFitScored: number;
      fulfillmentSum: number; deliverableSum: number; feedbackCertain: number;
      accepted: number; reworkCertain: number; rework: number; memoryGap: number; dissatisfied: number;
      sentimentAssessed: number; sentimentCertain: number; emotionAssessed: number; annoyed: number; frustrated: number;
      annoyanceUncertain: number; frustrationUncertain: number; dissatisfactionIntensityScored: number; intensitySum: number;
      underdeliveryCertain: number; underdelivery: number; failureReasons: Record<string, number>;
      feedbackTargets: Record<string, number>; retrospectiveAssessed: number; laterCorrections: number; deliveryAdmissions: number;
      outcomeKnown: number; acknowledgedSuccess: number; reportedShortfall: number; outcomeReasons: Record<string, number> }>();
    const examples: { id: string; episodeAt: number; assessedAt: number; signals: string[]; outcome: ReturnType<typeof responseOutcome> }[] = [];
    for (const row of rows.slice(0, 10000)) {
      if (row.status !== "ok" || typeof row.result !== "string") continue;
      const r = JSON.parse(row.result) as ResponseResult;
      const date = new Date(Number(row.episode_at));
      if (bucket === "week") date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
      const week = date.toISOString().slice(0, 10);
      const taskType = r.quality.taskType.confidence >= 0.8 ? r.quality.taskType.choice : "uncertain";
      const human = r.human ?? null;
      const key = JSON.stringify([week, taskType, r.agentModel, human?.key ?? null]);
      const g = groups.get(key) ?? { week, human, taskType, agentModel: r.agentModel, evaluated: 0, assessable: 0, fitAssessable: 0,
        fulfillmentScored: 0, deliverableFitScored: 0,
        fulfillmentSum: 0, deliverableSum: 0, feedbackCertain: 0, accepted: 0, reworkCertain: 0, rework: 0, memoryGap: 0, dissatisfied: 0,
        sentimentAssessed: 0, sentimentCertain: 0, emotionAssessed: 0, annoyed: 0, frustrated: 0,
        annoyanceUncertain: 0, frustrationUncertain: 0, dissatisfactionIntensityScored: 0, intensitySum: 0,
        underdeliveryCertain: 0, underdelivery: 0, failureReasons: {},
        feedbackTargets: {}, retrospectiveAssessed: 0, laterCorrections: 0, deliveryAdmissions: 0,
        outcomeKnown: 0, acknowledgedSuccess: 0, reportedShortfall: 0, outcomeReasons: {} };
      g.evaluated++;
      const underdelivery = r.quality.underdelivery.noul >= 0.8;
      if (r.quality.underdelivery.noul <= 0.2 || underdelivery) g.underdeliveryCertain++;
      if (underdelivery) {
        g.underdelivery++;
        const reason = r.quality.failureReason.confidence >= 0.8 ? r.quality.failureReason.choice : "uncertain";
        g.failureReasons[reason] = (g.failureReasons[reason] ?? 0) + 1;
      }
      if (r.quality.assessability.choice === "assessable" && r.quality.assessability.confidence >= 0.8) {
        g.assessable++;
        if (r.quality.fulfillment.confidence >= 0.8) { g.fulfillmentScored++; g.fulfillmentSum += r.quality.fulfillment.score; }
      }
      if (r.quality.fitAssessability.choice === "assessable" && r.quality.fitAssessability.confidence >= 0.8) {
        g.fitAssessable++;
        if (r.quality.deliverableFit.confidence >= 0.8) { g.deliverableFitScored++; g.deliverableSum += r.quality.deliverableFit.score; }
      }
      const target = r.feedback.target.confidence >= 0.8 ? r.feedback.target.choice : "uncertain";
      g.feedbackTargets[target] = (g.feedbackTargets[target] ?? 0) + 1;
      const laterCorrection = (r.retrospective.judgment?.correction.noul ?? 0) >= 0.8;
      const deliveryAdmission = (r.retrospective.judgment?.deliveryAdmission.noul ?? 0) >= 0.8;
      const outcome = responseOutcome(r);
      const reportedShortfall = outcome.status === "reported_shortfall";
      if (reportedShortfall || outcome.status === "acknowledged_success") {
        g.outcomeKnown++;
        if (reportedShortfall) {
          g.reportedShortfall++;
          for (const label of outcome.reasons.length ? outcome.reasons : ["uncertain"]) {
            g.outcomeReasons[label] = (g.outcomeReasons[label] ?? 0) + 1;
          }
        } else g.acknowledgedSuccess++;
      }
      if (r.retrospective.judgment) g.retrospectiveAssessed++;
      if (laterCorrection) g.laterCorrections++;
      if (deliveryAdmission) g.deliveryAdmissions++;
      if (r.feedback.feedbackType.confidence >= 0.8) { g.feedbackCertain++; if (r.feedback.feedbackType.choice === "acceptance") g.accepted++; }
      const burden = r.feedback.avoidableRework.noul;
      if (burden <= 0.2 || burden >= 0.8) { g.reworkCertain++; if (burden >= 0.8) g.rework++; }
      const memoryGap = r.feedback.memoryGap.noul >= 0.8;
      const sentiment = r.feedback.sentiment;
      const sentimentCertain = !!sentiment && sentiment.confidence >= 0.8 && sentiment.choice !== "unclear";
      const dissatisfied = sentimentCertain && ["dissatisfied", "mixed"].includes(sentiment.choice);
      if (sentiment) g.sentimentAssessed++;
      if (sentimentCertain) g.sentimentCertain++;
      const { annoyance, frustration, dissatisfactionIntensity: intensity } = r.feedback;
      const annoyed = !!annoyance && annoyance.noul >= 0.8;
      const frustrated = !!frustration && frustration.noul >= 0.8;
      if (annoyance && frustration) {
        g.emotionAssessed++;
        if (annoyed) g.annoyed++;
        if (frustrated) g.frustrated++;
        if (annoyance.noul > 0.2 && annoyance.noul < 0.8) g.annoyanceUncertain++;
        if (frustration.noul > 0.2 && frustration.noul < 0.8) g.frustrationUncertain++;
      }
      if (intensity && intensity.confidence >= 0.8) { g.dissatisfactionIntensityScored++; g.intensitySum += intensity.score; }
      if (memoryGap) g.memoryGap++;
      if (dissatisfied) g.dissatisfied++;
      groups.set(key, g);
      const signals = [underdelivery ? "clear_underdelivery" : "", burden >= 0.8 ? "avoidable_rework" : "", memoryGap ? "reported_memory_gap" : "", dissatisfied ? `dissatisfied:${target}` : "",
        annoyed ? `annoyed:${target}` : "", frustrated ? `frustrated:${target}` : "",
        laterCorrection ? "later_correction" : "", deliveryAdmission ? "delivery_admission" : "", reportedShortfall ? "reported_shortfall" : ""].filter(Boolean);
      if (signals.length && examples.length < 20) examples.push({ id: String(row.id), episodeAt: Number(row.episode_at), assessedAt: Number(row.assessed_at), signals, outcome });
    }
    const summaries = [...groups.values()].map(({ fulfillmentSum, deliverableSum, intensitySum, ...g }) => ({ ...g,
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
      reworkRate95Interval: wilson(g.rework, g.reworkCertain), smallSample: g.evaluated < 20,
    }));
    const trends = summaries.flatMap(current => {
      const previous = summaries.filter(g => g.taskType === current.taskType && g.agentModel === current.agentModel &&
        g.human?.key === current.human?.key && g.week < current.week)
        .sort((a, b) => b.week.localeCompare(a.week))[0];
      if (!previous) return [];
      return (["fulfillment", "deliverableFit", "acknowledgedRate", "reportedShortfallRate", "unknownRate",
        "dissatisfactionRate", "sentimentUnknownRate", "annoyanceRate", "frustrationRate", "dissatisfactionIntensity"] as const).map(dimension => {
        const scoreDimension = dimension === "fulfillment" || dimension === "deliverableFit" || dimension === "dissatisfactionIntensity" ? dimension : null;
        const sentimentDimension = dimension === "dissatisfactionRate" || dimension === "sentimentUnknownRate";
        const emotionDimension = dimension === "annoyanceRate" || dimension === "frustrationRate";
        const beforeN = scoreDimension ? previous[`${scoreDimension}Scored`] : sentimentDimension ? previous.sentimentAssessed : emotionDimension ? previous.emotionAssessed : previous.evaluated;
        const afterN = scoreDimension ? current[`${scoreDimension}Scored`] : sentimentDimension ? current.sentimentAssessed : emotionDimension ? current.emotionAssessed : current.evaluated;
        const before = dimension === "fulfillment" || dimension === "deliverableFit" || dimension === "dissatisfactionIntensity" ? previous[`${dimension}Mean`] : previous[dimension];
        const after = dimension === "fulfillment" || dimension === "deliverableFit" || dimension === "dissatisfactionIntensity" ? current[`${dimension}Mean`] : current[dimension];
        const beforeCoverage = scoreDimension || sentimentDimension || emotionDimension ? beforeN / previous.evaluated : previous.outcomeCoverage;
        const afterCoverage = scoreDimension || sentimentDimension || emotionDimension ? afterN / current.evaluated : current.outcomeCoverage;
        const coverageChanged = beforeCoverage !== afterCoverage;
        const enough = beforeN >= 20 && afterN >= 20 && current.taskType !== "uncertain" && current.agentModel !== "unknown";
        const status = !current.human || !current.human.accountScope || current.taskType === "uncertain" || current.agentModel === "unknown" ? "unknown_stratum" :
          !enough ? "insufficient_samples" : (scoreDimension || sentimentDimension || emotionDimension) && coverageChanged ? "coverage_changed" : "descriptive_comparison";
        return { fromWeek: previous.week, toWeek: current.week, taskType: current.taskType, agentModel: current.agentModel,
          fromPeriod: previous.week, toPeriod: current.week, human: current.human,
          dimension, beforeN, afterN, status,
          before, after, beforeEvaluated: previous.evaluated, afterEvaluated: current.evaluated,
          beforeCoverage, afterCoverage, coverageChanged,
          denominator: dimension === "dissatisfactionIntensity" ? "confident_intensity_exchanges" : scoreDimension ? "confident_assessable_exchanges" : sentimentDimension ? "sentiment_assessed_exchanges" : emotionDimension ? "emotion_assessed_exchanges" : "all_evaluated_exchanges",
          scale: dimension === "dissatisfactionIntensity" ? "0_to_3_expressed_dissatisfaction" : scoreDimension ? "0_to_3_visible_quality" : "0_to_1_observed_rate",
          delta: status === "descriptive_comparison" ? after! - before! : null };
      });
    });
    const stages = this.#db.prepare(`SELECT s.stage,s.status,COUNT(*) count,
      SUM(CASE WHEN s.status!='ok' AND s.attempts>=3 THEN 1 ELSE 0 END) exhausted
      FROM response_stage_links l JOIN response_stages s ON s.key=l.key JOIN response_results r
      ON r.cohort=l.cohort AND r.id=l.episode_id AND r.input_hash=l.input_hash
      WHERE r.cohort=? AND r.active=1 AND r.episode_at>=? AND r.episode_at<? GROUP BY s.stage,s.status`).all(cohort, since, until);
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

function wilson(successes: number, total: number) {
  if (!total) return null;
  const z = 1.96, p = successes / total, denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const half = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
