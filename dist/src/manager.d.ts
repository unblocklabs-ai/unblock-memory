import type { QMDStore, VectorSearchResult } from "@unblocklabs/qmd";
import { type AnalysisRunner, type MemoryAnalysisSummary, type MemoryClusterDetail, type MemoryClusterList, type MemoryClusterSort, type MemoryReclusterOptions } from "./analysis.js";
import type { CorpusMemorySearchResult, CorpusSearchOptions, MemoryEmbeddingProbeResult, MemoryProviderStatus, MemoryReadResult, MemoryRequestContext, MemorySearchManagerContract, MemorySyncParams } from "./contracts.js";
import type { ChatType } from "./config.js";
import { type MaintenanceStatus, type MaintenanceTask, type TemporalBasis } from "./curation.js";
import { type SessionSyncResult } from "./session-sync.js";
import { type SessionMessageSpan } from "./session-projector.js";
import { type ResolvedSource } from "./sources.js";
import { type QualityCursor } from "./quality-audit.js";
import { qualityTaskPresence } from "./quality-triage.js";
import { reviewIndexedClaim } from "./evidence-review.js";
import { reviewClusterIngestion } from "./cluster-review.js";
export type ManagerStore = Pick<QMDStore, "update" | "embed" | "getStatus" | "listCollections" | "searchLex" | "vsearch" | "get" | "getDocumentBody" | "close">;
export type ManagerSessionConfig = {
    agentId: string;
    agentName: string;
    chatTypes: readonly ChatType[];
    maxExpandedTokens: number;
    collection: string;
    databasePath: string;
    manifestPath: string;
    outputDir: string;
    timezone: string;
};
export type SkillSearchCandidate = {
    name: string;
    description: string;
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
export declare function expandSessionSearchHit(result: Pick<VectorSearchResult, "body" | "bestChunk" | "chunkPos" | "chunkLen">, maxTokens: number, countTokens: (text: string) => Promise<number>, maxChars?: number, messages?: SessionMessageSpan[]): Promise<{
    text: string;
    position: number;
    sourceText?: string;
}>;
export declare class QmdMemoryManager implements MemorySearchManagerContract {
    #private;
    diagnostics(): Promise<{
        projectorVersion: number;
        semanticChunkingVersion: number | null | undefined;
        sessionsNeedingProjection: number;
        needsEmbedding: number;
        embeddingReady: boolean;
        structuralChunksOmitted: number | null;
        retrieval: {
            scope: string;
            operations: {
                [k: string]: {
                    calls: number;
                    outcomes: {
                        cancelled?: number | undefined;
                        ok?: number | undefined;
                        skipped?: number | undefined;
                        failed?: number | undefined;
                        empty?: number | undefined;
                        timed_out?: number | undefined;
                    };
                    measurements: {
                        [k: string]: {
                            total: number;
                            samples: number;
                            recentSamples: number;
                            p50: number | null;
                            p95: number | null;
                        };
                    };
                };
            };
        };
        scope: string;
    }>;
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
    reviewClaim(params: Omit<Parameters<typeof reviewIndexedClaim>[0], "db" | "sources" | "read"> & {
        corpora: readonly string[];
    }): Promise<{
        status: "unavailable";
        verdict: "insufficient_evidence";
        needsReview: boolean;
        reason: string;
    } | {
        evidence: {
            path: string;
            from: number;
            lines: number;
            documentHash: string;
            excerptHash: string;
        }[];
        policy: string;
        scope: string;
        needsReview: boolean;
        background?: {
            backgroundOnly: number;
            explicitSupport: number;
        } | undefined;
        verdict: "supports" | "contradicts" | "insufficient_evidence";
        confidence: number;
        probabilities: {
            supports: number;
            contradicts: number;
            insufficient_evidence: number;
        };
        status: "ok";
    }>;
    reviewCluster(params: Omit<Parameters<typeof reviewClusterIngestion>[0], "db" | "sources" | "read"> & {
        corpora: readonly string[];
    }): Promise<{
        status: "unavailable";
        reason: string;
        sample?: undefined;
        considered?: undefined;
        runId?: undefined;
        clusterSize?: undefined;
    } | {
        status: "ok";
        runId: string;
        clusterId: string;
        members: {
            flagged: boolean;
            defect: "encoding" | "wrapper" | "boilerplate" | "none_or_uncertain";
            confidence: number;
            path: string;
            hash: string;
            seq: number;
            from: number;
            fingerprint: string;
        }[];
        recurring: {
            defect: string;
            examples: {
                path: string;
                from: number;
                fingerprint: string;
            }[];
        }[];
        sampled: number;
        considered: number;
        clusterSize: number | undefined;
        policy: string;
        scope: string;
        reason?: undefined;
    }>;
    fetchCluster(params: {
        clusterId: string;
        topK?: number;
        offset?: number;
        sort?: MemoryClusterSort;
    }): Promise<MemoryClusterDetail>;
    listMaintenanceTasks(params?: {
        status?: MaintenanceStatus;
        limit?: number;
    }): Promise<(MaintenanceTask & {
        indexPresence?: ReturnType<typeof qualityTaskPresence>;
    })[]>;
    auditQuality(params: {
        corpora: readonly string[];
        apiKey: string;
        timeoutMs: number;
        minNoise: number;
        limit?: number;
        after?: QualityCursor;
        signal: AbortSignal;
    }): Promise<{
        status: "ok" | "partial";
        done: boolean;
        next: QualityCursor | undefined;
        scanned: number;
        judged: number;
        cached: number;
        skippedOversized: number;
        skippedStale: number;
        flagged: number;
        groups: {
            corpus: string;
            source: string;
            reason: string;
            pending: number;
            examples: MaintenanceTask[];
            triage: ReturnType<typeof import("./quality-triage.js").qualityTriage>;
        }[];
        policy: string;
        scope: string;
    } | {
        status: "busy";
    } | {
        status: "unavailable";
    }>;
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
    }): MaintenanceTask | undefined;
    search(query: string, opts?: CorpusSearchOptions): Promise<CorpusMemorySearchResult[]>;
    /** Whisperer-only discovery: exact trained recipe, no query-conditioned reranker or merged cap. */
    searchWhisperer(queries: readonly string[], opts: Pick<CorpusSearchOptions, "corpora" | "signal" | "maxSnippetChars">): Promise<CorpusMemorySearchResult[]>;
    searchSkills(query: string, minScore: number, limit: number): Promise<SkillSearchCandidate[]>;
    readFile(params: {
        relPath: string;
        from?: number;
        lines?: number;
        requestContext?: MemoryRequestContext;
    }): Promise<MemoryReadResult>;
    status(): MemoryProviderStatus;
    probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
    probeVectorAvailability(): Promise<boolean>;
    close(): Promise<void>;
}
