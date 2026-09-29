import type { UnblockMemoryConfig } from "./config.js";
import { type QueryConversation, type QueryPair } from "./query-contract.js";
/** Preserve whole visible messages and the complete current request, never tool/thinking text. */
export declare function queryConversation(prompt: string, messages: readonly unknown[]): QueryConversation;
export declare class QueryApiError extends Error {
    readonly code: "credentials" | "http_error" | "invalid_response" | "unavailable";
    readonly status?: number | undefined;
    constructor(code: "credentials" | "http_error" | "invalid_response" | "unavailable", status?: number | undefined);
}
/** The host owns model warmth/lifecycle; the plugin only sends bounded, cancellable requests. */
export declare class ApiQueryGenerator {
    private readonly config;
    constructor(config: UnblockMemoryConfig["memoryWhisperer"]["api"]);
    generate(conversation: QueryConversation, signal: AbortSignal): Promise<QueryPair>;
}
