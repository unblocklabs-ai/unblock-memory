import { Type } from "typebox";
import type { UnblockMemoryConfig } from "./config.js";
export declare const TYPESAFE_DEFAULT_ENDPOINT = "https://codex.unblocklabs.ai/v1/decisions";
export declare const TYPESAFE_MODEL = "liquid/d1.2-ultra";
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
export type TypeSafeRequestOptions = {
    apiKey: string;
    endpoint?: string;
    model?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
};
/** Accept the exact requested model, a provider-dated snapshot (e.g. liquid/d1.2-ultra-20261116), or jev-latest -> jev-X.Y.Z. */
export declare function matchesDecisionModel(returned: unknown, requested?: string): returned is string;
export declare function isLoopbackHostname(hostname: string): boolean;
export declare function defaultDecisionModel(endpoint?: string): string;
/** Namespace caches/cohorts by canonical endpoint when a non-default route is used. */
export declare function decisionModelScope(model?: string, endpoint?: string): string;
/** A conservative estimate of serialized size, not Jev's tokenizer. Non-ASCII is budgeted separately. */
export declare function estimateJevTokens(value: unknown): number;
export declare class TypeSafeRequestError extends Error {
    readonly code: "timeout" | "cancelled" | "http_error" | "invalid_response" | "network_error";
    readonly status?: number | undefined;
    readonly retryAfter?: boolean | undefined;
    constructor(message: string, code: "timeout" | "cancelled" | "http_error" | "invalid_response" | "network_error", status?: number | undefined, retryAfter?: boolean | undefined);
}
/** A TypeSafe deadline: the request's own timeout, or the caller's timed-out signal. */
export declare function isTypeSafeTimeout(error: unknown, signal: AbortSignal): boolean;
/** Explicit credentials take precedence; a missing explicit file never selects another key. */
export declare function resolveTypeSafeApiKey(config: Pick<UnblockMemoryConfig["typesafe"], "enabled" | "apiKey" | "apiKeyFile"> & {
    endpoint?: string;
}): Promise<string | undefined>;
/** One decision-model request. The caller owns the response schema and failure policy. */
export declare function requestTypeSafe(params: TypeSafeRequestOptions, state: unknown, questions: unknown): Promise<unknown>;
