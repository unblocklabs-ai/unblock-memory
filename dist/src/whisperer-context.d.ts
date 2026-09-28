/** Only visible user/assistant text; never system, tool, image, or thinking blocks. */
export declare function messageText(message: unknown): {
    role: "user" | "assistant";
    text: string;
} | undefined;
export declare function buildSkillWhispererQuery(prompt: string, messages: readonly unknown[], historyMessages: number): string;
