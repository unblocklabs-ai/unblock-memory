import { type NoulQuestion } from "@unblocklabs/decisions";
import type { QueryConversation } from "./query-contract.js";
/** Rank independent applicability judgments; only code maps answers to catalog entries. */
export declare function scoreSkillCatalog(params: {
    apiKey: string;
    endpoint?: string;
    model?: string;
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
    minUsefulness?: number;
    maxMatches?: number;
    batchSize?: number;
    onBatchFailure?: (batchIndex: number, error: unknown) => void;
}): Promise<Array<{
    index: number;
    score: number;
}>>;
export declare function qualityJudgeVersion(model?: string, endpoint?: string): string;
export type QualityJudgment = {
    noise: number;
    evidence: number;
};
/** These are indicators for review, never authorization to delete or rewrite. */
export declare function judgeQuality(params: {
    apiKey: string;
    endpoint?: string;
    model?: string;
    timeoutMs: number;
    signal: AbortSignal;
    chunks: readonly {
        text: string;
        sourceKind: "files" | "sessions";
    }[];
}): Promise<QualityJudgment[]>;
export declare function memoryJudgeVersion(model?: string, endpoint?: string): string;
export declare const MEMORY_JUDGE_VERSION: string;
export type MemoryPassage = {
    excerpt: string;
    corpus: string;
    sourcePath: string;
    dates: readonly string[];
};
/** The sole versioned passage prompt/state builder for both training and runtime. */
export declare function memoryUsefulnessRequest(conversation: QueryConversation, candidate: MemoryPassage, asOf: string, model?: string): {
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
        readonly memory_0: NoulQuestion;
    };
};
export declare function judgeMemoryPassage(request: ReturnType<typeof memoryUsefulnessRequest>, params: {
    apiKey: string;
    endpoint?: string;
    model?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<{
    probability: number;
    answer: {
        type: "noul";
        noul: number;
    };
    model: string;
    usage: import("@unblocklabs/decisions").DecisionUsage | null;
}>;
