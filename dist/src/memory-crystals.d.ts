import { DatabaseSync } from "node:sqlite";
/**
 * Memory Crystals: durable, citation-anchored syntheses of many memory chunks.
 *
 * - `memory_crystals`: one row per crystal. `stm` crystals may go stale (`stale_after_ms`); `ltm` crystals never do.
 *   `audience_key` is fixed by the first write: a later revision can never widen who may see a crystal.
 * - `memory_crystal_members`: the exact evidence chunks (doc hash + chunk span + quote sha256) the current revision
 *   was synthesized from. Replaced wholesale on every revision.
 * - `core_memories`: retroactive anchors. "A memory is core if and only if it changed a durable structure": when a
 *   crystal's title/summary changes, the evidence that was new to that revision is recorded here. Dedup per
 *   `(agent_id, source_kind, target_id, corpus, source_path, doc_hash)` so retries never duplicate.
 *
 * Read helpers never create or migrate a database; they return empty results for a missing file or table.
 */
export declare const MEMORY_CRYSTALS_COMPONENT = "memory_crystals";
export declare const MEMORY_CRYSTALS_SCHEMA_VERSION = 1;
/** Shared contract with Track P1-C (Steward crystallizer). Do not change without bumping the schema version. */
export declare const MEMORY_CRYSTALS_SCHEMA = "CREATE TABLE IF NOT EXISTS memory_crystals (\n  id TEXT PRIMARY KEY,\n  agent_id TEXT NOT NULL,\n  tier TEXT NOT NULL CHECK(tier IN ('stm', 'ltm')),\n  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),\n  title TEXT NOT NULL,\n  summary TEXT NOT NULL,\n  audience_key TEXT NOT NULL,\n  corpora_json TEXT NOT NULL CHECK(json_valid(corpora_json)),\n  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),\n  cluster_id TEXT,\n  input_digest TEXT NOT NULL,\n  recipe_hash TEXT NOT NULL DEFAULT 'default',\n  brightness REAL NOT NULL DEFAULT 0.5,\n  hit_count INTEGER NOT NULL DEFAULT 0 CHECK(hit_count >= 0),\n  created_ms INTEGER NOT NULL,\n  verified_ms INTEGER NOT NULL,\n  stale_after_ms INTEGER\n) STRICT;\n\nCREATE TABLE IF NOT EXISTS memory_crystal_members (\n  crystal_id TEXT NOT NULL REFERENCES memory_crystals(id) ON DELETE CASCADE,\n  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),\n  corpus TEXT NOT NULL,\n  source_path TEXT NOT NULL,\n  doc_hash TEXT NOT NULL,\n  chunk_pos INTEGER NOT NULL CHECK(chunk_pos >= 0),\n  chunk_len INTEGER NOT NULL CHECK(chunk_len > 0),\n  quote_sha256 TEXT NOT NULL,\n  observed_ms INTEGER,\n  PRIMARY KEY (crystal_id, ordinal)\n) STRICT;\n\nCREATE TABLE IF NOT EXISTS core_memories (\n  id TEXT PRIMARY KEY,\n  agent_id TEXT NOT NULL,\n  source_kind TEXT NOT NULL CHECK(source_kind IN ('crystal_revision', 'dossier_revision', 'voltaire_shift', 'expectation_surprise')),\n  target_id TEXT NOT NULL,\n  corpus TEXT NOT NULL,\n  source_path TEXT NOT NULL,\n  doc_hash TEXT,\n  quote_excerpt TEXT NOT NULL,\n  reason TEXT NOT NULL,\n  created_ms INTEGER NOT NULL\n) STRICT;\n\nCREATE INDEX IF NOT EXISTS idx_memory_crystals_agent_status_tier ON memory_crystals(agent_id, status, tier, brightness);\nCREATE INDEX IF NOT EXISTS idx_memory_crystals_agent_audience ON memory_crystals(agent_id, status, audience_key);\nCREATE INDEX IF NOT EXISTS idx_memory_crystals_agent_digest ON memory_crystals(agent_id, input_digest);\nCREATE INDEX IF NOT EXISTS idx_core_memories_agent_time ON core_memories(agent_id, created_ms);\nCREATE INDEX IF NOT EXISTS idx_core_memories_agent_source ON core_memories(agent_id, corpus, source_path);";
export declare const CRYSTAL_TIERS: readonly ["stm", "ltm"];
export declare const CRYSTAL_STATUSES: readonly ["active", "retired"];
export declare const CORE_MEMORY_SOURCE_KINDS: readonly ["crystal_revision", "dossier_revision", "voltaire_shift", "expectation_surprise"];
export type CrystalTier = typeof CRYSTAL_TIERS[number];
export type CrystalStatus = typeof CRYSTAL_STATUSES[number];
export type CoreMemorySourceKind = typeof CORE_MEMORY_SOURCE_KINDS[number];
/** Default `brightness` for a new crystal (schema default). */
export declare const DEFAULT_CRYSTAL_BRIGHTNESS = 0.5;
/** Default minimum overlap coefficient between the turn and a crystal's `title + summary` tokens. */
export declare const DEFAULT_CRYSTAL_MATCH_MIN_TOKEN_OVERLAP = 0.35;
/** Default minimum shared meaningful tokens: one shared word is never enough to fire. */
export declare const DEFAULT_CRYSTAL_MATCH_MIN_SHARED_TOKENS = 2;
/** Default additive rank boost for `ltm` crystals: enough to break ties, too small to beat a clearly better `stm` match. */
export declare const DEFAULT_CRYSTAL_LTM_RANK_BOOST = 0.01;
export type CrystalMemberInput = {
    corpus: string;
    sourcePath: string;
    docHash: string;
    chunkPos: number;
    chunkLen: number;
    /** Lowercase/uppercase hex sha256 of the exact quoted chunk text (stored lowercase). */
    quoteSha256: string;
    observedMs?: number | null;
    /**
     * Optional short excerpt of the quoted text. Never persisted on the member row (the contract stores only the hash);
     * used as `core_memories.quote_excerpt` when this member triggers a revision. Redacted before writing.
     */
    quoteExcerpt?: string;
};
export type CrystalMember = {
    ordinal: number;
    corpus: string;
    sourcePath: string;
    docHash: string;
    chunkPos: number;
    chunkLen: number;
    quoteSha256: string;
    observedMs: number | null;
};
export type MemoryCrystal = {
    id: string;
    agentId: string;
    tier: CrystalTier;
    revision: number;
    title: string;
    summary: string;
    audienceKey: string;
    corpora: string[];
    status: CrystalStatus;
    clusterId: string | null;
    inputDigest: string;
    recipeHash: string;
    brightness: number;
    hitCount: number;
    createdMs: number;
    verifiedMs: number;
    staleAfterMs: number | null;
    /** Present on `getCrystal` / `upsertCrystal` results (and matcher results with `includeMembers`). */
    members?: CrystalMember[];
};
/** Evidence the caller asserts triggered a revision (overrides the computed "new doc hash" set). */
export type CrystalTriggeringEvidence = {
    corpus: string;
    sourcePath: string;
    docHash?: string | null;
    quoteExcerpt?: string;
    /** Per-anchor reason; falls back to the revision reason. */
    reason?: string;
};
export type UpsertCrystalInput = {
    id: string;
    agentId: string;
    /** Tier for a NEW crystal (default `stm`). Ignored on existing crystals: use `promoteCrystalToLtm`. */
    tier?: CrystalTier;
    title: string;
    summary: string;
    /** Audience for a NEW crystal. Locked afterwards: a different value on an existing crystal is ignored. */
    audienceKey: string;
    /** Corpora the crystal draws on. Every member's corpus is always added (the ACL must cover all evidence). */
    corpora: readonly string[];
    /** At least one member is required. Ordinals follow array order. */
    members: readonly CrystalMemberInput[];
    /** Fingerprint of the crystallizer's inputs; unchanged digest = a pure re-verification. */
    inputDigest: string;
    clusterId?: string | null;
    recipeHash?: string;
    /** `[0, 1]`. New crystals default to 0.5; existing crystals keep theirs when omitted. */
    brightness?: number;
    /** `stm` expiry (epoch ms). Ignored (always `NULL`) for `ltm`. Omitted on an update = keep the current value. */
    staleAfterMs?: number | null;
    /** Explicit evidence that caused this revision; when non-empty it replaces the computed new-doc-hash anchors. */
    triggeringMembers?: readonly CrystalTriggeringEvidence[];
    /** Why the crystal changed (stored on each core memory). */
    revisionReason?: string;
    nowMs?: number;
};
export type UpsertCrystalAction = "created" | "verified" | "refreshed" | "revised" | "ignored_retired";
export type UpsertCrystalResult = {
    /**
     * - `created`: new crystal.
     * - `verified`: same `inputDigest`; `verified_ms` / brightness / staleness touched, revision unchanged.
     * - `refreshed`: digest changed but title and summary did not: members replaced, no revision bump, no core memory.
     * - `revised`: title or summary changed: revision bumped, members replaced, core memories recorded.
     * - `ignored_retired`: the id names a retired crystal; nothing was written.
     */
    action: UpsertCrystalAction;
    crystal: MemoryCrystal;
    /** Core-memory anchors newly recorded by this call (retries that dedup are not counted). */
    coreMemoriesAdded: CoreMemory[];
    /** True when the caller passed an `audienceKey` different from the locked one (it was ignored). */
    audienceLocked: boolean;
};
export type CoreMemory = {
    id: string;
    agentId: string;
    sourceKind: CoreMemorySourceKind;
    targetId: string;
    corpus: string;
    sourcePath: string;
    docHash: string | null;
    quoteExcerpt: string;
    reason: string;
    createdMs: number;
};
export type RecordCoreMemoryInput = {
    agentId: string;
    sourceKind: CoreMemorySourceKind;
    targetId: string;
    corpus: string;
    sourcePath: string;
    docHash?: string | null;
    quoteExcerpt: string;
    reason: string;
    nowMs?: number;
};
export type RecordCoreMemoryResult = {
    recorded: boolean;
    coreMemory: CoreMemory;
};
export type ListCrystalsFilter = {
    agentId: string;
    status?: CrystalStatus;
    tier?: CrystalTier;
    audienceKey?: string;
    /** `0` or omitted = unlimited. */
    limit?: number;
};
export type ListCoreMemoriesFilter = {
    agentId: string;
    sourceKind?: CoreMemorySourceKind;
    targetId?: string;
    /** `0` or omitted = unlimited. */
    limit?: number;
};
export type MemoryCrystalsSummary = {
    total: number;
    byTier: Record<CrystalTier, number>;
    byStatus: Record<CrystalStatus, number>;
    /** Active crystals per tier (what the whisperer can actually surface, before ACL/staleness). */
    activeByTier: Record<CrystalTier, number>;
    coreMemoriesCount: number;
    coreMemoriesBySourceKind: Record<CoreMemorySourceKind, number>;
};
export type CrystalMatchQuery = {
    agentId: string;
    /** The current user turn (or any text) to match against crystal `title + summary`. */
    queryText: string;
    /** Exact audience keys the caller may see. Empty = nothing matches. */
    audienceKeys: readonly string[];
    /** Every corpus a crystal draws on must be in this set. Empty = nothing matches. */
    allowedCorpora: readonly string[];
    /** Minimum overlap coefficient in `[0, 1]` (default 0.35). */
    minTokenOverlap?: number;
    /** Minimum shared meaningful tokens (default 2; `0` is clamped to 1). */
    minSharedTokens?: number;
    /** Maximum matches returned; `0` or omitted = unlimited. */
    maxResults?: number;
    /** Staleness clock (default `Date.now()`). */
    nowMs?: number;
    /** Additive rank boost for `ltm` (default 0.01). */
    ltmRankBoost?: number;
    /** Attach `members` to each matched crystal (one extra indexed read per match). Default false. */
    includeMembers?: boolean;
};
export type CrystalMatch = {
    crystal: MemoryCrystal;
    /** Final rank score: `matchScore * (0.7 + 0.3 * clamp(brightness)) + (ltm ? ltmRankBoost : 0)`. */
    score: number;
    /** Raw overlap coefficient `|shared| / min(|query tokens|, |crystal tokens|)`. */
    matchScore: number;
    sharedTokens: number;
};
/** Create the three tables + indexes and register `memory_schema('memory_crystals', 1)`. Idempotent; refuses unknown versions. */
export declare function ensureMemoryCrystalsSchema(db: DatabaseSync): void;
/**
 * Open `path` read-only (never creating or migrating it), run `fn`, and close. A missing/non-regular file or an open
 * failure yields `fallback`; a DB without the tables flows through the read helpers' empty results.
 */
