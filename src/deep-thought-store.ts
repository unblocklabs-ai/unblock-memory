import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

/* ───────────────────────────── Types ───────────────────────────── */

type DeepThoughtStoredCitation = { source: string; lines?: string; date?: string; quote: string };

export type DeepThoughtJobRecord = {
  jobId: string;
  agentId: string;
  ownerKey: string;
  question: string;
  questionHash: string;
  corpora: string[];
  status: string;
  toolCallsUsed: number;
  lastTool?: string;
  /** The final `DeepThoughtOutcome` (JSON) once the job finished. */
  outcome?: Record<string, unknown>;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  /** Epoch ms after which the row is pruned; absent = never expires (running, or retention `0`). */
  expiresAt?: number;
};

export type DeepThoughtJobInput = {
  jobId: string;
  agentId: string;
  ownerKey: string;
  question: string;
  /** Optional investigation focus; folded into `question_hash`. */
  focus?: string;
  corpora: readonly string[];
  status: string;
  toolCallsUsed: number;
  lastTool?: string;
  outcome?: Record<string, unknown>;
  startedAt: number;
  nowMs?: number;
  completedAt?: number;
  expiresAt?: number;
};

export type DerivedObservationStatus = "fresh" | "stale" | "superseded";

export type DerivedObservation = {
  id: string;
  agentId: string;
  question: string;
  questionHash: string;
  audienceKey: string;
  corpora: string[];
  collectionGenerations: Record<string, number>;
  answer: string;
  confidence: string;
  citations: DeepThoughtStoredCitation[];
  openQuestions: string[];
  sourceJobId?: string;
  status: DerivedObservationStatus;
  hitCount: number;
  createdAt: number;
  lastHitAt?: number;
  invalidatedAt?: number;
};

export type DerivedObservationKey = {
  agentId: string;
  question: string;
  focus?: string;
  audienceKey: string;
  corpora: readonly string[];
};

export type SaveDerivedObservationInput = DerivedObservationKey & {
  collectionGenerations: Readonly<Record<string, number>>;
  answer: string;
  confidence: string;
  citations: readonly DeepThoughtStoredCitation[];
  openQuestions?: readonly string[];
  sourceJobId?: string;
  id?: string;
  nowMs?: number;
};

/* ───────────────────────────── Canonical forms ───────────────────────────── */

/** Lowercase, NFKC, collapsed whitespace, leading/trailing punctuation trimmed. */
export function normalizeDeepThoughtQuestion(question: string): string {
  return question.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ")
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
}

/** Stable fingerprint of the normalized question (and focus, when given: a different focus is a different investigation). */
export function deepThoughtQuestionHash(question: string, focus?: string): string {
  const normalizedFocus = focus === undefined ? "" : normalizeDeepThoughtQuestion(focus);
  const key = normalizedFocus ? `${normalizeDeepThoughtQuestion(question)}\0focus:${normalizedFocus}` : normalizeDeepThoughtQuestion(question);
  return createHash("sha256").update(key).digest("hex");
}

/** Sorted, de-duplicated, trimmed corpus names. */
export function canonicalCorpora(corpora: readonly string[]): string[] {
  return [...new Set(corpora.map(name => name.trim()).filter(Boolean))].sort();
}

function canonicalGenerations(generations: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(generations).sort()) {
    const value = generations[key];
    if (!Number.isSafeInteger(value) || value! < 0) throw new Error(`DeepThoughtStore generation for ${key} must be a non-negative integer`);
    out[key] = value!;
  }
  return out;
}

/** True only when both snapshots record exactly the same collections at exactly the same generations. */
function generationsMatch(recorded: Readonly<Record<string, number>>, current: Readonly<Record<string, number>>): boolean {
  const recordedKeys = Object.keys(recorded);
  if (!recordedKeys.length) return false;
  // A collection that appeared since synthesis is content the answer never saw: also not a match.
  if (Object.keys(current).length !== recordedKeys.length) return false;
  return recordedKeys.every(key => Object.hasOwn(current, key) && current[key] === recorded[key]);
}

/**
 * Public form of the exact freshness rule: `current` must record exactly the collections in `recorded`, each at exactly
 * the same generation. An empty snapshot on either side never verifies.
 */
