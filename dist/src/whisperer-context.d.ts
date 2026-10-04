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
