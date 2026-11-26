import type { DatabaseSync } from "node:sqlite";
export declare const RECALL_LEDGER_SCHEMA_VERSION = 2;
export type RecallLedgerConfig = {
    enabled: boolean;
    retentionDays: number;
};
type RecallSource = "whisperer" | "tool" | "drift_rerun";
type RecallRankingMode = "decision" | "retrieval";
type RecallFallbackReason = "key_unavailable" | "all_judgments_failed";
export type RecallQueryOutcome = "emitted" | "rejected" | "empty" | "tool_ok" | "degraded" | "partial" | "missing_key" | "unavailable" | "timed_out" | "cancelled" | "skipped" | "failed";
export type RecallHitDisposition = "emitted" | "returned" | "rank_limit" | "below_threshold" | "judge_failed" | "unjudged_cap" | "cooldown" | "redundant" | "payload_limit";
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
    scores: readonly {
        path: string;
        name: string;
        score: number;
    }[];
    inputTokens?: number;
    outputTokens?: number;
    elapsedMs?: number;
    outcome: string;
};
type SkillOpenRecord = SkillEventContext & {
    skillPath: string;
    toolName: "read" | "skills_read";
    wasWhispered: boolean;
    wasPinned: boolean;
};
export type RecallLedgerEvent = {
    kind: "query";
    record: RecallQueryRecord;
} | {
    kind: "read";
    record: RecallReadRecord;
} | {
    kind: "skill_routing";
    record: SkillRoutingRecord;
} | {
    kind: "skill_open";
    record: SkillOpenRecord;
};
export type RecallPersonIdentity = {
    provider: string;
    senderId: string;
    accountId?: string;
};
/** Parses YYYY-MM-DD.md filenames (both `2026-11-20.md` under a rooted `memory/` source and `memory/2026-11-20.md`). */
export declare function parseDailyFilenameDateMs(path: string): number | undefined;
export declare function resolveRecallLedger(value: unknown): RecallLedgerConfig;
export declare function openRecallLedger(path: string): DatabaseSync;
/** Direct synchronous batch committer (also used in tests and standalone scripts). */
export declare function writeRecallBatch(path: string, events: readonly RecallLedgerEvent[], options?: {
    retentionDays?: number;
    nowMs?: number;
    prune?: boolean;
}): {
    written: number;
    pruned: number;
};
/** Operator erasure for one person's recall query history; never creates tables in an uninitialized DB. */
export declare function purgeRecallPerson(path: string, identity: RecallPersonIdentity): {
    queries: number;
};
type WorkerRequestPayload = {
    kind: "batch";
    path: string;
    events: readonly RecallLedgerEvent[];
    options: {
        retentionDays: number;
        nowMs: number;
        prune: boolean;
    };
} | {
    kind: "purge";
    path: string;
    identity: RecallPersonIdentity;
} | {
    kind: "shutdown";
};
type WorkerRequest = WorkerRequestPayload & {
    id: number;
};
type WorkerResponse = {
    id: number;
    ok: true;
    result: {
        written: number;
        pruned: number;
    } | {
        queries: number;
    } | null;
} | {
    id: number;
    ok: false;
    error: string;
};
/**
 * Persistent worker handler exported by name so the single background worker thread
 * reuses open SQLite connections across batches without spinning up a V8 isolate per event.
 * @public loaded by name from the persistent worker thread
 */
export declare function createRecallWorkerHandler(): {
    handle: (request: WorkerRequest) => WorkerResponse;
    closeAll: () => void;
};
/**
 * Off-event-loop recall ledger writer backed by a single lazy persistent Worker thread.
 * `enqueue` is strictly O(1) and synchronous with zero SQLite I/O on the Gateway thread.
 */
export declare class RecallLedgerWriter {
    #private;
    constructor(options?: {
        retentionDays?: number;
        maxQueueSize?: number;
        pruneIntervalMs?: number;
        shutdownTimeoutMs?: number;
        onError?: (error: unknown) => void;
        onDrop?: () => void;
    });
    enqueue(dbPath: string, event: RecallLedgerEvent): boolean;
    /** Orders person erasure behind any previously accepted writes so queued events cannot resurrect deleted rows. */
    purgePerson(dbPath: string, identity: RecallPersonIdentity): Promise<{
        queries: number;
    }>;
    flush(): Promise<void>;
    close(timeoutMs?: number): Promise<void>;
    stats(): {
        enqueued: number;
        written: number;
        dropped: number;
        errors: number;
    };
}
export {};
