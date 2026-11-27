import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { isRecord, nonBlank } from "./guards.js";
import { immediateTransaction, openMemoryDatabase, tableExists } from "./memory-database.js";

// Loaded by plain-Node workers, offline tools and the Expectations Whisperer: keep this module free of `openclaw`.

/**
 * The 6th primitive: memory of the FUTURE. One row per open commitment, prediction, blocker, decision outcome
 * hypothesis or todo, keyed by `(agent_id, dedup_key)` so every producer upserts idempotently.
 *
 * - Identity columns (`kind`, `source_kind`, `audience_key`, `chat_type`) are fixed by the first write: a later
 *   upsert can never move an expectation into a wider audience.
 * - A resolved status (`kept`/`broken`/`right`/`wrong`/`expired`/`dismissed`) survives re-upserts unless the
 *   caller passes `reopen: true`.
 * - Read helpers take a raw `DatabaseSync`, never create the table, and return empty results when it is absent, so
 *   read-only consumers (whisperers, diagnostics) can share them.
 */

export const EXPECTATIONS_COMPONENT = "expectations";
export const EXPECTATIONS_SCHEMA_VERSION = 1;
const TABLE = "expectations";

export const EXPECTATION_KINDS = ["commitment", "prediction", "blocker", "decision_outcome", "todo"] as const;
export const EXPECTATION_SOURCE_KINDS = ["captains_log", "people_todo", "session_steward", "manual"] as const;
export const EXPECTATION_CHAT_TYPES = ["channel", "group", "direct", "workspace"] as const;
export const EXPECTATION_STATUSES = ["open", "kept", "broken", "right", "wrong", "expired", "dismissed"] as const;
export const RESOLVED_EXPECTATION_STATUSES = ["kept", "broken", "right", "wrong", "expired", "dismissed"] as const;

export type ExpectationKind = typeof EXPECTATION_KINDS[number];
export type ExpectationSourceKind = typeof EXPECTATION_SOURCE_KINDS[number];
export type ExpectationChatType = typeof EXPECTATION_CHAT_TYPES[number];
export type ExpectationStatus = typeof EXPECTATION_STATUSES[number];
export type ResolvedExpectationStatus = typeof RESOLVED_EXPECTATION_STATUSES[number];

/**
 * Workspace-wide audience. Reserved for explicitly workspace-approved sources (Captain's Log workspace blockers, active
 * people todos, operator items); a channel or group conversation is NEVER pooled into it.
 */
export const WORKSPACE_AUDIENCE = "workspace";

const audiencePart = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Strict per-person DM audience `direct:<provider>:<accountId>:<senderId>` (provider lowercased). Fails closed: any
 * missing part yields `undefined`, so an unknown sender or provider never collapses into a shared key.
 */
export function directAudienceKey(provider: unknown, accountId: unknown, senderId: unknown): string | undefined {
  const parts = [audiencePart(provider)?.toLowerCase(), audiencePart(accountId), audiencePart(senderId)];
  return parts.every(Boolean) ? `direct:${parts.join(":")}` : undefined;
}

/**
 * One shared conversation's audience: `channel:<provider>:<accountId>:<nativeChannelId>` or
 * `group:<provider>:<accountId>:<nativeChannelId>` (provider and channel id lowercased, thread suffixes dropped: hook
 * contexts carry a lowercased conversation id). Fails closed with `undefined` when any part is missing.
 */
export function conversationAudienceKey(chatType: "channel" | "group", provider: unknown, accountId: unknown,
  nativeChannelId: unknown): string | undefined {
  const channel = audiencePart(audiencePart(nativeChannelId)?.split(/:(?:thread|topic):/iu, 1)[0])?.toLowerCase();
  const parts = [audiencePart(provider)?.toLowerCase(), audiencePart(accountId), channel];
  return parts.every(Boolean) ? `${chatType}:${parts.join(":")}` : undefined;
}