export function derivedObservationGenerationsFresh(recorded: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>> | undefined): boolean {
  return current !== undefined && Object.keys(current).length > 0 && generationsMatch(recorded, current);
}

/**
 * Caller identity fields that isolate cached `deep_thought` answers. Only fields the host derives from the SAME run
 * parameter on both surfaces are used, so the `deep_thought` tool (writer) and the `before_prompt_build` Memory
 * Whisperer (reader) compute identical keys:
 *
 * | field        | tool context (`createTool`)          | hook context (`before_prompt_build`)  | host source            |
 * |--------------|--------------------------------------|---------------------------------------|------------------------|
 * | `sessionKey` | `sessionKey`                         | `sessionKey`                          | `run.sessionKey`       |
 * | `provider`   | `messageChannel` (normalized)        | `messageProvider` ?? `channel`        | `run.messageProvider`  |
 * | `accountId`  | `agentAccountId`                     | `accountId`                           | `run.agentAccountId`   |
 * | `senderId`   | `requesterSenderId`                  | `senderId`                            | `run.senderId`         |
 *
 * The tool's `nativeChannelId` is deliberately NOT used: hooks never receive it, and hook `chatId`/`channelId` is a
 * different derivation (the lowercased session-key conversation id, thread suffixes included, or `currentChannelId`).
 */
export type DeepThoughtAudienceIdentity = {
  agentId: string;
  sessionKey?: string;
  /** Channel/provider id (e.g. `slack`). Case-folded: the tool side is host-normalized, the hook side is raw. */
  provider?: string;
  accountId?: string;
  /** Requesting sender. Part of the key only outside shared `group`/`channel` sessions (see `deepThoughtAudienceKey`). */
  senderId?: string;
};

/** Mirrors the host's `parseRawSessionConversationRef`: `[agent:<id>:]<provider>:(group|channel):<id>…` is shared. */
function sharedConversationSession(sessionKey: string): boolean {
  const parts = sessionKey.split(":");
  const offset = parts[0]?.trim().toLowerCase() === "agent" ? 2 : 0;
  if (parts.length < offset + 3 || parts[offset]?.trim().toLowerCase() === "agent") return false;
  const kind = parts[offset + 1]?.trim().toLowerCase();
  return (kind === "group" || kind === "channel") && !!parts.slice(offset + 2).join(":").trim();
}

/**
 * The default `deep_thought` cache audience key. A group/channel session key already names one shared conversation,
 * so everyone in it shares answers. Any other session (DMs, including `dmScope=main` where several peers share one
 * session key such as `agent:main:main`) is additionally split per requesting sender, so an answer never crosses a
 * DM/private boundary. Such a session without a verified sender returns `undefined`: callers must skip the cache
 * (never read or write) rather than pool every unidentified caller under one key.
 * Every producer and consumer of `derived_observations.audience_key` must call this so they stay in lockstep.
 */
export function deepThoughtAudienceKey(identity: DeepThoughtAudienceIdentity): string | undefined {
  const text = (value: string | undefined) => value?.trim() ?? "";
  const sessionKey = text(identity.sessionKey);
  const shared = sharedConversationSession(sessionKey);
  const sender = text(identity.senderId);
  if (!shared && !sender) return undefined;
  const key = ["v2", identity.agentId, sessionKey, text(identity.provider).toLowerCase(), text(identity.accountId), shared ? "" : sender];
  return `caller:${createHash("sha256").update(JSON.stringify(key)).digest("hex")}`;
}

/* ───────────────────────────── Deterministic question matching ───────────────────────────── */

/** Default minimum overlap score (share of the stored question's meaningful tokens the turn covers). */
export const DEFAULT_DERIVED_MATCH_MIN_TOKEN_OVERLAP = 0.45;
/** Default minimum count of shared meaningful tokens: one shared word is never enough to fire. */
export const DEFAULT_DERIVED_MATCH_MIN_SHARED_TOKENS = 2;