export declare function withReadOnlyMemoryCrystals<T>(path: string, fallback: T, fn: (db: DatabaseSync) => T): T;
type DbSource = string | DatabaseSync | MemoryCrystalsStore;
/**
 * Record a retroactive core-memory anchor. Idempotent per `(agent_id, source_kind, target_id, corpus, source_path,
 * doc_hash)`: a retry returns the existing row with `recorded: false`. Creates the schema on first use.
 */
export declare function recordCoreMemory(db: DatabaseSync, input: RecordCoreMemoryInput): RecordCoreMemoryResult;
/** Newest first. Missing table → `[]`. Safe on read-only connections. */
export declare function listCoreMemories(db: DatabaseSync, filter: ListCoreMemoriesFilter): CoreMemory[];
/** Crystal with members, or `undefined` when missing, owned by another agent, or the table is absent. */
export declare function getCrystal(db: DatabaseSync, id: string, agentId: string): MemoryCrystal | undefined;
/** Brightest first, then most recently verified. Missing table → `[]`. Safe on read-only connections. */
export declare function listCrystals(db: DatabaseSync, filter: ListCrystalsFilter): MemoryCrystal[];
/**
 * Create, re-verify, refresh or revise a crystal (see `UpsertCrystalResult.action`). Atomic; joins a caller's open
 * transaction. The audience of an existing crystal is never changed. Creates the schema on first use.
 */