export const EXPECTATIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS expectations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('commitment', 'prediction', 'blocker', 'decision_outcome', 'todo')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('captains_log', 'people_todo', 'session_steward', 'manual')),
  source_ref TEXT NOT NULL,
  audience_key TEXT NOT NULL,
  chat_type TEXT NOT NULL CHECK(chat_type IN ('channel', 'group', 'direct', 'workspace')),
  subject_person_id TEXT,
  subject_label TEXT,
  channel TEXT,
  summary TEXT NOT NULL,
  expected_state TEXT NOT NULL,
  due_at_ms INTEGER,
  trigger_spec_json TEXT NOT NULL CHECK(json_valid(trigger_spec_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  status TEXT NOT NULL CHECK(status IN ('open', 'kept', 'broken', 'right', 'wrong', 'expired', 'dismissed')),
  surprise_score REAL CHECK(surprise_score IS NULL OR (surprise_score >= 0.0 AND surprise_score <= 1.0)),
  resolution_note TEXT,
  resolution_evidence_json TEXT CHECK(resolution_evidence_json IS NULL OR json_valid(resolution_evidence_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  UNIQUE(agent_id, dedup_key)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_expectations_agent_status_due ON expectations(agent_id, status, due_at_ms);
CREATE INDEX IF NOT EXISTS idx_expectations_agent_audience ON expectations(agent_id, status, audience_key);
CREATE INDEX IF NOT EXISTS idx_expectations_agent_channel ON expectations(agent_id, status, channel);
CREATE INDEX IF NOT EXISTS idx_expectations_agent_person ON expectations(agent_id, status, subject_person_id);`;

export type ExpectationTriggerSpec = {
  channels?: string[]; personIds?: string[]; senderIds?: string[]; keywords?: string[]; dueLeadMs?: number;
};

export type Expectation = {
  id: string; agentId: string; dedupKey: string; kind: ExpectationKind; sourceKind: ExpectationSourceKind; sourceRef: string;
  audienceKey: string; chatType: ExpectationChatType; subjectPersonId: string | null; subjectLabel: string | null;
  channel: string | null; summary: string; expectedState: string; dueAtMs: number | null; triggerSpec: ExpectationTriggerSpec;
  evidence: unknown; status: ExpectationStatus; surpriseScore: number | null; resolutionNote: string | null;
  resolutionEvidence: unknown; createdAtMs: number; updatedAtMs: number; resolvedAtMs: number | null;
};

export type ExpectationInput = {
  agentId: string; dedupKey: string; kind: ExpectationKind; sourceKind: ExpectationSourceKind; sourceRef: string;
  audienceKey: string; chatType: ExpectationChatType; summary: string; expectedState: string;
  subjectPersonId?: string | null; subjectLabel?: string | null; channel?: string | null; dueAtMs?: number | null;
  triggerSpec?: ExpectationTriggerSpec; evidence?: unknown;
  /** Explicitly reopen a resolved row (clears its resolution). Without it a resolved status is preserved. */
  reopen?: boolean;
  nowMs?: number;
};

export type ExpectationUpsertResult = { action: "inserted" | "updated" | "reopened" | "unchanged"; expectation: Expectation };

export type ResolveExpectationInput = {
  id: string; agentId: string; status: ResolvedExpectationStatus; surpriseScore?: number | null; resolutionNote?: string | null;
  resolutionEvidence?: unknown; resolvedAtMs?: number;
};

export type ExpectationFilter = {
  agentId: string;
  status?: ExpectationStatus | readonly ExpectationStatus[];
  kind?: ExpectationKind | readonly ExpectationKind[];
  sourceKind?: ExpectationSourceKind | readonly ExpectationSourceKind[];
  channel?: string;
  personId?: string;
  /** Restrict to these audiences (an empty array matches nothing). Omit for every audience. */
  audienceKeys?: readonly string[];
  dueBeforeMs?: number;
  /** `0` or omitted = unlimited. */
  limit?: number;
};

export type ExpectationsSummary = {
  total: number;
  byStatus: Record<ExpectationStatus, number>;
  byKind: Record<ExpectationKind, number>;
  /** Open expectations whose `due_at_ms` is before `nowMs`. */
  overdue: number;
  /** Mean surprise over resolved rows that carry a score, or `null` when none do. */
  averageSurprise: number | null;
  resolvedWithSurprise: number;
};

// Keep in step with steward-captains-log.ts's redactor (it is module-private there).
export function redactSecrets(text: string): string {
  return text.replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/giu, "[redacted]")
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/gu, "[redacted]")
    .replace(/\b(?:Bearer|Authorization\s*:\s*Basic)\s+[^\s"',;\]}]+|\b(?:sk-|xox[baprs]-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}/giu, "[redacted]")
    .replace(/\b([\w-]*(?:api[_ -]?key|token|credential|password|passwd|secret)[\w-]*["'`]?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\\r\n])*`|[^\s,;]+)/giu, "$1[redacted]")
    .replace(/(\b[a-z][\w+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[redacted]@");
}

const oneLine = (text: string) => redactSecrets(text).replace(/\s+/gu, " ").trim();

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`Expectation ${field} must be a non-empty string`);
  return value.trim();
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new TypeError(`Expectation ${field} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function optionalTime(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`Expectation ${field} must be a non-negative integer`);
  return value as number;
}

function optionalText(value: unknown): string | null {
  const text = nonBlank(value);
  return text === undefined ? null : oneLine(text) || null;
}

function requireSurprise(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("Expectation surpriseScore must be within 0..1");
  return value;
}

function requireLimit(limit: number | undefined): number {
  const value = limit ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("limit must be a non-negative integer");
  return value;
}

const uniqueStrings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.flatMap(item => { const text = typeof item === "string" ? oneLine(item) : ""; return text ? [text] : []; }))]
  : [];

/** Normalize a caller- or model-provided trigger spec, keeping only well-formed fields. */
export function normalizeTriggerSpec(value: unknown): ExpectationTriggerSpec {
  if (!isRecord(value)) return {};
  const spec: ExpectationTriggerSpec = {};
  for (const key of ["channels", "personIds", "senderIds", "keywords"] as const) {
    const list = uniqueStrings(value[key]);
    if (list.length) spec[key] = list;
  }
  const lead = value.dueLeadMs;
  if (typeof lead === "number" && Number.isSafeInteger(lead) && lead >= 0) spec.dueLeadMs = lead;
  return spec;
}

function jsonText(value: unknown, field: string): string {
  const text = JSON.stringify(value ?? {});
  if (text === undefined) throw new TypeError(`Expectation ${field} must be JSON-serializable`);
  return text;
}

function parseJson(text: unknown, fallback: unknown): unknown {
  if (typeof text !== "string") return fallback;
  try { return JSON.parse(text) as unknown; } catch { return fallback; }
}

