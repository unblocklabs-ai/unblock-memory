export declare const MAX_SKILL_QUERY_CHARS = 12000;
export declare const MAX_STATE_TOKENS = 24000;
/** Only visible user/assistant text; never system, tool, image, or thinking blocks. */
export declare function messageText(message: unknown): {
    role: "user" | "assistant";
    text: string;
} | undefined;
export declare function recentSkillMessages(messages: readonly unknown[], limit: number): {
    role: "user" | "assistant";
    text: string;
}[];
export declare function buildSkillWhispererQuery(prompt: string, history: readonly NonNullable<ReturnType<typeof messageText>>[]): string;
/** Collect whole recent entries from newest to oldest within a token budget, returning oldest first. */
export declare function takeRecentWithinTokens<In, Out = In>(items: readonly In[], options: {
    endIndex?: number;
    maxItems?: number;
    maxTokens: number;
    usedTokens: number;
    estimateTokens: (item: Out) => number;
    transform?: (item: In) => Out | undefined;
}): {
    items: Out[];
    usedTokens: number;
};
