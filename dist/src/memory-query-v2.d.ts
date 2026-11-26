import type { QueryConversation, QueryPair } from "./query-contract.js";
export type DecisionAccess = {
    apiKey: string;
    endpoint?: string;
    model?: string;
    timeoutMs?: number;
};
export type RecallGateDecision = {
    shouldRecall: boolean;
    /** Selected corpora; empty when the gate skips recall. */
    corpora: string[];
    gateScore?: number;
    corpusScores?: Record<string, number>;
    /** Set when the gate call failed and recall failed open across every configured corpus. */
    error?: {
        cause: unknown;
    };
};
export type RecallPlan = {
    shouldRecall: boolean;
    corpora: string[];
    topics: QueryPair[];
    /** Grounded verbatim anchors behind `topics`; empty when deterministic fallback queries are used. */
    anchors: string[];
    gateScore?: number;
    queryFallback: boolean;
    gateFallback?: {
        cause: unknown;
    };
    extractionFallback?: {
        reason: "error" | "no_grounded_topics";
        cause?: unknown;
    };
};
type PlanStage = "gate" | "extraction";
/** Plain-text transcript for `/v1/extractions`, so returned spans index into exact conversation text. */
export declare function conversationText(conversation: QueryConversation): string;
/** Truncate to at most `maxChars` UTF-16 units without leaving a lone high surrogate. */
export declare function sliceHeadSafe(text: string, maxChars: number): string;
/**
 * Keep only anchors that occur verbatim (case-insensitively) inside a conversation message, never only in
 * role labels. Exact spans are preferred when they agree with the value. Deduplicates and caps at `max`.
 */
export declare function groundAnchors(conversation: QueryConversation, values: readonly unknown[], spans: readonly (readonly [number, number])[] | undefined, max?: number): string[];
/** One lexical/semantic pair per grounded anchor, bounded like deterministic fallback queries. */
export declare function topicQueries(anchors: readonly string[], currentRequest: string): QueryPair[];
/** Step 1: one batched decision call deciding whether to recall at all and which corpora to search. */
export declare function recallGate(params: DecisionAccess & {
    conversation: QueryConversation;
    asOf: string;
    corpora: readonly string[];
    signal: AbortSignal;
    minGateScore?: number;
    minCorpusScore?: number;
    gateTimeoutMs?: number;
}): Promise<RecallGateDecision>;
/** Gate, route and extract. Fails open to deterministic queries; rethrows only turn cancellation. */
export declare function planRecall(params: DecisionAccess & {
    conversation: QueryConversation;
    asOf: string;
    corpora: readonly string[];
    signal: AbortSignal;
    onStage?: (stage: PlanStage) => void;
    minGateScore?: number;
    minCorpusScore?: number;
    maxTopics?: number;
    gateTimeoutMs?: number;
    extractTimeoutMs?: number;
}): Promise<RecallPlan>;
export {};
