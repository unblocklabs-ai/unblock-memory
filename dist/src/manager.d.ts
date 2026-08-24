import type { QMDStore } from "@unblocklabs/qmd";
import type { MemoryEmbeddingProbeResult, MemoryProviderStatus, MemoryReadResult, MemorySearchManagerContract, MemorySearchResult, MemorySyncParams } from "./contracts.js";
import { type ResolvedSource } from "./sources.js";
export type ManagerStore = Pick<QMDStore, "update" | "embed" | "getStatus" | "listCollections" | "searchLex" | "vsearch" | "get" | "getDocumentBody" | "close">;
export declare function enableSecureDelete(store: QMDStore): void;
export declare function cleanupRemovedDocuments(store: QMDStore, changedDocuments?: number): number;
export declare function pruneStaleCollections(store: QMDStore, configuredCollections: ReadonlySet<string>): Promise<void>;
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
    });
    start(): Promise<void>;
    sync(params?: MemorySyncParams): Promise<void>;
    search(query: string, opts?: {
        maxResults?: number;
        minScore?: number;
        lexicalOnly?: boolean;
        sources?: Array<"memory" | "sessions">;
        signal?: AbortSignal;
    }): Promise<MemorySearchResult[]>;
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