const STOP_WORDS = new Set(`a about above after again against all also am an and any are aren as at be because been before
being below between both but by can cannot could couldn did didn do does doesn doing don down during each else ever few for
from further get got had hadn has hasn have haven having he her here hers herself him himself his how i if in into is isn it
its itself just know let like ll me might more most much must mustn my myself need no nor not now of off on once only or
other our ours ourselves out over own please re really remember s same say shall she should shouldn so some still such t
tell than thank thanks that the their theirs them themselves then there these they thing things this those through to too
under until up us ve very want was wasn way we well were weren what whats when where whether which while who whom whose why
will with won would wouldn yeah yes yet you your yours yourself yourselves hey hi hello ok okay again quick question`
  .split(/\s+/u).filter(Boolean));

function stemToken(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !/(?:ss|us|is)$/u.test(token)) return token.slice(0, -1);
  return token;
}

/**
 * Meaningful tokens of a question or turn: normalized like `normalizeDeepThoughtQuestion`, split on anything that is
 * not a letter/number, possessives and simple plurals folded, stop words and 1-letter words dropped (numbers are kept).
 */
export function derivedObservationTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizeDeepThoughtQuestion(text).replace(/['’]s\b/gu, "").split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || STOP_WORDS.has(raw)) continue;
    if (raw.length < 2 && !/^\p{N}+$/u.test(raw)) continue;
    const token = stemToken(raw);
    if (!STOP_WORDS.has(token)) out.add(token);
  }
  return out;
}

type DerivedObservationMatchKind = "exact" | "overlap";

export type DerivedObservationMatch = {
  observation: DerivedObservation;
  /** `1` for an exact normalized-question match; otherwise the overlap score in `[0, 1)`. */
  score: number;
  kind: DerivedObservationMatchKind;
  sharedTokens: number;
};

export type DerivedObservationMatchQuery = {
  agentId: string;
  /** The current user turn (or any text) to match against stored questions. */
  queryText: string;
  /** Exact audience key; rows for any other audience are never considered. */
  audienceKey: string;
  /** Every corpus a row searched must be in this set, or the row is never surfaced. */
  allowedCorpora: readonly string[];
  /** Minimum overlap score in `[0, 1]` (default 0.45). `0` keeps any row meeting `minSharedTokens`. */
  minTokenOverlap?: number;
  /** Minimum shared meaningful tokens for a non-exact match (default 2; `0`/`1` are clamped to 1). */
  minSharedTokens?: number;
  /** Maximum matches returned; `0` (default) = unlimited. */
  maxResults?: number;
};

/**
 * Current collection generations used to verify freshness:
 * - a function returns the exact snapshot for one row's (canonical) corpora — the strict per-row check;
 * - a flat record is a snapshot taken for exactly `allowedCorpora`. Rows over that same corpora set get the exact check;
 *   rows over a narrower set are only verifiable as stale (a recorded collection moved or vanished), never as fresh,
 *   because the flat snapshot cannot reveal a collection newly added under the narrower set.
 */
type DerivedObservationGenerationsSource =
  | Readonly<Record<string, number>>
  | ((corpora: readonly string[]) => Readonly<Record<string, number>> | undefined);

export type FindMatchingDerivedObservationsParams = DerivedObservationMatchQuery & {
  currentGenerations: DerivedObservationGenerationsSource;
  nowMs?: number;
};

type Verification = "fresh" | "stale" | "unverifiable";

function verifyAgainst(found: DerivedObservation, source: DerivedObservationGenerationsSource,
  allowedKey: string): Verification {
  if (typeof source === "function") {
    let snapshot: Readonly<Record<string, number>> | undefined;
    try { snapshot = source(found.corpora); } catch { return "unverifiable"; }
    if (!snapshot || !Object.keys(snapshot).length) return "unverifiable";
    return generationsMatch(found.collectionGenerations, snapshot) ? "fresh" : "stale";
  }
  if (!Object.keys(source).length) return "unverifiable";
  const recorded = Object.entries(found.collectionGenerations);
  if (!recorded.length) return "unverifiable";
  // The flat snapshot covers every allowed corpus ⊇ this row's corpora: a moved or vanished collection is definitive.
  if (recorded.some(([collection, generation]) => !Object.hasOwn(source, collection) || source[collection] !== generation)) return "stale";
  if (JSON.stringify(found.corpora) !== allowedKey) return "unverifiable";
  return generationsMatch(found.collectionGenerations, source) ? "fresh" : "stale";
}

