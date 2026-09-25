import { basename } from "node:path";
import { selectTypeSafeSkill } from "./typesafe.js";
import { resolveTypeSafeApiKey, TypeSafeRequestError } from "./typesafe-client.js";
import { messageText } from "./whisperer-context.js";
const CANDIDATE_LIMIT = 10;
const MAX_QUERY_CHARS = 12_000;
const TYPESAFE_CANDIDATE_LIMIT = 3;
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function buildSkillWhispererQuery(prompt, messages, historyMessages) {
    const availableHistory = messages.flatMap((message) => {
        const parsed = messageText(message);
        return parsed ? [`${parsed.role}: ${parsed.text}`] : [];
    });
    const history = historyMessages === 0 ? [] : availableHistory.slice(-historyMessages);
    return [...history, `user: ${prompt.trim()}`].join("\n\n").slice(-MAX_QUERY_CHARS);
}
function typeSafeConversation(prompt, messages, historyMessages) {
    const currentRequest = prompt.trim().slice(-MAX_QUERY_CHARS);
    let remaining = MAX_QUERY_CHARS - currentRequest.length;
    const available = messages.flatMap(message => {
        const parsed = messageText(message);
        return parsed ? [{ role: parsed.role, content: parsed.text }] : [];
    });
    const history = [];
    for (const message of (historyMessages ? available.slice(-historyMessages) : []).reverse()) {
        if (remaining <= 0)
            break;
        const content = message.content.slice(-remaining);
        history.unshift({ role: message.role, content });
        remaining -= content.length;
    }
    return { currentRequest, history };
}
function readPath(params) {
    for (const value of [params.path, params.file_path, params.filePath]) {
        if (typeof value === "string" && basename(value).toLowerCase() === "skill.md")
            return value;
    }
    return undefined;
}
function sessionScope(context) {
    return context.sessionId || context.sessionKey;
}
export function registerSkillWhisperer(api, runtime, config, typesafe, diagnostics) {
    if (!config.enabled)
        return;
    const sessions = new Map();
    const stateFor = (scope) => {
        let state = sessions.get(scope);
        if (!state) {
            state = { turn: 0, skills: new Map() };
            sessions.set(scope, state);
        }
        return state;
    };
    const active = (agentId) => ({ cfg: api.config, agentId });
    const beforePrompt = async (event, context) => {
        const { agentId, runId } = context;
        const scope = sessionScope(context);
        if (context.trigger !== "user" || !scope || !runId || !agentId)
            return;
        const state = stateFor(scope);
        if (state.lastRunId === runId)
            return state.result;
        state.lastRunId = runId;
        state.turn += 1;
        // Reuse even an in-flight result when the host rebuilds this run's prompt.
        const run = async () => {
            try {
                const runtimeParams = active(agentId);
                const apiKey = await resolveTypeSafeApiKey(typesafe);
                if (!apiKey)
                    diagnostics?.record(agentId, "skill", typesafe.enabled ? "missing_key" : "typesafe_disabled");
                const candidates = await runtime.searchSkills(runtimeParams, buildSkillWhispererQuery(event.prompt, event.messages, config.historyMessages), apiKey ? -1 : config.minScore, CANDIDATE_LIMIT);
                const resolvedCandidates = candidates.flatMap((candidate) => {
                    const canonicalPath = runtime.resolveSkillPath(runtimeParams, candidate.path);
                    return canonicalPath ? [{ candidate, canonicalPath }] : [];
                });
                let resolved = resolvedCandidates[0];
                if (!resolved) {
                    diagnostics?.record(agentId, "skill", "no_candidates");
                    return;
                }
                if (apiKey) {
                    const shortlist = resolvedCandidates.slice(0, TYPESAFE_CANDIDATE_LIMIT);
                    const selectedIndex = await selectTypeSafeSkill({
                        apiKey, timeoutMs: typesafe.timeoutMs,
                        ...typeSafeConversation(event.prompt, event.messages, config.historyMessages),
                        candidates: shortlist.map(({ candidate }) => candidate),
                        onCandidateFailure: (candidateIndex, error) => {
                            diagnostics?.record(agentId, "skill", "judge_candidate_failed");
                            api.logger.warn("unblock-memory skill_whisperer " + JSON.stringify({ event: "candidate_failed",
                                agentId, runId, candidateIndex, errorCode: error instanceof TypeSafeRequestError ? error.code : "unexpected",
                                httpStatus: error instanceof TypeSafeRequestError ? error.status : undefined }));
                        },
                    });
                    if (selectedIndex === undefined) {
                        diagnostics?.record(agentId, "skill", "rejected");
                        return;
                    }
                    resolved = shortlist[selectedIndex];
                }
                else if (resolved && resolved.candidate.score < config.minScore) {
                    diagnostics?.record(agentId, "skill", "rejected");
                    return;
                }
                if (!resolved)
                    return;
                // A selection completing after session teardown must not resurrect its hint.
                if (sessions.get(scope) !== state || state.lastRunId !== runId) {
                    diagnostics?.record(agentId, "skill", "cancelled");
                    return;
                }
                const { candidate: selected, canonicalPath } = resolved;
                if (apiKey && runtime.resolveSkillPath(runtimeParams, selected.path) !== canonicalPath)
                    return;
                const previous = state.skills.get(canonicalPath);
                const lastSeen = Math.max(previous?.suggested ?? -Infinity, previous?.opened ?? -Infinity);
                if (state.turn - lastSeen <= config.cooldownTurns) {
                    diagnostics?.record(agentId, "skill", "cooldown");
                    return;
                }
                const history = state.skills.get(canonicalPath) ?? {};
                history.suggested = state.turn;
                state.skills.set(canonicalPath, history);
                diagnostics?.record(agentId, "skill", "emitted");
                return {
                    appendContext: `<skill>This skill may be relevant: ${JSON.stringify(selected.path).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e")}</skill>`,
                };
            }
            catch (error) {
                diagnostics?.record(agentId, "skill", error instanceof TypeSafeRequestError && error.code === "timeout" ? "timed_out" : "failed");
                api.logger.warn("unblock-memory skill whisperer failed; no hint emitted");
                return;
            }
        };
        state.result = run();
        return state.result;
    };
    api.on("after_tool_call", (event, context) => {
        if (event.toolName !== "read" || event.error ||
            (isRecord(event.result) && event.result.isError === true) || !context.agentId)
            return;
        const scope = sessionScope(context);
        const path = scope ? readPath(event.params) : undefined;
        if (!scope || !path)
            return;
        try {
            const canonicalPath = runtime.resolveSkillPath(active(context.agentId), path);
            if (!canonicalPath)
                return;
            const state = stateFor(scope);
            const history = state.skills.get(canonicalPath) ?? {};
            history.opened = state.turn;
            state.skills.set(canonicalPath, history);
        }
        catch {
            api.logger.warn("unblock-memory skill whisperer read tracking failed");
        }
    }, { matcher: ["read"] });
    api.on("session_end", (event, context) => {
        sessions.delete(event.sessionId);
        if (event.sessionKey)
            sessions.delete(event.sessionKey);
        if (context.sessionKey)
            sessions.delete(context.sessionKey);
    });
    return beforePrompt;
}
