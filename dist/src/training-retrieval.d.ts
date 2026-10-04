import type { ChatType } from "./config.js";
import type { SessionMessageSpan } from "./session-projector.js";
import type { QueryLane } from "./query-contract.js";
export declare const TRAINING_RETRIEVAL_VERSION = "qmd-2.10.2-historical-lanes-depth10-v3:complete-excerpt-1200-v1";
export declare const TRAINING_SEARCH_OPTIONS: {
    readonly vector: 10;
    readonly bm25: 10;
    readonly mergedLimit: null;
    readonly rerank: false;
};
export type TrainingHit = {
    path: string;
    corpus: string;
    text: string;
    dates: string[];
    position: number;
    startLine: number;
    endLine: number;
    score: number;
    methods: string[];
};
/** Missing historical evidence is reviewable; unexpected SQLite/I/O failures remain fatal. */
export declare class HistoricalCorpusUnavailableError extends Error {
}
/** Never infer dates by parsing message bodies: headings can be quoted or forged. */
export declare function historicalPrefix(body: string, spans: readonly SessionMessageSpan[] | undefined, cutoff: number): {
    body: string;
    spans: SessionMessageSpan[];
} | undefined;
/** Capture source bytes once per run; each cutoff still owns its index and native model context. */
export declare function historicalTrainingSource(stateDir: string, chatTypes: readonly ChatType[]): Promise<(cutoff: number, openStore?: typeof import("@unblocklabs/qmd")["createStore"]) => Promise<{
    corpusHash: string;
    report: {
        sessions: number;
        chunks: number;
        excluded: number;
        truncated: number;
        excludedChunks: number;
    };
    maxDate: string;
    search: (query: string, lane: QueryLane) => Promise<TrainingHit[]>;
    close: () => Promise<void>;
}>>;
/** Standalone calls get a fresh source capture; evaluation runs reuse their own capture. */
export declare function historicalTrainingSearch(stateDir: string, chatTypes: readonly ChatType[], cutoff: number, openStore?: typeof import("@unblocklabs/qmd")["createStore"]): Promise<{
    corpusHash: string;
    report: {
        sessions: number;
        chunks: number;
        excluded: number;
        truncated: number;
        excludedChunks: number;
    };
    maxDate: string;
    search: (query: string, lane: QueryLane) => Promise<TrainingHit[]>;
    close: () => Promise<void>;
}>;
