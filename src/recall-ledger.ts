import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { DEFAULTS } from "./defaults.js";
import { immediateTransaction, openMemoryDatabase, tableExists } from "./memory-database.js";

// Loaded by the background writer worker with plain Node resolution:
// this module and its imports must stay free of `openclaw`.

export const RECALL_LEDGER_SCHEMA_VERSION = 2;
const MAX_RETENTION_DAYS = 3650;

export type RecallLedgerConfig = {
  enabled: boolean;
  retentionDays: number;
};

type RecallSource = "whisperer" | "tool" | "drift_rerun";
type RecallRankingMode = "decision" | "retrieval";
type RecallFallbackReason = "key_unavailable" | "all_judgments_failed";
export type RecallQueryOutcome =
  | "emitted"
  | "rejected"
  | "empty"
  | "tool_ok"
  | "degraded"
  | "partial"
  | "missing_key"
  | "unavailable"
  | "timed_out"
  | "cancelled"
  | "skipped"
  | "failed";

export type RecallHitDisposition =
  | "emitted"
  | "returned"
  | "rank_limit"
  | "below_threshold"
  | "judge_failed"
  | "unjudged_cap"
  | "cooldown"
  | "redundant"
  | "payload_limit";

type ObservedAtBasis = "extracted" | "session_message" | "filename_date" | "unknown";

export type RecallHitLocator = {
  rawLeafId: string;
  docHash?: string;
  qmdSeq?: number;
  chunkPos?: number;
  chunkLen?: number;
  observedAtMs?: number;
  observedAtBasis: ObservedAtBasis;
};

export type RecallHitRecord = {
  rawLeafId: string;
  passageId: string;
  docHash?: string;
  qmdSeq?: number;
  chunkPos?: number;
  chunkLen?: number;
  corpus: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  targetSessionId?: string;
  extractedId?: string;
  extractedRevision?: number;
  observedAtMs?: number;
  observedAtBasis: ObservedAtBasis;
  retrievalRank: number;
  retrievalScore?: number;
  usefulnessScore?: number;
  disposition: RecallHitDisposition;
  finalRank?: number;
};

export type RecallQueryRecord = {
  eventKey: string;
  createdAtMs: number;
  agentId: string;
  source: RecallSource;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  provider?: string;
  accountId?: string;
  senderId?: string;
  channelId?: string;
  threadId?: string;
  chatType?: string;
  lexQuery?: string;
  vecQuery?: string;
  queryFallback: boolean;
  corpora: readonly string[];
  sessionFilterJson?: string;
  rankingMode: RecallRankingMode;
  fallbackReason?: RecallFallbackReason;
  decisionModel?: string;
  minUsefulness?: number;
  outcome: RecallQueryOutcome;
  parentQueryId?: number;
  inputTokens?: number;
  outputTokens?: number;
  hits: readonly RecallHitRecord[];
};

type RecallReadRecord = {
  eventKey: string;
  readAtMs: number;
  agentId: string;
  sessionId?: string;
  runId?: string;
  sourcePath: string;
  startLine?: number;
  lineCount?: number;
  status: "ok" | "not_found" | "unavailable";
};

type SkillEventContext = {
  createdAtMs: number;
  agentId: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
};

export type SkillRoutingRecord = SkillEventContext & {
  eventKey: string;
  surface?: string;
  catalogRevision?: string;
  mode: "direct" | "search" | "fallback";
  candidateCount: number;
  emitted: readonly string[];
  scores: readonly { path: string; name: string; score: number }[];
  inputTokens?: number;
  outputTokens?: number;
  elapsedMs?: number;
  outcome: string;
};

export type SkillOpenRecord = SkillEventContext & {
  skillPath: string;
  toolName: "read" | "skills_read";
  wasWhispered: boolean;
  wasPinned: boolean;
};

export type RecallLedgerEvent =
  | { kind: "query"; record: RecallQueryRecord }
  | { kind: "read"; record: RecallReadRecord }
  | { kind: "skill_routing"; record: SkillRoutingRecord }
  | { kind: "skill_open"; record: SkillOpenRecord };

export type RecallPersonIdentity = {
  provider: string;
  senderId: string;
  accountId?: string;
};

