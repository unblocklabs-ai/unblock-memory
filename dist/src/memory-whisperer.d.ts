import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
import { type MemoryCandidateManager } from "./memory-search.js";
import type { RecallLedgerWriter } from "./recall-ledger.js";
import type { WhispererPrompt } from "./whisperer-prompt.js";
type MemoryWhispererRuntime = {
    getMemorySearchManager(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }): Promise<{
        manager: MemoryCandidateManager | null;
    }>;
};
type RecallLedgerSink = {
    writer: RecallLedgerWriter;
    dbPathForAgent: (agentId: string) => string;
};
export declare function registerMemoryWhisperer(api: OpenClawPluginApi, runtime: MemoryWhispererRuntime, config: UnblockMemoryConfig["memoryWhisperer"], decisionModel: UnblockMemoryConfig["decisionModel"], diagnostics?: WhispererDiagnostics, recallLedger?: RecallLedgerSink): WhispererPrompt | undefined;
export {};
