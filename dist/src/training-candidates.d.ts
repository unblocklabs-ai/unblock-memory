import type { QMDStore } from "@unblocklabs/qmd";
import type { QueryLane } from "./query-contract.js";
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
export declare function trainingCandidates(qmd: QMDStore, query: string, collection: string | string[], lane: QueryLane, signal?: AbortSignal): Promise<Candidate[]>;
export {};
