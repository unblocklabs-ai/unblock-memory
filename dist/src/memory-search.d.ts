import type { CorpusMemorySearchResult, CorpusSearchOptions } from "./contracts.js";
import type { QueryConversation, QueryPair } from "./query-contract.js";
import { selectJudgeConversation } from "./judge-context.js";
import { type BrightnessRecipe } from "./memory-brightness.js";
import { type RetrievalTimings } from "./retrieval-timing.js";
import { type RecallHitDisposition, type RecallHitLocator } from "./recall-ledger.js";
export type MemoryCandidateManager = {
    searchCandidates(queries: QueryPair, options: CorpusSearchOptions): Promise<CorpusMemorySearchResult[]>;
    /**
     * Optional: run every topic inside one serialized job (one queue slot, one metadata/store setup) instead of
     * queueing each topic separately behind background indexing. Settles per topic, in topic order.
     */
    searchCandidateTopics?(topics: readonly QueryPair[], options: CorpusSearchOptions): Promise<PromiseSettledResult<CorpusMemorySearchResult[]>[]>;
    /**
     * Optional: `hits` minus any Fleet Commons hit no longer servable from the live cache under the running `allowExpired`
     * policy (retired, superseded or expired since retrieval). Non-Fleet hits always pass through unchanged.
     */
    activeFleetHits?<T extends Pick<CorpusMemorySearchResult, "path">>(hits: readonly T[]): T[];
};
export declare function memoryPassageId(text: string): string;
export type MemorySearchObservation = RetrievalTimings & {
    retrievalMs: number;
    judgeMs: number;
    candidates: number;
    eligible: number;
    requestsSucceeded: number;
    requestsFailed: number;
    /** Multi-topic searches only: topic searches that failed while at least one other topic succeeded. */
    topicsFailed?: number;
    /** Decision-model tokens summed across every judged candidate that reported usage. */
    inputTokens?: number;
    outputTokens?: number;
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
type SearchBrightness = {
    recipe: BrightnessRecipe;
    weight?: number;
    maxBoost?: number;
    lookup?: (subjects: readonly string[]) => Map<string, {
        normalized: number;
        samples: number;
    }> | undefined;
};
/**
 * Both entry points use the same complete passages and independent usefulness judgments.
 * A single query pair (or one-element list) searches exactly as before; 2+ topic pairs search together (one
 * manager job when supported) and fuse with passage-level RRF, reserving a judge slot and a finalist slot per topic.
 */
export declare function searchMemory(manager: MemoryCandidateManager, queries: QueryPair | readonly QueryPair[], options: CorpusSearchOptions & {
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
    /** Adjust finalist order only, after usefulness gating. Returned scores remain unadjusted. */
    brightness?: SearchBrightness;
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
export {};
