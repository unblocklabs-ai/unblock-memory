import type { VectorSearchTrace } from "@unblocklabs/qmd";
export declare const timingFields: readonly ["setupMs", "queueWaitMs", "metadataMs", "storeSetupMs", "bm25Ms", "vectorMs", "vectorIndexCheckMs", "vectorScopeMs", "embeddingMs", "vectorScanMs", "hydrationMs", "vectorMappingMs", "vectorOtherMs", "passageMs", "candidatePrepMs", "retrievalOtherMs", "otherMs"];
type TimingField = typeof timingFields[number] | "retrievalMs" | "judgeMs" | "generationMs";
export type RetrievalTimings = Partial<Record<TimingField | "metadataReloads" | "vectorScanAttempts", number>>;
/** Freeze in-flight duration at abort, without changing the work's cancellation behavior. */
export declare function startTiming(field: TimingField, timings?: RetrievalTimings, signal?: AbortSignal): () => void;
export declare function timeStage<T>(field: TimingField, timings: RetrievalTimings | undefined, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T>;
export declare function vectorTrace(timings?: RetrievalTimings, signal?: AbortSignal): VectorSearchTrace | undefined;
export declare function unaccounted(total: number, timings: RetrievalTimings, fields: readonly TimingField[]): number;
export declare const vectorParts: ("vectorIndexCheckMs" | "vectorScopeMs" | "embeddingMs" | "vectorScanMs" | "hydrationMs" | "vectorMappingMs")[];
export declare const retrievalParts: readonly ["queueWaitMs", "metadataMs", "storeSetupMs", "bm25Ms", "vectorMs", "passageMs"];
export {};
