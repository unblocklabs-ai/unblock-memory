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
/**
 * Total gate + extraction budget: never more than half of the turn deadline, so at least 50% of
 * `memoryWhisperer.timeoutMs` always remains for QMD search and usefulness judging.
 */
export declare function planningBudgetMs(turnTimeoutMs?: number, planningTimeoutMs?: number): number;
/** Plain-text transcript for `/v1/extractions`, so returned spans index into exact conversation text. */
export declare function conversationText(conversation: QueryConversation): string;
/** Truncate to at most `maxChars` UTF-16 units without leaving a lone high surrogate. */
export declare function sliceHeadSafe(text: string, maxChars: number): string;
/**
 * Keep only anchors that occur verbatim (case-insensitively) inside a conversation message, never only in role
 * labels, and always return the conversation's own text. A span is validated against the body it points into
 * (UTF-16 or code-point offsets) and wins over a substring search. Rejects trivial anchors, deduplicates, and
 * caps at `max`.
 */
export declare function groundAnchors(conversation: QueryConversation, values: readonly unknown[], spans: readonly (readonly [number, number])[] | undefined, max?: number): string[];
/**
 * One lexical/semantic pair per grounded anchor, bounded like deterministic fallback queries. Pairs are
 * deduplicated after bounding and only then capped at `max`, so two anchors that bound to the same query
 * cannot consume two topic slots.
 */
export declare function topicQueries(anchors: readonly string[], currentRequest: string, max?: number): QueryPair[];
/** Step 1: one batched decision call deciding whether to recall at all and which corpora to search. */
export declare function recallGate(params: DecisionAccess & {
    conversation: QueryConversation;
    asOf: string;
    corpora: readonly string[];
    signal: AbortSignal;
    /** Shared planning deadline; expiry fails open like any other gate failure. */
    deadline?: AbortSignal;
    minGateScore?: number;
    minCorpusScore?: number;
    gateTimeoutMs?: number;
}): Promise<RecallGateDecision>;
/**
 * Gate, route and extract in parallel under one planning deadline. A gate skip aborts the in-flight extraction;
 * a passing (or failed-open) gate awaits it. Fails open to deterministic queries; rethrows only turn cancellation.
 */
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
    /** Turn deadline (`memoryWhisperer.timeoutMs`); planning never takes more than half of it. */
    turnTimeoutMs?: number;
    planningTimeoutMs?: number;
}): Promise<RecallPlan>;
export {};
