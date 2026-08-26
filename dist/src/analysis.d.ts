import type { QMDStore } from "@unblocklabs/qmd";
type AnalysisDatabase = QMDStore["internal"]["db"];
export type MemoryReclusterOptions = {
    space?: {
        method?: "umap" | "none";
        nComponents?: number;
        nNeighbors?: number;
        minDist?: number;
    };
    hdbscan?: {
        minClusterSize?: number;
        minSamples?: number;
        clusterSelectionMethod?: "eom" | "leaf";
        clusterSelectionEpsilon?: number;
        allowSingleCluster?: boolean;
    };
    seed?: number;
};
export type AnalysisRunner = (params: {
    executable: string;
    dbPath: string;
    options?: MemoryReclusterOptions;
    signal?: AbortSignal;
}) => Promise<void>;
type MemoryAnalysisMember = {
    hash: string;
    seq: number;
    probability: number;
    outlierScore: number;
    x: number;
    y: number;
    representativeRank: number | null;
    sourceDate: string;
    text: string;
    sourcePaths: string[];
};
export type MemoryClusterSort = "representative" | "score_desc" | "score_asc" | "date_desc" | "date_asc";
export type MemoryAnalysisSummary = {
    status: "ok";
    runId: string;
    createdAt: string;
    completedAt: string;
    inputDigest: string;
    model: string;
    embeddingFingerprint: string;
    dimensions: number;
    clusters: number;
    members: number;
    noise: number;
    stale: boolean;
    staleSince: string | null;
};
type MemoryClusterSummary = {
    clusterId: string;
    size: number;
    availableSize: number;
    meanProbability: number;
    preview?: Pick<MemoryAnalysisMember, "hash" | "seq" | "probability" | "text" | "sourcePaths">;
};
type AnalysisReadMetadata = {
    stale: boolean;
    staleSince: string | null;
    analyzedAt: string | null;
    hint?: string;
};
export type MemoryClusterList = AnalysisReadMetadata & {
    status: "ok" | "not_analyzed";
    runId?: string;
    clusters: MemoryClusterSummary[];
    noise: MemoryClusterSummary | null;
};
export type MemoryClusterDetail = AnalysisReadMetadata & {
    status: "ok" | "not_found" | "not_analyzed";
    runId?: string;
    cluster?: Omit<MemoryClusterSummary, "preview">;
    members?: MemoryAnalysisMember[];
    page?: {
        offset: number;
        returned: number;
        total: number;
        hasMore: boolean;
        nextOffset?: number;
    };
};
export declare function ensureMemoryAnalysisSchema(db: AnalysisDatabase): void;
export declare function markMemoryAnalysisStale(db: AnalysisDatabase): void;
export declare function clusterReference(runId: string, clusterId: number): string;
export declare function runAnalysisWorker(params: {
    executable: string;
    dbPath: string;
    options?: MemoryReclusterOptions;
    signal?: AbortSignal;
}): Promise<void>;
export declare function latestAnalysisRunId(db: AnalysisDatabase): string | undefined;
export declare function readAnalysisSummary(db: AnalysisDatabase): MemoryAnalysisSummary | undefined;
export declare function readClusters(db: AnalysisDatabase, requestedLimit?: number): MemoryClusterList;
export declare function readCluster(db: AnalysisDatabase, clusterReferenceId: string, requestedLimit?: number, requestedOffset?: number, sort?: MemoryClusterSort): MemoryClusterDetail;
export {};
