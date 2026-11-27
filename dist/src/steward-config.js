import { resolveDecisionCredential } from "./decision-client.js";
import { isAbsolute } from "node:path";
import { isRecord } from "./guards.js";
const efforts = ["off", "minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_STEWARD_CONFIG = {
    enabled: true, model: "gpt-6.2-sol", reasoning: "medium", endpoint: "https://codex.unblocklabs.ai/v1/responses",
    maxActiveBackground: 1,
    deepThought: { enabled: true, maxTurns: 6, maxToolCalls: 16, maxConcurrent: 2, timeoutMs: 60_000,
        maxToolResultChars: 8000, maxInputTokens: 48_000 },
    peopleShadow: { enabled: true, intervalMinutes: 60, maxItemsPerRun: 10, timeoutMs: 45_000 },
};
function section(value = {}, defaults, label, optional = []) {
    if (!isRecord(value))
        throw new Error(`${label} must be an object`);
    for (const key of Object.keys(value)) {
        if (!Object.hasOwn(defaults, key) && !optional.includes(key))
            throw new Error(`Unknown ${label} property: ${key}`);
    }
    return { ...defaults, ...value };
}
function integer(value, min, max, key) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`steward.${key} must be an integer between ${min} and ${max}`);
    }
    return value;
}
function enabled(value, label) {
    if (typeof value !== "boolean")
        throw new Error(`${label}.enabled must be a boolean`);
    return value;
}
function text(value, key) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`steward.${key} must be a non-empty string`);
    return value.trim();
}
function absolutePath(value) {
    const path = text(value, "apiKeyFile");
    if (!isAbsolute(path))
        throw new Error("steward.apiKeyFile must be an absolute path");
    return path;
}
function endpoint(value) {
    const url = typeof value === "string" && /^https?:\/\//iu.test(value) && !/[\s?#\\]/u.test(value) &&
        !value.split("/")[2]?.includes("@") && URL.canParse(value) ? new URL(value) : undefined;
    // Plain HTTP would expose the bearer credential: allow it for loopback only, matching decisionModel.endpoint.
    const loopback = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!url || url.username || url.password || (url.protocol === "http:" && !loopback)) {
        throw new Error("steward.endpoint must be an HTTPS (or loopback HTTP) URL without credentials, query or fragment");
    }
    return url.href.replace(/\/+$/u, "");
}
export function resolveStewardConfig(value) {
    const defaults = DEFAULT_STEWARD_CONFIG;
    const c = section(value, defaults, "steward", ["apiKey", "apiKeyFile"]);
    const d = section(c.deepThought, defaults.deepThought, "steward.deepThought");
    const p = section(c.peopleShadow, defaults.peopleShadow, "steward.peopleShadow");
    const reasoning = efforts.find(e => e === c.reasoning);
    if (!reasoning)
        throw new Error("Invalid steward.reasoning");
    const apiKey = c.apiKey === undefined ? undefined : text(c.apiKey, "apiKey");
    if (apiKey && /\s/u.test(apiKey))
        throw new Error("steward.apiKey must not contain whitespace");
    return { enabled: enabled(c.enabled, "steward"), model: text(c.model, "model"), reasoning, endpoint: endpoint(c.endpoint),
        ...(apiKey ? { apiKey } : {}), ...(c.apiKeyFile === undefined ? {} : { apiKeyFile: absolutePath(c.apiKeyFile) }),
        maxActiveBackground: integer(c.maxActiveBackground, 1, 4, "maxActiveBackground"),
        deepThought: { enabled: enabled(d.enabled, "steward.deepThought"), maxTurns: integer(d.maxTurns, 1, 12, "deepThought.maxTurns"),
            maxToolCalls: integer(d.maxToolCalls, 1, 32, "deepThought.maxToolCalls"), maxConcurrent: integer(d.maxConcurrent, 1, 4, "deepThought.maxConcurrent"),
            timeoutMs: integer(d.timeoutMs, 5000, 180_000, "deepThought.timeoutMs"),
            maxToolResultChars: integer(d.maxToolResultChars, 500, 32_000, "deepThought.maxToolResultChars"),
            maxInputTokens: integer(d.maxInputTokens, 2000, 128_000, "deepThought.maxInputTokens") },
        peopleShadow: { enabled: enabled(p.enabled, "steward.peopleShadow"), intervalMinutes: integer(p.intervalMinutes, 5, 1440, "peopleShadow.intervalMinutes"),
            maxItemsPerRun: integer(p.maxItemsPerRun, 1, 50, "peopleShadow.maxItemsPerRun"),
            timeoutMs: integer(p.timeoutMs, 5000, 180_000, "peopleShadow.timeoutMs") },
    };
}
/** Bind the runner's resolveApiKey callback to its destination. Never inherit another origin's key. */
export async function resolveStewardCredential(config, decision) {
    if (config.apiKey !== undefined || config.apiKeyFile !== undefined)
        return resolveDecisionCredential(config);
    if (!config.enabled || new URL(config.endpoint).origin !== new URL(decision.endpoint).origin)
        return undefined;
    return resolveDecisionCredential(decision);
}
