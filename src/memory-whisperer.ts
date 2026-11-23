import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import { resolveTypeSafeApiKey, TypeSafeRequestError } from "./typesafe-client.js";
import { complementaryIndices, reviewMemoryRedundancy } from "./typesafe-review.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
import { ApiQueryGenerator, compactJudgeConversation, fallbackQueries, QueryApiError, queryConversation } from "./query-generator.js";
import { QueryInputBudgetError, type QueryPair } from "./query-contract.js";
import { searchMemory, memoryPassageId, type MemoryCandidateManager } from "./memory-search.js";
import { startTiming, timeStage } from "./retrieval-timing.js";

const MAX_JUDGE_CANDIDATES = 6;
const MAX_GENERATION_TIMEOUT_MS = 1_500;
const MAX_PAYLOAD_CHARS = 5_000;

function encodeHints(items: { source: string; lines: string; body: string }[]): string {
  return JSON.stringify(items).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
}

type MemoryWhispererRuntime = {
  getMemorySearchManager(params: { cfg: OpenClawConfig; agentId: string }): Promise<{
    manager: MemoryCandidateManager | null;
  }>;
};

type SessionState = {
  agentId: string;
  sessionId?: string;
  sessionKey?: string;
  runId: string;
  turn: number;
  controller: AbortController;
  recent: Map<string, number>;
  result?: Promise<{ appendContext: string } | undefined>;
};

