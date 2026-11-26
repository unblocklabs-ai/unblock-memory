import type { AllowedDocumentPaths, QMDStore, VectorSearchTrace } from "@unblocklabs/qmd";
import type { QueryLane } from "./query-contract.js";

/** Discover the top ten passages for one lane before fusing lane rankings. */
export async function discoverLaneCandidates(qmd: QMDStore, query: string, collection: string | string[], lane: QueryLane, signal?: AbortSignal, allowedPaths?: AllowedDocumentPaths, trace?: VectorSearchTrace) {
  const hits = await qmd.discoverCandidates({ query, lane, collection, limit: 10, signal,
    // Preserve keyword chunk tie-breaking against this lane's own query.
    intent: query, allowedPaths, trace });
  return hits.map(({ method, rank, score, file, body, bestChunk, bestChunkPos, ref }) => {
    const retrieval: Partial<Record<typeof method, { score: number; rank: number }>> = {
      [method]: { score, rank: rank + 1 },
    };
    return { file, body, bestChunk, bestChunkPos, ...(ref ? { ref } : {}), score: 1 / (rank + 1),
      explain: { methods: [method] }, ...retrieval };
  });
}
