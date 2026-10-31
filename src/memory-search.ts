import { createHash } from "node:crypto";
import type { CorpusMemorySearchResult, CorpusSearchOptions } from "./contracts.js";
import type { QueryConversation, QueryPair } from "./query-contract.js";
import { MEMORY_PASSAGE_CHARS, duplicateMemoryPassage } from "./memory-passage.js";
import { judgeMemoryPassage, memoryUsefulnessRequest } from "./typesafe.js";
import { startTiming, retrievalParts, unaccounted, type RetrievalTimings } from "./retrieval-timing.js";

export type MemoryCandidateManager = {
  searchCandidates(queries: QueryPair, options: CorpusSearchOptions): Promise<CorpusMemorySearchResult[]>;
};

export function memoryPassageId(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/gu, " ").trim()).digest("hex");
}

export type MemorySearchObservation = RetrievalTimings & {
  retrievalMs: number; judgeMs: number; candidates: number; eligible: number;
  requestsSucceeded: number; requestsFailed: number;
};

export type MemoryRanking = {
  rankingMode: "typesafe_usefulness" | "retrieval";
  fallbackReason?: "key_unavailable" | "all_judgments_failed";
};

/** Both entry points use the same complete passages and independent usefulness judgments. */
export async function searchMemory(manager: MemoryCandidateManager, queries: QueryPair, options: CorpusSearchOptions & {
  apiKey?: string; timeoutMs: number; conversation: QueryConversation; asOf?: string;
  /** Only explicit, agent-requested search opts in. Automatic injection stays strict. */
  allowRetrievalFallback?: boolean;
  minUsefulness?: number; excludedPassages?: ReadonlyMap<string, number>;
  onCandidates?: (observation: MemorySearchObservation) => void;
  onJudgment?: (event: { candidateIndex: number; elapsedMs: number; error?: unknown }) => void;
}): Promise<MemorySearchObservation & MemoryRanking & { results: CorpusMemorySearchResult[] }> {
  const { signal } = options;
  signal?.throwIfAborted();
  const asOf = options.asOf ?? new Date().toISOString();
  const timings = options.timings ?? {};
  const endRetrieval = startTiming("retrievalMs", timings, signal);
  let hits: CorpusMemorySearchResult[];
  try {
    hits = await manager.searchCandidates(queries, {
      corpora: options.corpora, sessionFilter: options.sessionFilter, requestContext: options.requestContext,
      sources: options.sources, signal, maxSnippetChars: MEMORY_PASSAGE_CHARS, timings,
    });
  } finally {
    endRetrieval();
    if (timings.retrievalMs !== undefined) timings.retrievalOtherMs = unaccounted(timings.retrievalMs, timings, retrievalParts);
  }
  signal?.throwIfAborted();
  const observation: MemorySearchObservation = { retrievalMs: timings.retrievalMs ?? 0, judgeMs: 0,
    candidates: hits.length, eligible: 0, requestsSucceeded: 0, requestsFailed: 0 };
  const candidates: CorpusMemorySearchResult[] = [];
  const endCandidatePrep = startTiming("candidatePrepMs", timings, signal);
  try {
    for (const hit of hits) {
      // Defense in depth before disclosing passages to the external judge.
      if (options.corpora && !options.corpora.includes("all") && !options.corpora.includes(hit.corpus)) continue;
      const excerpt = hit.snippet.trim();
      if (!excerpt || excerpt.length > MEMORY_PASSAGE_CHARS || options.excludedPassages?.has(memoryPassageId(excerpt)) ||
        duplicateMemoryPassage({ ...hit, text: excerpt }, candidates.map(candidate => ({ ...candidate, text: candidate.snippet })))) continue;
      candidates.push({ ...hit, snippet: excerpt });
    }
  } finally { endCandidatePrep(); }
  observation.eligible = candidates.length;
  options.onCandidates?.(observation);
  const fallback = (reason: NonNullable<MemoryRanking["fallbackReason"]>) => ({
    ...timings, ...observation, rankingMode: "retrieval" as const, fallbackReason: reason,
    // Discovery is a lexical-first union, not a ranking. Stable reciprocal-rank
    // ordering lets strong vector-only hits compete before maxResults truncation.
    // These original lane scores are not fused ranks or usefulness probabilities.
    results: [...candidates].sort((a, b) => b.score - a.score).slice(0, options.maxResults ?? 5),
  });
  if (!options.apiKey) {
    signal?.throwIfAborted();
    if (options.allowRetrievalFallback) return fallback("key_unavailable");
    return { ...timings, ...observation, rankingMode: "typesafe_usefulness", results: [] };
  }
  const apiKey = options.apiKey;
  const endJudge = startTiming("judgeMs", timings, signal);
  let judged: CorpusMemorySearchResult[];
  try {
    judged = (await Promise.all(candidates.map(async (hit, candidateIndex) => {
      const requestStarted = performance.now();
      try {
        const { probability } = await judgeMemoryPassage(memoryUsefulnessRequest(options.conversation, {
          excerpt: hit.snippet, corpus: hit.corpus, sourcePath: hit.path,
          dates: [...new Set(hit.sessionMessages?.flatMap(message => message.timestamp ? [message.timestamp] : [])
            ?? (hit.messageTimestamp ? [hit.messageTimestamp] : []))],
        }, asOf), { ...options, apiKey });
        signal?.throwIfAborted();
        observation.requestsSucceeded++;
        options.onJudgment?.({ candidateIndex, elapsedMs: performance.now() - requestStarted });
        // Discovery reciprocal ranks are not vector similarity or usefulness.
        const { vectorScore: _vectorScore, textScore: _textScore, ...result } = hit;
        return [{ ...result, score: probability }];
      } catch (error) {
        if (signal?.aborted) return [];
        observation.requestsFailed++;
        options.onJudgment?.({ candidateIndex, elapsedMs: performance.now() - requestStarted, error });
        return [];
      }
    }))).flat();
  } finally { endJudge(); }
  signal?.throwIfAborted();
  observation.judgeMs = timings.judgeMs ?? 0;
  if (options.allowRetrievalFallback && candidates.length && !observation.requestsSucceeded)
    return fallback("all_judgments_failed");
  return { ...timings, ...observation, rankingMode: "typesafe_usefulness", results: judged.filter(hit => hit.score >= (options.minUsefulness ?? 0.7))
    .sort((a, b) => b.score - a.score).slice(0, options.maxResults ?? 5) };
}
