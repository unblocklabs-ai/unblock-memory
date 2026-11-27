import { createHash, randomUUID } from "node:crypto";
import { immediateTransaction, openMemoryDatabase } from "./memory-database.js";
// Loaded by plain-Node workers and offline tools (Voltaire Drift, whisper prefetch): keep this module free of `openclaw`.
/**
 * Durable `deep_thought` state:
 *
 * - `deep_thought_jobs`: async/sync investigation records, so a `jobId` handed to the caller is still collectible
 *   after a Gateway restart. Caller isolation is the exact `owner_key`; a restart turns orphaned `running` rows into
 *   `cancelled` ones instead of leaving them hanging.
 * - `derived_observations`: completed, citation-verified syntheses keyed by `(agent_id, question_hash, audience_key,
 *   corpora_json)` and stamped with the exact QMD `collection_generations` they were synthesized against. A lookup only
 *   hits when every recorded collection is still at the same generation; any advance flips the row to `stale`.
 *   At most one row per key is `fresh` (partial unique index); a newer save supersedes the previous fresh row.
 */
const COMPONENT = "deep_thought";
const SCHEMA_VERSION = 1;
/** Default collectible window for finished jobs (`0` = keep until explicitly deleted). */
export const DEFAULT_DEEP_THOUGHT_JOB_RETENTION_MS = 1_800_000;
const SCHEMA = `CREATE TABLE IF NOT EXISTS deep_thought_jobs (
  job_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  question TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  corpora_json TEXT NOT NULL CHECK(json_valid(corpora_json)),
  status TEXT NOT NULL,
  tool_calls_used INTEGER NOT NULL,
  last_tool TEXT,
  outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  expires_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS deep_thought_jobs_agent_status ON deep_thought_jobs(agent_id, status);
CREATE INDEX IF NOT EXISTS deep_thought_jobs_expiry ON deep_thought_jobs(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS derived_observations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  question TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  audience_key TEXT NOT NULL,
  corpora_json TEXT NOT NULL CHECK(json_valid(corpora_json)),
  collection_generations_json TEXT NOT NULL CHECK(json_valid(collection_generations_json)),
  answer TEXT NOT NULL,
  confidence TEXT NOT NULL,
  citations_json TEXT NOT NULL CHECK(json_valid(citations_json)),
  open_questions_json TEXT NOT NULL CHECK(json_valid(open_questions_json)),
  source_job_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('fresh','stale','superseded')),
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_hit_at INTEGER,
  invalidated_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS derived_observations_one_fresh
  ON derived_observations(agent_id, question_hash, audience_key, corpora_json) WHERE status='fresh';
CREATE INDEX IF NOT EXISTS derived_observations_agent_status ON derived_observations(agent_id, status, created_at);`;
/* ───────────────────────────── Canonical forms ───────────────────────────── */
/** Lowercase, NFKC, collapsed whitespace, leading/trailing punctuation trimmed. */
export function normalizeDeepThoughtQuestion(question) {
    return question.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ")
        .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
}
/** Stable fingerprint of the normalized question (and focus, when given: a different focus is a different investigation). */
export function deepThoughtQuestionHash(question, focus) {
    const normalizedFocus = focus === undefined ? "" : normalizeDeepThoughtQuestion(focus);
    const key = normalizedFocus ? `${normalizeDeepThoughtQuestion(question)}\0focus:${normalizedFocus}` : normalizeDeepThoughtQuestion(question);
    return createHash("sha256").update(key).digest("hex");
}
/** Sorted, de-duplicated, trimmed corpus names. */
export function canonicalCorpora(corpora) {
    return [...new Set(corpora.map(name => name.trim()).filter(Boolean))].sort();
}
function canonicalGenerations(generations) {
    const out = {};
    for (const key of Object.keys(generations).sort()) {
        const value = generations[key];
        if (!Number.isSafeInteger(value) || value < 0)
            throw new Error(`DeepThoughtStore generation for ${key} must be a non-negative integer`);
        out[key] = value;
    }
    return out;
}
/** True only when both snapshots record exactly the same collections at exactly the same generations. */
function generationsMatch(recorded, current) {
    const recordedKeys = Object.keys(recorded);
    if (!recordedKeys.length)
        return false;
    // A collection that appeared since synthesis is content the answer never saw: also not a match.
    if (Object.keys(current).length !== recordedKeys.length)
        return false;
    return recordedKeys.every(key => Object.hasOwn(current, key) && current[key] === recorded[key]);
}
function optionalNumber(value) { return value === null || value === undefined ? undefined : Number(value); }
function optionalText(value) { return value === null || value === undefined ? undefined : String(value); }
function jobRecord(row) {
    const outcome = optionalText(row.outcome_json);
    return {
        jobId: String(row.job_id), agentId: String(row.agent_id), ownerKey: String(row.owner_key), question: String(row.question),
        questionHash: String(row.question_hash), corpora: JSON.parse(String(row.corpora_json)), status: String(row.status),
        toolCallsUsed: Number(row.tool_calls_used),
        ...(optionalText(row.last_tool) !== undefined ? { lastTool: String(row.last_tool) } : {}),
        ...(outcome !== undefined ? { outcome: JSON.parse(outcome) } : {}),
        startedAt: Number(row.started_at), updatedAt: Number(row.updated_at),
        ...(optionalNumber(row.completed_at) !== undefined ? { completedAt: Number(row.completed_at) } : {}),
        ...(optionalNumber(row.expires_at) !== undefined ? { expiresAt: Number(row.expires_at) } : {}),
    };
}
function observation(row) {
    return {
        id: String(row.id), agentId: String(row.agent_id), question: String(row.question), questionHash: String(row.question_hash),
        audienceKey: String(row.audience_key), corpora: JSON.parse(String(row.corpora_json)),
        collectionGenerations: JSON.parse(String(row.collection_generations_json)),
        answer: String(row.answer), confidence: String(row.confidence),
        citations: JSON.parse(String(row.citations_json)),
        openQuestions: JSON.parse(String(row.open_questions_json)),
        ...(optionalText(row.source_job_id) !== undefined ? { sourceJobId: String(row.source_job_id) } : {}),
        status: String(row.status), hitCount: Number(row.hit_count), createdAt: Number(row.created_at),
        ...(optionalNumber(row.last_hit_at) !== undefined ? { lastHitAt: Number(row.last_hit_at) } : {}),
        ...(optionalNumber(row.invalidated_at) !== undefined ? { invalidatedAt: Number(row.invalidated_at) } : {}),
    };
}
/** Identity keys must round-trip exactly: SQLite TEXT returned through node:sqlite truncates at NUL. */
function requireText(value, field) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`DeepThoughtStore ${field} is required`);
    if (value.includes("\0"))
        throw new Error(`DeepThoughtStore ${field} must not contain NUL characters`);
}
function ensureSchema(db) {
    const read = () => db.prepare("SELECT version FROM memory_schema WHERE component=?").get(COMPONENT)?.version;
    const ready = (version) => {
        if (version !== undefined && version !== SCHEMA_VERSION)
            throw new Error("Unsupported deep_thought store schema version");
        return version === SCHEMA_VERSION &&
            Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='deep_thought_jobs'").get()) &&
            Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='derived_observations'").get());
    };
    // Fast path avoids taking the write lock on every open.
    if (ready(read()))
        return;
    immediateTransaction(db, () => {
        if (ready(read()))
            return;
        db.exec(SCHEMA);
        db.prepare("INSERT OR IGNORE INTO memory_schema VALUES (?,?)").run(COMPONENT, SCHEMA_VERSION);
    });
}
/* ───────────────────────────── Store ───────────────────────────── */
export class DeepThoughtStore {
    db;
    #owned;
    /** Pass a path to open a dedicated connection, or an already-open `DatabaseSync` to share one. */
    constructor(database, options = {}) {
        this.#owned = typeof database === "string";
        this.db = typeof database === "string"
            ? openMemoryDatabase(database, options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs })
            : database;
        try {
            ensureSchema(this.db);
        }
        catch (error) {
            if (this.#owned)
                this.db.close();
            throw error;
        }
    }
    close() { if (this.#owned)
        this.db.close(); }
    /* ─────────── Jobs ─────────── */
    /** Insert a job, or update its progress/outcome. Identity columns (agent, owner, question) never change after insert. */
    upsertJob(input) {
        requireText(input.jobId, "jobId");
        requireText(input.agentId, "agentId");
        requireText(input.ownerKey, "ownerKey");
        const now = input.nowMs ?? Date.now();
        this.db.prepare(`INSERT INTO deep_thought_jobs
        (job_id,agent_id,owner_key,question,question_hash,corpora_json,status,tool_calls_used,last_tool,outcome_json,
         started_at,updated_at,completed_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET
        status=excluded.status, tool_calls_used=excluded.tool_calls_used, last_tool=excluded.last_tool,
        outcome_json=COALESCE(excluded.outcome_json, deep_thought_jobs.outcome_json), updated_at=excluded.updated_at,
        completed_at=excluded.completed_at, expires_at=excluded.expires_at
      WHERE deep_thought_jobs.agent_id=excluded.agent_id AND deep_thought_jobs.owner_key=excluded.owner_key`)
            .run(input.jobId, input.agentId, input.ownerKey, input.question, deepThoughtQuestionHash(input.question, input.focus), JSON.stringify(canonicalCorpora(input.corpora)), input.status, Math.max(0, Math.trunc(input.toolCallsUsed)), input.lastTool ?? null, input.outcome === undefined ? null : JSON.stringify(input.outcome), input.startedAt, now, input.completedAt ?? null, input.expiresAt ?? null);
        const stored = this.getJob(input.jobId);
        if (!stored || stored.ownerKey !== input.ownerKey || stored.agentId !== input.agentId) {
            throw new Error(`DeepThoughtStore job ${input.jobId} belongs to another caller`);
        }
        return stored;
    }
    getJob(jobId) {
        const row = this.db.prepare("SELECT * FROM deep_thought_jobs WHERE job_id=?").get(jobId);
        return row ? jobRecord(row) : undefined;
    }
    deleteJob(jobId) {
        return Number(this.db.prepare("DELETE FROM deep_thought_jobs WHERE job_id=?").run(jobId).changes) > 0;
    }
    /**
     * Restart recovery: every `running` row for `agentId` (except live `keepJobIds` still owned by this process) becomes
     * `cancelled` with a self-explaining outcome, so polling its `jobId` answers instead of hanging forever.
     * `retentionMs` (`0` = unlimited) sets how long the cancelled record stays collectible.
     */
    markInterruptedJobs(agentId, nowMs, options = {}) {
        const keep = new Set(options.keepJobIds ?? []);
        const retentionMs = options.retentionMs ?? DEFAULT_DEEP_THOUGHT_JOB_RETENTION_MS;
        const expiresAt = retentionMs > 0 ? nowMs + retentionMs : null;
        return immediateTransaction(this.db, () => {
            const rows = this.db.prepare("SELECT * FROM deep_thought_jobs WHERE agent_id=? AND status='running'").all(agentId).map(jobRecord);
            let changed = 0;
            for (const job of rows) {
                if (keep.has(job.jobId))
                    continue;
                const outcome = {
                    status: "cancelled", jobId: job.jobId, citations: [], openQuestions: [], hopsUsed: 0, toolCallsUsed: job.toolCallsUsed,
                    elapsedMs: Math.max(0, nowMs - job.startedAt), ...(job.lastTool ? { lastTool: job.lastTool } : {}), corpora: job.corpora,
                    error: "interrupted by gateway restart",
                    note: "This investigation was interrupted when the Gateway restarted before it finished. Ask deep_thought the question again to re-run it.",
                };
                changed += Number(this.db.prepare(`UPDATE deep_thought_jobs SET status='cancelled', outcome_json=?, updated_at=?,
            completed_at=?, expires_at=? WHERE job_id=? AND status='running'`)
                    .run(JSON.stringify(outcome), nowMs, nowMs, expiresAt, job.jobId).changes);
            }
            return changed;
        });
    }
    /** Delete finished jobs past their `expires_at`; rows with `expires_at IS NULL` (retention `0`) are kept. */
    pruneExpiredJobs(nowMs) {
        return Number(this.db.prepare("DELETE FROM deep_thought_jobs WHERE expires_at IS NOT NULL AND expires_at<=?").run(nowMs).changes);
    }
    /* ─────────── Derived observations ─────────── */
    /** Persist a verified synthesis; any previous `fresh` row for the same key becomes `superseded` atomically. */
    saveDerivedObservation(input) {
        requireText(input.agentId, "agentId");
        requireText(input.audienceKey, "audienceKey");
        if (!input.answer.trim())
            throw new Error("DeepThoughtStore answer is required");
        const generations = canonicalGenerations(input.collectionGenerations);
        if (!Object.keys(generations).length) {
            throw new Error("DeepThoughtStore derived observations must record at least one collection generation");
        }
        const now = input.nowMs ?? Date.now();
        const id = input.id ?? `obs_${randomUUID()}`;
        const questionHash = deepThoughtQuestionHash(input.question, input.focus);
        const corpora = JSON.stringify(canonicalCorpora(input.corpora));
        return immediateTransaction(this.db, () => {
            this.db.prepare(`UPDATE derived_observations SET status='superseded', invalidated_at=?
        WHERE agent_id=? AND question_hash=? AND audience_key=? AND corpora_json=? AND status='fresh'`)
                .run(now, input.agentId, questionHash, input.audienceKey, corpora);
            this.db.prepare(`INSERT INTO derived_observations
          (id,agent_id,question,question_hash,audience_key,corpora_json,collection_generations_json,answer,confidence,
           citations_json,open_questions_json,source_job_id,status,hit_count,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'fresh',0,?)`)
                .run(id, input.agentId, input.question, questionHash, input.audienceKey, corpora, JSON.stringify(generations), input.answer, input.confidence, JSON.stringify(input.citations), JSON.stringify(input.openQuestions ?? []), input.sourceJobId ?? null, now);
            return observation(this.db.prepare("SELECT * FROM derived_observations WHERE id=?").get(id));
        });
    }
    /**
     * Exact-key lookup of the `fresh` observation. Hits (and counts the hit) only when `currentGenerations` records exactly
     * the same collections at exactly the same generations; otherwise the row is marked `stale` and `undefined` is returned.
     * An empty `currentGenerations` cannot verify anything: it misses without invalidating.
     */
    findFreshDerivedObservation(input) {
        if (!Object.keys(input.currentGenerations).length)
            return undefined;
        const now = input.nowMs ?? Date.now();
        const questionHash = deepThoughtQuestionHash(input.question, input.focus);
        const corpora = JSON.stringify(canonicalCorpora(input.corpora));
        return immediateTransaction(this.db, () => {
            const row = this.db.prepare(`SELECT * FROM derived_observations
        WHERE agent_id=? AND question_hash=? AND audience_key=? AND corpora_json=? AND status='fresh'
        ORDER BY created_at DESC LIMIT 1`).get(input.agentId, questionHash, input.audienceKey, corpora);
            if (!row)
                return undefined;
            const found = observation(row);
            if (!generationsMatch(found.collectionGenerations, input.currentGenerations)) {
                this.db.prepare("UPDATE derived_observations SET status='stale', invalidated_at=? WHERE id=? AND status='fresh'").run(now, found.id);
                return undefined;
            }
            this.db.prepare("UPDATE derived_observations SET hit_count=hit_count+1, last_hit_at=? WHERE id=?").run(now, found.id);
            return { ...found, hitCount: found.hitCount + 1, lastHitAt: now };
        });
    }
    getDerivedObservation(id) {
        const row = this.db.prepare("SELECT * FROM derived_observations WHERE id=?").get(id);
        return row ? observation(row) : undefined;
    }
    /** Newest first. `limit` `0` (default) = unlimited. */
    listDerivedObservations(options) {
        const limit = options.limit ?? 0;
        if (!Number.isSafeInteger(limit) || limit < 0)
            throw new Error("DeepThoughtStore limit must be a non-negative integer (0 = unlimited)");
        const status = options.status ?? null, audience = options.audienceKey ?? null;
        return this.db.prepare(`SELECT * FROM derived_observations
      WHERE agent_id=? AND (? IS NULL OR status=?) AND (? IS NULL OR audience_key=?)
      ORDER BY created_at DESC, id LIMIT ?`)
            .all(options.agentId, status, status, audience, audience, limit > 0 ? limit : -1).map(observation);
    }
}