/** Parses YYYY-MM-DD.md filenames (both `2026-11-20.md` under a rooted `memory/` source and `memory/2026-11-20.md`). */
export function parseDailyFilenameDateMs(path: string): number | undefined {
  const match = /(?:^|\/)(\d{4})-(\d{2})-(\d{2})\.md$/u.exec(path);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return undefined;
  }
  return ms;
}

export function resolveRecallLedger(value: unknown): RecallLedgerConfig {
  const defaultRetentionDays = DEFAULTS.recallLedger.defaultRetentionDays;
  if (value === undefined) return { enabled: false, retentionDays: defaultRetentionDays };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unblock-memory recallLedger must be an object");
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (key !== "enabled" && key !== "retentionDays") {
      throw new Error(`unknown recallLedger key: ${key}`);
    }
  }
  const enabled = config.enabled === undefined ? false : config.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("unblock-memory recallLedger.enabled must be a boolean");
  }
  const retentionDays = config.retentionDays === undefined ? defaultRetentionDays : config.retentionDays;
  if (
    typeof retentionDays !== "number" ||
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > MAX_RETENTION_DAYS
  ) {
    throw new Error(`unblock-memory recallLedger.retentionDays must be an integer between 1 and ${MAX_RETENTION_DAYS}`);
  }
  return { enabled, retentionDays };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS recall_queries (
  id                  INTEGER PRIMARY KEY,
  event_key           TEXT NOT NULL UNIQUE,
  created_at_ms       INTEGER NOT NULL,
  agent_id            TEXT NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('whisperer', 'tool', 'drift_rerun')),
  session_id          TEXT,
  session_key         TEXT,
  run_id              TEXT,
  provider            TEXT,
  account_id          TEXT,
  sender_id           TEXT,
  channel_id          TEXT,
  thread_id           TEXT,
  chat_type           TEXT,
  lex_query           TEXT,
  vec_query           TEXT,
  query_fallback      INTEGER NOT NULL DEFAULT 0 CHECK (query_fallback IN (0, 1)),
  corpora_json        TEXT NOT NULL,
  session_filter_json TEXT,
  ranking_mode        TEXT NOT NULL CHECK (ranking_mode IN ('decision', 'retrieval')),
  fallback_reason     TEXT CHECK (fallback_reason IS NULL OR fallback_reason IN ('key_unavailable', 'all_judgments_failed')),
  decision_model      TEXT,
  min_usefulness      REAL,
  outcome             TEXT NOT NULL CHECK (outcome IN (
    'emitted', 'rejected', 'empty', 'tool_ok', 'degraded', 'partial',
    'missing_key', 'unavailable', 'timed_out', 'cancelled', 'skipped', 'failed'
  )),
  parent_query_id     INTEGER REFERENCES recall_queries(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE IF NOT EXISTS recall_hits (
  id                  INTEGER PRIMARY KEY,
  query_id            INTEGER NOT NULL REFERENCES recall_queries(id) ON DELETE CASCADE,
  hit_at_ms           INTEGER NOT NULL,
  raw_leaf_id         TEXT NOT NULL,
  passage_id          TEXT NOT NULL,
  doc_hash            TEXT,
  qmd_seq             INTEGER,
  chunk_pos           INTEGER,
  chunk_len           INTEGER,
  corpus              TEXT NOT NULL,
  source_path         TEXT NOT NULL,
  start_line          INTEGER NOT NULL,
  end_line            INTEGER NOT NULL,
  target_session_id   TEXT,
  extracted_id        TEXT,
  extracted_revision  INTEGER,
  observed_at_ms      INTEGER,
  observed_at_basis   TEXT NOT NULL DEFAULT 'unknown' CHECK (
    observed_at_basis IN ('extracted', 'session_message', 'filename_date', 'unknown')
  ),
  retrieval_rank      INTEGER NOT NULL CHECK (retrieval_rank >= 1),
  retrieval_score     REAL,
  usefulness_score    REAL CHECK (usefulness_score IS NULL OR (usefulness_score >= 0.0 AND usefulness_score <= 1.0)),
  disposition         TEXT NOT NULL CHECK (disposition IN (
    'emitted', 'returned', 'rank_limit', 'below_threshold', 'judge_failed',
    'unjudged_cap', 'cooldown', 'redundant', 'payload_limit'
  )),
  final_rank          INTEGER CHECK (final_rank IS NULL OR final_rank >= 1),
  UNIQUE (query_id, retrieval_rank)
) STRICT;

CREATE TABLE IF NOT EXISTS recall_reads (
  id                  INTEGER PRIMARY KEY,
  event_key           TEXT NOT NULL UNIQUE,
  read_at_ms          INTEGER NOT NULL,
  agent_id            TEXT NOT NULL,
  session_id          TEXT,
  run_id              TEXT,
  source_path         TEXT NOT NULL,
  start_line          INTEGER,
  line_count          INTEGER,
  status              TEXT NOT NULL CHECK (status IN ('ok', 'not_found', 'unavailable'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_recall_queries_time ON recall_queries (created_at_ms);
CREATE INDEX IF NOT EXISTS idx_recall_queries_agent_time ON recall_queries (agent_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_recall_queries_origin ON recall_queries (agent_id, provider, account_id, sender_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_recall_queries_parent ON recall_queries (parent_query_id) WHERE parent_query_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recall_hits_leaf_time ON recall_hits (raw_leaf_id, hit_at_ms);
CREATE INDEX IF NOT EXISTS idx_recall_hits_doc_time ON recall_hits (doc_hash, hit_at_ms) WHERE doc_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recall_hits_session_time ON recall_hits (target_session_id, hit_at_ms) WHERE target_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recall_hits_disp_time ON recall_hits (disposition, hit_at_ms);
CREATE INDEX IF NOT EXISTS idx_recall_reads_time ON recall_reads (read_at_ms);
CREATE INDEX IF NOT EXISTS idx_recall_reads_path_time ON recall_reads (source_path, read_at_ms);

CREATE TABLE IF NOT EXISTS skill_routing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  session_key TEXT,
  run_id TEXT,
  surface TEXT,
  catalog_revision TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('direct','search','fallback')),
  candidate_count INTEGER NOT NULL,
  emitted_json TEXT NOT NULL CHECK(json_valid(emitted_json)),
  scores_json TEXT NOT NULL CHECK(json_valid(scores_json)),
  input_tokens INTEGER,
  output_tokens INTEGER,
  elapsed_ms REAL,
  outcome TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_skill_routing_agent_time ON skill_routing_events (agent_id, created_at_ms);

CREATE TABLE IF NOT EXISTS skill_open_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  session_key TEXT,
  run_id TEXT,
  skill_path TEXT NOT NULL,
  tool_name TEXT NOT NULL CHECK(tool_name IN ('read','skills_read')),
  was_whispered INTEGER NOT NULL CHECK(was_whispered IN (0,1)),
  was_pinned INTEGER NOT NULL CHECK(was_pinned IN (0,1))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_skill_open_agent_time ON skill_open_events (agent_id, created_at_ms);
`;

function ensureRecallLedgerSchema(db: DatabaseSync): void {
  const version = db.prepare("SELECT version FROM memory_schema WHERE component = 'recall_ledger'");
  if (version.get()?.version === RECALL_LEDGER_SCHEMA_VERSION) return;
  immediateTransaction(db, () => {
    const current = version.get()?.version;
    if (current === RECALL_LEDGER_SCHEMA_VERSION) return;
    if (current !== undefined && current !== 1) {
      throw new Error(`Unsupported recall_ledger schema version: ${String(current)}`);
    }
    db.exec(SCHEMA_SQL);
    const columns = db.prepare("PRAGMA table_info(recall_queries)").all();
    for (const column of ["input_tokens", "output_tokens"]) {
      if (!columns.some(row => row.name === column)) db.exec(`ALTER TABLE recall_queries ADD COLUMN ${column} INTEGER`);
    }
    db.prepare(`INSERT INTO memory_schema (component, version) VALUES ('recall_ledger', ?)
      ON CONFLICT(component) DO UPDATE SET version = excluded.version`).run(RECALL_LEDGER_SCHEMA_VERSION);
  });
}

export function openRecallLedger(path: string): DatabaseSync {
  const db = openMemoryDatabase(path);
  try {
    ensureRecallLedgerSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function truncIntOrNull(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return Number.isSafeInteger(truncated) ? truncated : null;
}

function positiveIntOrNull(value: number | undefined): number | null {
  const truncated = truncIntOrNull(value);
  return truncated !== null && truncated >= 1 ? truncated : null;
}

function requiredInt(value: number, fallback: number): number {
  const truncated = truncIntOrNull(value);
  return truncated !== null ? truncated : fallback;
}

function clampUnitOrNull(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function writeRecallBatchIntoDb(
  db: DatabaseSync,
  events: readonly RecallLedgerEvent[],
  options: { retentionDays?: number; nowMs?: number; prune?: boolean } = {},
): { written: number; pruned: number } {
  const insertQuery = db.prepare(`
    INSERT INTO recall_queries (
      event_key, created_at_ms, agent_id, source,
      session_id, session_key, run_id,
      provider, account_id, sender_id, channel_id, thread_id, chat_type,
      lex_query, vec_query, query_fallback,
      corpora_json, session_filter_json, ranking_mode, fallback_reason, decision_model, min_usefulness,
      outcome, parent_query_id, input_tokens, output_tokens
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT(event_key) DO NOTHING
  `);
  const insertHit = db.prepare(`
    INSERT INTO recall_hits (
      query_id, hit_at_ms,
      raw_leaf_id, passage_id, doc_hash, qmd_seq, chunk_pos, chunk_len,
      corpus, source_path, start_line, end_line,
      target_session_id, extracted_id, extracted_revision,
      observed_at_ms, observed_at_basis,
      retrieval_rank, retrieval_score, usefulness_score, disposition, final_rank
    ) VALUES (
      ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?
    )
  `);
  const insertRead = db.prepare(`
    INSERT INTO recall_reads (
      event_key, read_at_ms, agent_id, session_id, run_id,
      source_path, start_line, line_count, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO NOTHING
  `);

  const insertRouting = db.prepare(`INSERT INTO skill_routing_events (
    event_key, created_at_ms, agent_id, session_id, session_key, run_id, surface, catalog_revision,
    mode, candidate_count, emitted_json, scores_json, input_tokens, output_tokens, elapsed_ms, outcome
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING`);
  const insertOpen = db.prepare(`INSERT INTO skill_open_events (
    created_at_ms, agent_id, session_id, session_key, run_id, skill_path, tool_name, was_whispered, was_pinned
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let written = 0;
  let pruned = 0;
  const fallbackNow = Math.trunc(options.nowMs ?? Date.now());
  immediateTransaction(db, () => {
    for (const event of events) {
      if (event.kind === "query") {
        const r = event.record;
        const createdAtMs = requiredInt(r.createdAtMs, fallbackNow);
        const result = insertQuery.run(
          r.eventKey,
          createdAtMs,
          r.agentId,
          r.source,
          r.sessionId ?? null,
          r.sessionKey ?? null,
          r.runId ?? null,
          r.provider ?? null,
          r.accountId ?? null,
          r.senderId ?? null,
          r.channelId ?? null,
          r.threadId ?? null,
          r.chatType ?? null,
          r.lexQuery ?? null,
          r.vecQuery ?? null,
          r.queryFallback ? 1 : 0,
          JSON.stringify(r.corpora),
          r.sessionFilterJson ?? null,
          r.rankingMode,
          r.fallbackReason ?? null,
          r.decisionModel ?? null,
          finiteOrNull(r.minUsefulness),
          r.outcome,
          positiveIntOrNull(r.parentQueryId),
          truncIntOrNull(r.inputTokens),
          truncIntOrNull(r.outputTokens),
        );
        if (Number(result.changes) > 0) {
          written++;
          const queryId = Number(result.lastInsertRowid);
          for (const hit of r.hits) {
            const observedAtMs = truncIntOrNull(hit.observedAtMs);
            const observedAtBasis: ObservedAtBasis = observedAtMs === null ? "unknown" : hit.observedAtBasis;
            insertHit.run(
              queryId,
              createdAtMs,
              hit.rawLeafId,
              hit.passageId,
              hit.docHash ?? null,
              truncIntOrNull(hit.qmdSeq),
              truncIntOrNull(hit.chunkPos),
              truncIntOrNull(hit.chunkLen),
              hit.corpus,
              hit.sourcePath,
              requiredInt(hit.startLine, 1),
              requiredInt(hit.endLine, 1),
              hit.targetSessionId ?? null,
              hit.extractedId ?? null,
              truncIntOrNull(hit.extractedRevision),
              observedAtMs,
              observedAtBasis,
              Math.max(1, requiredInt(hit.retrievalRank, 1)),
              finiteOrNull(hit.retrievalScore),
              clampUnitOrNull(hit.usefulnessScore),
              hit.disposition,
              positiveIntOrNull(hit.finalRank),
            );
          }
        }
      } else if (event.kind === "read") {
        const r = event.record;
        const result = insertRead.run(
          r.eventKey,
          requiredInt(r.readAtMs, fallbackNow),
          r.agentId,
          r.sessionId ?? null,
          r.runId ?? null,
          r.sourcePath,
          truncIntOrNull(r.startLine),
          truncIntOrNull(r.lineCount),
          r.status,
        );
        if (Number(result.changes) > 0) written++;
      } else if (event.kind === "skill_routing") {
        const r = event.record;
        written += Number(insertRouting.run(
          r.eventKey, r.createdAtMs, r.agentId, r.sessionId ?? null, r.sessionKey ?? null, r.runId ?? null,
          r.surface ?? null, r.catalogRevision ?? null, r.mode, r.candidateCount, JSON.stringify(r.emitted),
          JSON.stringify(r.scores), truncIntOrNull(r.inputTokens), truncIntOrNull(r.outputTokens), finiteOrNull(r.elapsedMs), r.outcome,
        ).changes);
      } else {
        const r = event.record;
        written += Number(insertOpen.run(r.createdAtMs, r.agentId, r.sessionId ?? null, r.sessionKey ?? null, r.runId ?? null,
          r.skillPath, r.toolName, Number(r.wasWhispered), Number(r.wasPinned)).changes);
      }
    }
    if (options.prune && options.retentionDays && options.retentionDays > 0) {
      const cutoff = Math.trunc((options.nowMs ?? Date.now()) - options.retentionDays * 86_400_000);
      pruned += Number(db.prepare("DELETE FROM recall_queries WHERE created_at_ms < ?").run(cutoff).changes);
      pruned += Number(db.prepare("DELETE FROM recall_reads WHERE read_at_ms < ?").run(cutoff).changes);
      pruned += Number(db.prepare("DELETE FROM skill_routing_events WHERE created_at_ms < ?").run(cutoff).changes);
      pruned += Number(db.prepare("DELETE FROM skill_open_events WHERE created_at_ms < ?").run(cutoff).changes);
    }
  });
  return { written, pruned };
}

/** Direct synchronous batch committer (also used in tests and standalone scripts). */
export function writeRecallBatch(
  path: string,
  events: readonly RecallLedgerEvent[],
  options: { retentionDays?: number; nowMs?: number; prune?: boolean } = {},
): { written: number; pruned: number } {
  if (!events.length && !options.prune) return { written: 0, pruned: 0 };
  const db = openRecallLedger(path);
  try {
    return writeRecallBatchIntoDb(db, events, options);
  } finally {
    db.close();
  }
}

function purgeRecallPersonInDb(db: DatabaseSync, identity: RecallPersonIdentity): { queries: number } {
  const provider = identity.provider.trim().toLowerCase();
  const senderId = identity.senderId.trim();
  const accountId = identity.accountId?.trim().toLowerCase();
  if (!provider || !senderId) throw new Error("provider and senderId are required");
  if (!tableExists(db, "recall_queries")) return { queries: 0 };
  let queries = 0;
  immediateTransaction(db, () => {
    if (accountId) {
      queries = Number(
        db.prepare("DELETE FROM recall_queries WHERE provider = ? AND account_id = ? AND sender_id = ?")
          .run(provider, accountId, senderId).changes,
      );
    } else {
      queries = Number(
        db.prepare("DELETE FROM recall_queries WHERE provider = ? AND sender_id = ?")
          .run(provider, senderId).changes,
      );
    }
  });
  return { queries };
}

/** Operator erasure for one person's recall query history; never creates tables in an uninitialized DB. */
export function purgeRecallPerson(path: string, identity: RecallPersonIdentity): { queries: number } {
  const provider = identity.provider.trim().toLowerCase();
  const senderId = identity.senderId.trim();
  if (!provider || !senderId) throw new Error("provider and senderId are required");
  if (!existsSync(path)) return { queries: 0 };
  const db = openMemoryDatabase(path);
  try {
    return purgeRecallPersonInDb(db, identity);
  } finally {
    db.close();
  }
}

type WorkerRequestPayload =
  | { kind: "batch"; path: string; events: readonly RecallLedgerEvent[]; options: { retentionDays: number; nowMs: number; prune: boolean } }
  | { kind: "purge"; path: string; identity: RecallPersonIdentity }
  | { kind: "shutdown" };

type WorkerRequest = WorkerRequestPayload & { id: number };

type WorkerResponse =
  | { id: number; ok: true; result: { written: number; pruned: number } | { queries: number } | null }
  | { id: number; ok: false; error: string };

/**
 * Persistent worker handler exported by name so the single background worker thread
 * reuses open SQLite connections across batches without spinning up a V8 isolate per event.
 * @public loaded by name from the persistent worker thread
 */
export function createRecallWorkerHandler(): {
  handle: (request: WorkerRequest) => WorkerResponse;
  closeAll: () => void;
} {
  const openDbs = new Map<string, DatabaseSync>();
  const getDb = (path: string): DatabaseSync => {
    let db = openDbs.get(path);
    if (!db) {
      db = openRecallLedger(path);
      openDbs.set(path, db);
    }
    return db;
  };
  const closeAll = () => {
    for (const db of openDbs.values()) {
      try { db.close(); } catch { /* best-effort on worker shutdown */ }
    }
    openDbs.clear();
  };
  const handle = (request: WorkerRequest): WorkerResponse => {
    if (request.kind === "shutdown") {
      closeAll();
      return { id: request.id, ok: true, result: null };
    }
    try {
      if (request.kind === "batch") {
        const db = getDb(request.path);
        const result = writeRecallBatchIntoDb(db, request.events, request.options);
        return { id: request.id, ok: true, result };
      }
      const existing = openDbs.get(request.path);
      if (existing) {
        return { id: request.id, ok: true, result: purgeRecallPersonInDb(existing, request.identity) };
      }
      return { id: request.id, ok: true, result: purgeRecallPerson(request.path, request.identity) };
    } catch (error) {
      // Drop potentially broken handle so the next batch reopens cleanly.
      const broken = openDbs.get(request.path);
      if (broken) {
        openDbs.delete(request.path);
        try { broken.close(); } catch { /* ignore */ }
      }
      return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  return { handle, closeAll };
}

type PendingTask =
  | { kind: "batch"; dbPath: string; events: RecallLedgerEvent[] }
  | { kind: "purge"; dbPath: string; identity: RecallPersonIdentity; resolve: (value: { queries: number }) => void; reject: (error: unknown) => void };

type WorkerHandle = {
  worker: Worker;
  pending: Map<number, { resolve: (value: WorkerResponse) => void; reject: (error: unknown) => void }>;
  terminated: boolean;
};

/**
 * Off-event-loop recall ledger writer backed by a single lazy persistent Worker thread.
 * `enqueue` is strictly O(1) and synchronous with zero SQLite I/O on the Gateway thread.
 */
export class RecallLedgerWriter {
  #queue: PendingTask[] = [];
  #queuedEvents = 0;
  #inFlightEvents = 0;
  #lastPrunedAt = new Map<string, number>();
  #handle?: WorkerHandle;
  #nextRpcId = 1;
  #draining?: Promise<void>;
  #closePromise?: Promise<void>;
  #retentionDays: number;
  #maxQueueSize: number;
  #pruneIntervalMs: number;
  #shutdownTimeoutMs: number;
  #onError?: (error: unknown) => void;
  #onDrop?: () => void;
  #enqueued = 0;
  #written = 0;
  #dropped = 0;
  #errors = 0;
  #closed = false;
  #aborted = false;

  constructor(options: {
    retentionDays?: number;
    maxQueueSize?: number;
    pruneIntervalMs?: number;
    shutdownTimeoutMs?: number;
    onError?: (error: unknown) => void;
    onDrop?: () => void;
  } = {}) {
    this.#retentionDays = options.retentionDays ?? DEFAULTS.recallLedger.defaultRetentionDays;
    this.#maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULTS.recallLedger.maxQueueSize);
    this.#pruneIntervalMs = Math.max(1, options.pruneIntervalMs ?? DEFAULTS.recallLedger.pruneIntervalMs);
    this.#shutdownTimeoutMs = Math.max(100, options.shutdownTimeoutMs ?? DEFAULTS.recallLedger.shutdownTimeoutMs);
    this.#onError = options.onError;
    this.#onDrop = options.onDrop;
  }

  enqueue(dbPath: string, event: RecallLedgerEvent): boolean {
    if (this.#closed || this.#aborted || this.#queuedEvents + this.#inFlightEvents >= this.#maxQueueSize) {
      this.#dropped++;
      this.#onDrop?.();
      return false;
    }
    const tail = this.#queue.at(-1);
    if (tail && tail.kind === "batch" && tail.dbPath === dbPath) {
      tail.events.push(event);
    } else {
      this.#queue.push({ kind: "batch", dbPath, events: [event] });
    }
    this.#queuedEvents++;
    this.#enqueued++;
    this.#scheduleDrain();
    return true;
  }

  /** Orders person erasure behind any previously accepted writes so queued events cannot resurrect deleted rows. */
  async purgePerson(dbPath: string, identity: RecallPersonIdentity): Promise<{ queries: number }> {
    if (this.#closed) {
      if (this.#closePromise) await this.#closePromise;
      return purgeRecallPerson(dbPath, identity);
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ kind: "purge", dbPath, identity, resolve, reject });
      this.#scheduleDrain();
    });
  }

  #ensureWorker(): WorkerHandle {
    if (this.#aborted) throw new Error("Recall ledger writer shutdown timed out");
    if (this.#handle && !this.#handle.terminated) return this.#handle;
    const worker = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      if (workerData.module.endsWith(".ts")) require("node:module").createRequire(workerData.module)("tsx/esm/api").register();
      const ready = import(workerData.module).then(({ createRecallWorkerHandler }) => createRecallWorkerHandler());
      let chain = Promise.resolve();
      parentPort.on("message", (request) => {
        chain = chain.then(async () => {
          const handler = await ready;
          const response = handler.handle(request);
          parentPort.postMessage(response);
          if (request.kind === "shutdown") parentPort.close();
        }).catch((error) => {
          parentPort.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
          if (request.kind === "shutdown") parentPort.close();
        });
      });
      `,
      {
        eval: true,
        execArgv: [],
        workerData: { module: import.meta.url },
      },
    );
    const handle: WorkerHandle = { worker, pending: new Map(), terminated: false };
    worker.on("message", (response: WorkerResponse) => {
      const pending = handle.pending.get(response.id);
      if (!pending) return;
      handle.pending.delete(response.id);
      if (handle.pending.size === 0) worker.unref();
      pending.resolve(response);
    });
    const failHandle = (error: unknown) => {
      if (handle.terminated) return;
      handle.terminated = true;
      if (this.#handle === handle) this.#handle = undefined;
      for (const pending of handle.pending.values()) pending.reject(error);
      handle.pending.clear();
    };
    worker.on("error", failHandle);
    worker.on("exit", (code) => {
      if (handle.pending.size > 0) {
        failHandle(new Error(`Recall ledger worker exited unexpectedly (code ${code})`));
      } else {
        handle.terminated = true;
        if (this.#handle === handle) this.#handle = undefined;
      }
    });
    worker.unref();
    this.#handle = handle;
    return handle;
  }

  #rpc(request: WorkerRequestPayload): Promise<WorkerResponse> {
    const handle = this.#ensureWorker();
    const id = this.#nextRpcId++;
    handle.worker.ref();
    return new Promise((resolve, reject) => {
      handle.pending.set(id, { resolve, reject });
      try {
        handle.worker.postMessage({ ...request, id });
      } catch (error) {
        handle.pending.delete(id);
        if (handle.pending.size === 0) handle.worker.unref();
        reject(error);
      }
    });
  }

  #discardPendingQueue(reason: Error): void {
    while (this.#queue.length > 0) {
      const task = this.#queue.shift()!;
      if (task.kind === "batch") {
        this.#queuedEvents = Math.max(0, this.#queuedEvents - task.events.length);
        this.#dropped += task.events.length;
        for (let i = 0; i < task.events.length; i++) this.#onDrop?.();
      } else {
        task.reject(reason);
      }
    }
    this.#queuedEvents = 0;
  }

  #scheduleDrain(): void {
    if (this.#draining || this.#aborted) return;
    // Coalesce synchronous bursts on the same tick before shipping a batch to the worker.
    this.#draining = Promise.resolve().then(() => this.#drainLoop()).finally(() => {
      this.#draining = undefined;
      if (this.#queue.length > 0 && !this.#closed && !this.#aborted) this.#scheduleDrain();
    });
  }

  async #drainLoop(): Promise<void> {
    while (this.#queue.length > 0 && !this.#aborted) {
      const task = this.#queue.shift()!;
      if (task.kind === "batch") {
        this.#queuedEvents = Math.max(0, this.#queuedEvents - task.events.length);
        this.#inFlightEvents += task.events.length;
        const nowMs = Date.now();
        const lastPruned = this.#lastPrunedAt.get(task.dbPath) ?? 0;
        const prune = nowMs - lastPruned >= this.#pruneIntervalMs;
        try {
          const response = await this.#rpc({
            kind: "batch",
            path: task.dbPath,
            events: task.events,
            options: { retentionDays: this.#retentionDays, nowMs, prune },
          });
          if (!response.ok) throw new Error(response.error);
          if (response.result && "written" in response.result) {
            this.#written += response.result.written;
          }
          if (prune) this.#lastPrunedAt.set(task.dbPath, nowMs);
        } catch (error) {
          this.#errors++;
          this.#dropped += task.events.length;
          this.#onError?.(error);
        } finally {
          this.#inFlightEvents = Math.max(0, this.#inFlightEvents - task.events.length);
        }
      } else {
        try {
          const response = await this.#rpc({
            kind: "purge",
            path: task.dbPath,
            identity: task.identity,
          });
          if (!response.ok) throw new Error(response.error);
          task.resolve((response.result as { queries: number }) ?? { queries: 0 });
        } catch (error) {
          this.#errors++;
          this.#onError?.(error);
          task.reject(error);
        }
      }
    }
  }

  async flush(): Promise<void> {
    while (!this.#aborted && (this.#draining || this.#queue.length > 0)) {
      if (!this.#draining && this.#queue.length > 0) this.#scheduleDrain();
      await this.#draining;
    }
  }

  close(timeoutMs = this.#shutdownTimeoutMs): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    const runClose = async () => {
      const shutdown = async () => {
        await this.flush();
        const handle = this.#handle;
        if (handle && !handle.terminated) {
          try {
            await this.#rpc({ kind: "shutdown" });
          } catch {
            // Worker may already be exiting.
          }
          if (!handle.terminated) {
            await handle.worker.terminate().catch(() => undefined);
            handle.terminated = true;
          }
          if (this.#handle === handle) this.#handle = undefined;
        }
      };
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          shutdown(),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              this.#aborted = true;
              const timeoutError = new Error(`Recall ledger shutdown timed out after ${timeoutMs}ms`);
              this.#discardPendingQueue(timeoutError);
              const handle = this.#handle;
              this.#handle = undefined;
              if (handle && !handle.terminated) {
                handle.terminated = true;
                for (const pending of handle.pending.values()) pending.reject(timeoutError);
                handle.pending.clear();
                void handle.worker.terminate().catch(() => undefined).finally(() => resolve());
              } else {
                resolve();
              }
            }, timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    this.#closePromise = runClose();
    return this.#closePromise;
  }

  stats() {
    return {
      enqueued: this.#enqueued,
      written: this.#written,
      dropped: this.#dropped,
      errors: this.#errors,
    };
  }
}
