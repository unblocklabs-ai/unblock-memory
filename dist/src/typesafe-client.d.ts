import type { UnblockMemoryConfig } from "./config.js";
export declare const TYPESAFE_MODEL = "jev-1.13.0";
export declare class TypeSafeRequestError extends Error {
    readonly code: "timeout" | "cancelled" | "http_error" | "invalid_response" | "network_error";
    readonly status?: number | undefined;
    constructor(message: string, code: "timeout" | "cancelled" | "http_error" | "invalid_response" | "network_error", status?: number | undefined);
}
/** Explicit credentials take precedence; a missing explicit file never selects another key. */
export declare function resolveTypeSafeApiKey(config: UnblockMemoryConfig["typesafe"]): Promise<string | undefined>;
/** One TypeSafe request. The caller owns the response schema and failure policy. */
export declare function requestTypeSafe(params: {
    apiKey: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}, state: unknown, questions: unknown): Promise<unknown>;