function boundedOverlap(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) throw new Error(`DeepThoughtStore ${field} must be between 0 and 1`);
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new Error(`DeepThoughtStore ${field} must be a non-negative integer`);
  return resolved;
}

/**
 * ACL-filtered, scored candidates (no freshness check). Only `fresh` rows of the exact agent + audience whose corpora
 * are all allowed. Exact normalized-question hash → score 1; otherwise score = |shared| / |stored question tokens|
 * (capped below 1), kept when it reaches `minTokenOverlap` with at least `minSharedTokens` shared tokens.
 * Sorted by score desc, then newest first. Unlimited: callers apply `maxResults` after verification.
 */
function scoreCandidates(db: DatabaseSync, query: DerivedObservationMatchQuery): DerivedObservationMatch[] {
  requireText(query.agentId, "agentId"); requireText(query.audienceKey, "audienceKey");
  const minOverlap = boundedOverlap(query.minTokenOverlap, DEFAULT_DERIVED_MATCH_MIN_TOKEN_OVERLAP, "minTokenOverlap");
  const minShared = Math.max(1, nonNegativeInteger(query.minSharedTokens, DEFAULT_DERIVED_MATCH_MIN_SHARED_TOKENS, "minSharedTokens"));
  nonNegativeInteger(query.maxResults, 0, "maxResults");
  const allowed = new Set(canonicalCorpora(query.allowedCorpora));
  if (!allowed.size || !normalizeDeepThoughtQuestion(query.queryText)) return [];
  const queryHash = deepThoughtQuestionHash(query.queryText);
  const queryTokens = derivedObservationTokens(query.queryText);
  const rows = db.prepare(`SELECT * FROM derived_observations WHERE agent_id=? AND audience_key=? AND status='fresh'
    ORDER BY created_at DESC, id`).all(query.agentId, query.audienceKey);
  const matches: DerivedObservationMatch[] = [];
  for (const row of rows) {
    let found: DerivedObservation;
    try { found = observation(row); } catch { continue; }
    if (found.audienceKey !== query.audienceKey || found.agentId !== query.agentId) continue;
    if (!Array.isArray(found.corpora) || !found.corpora.length || !found.corpora.every(corpus => allowed.has(corpus))) continue;
    if (found.questionHash === queryHash) {
      matches.push({ observation: found, score: 1, kind: "exact", sharedTokens: queryTokens.size });
      continue;
    }
    const stored = derivedObservationTokens(found.question);
    if (!stored.size) continue;
    let shared = 0;
    for (const token of stored) if (queryTokens.has(token)) shared += 1;
    if (shared < minShared) continue;
    const score = Math.min(shared / stored.size, 0.999);
    if (score < minOverlap) continue;
    matches.push({ observation: found, score, kind: "overlap", sharedTokens: shared });
  }
  return matches.sort((a, b) => b.score - a.score || b.observation.createdAt - a.observation.createdAt);
}

function limited<T>(items: T[], maxResults: number | undefined): T[] {
  const limit = maxResults ?? 0;
  return limit > 0 ? items.slice(0, limit) : items;
}

function hasDerivedObservationsTable(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='derived_observations'").get());
}

/** Opens an existing database read-only; `undefined` when it does not exist, cannot be opened, or has no table. */
function openReadOnly(dbPath: string): DatabaseSync | undefined {
  if (!dbPath || !existsSync(dbPath)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    if (hasDerivedObservationsTable(db)) return db;
  } catch {}
  try { db?.close(); } catch {}
  return undefined;
}

/**
 * Read-only candidate lookup (ACL + deterministic scoring, no freshness check) against an existing database file.
 * Returns `[]` — never throws for a missing database or table — so callers on the hot path can probe cheaply.
 */
export function readDerivedObservationCandidates(dbPath: string, query: DerivedObservationMatchQuery): DerivedObservationMatch[] {
  const db = openReadOnly(dbPath);
  if (!db) return [];
  try { return scoreCandidates(db, query); }
  finally { db.close(); }
}

