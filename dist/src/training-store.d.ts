import { type TrainingExample, type TrainingInput } from "./training-input.js";
import { type judgeTrainingInput } from "./training-gate.js";
import type { TeacherResult } from "./training-models.js";
import type { TrainingHit } from "./training-retrieval.js";
import type { parseContextJudgment } from "./training-judge.js";
type GateResult = Awaited<ReturnType<typeof judgeTrainingInput>>;
type Job = {
    id: string;
    inputHash: string;
    inputJson: string;
};
export type TrainingSourceExample = {
    id: string;
    inputHash: string;
    inputJson: string;
    sessionId: string;
    timestamp: number;
};
export type QueryEvaluation = {
    query: string;
    retrievalId: string;
    score: number;
    judgments?: {
        id: string;
        excluded: boolean;
    }[];
};
type TrainingEvaluation = {
    sourceId: string;
    inputHash: string;
    timestamp: number;
    corpusHash: string;
    teacherId: string;
    corpusReport: {
        sessions: number;
        chunks: number;
        excluded: number;
        truncated: number;
        excludedChunks: number;
    };
    queries: QueryEvaluation[];
    selected: string[];
};
export type TrainingStepResults = {
    generate: TeacherResult;
    retrieve: {
        query: string;
        maxDate: string;
        corpusHash: string;
        hits: TrainingHit[];
    };
    judge: ReturnType<typeof parseContextJudgment> | {
        excluded: true;
        reason: "operator-exclusion";
    };
    evaluate: TrainingEvaluation;
};
type StepStatus = "pending" | "attempted" | "complete" | "failed" | "ambiguous";
export declare class TrainingStore {
    #private;
    constructor(path: string, agentId: string);
    locked<T>(fn: () => T | Promise<T>): Promise<T>;
    renew(): void;
    sessions(): string[];
    syncSession(sessionId: string, examples: TrainingExample[], since: number, until: number, existingOnly: boolean): {
        added: number;
        changed: number;
        unchanged: number;
        retired: number;
    };
    unavailable(sessionId: string): void;
    pending(limit?: number): Job[];
    start(id: string): number;
    finish(id: string, attempt: number, result: GateResult | {
        status: "failed" | "ambiguous";
        error: string;
    }): void;
    retry(includeAmbiguous: boolean): number;
    activeExamples(): TrainingSourceExample[];
    queryExamples(threshold?: number): {
        recallProbability: number;
        id: string;
        inputHash: string;
        inputJson: string;
        sessionId: string;
        timestamp: number;
    }[];
    step<S extends keyof TrainingStepResults>(stage: S, request: unknown): {
        id: string;
        stage: S;
        request: unknown;
        status: StepStatus;
        result: TrainingStepResults[S] | undefined;
    };
    judgmentExcluded(identity: string): boolean;
    startStep(stage: keyof TrainingStepResults, id: string, request: unknown): number;
    finishStep<S extends keyof TrainingStepResults>(stage: S, id: string, attempt: number, outcome: {
        result: TrainingStepResults[S];
    } | {
        status: "failed" | "ambiguous";
        error: string;
    }): void;
    completedEvaluations(versions?: {
        selection: string;
        retrieval: string;
    }): TrainingEvaluation[];
    sourceDetails(id: string): {
        nodeId: string;
        agentId: string;
        sourceId: string;
    };
    stepRecord(id: string): {
        id: string;
        stage: import("node:sqlite").SQLOutputValue;
        request: unknown;
        result: unknown;
        completedAt: import("node:sqlite").SQLOutputValue;
    };
    status(threshold: number): {
        nodeId: string;
        agentId: string;
        preparation: string;
        promptVersion: string;
        requestedModel: string;
        threshold: number;
        examples: Record<string, import("node:sqlite").SQLOutputValue>[];
        collectedInputs: number;
        queryInputs: number;
        stages: Record<string, import("node:sqlite").SQLOutputValue>[];
        complete: number;
        positive: number;
        inputTokens: number;
        outputTokens: number;
        negative: number;
        queryStages: Record<string, import("node:sqlite").SQLOutputValue>[];
        queryAttempts: Record<string, import("node:sqlite").SQLOutputValue>[];
        attempts: Record<string, import("node:sqlite").SQLOutputValue>[];
    };
    exportRows(threshold: number): Generator<{
        stage: string;
        inputHash: import("node:sqlite").SQLOutputValue;
        preparation: string;
        input: TrainingInput;
        recallProbability: import("node:sqlite").SQLOutputValue;
        recallNeeded: boolean;
        threshold: number;
        model: import("node:sqlite").SQLOutputValue;
        promptVersion: import("node:sqlite").SQLOutputValue;
        usage: {
            input_tokens: import("node:sqlite").SQLOutputValue;
            output_tokens: import("node:sqlite").SQLOutputValue;
        };
        sources: {
            nodeId: string;
            agentId: string;
        }[];
    }, void, unknown>;
    close(): void;
}
export {};
