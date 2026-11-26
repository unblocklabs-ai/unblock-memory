import type { AllowedDocumentPaths, QMDStore, VectorSearchTrace } from "@unblocklabs/qmd";
import type { QueryLane } from "./query-contract.js";
/** Discover the top ten passages for one lane before fusing lane rankings. */
export declare function discoverLaneCandidates(qmd: QMDStore, query: string, collection: string | string[], lane: QueryLane, signal?: AbortSignal, allowedPaths?: AllowedDocumentPaths, trace?: VectorSearchTrace): Promise<{
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
