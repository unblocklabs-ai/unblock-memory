import type { ChatType, DecisionModelPluginConfig } from "./config.js";
import type { ExpectationChatType } from "./expectations-store.js";
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
    outcomeLedger: StewardOutcomeLedgerConfig;
    expectations: StewardExpectationsConfig;
    crystals: StewardCrystalsConfig;
    overnight: StewardOvernightConfig;
};
export declare function resolveStewardConfig(value: unknown): StewardConfig;
/** Bind the runner's resolveApiKey callback to its destination. Never inherit another origin's key. */
export declare function resolveStewardCredential(config: StewardConfig, decision: DecisionModelPluginConfig): Promise<string | undefined>;
export {};
