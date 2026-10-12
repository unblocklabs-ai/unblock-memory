import type { UnblockMemoryConfig } from "./config.js";
import { readInsideOutSources } from "./inside-out-sources.js";
import { emotionBaselineHistory } from "./emotion-baselines.js";
export type InsideOutConfig = {
    enabled: boolean;
    intervalMinutes: number;
    maxInteractions: number;
    maxContextTokens: number;
    baselineMinInteractions: number;
};
export declare function resolveInsideOut(value: unknown): InsideOutConfig;
/** Refresh People links without loading transcripts or calling Jev. Known accounts stay exact. */
export declare function linkInsideOutPeople(path: string): {
    updated: number;
    linked: number;
    unlinked: number;
};
/** Explicit legacy repair: only read sources owning unlinked reviews; never rejudge their text. */
export declare function repairInsideOutIdentities(options: Parameters<typeof readInsideOutSources>[0] & {
    storePath: string;
}): Promise<{
    repaired: number;
    errors: string[];
}>;
export declare function runInsideOut(options: {
    agentId: string;
    databasePath: string;
    sessionsDir?: string;
    storePath: string;
    config: UnblockMemoryConfig;
    signal?: AbortSignal;
    retry?: boolean;
    sessionId?: string;
}): Promise<{
    reviewed: number;
    cached: number;
    failed: number;
    sources: number;
    skippedSources: number;
    errors: string[];
} | {
    status: string;
}>;
/** Rebuild local statistics from existing grades, also refreshing exact People links. */
export declare function refreshInsideOutBaselines(path: string, options?: {
    minInteractions?: number;
    now?: number;
    recompare?: boolean;
}): {
    snapshots: number;
    comparisons: number;
};
/** Keep historical aggregation off the Gateway event loop; serialize writers per store. */
export declare function refreshInsideOutBaselinesAsync(path: string, options?: Parameters<typeof refreshInsideOutBaselines>[1]): Promise<{
    snapshots: number;
    comparisons: number;
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
    is_current: number;
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