const nullableText = (value: unknown) => value === null || value === undefined ? null : String(value);
const nullableNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);

function expectation(row: Record<string, unknown>): Expectation {
  return {
    id: String(row.id), agentId: String(row.agent_id), dedupKey: String(row.dedup_key), kind: row.kind as ExpectationKind,
    sourceKind: row.source_kind as ExpectationSourceKind, sourceRef: String(row.source_ref), audienceKey: String(row.audience_key),
    chatType: row.chat_type as ExpectationChatType, subjectPersonId: nullableText(row.subject_person_id),
    subjectLabel: nullableText(row.subject_label), channel: nullableText(row.channel), summary: String(row.summary),
    expectedState: String(row.expected_state), dueAtMs: nullableNumber(row.due_at_ms),
    triggerSpec: normalizeTriggerSpec(parseJson(row.trigger_spec_json, {})), evidence: parseJson(row.evidence_json, {}),
    status: row.status as ExpectationStatus, surpriseScore: nullableNumber(row.surprise_score),
    resolutionNote: nullableText(row.resolution_note), resolutionEvidence: parseJson(row.resolution_evidence_json, null),
    createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms), resolvedAtMs: nullableNumber(row.resolved_at_ms),
  };
}

/** Runs `fn` atomically, joining a caller's open transaction (e.g. `WorkStore.commitWithDomain`) instead of nesting. */
function atomically<T>(db: DatabaseSync, fn: () => T): T {
  return db.isTransaction ? fn() : immediateTransaction(db, fn);
}

/** Create the table and register `memory_schema('expectations', 1)`. Idempotent; refuses unknown future versions. */
export function ensureExpectationsSchema(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS memory_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT");
  const ready = () => {
    const version = db.prepare("SELECT version FROM memory_schema WHERE component=?").get(EXPECTATIONS_COMPONENT)?.version;
    if (version !== undefined && version !== EXPECTATIONS_SCHEMA_VERSION) throw new Error("Unsupported expectations schema version");
    return version === EXPECTATIONS_SCHEMA_VERSION && tableExists(db, TABLE);
  };
  if (ready()) return;
  atomically(db, () => {
    if (ready()) return;
    db.exec(EXPECTATIONS_SCHEMA);
    db.prepare("INSERT OR IGNORE INTO memory_schema VALUES (?,?)").run(EXPECTATIONS_COMPONENT, EXPECTATIONS_SCHEMA_VERSION);
  });
}

function hasTable(db: DatabaseSync): boolean {
  try { return tableExists(db, TABLE); } catch { return false; }
}

/** Upsert by `(agent_id, dedup_key)`, creating the table on first use. */
export function upsertExpectation(db: DatabaseSync, input: ExpectationInput): ExpectationUpsertResult {
  ensureExpectationsSchema(db);
  const agentId = requireText(input.agentId, "agentId"), dedupKey = requireText(input.dedupKey, "dedupKey");
  const kind = requireEnum(input.kind, EXPECTATION_KINDS, "kind");
  const sourceKind = requireEnum(input.sourceKind, EXPECTATION_SOURCE_KINDS, "sourceKind");
  const chatType = requireEnum(input.chatType, EXPECTATION_CHAT_TYPES, "chatType");
  const audienceKey = requireText(input.audienceKey, "audienceKey");
  if (chatType === "direct" ? !audienceKey.startsWith("direct:") : audienceKey.startsWith("direct:")) {
    throw new TypeError("Expectation direct chatType and direct: audienceKey must go together");
  }
  // The shared workspace audience is only ever a workspace row: a channel/group conversation is never broadcast.
  if ((chatType === "workspace") !== (audienceKey === WORKSPACE_AUDIENCE)) {
    throw new TypeError("Expectation workspace chatType and the workspace audienceKey must go together");
  }
  const sourceRef = requireText(input.sourceRef, "sourceRef");
  const summary = oneLine(requireText(input.summary, "summary")), expectedState = oneLine(requireText(input.expectedState, "expectedState"));
  if (!summary || !expectedState) throw new TypeError("Expectation summary and expectedState must not be blank after redaction");
  const dueAtMs = optionalTime(input.dueAtMs, "dueAtMs");
  const now = optionalTime(input.nowMs, "nowMs") ?? Date.now();
  const triggerJson = jsonText(normalizeTriggerSpec(input.triggerSpec ?? {}), "triggerSpec");
  const evidenceJson = jsonText(input.evidence ?? {}, "evidence");
  const personId = optionalText(input.subjectPersonId), label = optionalText(input.subjectLabel), channel = optionalText(input.channel);
  return atomically(db, () => {
    const existing = db.prepare("SELECT * FROM expectations WHERE agent_id=? AND dedup_key=?").get(agentId, dedupKey);
    if (!existing) {
      const id = randomUUID();
      db.prepare(`INSERT INTO expectations (id, agent_id, dedup_key, kind, source_kind, source_ref, audience_key, chat_type,
          subject_person_id, subject_label, channel, summary, expected_state, due_at_ms, trigger_spec_json, evidence_json, status,
          created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`)
        .run(id, agentId, dedupKey, kind, sourceKind, sourceRef, audienceKey, chatType, personId, label, channel, summary, expectedState,
          dueAtMs, triggerJson, evidenceJson, now, now);
      return { action: "inserted", expectation: expectation(db.prepare("SELECT * FROM expectations WHERE id=?").get(id)!) };
    }
    const reopen = input.reopen === true && existing.status !== "open";
    const params: SQLInputValue[] = [sourceRef, personId, label, channel, summary, expectedState, dueAtMs, triggerJson, evidenceJson];
    const changed = Number(db.prepare(`UPDATE expectations SET source_ref=?, subject_person_id=?, subject_label=?, channel=?, summary=?,
        expected_state=?, due_at_ms=?, trigger_spec_json=?, evidence_json=?, updated_at_ms=?,
        status=CASE WHEN ? THEN 'open' ELSE status END,
        surprise_score=CASE WHEN ? THEN NULL ELSE surprise_score END,
        resolution_note=CASE WHEN ? THEN NULL ELSE resolution_note END,
        resolution_evidence_json=CASE WHEN ? THEN NULL ELSE resolution_evidence_json END,
        resolved_at_ms=CASE WHEN ? THEN NULL ELSE resolved_at_ms END
      WHERE id=? AND (? OR source_ref IS NOT ? OR subject_person_id IS NOT ? OR subject_label IS NOT ? OR channel IS NOT ? OR summary IS NOT ?
        OR expected_state IS NOT ? OR due_at_ms IS NOT ? OR trigger_spec_json IS NOT ? OR evidence_json IS NOT ?)`)
      .run(...params, now, ...Array<number>(5).fill(Number(reopen)), String(existing.id), Number(reopen), ...params).changes) > 0;
    const row = expectation(db.prepare("SELECT * FROM expectations WHERE id=?").get(String(existing.id))!);
    return { action: reopen ? "reopened" : changed ? "updated" : "unchanged", expectation: row };
  });
}

