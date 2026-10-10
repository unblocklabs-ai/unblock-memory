import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
import { type MemoryCandidateManager } from "./memory-search.js";
type MemoryWhispererRuntime = {
    getMemorySearchManager(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }): Promise<{
        manager: MemoryCandidateManager | null;
    }>;
};
export declare function registerMemoryWhisperer(api: OpenClawPluginApi, runtime: MemoryWhispererRuntime, config: UnblockMemoryConfig["memoryWhisperer"], typesafe: UnblockMemoryConfig["typesafe"], diagnostics?: WhispererDiagnostics): Parameters<typeof api.on<"before_prompt_build">>[1] | undefined;
export {};
