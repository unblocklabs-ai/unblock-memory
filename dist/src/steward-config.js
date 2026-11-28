import { resolveDecisionCredential } from "./decision-client.js";
import { isAbsolute } from "node:path";
import { DEFAULT_EMOTIONAL_SALIENCE_OPTIONS } from "./emotional-salience.js";
import { isRecord } from "./guards.js";
import { CRYSTALS_DEFAULTS } from "./steward-crystals.js";
const efforts = ["off", "minimal", "low", "medium", "high", "xhigh"];
const searchRankings = ["retrieval", "decision"];
const peopleModes = ["publish", "shadow"];
const confidences = ["high", "medium", "low"];
const chatTypes = ["channel", "group", "direct"];
const expectationChatTypes = ["workspace", "channel", "group", "direct"];
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
        includeEmotionalSalience: true,
        minSalienceScore: DEFAULT_EMOTIONAL_SALIENCE_OPTIONS.minSalienceScore,
        minAbsoluteIntensity: DEFAULT_EMOTIONAL_SALIENCE_OPTIONS.minAbsoluteIntensity,
        minRelativeIntensity: DEFAULT_EMOTIONAL_SALIENCE_OPTIONS.minRelativeIntensity,
    },
    outcomeLedger: {
        enabled: true,
        intervalMinutes: 60,
        lookbackMs: 604_800_000,
        maxRowsPerPass: 0,
        matchWindowMs: 1_800_000,
        retentionDays: 0,
    },
    expectations: {
        enabled: true,
        intervalMinutes: 60,
        lookbackMinutes: 70,
        dueLeadMinutes: 60,
        sweepAfterMinutes: 1440,
        maxSessionsPerRun: 0,
        maxCharsPerSession: 0,
        maxSweepItems: 0,
        timeoutMs: 0,
        excludeChatTypes: ["direct"],
        workspaceSweepChatTypes: ["channel"],
        extract: true,
        sweep: true,
        blockerAutoExpireMinutes: 4320,
        captainsLogDecisionResolve: true,
        captainsLogResolveChatTypes: ["workspace", "channel"],
        captainsLogResolveMinConfidence: 0.85,
        captainsLogResolveTimeoutMs: 15_000,
    },
    crystals: { enabled: true, ...CRYSTALS_DEFAULTS, allowedCorpora: [...CRYSTALS_DEFAULTS.allowedCorpora] },
    overnight: {
        enabled: true,
        intervalMinutes: 720,
        voltaireEnabled: true,
        postmortemsEnabled: true,
        preAnswerEnabled: true,
        lookbackDays: 30,
        minRecurrence: 2,
        lookaheadMinutes: 720,
        maxVoltairePerRun: 5,
        maxPostmortemsPerRun: 5,
        maxPreAnswersPerRun: 3,
        minConfidence: "medium",
        recallChatTypes: ["channel", "group"],
        saveDerivedObservations: true,
        writeDailyLogNotes: true,
        dailyLogChatTypes: ["workspace", "channel"],
        dailyLogCorpora: ["memory", "knowledge"],
        timeoutMs: 0,
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
/** Inside Out intensity scale, 0 (none) to 3 (overwhelming). */
function intensity(value, key) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 3) {
        throw new Error(`steward.${key} must be a number between 0 and 3`);
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
function expectationChatTypeList(value, key) {
    if (!Array.isArray(value))
        throw new Error(`steward.${key} must be an array`);
    const out = [];
    for (const entry of value) {
        const matched = expectationChatTypes.find(t => t === entry);
        if (!matched)
            throw new Error(`Invalid steward.${key} entry`);
        if (!out.includes(matched))
            out.push(matched);
    }
    return out;
}
function corpusList(value, key) {
    if (!Array.isArray(value) || !value.every(entry => typeof entry === "string" && entry.trim())) {
        throw new Error(`steward.${key} must be an array of non-empty corpus names`);
    }
    return [...new Set(value.map(entry => entry.trim()))];
}
function hour(value, key) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 23) {
        throw new Error(`steward.${key} must be an integer between 0 and 23`);
    }
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
    const d = section(c.deepThought, defaults.deepThought, "steward.deepThought", ["reasoning"]);
    const p = section(c.peopleShadow, defaults.peopleShadow, "steward.peopleShadow", ["includeInteractionLearning"]);
    const cl = section(c.captainsLog, defaults.captainsLog, "steward.captainsLog");
    const o = section(c.outcomeLedger, defaults.outcomeLedger, "steward.outcomeLedger", ["lateEvidenceRescanMs"]);
    const e = section(c.expectations, defaults.expectations, "steward.expectations");
    const cr = section(c.crystals, defaults.crystals, "steward.crystals");
    const on = section(c.overnight, defaults.overnight, "steward.overnight", ["quietHoursStartHour", "quietHoursEndHour"]);
    if ((on.quietHoursStartHour === undefined) !== (on.quietHoursEndHour === undefined)) {
        throw new Error("steward.overnight.quietHoursStartHour and quietHoursEndHour must be set together");
    }
    const overnightConfidence = confidences.find(level => level === on.minConfidence);
    if (!overnightConfidence)
        throw new Error("Invalid steward.overnight.minConfidence");
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
            includeEmotionalSalience: boolean(cl.includeEmotionalSalience, "steward.captainsLog.includeEmotionalSalience"),
            minSalienceScore: unitInterval(cl.minSalienceScore, "captainsLog.minSalienceScore"),
            minAbsoluteIntensity: intensity(cl.minAbsoluteIntensity, "captainsLog.minAbsoluteIntensity"),
            minRelativeIntensity: intensity(cl.minRelativeIntensity, "captainsLog.minRelativeIntensity"),
        },
        outcomeLedger: {
            enabled: enabled(o.enabled, "steward.outcomeLedger"),
            intervalMinutes: integer(o.intervalMinutes, 1, "outcomeLedger.intervalMinutes"),
            lookbackMs: integer(o.lookbackMs, 1, "outcomeLedger.lookbackMs"),
            maxRowsPerPass: integer(o.maxRowsPerPass, 0, "outcomeLedger.maxRowsPerPass"),
            matchWindowMs: integer(o.matchWindowMs, 1, "outcomeLedger.matchWindowMs"),
            retentionDays: integer(o.retentionDays, 0, "outcomeLedger.retentionDays"),
            ...(o.lateEvidenceRescanMs === undefined ? {}
                : { lateEvidenceRescanMs: integer(o.lateEvidenceRescanMs, 0, "outcomeLedger.lateEvidenceRescanMs") }),
        },
        expectations: {
            enabled: enabled(e.enabled, "steward.expectations"),
            intervalMinutes: integer(e.intervalMinutes, 1, "expectations.intervalMinutes"),
            lookbackMinutes: integer(e.lookbackMinutes, 1, "expectations.lookbackMinutes"),
            dueLeadMinutes: integer(e.dueLeadMinutes, 0, "expectations.dueLeadMinutes"),
            sweepAfterMinutes: integer(e.sweepAfterMinutes, 0, "expectations.sweepAfterMinutes"),
            maxSessionsPerRun: integer(e.maxSessionsPerRun, 0, "expectations.maxSessionsPerRun"),
            maxCharsPerSession: integer(e.maxCharsPerSession, 0, "expectations.maxCharsPerSession"),
            maxSweepItems: integer(e.maxSweepItems, 0, "expectations.maxSweepItems"),
            timeoutMs: integer(e.timeoutMs, 0, "expectations.timeoutMs"),
            excludeChatTypes: chatTypeList(e.excludeChatTypes, "expectations.excludeChatTypes"),
            workspaceSweepChatTypes: chatTypeList(e.workspaceSweepChatTypes, "expectations.workspaceSweepChatTypes"),
            extract: boolean(e.extract, "steward.expectations.extract"),
            sweep: boolean(e.sweep, "steward.expectations.sweep"),
            blockerAutoExpireMinutes: integer(e.blockerAutoExpireMinutes, 0, "expectations.blockerAutoExpireMinutes"),
            captainsLogDecisionResolve: boolean(e.captainsLogDecisionResolve, "steward.expectations.captainsLogDecisionResolve"),
            captainsLogResolveChatTypes: expectationChatTypeList(e.captainsLogResolveChatTypes, "expectations.captainsLogResolveChatTypes"),
            captainsLogResolveMinConfidence: unitInterval(e.captainsLogResolveMinConfidence, "expectations.captainsLogResolveMinConfidence"),
            captainsLogResolveTimeoutMs: integer(e.captainsLogResolveTimeoutMs, 0, "expectations.captainsLogResolveTimeoutMs"),
        },
        crystals: {
            enabled: enabled(cr.enabled, "steward.crystals"),
            intervalMinutes: integer(cr.intervalMinutes, 1, "crystals.intervalMinutes"),
            reclusterMinIntervalMinutes: integer(cr.reclusterMinIntervalMinutes, 0, "crystals.reclusterMinIntervalMinutes"),
            autoRecluster: boolean(cr.autoRecluster, "steward.crystals.autoRecluster"),
            minClusterSize: integer(cr.minClusterSize, 1, "crystals.minClusterSize"),
            maxClustersPerRun: integer(cr.maxClustersPerRun, 0, "crystals.maxClustersPerRun"),
            maxMembersPerCluster: integer(cr.maxMembersPerCluster, 0, "crystals.maxMembersPerCluster"),
            stmStaleAfterMinutes: integer(cr.stmStaleAfterMinutes, 0, "crystals.stmStaleAfterMinutes"),
            ltmPromoteMinHelped: integer(cr.ltmPromoteMinHelped, 0, "crystals.ltmPromoteMinHelped"),
            ltmPromoteMinHits: integer(cr.ltmPromoteMinHits, 0, "crystals.ltmPromoteMinHits"),
            allowedCorpora: corpusList(cr.allowedCorpora, "crystals.allowedCorpora"),
            timeoutMs: integer(cr.timeoutMs, 0, "crystals.timeoutMs"),
            prioritizeEmotionalSalience: boolean(cr.prioritizeEmotionalSalience, "steward.crystals.prioritizeEmotionalSalience"),
        },
        overnight: {
            enabled: enabled(on.enabled, "steward.overnight"),
            intervalMinutes: integer(on.intervalMinutes, 1, "overnight.intervalMinutes"),
            ...(on.quietHoursStartHour === undefined ? {} : {
                quietHoursStartHour: hour(on.quietHoursStartHour, "overnight.quietHoursStartHour"),
                quietHoursEndHour: hour(on.quietHoursEndHour, "overnight.quietHoursEndHour"),
            }),
            voltaireEnabled: boolean(on.voltaireEnabled, "steward.overnight.voltaireEnabled"),
            postmortemsEnabled: boolean(on.postmortemsEnabled, "steward.overnight.postmortemsEnabled"),
            preAnswerEnabled: boolean(on.preAnswerEnabled, "steward.overnight.preAnswerEnabled"),
            lookbackDays: integer(on.lookbackDays, 0, "overnight.lookbackDays"),
            minRecurrence: integer(on.minRecurrence, 1, "overnight.minRecurrence"),
            lookaheadMinutes: integer(on.lookaheadMinutes, 0, "overnight.lookaheadMinutes"),
            maxVoltairePerRun: integer(on.maxVoltairePerRun, 0, "overnight.maxVoltairePerRun"),
            maxPostmortemsPerRun: integer(on.maxPostmortemsPerRun, 0, "overnight.maxPostmortemsPerRun"),
            maxPreAnswersPerRun: integer(on.maxPreAnswersPerRun, 0, "overnight.maxPreAnswersPerRun"),
            minConfidence: overnightConfidence,
            recallChatTypes: chatTypeList(on.recallChatTypes, "overnight.recallChatTypes"),
            saveDerivedObservations: boolean(on.saveDerivedObservations, "steward.overnight.saveDerivedObservations"),
            writeDailyLogNotes: boolean(on.writeDailyLogNotes, "steward.overnight.writeDailyLogNotes"),
            dailyLogChatTypes: expectationChatTypeList(on.dailyLogChatTypes, "overnight.dailyLogChatTypes"),
            dailyLogCorpora: corpusList(on.dailyLogCorpora, "overnight.dailyLogCorpora"),
            timeoutMs: integer(on.timeoutMs, 0, "overnight.timeoutMs"),
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
