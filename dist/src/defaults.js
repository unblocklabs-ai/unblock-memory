import { readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
const here = new URL(import.meta.url);
// Use the package-root copy even when tsc emits a type-import copy under dist/.
const bundledPath = new URL(basename(fileURLToPath(new URL("../", here))) === "dist"
    ? "../../defaults.json" : "../defaults.json", here);
const reasoningLevels = ["none", "minimal", "low", "medium", "high", "xhigh"];
const probabilities = new Set([
    "minProposalConfidence", "minSupport", "minRetention", "minReplacement", "gateThreshold",
    "defaultMinUsefulness", "minDecisionUsefulness", "defaultMinScore", "nudgeMaxProbability",
    "defaultMinProbability", "minClaimSupport", "minRedundancy", "minClusterConfidence",
    "defaultMinNoise", "triageNoiseThreshold", "triageEvidenceHigh", "triageEvidenceLow",
    "primerUncertainFloor", "scoreHigh", "scoreLow",
]);
const ranges = {
    "decisionModel.timeoutMs": [1, 10_000],
    "decisionModel.unboundedTimeoutMs": [1, 60_000],
    "extraction.proposalTimeoutMs": [1, 60_000],
    "extraction.validationTimeoutMs": [1, 60_000],
    "extraction.intervalMinutes": [0, 1440],
    "extraction.historyMessages": [0, 20],
    "extraction.maxBatches": [1, 50],
    "extraction.inputLimitTokens": [1, 32_000],
    "training.decisionTimeoutMs": [1, 60_000],
    "memoryWhisperer.defaultMaxHints": [1, 3],
    "memoryWhisperer.defaultCooldownTurns": [0, 1000],
    "memoryWhisperer.defaultTimeoutMs": [1, 10_000],
    "skillWhisperer.defaultHistoryMessages": [0, Number.MAX_SAFE_INTEGER],
    "skillWhisperer.defaultCooldownTurns": [0, Number.MAX_SAFE_INTEGER],
    "myTurn.defaultHistoryMessages": [1, 50],
    "safetyWhisperer.defaultHistoryMessages": [0, 20],
    "safetyWhisperer.defaultTimeoutMs": [1, 10_000],
    "people.defaultWhispererMaxChars": [1, 4000],
    "people.defaultTodosMaxOpen": [1, 10_000],
    "responseAudit.defaultHistoryMessages": [0, 20],
    "responseAudit.defaultLookbackDays": [1, 90],
    "responseAudit.defaultMaxEpisodes": [1, 100],
    "responseAudit.defaultIntervalMinutes": [0, 1440],
    "insideOut.defaultIntervalMinutes": [0, 10080],
    "insideOut.defaultMaxInteractions": [1, 10000],
    "insideOut.defaultMaxContextTokens": [256, 30_000],
    "insideOut.defaultBaselineMinInteractions": [1, 10000],
    "recallLedger.defaultRetentionDays": [1, 3650],
    "recallLedger.maxQueueSize": [1, 10000],
    "recallLedger.shutdownTimeoutMs": [100, 10000],
};
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        throw new Error(`Cannot load operational defaults from ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function validUrl(value, http) {
    try {
        const url = new URL(value);
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        return !/[\s?#]/u.test(value) && (url.protocol === "https:" ||
            (url.protocol === "http:" && (http === "any" || (http === "loopback" && loopback)))) &&
            !url.username && !url.password && !url.hash && !url.search;
    }
    catch {
        return false;
    }
}
function validLeaf(base, value, path, key) {
    if (typeof base === "number" && typeof value === "number") {
        if (probabilities.has(key))
            return Number.isFinite(value) && value >= 0 && value <= 1;
        const [min, max] = ranges[path] ?? [1, key.endsWith("Ms") ? 2_147_483_647 : Number.MAX_SAFE_INTEGER];
        return Number.isSafeInteger(value) && value >= min && value <= max;
    }
    if (typeof base !== "string" || typeof value !== "string")
        return false;
    if (path === "memoryWhisperer.defaultApiEndpoint")
        return value === "" || validUrl(value, "any");
    if (path === "decisionModel.endpoint")
        return validUrl(value, "loopback");
    if (path === "people.slackApiUrl")
        return validUrl(value, "none");
    if (path === "training.teacherReasoning")
        return reasoningLevels.includes(value);
    if (path === "training.teacherModel")
        return /^[^/\s]+\/[^\s]+$/u.test(value);
    return value.trim() === value && value.length > 0 && !/\s/u.test(value);
}
function merge(base, patch, parent = "") {
    if (!record(patch))
        throw new Error(`Invalid operational default ${parent || "(root)"}: expected an object`);
    for (const key of Object.keys(patch)) {
        if (!Object.hasOwn(base, key))
            throw new Error(`Unknown operational default ${parent ? `${parent}.` : ""}${key}`);
    }
    return Object.freeze(Object.fromEntries(Object.entries(base).map(([key, fallback]) => {
        const path = parent ? `${parent}.${key}` : key;
        const value = Object.hasOwn(patch, key) ? patch[key] : fallback;
        if (record(fallback))
            return [key, merge(fallback, value, path)];
        if (!validLeaf(fallback, value, path, key))
            throw new Error(`Invalid operational default ${path}: wrong type or out of range`);
        return [key, value];
    })));
}
/** An explicit override path takes precedence over the process-wide environment setting. */
export function loadOperationalDefaults(overridePath = process.env.UNBLOCK_MEMORY_DEFAULTS_FILE) {
    if (overridePath !== undefined && !isAbsolute(overridePath)) {
        throw new Error("UNBLOCK_MEMORY_DEFAULTS_FILE / operational defaults path must be absolute");
    }
    const base = readJson(bundledPath);
    if (!record(base))
        throw new Error("Bundled defaults.json must be an object");
    const result = merge(base, overridePath === undefined ? {} : readJson(overridePath));
    const { extraction, training, quality, responseAudit } = result;
    if (extraction.inputTargetTokens > extraction.inputLimitTokens ||
        extraction.historyTokenBudget + extraction.promptReserveTokens >= extraction.inputTargetTokens) {
        throw new Error("Invalid operational defaults: extraction history, reserve, target and limit token budgets conflict");
    }
    if (extraction.heartbeatMs >= extraction.leaseMs || training.heartbeatMs >= training.leaseMs) {
        throw new Error("Invalid operational defaults: extraction and training heartbeats must be shorter than their leases");
    }
    if (quality.triageEvidenceLow > quality.triageEvidenceHigh || responseAudit.scoreLow > responseAudit.scoreHigh) {
        throw new Error("Invalid operational defaults: low score threshold exceeds high score threshold");
    }
    return result;
}
export const DEFAULTS = loadOperationalDefaults();
