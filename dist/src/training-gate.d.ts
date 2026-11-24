import type { TrainingInput } from "./training-input.js";
export declare const TRAINING_GATE_VERSION = "historical-recall-v2";
export declare const TRAINING_GATE_MODEL = "liquid/d1.2-ultra";
export declare const TRAINING_GATE_THRESHOLD = 0.7;
export declare const TRAINING_GATE_QUESTIONS: {
    recall_needed: {
        type: string;
        instructions: {
            question: string;
            history: string;
            scope: string;
            timeWindow: string;
            trust: string;
        };
        criteria: {
            true: string;
            false: string;
        };
    };
};
export declare function judgeTrainingInput(input: TrainingInput, apiKey: string, signal: AbortSignal, options?: {
    endpoint?: string;
    model?: string;
}): Promise<{
    probability: number;
    model: string;
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
}>;
