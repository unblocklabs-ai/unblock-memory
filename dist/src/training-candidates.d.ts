import type { AllowedDocumentPaths, QMDStore, VectorSearchTrace } from "@unblocklabs/qmd";
import type { QueryLane } from "./query-contract.js";
/** Runtime and training share the exact ten-candidate recipe, not hybrid ranking. */
export declare function trainingCandidates(qmd: QMDStore, query: string, collection: string | string[], lane: QueryLane, signal?: AbortSignal, allowedPaths?: AllowedDocumentPaths, trace?: VectorSearchTrace): Promise<{
    vector?: {
        score: number;
        rank: number;
    } | undefined;
    bm25?: {
        score: number;
        rank: number;
    } | undefined;
    score: number;
    explain: {
        methods: ("vector" | "bm25")[];
    };
    ref?: import("@unblocklabs/qmd").PassageRef | undefined;
    file: string;
    body: string;
    bestChunk: string;
    bestChunkPos: number;
}[]>;
