import { normalizeAgentIdStrict } from "openclaw/plugin-sdk/routing";
const DEFAULT_SAFETY_MIN_PROBABILITY = 0.4;
const MAX_SCENARIOS = 20;
const MAX_TEXT_CHARS = 2000;
const MAX_ENTRIES = 500;
const SCENARIO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
function record(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    return value;
}
function onlyKeys(value, allowed, label) {
    const unknown = Object.keys(value).find(key => !allowed.includes(key));
    if (unknown)
        throw new Error(`${label} has unknown property: ${unknown}`);
}
function text(value, label, maximum = 256) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
        throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
    }
    return value.trim();
}
function list(value, label) {
    const raw = value ?? [];
    if (!Array.isArray(raw) || raw.length > MAX_ENTRIES)
        throw new Error(`${label} must be an array of at most ${MAX_ENTRIES} entries`);
    return raw;
}
function optionalName(value, label) {
    return value.name === undefined ? {} : { name: text(value.name, `${label}.name`) };
}
// Trusted identifiers; names are labels only and never participate in matching. The host
// lowercases provider and account IDs, and session keys fold channel IDs, so those compare
// case-insensitively. Sender IDs stay exact because they approve.
function channels(value, label) {
    return list(value, label).map((entry, index) => {
        const at = `${label}[${index}]`, channel = record(entry, at);
        onlyKeys(channel, ["name", "provider", "accountId", "channelId"], at);
        return { ...optionalName(channel, at), provider: text(channel.provider, `${at}.provider`).toLowerCase(),
            accountId: text(channel.accountId, `${at}.accountId`).toLowerCase(),
            channelId: text(channel.channelId, `${at}.channelId`).toLowerCase() };
    });
}
function requestors(value, label) {
    return list(value, label).map((entry, index) => {
        const at = `${label}[${index}]`, requestor = record(entry, at);
        onlyKeys(requestor, ["name", "provider", "accountId", "senderId"], at);
        return { ...optionalName(requestor, at), provider: text(requestor.provider, `${at}.provider`).toLowerCase(),
            accountId: text(requestor.accountId, `${at}.accountId`).toLowerCase(), senderId: text(requestor.senderId, `${at}.senderId`) };
    });
}
function scenario(value, index) {
    const at = `safetyWhisperer.scenarios[${index}]`, entry = record(value, at);
    onlyKeys(entry, ["id", "enabled", "instructions", "flaggedPrompt", "minProbability", "approvedRequestors",
        "excludedChannels", "agentIds"], at);
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!SCENARIO_ID.test(id))
        throw new Error(`${at}.id must be 1-64 letters, digits, '.', '_' or '-'`);
    const enabled = entry.enabled ?? true;
    if (typeof enabled !== "boolean")
        throw new Error(`${at}.enabled must be a boolean`);
    const minProbability = entry.minProbability ?? DEFAULT_SAFETY_MIN_PROBABILITY;
    if (typeof minProbability !== "number" || !Number.isFinite(minProbability) || minProbability < 0 || minProbability > 1) {
        throw new Error(`${at}.minProbability must be between 0 and 1`);
    }
    let agentIds;
    if (entry.agentIds !== undefined) {
        const raw = list(entry.agentIds, `${at}.agentIds`);
        if (!raw.length)
            throw new Error(`${at}.agentIds must be omitted or non-empty`);
        // The host normalizes agent IDs (lowercase), so match its form rather than the configured spelling.
        agentIds = [...new Set(raw.map((agentId, i) => {
                const normalized = normalizeAgentIdStrict(text(agentId, `${at}.agentIds[${i}]`));
                if (!normalized.ok)
                    throw new Error(`${at}.agentIds[${i}] is not a valid agent ID`);
                return normalized.value;
            }))];
    }
    return {
        id, enabled, minProbability,
        instructions: text(entry.instructions, `${at}.instructions`, MAX_TEXT_CHARS),
        flaggedPrompt: text(entry.flaggedPrompt, `${at}.flaggedPrompt`, MAX_TEXT_CHARS),
        approvedRequestors: requestors(entry.approvedRequestors, `${at}.approvedRequestors`),
        excludedChannels: channels(entry.excludedChannels, `${at}.excludedChannels`),
        ...(agentIds ? { agentIds } : {}),
    };
}
export function resolveSafetyWhisperer(value) {
    const defaults = { enabled: false, historyMessages: 6, timeoutMs: 3000, excludedChannels: [], scenarios: [] };
    if (value === undefined)
        return defaults;
    const config = record(value, "safetyWhisperer");
    onlyKeys(config, ["enabled", "historyMessages", "timeoutMs", "excludedChannels", "scenarios"], "safetyWhisperer");
    const enabled = config.enabled ?? false;
    if (typeof enabled !== "boolean")
        throw new Error("safetyWhisperer.enabled must be a boolean");
    const integer = (key, minimum, maximum) => {
        const n = config[key] ?? defaults[key];
        if (typeof n !== "number" || !Number.isInteger(n) || n < minimum || n > maximum) {
            throw new Error(`safetyWhisperer.${key} must be an integer between ${minimum} and ${maximum}`);
        }
        return n;
    };
    const raw = config.scenarios ?? [];
    if (!Array.isArray(raw) || raw.length > MAX_SCENARIOS)
        throw new Error(`safetyWhisperer.scenarios must be an array of at most ${MAX_SCENARIOS}`);
    const scenarios = raw.map(scenario);
    const ids = new Set();
    for (const { id } of scenarios) {
        if (ids.has(id))
            throw new Error(`safetyWhisperer scenario ids must be unique: ${id}`);
        ids.add(id);
    }
    if (enabled && !scenarios.length)
        throw new Error("enabled safetyWhisperer requires at least one scenario");
    return { enabled, scenarios, historyMessages: integer("historyMessages", 0, 20), timeoutMs: integer("timeoutMs", 1, 10_000),
        excludedChannels: channels(config.excludedChannels, "safetyWhisperer.excludedChannels") };
}
