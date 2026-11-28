import { DatabaseSync } from "node:sqlite";
/** Default collectible window for finished jobs (`0` = keep until explicitly deleted). */
export declare const DEFAULT_DEEP_THOUGHT_JOB_RETENTION_MS = 1800000;
type DeepThoughtStoredCitation = {
    source: string;
    lines?: string;
    date?: string;
    quote: string;
};
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
/** Lowercase, NFKC, collapsed whitespace, leading/trailing punctuation trimmed. */
export declare function normalizeDeepThoughtQuestion(question: string): string;
/** Stable fingerprint of the normalized question (and focus, when given: a different focus is a different investigation). */
export declare function deepThoughtQuestionHash(question: string, focus?: string): string;
/** Sorted, de-duplicated, trimmed corpus names. */
export declare function canonicalCorpora(corpora: readonly string[]): string[];
/**
 * Public form of the exact freshness rule: `current` must record exactly the collections in `recorded`, each at exactly
 * the same generation. An empty snapshot on either side never verifies.
 */
export declare function derivedObservationGenerationsFresh(recorded: Readonly<Record<string, number>>, current: Readonly<Record<string, number>> | undefined): boolean;
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
/**
 * The default `deep_thought` cache audience key. A group/channel session key already names one shared conversation,
 * so everyone in it shares answers. Any other session (DMs, including `dmScope=main` where several peers share one
 * session key such as `agent:main:main`) is additionally split per requesting sender, so an answer never crosses a
 * DM/private boundary. Such a session without a verified sender returns `undefined`: callers must skip the cache
 * (never read or write) rather than pool every unidentified caller under one key.
 * Every producer and consumer of `derived_observations.audience_key` must call this so they stay in lockstep.
 */
export declare function deepThoughtAudienceKey(identity: DeepThoughtAudienceIdentity): string | undefined;
/** Default minimum overlap score (share of the stored question's meaningful tokens the turn covers). */
export declare const DEFAULT_DERIVED_MATCH_MIN_TOKEN_OVERLAP = 0.45;
/** Default minimum count of shared meaningful tokens: one shared word is never enough to fire. */
export declare const DEFAULT_DERIVED_MATCH_MIN_SHARED_TOKENS = 2;
/**
 * Meaningful tokens of a question or turn: normalized like `normalizeDeepThoughtQuestion`, split on anything that is
 * not a letter/number, possessives and simple plurals folded, stop words and 1-letter words dropped (numbers are kept).
 */
export declare function derivedObservationTokens(text: string): Set<string>;
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
type DerivedObservationGenerationsSource = Readonly<Record<string, number>> | ((corpora: readonly string[]) => Readonly<Record<string, number>> | undefined);
export type FindMatchingDerivedObservationsParams = DerivedObservationMatchQuery & {
    currentGenerations: DerivedObservationGenerationsSource;
    nowMs?: number;
};
/**
 * Read-only candidate lookup (ACL + deterministic scoring, no freshness check) against an existing database file.
 * Returns `[]` — never throws for a missing database or table — so callers on the hot path can probe cheaply.
 */
export declare function readDerivedObservationCandidates(dbPath: string, query: DerivedObservationMatchQuery): DerivedObservationMatch[];
/**
 * Read-only `findMatchingDerivedObservations`: identical matching and verification, but never writes (stale rows are
 * skipped, not marked). `[]` when the database or `derived_observations` table does not exist.
 */
export declare function findMatchingDerivedObservationsReadOnly(dbPath: string, params: FindMatchingDerivedObservationsParams): DerivedObservationMatch[];
/** A fully prepared `derived_observations` row: canonical hash, corpora and generations, everything already JSON-encoded. */
type FreshObservationRow = {
    id: string;
    agentId: string;
    question: string;
    questionHash: string;
    audienceKey: string;
    corporaJson: string;
    collectionGenerationsJson: string;
    answer: string;
    confidence: string;
    citationsJson: string;
    openQuestionsJson: string;
    sourceJobId: string | null;
    nowMs: number;
};
/**
 * The single writer of new `derived_observations` rows: supersedes any `fresh` row for the same key, then inserts this one
 * as `fresh`. Runs inside the caller's open transaction and never begins its own.
 */
export declare function insertFreshObservationInTransaction(db: DatabaseSync, row: FreshObservationRow): void;
export declare class DeepThoughtStore {
    #private;
    readonly db: DatabaseSync;
    /** Pass a path to open a dedicated connection, or an already-open `DatabaseSync` to share one. */
    constructor(database: string | DatabaseSync, options?: {
        busyTimeoutMs?: number;
    });
    close(): void;
    /** Insert a job, or update its progress/outcome. Identity columns (agent, owner, question) never change after insert. */
    upsertJob(input: DeepThoughtJobInput): DeepThoughtJobRecord;
    getJob(jobId: string): DeepThoughtJobRecord | undefined;
    deleteJob(jobId: string): boolean;
    /**
     * Restart recovery: every `running` row for `agentId` (except live `keepJobIds` still owned by this process) becomes
     * `cancelled` with a self-explaining outcome, so polling its `jobId` answers instead of hanging forever.
     * `retentionMs` (`0` = unlimited) sets how long the cancelled record stays collectible.
     */
    markInterruptedJobs(agentId: string, nowMs: number, options?: {
        keepJobIds?: Iterable<string>;
        retentionMs?: number;
    }): number;
    /** Delete finished jobs past their `expires_at`; rows with `expires_at IS NULL` (retention `0`) are kept. */
    pruneExpiredJobs(nowMs: number): number;
    /** Persist a verified synthesis; any previous `fresh` row for the same key becomes `superseded` atomically. */
    saveDerivedObservation(input: SaveDerivedObservationInput): DerivedObservation;
    /**
     * Exact-key lookup of the `fresh` observation. Hits (and counts the hit) only when `currentGenerations` records exactly
     * the same collections at exactly the same generations; otherwise the row is marked `stale` and `undefined` is returned.
     * An empty `currentGenerations` cannot verify anything: it misses without invalidating.
     */
    findFreshDerivedObservation(input: DerivedObservationKey & {
        currentGenerations: Readonly<Record<string, number>>;
        nowMs?: number;
    }): DerivedObservation | undefined;
    /**
     * Fresh, generation-verified observations whose question matches `queryText` (see `DerivedObservationMatchQuery`).
     * Strict ACL: exact agent + audience, every searched corpus allowed. An empty `currentGenerations` returns `[]`.
     * Rows that verify as stale (a recorded collection moved, vanished, or a new one appeared) are marked `stale`.
     * Never counts hits: a whisper is not a served `deep_thought` answer.
     */
    findMatchingDerivedObservations(params: FindMatchingDerivedObservationsParams): DerivedObservationMatch[];
    getDerivedObservation(id: string): DerivedObservation | undefined;
    /** Newest first. `limit` `0` (default) = unlimited. */
    listDerivedObservations(options: {
        agentId: string;
        status?: DerivedObservationStatus;
        audienceKey?: string;
        limit?: number;
    }): DerivedObservation[];
}
export {};
