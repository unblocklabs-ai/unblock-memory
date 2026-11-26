import type { CorpusMemorySearchResult, CorpusSearchOptions } from "./contracts.js";
import type { QueryConversation, QueryPair } from "./query-contract.js";
import { selectJudgeConversation } from "./judge-context.js";
import { type RetrievalTimings } from "./retrieval-timing.js";
import { type RecallHitDisposition, type RecallHitLocator } from "./recall-ledger.js";
export type MemoryCandidateManager = {
    searchCandidates(queries: QueryPair, options: CorpusSearchOptions): Promise<CorpusMemorySearchResult[]>;
};
export declare function memoryPassageId(text: string): string;
export type MemorySearchObservation = RetrievalTimings & {
    retrievalMs: number;
    judgeMs: number;
    candidates: number;
    eligible: number;
    requestsSucceeded: number;
    requestsFailed: number;
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
/** Both entry points use the same complete passages and independent usefulness judgments. */
export declare function searchMemory(manager: MemoryCandidateManager, queries: QueryPair, options: CorpusSearchOptions & {
    apiKey?: string;
    endpoint?: string;
    model?: string;
    timeoutMs: number;
    conversation: QueryConversation | ReturnType<typeof selectJudgeConversation>;
    asOf?: string;
    /** Only explicit, agent-requested search opts in. Automatic injection stays strict. */
    allowRetrievalFallback?: boolean;
    /** Cap top retrieval-ranked candidates sent to the decision endpoint (after dedup and cooldown filtering). */
    maxJudgeCandidates?: number;
    minUsefulness?: number;
    excludedPassages?: ReadonlyMap<string, number>;
    onCandidates?: (observation: MemorySearchObservation) => void;
    onJudgment?: (event: {
        candidateIndex: number;
        elapsedMs: number;
        error?: unknown;
    }) => void;
    onTrace?: (candidates: RecallCandidateTrace[]) => void;
}): Promise<MemorySearchObservation & MemoryRanking & {
    results: CorpusMemorySearchResult[];
}>;
