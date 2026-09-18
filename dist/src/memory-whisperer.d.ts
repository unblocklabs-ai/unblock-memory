import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { CorpusMemorySearchResult, CorpusSearchOptions } from "./contracts.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
type MemoryWhispererRuntime = {
    getMemorySearchManager(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }): Promise<{
        manager: {
            search(query: string, opts?: CorpusSearchOptions): Promise<CorpusMemorySearchResult[]>;
        } | null;
    }>;
};
export declare function registerMemoryWhisperer(api: OpenClawPluginApi, runtime: MemoryWhispererRuntime, config: UnblockMemoryConfig["memoryWhisperer"], typesafe: UnblockMemoryConfig["typesafe"], diagnostics?: WhispererDiagnostics): void;
export {};
