import { DEFAULTS } from "./defaults.js";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { CorpusMemorySearchResult } from "./contracts.js";
import { resolveDecisionCredential, DecisionRequestError } from "./decision-client.js";
import { complementaryIndices, reviewMemoryRedundancy } from "./decision-review.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
import { ApiQueryGenerator, fallbackQueries, QueryApiError, visibleQueryConversation } from "./query-generator.js";
import { queryUserText } from "./response-text.js";
import { classifySyntheticInput, type SyntheticInputFilterConfig } from "./synthetic-input.js";
import { selectJudgeConversation } from "./judge-context.js";
import { prepareQueryConversation, QueryInputBudgetError, type QueryConversation, type QueryPair } from "./query-contract.js";
import { searchMemory, memoryPassageId, type MemoryCandidateManager, type RecallCandidateTrace } from "./memory-search.js";
import { startTiming, timeStage } from "./retrieval-timing.js";
import { abortable, abortedByTimeout } from "./abortable.js";
import { nonBlank } from "./guards.js";
import type { RecallHitDisposition, RecallHitRecord, RecallLedgerWriter, RecallQueryOutcome } from "./recall-ledger.js";
import type { WhispererPrompt } from "./whisperer-prompt.js";
import { WhispererAdmissionTracker } from "./whisperer-admission.js";
import { planRecall, type RecallPlan } from "./memory-query-v2.js";
import {
  canonicalCorpora,
  DEFAULT_DERIVED_MATCH_MIN_SHARED_TOKENS,
  DEFAULT_DERIVED_MATCH_MIN_TOKEN_OVERLAP,
  deepThoughtAudienceKey,
  derivedObservationGenerationsFresh,
  readDerivedObservationCandidates,
  type DeepThoughtAudienceIdentity,
  type DerivedObservationMatch,
} from "./deep-thought-store.js";
import { WORKSPACE_AUDIENCE } from "./expectations-store.js";
import { computeBrightnessMap, type BrightnessConfig } from "./memory-brightness.js";
import { findMatchingCrystalsReadOnly, recordCrystalHitsAtPath, type CrystalMatch, type CrystalTier } from "./memory-crystals.js";
import { chatTypeFromSessionKey } from "./session-chat-type.js";

const MAX_JUDGE_CANDIDATES = DEFAULTS.memoryWhisperer.maxJudgeCandidates;
const MAX_GENERATION_TIMEOUT_MS = DEFAULTS.memoryWhisperer.maxQueryGenMs;
const MAX_PAYLOAD_CHARS = DEFAULTS.memoryWhisperer.maxInjectedChars;
const MAX_SESSIONS = DEFAULTS.memoryWhisperer.maxTrackedSessions;
const MAX_SEEN_RUNS = DEFAULTS.memoryWhisperer.maxRunsPerSession;

type MemoryHint = { source: string; lines: string; body: string };
/** A verified `deep_thought` synthesis whispered verbatim; `source` is always `derived_observation:<id>`. */
type DerivedHint = {
  source: string; kind: "verified_synthesis"; question: string; answer: string; confidence: string; citations: string[];
  verifiedAt: string;
};

/** An active Memory Crystal whispered verbatim; `source` is always `memory_crystal:<id>`. */
type CrystalHint = { source: string; tier: CrystalTier; title: string; summary: string; revision: number };

function encodeHints(items: readonly (MemoryHint | DerivedHint | CrystalHint)[]): string {
  return JSON.stringify(items).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
}

/** Optional: whisper fresh, generation-verified `deep_thought` syntheses (`derived_observations`) matching the turn. */
type DerivedObservationWhisperOptions = {
  /** The agent's memory database holding `derived_observations` (opened read-only; missing = nothing to whisper). */
  dbPathForAgent: (agentId: string) => string;
  /** Current QMD collection generations covering exactly `corpora` (same contract as `deep_thought`). */
  getCollectionGenerations: (agentId: string, corpora: readonly string[]) => Promise<Record<string, number>> | Record<string, number>;
  /**
   * Must produce the exact key `deep_thought` saved under. Default: `deepThoughtAudienceKey` over the hook context
   * (agent + session key + provider + account, plus sender outside group/channel sessions). A blank result disables
   * the whisper for that turn.
   */
  audienceKey?: (ctx: DeepThoughtAudienceIdentity) => string | undefined;
  /** Syntheses whispered per turn (default 2; `0` = unlimited). */
  maxHints?: number;
  /** Minimum share of a stored question's meaningful tokens the turn must cover (default 0.45). */
  minTokenOverlap?: number;
  /** Minimum shared meaningful tokens for a non-exact match (default 2). */
  minSharedTokens?: number;
  /** Payload budget for the derived entries (default `memoryWhisperer.maxInjectedChars`; `0` = unlimited). Entries are never sliced. */
  maxPayloadChars?: number;
  /** Turns a whispered synthesis stays suppressed in a session (default `memoryWhisperer.cooldownTurns`). */
  cooldownTurns?: number;
};

