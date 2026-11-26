import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import { DEFAULTS } from "./defaults.js";
import { readSkillCatalogEntry, type SkillCatalogEntry, type SkillSearchCandidate } from "./manager.js";
import { scoreSkillCatalog } from "./decision-ranking.js";
import { isDecisionTimeout, resolveDecisionCredential, DecisionRequestError } from "./decision-client.js";
import { buildSkillWhispererQuery, MAX_SKILL_QUERY_CHARS, recentSkillMessages } from "./whisperer-context.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
import { SkillSessionStore, type ActiveSkillEntry } from "./skill-session-store.js";
import { abortable } from "./abortable.js";
import { isRecord } from "./guards.js";
import { whispererSurface, type WhispererPrompt, type WhispererSurface } from "./whisperer-prompt.js";

const settings = DEFAULTS.skillWhisperer;
const MAX_SESSIONS = 1_000;
const MAX_SEEN_RUNS = 64;
const DAY_MS = 86_400_000;
const RETENTION_MS = settings.sessionRetentionDays * DAY_MS;
export const SKILL_WHISPERER_TIMEOUT_MS = settings.timeoutMs;

type RuntimeParams = { cfg: OpenClawConfig; agentId: string };
type SkillWhispererRuntime = {
  listSkills?(params: RuntimeParams): Promise<SkillCatalogEntry[]>;
  memoryDatabasePath?(agentId: string): string;
  searchSkills(params: RuntimeParams, query: string, minScore: number, limit: number): Promise<SkillSearchCandidate[]>;
  resolveSkillPath(params: RuntimeParams, path: string): string | undefined;
};

type SessionState = {
  agentId: string;
  scope: string;
  turn: number;
  lastRunId?: string;
  seenRuns: Set<string>;
  lifetime: AbortController;
  result?: Promise<{ appendContext: string } | undefined>;
  controller?: AbortController;
  skills?: Map<string, ActiveSkillEntry>;
};

function decisionConversation(prompt: string, messages: ReturnType<typeof recentSkillMessages>) {
  const currentRequest = prompt.trim().slice(-MAX_SKILL_QUERY_CHARS);
  let remaining = MAX_SKILL_QUERY_CHARS - currentRequest.length;
  const history: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
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
}

