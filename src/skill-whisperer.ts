import { basename } from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { SkillSearchCandidate } from "./manager.js";

const CANDIDATE_LIMIT = 10;
const MAX_QUERY_CHARS = 12_000;

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

function messageText(message: unknown): { role: "user" | "assistant"; text: string } | undefined {
  if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) return undefined;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text ? { role: message.role, text } : undefined;
  }
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content.flatMap((part) => {
    return isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [];
  }).join("\n").trim();
  return text ? { role: message.role, text } : undefined;
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
      const candidates = await runtime.searchSkills(
        runtimeParams,
        buildSkillWhispererQuery(event.prompt, event.messages, config.historyMessages),
        config.minScore,
        CANDIDATE_LIMIT,
      );
      const resolved = candidates.flatMap((candidate) => {
        const canonicalPath = runtime.resolveSkillPath(runtimeParams, candidate.path);
        return canonicalPath ? [{ candidate, canonicalPath }] : [];
      })[0];
      if (!resolved || resolved.candidate.score < config.minScore) return;
      const { candidate: selected, canonicalPath } = resolved;
      const previous = state.skills.get(canonicalPath);
      const lastSeen = Math.max(previous?.suggested ?? -Infinity, previous?.opened ?? -Infinity);
      if (state.turn - lastSeen <= config.cooldownTurns) return;
      const history = state.skills.get(canonicalPath) ?? {};
      history.suggested = state.turn;
      state.skills.set(canonicalPath, history);
      return {
        prependContext:
          `A potentially relevant skill is available: ${JSON.stringify(selected.name)} ` +
          `at ${JSON.stringify(selected.path)}. Check it before proceeding if applicable.`,
      };
    } catch (error) {
      api.logger.warn(`unblock-memory skill whisperer search failed: ${String(error)}`);
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
    } catch (error) {
      api.logger.warn(`unblock-memory skill whisperer read tracking failed: ${String(error)}`);
    }
  }, { matcher: ["read"] });

  api.on("session_end", (event, context) => {
    sessions.delete(event.sessionId);
    if (event.sessionKey) sessions.delete(event.sessionKey);
    if (context.sessionKey) sessions.delete(context.sessionKey);
  });
}