export declare function upsertCrystal(db: DatabaseSync, input: UpsertCrystalInput): UpsertCrystalResult;
/** Promote an active `stm` crystal to `ltm` (clears `stale_after_ms`). False when missing, retired, or already `ltm`. */
export declare function promoteCrystalToLtm(db: DatabaseSync, id: string, agentId: string, nowMs?: number): boolean;
/**
 * Retire an active crystal (it stops matching; members and core memories are kept for provenance). False when missing
 * or already retired. `nowMs` is accepted for API symmetry; the schema has no retirement timestamp column.
 */
export declare function retireCrystal(db: DatabaseSync, id: string, agentId: string, _nowMs?: number): boolean;
/** Set a crystal's brightness (`[0, 1]`). False when missing. `nowMs` is accepted for API symmetry. */
export declare function updateCrystalBrightness(db: DatabaseSync, id: string, agentId: string, brightness: number, _nowMs?: number): boolean;
/**
 * Count surfaced hits (call from a writable connection after a whisper actually used the crystal). Best-effort and
 * zero-stall: the write runs with `busy_timeout = 0`, so a busy ledger throws `SQLITE_BUSY` immediately instead of
 * blocking the Gateway event loop. A borrowed connection's own busy timeout is restored afterwards.
 */
export declare function recordCrystalHits(db: DatabaseSync, ids: readonly string[], agentId: string): number;
/**
 * Hot-path hit counter for the Memory Whisperer: opens an EXISTING database file (never creating or migrating it),
 * bumps `hit_count` for `ids`, and closes. Returns 0 for a missing file/table; a busy or locked ledger throws, so the
 * caller decides whether a lost count matters (the whisperer treats it as best-effort).
 */
