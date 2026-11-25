import { DEFAULTS } from "./defaults.js";
import { basename } from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { SkillSearchCandidate } from "./manager.js";
import { selectSkill } from "./decision-ranking.js";
import { isDecisionTimeout, resolveDecisionCredential, DecisionRequestError } from "./decision-client.js";
import { buildSkillWhispererQuery, MAX_SKILL_QUERY_CHARS, recentSkillMessages } from "./whisperer-context.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
import { abortable } from "./abortable.js";
import { isRecord } from "./guards.js";

const CANDIDATE_LIMIT = DEFAULTS.skillWhisperer.maxCandidates;
const JUDGE_CANDIDATE_LIMIT = DEFAULTS.skillWhisperer.maxParallelJudges;
const MAX_SESSIONS = 1_000;
const MAX_SEEN_RUNS = 64;
export const SKILL_WHISPERER_TIMEOUT_MS = DEFAULTS.skillWhisperer.timeoutMs;

type SkillWhispererRuntime = {
  searchSkills(
    params: { cfg: OpenClawConfig; agentId: string },
    query: string,
    minScore: number,
    limit: number,
  ): Promise<SkillSearchCandidate[]>;
  resolveSkillPath(params: { cfg: OpenClawConfig; agentId: string }, path: string): string | undefined;
};

type SessionState = {
  turn: number;
  lastRunId?: string;
  seenRuns: Set<string>;
  result?: Promise<{ appendContext: string } | undefined>;
  controller?: AbortController;
  skills: Map<string, { suggested?: number; opened?: number }>;
};

function decisionConversation(prompt: string, messages: ReturnType<typeof recentSkillMessages>) {
  const currentRequest = prompt.trim().slice(-MAX_SKILL_QUERY_CHARS);
  let remaining = MAX_SKILL_QUERY_CHARS - currentRequest.length;
  const history: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (remaining <= 0) break;
    const message = messages[i];
    const content = message.text.slice(-remaining);
    history.unshift({ role: message.role, content });
    remaining -= content.length;
  }
  return { currentRequest, history };
}

function readPath(params: Record<string, unknown>): string | undefined {
  for (const value of [params.path, params.file_path, params.filePath]) {
    if (typeof value === "string" && basename(value).toLowerCase() === "skill.md") return value;
  }
  return undefined;
}

function sessionScope(context: { sessionId?: string; sessionKey?: string }): string | undefined {
  return context.sessionId || context.sessionKey;
}

