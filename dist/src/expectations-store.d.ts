import { DatabaseSync } from "node:sqlite";
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
export declare const EXPECTATIONS_COMPONENT = "expectations";
export declare const EXPECTATIONS_SCHEMA_VERSION = 1;
export declare const EXPECTATION_KINDS: readonly ["commitment", "prediction", "blocker", "decision_outcome", "todo"];
export declare const EXPECTATION_SOURCE_KINDS: readonly ["captains_log", "people_todo", "session_steward", "manual"];
export declare const EXPECTATION_CHAT_TYPES: readonly ["channel", "group", "direct", "workspace"];
export declare const EXPECTATION_STATUSES: readonly ["open", "kept", "broken", "right", "wrong", "expired", "dismissed"];
export declare const RESOLVED_EXPECTATION_STATUSES: readonly ["kept", "broken", "right", "wrong", "expired", "dismissed"];
export type ExpectationKind = typeof EXPECTATION_KINDS[number];
export type ExpectationSourceKind = typeof EXPECTATION_SOURCE_KINDS[number];
export type ExpectationChatType = typeof EXPECTATION_CHAT_TYPES[number];
export type ExpectationStatus = typeof EXPECTATION_STATUSES[number];
export type ResolvedExpectationStatus = typeof RESOLVED_EXPECTATION_STATUSES[number];
/**
 * Workspace-wide audience. Reserved for explicitly workspace-approved sources (Captain's Log workspace blockers, active
 * people todos, operator items); a channel or group conversation is NEVER pooled into it.
 */
export declare const WORKSPACE_AUDIENCE = "workspace";
/**
 * Strict per-person DM audience `direct:<provider>:<accountId>:<senderId>` (provider lowercased). Fails closed: any
 * missing part yields `undefined`, so an unknown sender or provider never collapses into a shared key.
 */
export declare function directAudienceKey(provider: unknown, accountId: unknown, senderId: unknown): string | undefined;
/**
 * One shared conversation's audience: `channel:<provider>:<accountId>:<nativeChannelId>` or
 * `group:<provider>:<accountId>:<nativeChannelId>` (provider and channel id lowercased, thread suffixes dropped: hook
 * contexts carry a lowercased conversation id). Fails closed with `undefined` when any part is missing.
 */
