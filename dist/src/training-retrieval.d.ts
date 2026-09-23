import type { ChatType } from "./config.js";
import type { SessionMessageSpan } from "./session-projector.js";
export declare const TRAINING_RETRIEVAL_VERSION = "qmd-2.10.1-historical-prefix-depth10-v2";
export declare const TRAINING_SEARCH_OPTIONS: {
    readonly vector: 10;
    readonly bm25: 10;
    readonly mergedLimit: null;
    readonly rerank: false;
};
export type TrainingHit = {
    path: string;
    text: string;
    dates: string[];
    position: number;
    score: number;
    methods: string[];
};
/** Never infer dates by parsing message bodies: headings can be quoted or forged. */
export declare function historicalPrefix(body: string, spans: readonly SessionMessageSpan[] | undefined, cutoff: number): {
    body: string;
    spans: SessionMessageSpan[];
} | undefined;
/** A read-only source snapshot, copied into a disposable in-memory QMD index.
 * No filesystem projection, live-index mutation, model re-embedding or dependency patch. */
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
    search: (query: string) => Promise<TrainingHit[]>;
    close: () => Promise<void>;
}>;
