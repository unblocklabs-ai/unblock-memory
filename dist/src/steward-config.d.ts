import type { ChatType, DecisionModelPluginConfig } from "./config.js";
declare const efforts: readonly ["off", "minimal", "low", "medium", "high", "xhigh"];
declare const peopleModes: readonly ["publish", "shadow"];
declare const confidences: readonly ["high", "medium", "low"];
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
    /** How long each tool call waits synchronously before handing off a running `jobId` (`0` = wait until completion). */
    syncWaitMs: number;
    /** How long finished background `deep_thought` jobs remain collectible in memory (`0` = until process exit). */
    jobRetentionMs: number;
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
    /** Optional reasoning effort override for `deep_thought` (defaults to `steward.reasoning`). */
    reasoning?: typeof efforts[number];
};
type StewardPeopleShadowConfig = {
    enabled: boolean;
    /** `"publish"` (default) applies verified dossier updates and retires legacy people-learning crons; `"shadow"` is proposal-only. */
    mode: typeof peopleModes[number];
    intervalMinutes: number;
    /** Maximum items per pass (`0` = unlimited). */
    maxItemsPerRun: number;
    /** Per-item model timeout in ms (`0` = unlimited). */
    timeoutMs: number;
    /** Lowest proposal confidence that may mutate/verify a dossier in publish mode. */
    minConfidence: typeof confidences[number];
    /** Evidence handles per packet (`0` = unlimited). */
    maxHandles: number;
    /** Characters per evidence excerpt (`0` = unlimited). */
    maxExcerptChars: number;
    /** Largest export file read in bytes (`0` = unlimited). */
    maxExportBytes: number;
};
type StewardCaptainsLogConfig = {
    enabled: boolean;
    intervalMinutes: number;
    lookbackMinutes: number;
    /** Maximum eligible sessions distilled per run (`0` = unlimited). */
    maxSessionsPerRun: number;
    /** Character budget per session transcript excerpt (`0` = unlimited). */
    maxCharsPerSession: number;
    /** Character budget for existing daily log tail (`0` = unlimited). */
    maxExistingLogChars: number;
    /** Model timeout in ms (`0` = unlimited). */
    timeoutMs: number;
    /** Chat types excluded from workspace `memory/YYYY-MM-DD.md` distillation (default: `["direct"]`). */
    excludeChatTypes: ChatType[];
};
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
    captainsLog: StewardCaptainsLogConfig;
};
export declare function resolveStewardConfig(value: unknown): StewardConfig;
/** Bind the runner's resolveApiKey callback to its destination. Never inherit another origin's key. */
export declare function resolveStewardCredential(config: StewardConfig, decision: DecisionModelPluginConfig): Promise<string | undefined>;
export {};
