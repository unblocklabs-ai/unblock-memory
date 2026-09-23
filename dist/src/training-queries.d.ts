import type { UnblockMemoryConfig } from "./config.js";
import type { TrainingInput } from "./training-input.js";
import { historicalTrainingSearch } from "./training-retrieval.js";
import type { QueryEvaluation, TrainingStore } from "./training-store.js";
type Source = {
    databasePath: string;
    agentId: string;
    stateDir: string;
};
type Options = {
    maxExamples?: number;
    dryRun?: boolean;
    threshold?: number;
};
export declare const TRAINING_EVALUATION_CONCURRENCY = 4;
export declare function generateTrainingQueries(source: Source, store: TrainingStore, runtime: unknown, options: Options & {
    maxInputBytes: number;
    concurrency?: number;
}): Promise<{
    threshold: number;
    model: string;
    examples: number;
    calls: number;
    completed: number;
    cached: number;
    failed: number;
    ambiguous: number;
    blocked: number;
    inputBytes: number;
    budgetLimited: boolean;
    refreshed: {
        sessions: number;
        excludedSessions: number;
        oversizedSessions: number;
        eligible: number;
        users: number;
        filtered: number;
        oversized: number;
        unanswered: number;
        added: number;
        changed: number;
        unchanged: number;
        retired: number;
    };
}>;
export declare function selectTrainingQueries(queries: QueryEvaluation[]): string[];
export declare function evaluateTrainingQueries(source: Source, store: TrainingStore, config: UnblockMemoryConfig, options: Options & {
    maxCalls?: number;
    concurrency?: number;
    excludeJudgments?: string[];
}, createSearch?: typeof historicalTrainingSearch): Promise<{
    concurrency: number;
    threshold: number;
    retrievalMethod: string;
    callUnit: string;
    retrievals: number;
    evaluated: number;
    awaitingTeacher: number;
    examples: number;
    calls: number;
    completed: number;
    cached: number;
    failed: number;
    ambiguous: number;
    blocked: number;
    inputBytes: number;
    budgetLimited: boolean;
    refreshed: {
        sessions: number;
        excludedSessions: number;
        oversizedSessions: number;
        eligible: number;
        users: number;
        filtered: number;
        oversized: number;
        unanswered: number;
        added: number;
        changed: number;
        unchanged: number;
        retired: number;
    };
}>;
export declare function exportQueryTraining(store: TrainingStore, threshold?: number): Generator<{
    stage: string;
    input: TrainingInput;
    inputHash: string;
    recallProbability: number;
    threshold: number;
    target: string[];
    source: {
        nodeId: string;
        agentId: string;
        sourceId: string;
    };
    evaluation: {
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
    splitGroup: string;
    provenance: {
        id: string;
        stage: import("node:sqlite").SQLOutputValue;
        request: unknown;
        result: unknown;
        completedAt: import("node:sqlite").SQLOutputValue;
    }[];
}, void, unknown>;
export {};
