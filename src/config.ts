import { DEFAULTS } from "./defaults.js";
import { isAbsolute } from "node:path";
import {
  resolveDecisionConfig,
} from "@unblocklabs/decisions";
import { resolveExtraction, type ExtractionConfig } from "./extraction-config.js";
import { resolveResponseAudit, type ResponseAuditConfig } from "./response-config.js";
import { resolvePeoplePrimer, type PeoplePrimerConfig } from "./people-primer-config.js";
import { DEFAULT_LEARNING, resolvePeopleLearning, type PeopleLearningConfig } from "./people-learning-config.js";
import { resolveInsideOut, type InsideOutConfig } from "./inside-out.js";
import { resolveSafetyWhisperer, type SafetyWhispererConfig } from "./safety-config.js";
import { resolveMyTurn, type MyTurnConfig } from "./my-turn.js";
import { resolveRecallLedger, type RecallLedgerConfig } from "./recall-ledger.js";
import { resolveStewardConfig, type StewardConfig } from "./steward-config.js";
import { EXPECTATIONS_WHISPERER_DEFAULTS, type ExpectationsWhispererConfig } from "./expectations-whisperer.js";
import { DEFAULT_DERIVED_MATCH_MIN_SHARED_TOKENS, DEFAULT_DERIVED_MATCH_MIN_TOKEN_OVERLAP } from "./deep-thought-store.js";
import {
  BRIGHTNESS_RECIPES, brightnessRecipeHash, DEFAULT_BRIGHTNESS_CONFIG, type BrightnessConfig, type BrightnessRecipe,
} from "./memory-brightness.js";
import {
  DEFAULT_CRYSTAL_LTM_RANK_BOOST, DEFAULT_CRYSTAL_MATCH_MIN_SHARED_TOKENS, DEFAULT_CRYSTAL_MATCH_MIN_TOKEN_OVERLAP,
} from "./memory-crystals.js";

const DEFAULT_PATHS = ["MEMORY.md", "USER.md", "memory/*.md", "memory/!(dreaming)/**/*.md"] as const;
const DEFAULT_SESSION_MAX_EXPANDED_TOKENS = 500;
const MAX_SESSION_MAX_EXPANDED_TOKENS = 10_000;

export type FileCorpusConfig = {
  name: string;
  kind: "files";
  paths: readonly string[];
};

export type SkillCorpusConfig = {
  name: "skills";
  kind: "skills";
  paths: readonly string[];
};

const CHAT_TYPES = ["channel", "group", "direct"] as const;
export type ChatType = (typeof CHAT_TYPES)[number];

type SessionCorpusConfig = {
  name: "sessions";
  kind: "sessions";
  chatTypes: readonly ChatType[];
  maxExpandedTokens: number;
  syncIntervalMinutes: number;
};

export type CorpusConfig = FileCorpusConfig | SkillCorpusConfig | SessionCorpusConfig;

export const DEFAULT_CORPORA: readonly FileCorpusConfig[] = [
  {
    name: "memory",
    kind: "files",
    paths: DEFAULT_PATHS,
  },
];

export type DecisionModelPluginConfig = {
  enabled: boolean;
  endpoint: string;
  model: string;
  apiKey?: string;
  apiKeyFile?: string;
  timeoutMs: number;
};

export const WHISPERER_NAMES = ["memory", "skill", "people", "myTurn", "expectations", "safety"] as const;
export type WhispererName = (typeof WHISPERER_NAMES)[number];
export type WhispererTriggersConfig = {
  cron: readonly WhispererName[];
  subagent: readonly WhispererName[];
  heartbeat: readonly WhispererName[];
};

