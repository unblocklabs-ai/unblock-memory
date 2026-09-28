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
    version: string;
    model: string;
    revision: string;
    conversationTokens: number;
    conversationBytes: number;
    contextTokens: number;
    outputTokens: number;
    system: string;
};
export declare class QueryInputBudgetError extends Error {
    constructor();
}
export declare function parseQueryPair(value: unknown): QueryPair;
/** Escape template delimiters identically in the student worker and dataset preparation. */
export declare function serializeQueryConversation(conversation: QueryConversation): string;
export declare function queryTokenIds(text: string): number[];
/** Never alter the current request or split a history message. */
export declare function prepareQueryConversation(history: QueryConversation["history"], currentRequest: string): {
    conversation: QueryConversation;
    contextLimited: boolean;
};