/** Optional: whisper active, ACL-matched Memory Crystals (`memory_crystals`) whose title + summary match the turn. */
type CrystalWhisperOptions = {
  /** The agent's memory database holding `memory_crystals` (opened read-only; missing = nothing to whisper). */
  dbPathForAgent: (agentId: string) => string;
  /**
   * Caller audience in addition to the always-visible `workspace` audience. Default: `deepThoughtAudienceKey` over the
   * hook context (the same key derived observations use). A blank result limits the turn to `workspace` crystals.
   */
  audienceKey?: (ctx: DeepThoughtAudienceIdentity) => string | undefined;
  /** Crystals whispered per turn (default 2; `0` = unlimited). */
  maxHints?: number;
  minTokenOverlap?: number;
  minSharedTokens?: number;
  ltmRankBoost?: number;
  /** Payload budget for the crystal entries (default `memoryWhisperer.maxInjectedChars`; `0` = unlimited). */
  maxPayloadChars?: number;
  /** Count emitted crystals (STM→LTM promotion evidence). Default: a best-effort write to the existing database. */
  recordHits?: (agentId: string, ids: readonly string[]) => void;
};

/** Optional: re-order usefulness-qualified finalists by Brightness evidence (never on the `off` recipe). */
type BrightnessWhisperOptions = BrightnessConfig & { dbPathForAgent: (agentId: string) => string; baselineMinInteractions?: number };

export type MemoryWhispererOptions = {
  syntheticInput?: SyntheticInputFilterConfig;
  derivedObservations?: DerivedObservationWhisperOptions;
  crystals?: CrystalWhisperOptions;
  brightness?: BrightnessWhisperOptions;
  /** Active retrieval recipe fingerprint; forwarded on recall-ledger query records and the completed log line. */
  recipeHash?: string;
};

/**
 * Hook-side twin of `deep_thought`'s tool-side mapping; both read the same host run parameters (see the field table on
 * `DeepThoughtAudienceIdentity`). The hook never receives the tool's `nativeChannelId`, so it is not part of the key.
 */
function derivedAudienceContext(context: Record<string, unknown>, agentId: string, sessionKey?: string): DeepThoughtAudienceIdentity {
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
  const provider = text(context.messageProvider) ?? text(context.channel);
  const accountId = text(context.accountId);
  const senderId = text(context.senderId);
  return {
    agentId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(provider ? { provider } : {}),
    ...(accountId ? { accountId } : {}),
    ...(senderId ? { senderId } : {}),
  };
}

function derivedHint(match: DerivedObservationMatch): DerivedHint {
  const found = match.observation;
  return {
    source: `derived_observation:${found.id}`, kind: "verified_synthesis", question: found.question, answer: found.answer,
    confidence: found.confidence, citations: [...new Set(found.citations.map(citation => citation.source).filter(Boolean))],
    verifiedAt: new Date(found.createdAt).toISOString(),
  };
}

const DEFAULT_DERIVED_MAX_HINTS = 2;

/**
 * Never throws. Matching is local + deterministic (zero model calls); generations are fetched once per distinct
 * corpora set among candidates and each row is verified against the exact snapshot for its own corpora.
 */
async function lookupDerivedObservations(params: {
  options: DerivedObservationWhisperOptions;
  agentId: string;
  queryText: string;
  audienceKey: string;
  allowedCorpora: readonly string[];
  isCoolingDown: (id: string) => boolean;
}): Promise<DerivedObservationMatch[]> {
  const { options, agentId, queryText, audienceKey, allowedCorpora } = params;
  const candidates = readDerivedObservationCandidates(options.dbPathForAgent(agentId), {
    agentId, queryText, audienceKey, allowedCorpora,
    minTokenOverlap: options.minTokenOverlap ?? DEFAULT_DERIVED_MATCH_MIN_TOKEN_OVERLAP,
    minSharedTokens: options.minSharedTokens ?? DEFAULT_DERIVED_MATCH_MIN_SHARED_TOKENS,
  }).filter(match => !params.isCoolingDown(match.observation.id));
  if (!candidates.length) return [];
  const sets = new Map<string, string[]>();
  for (const match of candidates) {
    const corpora = canonicalCorpora(match.observation.corpora);
    sets.set(JSON.stringify(corpora), corpora);
  }
  const snapshots = new Map<string, Record<string, number> | undefined>(await Promise.all([...sets].map(async ([key, corpora]) => {
    try { return [key, await options.getCollectionGenerations(agentId, corpora)] as const; }
    catch { return [key, undefined] as const; }
  })));
  const verified = candidates.filter(match => derivedObservationGenerationsFresh(match.observation.collectionGenerations,
    snapshots.get(JSON.stringify(canonicalCorpora(match.observation.corpora)))));
  const maxHints = options.maxHints ?? DEFAULT_DERIVED_MAX_HINTS;
  return maxHints > 0 ? verified.slice(0, maxHints) : verified;
}

/** Bound the derived entries without slicing any answer; `0` = unlimited. */
function boundDerivedHints(matches: readonly DerivedObservationMatch[], maxChars: number): { emitted: DerivedObservationMatch[]; hints: DerivedHint[] } {
  const emitted: DerivedObservationMatch[] = [];
  const hints: DerivedHint[] = [];
  for (const match of matches) {
    const next = derivedHint(match);
    if (maxChars > 0 && encodeHints([...hints, next]).length > maxChars) continue;
    emitted.push(match);
    hints.push(next);
  }
  return { emitted, hints };
}

function crystalHint({ crystal }: CrystalMatch): CrystalHint {
  return { source: `memory_crystal:${crystal.id}`, tier: crystal.tier, title: crystal.title, summary: crystal.summary,
    revision: crystal.revision };
}

