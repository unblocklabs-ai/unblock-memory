import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { SkillSearchCandidate } from "./manager.js";
type SkillWhispererRuntime = {
    searchSkills(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }, query: string, minScore: number, limit: number): Promise<SkillSearchCandidate[]>;
    resolveSkillPath(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }, path: string): string | undefined;
};
export declare function buildSkillWhispererQuery(prompt: string, messages: readonly unknown[], historyMessages: number): string;
export declare function registerSkillWhisperer(api: OpenClawPluginApi, runtime: SkillWhispererRuntime, config: UnblockMemoryConfig["skillWhisperer"]): void;
export {};
