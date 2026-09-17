import type { UnblockMemoryConfig } from "./config.js";
import type { memoryConversation } from "./whisperer-context.js";
type TypeSafeConfig = UnblockMemoryConfig["typesafe"];
/** Explicit credentials take precedence; a missing explicit file never selects another key. */
export declare function resolveTypeSafeApiKey(config: TypeSafeConfig): Promise<string | undefined>;
/** Select from trusted candidates; never accept a provider-generated path or skill name. */
export declare function selectTypeSafeSkill(params: {
    apiKey: string;
    timeoutMs: number;
    currentRequest: string;
    history: readonly {
        role: "user" | "assistant";
        content: string;
    }[];
    candidates: readonly {
        name: string;
        description: string;
    }[];
}): Promise<number | undefined>;
/** Independent usefulness judgments in one request, indexed only by caller-owned IDs. */
export declare function judgeTypeSafeMemories(params: {
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
    conversation: ReturnType<typeof memoryConversation>;
    candidates: readonly {
        excerpt: string;
        corpus: string;
        startedAt?: number;
    }[];
}): Promise<number[]>;
export {};
