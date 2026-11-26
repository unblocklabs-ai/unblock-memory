import { createHash } from "node:crypto";
import type { CorpusMemorySearchResult, CorpusSearchOptions } from "./contracts.js";
import type { QueryConversation, QueryPair } from "./query-contract.js";
import { selectJudgeConversation } from "./judge-context.js";
import { MEMORY_PASSAGE_CHARS, duplicateMemoryPassage } from "./memory-passage.js";
import { judgeMemoryPassage, memoryUsefulnessRequest } from "./decision-ranking.js";
import { startTiming, retrievalParts, unaccounted, type RetrievalTimings } from "./retrieval-timing.js";
import { parseDailyFilenameDateMs, type RecallHitDisposition, type RecallHitLocator } from "./recall-ledger.js";

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
  rankingMode: "decision" | "retrieval";
  fallbackReason?: "key_unavailable" | "all_judgments_failed" | "input_too_large";
};

export type RecallCandidateTrace = {
  hit: CorpusMemorySearchResult;
  passageId: string;
  locator: RecallHitLocator;
  retrievalRank: number;
  retrievalScore: number;
  usefulnessScore?: number;
  disposition: RecallHitDisposition | "passed";
  finalRank?: number;
};

function resolveLocator(hit: CorpusMemorySearchResult, passageId: string): RecallHitLocator {
  if (hit.locator) return hit.locator;
  const extractedMs = hit.extracted?.observedAt ? Date.parse(hit.extracted.observedAt) : Number.NaN;
  if (Number.isFinite(extractedMs)) {
    return { rawLeafId: passageId, observedAtMs: extractedMs, observedAtBasis: "extracted" };
  }
  const fileDateMs = hit.corpus !== "sessions" ? parseDailyFilenameDateMs(hit.path) : undefined;
  if (fileDateMs !== undefined) {
    return { rawLeafId: passageId, observedAtMs: fileDateMs, observedAtBasis: "filename_date" };
  }
  return { rawLeafId: passageId, observedAtBasis: "unknown" };
}

