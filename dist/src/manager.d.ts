import type { QMDStore } from "@unblocklabs/qmd";
import { type AnalysisRunner, type MemoryAnalysisSummary, type MemoryClusterDetail, type MemoryClusterList, type MemoryClusterSort, type MemoryReclusterOptions } from "./analysis.js";
import type { CorpusMemorySearchResult, CorpusSearchOptions, MemoryEmbeddingProbeResult, MemoryProviderStatus, MemoryReadResult, MemorySearchManagerContract, MemorySyncParams } from "./contracts.js";
import type { ChatType } from "./config.js";
import { type MaintenanceStatus, type TemporalBasis } from "./curation.js";
import { type SessionSyncResult } from "./session-sync.js";
import { type ResolvedSource } from "./sources.js";
export type ManagerStore = Pick<QMDStore, "update" | "embed" | "getStatus" | "listCollections" | "searchLex" | "vsearch" | "get" | "getDocumentBody" | "close">;
export type ManagerSessionConfig = {
    agentId: string;
    agentName: string;
    chatTypes: readonly ChatType[];
    collection: string;
    databasePath: string;
    manifestPath: string;
    outputDir: string;
    timezone: string;
};
export type SkillSearchCandidate = {
    name: string;
    path: string;
    score: number;
};
export declare function enableSecureDelete(store: QMDStore): void;
export declare function cleanupRemovedDocuments(store: QMDStore, changedDocuments?: number): number;
export declare function pruneStaleCollections(store: QMDStore, configuredCollections: ReadonlySet<string>): Promise<number>;
export declare function buildReadResult(params: {
    content: string;
    path: string;
    from?: number;
    lines?: number;
}): MemoryReadResult;
export declare class QmdMemoryManager implements MemorySearchManagerContract {
    #private;
    constructor(params: {
        dbPath: string;
        curationPath?: string;
        workspaceDir: string;
        sources: readonly ResolvedSource[];
        storeFactory?: () => Promise<ManagerStore>;
        keepModelsWarm?: boolean;
        analysisExecutable?: string;
        analysisRunner?: AnalysisRunner;
        sessions?: ManagerSessionConfig;
    });
    start(): Promise<void>;
    sync(params?: MemorySyncParams): Promise<void>;
    syncSessions(force?: boolean, onPhase?: (phase: "projecting" | "indexing") => void): Promise<SessionSyncResult>;
    recluster(options?: MemoryReclusterOptions, signal?: AbortSignal): Promise<MemoryAnalysisSummary>;
    listClusters(limit?: number): Promise<MemoryClusterList>;
    fetchCluster(params: {
        clusterId: string;
        topK?: number;
        offset?: number;
        sort?: MemoryClusterSort;
    }): Promise<MemoryClusterDetail>;
    listMaintenanceTasks(params?: {
        status?: MaintenanceStatus;
        limit?: number;
    }): import("./curation.js").MaintenanceTask[];
    updateMaintenanceTask(params: {
        id: string;
        status: Exclude<MaintenanceStatus, "pending">;
        note?: string;
        annotation?: {
            scope: "chunk" | "document";
            eventTime: string;
            basis: TemporalBasis;
            evidence: string;
        };
    }): import("./curation.js").MaintenanceTask | undefined;
    search(query: string, opts?: CorpusSearchOptions): Promise<CorpusMemorySearchResult[]>;
    searchSkills(query: string, minScore: number, limit: number): Promise<SkillSearchCandidate[]>;
    readFile(params: {
        relPath: string;
        from?: number;
        lines?: number;
    }): Promise<MemoryReadResult>;
    status(): MemoryProviderStatus;
    probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
    probeVectorAvailability(): Promise<boolean>;
    close(): Promise<void>;
}
