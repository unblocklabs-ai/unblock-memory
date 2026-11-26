import type { DecisionModelPluginConfig } from "./config.js";
type StewardDeepThoughtConfig = {
    enabled: boolean;
    maxTurns: number;
    maxToolCalls: number;
    maxConcurrent: number;
    timeoutMs: number;
    maxToolResultChars: number;
    maxInputTokens: number;
};
type StewardPeopleShadowConfig = {
    enabled: boolean;
    intervalMinutes: number;
    maxItemsPerRun: number;
    timeoutMs: number;
};
declare const efforts: readonly ["off", "minimal", "low", "medium", "high", "xhigh"];
export type StewardConfig = {
    enabled: boolean;
    model: string;
    reasoning: typeof efforts[number];
    endpoint: string;
    apiKey?: string;
    apiKeyFile?: string;
    maxActiveBackground: number;
    deepThought: StewardDeepThoughtConfig;
    peopleShadow: StewardPeopleShadowConfig;
};
export declare function resolveStewardConfig(value: unknown): StewardConfig;
/** Bind the runner's resolveApiKey callback to its destination. Never inherit another origin's key. */
export declare function resolveStewardCredential(config: StewardConfig, decision: DecisionModelPluginConfig): Promise<string | undefined>;
export {};
