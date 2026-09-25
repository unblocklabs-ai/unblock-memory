import type { memoryConversation } from "./whisperer-context.js";
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
    onCandidateFailure?: (index: number, error: unknown) => void;
}): Promise<number | undefined>;
export declare const QUALITY_JUDGE_VERSION = "jev-1.13.0:quality-v3-isolated";
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
/** One HTTP request per candidate, all launched together; result order matches input order. */
export declare function judgeTypeSafeMemories(params: {
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
    conversation: ReturnType<typeof memoryConversation>;
    candidates: readonly {
        excerpt: string;
        corpus: string;
        messageTimestamp?: string;
    }[];
}): Promise<number[]>;
