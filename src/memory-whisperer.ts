import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import { resolveTypeSafeApiKey, TypeSafeRequestError } from "./typesafe-client.js";
import { complementaryIndices, reviewMemoryRedundancy } from "./typesafe-review.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
import { ApiQueryGenerator, QueryApiError, queryConversation } from "./query-generator.js";
import { judgeTrainingInput, TRAINING_GATE_THRESHOLD } from "./training-gate.js";
import { QueryInputBudgetError, type QueryPair } from "./query-contract.js";
import { searchMemory, memoryPassageId, type MemoryCandidateManager } from "./memory-search.js";

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
    if (context.trigger !== "user" || !agentId || !runId || !scope || !event.prompt.trim()) return;
    const corpora = config.corpora;
    if (!corpora.length) return;
    const key = JSON.stringify([agentId, scope]);
    const previous = sessions.get(key);
    if (previous?.runId === runId) return previous.result;
    const started = performance.now();
    const asOf = new Date().toISOString();
    const measurement: Parameters<WhispererDiagnostics["measureMemory"]>[1] = { outcome: "skipped", elapsedMs: 0 };
    let stage = "input", reason = "completed";
    let recallProbability: number | undefined, queryCount: number | undefined;
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
    let recallRejected = false;
    let gateFailed = false;
    const timer = setTimeout(() => { timedOut = true; state.controller.abort(); }, config.timeoutMs);
    let onAbort: () => void = () => {};
    const aborted = new Promise<undefined>(resolve => {
      onAbort = () => resolve(undefined);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const run = async () => {
      const conversation = queryConversation(event.prompt, event.messages);
      stage = "credentials";
      const apiKey = await resolveTypeSafeApiKey(typesafe);
      if (signal.aborted) return;
      if (!apiKey) { reason = "missing_key"; diagnostics?.record(agentId, "memory", "missing_key"); return; }
      const gateStarted = performance.now();
      const gateSignal = AbortSignal.any([signal, AbortSignal.timeout(typesafe.timeoutMs)]);
      // Speculation is intentional: neither model generation nor QMD waits for the recall judgment.
      const gate = judgeTrainingInput(conversation, apiKey, gateSignal)
        .then(result => {
          if (signal.aborted) return false;
          measurement.gateMs = performance.now() - gateStarted;
          recallProbability = result.probability;
          if (result.probability >= TRAINING_GATE_THRESHOLD) return true;
          recallRejected = true;
          diagnostics?.record(agentId, "memory", "recall_not_needed");
          state.controller.abort();
          return false;
        }).catch(error => {
          if (!signal.aborted) {
            measurement.gateMs = performance.now() - gateStarted;
            log("warn", "recall_failed", { stage: "recall", elapsedMs: measurement.gateMs, timeoutMs: typesafe.timeoutMs,
              ...failureFields(error instanceof TypeSafeRequestError ? error :
                new TypeSafeRequestError("Recall judgment failed", "invalid_response")) });
            gateFailed = true;
            diagnostics?.record(agentId, "memory", "failed");
            state.controller.abort();
          }
          return false;
        });
      const retrieveAndJudge = async () => {
        let queries: QueryPair;
        stage = "generation";
        const generationStarted = performance.now();
        try {
          queries = await generator.generate(conversation, signal);
          if (signal.aborted) return;
          queryCount = 2;
          diagnostics?.record(agentId, "memory", "queries_generated");
        } catch (error) {
          if (signal.aborted) return;
          reason = "generation_failed";
          measurement.outcome = "failed";
          log("warn", "generation_failed", { ...failureFields(error), elapsedMs: performance.now() - generationStarted });
          diagnostics?.record(agentId, "memory", "failed");
          return;
        } finally {
          measurement.generationMs = performance.now() - generationStarted;
        }
        stage = "retrieval";
        const { manager } = await runtime.getMemorySearchManager({ cfg: api.config, agentId });
        if (signal.aborted) return;
        if (!manager) { reason = "unavailable"; diagnostics?.record(agentId, "memory", "unavailable"); return; }
        const search = await searchMemory(manager, queries, {
          corpora, signal, apiKey, timeoutMs: typesafe.timeoutMs, conversation, asOf,
          minUsefulness: config.minUsefulness, maxResults: 4, excludedPassages: state.recent,
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
        if (!await gate || signal.aborted || sessions.get(key) !== state) return;
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
        const hints = selected.map(({ hit, excerpt }) => ({
          source: hit.path, lines: `${hit.startLine}-${hit.endLine}`, body: excerpt,
        }));
        // Bound the complete injected payload, including source metadata.
        // Preserve exact JSON values while keeping source text inside its prompt tags.
        const rendered = JSON.stringify(hints).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
        if (rendered.length > 5000) { reason = "payload_limit"; diagnostics?.record(agentId, "memory", "payload_limit"); return; }
        for (const candidate of selected) state.recent.set(candidate.id, state.turn);
        diagnostics?.record(agentId, "memory", "emitted");
        const appendContext = `<memory>\n${rendered}\n</memory>`;
        measurement.outcome = "ok";
        reason = "emitted";
        measurement.results = selected.length;
        measurement.contextChars = appendContext.length;
        return { appendContext };
      };
      const [, result] = await Promise.all([gate, retrieveAndJudge()]);
      return result;
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
          measurement.outcome = gateFailed ? "failed" : recallRejected ? "skipped" : timedOut ? "timed_out" : "cancelled";
          reason = gateFailed ? "recall_failed" : recallRejected ? "recall_not_needed" : timedOut ? "deadline" : "cancelled";
        }
        diagnostics?.measureMemory(agentId, measurement);
        log("info", "completed", { ...measurement, reason, recallProbability, queryCount, requestsSucceeded, requestsFailed,
          judgedCandidates: requestsSucceeded, partial: requestsSucceeded > 0 && requestsFailed > 0, timeoutMs: config.timeoutMs,
          requestTimeoutMs: typesafe.timeoutMs });
        if (signal.aborted && !recallRejected && !gateFailed) diagnostics?.record(agentId, "memory", timedOut ? "timed_out" : "cancelled");
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