export type UnblockMemoryConfig = {
  myTurn: MyTurnConfig;
  extraction: ExtractionConfig;
  corpora: readonly CorpusConfig[];
  keepEmbeddingModelWarm: boolean;
  analysis: { executable?: string };
  decisionModel: DecisionModelPluginConfig;
  qualityAudit: { enabled: boolean; corpora: readonly string[]; minNoise: number };
  evidenceReview: { enabled: boolean; corpora: readonly string[] };
  responseAudit: ResponseAuditConfig;
  insideOut: InsideOutConfig;
  peoplePrimer: PeoplePrimerConfig;
  people: {
    enabled: boolean;
    whisperer: { enabled: boolean; maxChars: number };
    todos: { maxOpen: number };
    learning: PeopleLearningConfig;
  };
  skillWhisperer: {
    enabled: boolean;
    historyMessages: number;
    minScore: number;
    /** Legacy fleet setting; active skills no longer cool down. */
    cooldownTurns: number;
    /** Retrieval recipe label stamped on skill routing exposures (A/B experiments). Resolved default: `"default"`. */
    recipeHash?: string;
  };
  memoryWhisperer: {
    enabled: boolean;
    complementaryHints: boolean;
    corpora: readonly string[];
    minUsefulness: number;
    maxHints: number;
    cooldownTurns: number;
    timeoutMs: number;
    /**
     * `v2`: d1.2 recall gate + grounded topic extraction. `legacy`: the optional query-model API path.
     * Always set by `resolveConfig`; hand-built configs that omit it get the operational default (`v2`).
     */
    mode?: MemoryWhispererMode;
    /** Only used by `mode: "legacy"`; still accepted in `v2` so existing fleet configs keep loading. */
    api: { endpoint: string; apiKeyFile?: string };
    /** Retrieval recipe label stamped on memory exposures (whisperer + `memory_search`). Resolved default: `"default"`. */
    recipeHash?: string;
    /** Whisper fresh, generation-verified `deep_thought` syntheses matching the turn. Resolved default: `true`. */
    derivedObservations?: boolean;
    /** Verified syntheses whispered per turn. Resolved default: `2`; `0` = unlimited. */
    derivedMaxHints?: number;
    /** Minimum share (0..1) of a stored question's meaningful tokens the turn must cover. Resolved default: `0.45`. */
    derivedMinTokenOverlap?: number;
    /** Minimum shared meaningful tokens for a non-exact question match. Resolved default: `2`. */
    derivedMinSharedTokens?: number;
    /**
     * Brightness A/B recipe: re-orders usefulness-qualified finalists by recall/outcome evidence. Resolved default:
     * `recipe: "off"` (no lookup). A non-`off` recipe also stamps `brightness:<recipe>` as `recipeHash` unless one is set.
     */
    brightness?: BrightnessConfig;
    /** Whisper active Memory Crystals (`memory_crystals`) matching the turn. Resolved default: `true`. */
    crystalsEnabled?: boolean;
    /** Crystals whispered per turn. Resolved default: `2`; `0` = unlimited. */
    crystalMaxHints?: number;
    /** Minimum overlap coefficient (0..1) between the turn and a crystal's title + summary. Resolved default: `0.35`. */
    crystalMinTokenOverlap?: number;
    /** Minimum shared meaningful tokens for a crystal match. Resolved default: `2`. */
    crystalMinSharedTokens?: number;
    /** Additive rank boost for long-term (`ltm`) crystals. Resolved default: `0.01`. */
    crystalLtmRankBoost?: number;
  };
  safetyWhisperer: SafetyWhispererConfig;
  /** On by default: open commitments, blockers and todos from the `expectations` table (read-only, zero model cost). */
  expectationsWhisperer: ExpectationsWhispererConfig;
  whispererTriggers: WhispererTriggersConfig;
  recallLedger: RecallLedgerConfig;
  /** Off unless configured: `deep_thought` curator and People shadow adjudication. */
  steward: StewardConfig;
};

export const DEFAULT_PEOPLE_CONFIG: UnblockMemoryConfig["people"] = {
  enabled: false,
  whisperer: { enabled: false, maxChars: DEFAULTS.people.defaultWhispererMaxChars },
  todos: { maxOpen: DEFAULTS.people.defaultTodosMaxOpen },
  learning: DEFAULT_LEARNING,
};

const DEFAULT_DECISION_MODEL_CONFIG: DecisionModelPluginConfig = {
  enabled: true,
  endpoint: DEFAULTS.decisionModel.endpoint,
  model: DEFAULTS.decisionModel.model,
  timeoutMs: DEFAULTS.decisionModel.timeoutMs,
};

const DEFAULT_QUALITY_AUDIT: UnblockMemoryConfig["qualityAudit"] = {
  enabled: false, corpora: [], minNoise: DEFAULTS.quality.defaultMinNoise,
};

function resolveQualityAudit(value: unknown, corpora: readonly CorpusConfig[]): UnblockMemoryConfig["qualityAudit"] {
  if (value === undefined) return { ...DEFAULT_QUALITY_AUDIT };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("qualityAudit must be an object");
  const config = value as Record<string, unknown>;
  assertOnlyKeys(config, ["enabled", "corpora", "minNoise"], "qualityAudit");
  const enabled = config.enabled ?? false;
  const selected = config.corpora ?? [];
  const minNoise = config.minNoise ?? DEFAULT_QUALITY_AUDIT.minNoise;
  if (typeof enabled !== "boolean") throw new Error("qualityAudit.enabled must be a boolean");
  if (!Array.isArray(selected) || !selected.every((name): name is string =>
    typeof name === "string" && corpora.some(corpus => corpus.name === name && corpus.kind !== "skills"))) {
    throw new Error("qualityAudit.corpora must list configured non-skill corpora");
  }
  if (enabled && !selected.length) throw new Error("enabled qualityAudit requires explicit corpora");
  if (typeof minNoise !== "number" || !Number.isFinite(minNoise) || minNoise < 0 || minNoise > 1) {
    throw new Error("qualityAudit.minNoise must be between 0 and 1");
  }
  return { enabled, corpora: [...new Set(selected)], minNoise };
}