/** Both entry points use the same complete passages and independent usefulness judgments. */
export async function searchMemory(manager: MemoryCandidateManager, queries: QueryPair, options: CorpusSearchOptions & {
  apiKey?: string; endpoint?: string; model?: string; timeoutMs: number;
  conversation: QueryConversation | ReturnType<typeof selectJudgeConversation>; asOf?: string;
  /** Only explicit, agent-requested search opts in. Automatic injection stays strict. */
  allowRetrievalFallback?: boolean;
  /** Cap top retrieval-ranked candidates sent to the decision endpoint (after dedup and cooldown filtering). */
  maxJudgeCandidates?: number;
  minUsefulness?: number; excludedPassages?: ReadonlyMap<string, number>;
  onCandidates?: (observation: MemorySearchObservation) => void;
  onJudgment?: (event: { candidateIndex: number; elapsedMs: number; error?: unknown }) => void;
  onTrace?: (candidates: RecallCandidateTrace[]) => void;
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
  const trackTrace = Boolean(options.onTrace);
  const candidates: CorpusMemorySearchResult[] = [];
  const traces: RecallCandidateTrace[] = [];
  const traceByCandidate = new Map<CorpusMemorySearchResult, RecallCandidateTrace>();
  const endCandidatePrep = startTiming("candidatePrepMs", timings, signal);
  try {
    let retrievalRank = 0;
    for (const hit of hits) {
      // Defense in depth before disclosing passages to the external judge.
      if (options.corpora && !options.corpora.includes("all") && !options.corpora.includes(hit.corpus)) continue;
      const excerpt = hit.snippet.trim();
      if (!excerpt || excerpt.length > MEMORY_PASSAGE_CHARS) continue;
      const passageId = memoryPassageId(excerpt);
      if (options.excludedPassages?.has(passageId)) {
        if (trackTrace) {
          retrievalRank++;
          traces.push({
            hit: { ...hit, snippet: excerpt },
            passageId,
            locator: resolveLocator(hit, passageId),
            retrievalRank,
            retrievalScore: hit.score,
            disposition: "cooldown",
          });
        }
        continue;
      }
      if (duplicateMemoryPassage({ ...hit, text: excerpt }, candidates.map(candidate => ({ ...candidate, text: candidate.snippet })))) continue;
      const candidate: CorpusMemorySearchResult = { ...hit, snippet: excerpt };
      candidates.push(candidate);
      if (trackTrace) {
        retrievalRank++;
        const trace: RecallCandidateTrace = {
          hit: candidate,
          passageId,
          locator: resolveLocator(candidate, passageId),
          retrievalRank,
          retrievalScore: hit.score,
          disposition: "unjudged_cap",
        };
        traces.push(trace);
        traceByCandidate.set(candidate, trace);
      }
    }
  } finally { endCandidatePrep(); }
  observation.eligible = candidates.length;
  options.onCandidates?.(observation);
  const fallback = (reason: NonNullable<MemoryRanking["fallbackReason"]>) => {
    // Stable retrieval-score ordering (fused RRF scores from discovery) before maxResults truncation.
    // These retrieval scores are not decision model usefulness probabilities.
    const ranked = [...candidates].sort((a, b) => b.score - a.score);
    const limit = options.maxResults ?? 5;
    const results = ranked.slice(0, limit);
    if (trackTrace) {
      for (const [index, candidate] of results.entries()) {
        const trace = traceByCandidate.get(candidate);
        if (trace) {
          trace.disposition = "returned";
          trace.finalRank = index + 1;
        }
      }
      options.onTrace?.(traces);
    }
    return { ...timings, ...observation, rankingMode: "retrieval" as const, fallbackReason: reason, results };
  };
  const conversation = "status" in options.conversation
    ? options.conversation
    : selectJudgeConversation(options.conversation);
  if (conversation.status === "input_too_large" || !options.apiKey) {
    signal?.throwIfAborted();
    if (options.allowRetrievalFallback) {
      return fallback(conversation.status === "input_too_large" ? "input_too_large" : "key_unavailable");
    }
    if (trackTrace) options.onTrace?.(traces);
    return { ...timings, ...observation, rankingMode: "decision", results: [] };
  }
  const maxJudge = typeof options.maxJudgeCandidates === "number" && Number.isFinite(options.maxJudgeCandidates)
    ? Math.max(0, Math.floor(options.maxJudgeCandidates))
    : undefined;
  const judgePool = maxJudge !== undefined
    ? [...candidates].sort((a, b) => b.score - a.score).slice(0, maxJudge)
    : candidates;
  const minUsefulness = options.minUsefulness ?? 0.7;
  const apiKey = options.apiKey;
  const endJudge = startTiming("judgeMs", timings, signal);
  let judged: { result: CorpusMemorySearchResult; trace?: RecallCandidateTrace }[];
  try {
    judged = (await Promise.all(judgePool.map(async (hit, candidateIndex) => {
      const requestStarted = performance.now();
      const trace = trackTrace ? traceByCandidate.get(hit) : undefined;
      try {
        const { probability } = await judgeMemoryPassage(memoryUsefulnessRequest(conversation, {
          excerpt: hit.snippet, corpus: hit.corpus, sourcePath: hit.path,
          dates: [...new Set(hit.sessionMessages?.flatMap(message => message.timestamp ? [message.timestamp] : [])
            ?? (hit.messageTimestamp ? [hit.messageTimestamp] : []))],
        }, asOf, options.model), { ...options, apiKey });
        signal?.throwIfAborted();
        observation.requestsSucceeded++;
        options.onJudgment?.({ candidateIndex, elapsedMs: performance.now() - requestStarted });
        if (trace) {
          trace.usefulnessScore = probability;
          trace.disposition = probability >= minUsefulness ? "rank_limit" : "below_threshold";
        }
        // Discovery reciprocal ranks are not vector similarity or usefulness.
        const { vectorScore: _vectorScore, textScore: _textScore, ...result } = hit;
        const scored: CorpusMemorySearchResult = { ...result, score: probability };
        return [{ result: scored, trace }];
      } catch (error) {
        if (signal?.aborted) return [];
        observation.requestsFailed++;
        if (trace) trace.disposition = "judge_failed";
        options.onJudgment?.({ candidateIndex, elapsedMs: performance.now() - requestStarted, error });
        return [];
      }
    }))).flat();
  } finally { endJudge(); }
  signal?.throwIfAborted();
  observation.judgeMs = timings.judgeMs ?? 0;
  if (options.allowRetrievalFallback && judgePool.length && !observation.requestsSucceeded)
    return fallback("all_judgments_failed");
  const passed = judged
    .filter(({ result }) => result.score >= minUsefulness)
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, options.maxResults ?? 5);
  if (trackTrace) {
    for (const [index, entry] of passed.entries()) {
      if (entry.trace) {
        entry.trace.disposition = "passed";
        entry.trace.finalRank = index + 1;
      }
    }
    options.onTrace?.(traces);
  }
  return { ...timings, ...observation, rankingMode: "decision", results: passed.map(entry => entry.result) };
}
