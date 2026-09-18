import type { QMDStore } from "@unblocklabs/qmd";
import { type ResolvedSource } from "./sources.js";
/** Inspect center and edge samples; never extrapolate their labels to the rest of a cluster. */
export declare function reviewClusterIngestion(params: {
    db: QMDStore["internal"]["db"];
    sources: readonly ResolvedSource[];
    clusterId: string;
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
    read?: <T>(run: () => T) => Promise<T>;
}): Promise<{
    status: "unavailable";
    reason: string;
    sample?: undefined;
    considered?: undefined;
    runId?: undefined;
    clusterSize?: undefined;
} | {
    status: "ok";
    runId: string;
    clusterId: string;
    members: {
        flagged: boolean;
        defect: "encoding" | "wrapper" | "boilerplate" | "none_or_uncertain";
        confidence: number;
        path: string;
        hash: string;
        seq: number;
        from: number;
        fingerprint: string;
    }[];
    recurring: {
        defect: string;
        examples: {
            path: string;
            from: number;
            fingerprint: string;
        }[];
    }[];
    sampled: number;
    considered: number;
    clusterSize: number | undefined;
    policy: string;
    scope: string;
    reason?: undefined;
}>;
