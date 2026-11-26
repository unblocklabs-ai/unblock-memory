import type { UnblockMemoryConfig } from "./config.js";
import { readInsideOutSources } from "./inside-out-sources.js";
import { emotionBaselineHistory } from "./emotion-baselines.js";
export { linkInsideOutPeople, purgeInsideOutPerson, refreshInsideOutBaselines, refreshInsideOutBaselinesAsync } from "./inside-out-store.js";
/** One fenced `mode='run'` singleton per agent store replaces the old process-local lock. */
export declare const INSIDE_OUT_WORK_KIND = "inside_out_grade";
export declare const INSIDE_OUT_WORK_SCOPE = "agent";
export type InsideOutConfig = {
    enabled: boolean;
    intervalMinutes: number;
    maxInteractions: number;
    maxContextTokens: number;
    baselineMinInteractions: number;
};
export declare function resolveInsideOut(value: unknown): InsideOutConfig;
/** Synchronous graceful release for `gateway_stop`: call before aborting so the pass adds no strikes. */
export declare function interruptInsideOut(owner: string, now?: number): number;
/** Explicit legacy repair: only read sources owning unlinked reviews; never rejudge their text. */
export declare function repairInsideOutIdentities(options: Parameters<typeof readInsideOutSources>[0] & {
    storePath: string;
}): Promise<{
    repaired: number;
    errors: string[];
}>;
type InsideOutRunResult = {
    reviewed: number;
    cached: number;
    failed: number;
    sources: number;
    skippedSources: number;
    errors: string[];
    baselineError?: string;
};
type InsideOutRunOptions = {
    agentId: string;
    databasePath: string;
    sessionsDir?: string;
    storePath: string;
    config: UnblockMemoryConfig;
    signal?: AbortSignal;
    retry?: boolean;
    sessionId?: string;
    /** Explicit operator/CLI pass: claim now when unleased instead of waiting for the schedule. */
    manual?: boolean;
    /** Lease owner; the gateway passes a stable one so `interruptInsideOut` can release it on stop. */
    owner?: string;
    leaseMs?: number;
    heartbeatMs?: number;
};
/**
 * Scheduled passes run only when the agent's `inside_out_grade` row is due, so repeated `gateway_start`
 * calls and hot-replaced instances cannot re-run inside `intervalMinutes`. Manual passes start at once but
 * never overlap a live lease held by another process.
 */
export declare function runInsideOut(options: InsideOutRunOptions): Promise<InsideOutRunResult | {
    status: string;
    reason?: undefined;
} | {
    status: "skipped";
    reason: "already_running" | "not_due";
}>;
export declare function reportInsideOutBaselines(path: string, options?: Parameters<typeof emotionBaselineHistory>[1]): {
    id: string;
    person_id: string;
    rubric: string;
    model: string;
    version: string;
    week_start: number;
    week_end: number;
    computed_at: number;
    weekly: {
        joy: {
            count: number;
            mean: number | null;
            min: number | null;
            p10: number | null;
            median: number | null;
            p90: number | null;
            max: number | null;
            distribution: [number, number][];
        };
        sadness: {
            count: number;
            mean: number | null;
            min: number | null;
            p10: number | null;
            median: number | null;
            p90: number | null;
            max: number | null;
            distribution: [number, number][];
        };
        fear: {
            count: number;
            mean: number | null;
            min: number | null;
            p10: number | null;
            median: number | null;
            p90: number | null;
            max: number | null;
            distribution: [number, number][];
        };
        anger: {
            count: number;
            mean: number | null;
            min: number | null;
            p10: number | null;
            median: number | null;
            p90: number | null;
            max: number | null;
            distribution: [number, number][];
        };
        disgust: {
            count: number;
            mean: number | null;
            min: number | null;
            p10: number | null;
            median: number | null;
            p90: number | null;
            max: number | null;
            distribution: [number, number][];
        };
        surprise: {
            count: number;
            mean: number | null;
            min: number | null;
            p10: number | null;
            median: number | null;
            p90: number | null;
            max: number | null;
            distribution: [number, number][];
        };
    };
    cumulative: {
        joy: {
            count: number;
            mean: number | null;
            min: number | null;
            p10: number | null;
            median: number | null;
            p90: number | null;
            max: number | null;
            distribution: [number, number][];
        };
        sadness: {
            count: number;
            mean: number | null;
            min: number | null;
            p10: number | null;
            median: number | null;
            p90: number | null;
            max: number | null;
            distribution: [number, number][];
        };
        fear: {
            count: number;
            mean: number | null;
            min: number | null;
            p10: number | null;
            median: number | null;
            p90: number | null;
            max: number | null;
            distribution: [number, number][];
        };
        anger: {
            count: number;
            mean: number | null;
            min: number | null;
            p10: number | null;
            median: number | null;
            p90: number | null;
            max: number | null;
            distribution: [number, number][];
        };
        disgust: {
            count: number;
            mean: number | null;
            min: number | null;
            p10: number | null;
            median: number | null;
            p90: number | null;
            max: number | null;
            distribution: [number, number][];
        };
        surprise: {
            count: number;
            mean: number | null;
            min: number | null;
            p10: number | null;
            median: number | null;
            p90: number | null;
            max: number | null;
            distribution: [number, number][];
        };
    };
}[];
export declare function reportInsideOut(path: string, options?: {
    summary?: boolean;
    sender?: string;
    sessionId?: string;
    since?: number;
    emotion?: string;
    min?: number;
    bucket?: string;
    personId?: string;
    personal?: boolean;
    deviationHistory?: boolean;
}): Record<string, unknown>[];
