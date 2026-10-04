import type { QMDStore } from "@unblocklabs/qmd";
import type { QueryLane } from "./query-contract.js";
/** Runtime and training share the exact ten-candidate recipe, not hybrid ranking. */
export declare function trainingCandidates(qmd: QMDStore, query: string, collection: string | string[], lane: QueryLane, signal?: AbortSignal): Promise<{
    vector?: {
        score: number;
        rank: number;
    } | undefined;
    bm25?: {
        score: number;
        rank: number;
    } | undefined;
    file: string;
    body: string;
    bestChunk: string;
    bestChunkPos: number;
    score: number;
    explain: {
        methods: ("vector" | "bm25")[];
    };
}[]>;