/** Bound the crystal entries without slicing any summary; `0` = unlimited. */
function boundCrystalHints(matches: readonly CrystalMatch[], maxChars: number): { emitted: CrystalMatch[]; hints: CrystalHint[] } {
  const emitted: CrystalMatch[] = [];
  const hints: CrystalHint[] = [];
  for (const match of matches) {
    const next = crystalHint(match);
    if (maxChars > 0 && encodeHints([...hints, next]).length > maxChars) continue;
    emitted.push(match);
    hints.push(next);
  }
  return { emitted, hints };
}

const DEFAULT_CRYSTAL_MAX_HINTS = 2;

function failureFields(error: unknown) {
  return error instanceof DecisionRequestError || error instanceof QueryApiError
    ? { errorCode: error.code, httpStatus: error.status }
    : { errorCode: "unexpected" };
}

type MemoryWhispererRuntime = {
  getMemorySearchManager(params: { cfg: OpenClawConfig; agentId: string }): Promise<{
    manager: MemoryCandidateManager | null;
  }>;
};

/** Per-session data carried across turns; admission bookkeeping lives in WhispererAdmissionTracker. */
type SessionData = { recent: Map<string, number> };
type WhisperResult = { appendContext: string };

type RankedHint = { hit: CorpusMemorySearchResult; excerpt: string; id: string };

type TurnTelemetry = {
  stage: string;
  reason: string;
  queryCount?: number;
  queryFallback: boolean;
  gateScore?: number;
  topicCount?: number;
  requestsSucceeded: number;
  requestsFailed: number;
  measurement: Parameters<WhispererDiagnostics["measureMemory"]>[1];
};

type TurnLogger = (level: "info" | "warn", event: string, fields: Record<string, string | number | boolean | undefined>) => void;

async function generateQueriesWithFallback(params: {
  generator?: ApiQueryGenerator;
  conversation: QueryConversation;
  timeoutMs: number;
  signal: AbortSignal;
  turn: TurnTelemetry;
  agentId: string;
  diagnostics?: WhispererDiagnostics;
  log: TurnLogger;
}): Promise<QueryPair | undefined> {
  const { generator, conversation, timeoutMs, signal, turn, agentId, diagnostics, log } = params;
  turn.stage = "generation";
  if (!generator) {
    if (signal.aborted) return;
    turn.queryFallback = true;
    diagnostics?.record(agentId, "memory", "generation_fallback");
    return fallbackQueries(conversation);
  }
  const generationStarted = performance.now();
  const endGeneration = startTiming("generationMs", turn.measurement, signal);
  const generationTimeoutMs = Math.min(MAX_GENERATION_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs / 2)));
  const generationSignal = AbortSignal.any([signal, AbortSignal.timeout(generationTimeoutMs)]);
  try {
    const queries = await generator.generate(conversation, generationSignal);
    if (signal.aborted) return;
    diagnostics?.record(agentId, "memory", "queries_generated");
    return queries;
  } catch (error) {
    if (signal.aborted) return;
    turn.queryFallback = true;
    log("warn", "generation_fallback", {
      ...failureFields(error),
      elapsedMs: performance.now() - generationStarted,
      timeoutMs: generationTimeoutMs,
    });
    diagnostics?.record(agentId, "memory", "generation_fallback");
    return fallbackQueries(conversation);
  } finally {
    endGeneration();
  }
}

/** v2: d1.2 recall gate + corpus router, then grounded topic extraction. Never calls a query-model API. */
async function planQueriesV2(params: {
  conversation: QueryConversation;
  corpora: readonly string[];
  asOf: string;
  apiKey: string;
  decisionModel: UnblockMemoryConfig["decisionModel"];
  turnTimeoutMs: number;
  signal: AbortSignal;
  turn: TurnTelemetry;
  agentId: string;
  diagnostics?: WhispererDiagnostics;
  log: TurnLogger;
}): Promise<RecallPlan> {
  const { conversation, corpora, asOf, apiKey, decisionModel, turnTimeoutMs, signal, turn, agentId, diagnostics, log } = params;
  turn.stage = "gate";
  const started = performance.now();
  const endPlanning = startTiming("generationMs", turn.measurement, signal);
  let plan: RecallPlan;
  try {
    plan = await planRecall({
      apiKey, endpoint: decisionModel.endpoint, model: decisionModel.model, timeoutMs: decisionModel.timeoutMs,
      conversation, asOf, corpora, signal, turnTimeoutMs, onStage: stage => { turn.stage = stage; },
    });
  } finally {
    endPlanning();
  }
  turn.gateScore = plan.gateScore;
  turn.queryFallback = plan.queryFallback;
  if (plan.gateFallback) {
    diagnostics?.record(agentId, "memory", "gate_fallback");
    log("warn", "gate_fallback", { ...failureFields(plan.gateFallback.cause), elapsedMs: performance.now() - started });
  }
  if (plan.extractionFallback) {
    diagnostics?.record(agentId, "memory", "extraction_fallback");
    log("warn", "extraction_fallback", {
      reason: plan.extractionFallback.reason,
      ...(plan.extractionFallback.cause !== undefined ? failureFields(plan.extractionFallback.cause) : {}),
      elapsedMs: performance.now() - started,
    });
  }
  if (plan.shouldRecall && !plan.queryFallback) diagnostics?.record(agentId, "memory", "topics_extracted");
  return plan;
}

