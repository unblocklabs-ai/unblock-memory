import type { TrainingInput } from "./training-input.js";
import type { TrainingHit } from "./training-retrieval.js";
export declare const CONTEXT_JUDGE_VERSION = "jev-1.13.0:memory-usefulness-v2";
export declare function contextJudgeRequest(input: TrainingInput, asOf: string, hit: TrainingHit): {
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
export declare function judgeTrainingPassage(request: ReturnType<typeof contextJudgeRequest>, apiKey: string): Promise<{
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
