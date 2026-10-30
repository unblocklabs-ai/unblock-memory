import { Type } from "typebox";
import type { UnblockMemoryConfig } from "./config.js";
export declare const TYPESAFE_MODEL = "jev-1.13.0";
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
/** A conservative estimate of serialized size, not Jev's tokenizer. Non-ASCII is budgeted separately. */
export declare function estimateJevTokens(value: unknown): number;
export declare class TypeSafeRequestError extends Error {
    readonly code: "timeout" | "cancelled" | "http_error" | "invalid_response" | "network_error";
    readonly status?: number | undefined;
    constructor(message: string, code: "timeout" | "cancelled" | "http_error" | "invalid_response" | "network_error", status?: number | undefined);
}
/** A TypeSafe deadline: the request's own timeout, or the caller's timed-out signal. */
export declare function isTypeSafeTimeout(error: unknown, signal: AbortSignal): boolean;
/** Explicit credentials take precedence; a missing explicit file never selects another key. */
export declare function resolveTypeSafeApiKey(config: UnblockMemoryConfig["typesafe"]): Promise<string | undefined>;
/** One TypeSafe request. The caller owns the response schema and failure policy. */
export declare function requestTypeSafe(params: {
    apiKey: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}, state: unknown, questions: unknown): Promise<unknown>;
