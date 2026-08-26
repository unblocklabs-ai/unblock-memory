import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { CorpusConfig } from "./config.js";
import type { MemoryPluginRuntimeContract } from "./contracts.js";
import { QmdMemoryManager } from "./manager.js";
export declare class QmdMemoryRuntime implements MemoryPluginRuntimeContract {
    #private;
    constructor(corpora: readonly CorpusConfig[], analysisExecutable?: string);
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
    closeMemorySearchManager(params: {
        agentId: string;
    }): Promise<void>;
    closeAllMemorySearchManagers(): Promise<void>;
}
