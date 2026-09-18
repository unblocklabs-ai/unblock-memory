import { createHash, randomUUID } from "node:crypto";
import { responseOutcome } from "./response-outcome.js";
export const RESPONSE_REVIEW_POLICY = "response-review-v2";
/** Operator-only tasks, intentionally not exposed as memory-curation agent tools. */
export class ResponseReviews {
    db;
    constructor(db) {
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS response_review_tasks (
      id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, family TEXT NOT NULL, human_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      reviewer_kind TEXT, resolution_note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(episode_id,family,human_key));
      CREATE TABLE IF NOT EXISTS response_review_evidence (
        task_id TEXT NOT NULL, cohort TEXT NOT NULL, input_hash TEXT NOT NULL, active INTEGER NOT NULL,
        detail TEXT NOT NULL, PRIMARY KEY(task_id,cohort));
      CREATE TABLE IF NOT EXISTS response_review_decisions (
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, reviewer_kind TEXT NOT NULL,
        note TEXT NOT NULL, decided_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS response_review_versions (
        cohort TEXT NOT NULL, episode_id TEXT NOT NULL, input_hash TEXT NOT NULL, policy TEXT NOT NULL,
        PRIMARY KEY(cohort,episode_id));
      CREATE TABLE IF NOT EXISTS response_annotations (
        id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL);`);
    }
    sync(cohort, episodeId, inputHash, result, now) {
        this.db.prepare(`UPDATE response_review_evidence SET active=-1 WHERE cohort=? AND task_id IN
      (SELECT id FROM response_review_tasks WHERE episode_id=?)`).run(cohort, episodeId);
        const outcome = responseOutcome(result);
        const f = result.feedback, intensity = f.dissatisfactionIntensity;
        // Use probability of the relevant *group*, not the expected score or certainty
        // of one fine-grained target. Ambiguity among agent-related targets is harmless.
        const agentDirected = ["current_answer", "earlier_behavior", "delivery", "proactive_action", "mixed"];
        const agentProbability = agentDirected.reduce((sum, key) => sum + f.target.probabilities[key], 0);
        const signals = [
            ...(outcome.status === "reported_shortfall" ? [{ family: "delivery_quality", detail: outcome }] : []),
            ...(intensity && intensity.probabilities["2"] + intensity.probabilities["3"] >= 0.8 && agentProbability >= 0.8 &&
                ((f.annoyance?.noul ?? 0) >= 0.8 || (f.frustration?.noul ?? 0) >= 0.8) ?
                [{ family: "human_experience", detail: { target: f.target, sentiment: f.sentiment, annoyance: f.annoyance,
                            frustration: f.frustration, intensity } }] : []),
        ];
        for (const s of signals) {
            const humanKey = result.human?.key ?? "unknown";
            const id = createHash("sha256").update(JSON.stringify([episodeId, s.family, humanKey])).digest("hex");
            this.db.prepare(`INSERT INTO response_review_tasks(id,episode_id,family,human_key,created_at,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`).run(id, episodeId, s.family, humanKey, now, now);
            this.db.prepare(`INSERT INTO response_review_evidence VALUES(?,?,?,1,?) ON CONFLICT(task_id,cohort)
        DO UPDATE SET input_hash=excluded.input_hash,active=1,detail=excluded.detail`)
                .run(id, cohort, inputHash, JSON.stringify({ policy: RESPONSE_REVIEW_POLICY, signals: s.detail, human: result.human ?? null, references: result.references }));
        }
        this.db.prepare(`INSERT INTO response_review_versions VALUES(?,?,?,?) ON CONFLICT(cohort,episode_id)
      DO UPDATE SET input_hash=excluded.input_hash,policy=excluded.policy`).run(cohort, episodeId, inputHash, RESPONSE_REVIEW_POLICY);
    }
    refresh(cohort, since) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const rows = this.db.prepare(`SELECT r.id,r.input_hash,r.result FROM response_results r
        LEFT JOIN response_review_versions v ON v.cohort=r.cohort AND v.episode_id=r.id
        WHERE r.cohort=? AND r.active=1 AND r.status='ok' AND r.episode_at>=?
        AND (v.policy IS NULL OR v.policy!=? OR v.input_hash!=r.input_hash) ORDER BY r.id LIMIT 1000`)
                .all(cohort, since, RESPONSE_REVIEW_POLICY);
            for (const row of rows)
                this.sync(cohort, String(row.id), String(row.input_hash), JSON.parse(String(row.result)), Date.now());
            this.db.exec("COMMIT");
            return rows.length;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    reconcile(cohort) {
        this.db.prepare(`UPDATE response_review_evidence AS e SET active=CASE WHEN EXISTS (
      SELECT 1 FROM response_review_tasks t JOIN response_results r ON r.id=t.episode_id
      WHERE t.id=e.task_id AND r.cohort=e.cohort AND r.input_hash=e.input_hash AND r.active=1 AND r.status='ok')
      THEN 1 ELSE 0 END WHERE cohort=? AND active>=0`).run(cohort);
    }
    list(cohort, id) {
        return this.db.prepare(`SELECT t.*,e.input_hash,e.active,e.detail FROM response_review_tasks t
      JOIN response_review_evidence e ON e.task_id=t.id WHERE e.cohort=? ${id ? "AND t.id=?" : ""}
      ORDER BY t.updated_at DESC,t.id LIMIT 1001`).all(cohort, ...(id ? [id] : [])).map(row => ({
            id: String(row.id), episodeId: String(row.episode_id), family: String(row.family), status: String(row.status),
            evidenceStatus: row.active === 1 ? "current" : row.active === -1 ? "superseded" : "stale", reviewerKind: row.reviewer_kind,
            resolutionNote: row.resolution_note, createdAt: row.created_at, updatedAt: row.updated_at,
            evidence: JSON.parse(String(row.detail)),
        }));
    }
    decide(cohort, id, status, reviewer, note, now = Date.now()) {
        if (!["pending", "resolved", "dismissed", "deferred"].includes(status) || !["human", "agent"].includes(reviewer) ||
            !note.trim() || note.length > 4000)
            throw new Error("Invalid response review decision");
        if (!this.list(cohort, id).length)
            throw new Error("Unknown response review task in current cohort");
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare("UPDATE response_review_tasks SET status=?,reviewer_kind=?,resolution_note=?,updated_at=? WHERE id=?")
                .run(status, reviewer, note.trim(), now, id);
            this.db.prepare("INSERT INTO response_review_decisions(task_id,status,reviewer_kind,note,decided_at) VALUES(?,?,?,?,?)")
                .run(id, status, reviewer, note.trim(), now);
            this.db.exec("COMMIT");
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    annotate(occurredAt, kind, note) {
        if (!Number.isFinite(occurredAt) || !["model", "prompt", "deployment", "other"].includes(kind) || !note.trim() || note.length > 4000)
            throw new Error("Invalid response annotation");
        const id = randomUUID();
        this.db.prepare("INSERT INTO response_annotations VALUES(?,?,?,?)").run(id, occurredAt, kind, note.trim());
        return id;
    }
    annotations(since, until) {
        return this.db.prepare("SELECT * FROM response_annotations WHERE occurred_at>=? AND occurred_at<? ORDER BY occurred_at,id").all(since, until);
    }
}
