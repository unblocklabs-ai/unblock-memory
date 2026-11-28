import type { ChatType, DecisionModelPluginConfig } from "./config.js";
import { resolveDecisionCredential } from "./decision-client.js";
import type { ExpectationChatType } from "./expectations-store.js";
import { isAbsolute } from "node:path";
import { DEFAULT_EMOTIONAL_SALIENCE_OPTIONS } from "./emotional-salience.js";
import { isRecord } from "./guards.js";
import { CRYSTALS_DEFAULTS } from "./steward-crystals.js";

const efforts = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const searchRankings = ["retrieval", "decision"] as const;
const peopleModes = ["publish", "shadow"] as const;
const confidences = ["high", "medium", "low"] as const;
const chatTypes = ["channel", "group", "direct"] as const;
const expectationChatTypes = ["workspace", "channel", "group", "direct"] as const;

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
  /** Net-new claim discovery on nightly manifests. Unset = runtime default: ON in `"publish"`, OFF in `"shadow"`. */
  includeInteractionLearning?: boolean;
  /** New claims published per person per manifest, highest confidence first (`0` = unlimited). */
  maxNewClaimsPerPerson: number;
  /** Evidence handles per interaction packet (`0` = unlimited; a packet that drops excerpts never completes a review). */
  maxInteractionHandles: number;
  /** Annotate interaction excerpts with Response Audit outcome signals when that table exists. */
  includeResponseAudit: boolean;
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
  /** Cue emotionally salient human messages (Inside Out grades) to Steward and rank salient entries behind blockers. */
  includeEmotionalSalience: boolean;
  /** 0..1 salience score at which a graded message is cued as high-salience. */
  minSalienceScore: number;
  /** 0..3 absolute Inside Out intensity at which a message is always high-salience, regardless of the person's history. */
  minAbsoluteIntensity: number;
  /** 0..3 absolute intensity below which a person-relative spike never counts (a rare-but-trivial blip stays quiet). */
  minRelativeIntensity: number;
};
/** Deterministic (no model call) outcome scoring of memory hits, skills and person whispers into `memory_outcomes`. */
type StewardOutcomeLedgerConfig = {
  enabled: boolean;
  intervalMinutes: number;
  /** First-sweep history and Inside Out personal-baseline window in ms; later sweeps resume from the watermark. */
  lookbackMs: number;
  /** Exposures scored per pass; a capped pass resumes from its cursor next pass (`0` = unlimited). */
  maxRowsPerPass: number;
  /** How long after an exposure its use/outcome evidence may arrive, in ms. */
  matchWindowMs: number;
  /** Days `memory_outcomes` rows are kept (`0` = unlimited). */
  retentionDays: number;
  /** History re-scored behind the watermark for late audit/Inside Out evidence, in ms (`0` = full `lookbackMs`; unset = up to 2 days). */
  lateEvidenceRescanMs?: number;
};
/**
 * The Expectations pass (6th primitive). Deterministic Captain's Log blocker + people todo ingestion always runs, with
 * no model; session extraction and the due/resolution sweep additionally need the Steward runner.
 */