/**
 * Read-only `findMatchingDerivedObservations`: identical matching and verification, but never writes (stale rows are
 * skipped, not marked). `[]` when the database or `derived_observations` table does not exist.
 */
export function findMatchingDerivedObservationsReadOnly(dbPath: string,
  params: FindMatchingDerivedObservationsParams): DerivedObservationMatch[] {
  if (isEmptyGenerations(params.currentGenerations)) return [];
  const candidates = readDerivedObservationCandidates(dbPath, params);
  const allowedKey = JSON.stringify(canonicalCorpora(params.allowedCorpora));
  return limited(candidates.filter(match => verifyAgainst(match.observation, params.currentGenerations, allowedKey) === "fresh"),
    params.maxResults);
}

function isEmptyGenerations(source: DerivedObservationGenerationsSource): boolean {
  return typeof source !== "function" && !Object.keys(source).length;
}

function optionalNumber(value: unknown): number | undefined { return value === null || value === undefined ? undefined : Number(value); }
function optionalText(value: unknown): string | undefined { return value === null || value === undefined ? undefined : String(value); }

function jobRecord(row: Record<string, unknown>): DeepThoughtJobRecord {
  const outcome = optionalText(row.outcome_json);
  return {
    jobId: String(row.job_id), agentId: String(row.agent_id), ownerKey: String(row.owner_key), question: String(row.question),
    questionHash: String(row.question_hash), corpora: JSON.parse(String(row.corpora_json)) as string[], status: String(row.status),
    toolCallsUsed: Number(row.tool_calls_used),
    ...(optionalText(row.last_tool) !== undefined ? { lastTool: String(row.last_tool) } : {}),
    ...(outcome !== undefined ? { outcome: JSON.parse(outcome) as Record<string, unknown> } : {}),
    startedAt: Number(row.started_at), updatedAt: Number(row.updated_at),
    ...(optionalNumber(row.completed_at) !== undefined ? { completedAt: Number(row.completed_at) } : {}),
    ...(optionalNumber(row.expires_at) !== undefined ? { expiresAt: Number(row.expires_at) } : {}),
  };
}

function observation(row: Record<string, unknown>): DerivedObservation {
  return {
    id: String(row.id), agentId: String(row.agent_id), question: String(row.question), questionHash: String(row.question_hash),
    audienceKey: String(row.audience_key), corpora: JSON.parse(String(row.corpora_json)) as string[],
    collectionGenerations: JSON.parse(String(row.collection_generations_json)) as Record<string, number>,
    answer: String(row.answer), confidence: String(row.confidence),
    citations: JSON.parse(String(row.citations_json)) as DeepThoughtStoredCitation[],
    openQuestions: JSON.parse(String(row.open_questions_json)) as string[],
    ...(optionalText(row.source_job_id) !== undefined ? { sourceJobId: String(row.source_job_id) } : {}),
    status: String(row.status) as DerivedObservationStatus, hitCount: Number(row.hit_count), createdAt: Number(row.created_at),
    ...(optionalNumber(row.last_hit_at) !== undefined ? { lastHitAt: Number(row.last_hit_at) } : {}),
    ...(optionalNumber(row.invalidated_at) !== undefined ? { invalidatedAt: Number(row.invalidated_at) } : {}),
  };
}

/** Identity keys must round-trip exactly: SQLite TEXT returned through node:sqlite truncates at NUL. */
function requireText(value: string, field: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`DeepThoughtStore ${field} is required`);
  if (value.includes("\0")) throw new Error(`DeepThoughtStore ${field} must not contain NUL characters`);
}

function ensureSchema(db: DatabaseSync): void {
  const read = () => db.prepare("SELECT version FROM memory_schema WHERE component=?").get(COMPONENT)?.version;
  const ready = (version: unknown) => {
    if (version !== undefined && version !== SCHEMA_VERSION) throw new Error("Unsupported deep_thought store schema version");
    return version === SCHEMA_VERSION &&
      Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='deep_thought_jobs'").get()) &&
      Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='derived_observations'").get());
  };
  // Fast path avoids taking the write lock on every open.
  if (ready(read())) return;
  immediateTransaction(db, () => {
    if (ready(read())) return;
    db.exec(SCHEMA);
    db.prepare("INSERT OR IGNORE INTO memory_schema VALUES (?,?)").run(COMPONENT, SCHEMA_VERSION);
  });
}