async function selectComplementaryHints(params: {
  ranked: readonly RankedHint[];
  config: UnblockMemoryConfig["memoryWhisperer"];
  decisionModel: UnblockMemoryConfig["decisionModel"];
  apiKey: string;
  signal: AbortSignal;
  turn: TurnTelemetry;
  agentId: string;
  diagnostics?: WhispererDiagnostics;
  log: TurnLogger;
}): Promise<{ selected: RankedHint[]; redundantIds: Set<string> }> {
  const { ranked, config, decisionModel, apiKey, signal, turn, agentId, diagnostics, log } = params;
  const baseline = { selected: ranked.slice(0, config.maxHints), redundantIds: new Set<string>() };
  if (!config.complementaryHints || config.maxHints <= 1 || ranked.length <= 1) {
    return baseline;
  }
  turn.stage = "redundancy";
  try {
    const pairs = await reviewMemoryRedundancy({
      apiKey, endpoint: decisionModel.endpoint, model: decisionModel.model, timeoutMs: decisionModel.timeoutMs, signal,
      excerpts: ranked.slice(0, DEFAULTS.review.maxRedundancyCandidates).map(candidate => candidate.excerpt),
    });
    const { selected, redundant } = complementaryIndices(ranked.length, pairs, config.maxHints);
    return {
      selected: selected.map(index => ranked[index]!),
      redundantIds: new Set(redundant.map(index => ranked[index]!.id)),
    };
  } catch (error) {
    // Preserve the original useful candidates when the optional refinement is unavailable.
    if (!signal.aborted) {
      diagnostics?.record(agentId, "memory", "redundancy_unavailable");
      log("warn", "redundancy_unavailable", failureFields(error));
    }
    return baseline;
  }
}

function renderBoundedHints(selected: readonly RankedHint[]): { emitted: RankedHint[]; rendered: string; hints: MemoryHint[] } {
  // Bound the complete injected payload without slicing individual excerpts into misleading prefixes.
  const emitted: RankedHint[] = [];
  const hints: MemoryHint[] = [];
  let rendered = "";
  for (const candidate of selected) {
    const nextHint = {
      source: candidate.hit.path,
      lines: `${candidate.hit.startLine}-${candidate.hit.endLine}`,
      body: candidate.excerpt,
    };
    const nextRendered = encodeHints([...hints, nextHint]);
    if (nextRendered.length > MAX_PAYLOAD_CHARS) continue;
    emitted.push(candidate);
    hints.push(nextHint);
    rendered = nextRendered;
  }
  return { emitted, rendered, hints };
}

type RecallLedgerSink = {
  writer: RecallLedgerWriter;
  dbPathForAgent: (agentId: string) => string;
};

function splitChannelThread(value: string | undefined): { channelId?: string; threadId?: string } {
  if (!value) return {};
  const lower = value.toLowerCase();
  const threadIdx = lower.lastIndexOf(":thread:");
  const topicIdx = lower.lastIndexOf(":topic:");
  const splitAt = Math.max(threadIdx, topicIdx);
  if (splitAt > 0) {
    const markerLen = splitAt === threadIdx ? ":thread:".length : ":topic:".length;
    return {
      channelId: value.slice(0, splitAt).toLowerCase(),
      threadId: nonBlank(value.slice(splitAt + markerLen)),
    };
  }
  return { channelId: lower };
}

function whispererOrigin(context: Record<string, unknown>, sessionKey?: string) {
  const provider = nonBlank(context.messageProvider)?.toLowerCase();
  const accountId = nonBlank(context.accountId)?.toLowerCase();
  const senderId = nonBlank(context.senderId);
  const rawChannel = nonBlank(context.chatId) ?? nonBlank(context.channelId);
  const split = splitChannelThread(rawChannel);
  const channelId = split.channelId && split.channelId !== provider ? split.channelId : undefined;
  const threadId = split.threadId ?? nonBlank(context.threadId);
  const chatType = nonBlank(context.chatType)?.toLowerCase() ?? chatTypeFromSessionKey(sessionKey);
  return { provider, accountId, senderId, channelId, threadId, chatType };
}

function buildRecallHits(
  traces: readonly RecallCandidateTrace[],
  emittedRanks: ReadonlyMap<string, number>,
  selectedIds: ReadonlySet<string>,
  redundantIds: ReadonlySet<string>,
): RecallHitRecord[] {
  return traces.map((trace) => {
    let disposition: RecallHitDisposition;
    let finalRank = trace.finalRank;
    if (trace.disposition === "passed") {
      const emittedRank = emittedRanks.get(trace.passageId);
      if (emittedRank !== undefined) {
        disposition = "emitted";
        finalRank = emittedRank;
      } else if (selectedIds.has(trace.passageId)) {
        disposition = "payload_limit";
        finalRank = undefined;
      } else {
        disposition = redundantIds.has(trace.passageId) ? "redundant" : "rank_limit";
        finalRank = undefined;
      }
    } else {
      disposition = trace.disposition;
    }
    return {
      rawLeafId: trace.locator.rawLeafId,
      passageId: trace.passageId,
      docHash: trace.locator.docHash,
      qmdSeq: trace.locator.qmdSeq,
      chunkPos: trace.locator.chunkPos,
      chunkLen: trace.locator.chunkLen,
      corpus: trace.hit.corpus,
      sourcePath: trace.hit.path,
      startLine: trace.hit.startLine,
      endLine: trace.hit.endLine,
      targetSessionId: trace.hit.session?.sessionId,
      extractedId: trace.hit.extracted?.id,
      extractedRevision: trace.hit.extracted?.revision,
      observedAtMs: trace.locator.observedAtMs,
      observedAtBasis: trace.locator.observedAtBasis,
      retrievalRank: trace.retrievalRank,
      retrievalScore: trace.retrievalScore,
      usefulnessScore: trace.usefulnessScore,
      disposition,
      finalRank,
    };
  });
}