type StewardExpectationsConfig = {
  enabled: boolean;
  intervalMinutes: number;
  lookbackMinutes: number;
  /** Sweep open expectations due within this many minutes (overdue ones always qualify). */
  dueLeadMinutes: number;
  /** Sweep open expectations older than this, due date or not. */
  sweepAfterMinutes: number;
  /** Maximum eligible sessions read per run (`0` = unlimited). */
  maxSessionsPerRun: number;
  /** Character budget per session transcript excerpt (`0` = unlimited). */
  maxCharsPerSession: number;
  /** Open expectations judged per sweep (`0` = unlimited). */
  maxSweepItems: number;
  /** Per model call timeout in ms (`0` = unlimited). */
  timeoutMs: number;
  /** Chat types excluded from session extraction (default: `["direct"]`). Opted-in DMs stay in strict per-person audiences. */
  excludeChatTypes: ChatType[];
  /** Model-backed extraction of commitments/predictions/blockers/decision outcomes from sessions. */
  extract: boolean;
  /**
   * Session chat types whose conversations are evidence for sweeping `workspace` expectations (default `["channel"]`;
   * a 1:1 assistant can add `"group"` / `"direct"`; `[]` = none).
   */
  workspaceSweepChatTypes: ChatType[];
  /** Model-backed due/resolution sweep of open expectations. */
  sweep: boolean;
  /** Auto-expire mirrored Captain's Log blockers not re-captured within this many minutes (default 4320 = 72h; `0` = never). */
  blockerAutoExpireMinutes: number;
  /**
   * After each Captain's Log append, close open expectations (filtered by `captainsLogResolveChatTypes`) that the new
   * entries explicitly resolve or break, with batched d1.2 `choice` calls (needs `decisionModel.enabled`).
   */
  captainsLogDecisionResolve: boolean;
  /** Expectation chat types checked after Captain's Log (default: `["workspace", "channel"]`; add `"group"` / `"direct"` to opt in). */
  captainsLogResolveChatTypes: ExpectationChatType[];
  /** Minimum probability of the chosen `resolved` / `broken` option before it is applied (`0..1`). */
  captainsLogResolveMinConfidence: number;
  /** d1.2 request timeout in ms (`0` = no plugin-side limit; the decisions SDK still caps a request at 60 s). */
  captainsLogResolveTimeoutMs: number;
};
/** Memory Crystals: cluster → STM crystal synthesis, STM→LTM promotion and STM decay (`steward-crystals.ts`). */
type StewardCrystalsConfig = {
  enabled: boolean;
  intervalMinutes: number;
  /** Minimum minutes between automatic reclusters (only with `analysis.executable`). */
  reclusterMinIntervalMinutes: number;
  /** Recluster stale/missing analysis before synthesis (only with `analysis.executable`). */
  autoRecluster: boolean;
  minClusterSize: number;
  /** Synthesis model calls per pass (`0` = unlimited); unchanged, private or ineligible clusters never count. */
  maxClustersPerRun: number;
  /** Evidence members sent per cluster (`0` = the analysis page limit). */
  maxMembersPerCluster: number;
  /** STM crystals retire after this many minutes without re-verification (`0` = never). */
  stmStaleAfterMinutes: number;
  /** Promote STM → LTM after this many `helped` outcomes on member sources. */
  ltmPromoteMinHelped: number;
  /** ... or after this many whispered hits. */
  ltmPromoteMinHits: number;
  /**
   * Corpora crystals may draw evidence from — the ONLY source of truth (default `["memory","knowledge"]`; list
   * `"sessions"` to opt session transcripts in, e.g. on a 1:1 personal-assistant node). Unresolved native ids never pass.
   */
  allowedCorpora: string[];
  /** Per model call timeout in ms (`0` = unlimited). */
  timeoutMs: number;
  /**
   * Let high-salience (Flashbulb) evidence take a bounded share (≤ 1/4, at least one) of a cluster's member slots and
   * nudge synthesis order; representative members keep the remaining slots.
   */
  prioritizeEmotionalSalience: boolean;
};
/** Overnight Thinking: Voltaire Drift, Shortfall Post-Mortems and Anticipatory Pre-Answering (`steward-overnight.ts`). */
type StewardOvernightConfig = {
  enabled: boolean;
  intervalMinutes: number;
  /** Both set → run only inside `[start, end)` local hours (wraps midnight). Both unset → normal schedule. */
  quietHoursStartHour?: number;
  quietHoursEndHour?: number;
  voltaireEnabled: boolean;
  postmortemsEnabled: boolean;
  preAnswerEnabled: boolean;
  /** Recall history window (`0` = unlimited). */
  lookbackDays: number;
  minRecurrence: number;
  /** Pre-answer window (`0` = every weekday/hour slot). */
  lookaheadMinutes: number;
  /** Per-run caps (`0` = unlimited). */
  maxVoltairePerRun: number;
  maxPostmortemsPerRun: number;
  maxPreAnswersPerRun: number;
  /** Lowest diff confidence that records a shift. */
  minConfidence: typeof confidences[number];
  /** `recall_queries.chat_type` values mined for recurring questions. */
  recallChatTypes: ChatType[];
  saveDerivedObservations: boolean;
  /** Append ❔/✅ Voltaire notes to `<workspace>/memory/YYYY-MM-DD.md` (filtered by `dailyLogChatTypes` + `dailyLogCorpora`). */
  writeDailyLogNotes: boolean;
  /**
   * Audience kinds whose Voltaire shifts may reach the daily log or an audience-less `core_memories` anchor
   * (default: `["workspace", "channel"]`; add `"group"` / `"direct"` to opt in).
   */
  dailyLogChatTypes: ExpectationChatType[];
  /**
   * Corpora a shift must draw ALL of its evidence from to reach the daily log or an audience-less `core_memories` anchor
   * (default: `["memory", "knowledge"]`; add `"sessions"` / `"extracted"` to opt in).
   */
  dailyLogCorpora: string[];
  /** Per model call and per investigation timeout in ms (`0` = unlimited). */
  timeoutMs: number;
};
export type StewardConfig = {
  enabled: boolean; model: string; reasoning: typeof efforts[number]; endpoint: string;
  apiKey?: string; apiKeyFile?: string; maxActiveBackground: number;
  deepThought: StewardDeepThoughtConfig; peopleShadow: StewardPeopleShadowConfig;
  captainsLog: StewardCaptainsLogConfig; outcomeLedger: StewardOutcomeLedgerConfig;
  expectations: StewardExpectationsConfig; crystals: StewardCrystalsConfig; overnight: StewardOvernightConfig;
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
  peopleShadow: {
    enabled: true,
    mode: "publish",
    intervalMinutes: 60,
    maxItemsPerRun: 0,
    timeoutMs: 0,
    minConfidence: "medium",
    maxHandles: 0,
    maxExcerptChars: 0,
    maxExportBytes: 0,
    maxNewClaimsPerPerson: 0,
    maxInteractionHandles: 0,
    includeResponseAudit: true,
  },
  captainsLog: {
    enabled: true,
    intervalMinutes: 180,
    lookbackMinutes: 190,
    maxSessionsPerRun: 0,
    maxCharsPerSession: 0,
    maxExistingLogChars: 0,
    timeoutMs: 0,
    excludeChatTypes: ["direct"],
    includeEmotionalSalience: true,
    minSalienceScore: DEFAULT_EMOTIONAL_SALIENCE_OPTIONS.minSalienceScore,
    minAbsoluteIntensity: DEFAULT_EMOTIONAL_SALIENCE_OPTIONS.minAbsoluteIntensity,
    minRelativeIntensity: DEFAULT_EMOTIONAL_SALIENCE_OPTIONS.minRelativeIntensity,
  },
  outcomeLedger: {
    enabled: true,
    intervalMinutes: 60,
    lookbackMs: 604_800_000,
    maxRowsPerPass: 0,
    matchWindowMs: 1_800_000,
    retentionDays: 0,
  },
  expectations: {
    enabled: true,
    intervalMinutes: 60,
    lookbackMinutes: 70,
    dueLeadMinutes: 60,
    sweepAfterMinutes: 1440,
    maxSessionsPerRun: 0,
    maxCharsPerSession: 0,
    maxSweepItems: 0,
    timeoutMs: 0,
    excludeChatTypes: ["direct"],
    workspaceSweepChatTypes: ["channel"],
    extract: true,
    sweep: true,
    blockerAutoExpireMinutes: 4320,
    captainsLogDecisionResolve: true,
    captainsLogResolveChatTypes: ["workspace", "channel"],
    captainsLogResolveMinConfidence: 0.85,
    captainsLogResolveTimeoutMs: 15_000,
  },
  crystals: { enabled: true, ...CRYSTALS_DEFAULTS, allowedCorpora: [...CRYSTALS_DEFAULTS.allowedCorpora] },
  overnight: {
    enabled: true,
    intervalMinutes: 720,
    voltaireEnabled: true,
    postmortemsEnabled: true,
    preAnswerEnabled: true,
    lookbackDays: 30,
    minRecurrence: 2,
    lookaheadMinutes: 720,
    maxVoltairePerRun: 5,
    maxPostmortemsPerRun: 5,
    maxPreAnswersPerRun: 3,
    minConfidence: "medium",
    recallChatTypes: ["channel", "group"],
    saveDerivedObservations: true,
    writeDailyLogNotes: true,
    dailyLogChatTypes: ["workspace", "channel"],
    dailyLogCorpora: ["memory", "knowledge"],
    timeoutMs: 0,
  },
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
/** Inside Out intensity scale, 0 (none) to 3 (overwhelming). */
function intensity(value: unknown, key: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 3) {
    throw new Error(`steward.${key} must be a number between 0 and 3`);
  }
  return value;
}
function enabled(value: unknown, label: string) {
  return boolean(value, `${label}.enabled`);
}
function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}
function chatTypeList(value: unknown, key: string): ChatType[] {
  if (!Array.isArray(value)) throw new Error(`steward.${key} must be an array`);
  const out: ChatType[] = [];
  for (const entry of value) {
    const matched = chatTypes.find(t => t === entry);
    if (!matched) throw new Error(`Invalid steward.${key} entry`);
    if (!out.includes(matched)) out.push(matched);
  }
  return out;
}
function expectationChatTypeList(value: unknown, key: string): ExpectationChatType[] {
  if (!Array.isArray(value)) throw new Error(`steward.${key} must be an array`);
  const out: ExpectationChatType[] = [];
  for (const entry of value) {
    const matched = expectationChatTypes.find(t => t === entry);
    if (!matched) throw new Error(`Invalid steward.${key} entry`);
    if (!out.includes(matched)) out.push(matched);
  }
  return out;
}
function corpusList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === "string" && entry.trim())) {
    throw new Error(`steward.${key} must be an array of non-empty corpus names`);
  }
  return [...new Set(value.map(entry => (entry as string).trim()))];
}
function hour(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 23) {
    throw new Error(`steward.${key} must be an integer between 0 and 23`);
  }
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
  const p = section(c.peopleShadow, defaults.peopleShadow, "steward.peopleShadow", ["includeInteractionLearning"]);
  const cl = section(c.captainsLog, defaults.captainsLog, "steward.captainsLog");
  const o = section(c.outcomeLedger, defaults.outcomeLedger, "steward.outcomeLedger", ["lateEvidenceRescanMs"]);
  const e = section(c.expectations, defaults.expectations, "steward.expectations");
  const cr = section(c.crystals, defaults.crystals, "steward.crystals");
  const on = section(c.overnight, defaults.overnight, "steward.overnight", ["quietHoursStartHour", "quietHoursEndHour"]);
  if ((on.quietHoursStartHour === undefined) !== (on.quietHoursEndHour === undefined)) {
    throw new Error("steward.overnight.quietHoursStartHour and quietHoursEndHour must be set together");
  }
  const overnightConfidence = confidences.find(level => level === on.minConfidence);
  if (!overnightConfidence) throw new Error("Invalid steward.overnight.minConfidence");
  const reasoning = efforts.find(e => e === c.reasoning);
  if (!reasoning) throw new Error("Invalid steward.reasoning");
  const deepThoughtReasoning = d.reasoning === undefined ? undefined : efforts.find(e => e === d.reasoning);
  if (d.reasoning !== undefined && !deepThoughtReasoning) throw new Error("Invalid steward.deepThought.reasoning");
  const searchRanking = searchRankings.find(mode => mode === d.searchRanking);
  if (!searchRanking) throw new Error("Invalid steward.deepThought.searchRanking");
  const peopleMode = peopleModes.find(mode => mode === p.mode);
  if (!peopleMode) throw new Error("Invalid steward.peopleShadow.mode");
  const minConfidence = confidences.find(level => level === p.minConfidence);
  if (!minConfidence) throw new Error("Invalid steward.peopleShadow.minConfidence");
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
      mode: peopleMode,
      intervalMinutes: integer(p.intervalMinutes, 1, "peopleShadow.intervalMinutes"),
      maxItemsPerRun: integer(p.maxItemsPerRun, 0, "peopleShadow.maxItemsPerRun"),
      timeoutMs: integer(p.timeoutMs, 0, "peopleShadow.timeoutMs"),
      minConfidence,
      maxHandles: integer(p.maxHandles, 0, "peopleShadow.maxHandles"),
      maxExcerptChars: integer(p.maxExcerptChars, 0, "peopleShadow.maxExcerptChars"),
      maxExportBytes: integer(p.maxExportBytes, 0, "peopleShadow.maxExportBytes"),
      ...(p.includeInteractionLearning === undefined ? {}
        : { includeInteractionLearning: boolean(p.includeInteractionLearning, "steward.peopleShadow.includeInteractionLearning") }),
      maxNewClaimsPerPerson: integer(p.maxNewClaimsPerPerson, 0, "peopleShadow.maxNewClaimsPerPerson"),
      maxInteractionHandles: integer(p.maxInteractionHandles, 0, "peopleShadow.maxInteractionHandles"),
      includeResponseAudit: boolean(p.includeResponseAudit, "steward.peopleShadow.includeResponseAudit"),
    },
    captainsLog: {
      enabled: enabled(cl.enabled, "steward.captainsLog"),
      intervalMinutes: integer(cl.intervalMinutes, 1, "captainsLog.intervalMinutes"),
      lookbackMinutes: integer(cl.lookbackMinutes, 1, "captainsLog.lookbackMinutes"),
      maxSessionsPerRun: integer(cl.maxSessionsPerRun, 0, "captainsLog.maxSessionsPerRun"),
      maxCharsPerSession: integer(cl.maxCharsPerSession, 0, "captainsLog.maxCharsPerSession"),
      maxExistingLogChars: integer(cl.maxExistingLogChars, 0, "captainsLog.maxExistingLogChars"),
      timeoutMs: integer(cl.timeoutMs, 0, "captainsLog.timeoutMs"),
      excludeChatTypes: chatTypeList(cl.excludeChatTypes, "captainsLog.excludeChatTypes"),
      includeEmotionalSalience: boolean(cl.includeEmotionalSalience, "steward.captainsLog.includeEmotionalSalience"),
      minSalienceScore: unitInterval(cl.minSalienceScore, "captainsLog.minSalienceScore"),
      minAbsoluteIntensity: intensity(cl.minAbsoluteIntensity, "captainsLog.minAbsoluteIntensity"),
      minRelativeIntensity: intensity(cl.minRelativeIntensity, "captainsLog.minRelativeIntensity"),
    },
    outcomeLedger: {
      enabled: enabled(o.enabled, "steward.outcomeLedger"),
      intervalMinutes: integer(o.intervalMinutes, 1, "outcomeLedger.intervalMinutes"),
      lookbackMs: integer(o.lookbackMs, 1, "outcomeLedger.lookbackMs"),
      maxRowsPerPass: integer(o.maxRowsPerPass, 0, "outcomeLedger.maxRowsPerPass"),
      matchWindowMs: integer(o.matchWindowMs, 1, "outcomeLedger.matchWindowMs"),
      retentionDays: integer(o.retentionDays, 0, "outcomeLedger.retentionDays"),
      ...(o.lateEvidenceRescanMs === undefined ? {}
        : { lateEvidenceRescanMs: integer(o.lateEvidenceRescanMs, 0, "outcomeLedger.lateEvidenceRescanMs") }),
    },
    expectations: {
      enabled: enabled(e.enabled, "steward.expectations"),
      intervalMinutes: integer(e.intervalMinutes, 1, "expectations.intervalMinutes"),
      lookbackMinutes: integer(e.lookbackMinutes, 1, "expectations.lookbackMinutes"),
      dueLeadMinutes: integer(e.dueLeadMinutes, 0, "expectations.dueLeadMinutes"),
      sweepAfterMinutes: integer(e.sweepAfterMinutes, 0, "expectations.sweepAfterMinutes"),
      maxSessionsPerRun: integer(e.maxSessionsPerRun, 0, "expectations.maxSessionsPerRun"),
      maxCharsPerSession: integer(e.maxCharsPerSession, 0, "expectations.maxCharsPerSession"),
      maxSweepItems: integer(e.maxSweepItems, 0, "expectations.maxSweepItems"),
      timeoutMs: integer(e.timeoutMs, 0, "expectations.timeoutMs"),
      excludeChatTypes: chatTypeList(e.excludeChatTypes, "expectations.excludeChatTypes"),
      workspaceSweepChatTypes: chatTypeList(e.workspaceSweepChatTypes, "expectations.workspaceSweepChatTypes"),
      extract: boolean(e.extract, "steward.expectations.extract"),
      sweep: boolean(e.sweep, "steward.expectations.sweep"),
      blockerAutoExpireMinutes: integer(e.blockerAutoExpireMinutes, 0, "expectations.blockerAutoExpireMinutes"),
      captainsLogDecisionResolve: boolean(e.captainsLogDecisionResolve, "steward.expectations.captainsLogDecisionResolve"),
      captainsLogResolveChatTypes: expectationChatTypeList(e.captainsLogResolveChatTypes, "expectations.captainsLogResolveChatTypes"),
      captainsLogResolveMinConfidence: unitInterval(e.captainsLogResolveMinConfidence, "expectations.captainsLogResolveMinConfidence"),
      captainsLogResolveTimeoutMs: integer(e.captainsLogResolveTimeoutMs, 0, "expectations.captainsLogResolveTimeoutMs"),
    },
    crystals: {
      enabled: enabled(cr.enabled, "steward.crystals"),
      intervalMinutes: integer(cr.intervalMinutes, 1, "crystals.intervalMinutes"),
      reclusterMinIntervalMinutes: integer(cr.reclusterMinIntervalMinutes, 0, "crystals.reclusterMinIntervalMinutes"),
      autoRecluster: boolean(cr.autoRecluster, "steward.crystals.autoRecluster"),
      minClusterSize: integer(cr.minClusterSize, 1, "crystals.minClusterSize"),
      maxClustersPerRun: integer(cr.maxClustersPerRun, 0, "crystals.maxClustersPerRun"),
      maxMembersPerCluster: integer(cr.maxMembersPerCluster, 0, "crystals.maxMembersPerCluster"),
      stmStaleAfterMinutes: integer(cr.stmStaleAfterMinutes, 0, "crystals.stmStaleAfterMinutes"),
      ltmPromoteMinHelped: integer(cr.ltmPromoteMinHelped, 0, "crystals.ltmPromoteMinHelped"),
      ltmPromoteMinHits: integer(cr.ltmPromoteMinHits, 0, "crystals.ltmPromoteMinHits"),
      allowedCorpora: corpusList(cr.allowedCorpora, "crystals.allowedCorpora"),
      timeoutMs: integer(cr.timeoutMs, 0, "crystals.timeoutMs"),
      prioritizeEmotionalSalience: boolean(cr.prioritizeEmotionalSalience, "steward.crystals.prioritizeEmotionalSalience"),
    },
    overnight: {
      enabled: enabled(on.enabled, "steward.overnight"),
      intervalMinutes: integer(on.intervalMinutes, 1, "overnight.intervalMinutes"),
      ...(on.quietHoursStartHour === undefined ? {} : {
        quietHoursStartHour: hour(on.quietHoursStartHour, "overnight.quietHoursStartHour"),
        quietHoursEndHour: hour(on.quietHoursEndHour, "overnight.quietHoursEndHour"),
      }),
      voltaireEnabled: boolean(on.voltaireEnabled, "steward.overnight.voltaireEnabled"),
      postmortemsEnabled: boolean(on.postmortemsEnabled, "steward.overnight.postmortemsEnabled"),
      preAnswerEnabled: boolean(on.preAnswerEnabled, "steward.overnight.preAnswerEnabled"),
      lookbackDays: integer(on.lookbackDays, 0, "overnight.lookbackDays"),
      minRecurrence: integer(on.minRecurrence, 1, "overnight.minRecurrence"),
      lookaheadMinutes: integer(on.lookaheadMinutes, 0, "overnight.lookaheadMinutes"),
      maxVoltairePerRun: integer(on.maxVoltairePerRun, 0, "overnight.maxVoltairePerRun"),
      maxPostmortemsPerRun: integer(on.maxPostmortemsPerRun, 0, "overnight.maxPostmortemsPerRun"),
      maxPreAnswersPerRun: integer(on.maxPreAnswersPerRun, 0, "overnight.maxPreAnswersPerRun"),
      minConfidence: overnightConfidence,
      recallChatTypes: chatTypeList(on.recallChatTypes, "overnight.recallChatTypes"),
      saveDerivedObservations: boolean(on.saveDerivedObservations, "steward.overnight.saveDerivedObservations"),
      writeDailyLogNotes: boolean(on.writeDailyLogNotes, "steward.overnight.writeDailyLogNotes"),
      dailyLogChatTypes: expectationChatTypeList(on.dailyLogChatTypes, "overnight.dailyLogChatTypes"),
      dailyLogCorpora: corpusList(on.dailyLogCorpora, "overnight.dailyLogCorpora"),
      timeoutMs: integer(on.timeoutMs, 0, "overnight.timeoutMs"),
    },
  };
}

/** Bind the runner's resolveApiKey callback to its destination. Never inherit another origin's key. */
export async function resolveStewardCredential(config: StewardConfig, decision: DecisionModelPluginConfig) {
  if (config.apiKey !== undefined || config.apiKeyFile !== undefined) return resolveDecisionCredential(config);
  if (!config.enabled || new URL(config.endpoint).origin !== new URL(decision.endpoint).origin) return undefined;
  return resolveDecisionCredential(decision);
}
