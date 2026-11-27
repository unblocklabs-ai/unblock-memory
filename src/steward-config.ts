import type { DecisionModelPluginConfig } from "./config.js";
import { resolveDecisionCredential } from "./decision-client.js";
import { isAbsolute } from "node:path";
import { isRecord } from "./guards.js";

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
  enabled: boolean; intervalMinutes: number; maxItemsPerRun: number; timeoutMs: number;
};
const efforts = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const searchRankings = ["retrieval", "decision"] as const;
export type StewardConfig = {
  enabled: boolean; model: string; reasoning: typeof efforts[number]; endpoint: string;
  apiKey?: string; apiKeyFile?: string; maxActiveBackground: number;
  deepThought: StewardDeepThoughtConfig; peopleShadow: StewardPeopleShadowConfig;
};

const DEFAULT_STEWARD_CONFIG: StewardConfig = {
  enabled: true, model: "gpt-6.2-sol", reasoning: "medium", endpoint: "https://codex.unblocklabs.ai/v1/responses",
  maxActiveBackground: 1,
  deepThought: {
    enabled: true,
    maxTurns: 0,
    maxToolCalls: 0,
    maxConcurrent: 0,
    timeoutMs: 0,
    syncWaitMs: 65_000,
    jobRetentionMs: 1_800_000,
    wrapUpReserveMs: 20_000,
    maxToolResultChars: 0,
    maxInputTokens: 0,
    searchRanking: "retrieval",
    searchMinUsefulness: 0,
    defaultSearchResults: 10,
    maxSnippetChars: 0,
    maxQuoteChars: 0,
    maxPeopleMatches: 0,
  },
  peopleShadow: { enabled: true, intervalMinutes: 60, maxItemsPerRun: 10, timeoutMs: 45_000 },
};

function section(value: unknown = {}, defaults: object, label: string, optional: string[] = []) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(defaults, key) && !optional.includes(key)) throw new Error(`Unknown ${label} property: ${key}`);
  }
  return { ...defaults, ...value };
}

function integer(value: unknown, min: number, key: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`steward.${key} must be an integer >= ${min}`);
  }
  return value;
}
function unitInterval(value: unknown, key: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`steward.${key} must be a number between 0 and 1`);
  }
  return value;
}
function enabled(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label}.enabled must be a boolean`);
  return value;
}
function text(value: unknown, key: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`steward.${key} must be a non-empty string`);
  return value.trim();
}
function absolutePath(value: unknown) {
  const path = text(value, "apiKeyFile");
  if (!isAbsolute(path)) throw new Error("steward.apiKeyFile must be an absolute path");
  return path;
}
function endpoint(value: unknown) {
  const url = typeof value === "string" && /^https?:\/\//iu.test(value) && !/[\s?#\\]/u.test(value) &&
    !value.split("/")[2]?.includes("@") && URL.canParse(value) ? new URL(value) : undefined;
  // Plain HTTP would expose the bearer credential: allow it for loopback only, matching decisionModel.endpoint.
  const loopback = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!url || url.username || url.password || (url.protocol === "http:" && !loopback)) {
    throw new Error("steward.endpoint must be an HTTPS (or loopback HTTP) URL without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/u, "");
}

export function resolveStewardConfig(value: unknown): StewardConfig {
  const defaults = DEFAULT_STEWARD_CONFIG;
  const c = section(value, defaults, "steward", ["apiKey", "apiKeyFile"]);
  const d = section(c.deepThought, defaults.deepThought, "steward.deepThought", ["reasoning"]);
  const p = section(c.peopleShadow, defaults.peopleShadow, "steward.peopleShadow");
  const reasoning = efforts.find(e => e === c.reasoning);
  if (!reasoning) throw new Error("Invalid steward.reasoning");
  const deepThoughtReasoning = d.reasoning === undefined ? undefined : efforts.find(e => e === d.reasoning);
  if (d.reasoning !== undefined && !deepThoughtReasoning) throw new Error("Invalid steward.deepThought.reasoning");
  const searchRanking = searchRankings.find(mode => mode === d.searchRanking);
  if (!searchRanking) throw new Error("Invalid steward.deepThought.searchRanking");
  const apiKey = c.apiKey === undefined ? undefined : text(c.apiKey, "apiKey");
  if (apiKey && /\s/u.test(apiKey)) throw new Error("steward.apiKey must not contain whitespace");
  return { enabled: enabled(c.enabled, "steward"), model: text(c.model, "model"), reasoning, endpoint: endpoint(c.endpoint),
    ...(apiKey ? { apiKey } : {}), ...(c.apiKeyFile === undefined ? {} : { apiKeyFile: absolutePath(c.apiKeyFile) }),
    maxActiveBackground: integer(c.maxActiveBackground, 1, "maxActiveBackground"),
    deepThought: {
      enabled: enabled(d.enabled, "steward.deepThought"),
      maxTurns: integer(d.maxTurns, 0, "deepThought.maxTurns"),
      maxToolCalls: integer(d.maxToolCalls, 0, "deepThought.maxToolCalls"),
      maxConcurrent: integer(d.maxConcurrent, 0, "deepThought.maxConcurrent"),
      timeoutMs: integer(d.timeoutMs, 0, "deepThought.timeoutMs"),
      syncWaitMs: integer(d.syncWaitMs, 0, "deepThought.syncWaitMs"),
      jobRetentionMs: integer(d.jobRetentionMs, 0, "deepThought.jobRetentionMs"),
      wrapUpReserveMs: integer(d.wrapUpReserveMs, 0, "deepThought.wrapUpReserveMs"),
      maxToolResultChars: integer(d.maxToolResultChars, 0, "deepThought.maxToolResultChars"),
      maxInputTokens: integer(d.maxInputTokens, 0, "deepThought.maxInputTokens"),
      searchRanking,
      searchMinUsefulness: unitInterval(d.searchMinUsefulness, "deepThought.searchMinUsefulness"),
      defaultSearchResults: integer(d.defaultSearchResults, 1, "deepThought.defaultSearchResults"),
      maxSnippetChars: integer(d.maxSnippetChars, 0, "deepThought.maxSnippetChars"),
      maxQuoteChars: integer(d.maxQuoteChars, 0, "deepThought.maxQuoteChars"),
      maxPeopleMatches: integer(d.maxPeopleMatches, 0, "deepThought.maxPeopleMatches"),
      ...(deepThoughtReasoning ? { reasoning: deepThoughtReasoning } : {}),
    },
    peopleShadow: {
      enabled: enabled(p.enabled, "steward.peopleShadow"),
      intervalMinutes: integer(p.intervalMinutes, 1, "peopleShadow.intervalMinutes"),
      maxItemsPerRun: integer(p.maxItemsPerRun, 1, "peopleShadow.maxItemsPerRun"),
      timeoutMs: integer(p.timeoutMs, 0, "peopleShadow.timeoutMs"),
    },
  };
}

/** Bind the runner's resolveApiKey callback to its destination. Never inherit another origin's key. */
export async function resolveStewardCredential(config: StewardConfig, decision: DecisionModelPluginConfig) {
  if (config.apiKey !== undefined || config.apiKeyFile !== undefined) return resolveDecisionCredential(config);
  if (!config.enabled || new URL(config.endpoint).origin !== new URL(decision.endpoint).origin) return undefined;
  return resolveDecisionCredential(decision);
}
