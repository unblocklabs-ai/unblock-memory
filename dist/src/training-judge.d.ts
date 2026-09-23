import type { TrainingInput } from './training-input.js';
import type { TrainingHit } from './training-retrieval.js';
export declare const CONTEXT_JUDGE_VERSION = "conversation-context-usefulness-v1";
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
        passage: {
            text: string;
            sourcePath: string;
            dates: string[];
        };
    };
    questions: {
        usefulness: {
            type: string;
            instructions: {
                question: string;
                task: string;
                identity: string;
                value: string;
                time: string;
                limits: string;
                trust: string;
            };
            criteria: string[];
        };
    };
};
export declare function parseContextJudgment(payload: unknown): {
    score: number;
    answer: {
        type: "score";
        confidence: number;
        probabilities: {
            '0': number;
            '1': number;
            '2': number;
            '3': number;
        };
        score: number;
    };
    model: "jev-1.13.0";
    usage: {
        input_tokens: number;
        output_tokens: number;
    } | null;
};
export declare function judgeTrainingPassage(request: ReturnType<typeof contextJudgeRequest>, apiKey: string): Promise<{
    score: number;
    answer: {
        type: "score";
        confidence: number;
        probabilities: {
            '0': number;
            '1': number;
            '2': number;
            '3': number;
        };
        score: number;
    };
    model: "jev-1.13.0";
    usage: {
        input_tokens: number;
        output_tokens: number;
    } | null;
}>;
