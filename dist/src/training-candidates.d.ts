import type { QMDStore } from "@unblocklabs/qmd";
type Candidate = {
    file: string;
    body: string;
    bestChunk: string;
    bestChunkPos: number;
    score: number;
    explain: {
        methods: string[];
    };
    vector?: {
        score: number;
        rank: number;
    };
    bm25?: {
        score: number;
        rank: number;
    };
};
export declare function trainingCandidates(qmd: QMDStore, query: string, collection: string | string[], intent: string, signal?: AbortSignal): Promise<Candidate[]>;
export {};
