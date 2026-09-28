import type { UnblockMemoryConfig } from "./config.js";
import type { QueryPair } from "./query-contract.js";
import { type TrainingInput } from "./training-input.js";
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
    flagged: number;
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
        review: {
            sessionId: string;
            seq: number;
            reason: string;
        }[];
    };
}>;
/** Raw top-three average, including values below runtime's injection threshold. */
export declare function trainingQueryScore(probabilities: readonly number[]): number;
export declare function selectTrainingQueries(queries: readonly QueryEvaluation[]): QueryPair;
export declare function evaluateTrainingQueries(source: Source, store: TrainingStore, config: UnblockMemoryConfig, runtime: unknown, options: Options & {
    maxCalls?: number;
    maxInputBytes?: number;
    concurrency?: number;
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
    flagged: number;
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
        review: {
            sessionId: string;
            seq: number;
            reason: string;
        }[];
    };
}>;
export declare function exportQueryTraining(store: TrainingStore, threshold?: number): Generator<{
    stage: string;
    input: TrainingInput;
    inputHash: string;
    recallProbability: number;
    threshold: number;
    target: QueryPair;
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
