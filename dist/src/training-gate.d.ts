import type { TrainingInput } from "./training-input.js";
export declare const TRAINING_GATE_VERSION = "historical-recall-v2";
export declare const TRAINING_GATE_MODEL: string;
export declare const TRAINING_GATE_THRESHOLD: number;
export declare const TRAINING_GATE_QUESTIONS: {
    readonly recall_needed: import("@unblocklabs/decisions").NoulQuestion;
};
export declare function judgeTrainingInput(input: TrainingInput, apiKey: string, signal: AbortSignal, options?: {
    endpoint?: string;
    model?: string;
}): Promise<{
    probability: number;
    model: string;
    usage: import("@unblocklabs/decisions").DecisionUsage;
}>;
