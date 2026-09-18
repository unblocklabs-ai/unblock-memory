import { basename } from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { SkillSearchCandidate } from "./manager.js";
import { resolveTypeSafeApiKey, selectTypeSafeSkill } from "./typesafe.js";
import { messageText } from "./whisperer-context.js";
import type { WhispererDiagnostics } from "./diagnostics.js";

const CANDIDATE_LIMIT = 10;
const MAX_QUERY_CHARS = 12_000;
const TYPESAFE_CANDIDATE_LIMIT = 3;

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
  skills: Map<string, { suggested?: number; opened?: number }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function buildSkillWhispererQuery(
  prompt: string,
  messages: readonly unknown[],
  historyMessages: number,
): string {
  const availableHistory = messages.flatMap((message) => {
    const parsed = messageText(message);
    return parsed ? [`${parsed.role}: ${parsed.text}`] : [];
  });
  const history = historyMessages === 0 ? [] : availableHistory.slice(-historyMessages);
  return [...history, `user: ${prompt.trim()}`].join("\n\n").slice(-MAX_QUERY_CHARS);
}

function typeSafeConversation(prompt: string, messages: readonly unknown[], historyMessages: number) {
  const currentRequest = prompt.trim().slice(-MAX_QUERY_CHARS);
  let remaining = MAX_QUERY_CHARS - currentRequest.length;
  const available = messages.flatMap(message => {
    const parsed = messageText(message);
    return parsed ? [{ role: parsed.role, content: parsed.text }] : [];
  });
  const history: { role: "user" | "assistant"; content: string }[] = [];
  for (const message of (historyMessages ? available.slice(-historyMessages) : []).reverse()) {
    if (remaining <= 0) break;
    const content = message.content.slice(-remaining);
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
  typesafe: UnblockMemoryConfig["typesafe"],
  diagnostics?: WhispererDiagnostics,
): void {
  if (!config.enabled) return;
  const sessions = new Map<string, SessionState>();
  const stateFor = (scope: string) => {
    let state = sessions.get(scope);
    if (!state) {
      state = { turn: 0, skills: new Map() };
      sessions.set(scope, state);
    }
    return state;
  };
  const active = (agentId: string) => ({ cfg: api.config, agentId });

  api.on("before_prompt_build", async (event, context) => {
    const scope = sessionScope(context);
    if (context.trigger !== "user" || !scope || !context.runId || !context.agentId) return;
    const state = stateFor(scope);
    if (state.lastRunId === context.runId) return;
    state.lastRunId = context.runId;
    state.turn += 1;
    try {
      const runtimeParams = active(context.agentId);
      const apiKey = await resolveTypeSafeApiKey(typesafe);
      if (!apiKey) diagnostics?.record(context.agentId, "skill", typesafe.enabled ? "missing_key" : "typesafe_disabled");
      const candidates = await runtime.searchSkills(
        runtimeParams,
        buildSkillWhispererQuery(event.prompt, event.messages, config.historyMessages),
        apiKey ? -1 : config.minScore,
        CANDIDATE_LIMIT,
      );
      const resolvedCandidates = candidates.flatMap((candidate) => {
        const canonicalPath = runtime.resolveSkillPath(runtimeParams, candidate.path);
        return canonicalPath ? [{ candidate, canonicalPath }] : [];
      });
      let resolved = resolvedCandidates[0];
      if (!resolved) { diagnostics?.record(context.agentId, "skill", "no_candidates"); return; }
      if (apiKey) {
        const shortlist = resolvedCandidates.slice(0, TYPESAFE_CANDIDATE_LIMIT);
        const selectedIndex = await selectTypeSafeSkill({
          apiKey, timeoutMs: typesafe.timeoutMs,
          ...typeSafeConversation(event.prompt, event.messages, config.historyMessages),
          candidates: shortlist.map(({ candidate }) => candidate),
        });
        if (selectedIndex === undefined) { diagnostics?.record(context.agentId, "skill", "rejected"); return; }
        resolved = shortlist[selectedIndex];
      } else if (resolved && resolved.candidate.score < config.minScore) { diagnostics?.record(context.agentId, "skill", "rejected"); return; }
      if (!resolved) return;
      // A selection completing after session teardown must not resurrect its hint.
      if (sessions.get(scope) !== state || state.lastRunId !== context.runId) { diagnostics?.record(context.agentId, "skill", "cancelled"); return; }
      const { candidate: selected, canonicalPath } = resolved;
      if (apiKey && runtime.resolveSkillPath(runtimeParams, selected.path) !== canonicalPath) return;
      const previous = state.skills.get(canonicalPath);
      const lastSeen = Math.max(previous?.suggested ?? -Infinity, previous?.opened ?? -Infinity);
      if (state.turn - lastSeen <= config.cooldownTurns) { diagnostics?.record(context.agentId, "skill", "cooldown"); return; }
      const history = state.skills.get(canonicalPath) ?? {};
      history.suggested = state.turn;
      state.skills.set(canonicalPath, history);
      diagnostics?.record(context.agentId, "skill", "emitted");
      return {
        prependContext:
          `A potentially relevant skill is available: ${JSON.stringify(selected.name)} ` +
          `at ${JSON.stringify(selected.path)}. Check it before proceeding if applicable.`,
      };
    } catch (error) {
      diagnostics?.record(context.agentId, "skill", error instanceof Error && error.message === "TypeSafe selection timed out" ? "timed_out" : "failed");
      api.logger.warn("unblock-memory skill whisperer failed; no hint emitted");
      return;
    }
  });

  api.on("after_tool_call", (event, context) => {
    if (event.toolName !== "read" || event.error ||
      (isRecord(event.result) && event.result.isError === true) || !context.agentId) return;
    const scope = sessionScope(context);
    const path = scope ? readPath(event.params) : undefined;
    if (!scope || !path) return;
    try {
      const canonicalPath = runtime.resolveSkillPath(active(context.agentId), path);
      if (!canonicalPath) return;
      const state = stateFor(scope);
      const history = state.skills.get(canonicalPath) ?? {};
      history.opened = state.turn;
      state.skills.set(canonicalPath, history);
    } catch {
      api.logger.warn("unblock-memory skill whisperer read tracking failed");
    }
  }, { matcher: ["read"] });

  api.on("session_end", (event, context) => {
    sessions.delete(event.sessionId);
    if (event.sessionKey) sessions.delete(event.sessionKey);
    if (context.sessionKey) sessions.delete(context.sessionKey);
  });
}