function readSkillName(params: Record<string, unknown>): string | undefined {
  const value = params.name;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sessionScope(context: { sessionId?: string; sessionKey?: string }): string | undefined {
  return context.sessionId || context.sessionKey;
}

function sessionKey(agentId: string, scope: string, ephemeral = false): string {
  return JSON.stringify([agentId, scope, ephemeral]);
}

function isEphemeral(surface: WhispererSurface | undefined): boolean {
  return surface === "cron" || surface === "heartbeat";
}

function escapeXml(text: string): string {
  return text.replace(/[^\u{9}\u{A}\u{D}\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu, "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function attribute(text: string): string {
  return escapeXml(text).replaceAll('"', "&quot;");
}

function descriptionWithin(text: string, escapedBudget: number): string {
  let end = 0;
  let escapedChars = 0;
  for (const char of text) {
    escapedChars += escapeXml(char).length;
    if (end + char.length > settings.maxDescriptionChars || escapedChars > escapedBudget) break;
    end += char.length;
  }
  if (end === text.length) return escapeXml(text);
  if (escapedBudget < 1) return "";
  if (end === settings.maxDescriptionChars || escapedChars > escapedBudget) {
    // Leave room for the ellipsis without cutting a Unicode character or an XML entity.
    end -= [...text.slice(0, end)].at(-1)?.length ?? 0;
  }
  let prefix = text.slice(0, end).trimEnd();
  const wordBoundary = prefix.lastIndexOf(" ");
  if (wordBoundary > prefix.length * 0.85 && text[end] !== " ") prefix = prefix.slice(0, wordBoundary);
  return `${escapeXml(prefix)}…`;
}

function inActivationOrder(entries: readonly ActiveSkillEntry[]): ActiveSkillEntry[] {
  return entries.toSorted((a, b) => a.addedAtMs - b.addedAtMs ||
    (a.canonicalPath < b.canonicalPath ? -1 : a.canonicalPath > b.canonicalPath ? 1 : 0));
}

function renderSkills(entries: readonly ActiveSkillEntry[]): string | undefined {
  const header = "<skills>\nRelevant skills for this conversation (load SKILL.md via skills_read or read before following a skill's instructions):\n";
  const footer = "</skills>";
  let block = header;
  for (const entry of inActivationOrder(entries)) {
    const open = `- <skill name="${attribute(entry.name)}" path="${attribute(entry.canonicalPath)}">`;
    const close = "</skill>\n";
    const remaining = settings.maxInjectedChars - block.length - open.length - close.length - footer.length;
    if (remaining < 0) break;
    const description = entry.description.replace(/\s+/gu, " ").trim();
    const text = descriptionWithin(description, block === header ? remaining : Infinity);
    if (text.length > remaining) break;
    block += open + text + close;
  }
  return block === header ? undefined : block + footer;
}

export function registerSkillWhisperer(
  api: OpenClawPluginApi,
  runtime: SkillWhispererRuntime,
  config: UnblockMemoryConfig["skillWhisperer"],
  decisionModel: UnblockMemoryConfig["decisionModel"],
  diagnostics?: WhispererDiagnostics,
): WhispererPrompt | undefined {
  if (!config.enabled) return;
  const sessions = new Map<string, SessionState>();
  const ended = new Map<string, Set<string>>();
  const stores = new Map<string, { store: SkillSessionStore; prunedAt: number }>();
  let stopped = false;
  const paramsFor = (agentId: string) => ({ cfg: api.config, agentId });

  const storeFor = (agentId: string, existingOnly = false) => {
    const path = runtime.memoryDatabasePath?.(agentId);
    if (!path) return;
    let entry = stores.get(path);
    if (!entry) {
      if (existingOnly && !existsSync(path)) return;
      entry = { store: new SkillSessionStore(path), prunedAt: -Infinity };
      stores.set(path, entry);
    }
    const now = Date.now();
    if (now - entry.prunedAt >= DAY_MS) {
      entry.store.pruneExpired(now - RETENTION_MS);
      entry.prunedAt = now;
    }
    return entry.store;
  };

  const stateFor = (key: string, agentId: string, scope: string) => {
    let state = sessions.get(key);
    if (state) sessions.delete(key);
    else {
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value!;
        sessions.get(oldest)?.lifetime.abort();
        sessions.delete(oldest);
      }
      state = { agentId, scope, turn: 0, seenRuns: ended.get(key) ?? new Set(), lifetime: new AbortController() };
      ended.delete(key);
    }
    sessions.set(key, state);
    return state;
  };

  const hydrate = (state: SessionState, store: SkillSessionStore | undefined) => {
    if (!state.skills) {
      const entries = store?.list(state.scope) ?? [];
      state.skills = new Map(entries.map(entry => [entry.canonicalPath, entry]));
      for (const entry of entries) state.turn = Math.max(state.turn, entry.addedTurn);
    }
    return state.skills;
  };

  const catalogFor = <T extends SkillCatalogEntry>(params: RuntimeParams, entries: readonly T[]) => {
    const catalog = new Map<string, T>();
    for (const entry of entries) {
      const path = runtime.resolveSkillPath(params, entry.path);
      if (path && !catalog.has(path)) catalog.set(path, entry);
    }
    return catalog;
  };

  const activeSkills = (state: SessionState, params: RuntimeParams, catalog?: ReadonlyMap<string, SkillCatalogEntry>) => {
    const cutoff = Date.now() - RETENTION_MS;
    return [...state.skills?.values() ?? []].flatMap(entry => {
      const live = catalog?.get(entry.canonicalPath);
      // A catalog's lexical path may be a configured symlink to the canonical file.
      if (entry.lastUsedAtMs < cutoff || runtime.resolveSkillPath(params, live?.path ?? entry.canonicalPath) !== entry.canonicalPath) return [];
      return [live ? { ...entry, name: live.name, description: live.description } : entry];
    });
  };

  const prune = (state: SessionState, entries: readonly ActiveSkillEntry[], store?: SkillSessionStore) => {
    if (!state.skills || state.skills.size === entries.length) return;
    const valid = new Set(entries.map(entry => entry.canonicalPath));
    store?.pruneMissing(state.scope, valid);
    for (const path of state.skills.keys()) if (!valid.has(path)) state.skills.delete(path);
  };

  const save = (state: SessionState, entries: readonly ActiveSkillEntry[], store?: SkillSessionStore) => {
    if (!entries.length) return;
    store?.upsert(state.scope, entries);
    for (const entry of entries) state.skills?.set(entry.canonicalPath, entry);
  };

  // Separate admissions append even when the clock repeats a millisecond or moves backward.
  const nextAddedAt = (state: SessionState, now: number) => {
    for (const entry of state.skills?.values() ?? []) now = Math.max(now, entry.addedAtMs + 1);
    return now;
  };

  const retireRun = (state: SessionState) => {
    state.controller?.abort();
    if (state.lastRunId) {
      state.seenRuns.add(state.lastRunId);
      if (state.seenRuns.size > MAX_SEEN_RUNS) state.seenRuns.delete(state.seenRuns.values().next().value!);
    }
    state.lastRunId = undefined;
    state.result = undefined;
  };

  const beforePrompt: WhispererPrompt = async (event, context, surface) => {
    const { agentId, runId } = context;
    const scope = sessionScope(context);
    if (stopped || (!surface && context.trigger !== "user") || !scope || !runId || !agentId) return;
    const ephemeral = isEphemeral(surface);
    const key = sessionKey(agentId, scope, ephemeral);
    if (ended.get(key)?.has(runId)) return;
    const state = stateFor(key, agentId, scope);
    if (state.lastRunId === runId) return state.result;
    if (state.seenRuns.has(runId)) return;
    retireRun(state);
    if (ephemeral) state.skills = new Map();
    state.lastRunId = runId;
    const controller = new AbortController();
    state.controller = controller;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("Skill deadline", "TimeoutError")), SKILL_WHISPERER_TIMEOUT_MS);
    const signal = AbortSignal.any([controller.signal, state.lifetime.signal, deadline.signal]);
    const ownsRun = () => !controller.signal.aborted && sessions.get(key) === state && state.lastRunId === runId;
    const params = paramsFor(agentId);
    let catalog: Map<string, SkillCatalogEntry> | undefined;
    let store: SkillSessionStore | undefined;
    const diagnose = (outcome: Parameters<WhispererDiagnostics["record"]>[2]) => diagnostics?.record(agentId, "skill", outcome);

    const emit = (entries: readonly ActiveSkillEntry[], added = false) => {
      const block = renderSkills(entries);
      if (!block) return;
      diagnose(added ? "emitted" : "active_reused");
      return { appendContext: block };
    };
    const finish = (entries: readonly ActiveSkillEntry[], additions: readonly ActiveSkillEntry[] = []) => {
      const now = Date.now();
      save(state, [...entries.map(entry => ({ ...entry, lastUsedAtMs: now })), ...additions], store);
      return emit([...entries, ...additions], additions.length > 0);
    };

    const run = async () => {
      try {
        if (!ephemeral) store = storeFor(agentId);
        const skills = hydrate(state, store);
        state.turn += 1;
        const live = runtime.listSkills && await abortable(runtime.listSkills(params), signal);
        signal.throwIfAborted();
        if (live) catalog = catalogFor(params, live);
        const entries = activeSkills(state, params, catalog);
        prune(state, entries, store);
        if (skills.size >= settings.maxActiveSkillsPerSession) return finish(entries);

        const apiKey = await abortable(resolveDecisionCredential(decisionModel), signal);
        signal.throwIfAborted();
        if (!apiKey) diagnose(decisionModel.enabled ? "missing_key" : "decision_disabled");
        const recent = recentSkillMessages(event.messages, config.historyMessages);
        const direct = apiKey && live && live.length <= settings.maxDirectCatalogSkills;
        const candidates: ReadonlyMap<string, SkillCatalogEntry & { score?: number }> = direct && catalog
          ? catalog
          : catalogFor(params, (await abortable(runtime.searchSkills(params,
            buildSkillWhispererQuery(event.prompt, recent), apiKey ? -1 : config.minScore, settings.maxCandidates,
          ), signal)).filter(candidate => apiKey || candidate.score >= config.minScore));
        signal.throwIfAborted();
        const eligible = [...candidates].filter(([path]) => !skills.has(path));
        if (!eligible.length) diagnose("no_candidates");
        const matches = !eligible.length ? [] : apiKey ? await abortable(scoreSkillCatalog({
          apiKey, endpoint: decisionModel.endpoint, model: decisionModel.model, timeoutMs: SKILL_WHISPERER_TIMEOUT_MS, signal,
          ...decisionConversation(event.prompt, recent), candidates: eligible.map(([, candidate]) => candidate),
          onBatchFailure: (batchIndex, error) => {
            if (signal.aborted) return;
            diagnose("judge_candidate_failed");
            api.logger.warn("unblock-memory skill_whisperer " + JSON.stringify({ event: "batch_failed", agentId, runId, batchIndex,
              errorCode: error instanceof DecisionRequestError ? error.code : "unexpected",
              httpStatus: error instanceof DecisionRequestError ? error.status : undefined }));
          },
        }), signal) : eligible.slice(0, settings.maxMatchesPerTurn).map(([, candidate], index) => ({ index, score: candidate.score }));
        if (eligible.length && !matches.length) diagnose("rejected");
        signal.throwIfAborted();

        // Reads may pin skills while the provider is in flight. Recheck files, exclusions and capacity before writing.
        const current = activeSkills(state, params, catalog);
        prune(state, current, store);
        const now = Date.now();
        const addedAtMs = nextAddedAt(state, now);
        const additions: ActiveSkillEntry[] = [];
        for (const { index, score } of matches) {
          if (skills.size + additions.length >= settings.maxActiveSkillsPerSession) break;
          const [canonicalPath, candidate] = eligible[index]!;
          if (skills.has(canonicalPath) || runtime.resolveSkillPath(params, candidate.path) !== canonicalPath) continue;
          additions.push({ canonicalPath, name: candidate.name, description: candidate.description,
            source: "whisperer", score, addedTurn: state.turn, addedAtMs, lastUsedAtMs: now });
        }
        return finish(current, additions);
      } catch (error) {
        if (!ownsRun()) { diagnose("cancelled"); return; }
        const timedOut = isDecisionTimeout(error, signal);
        diagnose(timedOut ? "timed_out" : "failed");
        if (!timedOut) api.logger.warn("unblock-memory skill whisperer could not route new skills");
        let entries: ActiveSkillEntry[] | undefined;
        try {
          // A deadline can stop routing, but never retire an existing skill. Cancellation does neither.
          entries = activeSkills(state, params, catalog);
          return finish(entries);
        } catch {
          api.logger.warn("unblock-memory skill whisperer could not refresh active skills");
          return entries && emit(entries);
        }
      } finally { clearTimeout(timer); }
    };
    state.result = run();
    return state.result;
  };

  api.on("after_tool_call", async (event, context) => {
    const { agentId } = context;
    const isRead = event.toolName === "read";
    const isSkillsRead = event.toolName === "skills_read";
    if (stopped || (!isRead && !isSkillsRead) || event.error || !agentId || context.abortSignal?.aborted ||
      (isRecord(event.result) && event.result.isError === true)) return;
    const scope = sessionScope(context);
    const path = isRead ? readPath(event.params) : undefined;
    const skillName = isSkillsRead ? readSkillName(event.params) : undefined;
    if (!scope || (isRead ? !path : !skillName || !runtime.listSkills)) return;
    const key = sessionKey(agentId, scope);
    const runId = context.runId ?? event.runId;
    const ephemeral = sessions.get(sessionKey(agentId, scope, true));
    // Older tool-hook payloads may omit the trigger; a known ephemeral run still must not pin skills.
    if (isEphemeral(whispererSurface(context)) ||
        (ephemeral && (!runId || ephemeral.lastRunId === runId || ephemeral.seenRuns.has(runId)))) return;
    if (ended.has(key) || (runId && sessions.get(key)?.seenRuns.has(runId))) return;
    try {
      const params = paramsFor(agentId);
      let canonicalPath = path ? runtime.resolveSkillPath(params, path) : undefined;
      if (isRead && !canonicalPath) return;
      const state = stateFor(key, agentId, scope);
      const store = storeFor(agentId);
      const skills = hydrate(state, store);
      let catalog: Map<string, SkillCatalogEntry> | undefined;
      if (runtime.listSkills) {
        const signal = context.abortSignal
          ? AbortSignal.any([state.lifetime.signal, context.abortSignal]) : state.lifetime.signal;
        try {
          catalog = catalogFor(params, await abortable(runtime.listSkills(params), signal));
        } catch {
          if (isSkillsRead) return;
          /* A valid direct read can use local frontmatter if the catalog is unavailable. */
        }
      }
      let matchedByName: [string, SkillCatalogEntry] | undefined;
      if (isSkillsRead && skillName && catalog) {
        const target = skillName.toLowerCase();
        matchedByName = [...catalog.entries()].find(([, entry]) => entry.name.toLowerCase() === target);
        canonicalPath = matchedByName?.[0];
      }
      const verifyPath = isRead ? path! : matchedByName?.[1].path;
      if (!canonicalPath || !verifyPath || sessions.get(key) !== state || context.abortSignal?.aborted ||
        (runId && state.seenRuns.has(runId)) || runtime.resolveSkillPath(params, verifyPath) !== canonicalPath) return;
      if (catalog || !runtime.listSkills) prune(state, activeSkills(state, params, catalog), store);
      const prior = skills.get(canonicalPath);
      if (!prior && skills.size >= settings.maxActiveSkillsPerSession) return;
      const entry = matchedByName?.[1] ?? catalog?.get(canonicalPath) ?? readSkillCatalogEntry(canonicalPath);
      const now = Date.now();
      save(state, [{ canonicalPath, name: entry.name, description: entry.description,
        source: prior?.source ?? "read", score: prior?.score, addedTurn: prior?.addedTurn ?? state.turn,
        addedAtMs: prior?.addedAtMs ?? nextAddedAt(state, now), lastUsedAtMs: now }], store);
    } catch {
      api.logger.warn("unblock-memory skill whisperer could not pin a read skill");
    }
  }, { matcher: ["read", "skills_read"] });

  api.on("session_end", (event, context) => {
    if (stopped) return;
    const compacted = event.reason === "compaction";
    const successor = compacted && event.nextSessionId !== event.sessionId ? event.nextSessionId : undefined;
    const scopes = [...new Set([event.sessionId, event.sessionKey, context.sessionId, context.sessionKey]
      .filter((scope): scope is string => !!scope && scope !== successor))];
    const agents = context.agentId ? [context.agentId] : new Set([...sessions.values()]
      .filter(state => scopes.includes(state.scope)).map(state => state.agentId));
    for (const agentId of agents) {
      const previous = new Map<string, SessionState>();
      for (const scope of scopes) {
        for (const ephemeral of [false, true]) {
          const key = sessionKey(agentId, scope, ephemeral);
          const state = sessions.get(key);
          if (ephemeral && !state) continue;
          if (state) retireRun(state);
          if (compacted && !successor) continue;
          if (state && !ephemeral) previous.set(scope, state);
          state?.lifetime.abort();
          sessions.delete(key);
          const retired = state?.seenRuns ?? ended.get(key) ?? new Set<string>();
          ended.delete(key);
          ended.set(key, retired);
          if (ended.size > MAX_SESSIONS) ended.delete(ended.keys().next().value!);
        }
      }
      // These lifecycle notifications do not end the conversation.
      if (event.reason === "shutdown" || event.reason === "restart" || (compacted && !successor)) continue;
      try {
        const store = storeFor(agentId, true);
        if (!successor) {
          for (const scope of scopes) store?.deleteSession(scope);
          continue;
        }
        const inherited = inActivationOrder(scopes.flatMap(scope =>
          store?.list(scope) ?? [...previous.get(scope)?.skills?.values() ?? []]));
        if (!inherited.length) continue;
        const next = stateFor(sessionKey(agentId, successor), agentId, successor);
        const skills = hydrate(next, store);
        const merged = new Map<string, ActiveSkillEntry>();
        for (const entry of inherited) if (!merged.has(entry.canonicalPath)) merged.set(entry.canonicalPath, entry);
        let addedAtMs = nextAddedAt({ ...next, skills: merged }, Date.now());
        for (const entry of inActivationOrder([...skills.values()])) {
          if (!merged.has(entry.canonicalPath)) merged.set(entry.canonicalPath, { ...entry, addedAtMs: addedAtMs++ });
        }
        const entries = [...merged.values()].slice(0, settings.maxActiveSkillsPerSession);
        store?.rebindSession(scopes, successor, entries);
        skills.clear();
        for (const entry of entries) {
          skills.set(entry.canonicalPath, entry);
          next.turn = Math.max(next.turn, entry.addedTurn);
        }
      } catch {
        api.logger.warn("unblock-memory skill whisperer could not reconcile ended session");
      }
    }
  });
  api.on("gateway_stop", () => {
    stopped = true;
    for (const state of sessions.values()) state.lifetime.abort();
    sessions.clear();
    ended.clear();
    for (const { store } of stores.values()) store.close();
    stores.clear();
  });
  return beforePrompt;
}
