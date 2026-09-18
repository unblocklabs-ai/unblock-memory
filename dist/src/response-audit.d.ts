import type { UnblockMemoryConfig } from "./config.js";
import type { ResolvedSource } from "./sources.js";
export declare function responseCohort(config: UnblockMemoryConfig["responseAudit"]): string;
export type ResponseAuditOptions = {
    agentId: string;
    databasePath: string;
    storePath: string;
    indexPath: string;
    config: UnblockMemoryConfig;
    sources: readonly ResolvedSource[];
    signal?: AbortSignal;
    dryRun?: boolean;
    peoplePath?: string;
};
/** All inference is outside memory's mutation queue and outside transcript DB transactions. */
export declare function auditResponses(options: ResponseAuditOptions): Promise<{
    status: "disabled";
    reason?: undefined;
    cohort?: undefined;
    coverage?: undefined;
} | {
    status: "unavailable";
    reason: string;
    cohort?: undefined;
    coverage?: undefined;
} | {
    status: "already_running";
    reason?: undefined;
    cohort?: undefined;
    coverage?: undefined;
} | {
    status: "ok" | "dry_run";
    cohort: string;
    coverage: {
        sessions: number;
        sessionLimitReached: boolean;
        sessionsOverBudget: number;
        completedResponses: number;
        reconciledSessions: number;
        reconciliationDeferred: number;
        extractedSessions: number;
        unchangedSessions: number;
        stageAttempts: number;
        stageCacheHits: number;
        eligible: number;
        noFeedback: number;
        pendingFeedback: number;
        oversized: number;
        filteredEvents: number;
        outsideLookback: number;
        attempted: number;
        evaluated: number;
        cachedOrBackoff: number;
        deferredByLimit: number;
        failed: number;
        stale: number;
    };
    reason?: undefined;
} | {
    status: "unavailable";
    reason: string;
    cohort: string;
    coverage: {
        sessions: number;
        sessionLimitReached: boolean;
        sessionsOverBudget: number;
        completedResponses: number;
        reconciledSessions: number;
        reconciliationDeferred: number;
        extractedSessions: number;
        unchangedSessions: number;
        stageAttempts: number;
        stageCacheHits: number;
        eligible: number;
        noFeedback: number;
        pendingFeedback: number;
        oversized: number;
        filteredEvents: number;
        outsideLookback: number;
        attempted: number;
        evaluated: number;
        cachedOrBackoff: number;
        deferredByLimit: number;
        failed: number;
        stale: number;
    };
}>;