export function registerMemoryWhisperer(
  api: OpenClawPluginApi,
  runtime: MemoryWhispererRuntime,
  config: UnblockMemoryConfig["memoryWhisperer"],
  typesafe: UnblockMemoryConfig["typesafe"],
  diagnostics?: WhispererDiagnostics,
): Parameters<typeof api.on<"before_prompt_build">>[1] | undefined {
  if (!config.enabled || !typesafe.enabled) return;
  const sessions = new Map<string, SessionState>();
  const generator = new ApiQueryGenerator(config.api);

  const beforePrompt: Parameters<typeof api.on<"before_prompt_build">>[1] = async (event, context) => {
    const { agentId, runId, sessionId, sessionKey } = context;
    const scope = sessionId || sessionKey;
    if (context.trigger !== "user" || !agentId || !runId || !scope) return;
    const corpora = config.corpora;
    if (!corpora.length) return;
    const key = JSON.stringify([agentId, scope]);
    const previous = sessions.get(key);
    if (previous?.runId === runId) return previous.result;
    const currentUserMessage = typeof event.currentUserMessage === "string" ? event.currentUserMessage : undefined;
    const rawCurrent = currentUserMessage !== undefined ? currentUserMessage : event.prompt;
    if (!rawCurrent.replace(/^\s*From: [^\r\n]+ \([^()\r\n]+\)\s*$/, "").trim()) return;
    const started = performance.now();
    const asOf = new Date().toISOString();
    const measurement: Parameters<WhispererDiagnostics["measureMemory"]>[1] = { outcome: "skipped", elapsedMs: 0 };
    let stage = "input", reason = "completed";
    let queryCount: number | undefined, queryFallback = false;
    let requestsSucceeded = 0, requestsFailed = 0;
    const log = (level: "info" | "warn", event: string, fields: Record<string, string | number | boolean | undefined>) =>
      api.logger[level]("unblock-memory memory_whisperer " + JSON.stringify({ event, agentId, runId, sessionId, stage, ...fields }));
    const failureFields = (error: unknown) => error instanceof TypeSafeRequestError || error instanceof QueryApiError
      ? { errorCode: error.code, httpStatus: error.status } : { errorCode: "unexpected" };
    previous?.controller.abort();
    const state: SessionState = {
      agentId, sessionId, sessionKey, runId, turn: (previous?.turn ?? 0) + 1,
      controller: new AbortController(), recent: previous?.recent ?? new Map(),
    };
    sessions.set(key, state);
    for (const [id, turn] of state.recent) {
      if (state.turn - turn > config.cooldownTurns) state.recent.delete(id);
    }
    const { signal } = state.controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; state.controller.abort(); }, config.timeoutMs);
    let onAbort: () => void = () => {};
    const aborted = new Promise<undefined>(resolve => {
      onAbort = () => resolve(undefined);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const run = async () => {
      const conversation = queryConversation(event.prompt, event.messages, currentUserMessage);
      stage = "credentials";
      const apiKey = await timeStage("setupMs", measurement, signal, () => resolveTypeSafeApiKey(typesafe));
      if (signal.aborted) return;
      if (!apiKey) { reason = "missing_key"; diagnostics?.record(agentId, "memory", "missing_key"); return; }
      let queries: QueryPair;
      stage = "generation";
      const generationStarted = performance.now();
      const endGeneration = startTiming("generationMs", measurement, signal);
      const generationTimeoutMs = Math.min(MAX_GENERATION_TIMEOUT_MS, Math.max(1, Math.floor(config.timeoutMs / 2)));
      const generationSignal = AbortSignal.any([signal, AbortSignal.timeout(generationTimeoutMs)]);
      try {
        queries = await generator.generate(conversation, generationSignal);
        if (signal.aborted) return;
        diagnostics?.record(agentId, "memory", "queries_generated");
      } catch (error) {
        if (signal.aborted) return;
        queryFallback = true;
        queries = fallbackQueries(conversation);
        log("warn", "generation_fallback", { ...failureFields(error), elapsedMs: performance.now() - generationStarted,
          timeoutMs: generationTimeoutMs });
        diagnostics?.record(agentId, "memory", "generation_fallback");
      } finally {
        endGeneration();
      }
      queryCount = 2;
      stage = "retrieval";
      const { manager } = await timeStage("setupMs", measurement, signal,
        () => runtime.getMemorySearchManager({ cfg: api.config, agentId }));
      if (signal.aborted) return;
      if (!manager) { reason = "unavailable"; diagnostics?.record(agentId, "memory", "unavailable"); return; }
      const search = await searchMemory(manager, queries, {
        corpora, signal, apiKey, timeoutMs: typesafe.timeoutMs, conversation: compactJudgeConversation(conversation),
        asOf, timings: measurement, minUsefulness: config.minUsefulness, maxResults: 4,
        maxJudgeCandidates: MAX_JUDGE_CANDIDATES, excludedPassages: state.recent,
        onCandidates: observation => {
          measurement.retrievalMs = observation.retrievalMs;
          measurement.candidates = observation.candidates;
          measurement.eligible = observation.eligible;
          measurement.outcome = "empty";
          stage = "judgment";
        },
        onJudgment: ({ candidateIndex, elapsedMs, error }) => {
          const fields = { stage: "judgment", candidateIndex, elapsedMs, timeoutMs: typesafe.timeoutMs };
          if (error !== undefined) {
            requestsFailed++;
            diagnostics?.record(agentId, "memory", "judge_candidate_failed");
            log("warn", "candidate_failed", { ...fields, ...failureFields(error) });
          } else {
            requestsSucceeded++;
            log("info", "candidate_completed", fields);
          }
        },
      });
      if (signal.aborted || sessions.get(key) !== state) return;
      measurement.judgeMs = search.judgeMs;
      if (!search.eligible) { reason = "no_candidates"; diagnostics?.record(agentId, "memory", "no_candidates"); return; }
      if (!search.requestsSucceeded) {
        reason = "all_candidates_failed"; measurement.outcome = "failed";
        diagnostics?.record(agentId, "memory", "failed");
        return;
      }
      const ranked = search.results.map(hit => ({ hit, excerpt: hit.snippet, id: memoryPassageId(hit.snippet) }));
      let selected = ranked.slice(0, config.maxHints);
      if (!selected.length) { reason = "rejected"; diagnostics?.record(agentId, "memory", "rejected"); return; }
      if (config.complementaryHints && config.maxHints > 1 && ranked.length > 1) {
        stage = "redundancy";
        try {
          const pairs = await reviewMemoryRedundancy({ apiKey, timeoutMs: typesafe.timeoutMs, signal,
            excerpts: ranked.map(candidate => candidate.excerpt) });
          selected = complementaryIndices(ranked.length, pairs, config.maxHints).map(index => ranked[index]);
        } catch (error) {
          // Preserve the original useful candidates when the optional refinement is unavailable.
          if (!signal.aborted) {
            diagnostics?.record(agentId, "memory", "redundancy_unavailable");
            log("warn", "redundancy_unavailable", failureFields(error));
          }
        }
      }
      if (signal.aborted || sessions.get(key) !== state) return;
      stage = "render";
      // Bound the complete injected payload without slicing individual excerpts into misleading prefixes.
      const emitted: typeof selected = [];
      const hints: { source: string; lines: string; body: string }[] = [];
      let rendered = "";
      for (const candidate of selected) {
        const nextHint = {
          source: candidate.hit.path, lines: `${candidate.hit.startLine}-${candidate.hit.endLine}`, body: candidate.excerpt,
        };
        const nextRendered = encodeHints([...hints, nextHint]);
        if (nextRendered.length > MAX_PAYLOAD_CHARS) continue;
        emitted.push(candidate);
        hints.push(nextHint);
        rendered = nextRendered;
      }
      if (!emitted.length) { reason = "payload_limit"; diagnostics?.record(agentId, "memory", "payload_limit"); return; }
      for (const candidate of emitted) state.recent.set(candidate.id, state.turn);
      diagnostics?.record(agentId, "memory", "emitted");
      const appendContext = `<memory>\n${rendered}\n</memory>`;
      measurement.outcome = "ok";
      reason = "emitted";
      measurement.results = emitted.length;
      measurement.contextChars = appendContext.length;
      return { appendContext };
    };
    // Prompt rebuilds need the same context, not another retrieval or an empty hook result.
    state.result = (async () => {
      try {
        return await Promise.race([run(), aborted]);
      } catch (error) {
        if (error instanceof QueryInputBudgetError) {
          reason = "input_too_large";
          measurement.outcome = "skipped";
          diagnostics?.record(agentId, "memory", "input_too_large");
          return;
        }
        reason = "stage_failed";
        measurement.outcome = "failed";
        if (!signal.aborted) {
          diagnostics?.record(agentId, "memory", "failed");
          log("warn", "stage_failed", failureFields(error));
        }
        return;
      } finally {
        measurement.elapsedMs = performance.now() - started;
        if (signal.aborted) {
          measurement.outcome = timedOut ? "timed_out" : "cancelled";
          reason = timedOut ? "deadline" : "cancelled";
        }
        diagnostics?.measureMemory(agentId, measurement);
        log("info", "completed", { ...measurement, reason, queryCount, queryFallback, requestsSucceeded, requestsFailed,
          judgedCandidates: requestsSucceeded, partial: requestsSucceeded > 0 && requestsFailed > 0, timeoutMs: config.timeoutMs,
          requestTimeoutMs: typesafe.timeoutMs });
        if (signal.aborted) diagnostics?.record(agentId, "memory", timedOut ? "timed_out" : "cancelled");
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        // Stop sibling provider/worker work after an error or an empty early result too.
        state.controller.abort();
      }
    })();
    return state.result;
  };

  api.on("session_end", (event, context) => {
    for (const [key, state] of sessions) {
      if (context.agentId && state.agentId !== context.agentId) continue;
      if (state.sessionId === event.sessionId ||
        (state.sessionKey && (state.sessionKey === event.sessionKey || state.sessionKey === context.sessionKey))) {
        state.controller.abort();
        sessions.delete(key);
      }
    }
  });
  api.on("gateway_stop", () => {
    for (const state of sessions.values()) state.controller.abort();
    sessions.clear();
  });
  return beforePrompt;
}