/** Resolve an `open` expectation once. Returns false when it is missing, belongs to another agent, or is already resolved. */
export function resolveExpectation(db: DatabaseSync, input: ResolveExpectationInput): boolean {
  if (!hasTable(db)) return false;
  const status = requireEnum(input.status, RESOLVED_EXPECTATION_STATUSES, "status");
  const surprise = requireSurprise(input.surpriseScore);
  const resolvedAt = optionalTime(input.resolvedAtMs, "resolvedAtMs") ?? Date.now();
  const note = optionalText(input.resolutionNote);
  const evidence = input.resolutionEvidence === undefined || input.resolutionEvidence === null ? null : jsonText(input.resolutionEvidence, "resolutionEvidence");
  return Number(db.prepare(`UPDATE expectations SET status=?, surprise_score=?, resolution_note=?, resolution_evidence_json=?,
      resolved_at_ms=?, updated_at_ms=? WHERE id=? AND agent_id=? AND status='open'`)
    .run(status, surprise, note, evidence, resolvedAt, resolvedAt, input.id, input.agentId).changes) > 0;
}

const asList = <T>(value: T | readonly T[] | undefined): readonly T[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value as readonly T[] : [value as T];

/** Due-first (undated last), then oldest first. Missing table → `[]`. Safe on read-only connections. */
export function listExpectations(db: DatabaseSync, filter: ExpectationFilter): Expectation[] {
  const limit = requireLimit(filter.limit);
  if (!hasTable(db)) return [];
  const where = ["agent_id=?"], params: SQLInputValue[] = [filter.agentId];
  const inList = (column: string, values: readonly string[] | undefined) => {
    if (values === undefined) return;
    if (!values.length) { where.push("0"); return; }
    where.push(`${column} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };
  inList("status", asList(filter.status));
  inList("kind", asList(filter.kind));
  inList("source_kind", asList(filter.sourceKind));
  inList("audience_key", filter.audienceKeys);
  if (filter.channel !== undefined) { where.push("channel=?"); params.push(filter.channel); }
  if (filter.personId !== undefined) { where.push("subject_person_id=?"); params.push(filter.personId); }
  if (filter.dueBeforeMs !== undefined) { where.push("due_at_ms IS NOT NULL AND due_at_ms<=?"); params.push(filter.dueBeforeMs); }
  return db.prepare(`SELECT * FROM expectations WHERE ${where.join(" AND ")}
    ORDER BY due_at_ms IS NULL, due_at_ms, created_at_ms, id LIMIT ?`).all(...params, limit || -1).map(expectation);
}

export function getExpectation(db: DatabaseSync, id: string, agentId: string): Expectation | undefined {
  if (!hasTable(db)) return undefined;
  const row = db.prepare("SELECT * FROM expectations WHERE id=? AND agent_id=?").get(id, agentId);
  return row ? expectation(row) : undefined;
}

function emptySummary(): ExpectationsSummary {
  return {
    total: 0, overdue: 0, averageSurprise: null, resolvedWithSurprise: 0,
    byStatus: Object.fromEntries(EXPECTATION_STATUSES.map(status => [status, 0])) as Record<ExpectationStatus, number>,
    byKind: Object.fromEntries(EXPECTATION_KINDS.map(kind => [kind, 0])) as Record<ExpectationKind, number>,
  };
}

/** Counts by status and kind, overdue open items, and mean surprise on resolved items. Missing table → zeros. */
export function summarizeExpectations(source: DatabaseSync | ExpectationsStore, agentId: string, nowMs = Date.now()): ExpectationsSummary {
  const db = source instanceof ExpectationsStore ? source.db : source;
  const summary = emptySummary();
  if (!hasTable(db)) return summary;
  for (const row of db.prepare("SELECT status, kind, COUNT(*) AS n FROM expectations WHERE agent_id=? GROUP BY status, kind").all(agentId)) {
    const n = Number(row.n);
    summary.total += n;
    const status = row.status as ExpectationStatus, kind = row.kind as ExpectationKind;
    if (status in summary.byStatus) summary.byStatus[status] += n;
    if (kind in summary.byKind) summary.byKind[kind] += n;
  }
  const stats = db.prepare(`SELECT
      (SELECT COUNT(*) FROM expectations WHERE agent_id=? AND status='open' AND due_at_ms IS NOT NULL AND due_at_ms<?) AS overdue,
      (SELECT AVG(surprise_score) FROM expectations WHERE agent_id=? AND status!='open' AND surprise_score IS NOT NULL) AS average,
      (SELECT COUNT(*) FROM expectations WHERE agent_id=? AND status!='open' AND surprise_score IS NOT NULL) AS scored`)
    .get(agentId, nowMs, agentId, agentId);
  summary.overdue = Number(stats?.overdue ?? 0);
  summary.resolvedWithSurprise = Number(stats?.scored ?? 0);
  summary.averageSurprise = stats?.average === null || stats?.average === undefined ? null : Number(stats.average);
  return summary;
}

/**
 * Open `path` read-only (never creating it), run `fn`, and close. A missing file yields `fallback`; a DB without
 * the table flows through the helpers' empty results.
 */
export function withReadOnlyExpectations<T>(path: string, fallback: T, fn: (db: DatabaseSync) => T): T {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return fallback;
  const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec("PRAGMA query_only=ON"); return fn(db); }
  finally { db.close(); }
}

export class ExpectationsStore {
  readonly db: DatabaseSync;
  readonly #owned: boolean;

  /** Pass a path to own a connection, or an open `DatabaseSync` to share one (required for fenced atomic commits). */
  constructor(database: string | DatabaseSync, options: { busyTimeoutMs?: number } = {}) {
    this.#owned = typeof database === "string";
    this.db = typeof database === "string"
      ? openMemoryDatabase(database, options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs })
      : database;
    try { ensureExpectationsSchema(this.db); }
    catch (error) { if (this.#owned) this.db.close(); throw error; }
  }

  close(): void { if (this.#owned) this.db.close(); }

  upsertExpectation(input: ExpectationInput): ExpectationUpsertResult { return upsertExpectation(this.db, input); }
  resolveExpectation(input: ResolveExpectationInput): boolean { return resolveExpectation(this.db, input); }
  listExpectations(filter: ExpectationFilter): Expectation[] { return listExpectations(this.db, filter); }
  getExpectation(id: string, agentId: string): Expectation | undefined { return getExpectation(this.db, id, agentId); }
  summarize(agentId: string, nowMs?: number): ExpectationsSummary { return summarizeExpectations(this.db, agentId, nowMs); }
  syncDeterministic(agentId: string, nowMs?: number, options?: DeterministicSyncOptions): DeterministicSyncResult {
    return syncDeterministicExpectations(this.db, agentId, nowMs, options);
  }

  // Read-only helpers for consumers that must not create tables (missing table / read-only DB tolerant).
  static list(db: DatabaseSync, filter: ExpectationFilter): Expectation[] { return listExpectations(db, filter); }
  static get(db: DatabaseSync, id: string, agentId: string): Expectation | undefined { return getExpectation(db, id, agentId); }
  static summarize(db: DatabaseSync, agentId: string, nowMs?: number): ExpectationsSummary { return summarizeExpectations(db, agentId, nowMs); }
  static readOnly<T>(path: string, fallback: T, fn: (db: DatabaseSync) => T): T { return withReadOnlyExpectations(path, fallback, fn); }
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic, zero-model-cost ingestion from Captain's Log blockers and people todos.
// ---------------------------------------------------------------------------------------------------------------

export type DeterministicSyncOptions = {
  /**
   * Auto-expire a mirrored Captain's Log blocker whose topic has not been re-captured within this many minutes, also
   * resolving its linked ledger entries (default `4320` = 72h; `0` = never auto-expire).
   */
  blockerAutoExpireMinutes?: number;
};

export const DEFAULT_BLOCKER_AUTO_EXPIRE_MINUTES = 4320;

export type DeterministicSyncResult = {
  captainsLog: { upserted: number; resolved: number; expired: number; skipped: boolean };
  peopleTodos: { upserted: number; resolved: number; reopened: number; suppressed: number; skipped: boolean };
  /** Open pre-0.20 Steward rows retired because their audience cannot be proven (pooled group/channel, provider-less DM). */
  retired: number;
};

const CAPTAINS_LOG_TOPIC_PREFIX = "captains_log_topic:";
const LEGACY_CAPTAINS_LOG_PREFIX = "captains_log:";
const CAPTAINS_LOG_RESOLVED = "captains_log_resolved";
const CAPTAINS_LOG_EXPIRED = "captains_log_auto_expired";
/** Resolutions that a fresh capture of the same topic may reopen (never an operator's dismissal). */
const CAPTAINS_LOG_REOPENABLE = new Set([CAPTAINS_LOG_RESOLVED, CAPTAINS_LOG_EXPIRED, "steward_sweep"]);
const PEOPLE_TODO_PREFIX = "people_todo:";
const PEOPLE_TODO_RESOLVED = "people_todo_resolved";
const PEOPLE_TODO_SUPPRESSED = "people_todo_suppressed";

/**
 * Administrative People-store todos (directory hygiene, merge/soft-delete review): never user-facing expectations.
 * Production kinds: `soft_delete_review`, `needs_enrichment`, `incomplete_slack_identity`.
 */
const ADMIN_TODO_KIND = /soft[_ -]?delete|review|enrich|incomplete[_ -]?\w*identity|merge|duplicate/iu;
export function isAdministrativePeopleTodo(kind: string): boolean {
  return ADMIN_TODO_KIND.test(kind);
}

/** Recurring captures of one blocker collapse onto this key (case, punctuation and `[BLOCKED]` prefixes ignored). */
export function normalizeBlockerTopic(topic: string): string {
  return topic.normalize("NFKC").toLowerCase().replace(/^(?:\s*\[blocked\]\s*:?\s*)+/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function parseStringArray(text: unknown): string[] {
  return uniqueStrings(parseJson(text, []));
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  return db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`).get(table, column) !== undefined;
}

function evidenceSource(text: unknown): unknown {
  const evidence = parseJson(text, null);
  return isRecord(evidence) ? evidence.source : undefined;
}

/** Every Captain's Log entry an expectation mirrors (topic rows track `entryIds`; pre-0.20 rows one `entryId`). */
function linkedEntryIds(row: Record<string, unknown>): string[] {
  const evidence = parseJson(row.evidence_json, {});
  const ids = isRecord(evidence) ? [...uniqueStrings(evidence.entryIds), ...uniqueStrings([evidence.entryId])] : [];
  return [...new Set(ids.length ? ids : [String(row.source_ref)])];
}

function personInjectable(db: DatabaseSync, hasPeople: boolean, personId: string): boolean {
  if (!hasPeople) return false; // Fail closed: an unverifiable person is never surfaced.
  const row = db.prepare("SELECT status, injection_enabled FROM people WHERE id=?").get(personId);
  return row?.status === "active" && Number(row.injection_enabled) === 1;
}

function todoFields(kind: string, contextJson: unknown) {
  const context = parseJson(contextJson, {});
  const ctx = isRecord(context) ? context : {};
  const text = (...keys: string[]) => { for (const key of keys) { const value = optionalText(ctx[key]); if (value) return value; } return null; };
  const personId = text("personId", "person_id");
  const label = text("personName", "displayName", "name", "label", "subjectLabel");
  const readableKind = oneLine(kind.replace(/[_-]+/gu, " ")) || "people todo";
  const summary = text("summary", "title", "description") ??
    `People todo: ${readableKind}${label ? ` (${label})` : personId ? ` (person ${personId})` : ""}`;
  const expectedState = text("expectedState", "expected_state") ?? `The "${readableKind}" people todo is resolved`;
  const senderIds = [...new Set(["senderId", "externalId"].flatMap(key => { const value = text(key); return value ? [value] : []; }))];
  return { personId, label, summary, expectedState, senderIds };
}

type BlockerEntry = {
  id: string; topic: string; summary: string; labels: string[]; natives: string[]; sessionRefs: string[]; day: string; capturedAtMs: number;
};

function syncCaptainsLog(db: DatabaseSync, agentId: string, nowMs: number, expireMinutes: number, result: DeterministicSyncResult): void {
  result.captainsLog.skipped = false;
  const native = columnExists(db, "captains_log_entries", "native_channels_json") ? "native_channels_json" : "'[]'";
  const groups = new Map<string, BlockerEntry[]>();
  for (const row of db.prepare(`SELECT id, topic, summary, channels_json, ${native} AS native_channels_json, session_refs_json,
      captured_at_ms, day FROM captains_log_entries WHERE agent_id=? AND blocked=1 AND resolved_at_ms IS NULL
      ORDER BY captured_at_ms, id`).all(agentId)) {
    const entry: BlockerEntry = {
      id: String(row.id), topic: oneLine(String(row.topic)), summary: oneLine(String(row.summary)),
      labels: parseStringArray(row.channels_json), natives: parseStringArray(row.native_channels_json),
      sessionRefs: parseStringArray(row.session_refs_json), day: String(row.day), capturedAtMs: Number(row.captured_at_ms),
    };
    const key = normalizeBlockerTopic(entry.topic) || normalizeBlockerTopic(entry.summary) || `entry ${entry.id}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  const byKey = db.prepare("SELECT * FROM expectations WHERE agent_id=? AND dedup_key=?");
  for (const [topicKey, entries] of groups) {
    const dedupKey = CAPTAINS_LOG_TOPIC_PREFIX + topicKey;
    // Pre-0.20 rows were keyed per entry: adopt the first as the topic row, retire the rest as merged duplicates.
    const legacy = entries.flatMap(entry => {
      const row = byKey.get(agentId, LEGACY_CAPTAINS_LOG_PREFIX + entry.id);
      return row && row.status === "open" ? [row] : [];
    });
    let existing = byKey.get(agentId, dedupKey);
    if (!existing && legacy.length) {
      db.prepare("UPDATE expectations SET dedup_key=? WHERE id=?").run(dedupKey, String(legacy[0]!.id));
      existing = byKey.get(agentId, dedupKey);
    }
    for (const duplicate of legacy) {
      if (String(duplicate.id) === String(existing?.id)) continue;
      resolveExpectation(db, { id: String(duplicate.id), agentId, status: "dismissed", resolutionNote: "Merged into the recurring topic blocker",
        resolutionEvidence: { source: "captains_log_merged", into: dedupKey }, resolvedAtMs: nowMs });
    }
    const latest = entries.at(-1)!;
    const previous = existing ? linkedEntryIds(existing) : [];
    const entryIds = [...new Set([...previous, ...entries.map(entry => entry.id)])];
    const labels = [...new Set([...latest.labels, ...entries.flatMap(entry => entry.labels)])];
    const natives = [...new Set(entries.flatMap(entry => entry.natives))];
    // A fresh capture after a deterministic or Steward resolution is the blocker resurfacing; an operator dismissal stands.
    const reopen = !!existing && existing.status !== "open" && CAPTAINS_LOG_REOPENABLE.has(String(evidenceSource(existing.resolution_evidence_json))) &&
      entries.some(entry => entry.capturedAtMs > Number(existing.resolved_at_ms ?? Infinity));
    const upsert = upsertExpectation(db, {
      agentId, dedupKey, kind: "blocker", sourceKind: "captains_log", sourceRef: latest.id,
      audienceKey: WORKSPACE_AUDIENCE, chatType: "workspace", channel: labels[0] ?? null,
      summary: latest.topic || latest.summary || "Captain's Log blocker", expectedState: latest.summary || latest.topic || "Blocker resolved",
      // Native ids make `channel_match` fire on real hook contexts (which carry ids, not `#labels`).
      triggerSpec: { channels: [...labels, ...natives] },
      evidence: { source: "captains_log", topicKey, entryIds, entryId: latest.id, day: latest.day, capturedAtMs: latest.capturedAtMs,
        lastCapturedAtMs: latest.capturedAtMs, sessionRefs: [...new Set(entries.flatMap(entry => entry.sessionRefs))] },
      reopen, nowMs,
    });
    if (upsert.action !== "unchanged") result.captainsLog.upserted++;
  }

  const linked = db.prepare(`SELECT id, captured_at_ms, resolved_at_ms, resolution_note FROM captains_log_entries
    WHERE agent_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY captured_at_ms, id`);
  const closeEntry = db.prepare(`UPDATE captains_log_entries SET resolved_at_ms=?, resolution_note=?
    WHERE id=? AND agent_id=? AND blocked=1 AND resolved_at_ms IS NULL`);
  const expireMs = expireMinutes * 60_000;
  for (const row of db.prepare("SELECT * FROM expectations WHERE agent_id=? AND status='open' AND source_kind='captains_log'").all(agentId)) {
    const entries = linked.all(agentId, JSON.stringify(linkedEntryIds(row)));
    const open = entries.filter(entry => entry.resolved_at_ms === null);
    const resolved = entries.filter(entry => entry.resolved_at_ms !== null)
      .sort((a, b) => Number(a.resolved_at_ms) - Number(b.resolved_at_ms));
    if (!open.length && resolved.length) {
      const last = resolved.at(-1)!;
      if (resolveExpectation(db, {
        id: String(row.id), agentId, status: "kept", surpriseScore: 0,
        resolutionNote: nullableText(last.resolution_note) ?? "Captain's Log blocker resolved",
        resolutionEvidence: { source: CAPTAINS_LOG_RESOLVED, entryId: String(last.id), entryIds: resolved.map(entry => String(entry.id)) },
        resolvedAtMs: Number(last.resolved_at_ms),
      })) result.captainsLog.resolved++;
      continue;
    }
    if (expireMs <= 0 || !open.length) continue;
    const lastCapturedAtMs = Math.max(...entries.map(entry => Number(entry.captured_at_ms)));
    if (lastCapturedAtMs > nowMs - expireMs) continue;
    const note = `Auto-expired: not re-captured by Captain's Log within ${expireMinutes} minutes`;
    if (resolveExpectation(db, {
      id: String(row.id), agentId, status: "expired",
      resolutionNote: note,
      resolutionEvidence: { source: CAPTAINS_LOG_EXPIRED, entryIds: open.map(entry => String(entry.id)), lastCapturedAtMs },
      resolvedAtMs: nowMs,
    })) {
      for (const entry of open) closeEntry.run(nowMs, note, String(entry.id), agentId);
      result.captainsLog.expired++;
    }
  }
}

