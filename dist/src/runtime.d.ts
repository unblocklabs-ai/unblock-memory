import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { CorpusConfig } from "./config.js";
import type { ExtractionConfig } from "./extraction-config.js";
import type { MemoryPluginRuntimeContract } from "./contracts.js";
import { QmdMemoryManager, type ManagerSessionConfig, type SkillCatalogEntry } from "./manager.js";
import { type SessionSyncResult } from "./session-sync.js";
export type SessionSyncStatus = {
    status: "idle";
} | {
    status: "running";
    phase: "queued" | "projecting" | "indexing";
    startedAt: string;
} | ({
    status: "completed";
    startedAt: string;
    completedAt: string;
} & SessionSyncResult) | {
    status: "failed";
    startedAt: string;
    completedAt: string;
    error: string;
};
export type SessionSyncStartResult = {
    status: "started";
    startedAt: string;
} | {
    status: "already_running";
    startedAt: string;
} | {
    status: "unavailable";
    error: string;
};
export declare class QmdMemoryRuntime implements MemoryPluginRuntimeContract {
    #private;
    startSessionSyncSchedule(cfg: OpenClawConfig, onError: (error: unknown) => void): void;
    stopSessionSyncSchedule(): void;
    constructor(corpora: readonly CorpusConfig[], options?: {
        analysisExecutable?: string;
        keepEmbeddingModelWarm?: boolean;
        stateRoot?: string;
        extraction?: ExtractionConfig;
        syntheticInput?: ManagerSessionConfig["syntheticInput"];
        recallLedgerEnabled?: boolean;
        onError?: (error: unknown) => void;
    });
    memoryDatabasePath(agentId: string): string;
    searchableCorpora(): string[];
    getMemorySearchManager(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }): Promise<{
        manager: null;
        error: string;
    } | {
        manager: QmdMemoryManager;
        error?: undefined;
    }>;
    resolveMemoryBackendConfig(): {
        backend: "builtin";
    };
    classifyWorkspaceMemoryPaths: NonNullable<MemoryPluginRuntimeContract["classifyWorkspaceMemoryPaths"]>;
    startSessionSync(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }, force?: boolean): Promise<SessionSyncStartResult>;
    sessionSyncStatus(agentId: string): Promise<SessionSyncStatus>;
    prepareReload(change: Parameters<NonNullable<MemoryPluginRuntimeContract["prepareReload"]>>[0]): ReturnType<NonNullable<MemoryPluginRuntimeContract["prepareReload"]>>;
    closeMemorySearchManager(params: {
        agentId: string;
    }): Promise<void>;
    closeAllMemorySearchManagers(): Promise<void>;
    close(): Promise<void>;
    searchSkills(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }, query: string, minScore: number, limit: number): Promise<import("./manager.js").SkillSearchCandidate[]>;
    listSkills(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }): Promise<SkillCatalogEntry[]>;
    resolveSkillPath(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }, path: string): string | undefined;
}
