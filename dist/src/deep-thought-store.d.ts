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