function syncPeopleTodos(db: DatabaseSync, agentId: string, nowMs: number, result: DeterministicSyncResult): void {
  result.peopleTodos.skipped = false;
  const hasPeople = tableExists(db, "people");
  for (const row of db.prepare(`SELECT t.id, t.kind, t.context_json, t.first_seen_at, t.last_seen_at, t.occurrence_count,
        e.id AS expectation_id, e.status AS expectation_status, e.resolution_evidence_json AS resolution_evidence
      FROM people_todos t LEFT JOIN expectations e ON e.agent_id=? AND e.dedup_key = '${PEOPLE_TODO_PREFIX}' || t.id
      WHERE t.status='open' ORDER BY t.first_seen_at, t.id`).all(agentId)) {
    const kind = String(row.kind);
    const fields = todoFields(kind, row.context_json);
    // Admin hygiene todos and todos about a soft-deleted / injection-disabled person never become expectations.
    const reason = isAdministrativePeopleTodo(kind) ? "administrative"
      : fields.personId && !personInjectable(db, hasPeople, fields.personId) ? "person_not_injectable" : undefined;
    if (reason) {
      if (row.expectation_status === "open" && resolveExpectation(db, {
        id: String(row.expectation_id), agentId, status: "dismissed", resolutionNote: `People todo suppressed (${reason})`,
        resolutionEvidence: { source: PEOPLE_TODO_SUPPRESSED, todoId: String(row.id), reason }, resolvedAtMs: nowMs,
      })) result.peopleTodos.suppressed++;
      continue;
    }
    // A todo that reopened at its source (or became injectable again) after our deterministic resolution is live
    // again; a Steward or operator resolution is preserved.
    const source = evidenceSource(row.resolution_evidence);
    const priorAuto = row.expectation_status !== null && row.expectation_status !== "open" &&
      (source === PEOPLE_TODO_RESOLVED || source === PEOPLE_TODO_SUPPRESSED);
    const upsert = upsertExpectation(db, {
      agentId, dedupKey: PEOPLE_TODO_PREFIX + String(row.id), kind: "todo", sourceKind: "people_todo", sourceRef: String(row.id),
      audienceKey: WORKSPACE_AUDIENCE, chatType: "workspace", subjectPersonId: fields.personId, subjectLabel: fields.label,
      summary: fields.summary, expectedState: fields.expectedState,
      triggerSpec: { ...(fields.personId ? { personIds: [fields.personId] } : {}), ...(fields.senderIds.length ? { senderIds: fields.senderIds } : {}) },
      evidence: { source: "people_todo", todoId: String(row.id), todoKind: kind, firstSeenAt: String(row.first_seen_at) },
      reopen: priorAuto, nowMs,
    });
    if (upsert.action === "reopened") result.peopleTodos.reopened++;
    else if (upsert.action !== "unchanged") result.peopleTodos.upserted++;
  }
  for (const row of db.prepare(`SELECT e.id AS id, t.id AS todo_id, t.resolved_at AS resolved_at, t.resolution_note AS note
      FROM expectations e JOIN people_todos t ON e.dedup_key = '${PEOPLE_TODO_PREFIX}' || t.id
      WHERE e.agent_id=? AND e.status='open' AND e.source_kind='people_todo' AND t.status='resolved'`).all(agentId)) {
    const parsed = typeof row.resolved_at === "string" ? Date.parse(row.resolved_at) : Number.NaN;
    if (resolveExpectation(db, {
      id: String(row.id), agentId, status: "kept", surpriseScore: 0,
      resolutionNote: nullableText(row.note) ?? "People todo resolved",
      resolutionEvidence: { source: PEOPLE_TODO_RESOLVED, todoId: String(row.todo_id) },
      resolvedAtMs: Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : nowMs,
    })) result.peopleTodos.resolved++;
  }
}