export declare function recordCrystalHitsAtPath(path: string, ids: readonly string[], agentId: string): number;
/** Read-only counts by tier and status plus core-memory counts. A path is opened read-only; missing DB/table → zeros. */
export declare function summarizeCrystals(source: DbSource, agentId: string): MemoryCrystalsSummary;
/**
 * Deterministic, zero-LLM crystal lookup for the Memory Whisperer. Never writes; a path is opened read-only and a
 * missing database/table returns `[]` without creating anything.
 *
 * Strict ACL: only `active` crystals of exactly `agentId`, whose `audience_key` is in `audienceKeys`, whose every corpus
 * is in `allowedCorpora`, and that are not past `stale_after_ms`. Matching: meaningful tokens (stop words dropped,
 * simple plurals folded) of the query vs `title + summary`; keeps rows with `>= minSharedTokens` shared tokens and an
 * overlap coefficient `|shared| / min(|query|, |crystal|) >= minTokenOverlap`. Ranked by
 * `matchScore * (0.7 + 0.3 * clamp(brightness, 0, 1))` plus a small `ltm` boost, then `ltm` before `stm`.
 */
export declare function findMatchingCrystalsReadOnly(source: DbSource, query: CrystalMatchQuery): CrystalMatch[];
export declare class MemoryCrystalsStore {
    #private;
    readonly db: DatabaseSync;
    /** Pass a path to own a connection, or an open `DatabaseSync` to share one (e.g. inside a fenced Steward commit). */
    constructor(database: string | DatabaseSync, options?: {
        busyTimeoutMs?: number;
    });
    close(): void;
    upsertCrystal(input: UpsertCrystalInput): UpsertCrystalResult;
    promoteCrystalToLtm(id: string, agentId: string, nowMs?: number): boolean;
    retireCrystal(id: string, agentId: string, nowMs?: number): boolean;
    updateCrystalBrightness(id: string, agentId: string, brightness: number, nowMs?: number): boolean;
    recordCrystalHits(ids: readonly string[], agentId: string): number;
    listCrystals(filter: ListCrystalsFilter): MemoryCrystal[];
    getCrystal(id: string, agentId: string): MemoryCrystal | undefined;
    recordCoreMemory(input: RecordCoreMemoryInput): RecordCoreMemoryResult;
    listCoreMemories(filter: ListCoreMemoriesFilter): CoreMemory[];
    summarize(agentId: string): MemoryCrystalsSummary;
    findMatchingCrystals(query: CrystalMatchQuery): CrystalMatch[];
    static findMatchingCrystalsReadOnly(source: DbSource, query: CrystalMatchQuery): CrystalMatch[];
    static summarizeCrystals(source: DbSource, agentId: string): MemoryCrystalsSummary;
    static list(db: DatabaseSync, filter: ListCrystalsFilter): MemoryCrystal[];
    static get(db: DatabaseSync, id: string, agentId: string): MemoryCrystal | undefined;
    static listCoreMemories(db: DatabaseSync, filter: ListCoreMemoriesFilter): CoreMemory[];
    static readOnly<T>(path: string, fallback: T, fn: (db: DatabaseSync) => T): T;
}
export {};
