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
export declare const QUALITY_JUDGE_VERSION = "jev-1.13.0:quality-v2-json";
export type QualityJudgment = {
    noise: number;
    evidence: number;
};
/** These are indicators for review, never authorization to delete or rewrite. */
export declare function judgeTypeSafeQuality(params: {
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
    chunks: readonly {
        text: string;
        sourceKind: "files" | "sessions";
    }[];
}): Promise<QualityJudgment[]>;
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
