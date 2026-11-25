import { classifyDecisionFailure, DecisionError, matchesDecisionModel, type DecisionResult, type ExtractionResult, type FieldMap, type QuestionMap } from "@unblocklabs/decisions";
import { Type } from "typebox";
import type { UnblockMemoryConfig } from "./config.js";
export { classifyDecisionFailure, matchesDecisionModel, DecisionError as DecisionRequestError, };
export declare const NOUL_SCHEMA: Type.TObject<{
    type: Type.TLiteral<"noul">;
    noul: Type.TNumber;
}>;
export declare const NOUL_ANSWERS_SCHEMA: Type.TObject<{
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
export declare const DEFAULT_DECISION_MODEL: string;
export declare function decisionModelScope(model?: string, endpoint?: string): string;
/** A conservative estimate of serialized size, not a model-specific tokenizer. Non-ASCII is budgeted separately. */
export declare function estimateDecisionTokens(value: unknown): number;
/** A decision-model deadline: the request's own timeout, or the caller's timed-out signal. */
export declare function isDecisionTimeout(error: unknown, signal: AbortSignal): boolean;
/** Explicit credentials take precedence; a missing explicit file never selects another key. */
export declare function resolveDecisionCredential(config: Pick<UnblockMemoryConfig["decisionModel"], "enabled" | "apiKey" | "apiKeyFile"> & {
    endpoint?: string;
}): Promise<string | undefined>;
/** Typed extraction call backed directly by @unblocklabs/decisions. */
export declare function extractWithModel<const F extends FieldMap>(params: DecisionRequestOptions, state: string, fields: F, options?: {
    validateModel?: boolean;
}): Promise<ExtractionResult<F>>;
/** Typed decision call backed directly by @unblocklabs/decisions. */
export declare function decideWithModel<const Q extends QuestionMap>(params: DecisionRequestOptions, state: unknown, questions: Q, options?: {
    validateModel?: boolean;
    allowExtraAnswerKeys?: boolean;
}): Promise<DecisionResult<Q>>;
/**
 * Low-level raw JSON decision request backed by @unblocklabs/decisions `decideRaw()`,
 * for callers that intentionally tolerate partial multi-question responses (e.g. Safety Whisperer).
 */
export declare function requestDecision(params: DecisionRequestOptions, state: unknown, questions: unknown): Promise<unknown>;
