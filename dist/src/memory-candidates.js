/** Discover the top ten passages for one lane before fusing lane rankings. */
export async function discoverLaneCandidates(qmd, query, collection, lane, signal, allowedPaths, trace) {
    const hits = await qmd.discoverCandidates({ query, lane, collection, limit: 10, signal,
        // Preserve keyword chunk tie-breaking against this lane's own query.
        intent: query, allowedPaths, trace });
    return hits.map(({ method, rank, score, file, body, bestChunk, bestChunkPos, ref }) => {
        const retrieval = {
            [method]: { score, rank: rank + 1 },
        };
        return { file, body, bestChunk, bestChunkPos, ...(ref ? { ref } : {}), score: 1 / (rank + 1),
            explain: { methods: [method] }, ...retrieval };
    });
}