export declare function conversationAudienceKey(chatType: "channel" | "group", provider: unknown, accountId: unknown, nativeChannelId: unknown): string | undefined;
export declare const EXPECTATIONS_SCHEMA = "CREATE TABLE IF NOT EXISTS expectations (\n  id TEXT PRIMARY KEY,\n  agent_id TEXT NOT NULL,\n  dedup_key TEXT NOT NULL,\n  kind TEXT NOT NULL CHECK(kind IN ('commitment', 'prediction', 'blocker', 'decision_outcome', 'todo')),\n  source_kind TEXT NOT NULL CHECK(source_kind IN ('captains_log', 'people_todo', 'session_steward', 'manual')),\n  source_ref TEXT NOT NULL,\n  audience_key TEXT NOT NULL,\n  chat_type TEXT NOT NULL CHECK(chat_type IN ('channel', 'group', 'direct', 'workspace')),\n  subject_person_id TEXT,\n  subject_label TEXT,\n  channel TEXT,\n  summary TEXT NOT NULL,\n  expected_state TEXT NOT NULL,\n  due_at_ms INTEGER,\n  trigger_spec_json TEXT NOT NULL CHECK(json_valid(trigger_spec_json)),\n  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),\n  status TEXT NOT NULL CHECK(status IN ('open', 'kept', 'broken', 'right', 'wrong', 'expired', 'dismissed')),\n  surprise_score REAL CHECK(surprise_score IS NULL OR (surprise_score >= 0.0 AND surprise_score <= 1.0)),\n  resolution_note TEXT,\n  resolution_evidence_json TEXT CHECK(resolution_evidence_json IS NULL OR json_valid(resolution_evidence_json)),\n  created_at_ms INTEGER NOT NULL,\n  updated_at_ms INTEGER NOT NULL,\n  resolved_at_ms INTEGER,\n  UNIQUE(agent_id, dedup_key)\n) STRICT;\nCREATE INDEX IF NOT EXISTS idx_expectations_agent_status_due ON expectations(agent_id, status, due_at_ms);\nCREATE INDEX IF NOT EXISTS idx_expectations_agent_audience ON expectations(agent_id, status, audience_key);\nCREATE INDEX IF NOT EXISTS idx_expectations_agent_channel ON expectations(agent_id, status, channel);\nCREATE INDEX IF NOT EXISTS idx_expectations_agent_person ON expectations(agent_id, status, subject_person_id);";
export type ExpectationTriggerSpec = {
    channels?: string[];
    personIds?: string[];
    senderIds?: string[];
    keywords?: string[];
    dueLeadMs?: number;
};
export type Expectation = {
    id: string;
    agentId: string;
    dedupKey: string;
    kind: ExpectationKind;
    sourceKind: ExpectationSourceKind;
    sourceRef: string;
    audienceKey: string;
    chatType: ExpectationChatType;
    subjectPersonId: string | null;
    subjectLabel: string | null;
    channel: string | null;
    summary: string;
    expectedState: string;
    dueAtMs: number | null;
    triggerSpec: ExpectationTriggerSpec;
    evidence: unknown;
    status: ExpectationStatus;
    surpriseScore: number | null;
    resolutionNote: string | null;
    resolutionEvidence: unknown;
    createdAtMs: number;
    updatedAtMs: number;
    resolvedAtMs: number | null;
};
export type ExpectationInput = {
    agentId: string;
    dedupKey: string;
    kind: ExpectationKind;
    sourceKind: ExpectationSourceKind;
    sourceRef: string;
    audienceKey: string;
    chatType: ExpectationChatType;
    summary: string;
    expectedState: string;
    subjectPersonId?: string | null;
    subjectLabel?: string | null;
    channel?: string | null;
    dueAtMs?: number | null;
    triggerSpec?: ExpectationTriggerSpec;
    evidence?: unknown;
    /** Explicitly reopen a resolved row (clears its resolution). Without it a resolved status is preserved. */
    reopen?: boolean;
    nowMs?: number;
};
export type ExpectationUpsertResult = {
    action: "inserted" | "updated" | "reopened" | "unchanged";
    expectation: Expectation;
};
export type ResolveExpectationInput = {
    id: string;
    agentId: string;
    status: ResolvedExpectationStatus;
    surpriseScore?: number | null;
    resolutionNote?: string | null;
    resolutionEvidence?: unknown;
    resolvedAtMs?: number;
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
export declare function redactSecrets(text: string): string;
/** Normalize a caller- or model-provided trigger spec, keeping only well-formed fields. */
export declare function normalizeTriggerSpec(value: unknown): ExpectationTriggerSpec;
/** Create the table and register `memory_schema('expectations', 1)`. Idempotent; refuses unknown future versions. */
export declare function ensureExpectationsSchema(db: DatabaseSync): void;
/** Upsert by `(agent_id, dedup_key)`, creating the table on first use. */
export declare function upsertExpectation(db: DatabaseSync, input: ExpectationInput): ExpectationUpsertResult;
/** Resolve an `open` expectation once. Returns false when it is missing, belongs to another agent, or is already resolved. */
export declare function resolveExpectation(db: DatabaseSync, input: ResolveExpectationInput): boolean;
/** Due-first (undated last), then oldest first. Missing table → `[]`. Safe on read-only connections. */
export declare function listExpectations(db: DatabaseSync, filter: ExpectationFilter): Expectation[];
export declare function getExpectation(db: DatabaseSync, id: string, agentId: string): Expectation | undefined;
/** Counts by status and kind, overdue open items, and mean surprise on resolved items. Missing table → zeros. */
export declare function summarizeExpectations(source: DatabaseSync | ExpectationsStore, agentId: string, nowMs?: number): ExpectationsSummary;
/**
 * Open `path` read-only (never creating it), run `fn`, and close. A missing file yields `fallback`; a DB without
 * the table flows through the helpers' empty results.
 */
export declare function withReadOnlyExpectations<T>(path: string, fallback: T, fn: (db: DatabaseSync) => T): T;
export declare class ExpectationsStore {
    #private;
    readonly db: DatabaseSync;
    /** Pass a path to own a connection, or an open `DatabaseSync` to share one (required for fenced atomic commits). */
    constructor(database: string | DatabaseSync, options?: {
        busyTimeoutMs?: number;
    });
    close(): void;
    upsertExpectation(input: ExpectationInput): ExpectationUpsertResult;
    resolveExpectation(input: ResolveExpectationInput): boolean;
    listExpectations(filter: ExpectationFilter): Expectation[];
    getExpectation(id: string, agentId: string): Expectation | undefined;
    summarize(agentId: string, nowMs?: number): ExpectationsSummary;
    syncDeterministic(agentId: string, nowMs?: number, options?: DeterministicSyncOptions): DeterministicSyncResult;
    static list(db: DatabaseSync, filter: ExpectationFilter): Expectation[];
    static get(db: DatabaseSync, id: string, agentId: string): Expectation | undefined;
    static summarize(db: DatabaseSync, agentId: string, nowMs?: number): ExpectationsSummary;
    static readOnly<T>(path: string, fallback: T, fn: (db: DatabaseSync) => T): T;
}
export type DeterministicSyncOptions = {
    /**
     * Auto-expire a mirrored Captain's Log blocker whose topic has not been re-captured within this many minutes, also
     * resolving its linked ledger entries (default `4320` = 72h; `0` = never auto-expire).
     */
    blockerAutoExpireMinutes?: number;
};
export declare const DEFAULT_BLOCKER_AUTO_EXPIRE_MINUTES = 4320;
export type DeterministicSyncResult = {
    captainsLog: {
        upserted: number;
        resolved: number;
        expired: number;
        skipped: boolean;
    };
    peopleTodos: {
        upserted: number;
        resolved: number;
        reopened: number;
        suppressed: number;
        skipped: boolean;
    };
    /** Open pre-0.20 Steward rows retired because their audience cannot be proven (pooled group/channel, provider-less DM). */
    retired: number;
};
export declare function isAdministrativePeopleTodo(kind: string): boolean;
/** Recurring captures of one blocker collapse onto this key (case, punctuation and `[BLOCKED]` prefixes ignored). */
export declare function normalizeBlockerTopic(topic: string): string;
/**
 * Mirror open `[BLOCKED]` Captain's Log entries (one row per normalized topic) and open, user-facing people todos into
 * `expectations`; auto-resolve mirrored rows once their source resolves, auto-expire stale blockers, and retire pre-0.20
 * Steward rows whose audience cannot be proven. Missing source tables are skipped. Runs in one transaction (or the
 * caller's, e.g. a `WorkStore` fence).
 */
export declare function syncDeterministicExpectations(db: DatabaseSync, agentId: string, nowMs?: number, options?: DeterministicSyncOptions): DeterministicSyncResult;
