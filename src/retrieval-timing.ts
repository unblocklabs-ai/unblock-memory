import type { VectorSearchTiming, VectorSearchTrace } from "@unblocklabs/qmd";

export const timingFields = ["setupMs", "queueWaitMs", "metadataMs", "storeSetupMs", "bm25Ms", "vectorMs",
  "vectorIndexCheckMs", "vectorScopeMs", "embeddingMs", "vectorScanMs", "hydrationMs", "vectorMappingMs",
  "vectorOtherMs", "passageMs", "candidatePrepMs", "retrievalOtherMs", "otherMs"] as const;
type TimingField = typeof timingFields[number] | "retrievalMs" | "judgeMs" | "generationMs";
export type RetrievalTimings = Partial<Record<TimingField | "metadataReloads" | "vectorScanAttempts", number>>;

/** Freeze in-flight duration at abort, without changing the work's cancellation behavior. */
export function startTiming(field: TimingField, timings?: RetrievalTimings, signal?: AbortSignal): () => void {
  if (!timings || signal?.aborted) return () => {};
  const started = performance.now();
  const previous = timings[field] ?? 0;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    timings[field] = previous + performance.now() - started;
    signal?.removeEventListener("abort", end);
  };
  signal?.addEventListener("abort", end, { once: true });
  return end;
}

export async function timeStage<T>(field: TimingField, timings: RetrievalTimings | undefined,
  signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const end = startTiming(field, timings, signal);
  try { return await run(); } finally { end(); }
}

const vectorFields = {
  index_check: "vectorIndexCheckMs", scope_resolution: "vectorScopeMs", embedding: "embeddingMs",
  vector_scan_knn: "vectorScanMs", hydration: "hydrationMs", result_mapping: "vectorMappingMs",
} as const satisfies Record<VectorSearchTiming["stage"], TimingField>;

export function vectorTrace(timings?: RetrievalTimings, signal?: AbortSignal): VectorSearchTrace | undefined {
  if (!timings) return;
  return timing => {
    if (signal?.aborted || !Number.isFinite(timing.durationMs) || timing.durationMs < 0) return;
    const field = vectorFields[timing.stage];
    if (!field) return;
    timings[field] = (timings[field] ?? 0) + timing.durationMs;
    if (timing.stage === "vector_scan_knn") timings.vectorScanAttempts = (timings.vectorScanAttempts ?? 0) + 1;
  };
}

export function unaccounted(total: number, timings: RetrievalTimings, fields: readonly TimingField[]): number {
  return Math.max(0, total - fields.reduce((sum, field) => sum + (timings[field] ?? 0), 0));
}

export const vectorParts = Object.values(vectorFields);
export const retrievalParts = ["queueWaitMs", "metadataMs", "storeSetupMs", "bm25Ms", "vectorMs", "passageMs"] as const;