export function registerMemoryWhisperer(
  api: OpenClawPluginApi,
  runtime: MemoryWhispererRuntime,
  config: UnblockMemoryConfig["memoryWhisperer"],
  decisionModel: UnblockMemoryConfig["decisionModel"],
  diagnostics?: WhispererDiagnostics,
  recallLedger?: RecallLedgerSink,
  options: MemoryWhispererOptions = {},
): WhispererPrompt | undefined {
  if (!config.enabled || !decisionModel.enabled) return;
  const { derivedObservations, crystals, recipeHash } = options;
  const brightness = options.brightness && options.brightness.recipe !== "off" && options.brightness.weight > 0
    ? options.brightness : undefined;
  const recordCrystalHits = crystals?.recordHits ?? ((agentId: string, ids: readonly string[]) => {
    recordCrystalHitsAtPath(crystals!.dbPathForAgent(agentId), ids, agentId);
  });
  const mode = config.mode ?? DEFAULTS.memoryWhisperer.mode;
  const legacy = mode === "legacy";
  const sessions = new WhispererAdmissionTracker<SessionData, WhisperResult>({
    maxSessions: MAX_SESSIONS, maxRunsPerSession: MAX_SEEN_RUNS,
  });
  // v2 never constructs the query-model client, even when an old config still names its endpoint.
  const generator = legacy && config.api.endpoint ? new ApiQueryGenerator(config.api) : undefined;
  if (!legacy && config.api.endpoint) {
    api.logger.info("unblock-memory memory_whisperer " + JSON.stringify({
      event: "query_api_ignored", mode,
      note: "memoryWhisperer.mode \"v2\" plans queries with the decision model (d1.2) and ignores memoryWhisperer.api.endpoint; " +
        "set mode \"legacy\" to keep using the query-model API",
    }));
  }

  const beforePrompt: WhispererPrompt = async (event, context, surface) => {
    const { agentId, runId, sessionId, sessionKey } = context;
    const scope = sessionId || sessionKey;
    if ((!surface && context.trigger !== "user") || !agentId || !runId || !scope) return;
    const corpora = config.corpora;
    if (!corpora.length) return;
    const rawCurrent = event.currentUserMessage ?? event.prompt;
    const input = classifySyntheticInput({
      // A legacy prompt can wrap the wake in a sender envelope.
      text: queryUserText(rawCurrent) ?? rawCurrent,
      inputProvenance: context.inputProvenance,
      display: (event as Record<string, unknown>).display,
    }, options.syntheticInput);
    if (input.action === "skip" ||
        ((input.family === "cron_wrapper" || input.family === "heartbeat_control") && surface !== "cron" && surface !== "heartbeat")) return;
    const admission = sessions.lookup({ agentId, scope, runId });
    if (admission.kind === "replay") return admission.result;
    if (admission.kind === "superseded") return undefined;
    const currentRequest = queryUserText(input.text);
    if (!currentRequest) return;
    const inputFamily = surface === "cron" ? "cron_wrapper" : surface === "heartbeat" ? "heartbeat_control" : undefined;
    const started = performance.now();
    const asOf = new Date().toISOString();
    const turn: TurnTelemetry = {
      stage: "input",
      reason: "completed",
      queryFallback: false,
      requestsSucceeded: 0,
      requestsFailed: 0,
      measurement: { outcome: "skipped", elapsedMs: 0 },
    };
    const log: TurnLogger = (level, eventName, fields) =>
      api.logger[level]("unblock-memory memory_whisperer " + JSON.stringify({ event: eventName, agentId, runId, sessionId, stage: turn.stage, ...fields }));
    const state = sessions.admit({
      agentId, scope, runId, sessionId, sessionKey,
      init: previous => ({ recent: previous?.recent ?? new Map() }),
    });
    const { recent } = state.state;
    for (const [id, recordedTurn] of recent) {
      if (!id.startsWith("derived:") && state.turn - recordedTurn > config.cooldownTurns) recent.delete(id);
    }
    const { signal } = state;
    const clearDeadline = sessions.deadline(state, config.timeoutMs, "Memory deadline");
    const createdAtMs = Date.now();
    const rawMessageId = nonBlank((event as Record<string, unknown>).currentUserMessageId);
    const eventKey = `whisperer:${scope}:${rawMessageId ?? runId}`;
    const origin = whispererOrigin(context as Record<string, unknown>, sessionKey);
    let generatedQueries: readonly QueryPair[] | undefined;
    let searchedCorpora: readonly string[] = corpora;
    let traces: RecallCandidateTrace[] = [];
    let judgeUsage: { inputTokens?: number; outputTokens?: number } = {};
    let ledgerRecorded = false;
    const recordLedger = (
      outcome: RecallQueryOutcome,
      rankingMode: "decision" | "retrieval" = "decision",
      emittedRanks = new Map<string, number>(),
      selectedIds = new Set<string>(),
      redundantIds = new Set<string>(),
    ) => {
      if (!recallLedger || ledgerRecorded) return;
      ledgerRecorded = true;
      recallLedger.writer.enqueue(recallLedger.dbPathForAgent(agentId), {
        kind: "query",
        record: {
          eventKey,
          createdAtMs,
          agentId,
          source: "whisperer",
          sessionId,
          sessionKey,
          runId,
          ...origin,
          inputFamily,
          lexQuery: generatedQueries?.map(pair => pair.lex).join("\n"),
          vecQuery: generatedQueries?.map(pair => pair.vec).join("\n"),
          ...(recipeHash ? { recipeHash } : {}),
          queryFallback: turn.queryFallback,
          corpora: searchedCorpora,
          rankingMode,
          decisionModel: decisionModel.model,
          minUsefulness: config.minUsefulness,
          outcome,
          ...judgeUsage,
          hits: buildRecallHits(traces, emittedRanks, selectedIds, redundantIds),
        },
      });
    };
    // Fresh verified deep_thought syntheses: started up front, in parallel, off the retrieval critical path.
    const derivedCooldownTurns = derivedObservations?.cooldownTurns ?? config.cooldownTurns;
    for (const [id, recordedTurn] of recent) {
      if (id.startsWith("derived:") && state.turn - recordedTurn > derivedCooldownTurns) recent.delete(id);
    }
    let derivedSettled = false;
    let derivedMatches: DerivedObservationMatch[] = [];
    const derivedReady: Promise<void> = derivedObservations ? (async () => {
      try {
        await Promise.resolve(); // Let normal retrieval start first; the local read is synchronous.
        const audience = derivedAudienceContext(context as Record<string, unknown>, agentId, sessionKey);
        const audienceKey = nonBlank((derivedObservations.audienceKey ?? deepThoughtAudienceKey)(audience));
        if (!audienceKey) return;
        derivedMatches = await lookupDerivedObservations({
          options: derivedObservations, agentId, queryText: currentRequest, audienceKey, allowedCorpora: corpora,
          isCoolingDown: id => recent.has(`derived:${id}`),
        });
      } catch (error) {
        if (!signal.aborted) log("warn", "derived_unavailable", failureFields(error));
      } finally {
        derivedSettled = true;
      }
    })() : Promise.resolve();
    // Memory Crystals: one local read-only lookup (zero model calls), also off the retrieval critical path.
    let crystalSettled = false;
    let crystalMatches: CrystalMatch[] = [];
    const crystalReady: Promise<void> = crystals ? (async () => {
      try {
        await Promise.resolve();
        const audience = derivedAudienceContext(context as Record<string, unknown>, agentId, sessionKey);
        const audienceKey = nonBlank((crystals.audienceKey ?? deepThoughtAudienceKey)(audience));
        const matches = findMatchingCrystalsReadOnly(crystals.dbPathForAgent(agentId), {
          agentId, queryText: currentRequest, audienceKeys: [WORKSPACE_AUDIENCE, ...(audienceKey ? [audienceKey] : [])], allowedCorpora: corpora,
          ...(crystals.minTokenOverlap !== undefined ? { minTokenOverlap: crystals.minTokenOverlap } : {}),
          ...(crystals.minSharedTokens !== undefined ? { minSharedTokens: crystals.minSharedTokens } : {}),
          ...(crystals.ltmRankBoost !== undefined ? { ltmRankBoost: crystals.ltmRankBoost } : {}),
          nowMs: Date.now(),
        }).filter(match => !recent.has(`crystal:${match.crystal.id}`));
        const maxHints = crystals.maxHints ?? DEFAULT_CRYSTAL_MAX_HINTS;
        crystalMatches = maxHints > 0 ? matches.slice(0, maxHints) : matches;
      } catch (error) {
        if (!signal.aborted) log("warn", "crystals_unavailable", failureFields(error));
      } finally {
        crystalSettled = true;
      }
    })() : Promise.resolve();
    let memoryHints: MemoryHint[] = [];
    const run = async () => {
      const visible = visibleQueryConversation(event.prompt, event.messages, currentRequest, options.syntheticInput);
      const judgeConversation = selectJudgeConversation(visible);
      if (judgeConversation.status === "input_too_large") throw new QueryInputBudgetError();
      // Legacy only: the query-model contract has its own token budget. v2 plans from the bounded judge context.
      const legacyConversation = legacy
        ? prepareQueryConversation(visible.history, visible.currentRequest).conversation
        : undefined;
      turn.stage = "credentials";
      const apiKey = await timeStage("setupMs", turn.measurement, signal, () => resolveDecisionCredential(decisionModel));
      if (signal.aborted) return;
      if (!apiKey) {
        turn.reason = "missing_key";
        diagnostics?.record(agentId, "memory", "missing_key");
        recordLedger("missing_key");
        return;
      }
      let queries: QueryPair | readonly QueryPair[];
      if (legacyConversation) {
        const generated = await generateQueriesWithFallback({
          generator, conversation: legacyConversation, timeoutMs: config.timeoutMs, signal, turn, agentId, diagnostics, log,
        });
        if (!generated || signal.aborted) return;
        queries = generated;
        generatedQueries = [generated];
        turn.queryCount = 2;
      } else {
        const plan = await planQueriesV2({
          conversation: judgeConversation.conversation, corpora, asOf, apiKey, decisionModel, turnTimeoutMs: config.timeoutMs,
          signal, turn, agentId, diagnostics, log,
        });
        if (signal.aborted) return;
        if (!plan.shouldRecall) {
          turn.reason = "gate_skipped";
          diagnostics?.record(agentId, "memory", "gate_skipped");
          searchedCorpora = [];
          recordLedger("skipped");
          return;
        }
        searchedCorpora = plan.corpora;
        queries = plan.topics;
        generatedQueries = plan.topics;
        turn.topicCount = plan.topics.length;
        turn.queryCount = plan.topics.length * 2;
      }
      turn.stage = "retrieval";
      const { manager } = await timeStage("setupMs", turn.measurement, signal,
        () => runtime.getMemorySearchManager({ cfg: api.config, agentId }));
      if (signal.aborted) return;
      if (!manager) {
        turn.reason = "unavailable";
        diagnostics?.record(agentId, "memory", "unavailable");
        recordLedger("unavailable");
        return;
      }
      const search = await searchMemory(manager, queries, {
        corpora: searchedCorpora, signal, apiKey, endpoint: decisionModel.endpoint, model: decisionModel.model, timeoutMs: decisionModel.timeoutMs, conversation: judgeConversation,
        asOf, timings: turn.measurement, minUsefulness: config.minUsefulness, maxResults: DEFAULTS.memoryWhisperer.maxFinalists,
        maxJudgeCandidates: MAX_JUDGE_CANDIDATES, excludedPassages: recent,
        ...(brightness ? { brightness: {
          recipe: brightness.recipe, weight: brightness.weight, maxBoost: brightness.maxBoost,
          lookup: (subjects: readonly string[]) => computeBrightnessMap(brightness.dbPathForAgent(agentId), {
            agentId, recipe: brightness.recipe, subjects, decayRate: brightness.decayRate, lookbackDays: brightness.lookbackDays,
            emotionDecayStretch: brightness.emotionDecayStretch, emotionMaxBonus: brightness.emotionMaxBonus,
            ...(brightness.baselineMinInteractions !== undefined ? { baselineMinInteractions: brightness.baselineMinInteractions } : {}),
          }),
        } } : {}),
        onCandidates: observation => {
          turn.measurement.retrievalMs = observation.retrievalMs;
          turn.measurement.candidates = observation.candidates;
          turn.measurement.eligible = observation.eligible;
          turn.measurement.outcome = "empty";
          turn.stage = "judgment";
        },
        onJudgment: ({ candidateIndex, elapsedMs, error }) => {
          const fields = { stage: "judgment", candidateIndex, elapsedMs, timeoutMs: decisionModel.timeoutMs };
          if (error !== undefined) {
            turn.requestsFailed++;
            diagnostics?.record(agentId, "memory", "judge_candidate_failed");
            log("warn", "candidate_failed", { ...fields, ...failureFields(error) });
          } else {
            turn.requestsSucceeded++;
            log("info", "candidate_completed", fields);
          }
        },
        ...(recallLedger ? { onTrace: (recorded: RecallCandidateTrace[]) => { traces = recorded; } } : {}),
      });
      if (signal.aborted || !sessions.isCurrent(state)) return;
      turn.measurement.judgeMs = search.judgeMs;
      judgeUsage = {
        ...(search.inputTokens !== undefined ? { inputTokens: search.inputTokens } : {}),
        ...(search.outputTokens !== undefined ? { outputTokens: search.outputTokens } : {}),
      };
      if (search.topicsFailed) {
        diagnostics?.record(agentId, "memory", "topic_search_failed");
        log("warn", "topic_search_failed", { topicsFailed: search.topicsFailed, topicCount: turn.topicCount });
      }
      if (!search.eligible && search.topicsFailed) {
        // A partially failed retrieval with nothing to judge is not a clean empty result.
        turn.reason = "topic_search_failed"; turn.measurement.outcome = "failed";
        recordLedger("failed", search.rankingMode);
        return;
      }
      if (!search.eligible) {
        turn.reason = "no_candidates";
        diagnostics?.record(agentId, "memory", "no_candidates");
        recordLedger("empty", search.rankingMode);
        return;
      }
      if (!search.requestsSucceeded) {
        turn.reason = "all_candidates_failed"; turn.measurement.outcome = "failed";
        diagnostics?.record(agentId, "memory", "failed");
        recordLedger("failed", search.rankingMode);
        return;
      }
      const ranked: RankedHint[] = search.results.map(hit => ({ hit, excerpt: hit.snippet, id: memoryPassageId(hit.snippet) }));
      if (!ranked.length) {
        turn.reason = "rejected";
        diagnostics?.record(agentId, "memory", "rejected");
        recordLedger("rejected", search.rankingMode);
        return;
      }
      const { selected, redundantIds } = await selectComplementaryHints({
        ranked, config, decisionModel, apiKey, signal, turn, agentId, diagnostics, log,
      });
      if (signal.aborted || !sessions.isCurrent(state)) return;
      turn.stage = "render";
      const { emitted, rendered, hints } = renderBoundedHints(selected);
      const selectedIds = new Set(selected.map(candidate => candidate.id));
      const emittedRanks = new Map(emitted.map((candidate, index) => [candidate.id, index + 1]));
      if (!emitted.length) {
        turn.reason = "payload_limit";
        diagnostics?.record(agentId, "memory", "payload_limit");
        recordLedger("rejected", search.rankingMode, emittedRanks, selectedIds, redundantIds);
        return;
      }
      for (const candidate of emitted) recent.set(candidate.id, state.turn);
      memoryHints = hints;
      diagnostics?.record(agentId, "memory", "emitted");
      const appendContext = `<memory>\n${rendered}\n</memory>`;
      turn.measurement.outcome = "ok";
      turn.reason = "emitted";
      turn.measurement.results = emitted.length;
      turn.measurement.contextChars = appendContext.length;
      recordLedger("emitted", search.rankingMode, emittedRanks, selectedIds, redundantIds);
      return { appendContext };
    };
    let derivedEmitted = 0;
    let crystalsEmitted = 0;
    let derivedWaitAborted = false;
    /** Waits at most until the turn deadline; `false` when the deadline (or a cancel) ended the wait. */
    const settle = async (settled: () => boolean, ready: Promise<void>): Promise<boolean> => {
      if (settled()) return true;
      await new Promise<void>(resolve => {
        if (signal.aborted) return resolve();
        const onAbort = () => resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        void ready.finally(() => { signal.removeEventListener("abort", onAbort); resolve(); });
      });
      return !signal.aborted;
    };
    /**
     * Folds verified syntheses (first), then matched crystals, into the same `<memory>` block ahead of raw chunks;
     * without any, the normal result is returned as-is. An abort here never discards the normal result.
     */
    const withDerived = async (normal: WhisperResult | undefined): Promise<WhisperResult | undefined> => {
      if ((!derivedObservations && !crystals) || signal.aborted) return normal;
      if (!await settle(() => derivedSettled, derivedReady) || !await settle(() => crystalSettled, crystalReady)) {
        derivedWaitAborted = true;
        return normal;
      }
      if ((!derivedMatches.length && !crystalMatches.length) || !sessions.isCurrent(state)) return normal;
      const derived = derivedObservations && derivedMatches.length
        ? boundDerivedHints(derivedMatches, derivedObservations.maxPayloadChars ?? MAX_PAYLOAD_CHARS) : { emitted: [], hints: [] };
      const crystal = crystals && crystalMatches.length
        ? boundCrystalHints(crystalMatches, crystals.maxPayloadChars ?? MAX_PAYLOAD_CHARS) : { emitted: [], hints: [] };
      if (!derived.emitted.length && !crystal.emitted.length) return normal;
      for (const match of derived.emitted) recent.set(`derived:${match.observation.id}`, state.turn);
      for (const match of crystal.emitted) recent.set(`crystal:${match.crystal.id}`, state.turn);
      derivedEmitted = derived.emitted.length;
      crystalsEmitted = crystal.emitted.length;
      if (crystal.emitted.length) {
        // Real hit counts feed STM→LTM promotion; best-effort and off the hook's return path.
        const ids = crystal.emitted.map(match => match.crystal.id);
        setImmediate(() => {
          try { recordCrystalHits(agentId, ids); }
          catch (error) { log("warn", "crystal_hits_unrecorded", failureFields(error)); }
        });
      }
      if (!normal) {
        diagnostics?.record(agentId, "memory", "emitted");
        turn.reason = derived.emitted.length ? "derived_emitted" : "crystal_emitted";
      }
      const appendContext = `<memory>\n${encodeHints([...derived.hints, ...crystal.hints, ...memoryHints])}\n</memory>`;
      turn.measurement.outcome = "ok";
      turn.measurement.results = memoryHints.length + derived.emitted.length + crystal.emitted.length;
      turn.measurement.contextChars = appendContext.length;
      return { appendContext };
    };
    // Prompt rebuilds need the same context, not another retrieval or an empty hook result.
    state.result = (async () => {
      try {
        const normal = await abortable(run(), signal);
        return await withDerived(normal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof QueryInputBudgetError) {
          turn.reason = "input_too_large";
          turn.measurement.outcome = "skipped";
          diagnostics?.record(agentId, "memory", "input_too_large");
          if (sessions.isCurrent(state)) recordLedger("skipped");
          return;
        }
        turn.reason = "stage_failed";
        turn.measurement.outcome = "failed";
        diagnostics?.record(agentId, "memory", "failed");
        log("warn", "stage_failed", failureFields(error));
        if (sessions.isCurrent(state)) recordLedger("failed");
        return;
      } finally {
        turn.measurement.elapsedMs = performance.now() - started;
        const timedOut = abortedByTimeout(signal);
        if (signal.aborted && !derivedWaitAborted) {
          turn.measurement.outcome = timedOut ? "timed_out" : "cancelled";
          turn.reason = timedOut ? "deadline" : "cancelled";
          if (sessions.isCurrent(state)) recordLedger(timedOut ? "timed_out" : "cancelled");
        }
        diagnostics?.measureMemory(agentId, turn.measurement);
        log("info", "completed", {
          ...turn.measurement,
          reason: turn.reason,
          mode,
          gateScore: turn.gateScore,
          topicCount: turn.topicCount,
          queryCount: turn.queryCount,
          queryFallback: turn.queryFallback,
          requestsSucceeded: turn.requestsSucceeded,
          requestsFailed: turn.requestsFailed,
          judgedCandidates: turn.requestsSucceeded,
          partial: turn.requestsSucceeded > 0 && turn.requestsFailed > 0,
          timeoutMs: config.timeoutMs,
          requestTimeoutMs: decisionModel.timeoutMs,
          ...(derivedObservations ? { derivedEmitted } : {}),
          ...(crystals ? { crystalsEmitted } : {}),
          ...(brightness ? { brightnessRecipe: brightness.recipe } : {}),
          ...(recipeHash ? { recipeHash } : {}),
        });
        if (signal.aborted && !derivedWaitAborted) diagnostics?.record(agentId, "memory", timedOut ? "timed_out" : "cancelled");
        clearDeadline();
        // Stop sibling provider/worker work after an error or an empty early result too.
        state.controller.abort();
      }
    })();
    return state.result;
  };

  sessions.attach(api);
  return beforePrompt;
}
