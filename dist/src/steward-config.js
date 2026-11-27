import { resolveDecisionCredential } from "./decision-client.js";
import { isAbsolute } from "node:path";
import { isRecord } from "./guards.js";
const efforts = ["off", "minimal", "low", "medium", "high", "xhigh"];
const searchRankings = ["retrieval", "decision"];
const peopleModes = ["publish", "shadow"];
const confidences = ["high", "medium", "low"];
const chatTypes = ["channel", "group", "direct"];
const DEFAULT_STEWARD_CONFIG = {
    enabled: true, model: "gpt-6.2-sol", reasoning: "medium", endpoint: "https://codex.unblocklabs.ai/v1/responses",
    maxActiveBackground: 1,
    deepThought: {
        enabled: true,
        maxTurns: 0,
        maxToolCalls: 0,
        maxConcurrent: 0,
        timeoutMs: 0,
        syncWaitMs: 65_000,
        jobRetentionMs: 1_800_000,
        wrapUpReserveMs: 20_000,
        maxToolResultChars: 0,
        maxInputTokens: 0,
        searchRanking: "retrieval",
        searchMinUsefulness: 0,
        defaultSearchResults: 10,
        maxSnippetChars: 0,
        maxQuoteChars: 0,
        maxPeopleMatches: 0,
    },
    peopleShadow: {
        enabled: true,
        mode: "publish",
        intervalMinutes: 60,
        maxItemsPerRun: 0,
        timeoutMs: 0,
        minConfidence: "medium",
        maxHandles: 0,
        maxExcerptChars: 0,
        maxExportBytes: 0,
        maxNewClaimsPerPerson: 0,
        maxInteractionHandles: 0,
        includeResponseAudit: true,
    },
    captainsLog: {
        enabled: true,
        intervalMinutes: 180,
        lookbackMinutes: 190,
        maxSessionsPerRun: 0,
        maxCharsPerSession: 0,
        maxExistingLogChars: 0,
        timeoutMs: 0,
        excludeChatTypes: ["direct"],
    },
    outcomeLedger: {
        enabled: true,
        intervalMinutes: 60,
        lookbackMs: 604_800_000,
        maxRowsPerPass: 0,
        matchWindowMs: 1_800_000,
        retentionDays: 0,
    },
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
function integer(value, min, key) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
        throw new Error(`steward.${key} must be an integer >= ${min}`);
    }
    return value;
}
function unitInterval(value, key) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`steward.${key} must be a number between 0 and 1`);
    }
    return value;
}
function enabled(value, label) {
    return boolean(value, `${label}.enabled`);
}
function boolean(value, label) {
    if (typeof value !== "boolean")
        throw new Error(`${label} must be a boolean`);
    return value;
}
function chatTypeList(value, key) {
    if (!Array.isArray(value))
        throw new Error(`steward.${key} must be an array`);
    const out = [];
    for (const entry of value) {
        const matched = chatTypes.find(t => t === entry);
        if (!matched)
            throw new Error(`Invalid steward.${key} entry`);
        if (!out.includes(matched))
            out.push(matched);
    }
    return out;
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
    const d = section(c.deepThought, defaults.deepThought, "steward.deepThought", ["reasoning"]);
    const p = section(c.peopleShadow, defaults.peopleShadow, "steward.peopleShadow", ["includeInteractionLearning"]);
    const cl = section(c.captainsLog, defaults.captainsLog, "steward.captainsLog");
    const o = section(c.outcomeLedger, defaults.outcomeLedger, "steward.outcomeLedger");
    const reasoning = efforts.find(e => e === c.reasoning);
    if (!reasoning)
        throw new Error("Invalid steward.reasoning");
    const deepThoughtReasoning = d.reasoning === undefined ? undefined : efforts.find(e => e === d.reasoning);
    if (d.reasoning !== undefined && !deepThoughtReasoning)
        throw new Error("Invalid steward.deepThought.reasoning");
    const searchRanking = searchRankings.find(mode => mode === d.searchRanking);
    if (!searchRanking)
        throw new Error("Invalid steward.deepThought.searchRanking");
    const peopleMode = peopleModes.find(mode => mode === p.mode);
    if (!peopleMode)
        throw new Error("Invalid steward.peopleShadow.mode");
    const minConfidence = confidences.find(level => level === p.minConfidence);
    if (!minConfidence)
        throw new Error("Invalid steward.peopleShadow.minConfidence");
    const apiKey = c.apiKey === undefined ? undefined : text(c.apiKey, "apiKey");
    if (apiKey && /\s/u.test(apiKey))
        throw new Error("steward.apiKey must not contain whitespace");
    return { enabled: enabled(c.enabled, "steward"), model: text(c.model, "model"), reasoning, endpoint: endpoint(c.endpoint),
        ...(apiKey ? { apiKey } : {}), ...(c.apiKeyFile === undefined ? {} : { apiKeyFile: absolutePath(c.apiKeyFile) }),
        maxActiveBackground: integer(c.maxActiveBackground, 1, "maxActiveBackground"),
        deepThought: {
            enabled: enabled(d.enabled, "steward.deepThought"),
            maxTurns: integer(d.maxTurns, 0, "deepThought.maxTurns"),
            maxToolCalls: integer(d.maxToolCalls, 0, "deepThought.maxToolCalls"),
            maxConcurrent: integer(d.maxConcurrent, 0, "deepThought.maxConcurrent"),
            timeoutMs: integer(d.timeoutMs, 0, "deepThought.timeoutMs"),
            syncWaitMs: integer(d.syncWaitMs, 0, "deepThought.syncWaitMs"),
            jobRetentionMs: integer(d.jobRetentionMs, 0, "deepThought.jobRetentionMs"),
            wrapUpReserveMs: integer(d.wrapUpReserveMs, 0, "deepThought.wrapUpReserveMs"),
            maxToolResultChars: integer(d.maxToolResultChars, 0, "deepThought.maxToolResultChars"),
            maxInputTokens: integer(d.maxInputTokens, 0, "deepThought.maxInputTokens"),
            searchRanking,
            searchMinUsefulness: unitInterval(d.searchMinUsefulness, "deepThought.searchMinUsefulness"),
            defaultSearchResults: integer(d.defaultSearchResults, 1, "deepThought.defaultSearchResults"),
            maxSnippetChars: integer(d.maxSnippetChars, 0, "deepThought.maxSnippetChars"),
            maxQuoteChars: integer(d.maxQuoteChars, 0, "deepThought.maxQuoteChars"),
            maxPeopleMatches: integer(d.maxPeopleMatches, 0, "deepThought.maxPeopleMatches"),
            ...(deepThoughtReasoning ? { reasoning: deepThoughtReasoning } : {}),
        },
        peopleShadow: {
            enabled: enabled(p.enabled, "steward.peopleShadow"),
            mode: peopleMode,
            intervalMinutes: integer(p.intervalMinutes, 1, "peopleShadow.intervalMinutes"),
            maxItemsPerRun: integer(p.maxItemsPerRun, 0, "peopleShadow.maxItemsPerRun"),
            timeoutMs: integer(p.timeoutMs, 0, "peopleShadow.timeoutMs"),
            minConfidence,
            maxHandles: integer(p.maxHandles, 0, "peopleShadow.maxHandles"),
            maxExcerptChars: integer(p.maxExcerptChars, 0, "peopleShadow.maxExcerptChars"),
            maxExportBytes: integer(p.maxExportBytes, 0, "peopleShadow.maxExportBytes"),
            ...(p.includeInteractionLearning === undefined ? {}
                : { includeInteractionLearning: boolean(p.includeInteractionLearning, "steward.peopleShadow.includeInteractionLearning") }),
            maxNewClaimsPerPerson: integer(p.maxNewClaimsPerPerson, 0, "peopleShadow.maxNewClaimsPerPerson"),
            maxInteractionHandles: integer(p.maxInteractionHandles, 0, "peopleShadow.maxInteractionHandles"),
            includeResponseAudit: boolean(p.includeResponseAudit, "steward.peopleShadow.includeResponseAudit"),
        },
        captainsLog: {
            enabled: enabled(cl.enabled, "steward.captainsLog"),
            intervalMinutes: integer(cl.intervalMinutes, 1, "captainsLog.intervalMinutes"),
            lookbackMinutes: integer(cl.lookbackMinutes, 1, "captainsLog.lookbackMinutes"),
            maxSessionsPerRun: integer(cl.maxSessionsPerRun, 0, "captainsLog.maxSessionsPerRun"),
            maxCharsPerSession: integer(cl.maxCharsPerSession, 0, "captainsLog.maxCharsPerSession"),
            maxExistingLogChars: integer(cl.maxExistingLogChars, 0, "captainsLog.maxExistingLogChars"),
            timeoutMs: integer(cl.timeoutMs, 0, "captainsLog.timeoutMs"),
            excludeChatTypes: chatTypeList(cl.excludeChatTypes, "captainsLog.excludeChatTypes"),
        },
        outcomeLedger: {
            enabled: enabled(o.enabled, "steward.outcomeLedger"),
            intervalMinutes: integer(o.intervalMinutes, 1, "outcomeLedger.intervalMinutes"),
            lookbackMs: integer(o.lookbackMs, 1, "outcomeLedger.lookbackMs"),
            maxRowsPerPass: integer(o.maxRowsPerPass, 0, "outcomeLedger.maxRowsPerPass"),
            matchWindowMs: integer(o.matchWindowMs, 1, "outcomeLedger.matchWindowMs"),
            retentionDays: integer(o.retentionDays, 0, "outcomeLedger.retentionDays"),
        },
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
