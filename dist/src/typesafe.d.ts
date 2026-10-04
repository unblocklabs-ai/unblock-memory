import type { QueryConversation } from "./query-contract.js";
/** Select from trusted candidates; never accept a provider-generated path or skill name. */
export declare function selectTypeSafeSkill(params: {
    apiKey: string;
    timeoutMs: number;
    signal?: AbortSignal;
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
export declare const MEMORY_JUDGE_VERSION = "jev-1.13.0:memory-usefulness-v2";
export type MemoryPassage = {
    excerpt: string;
    corpus: string;
    sourcePath: string;
    dates: readonly string[];
};
/** The sole versioned passage prompt/state builder for both training and runtime. */
export declare function memoryUsefulnessRequest(conversation: QueryConversation, candidate: MemoryPassage, asOf: string): {
    model: string;
    state: {
        conversation: {
            history: {
                role: "user" | "assistant";
                content: string;
            }[];
            currentRequest: string;
        };
        asOf: string;
        candidates: {
            excerpt: string;
            corpus: string;
            sourcePath: string;
            dates: readonly string[];
        }[];
    };
    questions: {
        memory_0: {
            type: string;
            instructions: string;
            criteria: {
                true: string;
                false: string;
            };
        };
    };
};
export declare function judgeMemoryPassage(request: ReturnType<typeof memoryUsefulnessRequest>, params: {
    apiKey: string;
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<{
    probability: number;
    answer: {
        type: "noul";
        noul: number;
    };
    model: "jev-1.13.0";
    usage: {
        input_tokens: number;
        output_tokens: number;
    } | null;
}>;
