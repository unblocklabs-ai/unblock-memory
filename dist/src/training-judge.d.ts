import type { TrainingInput } from "./training-input.js";
import type { TrainingHit } from "./training-retrieval.js";
export declare const CONTEXT_JUDGE_VERSION: string;
export declare function contextJudgeRequest(input: TrainingInput, asOf: string, hit: TrainingHit, model?: string): {
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
        readonly memory_0: import("@unblocklabs/decisions").NoulQuestion;
    };
};
export declare function judgeTrainingPassage(request: ReturnType<typeof contextJudgeRequest>, apiKey: string, options?: {
    endpoint?: string;
    model?: string;
}): Promise<{
    probability: number;
    answer: {
        type: "noul";
        noul: number;
    };
    model: string;
    usage: import("@unblocklabs/decisions").DecisionUsage | null;
}>;
