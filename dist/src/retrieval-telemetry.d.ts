import { type RetrievalTimings } from "./retrieval-timing.js";
type RetrievalOperation = "vector" | "memoryWhisperer" | "memorySearch";
type RetrievalOutcome = "ok" | "partial" | "empty" | "failed" | "cancelled" | "timed_out" | "skipped";
declare const fields: readonly ["elapsedMs", "retrievalMs", "judgeMs", "gateMs", "generationMs", "setupMs", "queueWaitMs", "metadataMs", "storeSetupMs", "bm25Ms", "vectorMs", "vectorIndexCheckMs", "vectorScopeMs", "embeddingMs", "vectorScanMs", "hydrationMs", "vectorMappingMs", "vectorOtherMs", "passageMs", "candidatePrepMs", "retrievalOtherMs", "otherMs", "metadataReloads", "vectorScanAttempts", "candidates", "eligible", "results", "contextChars"];
type Field = typeof fields[number];
export type RetrievalObservation = {
    outcome: RetrievalOutcome;
    elapsedMs: number;
} & RetrievalTimings & Partial<Record<Field, number>>;
/** Only fixed operation/outcome names and nonnegative numbers enter this store. */
export declare class RetrievalTelemetry {
    #private;
    record(operation: RetrievalOperation, observation: RetrievalObservation): void;
    snapshot(): {
        scope: string;
        operations: {
            [k: string]: {
                calls: number;
                outcomes: {
                    cancelled?: number | undefined;
                    ok?: number | undefined;
                    partial?: number | undefined;
                    skipped?: number | undefined;
                    failed?: number | undefined;
                    empty?: number | undefined;
                    timed_out?: number | undefined;
                };
                slowestRecent: {
                    outcome: RetrievalOutcome;
                    setupMs?: number | undefined;
                    queueWaitMs?: number | undefined;
                    metadataMs?: number | undefined;
                    storeSetupMs?: number | undefined;
                    bm25Ms?: number | undefined;
                    vectorMs?: number | undefined;
                    vectorIndexCheckMs?: number | undefined;
                    vectorScopeMs?: number | undefined;
                    embeddingMs?: number | undefined;
                    vectorScanMs?: number | undefined;
                    hydrationMs?: number | undefined;
                    vectorMappingMs?: number | undefined;
                    vectorOtherMs?: number | undefined;
                    passageMs?: number | undefined;
                    candidatePrepMs?: number | undefined;
                    retrievalOtherMs?: number | undefined;
                    otherMs?: number | undefined;
                    retrievalMs?: number | undefined;
                    judgeMs?: number | undefined;
                    metadataReloads?: number | undefined;
                    vectorScanAttempts?: number | undefined;
                    elapsedMs?: number | undefined;
                    gateMs?: number | undefined;
                    generationMs?: number | undefined;
                    candidates?: number | undefined;
                    eligible?: number | undefined;
                    results?: number | undefined;
                    contextChars?: number | undefined;
                }[];
                measurements: {
                    [k: string]: {
                        total: number;
                        samples: number;
                        recentSamples: number;
                        p50: number | null;
                        p95: number | null;
                    };
                };
            };
        };
    };
}
export {};