export function registerSkillWhisperer(
  api: OpenClawPluginApi,
  runtime: SkillWhispererRuntime,
  config: UnblockMemoryConfig["skillWhisperer"],
  decisionModel: UnblockMemoryConfig["decisionModel"],
  diagnostics?: WhispererDiagnostics,
): Parameters<typeof api.on<"before_prompt_build">>[1] | undefined {
  if (!config.enabled) return;
  const sessions = new Map<string, SessionState>();
  const touchSession = (scope: string, state: SessionState) => {
    sessions.delete(scope);
    sessions.set(scope, state);
  };
  const stateFor = (scope: string) => {
    let state = sessions.get(scope);
    if (!state) {
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value!;
        sessions.get(oldest)?.controller?.abort();
        sessions.delete(oldest);
      }
      state = { turn: 0, seenRuns: new Set(), skills: new Map() };
    }
    touchSession(scope, state);
    return state;
  };
  const active = (agentId: string) => ({ cfg: api.config, agentId });

  const beforePrompt: Parameters<typeof api.on<"before_prompt_build">>[1] = async (event, context) => {
    const { agentId, runId } = context;
    const scope = sessionScope(context);
    if (context.trigger !== "user" || !scope || !runId || !agentId) return;
    const state = stateFor(scope);
    if (state.lastRunId === runId) return state.result;
    // Ignore delayed prompt rebuilds for already-superseded runs so they never abort or advance the latest run.
    if (state.seenRuns.has(runId)) return undefined;
    state.controller?.abort();
    if (state.lastRunId) {
      state.seenRuns.add(state.lastRunId);
      if (state.seenRuns.size > MAX_SEEN_RUNS) state.seenRuns.delete(state.seenRuns.values().next().value!);
    }
    const controller = new AbortController();
    state.controller = controller;
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(new DOMException("Skill deadline", "TimeoutError")), SKILL_WHISPERER_TIMEOUT_MS);
    state.lastRunId = runId;
    state.turn += 1;
    // Reuse even an in-flight result when the host rebuilds this run's prompt.
    const run = async () => {
      try {
        const runtimeParams = active(agentId);
        const apiKey = await abortable(resolveDecisionCredential(decisionModel), signal);
        if (!apiKey) diagnostics?.record(agentId, "skill", decisionModel.enabled ? "missing_key" : "decision_disabled");
        const recentMessages = recentSkillMessages(event.messages, config.historyMessages);
        const candidates = await abortable(runtime.searchSkills(
          runtimeParams,
          buildSkillWhispererQuery(event.prompt, recentMessages),
          apiKey ? -1 : config.minScore,
          CANDIDATE_LIMIT,
        ), signal);
        const resolvedCandidates = candidates.flatMap((candidate) => {
          const canonicalPath = runtime.resolveSkillPath(runtimeParams, candidate.path);
          return canonicalPath ? [{ candidate, canonicalPath }] : [];
        });
        if (!resolvedCandidates.length) { diagnostics?.record(agentId, "skill", "no_candidates"); return; }
        const cooling = (path: string) => {
          const previous = state.skills.get(path);
          return state.turn - Math.max(previous?.suggested ?? -Infinity, previous?.opened ?? -Infinity) <= config.cooldownTurns;
        };
        // Exclude cooling skills before choosing a winner so a cooling top hit never suppresses an eligible alternative.
        const eligibleCandidates = resolvedCandidates.filter(({ canonicalPath }) => !cooling(canonicalPath));
        if (!eligibleCandidates.length) { diagnostics?.record(agentId, "skill", "cooldown"); return; }
        let resolved = eligibleCandidates[0]!;
        if (apiKey) {
          const shortlist = eligibleCandidates.slice(0, JUDGE_CANDIDATE_LIMIT);
          const selectedIndex = await abortable(selectSkill({
            apiKey, endpoint: decisionModel.endpoint, model: decisionModel.model, timeoutMs: decisionModel.timeoutMs, signal,
            ...decisionConversation(event.prompt, recentMessages),
            candidates: shortlist.map(({ candidate }) => candidate),
            onCandidateFailure: (candidateIndex, error) => {
              if (signal.aborted) return;
              diagnostics?.record(agentId, "skill", "judge_candidate_failed");
              api.logger.warn("unblock-memory skill_whisperer " + JSON.stringify({ event: "candidate_failed",
                agentId, runId, candidateIndex, errorCode: error instanceof DecisionRequestError ? error.code : "unexpected",
                httpStatus: error instanceof DecisionRequestError ? error.status : undefined }));
            },
          }), signal);
          if (selectedIndex === undefined) { diagnostics?.record(agentId, "skill", "rejected"); return; }
          resolved = shortlist[selectedIndex]!;
        } else if (resolved.candidate.score < config.minScore) { diagnostics?.record(agentId, "skill", "rejected"); return; }
        // A selection completing after session teardown must not resurrect its hint.
        if (sessions.get(scope) !== state || state.lastRunId !== runId) { diagnostics?.record(agentId, "skill", "cancelled"); return; }
        const { candidate: selected, canonicalPath } = resolved;
        if (apiKey && runtime.resolveSkillPath(runtimeParams, selected.path) !== canonicalPath) return;
        if (cooling(canonicalPath)) { diagnostics?.record(agentId, "skill", "cooldown"); return; }
        const history = state.skills.get(canonicalPath) ?? {};
        history.suggested = state.turn;
        state.skills.set(canonicalPath, history);
        diagnostics?.record(agentId, "skill", "emitted");
        return {
          appendContext: `<skill>This skill may be relevant: ${JSON.stringify(selected.path).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e")}</skill>`,
        };
      } catch (error) {
        diagnostics?.record(agentId, "skill", isDecisionTimeout(error, signal) ? "timed_out" : signal.aborted ? "cancelled" : "failed");
        if (!signal.aborted) api.logger.warn("unblock-memory skill whisperer failed; no hint emitted");
        return;
      } finally { clearTimeout(timer); }
    };
    state.result = run();
    return state.result;
  };

  api.on("after_tool_call", (event, context) => {
    if (event.toolName !== "read" || event.error ||
      (isRecord(event.result) && event.result.isError === true) || !context.agentId) return;
    const scope = sessionScope(context);
    const path = scope ? readPath(event.params) : undefined;
    if (!scope || !path) return;
    // Ignore late callbacks for cleared, closed, or unknown sessions rather than recreating stale state.
    const state = sessions.get(scope);
    if (!state) return;
    try {
      const canonicalPath = runtime.resolveSkillPath(active(context.agentId), path);
      if (!canonicalPath) return;
      touchSession(scope, state);
      const history = state.skills.get(canonicalPath) ?? {};
      history.opened = state.turn;
      state.skills.set(canonicalPath, history);
    } catch {
      api.logger.warn("unblock-memory skill whisperer read tracking failed");
    }
  }, { matcher: ["read"] });

  api.on("session_end", (event, context) => {
    for (const scope of [event.sessionId, event.sessionKey, context.sessionKey]) {
      if (!scope) continue;
      sessions.get(scope)?.controller?.abort();
      sessions.delete(scope);
    }
  });
  api.on("gateway_stop", () => {
    for (const state of sessions.values()) state.controller?.abort();
    sessions.clear();
  });
  return beforePrompt;
}
