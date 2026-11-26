import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import { type SkillCatalogEntry, type SkillSearchCandidate } from "./manager.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
import type { RecallLedgerWriter } from "./recall-ledger.js";
import { type WhispererPrompt } from "./whisperer-prompt.js";
export declare const SKILL_WHISPERER_TIMEOUT_MS: number;
type RuntimeParams = {
    cfg: OpenClawConfig;
    agentId: string;
};
type SkillWhispererRuntime = {
    listSkills?(params: RuntimeParams): Promise<SkillCatalogEntry[]>;
    memoryDatabasePath?(agentId: string): string;
    searchSkills(params: RuntimeParams, query: string, minScore: number, limit: number): Promise<SkillSearchCandidate[]>;
    resolveSkillPath(params: RuntimeParams, path: string): string | undefined;
};
export declare function registerSkillWhisperer(api: OpenClawPluginApi, runtime: SkillWhispererRuntime, config: UnblockMemoryConfig["skillWhisperer"], decisionModel: UnblockMemoryConfig["decisionModel"], diagnostics?: WhispererDiagnostics, recallLedger?: {
    writer: RecallLedgerWriter;
    dbPathForAgent: (agentId: string) => string;
}): WhispererPrompt | undefined;
export {};
