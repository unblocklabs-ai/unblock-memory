import { isAbsolute } from "node:path";
import { resolveResponseAudit } from "./response-config.js";
import { resolvePeoplePrimer } from "./people-primer-config.js";
const DEFAULT_PATHS = ["MEMORY.md", "USER.md", "memory/**/*.md"];
const DEFAULT_SESSION_MAX_EXPANDED_TOKENS = 500;
const MAX_SESSION_MAX_EXPANDED_TOKENS = 10_000;
const CHAT_TYPES = ["channel", "group", "direct"];
export const DEFAULT_CORPORA = [
    {
        name: "memory",
        kind: "files",
        paths: DEFAULT_PATHS,
    },
];
export const DEFAULT_PEOPLE_CONFIG = {
    enabled: false,
    whisperer: { enabled: false, maxChars: 1200 },
    todos: { maxOpen: 1000 },
};
const DEFAULT_TYPESAFE_CONFIG = {
    enabled: true,
    timeoutMs: 1500,
};
const DEFAULT_QUALITY_AUDIT = {
    enabled: false, corpora: [], minNoise: 0.8,
};
function resolveQualityAudit(value, corpora) {
    if (value === undefined)
        return { ...DEFAULT_QUALITY_AUDIT };
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("qualityAudit must be an object");
    const config = value;
    assertOnlyKeys(config, ["enabled", "corpora", "minNoise"], "qualityAudit");
    const enabled = config.enabled ?? false;
    const selected = config.corpora ?? [];
    const minNoise = config.minNoise ?? DEFAULT_QUALITY_AUDIT.minNoise;
    if (typeof enabled !== "boolean")
        throw new Error("qualityAudit.enabled must be a boolean");
    if (!Array.isArray(selected) || !selected.every((name) => typeof name === "string" && corpora.some(corpus => corpus.name === name && corpus.kind !== "skills"))) {
        throw new Error("qualityAudit.corpora must list configured non-skill corpora");
    }
    if (enabled && !selected.length)
        throw new Error("enabled qualityAudit requires explicit corpora");
    if (typeof minNoise !== "number" || !Number.isFinite(minNoise) || minNoise < 0 || minNoise > 1) {
        throw new Error("qualityAudit.minNoise must be between 0 and 1");
    }
    return { enabled, corpora: [...new Set(selected)], minNoise };
}
function resolveTypeSafe(value) {
    if (value === undefined)
        return { ...DEFAULT_TYPESAFE_CONFIG };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("unblock-memory typesafe must be an object");
    }
    const config = value;
    assertOnlyKeys(config, ["enabled", "apiKey", "apiKeyFile", "timeoutMs"], "typesafe");
    const enabled = config.enabled ?? true;
    if (typeof enabled !== "boolean")
        throw new Error("unblock-memory typesafe.enabled must be a boolean");
    for (const key of ["apiKey", "apiKeyFile"]) {
        if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key].trim())) {
            throw new Error(`unblock-memory typesafe.${key} must be a non-empty string`);
        }
    }
    const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : undefined;
    const apiKeyFile = typeof config.apiKeyFile === "string" ? config.apiKeyFile.trim() : undefined;
    if (apiKey && apiKeyFile)
        throw new Error("unblock-memory typesafe accepts apiKey or apiKeyFile, not both");
    if (apiKeyFile && !isAbsolute(apiKeyFile)) {
        throw new Error("unblock-memory typesafe.apiKeyFile must be an absolute path");
    }
    return {
        enabled, ...(apiKey ? { apiKey } : {}), ...(apiKeyFile ? { apiKeyFile } : {}),
        timeoutMs: positiveInteger(config.timeoutMs, DEFAULT_TYPESAFE_CONFIG.timeoutMs, "typesafe.timeoutMs", 10_000),
    };
}
const DEFAULT_SKILL_WHISPERER = {
    enabled: false,
    historyMessages: 5,
    minScore: 0.5,
    cooldownTurns: 10,
};
const DEFAULT_MEMORY_WHISPERER = {
    enabled: false, complementaryHints: false, corpora: [], historyMessages: 5, minUsefulness: 0.7,
    maxHints: 2, cooldownTurns: 10, timeoutMs: 3000,
};
function resolveMemoryWhisperer(value, corpora) {
    if (value === undefined)
        return { ...DEFAULT_MEMORY_WHISPERER };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("unblock-memory memoryWhisperer must be an object");
    }
    const config = value;
    assertOnlyKeys(config, [...Object.keys(DEFAULT_MEMORY_WHISPERER), "mlx"], "memoryWhisperer");
    let mlx;
    if (config.mlx !== undefined) {
        if (!config.mlx || typeof config.mlx !== "object" || Array.isArray(config.mlx))
            throw new Error("memoryWhisperer.mlx must be an object");
        const value = config.mlx;
        assertOnlyKeys(value, ["pythonPath", "modelPath"], "memoryWhisperer.mlx");
        if (typeof value.pythonPath !== "string" || !isAbsolute(value.pythonPath) ||
            typeof value.modelPath !== "string" || !isAbsolute(value.modelPath)) {
            throw new Error("memoryWhisperer.mlx requires absolute pythonPath and modelPath");
        }
        mlx = { pythonPath: value.pythonPath, modelPath: value.modelPath };
    }
    const enabled = config.enabled ?? false;
    if (typeof enabled !== "boolean")
        throw new Error("unblock-memory memoryWhisperer.enabled must be a boolean");
    const complementaryHints = config.complementaryHints ?? false;
    if (typeof complementaryHints !== "boolean")
        throw new Error("memoryWhisperer.complementaryHints must be a boolean");
    const selected = config.corpora ?? [];
    if (!Array.isArray(selected) || !selected.every((name) => typeof name === "string" && corpora.some(corpus => corpus.name === name && corpus.kind !== "skills"))) {
        throw new Error("unblock-memory memoryWhisperer.corpora must list configured non-skill corpora");
    }
    if (enabled && !selected.length)
        throw new Error("unblock-memory enabled memoryWhisperer requires explicit corpora");
    const historyMessages = config.historyMessages ?? 5;
    const cooldownTurns = config.cooldownTurns ?? 10;
    if (typeof historyMessages !== "number" || !Number.isInteger(historyMessages) || historyMessages < 0 || historyMessages > 50) {
        throw new Error("unblock-memory memoryWhisperer.historyMessages must be an integer between 0 and 50");
    }
    if (typeof cooldownTurns !== "number" || !Number.isInteger(cooldownTurns) || cooldownTurns < 0 || cooldownTurns > 1000) {
        throw new Error("unblock-memory memoryWhisperer.cooldownTurns must be an integer between 0 and 1000");
    }
    const minUsefulness = config.minUsefulness ?? DEFAULT_MEMORY_WHISPERER.minUsefulness;
    if (typeof minUsefulness !== "number" || !Number.isFinite(minUsefulness) || minUsefulness < 0 || minUsefulness > 1) {
        throw new Error("unblock-memory memoryWhisperer.minUsefulness must be between 0 and 1");
    }
    return {
        enabled, complementaryHints, corpora: [...new Set(selected)], historyMessages, cooldownTurns, minUsefulness,
        maxHints: positiveInteger(config.maxHints, 2, "memoryWhisperer.maxHints", 2),
        timeoutMs: positiveInteger(config.timeoutMs, 3000, "memoryWhisperer.timeoutMs", 10_000),
        ...(mlx ? { mlx } : {}),
    };
}
function assertOnlyKeys(value, allowed, label) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown)
        throw new Error(`unblock-memory ${label} has unknown property: ${unknown}`);
}
function resolveCorpora(value) {
    if (value === undefined)
        return DEFAULT_CORPORA;
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error("unblock-memory corpora must be a non-empty array");
    }
    const names = new Set();
    const corpora = value.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`unblock-memory corpora[${index}] must be an object`);
        }
        const corpus = entry;
        if (typeof corpus.name !== "string" || !corpus.name.trim()) {
            throw new Error(`unblock-memory corpora[${index}].name must be a non-empty string`);
        }
        const name = corpus.name.trim();
        if (name === "all") {
            throw new Error(`unblock-memory corpus name is reserved: ${name}`);
        }
        if (names.has(name))
            throw new Error(`unblock-memory corpus names must be unique: ${name}`);
        names.add(name);
        if (corpus.kind === "skills") {
            assertOnlyKeys(corpus, ["name", "kind", "paths"], `corpora[${index}]`);
            if (name !== "skills") {
                throw new Error('unblock-memory skills corpus must be named "skills"');
            }
            if (!Array.isArray(corpus.paths) ||
                corpus.paths.length === 0 ||
                !corpus.paths.every((path) => typeof path === "string" && path.trim())) {
                throw new Error("unblock-memory corpus skills paths must be a non-empty array of non-empty strings");
            }
            return { name: "skills", kind: "skills", paths: corpus.paths.map((path) => path.trim()) };
        }
        if (corpus.kind === "sessions") {
            assertOnlyKeys(corpus, ["name", "kind", "chatTypes", "maxExpandedTokens", "syncIntervalMinutes"], `corpora[${index}]`);
            if (name !== "sessions") {
                throw new Error('unblock-memory session corpus must be named "sessions"');
            }
            const chatTypes = corpus.chatTypes ?? ["channel", "group"];
            if (!Array.isArray(chatTypes) ||
                chatTypes.length === 0 ||
                !chatTypes.every((chatType) => CHAT_TYPES.includes(chatType))) {
                throw new Error(`unblock-memory corpus sessions chatTypes must contain channel, group, or direct`);
            }
            const syncIntervalMinutes = corpus.syncIntervalMinutes ?? 60;
            if (typeof syncIntervalMinutes !== "number" || !Number.isInteger(syncIntervalMinutes) ||
                syncIntervalMinutes < 0 || syncIntervalMinutes > 1440) {
                throw new Error("unblock-memory corpus sessions syncIntervalMinutes must be an integer between 0 and 1440");
            }
            return {
                name: "sessions",
                syncIntervalMinutes,
                kind: "sessions",
                chatTypes: [...new Set(chatTypes)],
                maxExpandedTokens: positiveInteger(corpus.maxExpandedTokens, DEFAULT_SESSION_MAX_EXPANDED_TOKENS, "corpus sessions maxExpandedTokens", MAX_SESSION_MAX_EXPANDED_TOKENS),
            };
        }
        assertOnlyKeys(corpus, ["name", "kind", "paths"], `corpora[${index}]`);
        if (name === "sessions") {
            throw new Error('unblock-memory corpus named "sessions" must have kind "sessions"');
        }
        if (name === "skills") {
            throw new Error('unblock-memory corpus named "skills" must have kind "skills"');
        }
        if (corpus.kind !== "files") {
            throw new Error(`unblock-memory corpus ${name} must have kind "files", "skills", or "sessions"`);
        }
        if (!Array.isArray(corpus.paths) ||
            corpus.paths.length === 0 ||
            !corpus.paths.every((path) => typeof path === "string" && path.trim())) {
            throw new Error(`unblock-memory corpus ${name} paths must be a non-empty array of non-empty strings`);
        }
        return { name, kind: "files", paths: corpus.paths.map((path) => path.trim()) };
    });
    if (corpora.filter((corpus) => corpus.name === "memory").length !== 1) {
        throw new Error('unblock-memory corpora must contain exactly one corpus named "memory"');
    }
    return corpora;
}
function positiveInteger(value, fallback, label, maximum) {
    const resolved = value ?? fallback;
    if (typeof resolved !== "number" ||
        !Number.isInteger(resolved) ||
        resolved < 1 ||
        resolved > maximum) {
        throw new Error(`unblock-memory ${label} must be a positive integer no greater than ${maximum}`);
    }
    return resolved;
}
function resolvePeople(value) {
    if (value === undefined)
        return DEFAULT_PEOPLE_CONFIG;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("unblock-memory people must be an object");
    }
    const people = value;
    assertOnlyKeys(people, ["enabled", "whisperer", "todos"], "people");
    const enabled = people.enabled ?? false;
    if (typeof enabled !== "boolean")
        throw new Error("unblock-memory people.enabled must be a boolean");
    const whisperer = people.whisperer ?? {};
    if (!whisperer || typeof whisperer !== "object" || Array.isArray(whisperer)) {
        throw new Error("unblock-memory people.whisperer must be an object");
    }
    const whispererRecord = whisperer;
    assertOnlyKeys(whispererRecord, ["enabled", "maxChars"], "people.whisperer");
    const whispererEnabled = whispererRecord.enabled ?? false;
    if (typeof whispererEnabled !== "boolean") {
        throw new Error("unblock-memory people.whisperer.enabled must be a boolean");
    }
    const todos = people.todos ?? {};
    if (!todos || typeof todos !== "object" || Array.isArray(todos)) {
        throw new Error("unblock-memory people.todos must be an object");
    }
    const todosRecord = todos;
    assertOnlyKeys(todosRecord, ["maxOpen"], "people.todos");
    return {
        enabled,
        whisperer: {
            enabled: whispererEnabled,
            maxChars: positiveInteger(whispererRecord.maxChars, DEFAULT_PEOPLE_CONFIG.whisperer.maxChars, "people.whisperer.maxChars", 4000),
        },
        todos: {
            maxOpen: positiveInteger(todosRecord.maxOpen, DEFAULT_PEOPLE_CONFIG.todos.maxOpen, "people.todos.maxOpen", 10_000),
        },
    };
}
export function resolveConfig(value) {
    if (value === undefined || value === null) {
        return {
            corpora: DEFAULT_CORPORA,
            keepEmbeddingModelWarm: true,
            analysis: {},
            typesafe: { ...DEFAULT_TYPESAFE_CONFIG },
            qualityAudit: { ...DEFAULT_QUALITY_AUDIT },
            evidenceReview: { enabled: false, corpora: [] },
            responseAudit: resolveResponseAudit(undefined, DEFAULT_CORPORA),
            peoplePrimer: resolvePeoplePrimer(undefined, DEFAULT_CORPORA, false),
            people: DEFAULT_PEOPLE_CONFIG,
            skillWhisperer: DEFAULT_SKILL_WHISPERER,
            memoryWhisperer: { ...DEFAULT_MEMORY_WHISPERER },
        };
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error("unblock-memory config must be an object");
    }
    const config = value;
    assertOnlyKeys(config, ["corpora", "keepEmbeddingModelWarm", "analysis", "people", "peoplePrimer", "skillWhisperer", "memoryWhisperer", "typesafe", "qualityAudit", "evidenceReview", "responseAudit"], "config");
    const corpora = resolveCorpora(config.corpora);
    const people = resolvePeople(config.people);
    const peoplePrimer = resolvePeoplePrimer(config.peoplePrimer, corpora, people.enabled);
    let evidenceReview = { enabled: false, corpora: [] };
    if (config.evidenceReview !== undefined) {
        const value = config.evidenceReview;
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("evidenceReview must be an object");
        assertOnlyKeys(value, ["enabled", "corpora"], "evidenceReview");
        try {
            const approved = resolveQualityAudit(value, corpora);
            evidenceReview = { enabled: approved.enabled, corpora: approved.corpora };
        }
        catch {
            throw new Error("evidenceReview requires a boolean enabled and explicit configured non-skill corpora when enabled");
        }
    }
    if (config.keepEmbeddingModelWarm !== undefined &&
        typeof config.keepEmbeddingModelWarm !== "boolean") {
        throw new Error("unblock-memory keepEmbeddingModelWarm must be a boolean");
    }
    const keepEmbeddingModelWarm = config.keepEmbeddingModelWarm ?? true;
    let analysisConfig = {};
    if (config.analysis !== undefined) {
        if (!config.analysis || typeof config.analysis !== "object" || Array.isArray(config.analysis)) {
            throw new Error("unblock-memory analysis must be an object");
        }
        const analysis = config.analysis;
        assertOnlyKeys(analysis, ["executable"], "analysis");
        const configured = analysis.executable;
        if (configured !== undefined) {
            if (typeof configured !== "string" || !configured.trim() || !isAbsolute(configured.trim())) {
                throw new Error("unblock-memory analysis.executable must be an absolute non-empty path");
            }
            analysisConfig = { executable: configured.trim() };
        }
    }
    let skillWhisperer = DEFAULT_SKILL_WHISPERER;
    if (config.skillWhisperer !== undefined) {
        if (!config.skillWhisperer ||
            typeof config.skillWhisperer !== "object" ||
            Array.isArray(config.skillWhisperer)) {
            throw new Error("unblock-memory skillWhisperer must be an object");
        }
        const value = config.skillWhisperer;
        assertOnlyKeys(value, ["enabled", "historyMessages", "minScore", "cooldownTurns"], "skillWhisperer");
        const enabled = value.enabled ?? false;
        const historyMessages = value.historyMessages ?? 5;
        const minScore = value.minScore ?? 0.5;
        const cooldownTurns = value.cooldownTurns ?? 10;
        if (typeof enabled !== "boolean")
            throw new Error("unblock-memory skillWhisperer.enabled must be a boolean");
        if (typeof historyMessages !== "number" ||
            !Number.isInteger(historyMessages) ||
            historyMessages < 0) {
            throw new Error("unblock-memory skillWhisperer.historyMessages must be a non-negative integer");
        }
        if (typeof minScore !== "number" ||
            !Number.isFinite(minScore) ||
            minScore < 0 ||
            minScore > 1) {
            throw new Error("unblock-memory skillWhisperer.minScore must be between 0 and 1");
        }
        if (typeof cooldownTurns !== "number" ||
            !Number.isInteger(cooldownTurns) ||
            cooldownTurns < 0) {
            throw new Error("unblock-memory skillWhisperer.cooldownTurns must be a non-negative integer");
        }
        skillWhisperer = { enabled, historyMessages, minScore, cooldownTurns };
    }
    if (skillWhisperer.enabled && !corpora.some((corpus) => corpus.kind === "skills")) {
        throw new Error('unblock-memory enabled skillWhisperer requires a corpus named "skills" with kind "skills"');
    }
    return { corpora, keepEmbeddingModelWarm, analysis: analysisConfig, people, peoplePrimer, skillWhisperer,
        qualityAudit: resolveQualityAudit(config.qualityAudit, corpora),
        evidenceReview,
        responseAudit: resolveResponseAudit(config.responseAudit, corpora),
        memoryWhisperer: resolveMemoryWhisperer(config.memoryWhisperer, corpora), typesafe: resolveTypeSafe(config.typesafe) };
}
