import type { ExtractionConfig } from "./extraction-config.js";
import { type FleetCommonsConfig, type FleetCommonsSyncResult } from "./fleet-commons.js";
import type { QMDStore } from "@unblocklabs/qmd";
import { type AnalysisRunner, type MemoryAnalysisSummary, type MemoryClusterDetail, type MemoryClusterList, type MemoryClusterSort, type MemoryReclusterOptions } from "./analysis.js";
import type { CorpusMemorySearchResult, CorpusSearchOptions, MemoryEmbeddingProbeResult, MemoryProviderStatus, MemoryReadCursor, MemoryReadResult, MemoryRequestContext, MemorySearchManagerContract, MemorySyncParams } from "./contracts.js";
import type { ChatType } from "./config.js";
import { type MaintenanceStatus, type MaintenanceTask, type TemporalBasis } from "./curation.js";
import { type SessionSyncResult } from "./session-sync.js";
import { type SessionManifest } from "./session-sync-state.js";
import { type ResolvedSource } from "./sources.js";
import { type QualityCursor } from "./quality-audit.js";
import { qualityTaskPresence } from "./quality-triage.js";
import { reviewIndexedClaim } from "./evidence-review.js";
import { reviewClusterIngestion } from "./cluster-review.js";
import type { QueryPair } from "./query-contract.js";
export { expandSessionSearchHit } from "./memory-passage.js";
type MemoryReadParams = {
    relPath: string;
    from?: number;
    lines?: number;
    cursor?: MemoryReadCursor;
    requestContext?: MemoryRequestContext;
};
export type ManagerStore = Pick<QMDStore, "update" | "embed" | "getStatus" | "listCollections" | "vsearch" | "get" | "close" | "upsertDocument" | "retractDocument" | "syncProjectedCollection" | "getCollectionGeneration"> & Partial<Pick<QMDStore, "addCollection">>;
export type ManagerSessionConfig = {
    agentId: string;
    agentName: string;
    chatTypes: readonly ChatType[];
    maxExpandedTokens: number;
    collection: string;
    databasePath: string;
    /** `unblock-memory.sqlite`: holds the session manifest (QMD holds the projected documents). */
    statePath: string;
    /** Pre-0.18 state directory whose `sessions-manifest.json` is imported once on upgrade. */
    legacyStateDir?: string;
    timezone: string;
    syntheticInput?: import("./synthetic-input.js").SyntheticInputFilterConfig;
};
export type SkillCatalogEntry = {
    name: string;
    description: string;
    path: string;
};
export type SkillSearchCandidate = SkillCatalogEntry & {
    score: number;
};
export declare function readSkillCatalogEntry(path: string): SkillCatalogEntry;
export declare function enableSecureDelete(store: QMDStore): void;
export declare function cleanupRemovedDocuments(store: QMDStore, changedDocuments?: number): number;
export declare function buildReadResult({ content, path, from: start, lines, cursor }: {
    content: string;
    path: string;
    from?: number;
    lines?: number;
    cursor?: MemoryReadCursor;
}): MemoryReadResult;
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
                        partial?: number | undefined;
                        ok?: number | undefined;
                        empty?: number | undefined;
                        degraded?: number | undefined;
                        timed_out?: number | undefined;
                        cancelled?: number | undefined;
                        skipped?: number | undefined;
                        failed?: number | undefined;
                    };
                    slowestRecent: {
                        outcome: "partial" | "ok" | "empty" | "degraded" | "timed_out" | "cancelled" | "skipped" | "failed";
                        setupMs?: number | undefined;
                        queueWaitMs?: number | undefined;
                        metadataMs?: number | undefined;
                        storeSetupMs?: number | undefined;
                        bm25Ms?: number | undefined;
                        vectorMs?: number | undefined;
                        vectorIndexCheckMs?: number | undefined;
                        vectorScopeMs?: number | undefined;
                        embeddingMs?: number | undefined;
                        vectorScanMs?: number | undefined;
                        hydrationMs?: number | undefined;
                        vectorMappingMs?: number | undefined;
                        vectorOtherMs?: number | undefined;
                        passageMs?: number | undefined;
                        candidatePrepMs?: number | undefined;
                        retrievalOtherMs?: number | undefined;
                        otherMs?: number | undefined;
                        retrievalMs?: number | undefined;
                        judgeMs?: number | undefined;
                        generationMs?: number | undefined;
                        metadataReloads?: number | undefined;
                        vectorScanAttempts?: number | undefined;
                        elapsedMs?: number | undefined;
                        candidates?: number | undefined;
                        eligible?: number | undefined;
                        results?: number | undefined;
                        contextChars?: number | undefined;
                        requestsSucceeded?: number | undefined;
                        requestsFailed?: number | undefined;
                        fallbackKeyUnavailable?: number | undefined;
                        fallbackAllJudgmentsFailed?: number | undefined;
                    }[];
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
        extraction?: ExtractionConfig;
        fleetCommons?: FleetCommonsConfig;
        workspaceDir: string;
        sources: readonly ResolvedSource[];
        storeFactory?: () => Promise<ManagerStore>;
        keepModelsWarm?: boolean;
        analysisExecutable?: string;
        analysisRunner?: AnalysisRunner;
        sessions?: ManagerSessionConfig;
        trackRecallLocators?: boolean;
    });
    start(): Promise<void>;
    /**
     * Current QMD generation of every collection behind `corpora` (omitted or `["all"]` = every indexed collection), for
     * caches that must invalidate on any indexed change. Unknown corpora throw. Reads committed state without waiting
     * behind queued indexing, so a snapshot is never newer than what a search issued now could observe.
     */
    getCollectionGenerations(corpora?: readonly string[]): Promise<Record<string, number>>;
    syncExtracted(): Promise<void>;
    /**
     * Pull the Fleet Commons feed into SQLite (authoritative) and its projected QMD collection. The HTTP fetch and
     * validation run outside `#operationChain`; only the SQLite replace and QMD projection queue behind indexing like every
     * other write. `disabled` when `fleetCommons.enabled` is false.
     */
    syncFleetCommons(signal?: AbortSignal): Promise<FleetCommonsSyncResult>;
    /**
     * Delivery-time recheck of already-selected hits (a raw Fleet entry can be retired or expire while a caller judges it):
     * Fleet hits not in the live cache under the running `allowExpired` policy are dropped. A cache that cannot be read
     * fails closed for Fleet hits only.
     */
    activeFleetHits<T extends Pick<CorpusMemorySearchResult, "path">>(hits: readonly T[]): T[];
    sync(params?: MemorySyncParams): Promise<void>;
    syncSessions(force?: boolean, onPhase?: (phase: "projecting" | "indexing") => void, options?: {
        persist?: (manifest: SessionManifest) => void;
        signal?: AbortSignal;
        beforeWrite?: () => void;
    }): Promise<SessionSyncResult>;
    /** Trusted corpus name behind a native QMD collection id (`source-…`); skills and unknown ids are `undefined`. */
    corpusForCollection(collection: string): string | undefined;
    /**
     * Runs the external HDBSCAN worker OUTSIDE `#operationChain`: only the short preflight and the result read are
     * queued, so foreground `memory_search` / Memory Whisperer turns never wait behind a minutes-long child process.
     * Concurrent reclusters still run one at a time (`#reclusterInFlight`), and `close()` waits for a running worker.
     * Input that changed while the worker ran (a sync marked analysis stale) leaves the new run marked stale too.
     */
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
        verdict: "supports" | "contradicts" | "insufficient_evidence";
        confidence: number;
        probabilities: Record<"supports" | "contradicts" | "insufficient_evidence", number>;
        background: {
            backgroundOnly: number;
            explicitSupport: number;
        };
        needsReview: boolean;
        status: "ok";
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
        verdict: "supports" | "contradicts" | "insufficient_evidence";
        confidence: number;
        probabilities: Record<"supports" | "contradicts" | "insufficient_evidence", number>;
        needsReview: boolean;
        background?: undefined;
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
        endpoint?: string;
        model?: string;
        timeoutMs: number;
        minNoise: number;
        limit?: number;
        after?: QualityCursor;
        signal: AbortSignal;
    }): Promise<{
        status: "partial" | "ok";
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
    /** Shared discovery: exact trained recipe, scoped before either retrieval lane. */
    searchCandidates(queries: QueryPair, opts: CorpusSearchOptions): Promise<CorpusMemorySearchResult[]>;
    /**
     * Multi-topic discovery in ONE serialized job: one queue slot behind background indexing, one metadata refresh
     * and store setup, then each topic's lanes in order. A failed topic settles alone; cancellation fails the job.
     */
    searchCandidateTopics(topics: readonly QueryPair[], opts: CorpusSearchOptions): Promise<PromiseSettledResult<CorpusMemorySearchResult[]>[]>;
    listSkills(): Promise<SkillCatalogEntry[]>;
    skillAliases(canonicalPath: string): readonly string[];
    searchSkills(query: string, minScore: number, limit: number): Promise<SkillSearchCandidate[]>;
    readFile(params: MemoryReadParams & {
        cursor?: undefined;
    }): Promise<Exclude<MemoryReadResult, {
        status: "stale_cursor";
    }>>;
    readFile(params: MemoryReadParams): Promise<MemoryReadResult>;
    status(): MemoryProviderStatus;
    probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
    probeVectorAvailability(): Promise<boolean>;
    close(): Promise<void>;
}
