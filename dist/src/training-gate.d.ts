import type { TrainingInput } from "./training-input.js";
export declare const TRAINING_GATE_VERSION = "historical-recall-v1";
export declare const TRAINING_GATE_MODEL = "jev-1.13.0";
export declare const TRAINING_GATE_THRESHOLD = 0.7;
export declare const TRAINING_GATE_QUESTIONS: {
    recall_needed: {
        type: string;
        instructions: {
            question: string;
            history: string;
            scope: string;
            trust: string;
        };
        criteria: {
            true: string;
            false: string;
        };
    };
};
export declare function judgeTrainingInput(input: TrainingInput, apiKey: string, signal: AbortSignal): Promise<{
    probability: number;
    model: "jev-1.13.0";
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
}>;
