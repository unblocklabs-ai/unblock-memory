import { createHash } from "node:crypto";
import { MEMORY_PASSAGE_CHARS, duplicateMemoryPassage } from "./memory-passage.js";
import { judgeMemoryPassage, memoryUsefulnessRequest } from "./typesafe.js";
export function memoryPassageId(text) {
    return createHash("sha256").update(text.replace(/\s+/gu, " ").trim()).digest("hex");
}
/** Both entry points use the same complete passages and independent usefulness judgments. */
export async function searchMemory(manager, queries, options) {
    const { signal } = options;
    signal?.throwIfAborted();
    const asOf = options.asOf ?? new Date().toISOString();
    const started = performance.now();
    const hits = await manager.searchCandidates(queries, {
        corpora: options.corpora, sessionFilter: options.sessionFilter, requestContext: options.requestContext,
        sources: options.sources, signal, maxSnippetChars: MEMORY_PASSAGE_CHARS,
    });
    signal?.throwIfAborted();
    const observation = { retrievalMs: performance.now() - started, judgeMs: 0,
        candidates: hits.length, eligible: 0, requestsSucceeded: 0, requestsFailed: 0 };
    const candidates = [];
    for (const hit of hits) {
        // Defense in depth before disclosing passages to the external judge.
        if (options.corpora && !options.corpora.includes("all") && !options.corpora.includes(hit.corpus))
            continue;
        const excerpt = hit.snippet.trim();
        if (!excerpt || excerpt.length > MEMORY_PASSAGE_CHARS || options.excludedPassages?.has(memoryPassageId(excerpt)) ||
            duplicateMemoryPassage({ ...hit, text: excerpt }, candidates.map(candidate => ({ ...candidate, text: candidate.snippet }))))
            continue;
        candidates.push({ ...hit, snippet: excerpt });
    }
    observation.eligible = candidates.length;
    options.onCandidates?.(observation);
    const judgeStarted = performance.now();
    const judged = (await Promise.all(candidates.map(async (hit, candidateIndex) => {
        const requestStarted = performance.now();
        try {
            const { probability } = await judgeMemoryPassage(memoryUsefulnessRequest(options.conversation, {
                excerpt: hit.snippet, corpus: hit.corpus, sourcePath: hit.path,
                dates: [...new Set(hit.sessionMessages?.flatMap(message => message.timestamp ? [message.timestamp] : [])
                        ?? (hit.messageTimestamp ? [hit.messageTimestamp] : []))],
            }, asOf), options);
            signal?.throwIfAborted();
            observation.requestsSucceeded++;
            options.onJudgment?.({ candidateIndex, elapsedMs: performance.now() - requestStarted });
            // Discovery reciprocal ranks are not vector similarity or usefulness.
            const { vectorScore: _vectorScore, textScore: _textScore, ...result } = hit;
            return [{ ...result, score: probability }];
        }
        catch (error) {
            if (signal?.aborted)
                return [];
            observation.requestsFailed++;
            options.onJudgment?.({ candidateIndex, elapsedMs: performance.now() - requestStarted, error });
            return [];
        }
    }))).flat();
    signal?.throwIfAborted();
    observation.judgeMs = performance.now() - judgeStarted;
    return { ...observation, results: judged.filter(hit => hit.score >= (options.minUsefulness ?? 0.7))
            .sort((a, b) => b.score - a.score).slice(0, options.maxResults ?? 5) };
}
