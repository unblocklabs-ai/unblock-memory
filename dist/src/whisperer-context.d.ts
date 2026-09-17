/** Only visible user/assistant text; never system, tool, image, or thinking blocks. */
export declare function messageText(message: unknown): {
    role: "user" | "assistant";
    text: string;
} | undefined;
export declare function memoryConversation(prompt: string, messages: readonly unknown[]): {
    currentRequest: string;
    history: {
        role: "user" | "assistant";
        content: string;
    }[];
    truncated: boolean;
};
