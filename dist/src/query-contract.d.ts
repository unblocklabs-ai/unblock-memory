export type QueryLane = "lex" | "vec";
export type QueryPair = Record<QueryLane, string>;
export type QueryConversation = {
    history: {
        role: "user" | "assistant";
        content: string;
    }[];
    currentRequest: string;
};
export declare const QUERY_CONTRACT: {
    readonly revision: "o200k-v1";
    readonly conversationBytes: 24000;
    readonly conversationTokens: 8192;
};
export declare class QueryInputBudgetError extends Error {
    constructor();
}
export declare function parseQueryPair(value: unknown): QueryPair;
/** Escape template delimiters before budgeting the serialized conversation. */
export declare function serializeQueryConversation(conversation: QueryConversation): string;
/** Bounded o200k_base IDs: exact for ordinary text, linear and conservative for long unbroken runs. */
export declare function queryTokenIds(text: string): number[];
/** Never alter the current request or split a history message. */
export declare function prepareQueryConversation(history: QueryConversation["history"], currentRequest: string): {
    conversation: QueryConversation;
    contextLimited: boolean;
};
