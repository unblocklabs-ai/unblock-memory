import { basename } from "node:path";
const CANDIDATE_LIMIT = 10;
const MAX_QUERY_CHARS = 12_000;
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function messageText(message) {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant"))
        return undefined;
    if (typeof message.content === "string") {
        const text = message.content.trim();
        return text ? { role: message.role, text } : undefined;
    }
    if (!Array.isArray(message.content))
        return undefined;
    const text = message.content.flatMap((part) => {
        return isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [];
    }).join("\n").trim();
    return text ? { role: message.role, text } : undefined;
}
export function buildSkillWhispererQuery(prompt, messages, historyMessages) {
    const availableHistory = messages.flatMap((message) => {
        const parsed = messageText(message);
        return parsed ? [`${parsed.role}: ${parsed.text}`] : [];
    });
    const history = historyMessages === 0 ? [] : availableHistory.slice(-historyMessages);
    return [...history, `user: ${prompt.trim()}`].join("\n\n").slice(-MAX_QUERY_CHARS);
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
export function registerSkillWhisperer(api, runtime, config) {
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
    api.on("before_prompt_build", async (event, context) => {
        const scope = sessionScope(context);
        if (context.trigger !== "user" || !scope || !context.runId || !context.agentId)
            return;
        const state = stateFor(scope);
        if (state.lastRunId === context.runId)
            return;
        state.lastRunId = context.runId;
        state.turn += 1;
        try {
            const candidates = await runtime.searchSkills(active(context.agentId), buildSkillWhispererQuery(event.prompt, event.messages, config.historyMessages), config.minScore, CANDIDATE_LIMIT);
            const selected = candidates.find((candidate) => {
                if (candidate.score < config.minScore)
                    return false;
                const history = state.skills.get(candidate.path);
                const lastSeen = Math.max(history?.suggested ?? -Infinity, history?.opened ?? -Infinity);
                return state.turn - lastSeen > config.cooldownTurns;
            });
            if (!selected)
                return;
            const history = state.skills.get(selected.path) ?? {};
            history.suggested = state.turn;
            state.skills.set(selected.path, history);
            return {
                prependContext: `A potentially relevant skill is available: ${JSON.stringify(selected.name)} ` +
                    `at ${JSON.stringify(selected.path)}. Check it before proceeding if applicable.`,
            };
        }
        catch (error) {
            api.logger.warn(`unblock-memory skill whisperer search failed: ${String(error)}`);
            return;
        }
    });
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
        catch (error) {
            api.logger.warn(`unblock-memory skill whisperer read tracking failed: ${String(error)}`);
        }
    }, { matcher: ["read"] });
    api.on("session_end", (event, context) => {
        sessions.delete(event.sessionId);
        if (event.sessionKey)
            sessions.delete(event.sessionKey);
        if (context.sessionKey)
            sessions.delete(context.sessionKey);
    });
}