function resolveDecisionModel(value: unknown): DecisionModelPluginConfig {
  const label = "decisionModel";
  if (value === undefined) return { ...DEFAULT_DECISION_MODEL_CONFIG };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`unblock-memory ${label} must be an object`);
  }
  const config = value as Record<string, unknown>;
  assertOnlyKeys(config, ["enabled", "endpoint", "model", "apiKey", "apiKeyFile", "timeoutMs"], label);
  const enabled = config.enabled ?? true;
  if (typeof enabled !== "boolean") throw new Error(`unblock-memory ${label}.enabled must be a boolean`);
  const timeoutMs = positiveInteger(config.timeoutMs, DEFAULT_DECISION_MODEL_CONFIG.timeoutMs, `${label}.timeoutMs`, 10_000);
  let resolved;
  try {
    resolved = resolveDecisionConfig({
      endpoint: config.endpoint === undefined ? DEFAULTS.decisionModel.endpoint : config.endpoint as string,
      model: config.model === undefined ? DEFAULTS.decisionModel.model : config.model as string,
      apiKey: config.apiKey as string | undefined,
      apiKeyFile: config.apiKeyFile as string | undefined,
      timeoutMs,
    });
  } catch (error) {
    throw new Error(`unblock-memory ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    enabled,
    endpoint: resolved.endpoint,
    model: resolved.model,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    ...(resolved.apiKeyFile ? { apiKeyFile: resolved.apiKeyFile } : {}),
    timeoutMs: resolved.timeoutMs,
  };
}

const DEFAULT_RECIPE_HASH = "default";

function recipeHash(value: unknown, label: string): string {
  if (value === undefined) return DEFAULT_RECIPE_HASH;
  if (typeof value !== "string" || !value.trim()) throw new Error(`unblock-memory ${label}.recipeHash must be a non-empty string`);
  return value.trim();
}

const DEFAULT_SKILL_WHISPERER: UnblockMemoryConfig["skillWhisperer"] = {
  enabled: true,
  historyMessages: DEFAULTS.skillWhisperer.defaultHistoryMessages,
  minScore: DEFAULTS.skillWhisperer.defaultMinScore,
  cooldownTurns: DEFAULTS.skillWhisperer.defaultCooldownTurns,
  recipeHash: DEFAULT_RECIPE_HASH,
};

export type MemoryWhispererMode = "v2" | "legacy";
const MEMORY_WHISPERER_MODES: readonly MemoryWhispererMode[] = ["v2", "legacy"];

const DEFAULT_MEMORY_WHISPERER: UnblockMemoryConfig["memoryWhisperer"] = {
  enabled: false, complementaryHints: false, corpora: [], minUsefulness: DEFAULTS.memoryWhisperer.defaultMinUsefulness,
  maxHints: DEFAULTS.memoryWhisperer.defaultMaxHints, cooldownTurns: DEFAULTS.memoryWhisperer.defaultCooldownTurns,
  timeoutMs: DEFAULTS.memoryWhisperer.defaultTimeoutMs, mode: DEFAULTS.memoryWhisperer.mode as MemoryWhispererMode,
  api: { endpoint: DEFAULTS.memoryWhisperer.defaultApiEndpoint },
  recipeHash: DEFAULT_RECIPE_HASH, derivedObservations: true,
  derivedMaxHints: 2, derivedMinTokenOverlap: DEFAULT_DERIVED_MATCH_MIN_TOKEN_OVERLAP,
  derivedMinSharedTokens: DEFAULT_DERIVED_MATCH_MIN_SHARED_TOKENS,
  brightness: { ...DEFAULT_BRIGHTNESS_CONFIG },
  crystalsEnabled: true, crystalMaxHints: 2, crystalMinTokenOverlap: DEFAULT_CRYSTAL_MATCH_MIN_TOKEN_OVERLAP,
  crystalMinSharedTokens: DEFAULT_CRYSTAL_MATCH_MIN_SHARED_TOKENS, crystalLtmRankBoost: DEFAULT_CRYSTAL_LTM_RANK_BOOST,
};

function resolveBrightness(value: unknown): BrightnessConfig {
  if (value === undefined) return { ...DEFAULT_BRIGHTNESS_CONFIG };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unblock-memory memoryWhisperer.brightness must be an object");
  const config = value as Record<string, unknown>;
  assertOnlyKeys(config, Object.keys(DEFAULT_BRIGHTNESS_CONFIG), "memoryWhisperer.brightness");
  const recipe = config.recipe ?? DEFAULT_BRIGHTNESS_CONFIG.recipe;
  if (typeof recipe !== "string" || !BRIGHTNESS_RECIPES.includes(recipe as BrightnessRecipe)) {
    throw new Error(`unblock-memory memoryWhisperer.brightness.recipe must be one of ${BRIGHTNESS_RECIPES.join(", ")}`);
  }
  const number = (key: "weight" | "decayRate" | "maxBoost", positive: boolean) => {
    const resolved = config[key] ?? DEFAULT_BRIGHTNESS_CONFIG[key];
    if (typeof resolved !== "number" || !Number.isFinite(resolved) || (positive ? resolved <= 0 : resolved < 0)) {
      throw new Error(`unblock-memory memoryWhisperer.brightness.${key} must be a ${positive ? "positive" : "non-negative"} number`);
    }
    return resolved;
  };
  const lookbackDays = config.lookbackDays ?? DEFAULT_BRIGHTNESS_CONFIG.lookbackDays;
  if (typeof lookbackDays !== "number" || !Number.isSafeInteger(lookbackDays) || lookbackDays < 0) {
    throw new Error("unblock-memory memoryWhisperer.brightness.lookbackDays must be a non-negative integer (0 = unlimited)");
  }
  return {
    recipe: recipe as BrightnessRecipe, weight: number("weight", false), decayRate: number("decayRate", true), lookbackDays,
    maxBoost: number("maxBoost", false),
  };
}

function resolveQueryApi(value: unknown): UnblockMemoryConfig["memoryWhisperer"]["api"] {
  if (value === undefined) value = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("memoryWhisperer.api must be an object");
  const config = value as Record<string, unknown>;
  assertOnlyKeys(config, ["endpoint", "apiKeyFile"], "memoryWhisperer.api");
  const endpoint = config.endpoint ?? DEFAULT_MEMORY_WHISPERER.api.endpoint;
  let url: URL | undefined;
  if (endpoint !== "") {
    try { url = new URL(typeof endpoint === "string" ? endpoint : ""); }
    catch { throw new Error("memoryWhisperer.api.endpoint must be an HTTP(S) URL or empty"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("memoryWhisperer.api.endpoint must be an HTTP(S) URL without credentials, query or fragment");
    }
  }
  const apiKeyFile = config.apiKeyFile;
  if (apiKeyFile !== undefined && (typeof apiKeyFile !== "string" || !isAbsolute(apiKeyFile))) {
    throw new Error("memoryWhisperer.api.apiKeyFile must be an absolute path");
  }
  return { endpoint: url?.href.replace(/\/$/u, "") ?? "", ...(apiKeyFile ? { apiKeyFile } : {}) };
}

function resolveMemoryWhisperer(value: unknown, corpora: readonly CorpusConfig[],
  extraction: Pick<ExtractionConfig, "enabled" | "publish">): UnblockMemoryConfig["memoryWhisperer"] {
  if (value === undefined) {
    return { ...DEFAULT_MEMORY_WHISPERER, api: resolveQueryApi(undefined), brightness: resolveBrightness(undefined) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unblock-memory memoryWhisperer must be an object");
  }
  const config = value as Record<string, unknown>;
  assertOnlyKeys(config, [...Object.keys(DEFAULT_MEMORY_WHISPERER), "mlx"], "memoryWhisperer");
  // Accept old fleet configs during migration, but never launch a local worker.
  if (config.mlx !== undefined) {
    if (!config.mlx || typeof config.mlx !== "object" || Array.isArray(config.mlx)) throw new Error("memoryWhisperer.mlx must be an object");
    const value = config.mlx as Record<string, unknown>;
    assertOnlyKeys(value, ["pythonPath", "modelPath"], "memoryWhisperer.mlx");
    if (typeof value.pythonPath !== "string" || !isAbsolute(value.pythonPath) ||
        typeof value.modelPath !== "string" || !isAbsolute(value.modelPath)) {
      throw new Error("memoryWhisperer.mlx requires absolute pythonPath and modelPath");
    }
  }
  const enabled = config.enabled ?? false;
  if (typeof enabled !== "boolean") throw new Error("unblock-memory memoryWhisperer.enabled must be a boolean");
  const complementaryHints = config.complementaryHints ?? false;
  if (typeof complementaryHints !== "boolean") throw new Error("memoryWhisperer.complementaryHints must be a boolean");
  const selected = config.corpora ?? [];
  // Published extracted facts are searchable exactly like `runtime.searchableCorpora()` exposes them.
  const extractedPublished = extraction.enabled && extraction.publish;
  if (Array.isArray(selected) && selected.includes("extracted") && !extractedPublished &&
      !corpora.some(corpus => corpus.name === "extracted")) {
    throw new Error('unblock-memory memoryWhisperer.corpora may list "extracted" only when extraction.enabled and extraction.publish are both true');
  }
  if (!Array.isArray(selected) || !selected.every((name): name is string => typeof name === "string" &&
    ((name === "extracted" && extractedPublished) || corpora.some(corpus => corpus.name === name && corpus.kind !== "skills")))) {
    throw new Error("unblock-memory memoryWhisperer.corpora must list configured non-skill corpora (or published \"extracted\")");
  }
  if (enabled && !selected.length) throw new Error("unblock-memory enabled memoryWhisperer requires explicit corpora");
  const cooldownTurns = config.cooldownTurns ?? DEFAULT_MEMORY_WHISPERER.cooldownTurns;
  if (typeof cooldownTurns !== "number" || !Number.isInteger(cooldownTurns) || cooldownTurns < 0 || cooldownTurns > 1000) {
    throw new Error("unblock-memory memoryWhisperer.cooldownTurns must be an integer between 0 and 1000");
  }
  const minUsefulness = config.minUsefulness ?? DEFAULT_MEMORY_WHISPERER.minUsefulness;
  if (typeof minUsefulness !== "number" || !Number.isFinite(minUsefulness) || minUsefulness < 0 || minUsefulness > 1) {
    throw new Error("unblock-memory memoryWhisperer.minUsefulness must be between 0 and 1");
  }
  const derivedObservations = config.derivedObservations ?? true;
  if (typeof derivedObservations !== "boolean") throw new Error("unblock-memory memoryWhisperer.derivedObservations must be a boolean");
  const derivedMaxHints = config.derivedMaxHints ?? DEFAULT_MEMORY_WHISPERER.derivedMaxHints;
  if (typeof derivedMaxHints !== "number" || !Number.isSafeInteger(derivedMaxHints) || derivedMaxHints < 0) {
    throw new Error("unblock-memory memoryWhisperer.derivedMaxHints must be a non-negative integer (0 = unlimited)");
  }
  const derivedMinTokenOverlap = config.derivedMinTokenOverlap ?? DEFAULT_MEMORY_WHISPERER.derivedMinTokenOverlap;
  if (typeof derivedMinTokenOverlap !== "number" || !Number.isFinite(derivedMinTokenOverlap) || derivedMinTokenOverlap < 0 || derivedMinTokenOverlap > 1) {
    throw new Error("unblock-memory memoryWhisperer.derivedMinTokenOverlap must be between 0 and 1");
  }
  const derivedMinSharedTokens = config.derivedMinSharedTokens ?? DEFAULT_MEMORY_WHISPERER.derivedMinSharedTokens;
  if (typeof derivedMinSharedTokens !== "number" || !Number.isSafeInteger(derivedMinSharedTokens) || derivedMinSharedTokens < 1) {
    throw new Error("unblock-memory memoryWhisperer.derivedMinSharedTokens must be a positive integer");
  }
  const brightness = resolveBrightness(config.brightness);
  const crystalsEnabled = config.crystalsEnabled ?? DEFAULT_MEMORY_WHISPERER.crystalsEnabled;
  if (typeof crystalsEnabled !== "boolean") throw new Error("unblock-memory memoryWhisperer.crystalsEnabled must be a boolean");
  const crystalMaxHints = config.crystalMaxHints ?? DEFAULT_MEMORY_WHISPERER.crystalMaxHints;
  if (typeof crystalMaxHints !== "number" || !Number.isSafeInteger(crystalMaxHints) || crystalMaxHints < 0) {
    throw new Error("unblock-memory memoryWhisperer.crystalMaxHints must be a non-negative integer (0 = unlimited)");
  }
  const crystalMinTokenOverlap = config.crystalMinTokenOverlap ?? DEFAULT_MEMORY_WHISPERER.crystalMinTokenOverlap;
  if (typeof crystalMinTokenOverlap !== "number" || !Number.isFinite(crystalMinTokenOverlap) || crystalMinTokenOverlap < 0 ||
      crystalMinTokenOverlap > 1) {
    throw new Error("unblock-memory memoryWhisperer.crystalMinTokenOverlap must be between 0 and 1");
  }
  const crystalMinSharedTokens = config.crystalMinSharedTokens ?? DEFAULT_MEMORY_WHISPERER.crystalMinSharedTokens;
  if (typeof crystalMinSharedTokens !== "number" || !Number.isSafeInteger(crystalMinSharedTokens) || crystalMinSharedTokens < 1) {
    throw new Error("unblock-memory memoryWhisperer.crystalMinSharedTokens must be a positive integer");
  }
  const crystalLtmRankBoost = config.crystalLtmRankBoost ?? DEFAULT_MEMORY_WHISPERER.crystalLtmRankBoost;
  if (typeof crystalLtmRankBoost !== "number" || !Number.isFinite(crystalLtmRankBoost) || crystalLtmRankBoost < 0) {
    throw new Error("unblock-memory memoryWhisperer.crystalLtmRankBoost must be a non-negative number");
  }
  const mode = config.mode ?? DEFAULT_MEMORY_WHISPERER.mode;
  if (typeof mode !== "string" || !MEMORY_WHISPERER_MODES.includes(mode as MemoryWhispererMode)) {
    throw new Error('unblock-memory memoryWhisperer.mode must be "v2" or "legacy"');
  }
  return {
    enabled, complementaryHints, corpora: [...new Set(selected)], cooldownTurns, minUsefulness,
    mode: mode as MemoryWhispererMode,
    maxHints: positiveInteger(config.maxHints, DEFAULT_MEMORY_WHISPERER.maxHints, "memoryWhisperer.maxHints", 3),
    timeoutMs: positiveInteger(config.timeoutMs, DEFAULT_MEMORY_WHISPERER.timeoutMs, "memoryWhisperer.timeoutMs", 10_000),
    api: resolveQueryApi(config.api),
    // A/B lab: an active brightness recipe labels its own exposures unless the operator chose a label.
    recipeHash: config.recipeHash === undefined && brightness.recipe !== "off"
      ? brightnessRecipeHash(brightness.recipe) : recipeHash(config.recipeHash, "memoryWhisperer"),
    derivedObservations, derivedMaxHints, derivedMinTokenOverlap, derivedMinSharedTokens,
    brightness, crystalsEnabled, crystalMaxHints, crystalMinTokenOverlap, crystalMinSharedTokens, crystalLtmRankBoost,
  };
}

function resolveExpectationsWhisperer(value: unknown): ExpectationsWhispererConfig {
  if (value === undefined) return { ...EXPECTATIONS_WHISPERER_DEFAULTS };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unblock-memory expectationsWhisperer must be an object");
  }
  const config = value as Record<string, unknown>;
  assertOnlyKeys(config, Object.keys(EXPECTATIONS_WHISPERER_DEFAULTS), "expectationsWhisperer");
  const flag = (key: "enabled" | "includeWorkspaceBlockers") => {
    const resolved = config[key] ?? EXPECTATIONS_WHISPERER_DEFAULTS[key];
    if (typeof resolved !== "boolean") throw new Error(`unblock-memory expectationsWhisperer.${key} must be a boolean`);
    return resolved;
  };
  // `0` is meaningful and preserved: unlimited hints/payload, no cooldown, overdue-only due window.
  const count = (key: "maxHints" | "cooldownTurns" | "dueLeadMs" | "maxPayloadChars") => {
    const resolved = config[key] ?? EXPECTATIONS_WHISPERER_DEFAULTS[key];
    if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved < 0) {
      throw new Error(`unblock-memory expectationsWhisperer.${key} must be a non-negative integer`);
    }
    return resolved;
  };
  return {
    enabled: flag("enabled"), maxHints: count("maxHints"), cooldownTurns: count("cooldownTurns"), dueLeadMs: count("dueLeadMs"),
    maxPayloadChars: count("maxPayloadChars"), includeWorkspaceBlockers: flag("includeWorkspaceBlockers"),
  };
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`unblock-memory ${label} has unknown property: ${unknown}`);
}

function resolveWhispererTriggers(value: unknown): WhispererTriggersConfig {
  if (value === undefined) return { cron: [], subagent: [], heartbeat: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unblock-memory whispererTriggers must be an object");
  }
  const config = value as Record<string, unknown>;
  assertOnlyKeys(config, ["cron", "subagent", "heartbeat"], "whispererTriggers");
  const namesFor = (surface: keyof WhispererTriggersConfig) => {
    const names = config[surface];
    if (names === undefined) return [];
    const error = `unblock-memory whispererTriggers.${surface} must be an array of: ${WHISPERER_NAMES.join(", ")}`;
    if (!Array.isArray(names)) throw new Error(error);
    const unique = new Set<WhispererName>();
    for (const name of names) {
      const valid = WHISPERER_NAMES.find(candidate => candidate === name);
      if (!valid) throw new Error(error);
      unique.add(valid);
    }
    return [...unique];
  };
  return { cron: namesFor("cron"), subagent: namesFor("subagent"), heartbeat: namesFor("heartbeat") };
}

function resolveCorpora(value: unknown): readonly CorpusConfig[] {
  if (value === undefined) return DEFAULT_CORPORA;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("unblock-memory corpora must be a non-empty array");
  }

  const names = new Set<string>();
  const corpora = value.map((entry, index): CorpusConfig => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`unblock-memory corpora[${index}] must be an object`);
    }
    const corpus = entry as Record<string, unknown>;
    if (typeof corpus.name !== "string" || !corpus.name.trim()) {
      throw new Error(`unblock-memory corpora[${index}].name must be a non-empty string`);
    }
    const name = corpus.name.trim();
    if (name === "all") {
      throw new Error(`unblock-memory corpus name is reserved: ${name}`);
    }
    if (names.has(name)) throw new Error(`unblock-memory corpus names must be unique: ${name}`);
    names.add(name);
    if (corpus.kind === "skills") {
      assertOnlyKeys(corpus, ["name", "kind", "paths"], `corpora[${index}]`);
      if (name !== "skills") {
        throw new Error('unblock-memory skills corpus must be named "skills"');
      }
      if (
        !Array.isArray(corpus.paths) ||
        corpus.paths.length === 0 ||
        !corpus.paths.every((path) => typeof path === "string" && path.trim())
      ) {
        throw new Error(
          "unblock-memory corpus skills paths must be a non-empty array of non-empty strings",
        );
      }
      return { name: "skills", kind: "skills", paths: corpus.paths.map((path) => path.trim()) };
    }
    if (corpus.kind === "sessions") {
      assertOnlyKeys(
        corpus,
        ["name", "kind", "chatTypes", "maxExpandedTokens", "syncIntervalMinutes"],
        `corpora[${index}]`,
      );
      if (name !== "sessions") {
        throw new Error('unblock-memory session corpus must be named "sessions"');
      }
      const chatTypes = corpus.chatTypes ?? ["channel", "group"];
      if (
        !Array.isArray(chatTypes) ||
        chatTypes.length === 0 ||
        !chatTypes.every((chatType) => CHAT_TYPES.includes(chatType as ChatType))
      ) {
        throw new Error(
          `unblock-memory corpus sessions chatTypes must contain channel, group, or direct`,
        );
      }
      const syncIntervalMinutes = corpus.syncIntervalMinutes ?? 5;
      if (typeof syncIntervalMinutes !== "number" || !Number.isInteger(syncIntervalMinutes) ||
        syncIntervalMinutes < 0 || syncIntervalMinutes > 1440) {
        throw new Error("unblock-memory corpus sessions syncIntervalMinutes must be an integer between 0 and 1440");
      }
      return {
        name: "sessions",
        syncIntervalMinutes,
        kind: "sessions",
        chatTypes: [...new Set(chatTypes)] as ChatType[],
        maxExpandedTokens: positiveInteger(
          corpus.maxExpandedTokens,
          DEFAULT_SESSION_MAX_EXPANDED_TOKENS,
          "corpus sessions maxExpandedTokens",
          MAX_SESSION_MAX_EXPANDED_TOKENS,
        ),
      };
    }
    assertOnlyKeys(corpus, ["name", "kind", "paths"], `corpora[${index}]`);
    if (name === "sessions") {
      throw new Error('unblock-memory corpus named "sessions" must have kind "sessions"');
    }
    if (name === "skills") {
      throw new Error('unblock-memory corpus named "skills" must have kind "skills"');
    }
    if (corpus.kind !== "files") {
      throw new Error(
        `unblock-memory corpus ${name} must have kind "files", "skills", or "sessions"`,
      );
    }
    if (
      !Array.isArray(corpus.paths) ||
      corpus.paths.length === 0 ||
      !corpus.paths.every((path) => typeof path === "string" && path.trim())
    ) {
      throw new Error(
        `unblock-memory corpus ${name} paths must be a non-empty array of non-empty strings`,
      );
    }
    return { name, kind: "files", paths: corpus.paths.map((path) => path.trim()) };
  });

  if (corpora.filter((corpus) => corpus.name === "memory").length !== 1) {
    throw new Error('unblock-memory corpora must contain exactly one corpus named "memory"');
  }
  return corpora;
}

function positiveInteger(value: unknown, fallback: number, label: string, maximum: number): number {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "number" ||
    !Number.isInteger(resolved) ||
    resolved < 1 ||
    resolved > maximum
  ) {
    throw new Error(
      `unblock-memory ${label} must be a positive integer no greater than ${maximum}`,
    );
  }
  return resolved;
}

function resolvePeople(value: unknown): UnblockMemoryConfig["people"] {
  if (value === undefined) return DEFAULT_PEOPLE_CONFIG;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unblock-memory people must be an object");
  }
  const people = value as Record<string, unknown>;
  assertOnlyKeys(people, ["enabled", "whisperer", "todos", "learning"], "people");

  const enabled = people.enabled ?? false;
  if (typeof enabled !== "boolean")
    throw new Error("unblock-memory people.enabled must be a boolean");

  const whisperer = people.whisperer ?? {};
  if (!whisperer || typeof whisperer !== "object" || Array.isArray(whisperer)) {
    throw new Error("unblock-memory people.whisperer must be an object");
  }
  const whispererRecord = whisperer as Record<string, unknown>;
  assertOnlyKeys(whispererRecord, ["enabled", "maxChars"], "people.whisperer");
  const whispererEnabled = whispererRecord.enabled ?? false;
  if (typeof whispererEnabled !== "boolean") {
    throw new Error("unblock-memory people.whisperer.enabled must be a boolean");
  }

  const todos = people.todos ?? {};
  if (!todos || typeof todos !== "object" || Array.isArray(todos)) {
    throw new Error("unblock-memory people.todos must be an object");
  }
  const todosRecord = todos as Record<string, unknown>;
  assertOnlyKeys(todosRecord, ["maxOpen"], "people.todos");

  return {
    enabled,
    learning: resolvePeopleLearning(people.learning, enabled && whispererEnabled),
    whisperer: {
      enabled: whispererEnabled,
      maxChars: positiveInteger(
        whispererRecord.maxChars,
        DEFAULT_PEOPLE_CONFIG.whisperer.maxChars,
        "people.whisperer.maxChars",
        4000,
      ),
    },
    todos: {
      maxOpen: positiveInteger(
        todosRecord.maxOpen,
        DEFAULT_PEOPLE_CONFIG.todos.maxOpen,
        "people.todos.maxOpen",
        10_000,
      ),
    },
  };
}

export function resolveConfig(value: unknown): UnblockMemoryConfig {
  if (value === undefined || value === null) value = {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unblock-memory config must be an object");
  }
  const config = value as Record<string, unknown>;
  assertOnlyKeys(
    config,
    ["corpora", "keepEmbeddingModelWarm", "analysis", "people", "peoplePrimer", "skillWhisperer", "memoryWhisperer", "safetyWhisperer", "expectationsWhisperer", "myTurn", "decisionModel", "qualityAudit", "evidenceReview", "responseAudit", "insideOut", "extraction", "recallLedger", "steward", "whispererTriggers"],
    "config",
  );
  const corpora = resolveCorpora(config.corpora);
  const people = resolvePeople(config.people);
  const peoplePrimer = resolvePeoplePrimer(config.peoplePrimer, corpora, people.enabled);
  let evidenceReview: UnblockMemoryConfig["evidenceReview"] = { enabled: false, corpora: [] };
  if (config.evidenceReview !== undefined) {
    const value = config.evidenceReview;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("evidenceReview must be an object");
    assertOnlyKeys(value as Record<string, unknown>, ["enabled", "corpora"], "evidenceReview");
    try {
      const approved = resolveQualityAudit(value, corpora);
      evidenceReview = { enabled: approved.enabled, corpora: approved.corpora };
    } catch { throw new Error("evidenceReview requires a boolean enabled and explicit configured non-skill corpora when enabled"); }
  }
  if (
    config.keepEmbeddingModelWarm !== undefined &&
    typeof config.keepEmbeddingModelWarm !== "boolean"
  ) {
    throw new Error("unblock-memory keepEmbeddingModelWarm must be a boolean");
  }
  const keepEmbeddingModelWarm = config.keepEmbeddingModelWarm ?? true;
  let analysisConfig: { executable?: string } = {};
  if (config.analysis !== undefined) {
    if (!config.analysis || typeof config.analysis !== "object" || Array.isArray(config.analysis)) {
      throw new Error("unblock-memory analysis must be an object");
    }
    const analysis = config.analysis as Record<string, unknown>;
    assertOnlyKeys(analysis, ["executable"], "analysis");
    const configured = analysis.executable;
    if (configured !== undefined) {
      if (typeof configured !== "string" || !configured.trim() || !isAbsolute(configured.trim())) {
        throw new Error("unblock-memory analysis.executable must be an absolute non-empty path");
      }
      analysisConfig = { executable: configured.trim() };
    }
  }

  let skillWhisperer = DEFAULT_SKILL_WHISPERER;
  if (config.skillWhisperer !== undefined) {
    if (
      !config.skillWhisperer ||
      typeof config.skillWhisperer !== "object" ||
      Array.isArray(config.skillWhisperer)
    ) {
      throw new Error("unblock-memory skillWhisperer must be an object");
    }
    const value = config.skillWhisperer as Record<string, unknown>;
    assertOnlyKeys(
      value,
      ["enabled", "historyMessages", "minScore", "cooldownTurns", "recipeHash"],
      "skillWhisperer",
    );
    const enabled = value.enabled ?? DEFAULT_SKILL_WHISPERER.enabled;
    const historyMessages = value.historyMessages ?? DEFAULT_SKILL_WHISPERER.historyMessages;
    const minScore = value.minScore ?? DEFAULT_SKILL_WHISPERER.minScore;
    const cooldownTurns = value.cooldownTurns ?? DEFAULT_SKILL_WHISPERER.cooldownTurns;
    if (typeof enabled !== "boolean")
      throw new Error("unblock-memory skillWhisperer.enabled must be a boolean");
    if (
      typeof historyMessages !== "number" ||
      !Number.isInteger(historyMessages) ||
      historyMessages < 0
    ) {
      throw new Error(
        "unblock-memory skillWhisperer.historyMessages must be a non-negative integer",
      );
    }
    if (
      typeof minScore !== "number" ||
      !Number.isFinite(minScore) ||
      minScore < 0 ||
      minScore > 1
    ) {
      throw new Error("unblock-memory skillWhisperer.minScore must be between 0 and 1");
    }
    if (
      typeof cooldownTurns !== "number" ||
      !Number.isInteger(cooldownTurns) ||
      cooldownTurns < 0
    ) {
      throw new Error("unblock-memory skillWhisperer.cooldownTurns must be a non-negative integer");
    }
    skillWhisperer = { enabled, historyMessages, minScore, cooldownTurns, recipeHash: recipeHash(value.recipeHash, "skillWhisperer") };
  }
  // Default-on means "on once skills exist": without a skills corpus it could never
  // hint, so it registers no prompt hook and reports inactive. An explicit true is
  // overridden too, never thrown; plugin registration warns about that case.
  if (skillWhisperer.enabled && !corpora.some((corpus) => corpus.kind === "skills")) {
    skillWhisperer = { ...skillWhisperer, enabled: false };
  }
  // Resolved before the Memory Whisperer, whose corpora may include the published `extracted` corpus.
  const extraction = resolveExtraction(config.extraction, corpora);
  return { corpora, keepEmbeddingModelWarm, analysis: analysisConfig, people, peoplePrimer, skillWhisperer,
    myTurn: resolveMyTurn(config.myTurn),
    extraction,
    qualityAudit: resolveQualityAudit(config.qualityAudit, corpora),
    evidenceReview,
    responseAudit: resolveResponseAudit(config.responseAudit, corpora),
    insideOut: resolveInsideOut(config.insideOut),
    memoryWhisperer: resolveMemoryWhisperer(config.memoryWhisperer, corpora, extraction),
    safetyWhisperer: resolveSafetyWhisperer(config.safetyWhisperer),
    expectationsWhisperer: resolveExpectationsWhisperer(config.expectationsWhisperer),
    whispererTriggers: resolveWhispererTriggers(config.whispererTriggers),
    recallLedger: resolveRecallLedger(config.recallLedger),
    steward: resolveStewardConfig(config.steward),
    decisionModel: resolveDecisionModel(config.decisionModel) };
}