/* ───────────────────────────── Store ───────────────────────────── */

export class DeepThoughtStore {
  readonly db: DatabaseSync;
  readonly #owned: boolean;

  /** Pass a path to open a dedicated connection, or an already-open `DatabaseSync` to share one. */
  constructor(database: string | DatabaseSync, options: { busyTimeoutMs?: number } = {}) {
    this.#owned = typeof database === "string";
    this.db = typeof database === "string"
      ? openMemoryDatabase(database, options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs })
      : database;
    try { ensureSchema(this.db); }
    catch (error) { if (this.#owned) this.db.close(); throw error; }
  }

  close(): void { if (this.#owned) this.db.close(); }

  /* ─────────── Jobs ─────────── */

  /** Insert a job, or update its progress/outcome. Identity columns (agent, owner, question) never change after insert. */
  upsertJob(input: DeepThoughtJobInput): DeepThoughtJobRecord {
    requireText(input.jobId, "jobId"); requireText(input.agentId, "agentId"); requireText(input.ownerKey, "ownerKey");
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
      .run(input.jobId, input.agentId, input.ownerKey, input.question, deepThoughtQuestionHash(input.question, input.focus),
        JSON.stringify(canonicalCorpora(input.corpora)), input.status, Math.max(0, Math.trunc(input.toolCallsUsed)),
        input.lastTool ?? null, input.outcome === undefined ? null : JSON.stringify(input.outcome), input.startedAt, now,
        input.completedAt ?? null, input.expiresAt ?? null);
    const stored = this.getJob(input.jobId);
    if (!stored || stored.ownerKey !== input.ownerKey || stored.agentId !== input.agentId) {
      throw new Error(`DeepThoughtStore job ${input.jobId} belongs to another caller`);
    }
    return stored;
  }

  getJob(jobId: string): DeepThoughtJobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM deep_thought_jobs WHERE job_id=?").get(jobId);
    return row ? jobRecord(row) : undefined;
  }

  deleteJob(jobId: string): boolean {
    return Number(this.db.prepare("DELETE FROM deep_thought_jobs WHERE job_id=?").run(jobId).changes) > 0;
  }

  /**
   * Restart recovery: every `running` row for `agentId` (except live `keepJobIds` still owned by this process) becomes
   * `cancelled` with a self-explaining outcome, so polling its `jobId` answers instead of hanging forever.
   * `retentionMs` (`0` = unlimited) sets how long the cancelled record stays collectible.
   */
  markInterruptedJobs(agentId: string, nowMs: number,
    options: { keepJobIds?: Iterable<string>; retentionMs?: number } = {}): number {
    const keep = new Set(options.keepJobIds ?? []);
    const retentionMs = options.retentionMs ?? DEFAULT_DEEP_THOUGHT_JOB_RETENTION_MS;
    const expiresAt = retentionMs > 0 ? nowMs + retentionMs : null;
    return immediateTransaction(this.db, () => {
      const rows = this.db.prepare("SELECT * FROM deep_thought_jobs WHERE agent_id=? AND status='running'").all(agentId).map(jobRecord);
      let changed = 0;
      for (const job of rows) {
        if (keep.has(job.jobId)) continue;
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
  pruneExpiredJobs(nowMs: number): number {
    return Number(this.db.prepare("DELETE FROM deep_thought_jobs WHERE expires_at IS NOT NULL AND expires_at<=?").run(nowMs).changes);
  }

  /* ─────────── Derived observations ─────────── */

  /** Persist a verified synthesis; any previous `fresh` row for the same key becomes `superseded` atomically. */
  saveDerivedObservation(input: SaveDerivedObservationInput): DerivedObservation {
    requireText(input.agentId, "agentId"); requireText(input.audienceKey, "audienceKey");
    if (!input.answer.trim()) throw new Error("DeepThoughtStore answer is required");
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
        .run(id, input.agentId, input.question, questionHash, input.audienceKey, corpora, JSON.stringify(generations), input.answer,
          input.confidence, JSON.stringify(input.citations), JSON.stringify(input.openQuestions ?? []), input.sourceJobId ?? null, now);
      return observation(this.db.prepare("SELECT * FROM derived_observations WHERE id=?").get(id)!);
    });
  }

  /**
   * Exact-key lookup of the `fresh` observation. Hits (and counts the hit) only when `currentGenerations` records exactly
   * the same collections at exactly the same generations; otherwise the row is marked `stale` and `undefined` is returned.
   * An empty `currentGenerations` cannot verify anything: it misses without invalidating.
   */
  findFreshDerivedObservation(input: DerivedObservationKey & {
    currentGenerations: Readonly<Record<string, number>>; nowMs?: number;
  }): DerivedObservation | undefined {
    if (!Object.keys(input.currentGenerations).length) return undefined;
    const now = input.nowMs ?? Date.now();
    const questionHash = deepThoughtQuestionHash(input.question, input.focus);
    const corpora = JSON.stringify(canonicalCorpora(input.corpora));
    return immediateTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT * FROM derived_observations
        WHERE agent_id=? AND question_hash=? AND audience_key=? AND corpora_json=? AND status='fresh'
        ORDER BY created_at DESC LIMIT 1`).get(input.agentId, questionHash, input.audienceKey, corpora);
      if (!row) return undefined;
      const found = observation(row);
      if (!generationsMatch(found.collectionGenerations, input.currentGenerations)) {
        this.db.prepare("UPDATE derived_observations SET status='stale', invalidated_at=? WHERE id=? AND status='fresh'").run(now, found.id);
        return undefined;
      }
      this.db.prepare("UPDATE derived_observations SET hit_count=hit_count+1, last_hit_at=? WHERE id=?").run(now, found.id);
      return { ...found, hitCount: found.hitCount + 1, lastHitAt: now };
    });
  }

  /**
   * Fresh, generation-verified observations whose question matches `queryText` (see `DerivedObservationMatchQuery`).
   * Strict ACL: exact agent + audience, every searched corpus allowed. An empty `currentGenerations` returns `[]`.
   * Rows that verify as stale (a recorded collection moved, vanished, or a new one appeared) are marked `stale`.
   * Never counts hits: a whisper is not a served `deep_thought` answer.
   */
  findMatchingDerivedObservations(params: FindMatchingDerivedObservationsParams): DerivedObservationMatch[] {
    if (isEmptyGenerations(params.currentGenerations)) return [];
    const now = params.nowMs ?? Date.now();
    const candidates = scoreCandidates(this.db, params);
    const allowedKey = JSON.stringify(canonicalCorpora(params.allowedCorpora));
    const fresh: DerivedObservationMatch[] = [];
    const stale: string[] = [];
    for (const match of candidates) {
      const verdict = verifyAgainst(match.observation, params.currentGenerations, allowedKey);
      if (verdict === "fresh") fresh.push(match);
      else if (verdict === "stale") stale.push(match.observation.id);
    }
    if (stale.length) {
      immediateTransaction(this.db, () => {
        const mark = this.db.prepare("UPDATE derived_observations SET status='stale', invalidated_at=? WHERE id=? AND status='fresh'");
        for (const id of stale) mark.run(now, id);
      });
    }
    return limited(fresh, params.maxResults);
  }

  getDerivedObservation(id: string): DerivedObservation | undefined {
    const row = this.db.prepare("SELECT * FROM derived_observations WHERE id=?").get(id);
    return row ? observation(row) : undefined;
  }

  /** Newest first. `limit` `0` (default) = unlimited. */
  listDerivedObservations(options: { agentId: string; status?: DerivedObservationStatus; audienceKey?: string; limit?: number }): DerivedObservation[] {
    const limit = options.limit ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("DeepThoughtStore limit must be a non-negative integer (0 = unlimited)");
    const status = options.status ?? null, audience = options.audienceKey ?? null;
    return this.db.prepare(`SELECT * FROM derived_observations
      WHERE agent_id=? AND (? IS NULL OR status=?) AND (? IS NULL OR audience_key=?)
      ORDER BY created_at DESC, id LIMIT ?`)
      .all(options.agentId, status, status, audience, audience, limit > 0 ? limit : -1).map(observation);
  }
}