/**
 * Mirror open `[BLOCKED]` Captain's Log entries (one row per normalized topic) and open, user-facing people todos into
 * `expectations`; auto-resolve mirrored rows once their source resolves, auto-expire stale blockers, and retire pre-0.20
 * Steward rows whose audience cannot be proven. Missing source tables are skipped. Runs in one transaction (or the
 * caller's, e.g. a `WorkStore` fence).
 */
export function syncDeterministicExpectations(db: DatabaseSync, agentId: string, nowMs = Date.now(),
  options: DeterministicSyncOptions = {}): DeterministicSyncResult {
  requireText(agentId, "agentId");
  const expireMinutes = options.blockerAutoExpireMinutes ?? DEFAULT_BLOCKER_AUTO_EXPIRE_MINUTES;
  if (!Number.isSafeInteger(expireMinutes) || expireMinutes < 0) throw new RangeError("blockerAutoExpireMinutes must be a non-negative integer");
  const result: DeterministicSyncResult = {
    captainsLog: { upserted: 0, resolved: 0, expired: 0, skipped: true },
    peopleTodos: { upserted: 0, resolved: 0, reopened: 0, suppressed: 0, skipped: true },
    retired: 0,
  };
  ensureExpectationsSchema(db);
  return atomically(db, () => {
    // 0.19 pooled channel/group sessions into `workspace` and keyed DMs without a provider: fail closed.
    result.retired = Number(db.prepare(`UPDATE expectations SET status='dismissed', resolution_note=?, resolution_evidence_json=?,
        resolved_at_ms=?, updated_at_ms=?
      WHERE agent_id=? AND status='open' AND source_kind='session_steward' AND (
        (audience_key='workspace' AND chat_type!='workspace')
        OR (chat_type IN ('channel', 'group', 'direct') AND audience_key NOT GLOB chat_type || ':?*:?*:?*'))`)
      .run("Retired: audience could not be proven for this conversation", JSON.stringify({ source: "audience_retired" }),
        nowMs, nowMs, agentId).changes);
    if (tableExists(db, "captains_log_entries")) syncCaptainsLog(db, agentId, nowMs, expireMinutes, result);
    if (tableExists(db, "people_todos")) syncPeopleTodos(db, agentId, nowMs, result);
    return result;
  });
}
