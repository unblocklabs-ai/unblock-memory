import { classifyDecisionFailure, DEFAULT_DECISIONS_MODEL, DecisionError, decisionModelScope, defaultDecisionModel, LEGACY_SYSTEMONE_ENDPOINT, matchesDecisionModel, type DecisionResult, type QuestionMap } from "@unblocklabs/decisions";
import { Type } from "typebox";
import type { UnblockMemoryConfig } from "./config.js";
export { classifyDecisionFailure, decisionModelScope, defaultDecisionModel, LEGACY_SYSTEMONE_ENDPOINT, matchesDecisionModel, DEFAULT_DECISIONS_MODEL as TYPESAFE_MODEL, DecisionError as TypeSafeRequestError, };
export declare const TYPESAFE_NOUL_SCHEMA: Type.TObject<{
    type: Type.TLiteral<"noul">;
    noul: Type.TNumber;
}>;
export declare const TYPESAFE_NOUL_ANSWERS_SCHEMA: Type.TObject<{
    answers: Type.TRecord<"^.*$", Type.TObject<{
        type: Type.TLiteral<"noul">;
        noul: Type.TNumber;
    }>>;
}>;
type DecisionRequestOptions = {
    apiKey: string;
    endpoint?: string;
    model?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
};
/** A conservative estimate of serialized size, not a model-specific tokenizer. Non-ASCII is budgeted separately. */
export declare function estimateJevTokens(value: unknown): number;
/** A decision-model deadline: the request's own timeout, or the caller's timed-out signal. */
export declare function isTypeSafeTimeout(error: unknown, signal: AbortSignal): boolean;
/** Explicit credentials take precedence; a missing explicit file never selects another key. */
export declare function resolveTypeSafeApiKey(config: Pick<UnblockMemoryConfig["decisionModel"], "enabled" | "apiKey" | "apiKeyFile"> & {
    endpoint?: string;
}): Promise<string | undefined>;
/** Typed decision call backed directly by @unblocklabs/decisions. */
export declare function decideWithModel<const Q extends QuestionMap>(params: DecisionRequestOptions, state: unknown, questions: Q, options?: {
    validateModel?: boolean;
    allowExtraAnswerKeys?: boolean;
}): Promise<DecisionResult<Q>>;
/**
 * Low-level raw JSON decision request backed by @unblocklabs/decisions `decideRaw()`,
 * for callers that intentionally tolerate partial multi-question responses (e.g. Safety Whisperer).
 */
export declare function requestTypeSafe(params: DecisionRequestOptions, state: unknown, questions: unknown): Promise<unknown>;
