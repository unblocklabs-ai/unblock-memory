import type { CorpusMemorySearchResult, CorpusSearchOptions } from "./contracts.js";
import type { QueryConversation, QueryPair } from "./query-contract.js";
export type MemoryCandidateManager = {
    searchCandidates(queries: QueryPair, options: CorpusSearchOptions): Promise<CorpusMemorySearchResult[]>;
};
export declare function memoryPassageId(text: string): string;
export type MemorySearchObservation = {
    retrievalMs: number;
    judgeMs: number;
    candidates: number;
    eligible: number;
    requestsSucceeded: number;
    requestsFailed: number;
};
/** Both entry points use the same complete passages and independent usefulness judgments. */
export declare function searchMemory(manager: MemoryCandidateManager, queries: QueryPair, options: CorpusSearchOptions & {
    apiKey: string;
    timeoutMs: number;
    conversation: QueryConversation;
    asOf?: string;
    minUsefulness?: number;
    excludedPassages?: ReadonlyMap<string, number>;
    onCandidates?: (observation: MemorySearchObservation) => void;
    onJudgment?: (event: {
        candidateIndex: number;
        elapsedMs: number;
        error?: unknown;
    }) => void;
}): Promise<MemorySearchObservation & {
    results: CorpusMemorySearchResult[];
}>;
