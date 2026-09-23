import type { UnblockMemoryConfig } from "./config.js";
import type { TrainingStore } from "./training-store.js";
type Source = {
    databasePath: string;
    agentId: string;
};
/** A full active-branch rescan is cheap/local; only changed exact inputs need inference. */
export declare function collectTraining(source: Source, store?: TrainingStore, options?: {
    since?: number;
    until?: number;
    existingOnly?: boolean;
}): {
    sessions: number;
    excludedSessions: number;
    oversizedSessions: number;
    eligible: number;
    users: number;
    filtered: number;
    oversized: number;
    unanswered: number;
    added: number;
    changed: number;
    unchanged: number;
    retired: number;
};
/** Parallel, bounded paid work. Negative results are just as cacheable as positives. */
export declare function runTraining(source: Source, store: TrainingStore, config: UnblockMemoryConfig, options: {
    maxExamples?: number;
    maxInputBytes: number;
    concurrency?: number;
    dryRun?: boolean;
}): Promise<{
    refreshed: {
        sessions: number;
        excludedSessions: number;
        oversizedSessions: number;
        eligible: number;
        users: number;
        filtered: number;
        oversized: number;
        unanswered: number;
        added: number;
        changed: number;
        unchanged: number;
        retired: number;
    };
    pendingSelected: number;
    calls: number;
    completed: number;
    failed: number;
    ambiguous: number;
    inputBytes: number;
    inputTokens: number;
    outputTokens: number;
    budgetLimited: boolean;
}>;
export {};
