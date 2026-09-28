import { type TrainingExample, type TrainingInput } from "./training-input.js";
import { type judgeTrainingInput } from "./training-gate.js";
import { type TeacherResult, type TrainingRound } from "./training-models.js";
import type { TrainingHit } from "./training-retrieval.js";
import type { judgeTrainingPassage } from "./training-judge.js";
import type { QueryLane, QueryPair } from "./query-contract.js";
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
    lane: QueryLane;
    round: TrainingRound;
    retrievalId: string;
    score: number;
    maxProbability: number;
    judgments: string[];
};
type TrainingEvaluation = {
    sourceId: string;
    inputHash: string;
    timestamp: number;
    corpusHash: string;
    teacherIds: string[];
    corpusReport: {
        sessions: number;
        chunks: number;
        excluded: number;
        truncated: number;
        excludedChunks: number;
    };
    queries: QueryEvaluation[];
    selected: QueryPair | null;
    review: string[];
};
export type TrainingStepResults = {
    generate: TeacherResult;
    retrieve: {
        query: string;
        lane: QueryLane;
        maxDate: string;
        corpusHash: string;
        hits: TrainingHit[];
    };
    judge: Awaited<ReturnType<typeof judgeTrainingPassage>>;
    score: QueryEvaluation;
    evaluate: TrainingEvaluation;
};
type StepStatus = "pending" | "attempted" | "complete" | "failed" | "ambiguous";
type ReviewDetails = {
    steps: string[];
} | {
    lanes: string[];
    evaluationId: string;
} | {
    timestamp: number;
};
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
    retry(includeAmbiguous: boolean, ids: readonly string[]): number;
    activeExamples(): TrainingSourceExample[];
    queryExamples(threshold?: number): {
        recallProbability: number;
        id: string;
        inputHash: string;
        inputJson: string;
        sessionId: string;
        timestamp: number;
    }[];
    step<S extends keyof TrainingStepResults>(stage: S, parameters: Record<string, unknown>): {
        id: string;
        stage: S;
        request: {
            recipe: string;
        };
        status: StepStatus;
        result: TrainingStepResults[S] | undefined;
    };
    flagReview(example: TrainingSourceExample, reason: string, details: ReviewDetails): void;
    clearReview(sourceId: string): void;
    reviews(): {
        sourceId: string;
        inputHash: string;
        reason: string;
        details: ReviewDetails;
        updatedAt: number;
    }[];
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
        judge: string;
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
    stepRecordStatus(id: string): StepStatus | undefined;
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
        recipe: string;
        reviews: {
            sourceId: string;
            inputHash: string;
            reason: string;
            details: ReviewDetails;
            updatedAt: number;
        }[];
        retryable: Record<string, import("node:sqlite").SQLOutputValue>[];
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
