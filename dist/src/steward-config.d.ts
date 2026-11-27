import type { DecisionModelPluginConfig } from "./config.js";
type StewardDeepThoughtConfig = {
    enabled: boolean;
    /** Maximum investigation turns (`0` = unlimited). */
    maxTurns: number;
    /** Maximum tool calls per investigation (`0` = unlimited). */
    maxToolCalls: number;
    /** Maximum concurrent deep_thought investigations (`0` = unlimited). */
    maxConcurrent: number;
    /** Wall-clock timeout in milliseconds (`0` = unlimited). */
    timeoutMs: number;
    /** When `timeoutMs > 0`, reserve this many ms to force a final wrap-up submission (`0` = disabled). */
    wrapUpReserveMs: number;
    /** Maximum characters returned per tool result (`0` = unlimited). */
    maxToolResultChars: number;
    /** Maximum client-side input tokens per model turn (`0` = unlimited). */
    maxInputTokens: number;
    /** Search ranking inside deep_thought: local hybrid retrieval (`"retrieval"`) or decision model (`"decision"`). */
    searchRanking: "retrieval" | "decision";
    /** Minimum usefulness threshold (0..1) when `searchRanking` is `"decision"`. */
    searchMinUsefulness: number;
    /** Default results returned per `search_memory` call when the curator omits `maxResults`. */
    defaultSearchResults: number;
    /** Maximum characters per `search_memory` snippet (`0` = unlimited). */
    maxSnippetChars: number;
    /** Maximum characters per citation quote (`0` = unlimited). */
    maxQuoteChars: number;
    /** Maximum people returned by `lookup_person` (`0` = unlimited). */
    maxPeopleMatches: number;
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
