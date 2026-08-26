import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { CorpusConfig } from "./config.js";
import type { MemoryPluginRuntimeContract } from "./contracts.js";
import { QmdMemoryManager } from "./manager.js";
import type { SessionSyncResult } from "./session-sync.js";
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
type StoredSessionSyncStatus = Exclude<SessionSyncStatus, {
    status: "idle";
}>;
type StoredRunningSessionSync = Extract<StoredSessionSyncStatus, {
    status: "running";
}> & {
    pid: number;
};
export declare function recoverInterruptedSessionSync(directory: string, statusPath: string, stale: StoredRunningSessionSync): Promise<SessionSyncStatus>;
export declare class QmdMemoryRuntime implements MemoryPluginRuntimeContract {
    #private;
    constructor(corpora: readonly CorpusConfig[], options?: {
        analysisExecutable?: string;
        keepEmbeddingModelWarm?: boolean;
        stateRoot?: string;
    });
    getMemorySearchManager(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }): Promise<{
        manager: QmdMemoryManager;
        error?: undefined;
    } | {
        manager: null;
        error: string;
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
    closeMemorySearchManager(params: {
        agentId: string;
    }): Promise<void>;
    closeAllMemorySearchManagers(): Promise<void>;
}
export {};
