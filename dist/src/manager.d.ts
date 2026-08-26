import type { QMDStore } from "@unblocklabs/qmd";
import { type AnalysisRunner, type MemoryAnalysisSummary, type MemoryClusterDetail, type MemoryClusterList, type MemoryReclusterOptions } from "./analysis.js";
import type { CorpusMemorySearchResult, CorpusSearchOptions, MemoryEmbeddingProbeResult, MemoryProviderStatus, MemoryReadResult, MemorySearchManagerContract, MemorySyncParams } from "./contracts.js";
import type { ChatType } from "./config.js";
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
        workspaceDir: string;
        sources: readonly ResolvedSource[];
        storeFactory?: () => Promise<ManagerStore>;
        analysisExecutable?: string;
        analysisRunner?: AnalysisRunner;
        sessions?: ManagerSessionConfig;
    });
    start(): Promise<void>;
    sync(params?: MemorySyncParams): Promise<void>;
    syncSessions(force?: boolean): Promise<SessionSyncResult>;
    recluster(options?: MemoryReclusterOptions, signal?: AbortSignal): Promise<MemoryAnalysisSummary>;
    listClusters(limit?: number): Promise<MemoryClusterList>;
    fetchCluster(params: {
        clusterId: string;
        topK?: number;
    }): Promise<MemoryClusterDetail>;
    search(query: string, opts?: CorpusSearchOptions): Promise<CorpusMemorySearchResult[]>;
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
