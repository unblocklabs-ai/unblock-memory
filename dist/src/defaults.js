import { readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
const here = new URL(import.meta.url);
// Use the package-root copy even when tsc emits a type-import copy under dist/.
const bundledPath = new URL(basename(fileURLToPath(new URL("../", here))) === "dist"
    ? "../../defaults.json" : "../defaults.json", here);
const probabilities = new Set([
    "minProposalConfidence", "minSupport", "minRetention", "minReplacement",
    "defaultMinUsefulness", "minDecisionUsefulness", "defaultMinScore", "nudgeMaxProbability",
    "defaultMinProbability", "minClaimSupport", "minRedundancy", "minClusterConfidence",
    "defaultMinNoise", "triageNoiseThreshold", "triageEvidenceHigh", "triageEvidenceLow",
    "primerUncertainFloor", "scoreHigh", "scoreLow", "gateMinScore", "corpusMinScore",
]);
const deprecatedKeys = {
    extraction: {
        replacementBatchMaxChars: "replacementBatchMaxPayloadBytes",
        validatorBatchMaxChars: "validatorBatchMaxStateBytes",
    },
    review: { maxRedundancyChars: "maxRedundancyStateBytes" },
    quality: { judgeBatchMaxChars: "judgeBatchMaxStateBytes" },
    people: { primerBatchMaxChars: "primerBatchMaxStateBytes" },
};
/** Removed sections still accepted (and ignored) so older override files keep loading. */
const retiredKeys = {
    "": ["training"],
};
const ranges = {
    "decisionModel.timeoutMs": [1, 10_000],
    "decisionModel.unboundedTimeoutMs": [1, 60_000],
    "extraction.proposalTimeoutMs": [1, 60_000],
    "extraction.validationTimeoutMs": [1, 60_000],
    "extraction.intervalMinutes": [0, 1440],
    "extraction.historyMessages": [0, 20],
    "extraction.maxBatches": [1, 50],
    "extraction.inputLimitTokens": [1, 32_000],
    "extraction.replacementOptionsPerChoice": [1, 20],
    "extraction.replacementBatchSize": [1, 5],
    "extraction.replacementBatchMaxPayloadBytes": [1, 60_000],
    "extraction.validatorBatchSize": [1, 4],
    "extraction.validatorBatchMaxStateBytes": [1, 240_000],
    "memoryWhisperer.defaultMaxHints": [1, 3],
    "memoryWhisperer.defaultCooldownTurns": [0, 1000],
    "memoryWhisperer.defaultTimeoutMs": [1, 10_000],
    // A cursor must be able to advance over one astral scalar without splitting it.
    "memoryWhisperer.memoryGetMaxChars": [2, Number.MAX_SAFE_INTEGER],
    "memoryWhisperer.maxTopics": [1, 3],
    "memoryWhisperer.gateTimeoutMs": [1, 10_000],
    "memoryWhisperer.extractTimeoutMs": [1, 10_000],
    "memoryWhisperer.planningTimeoutMs": [1, 10_000],
    "skillWhisperer.defaultHistoryMessages": [0, Number.MAX_SAFE_INTEGER],
    "skillWhisperer.defaultCooldownTurns": [0, Number.MAX_SAFE_INTEGER],
    "skillWhisperer.maxDirectCatalogSkills": [1, 1000],
    "skillWhisperer.catalogBatchSize": [1, 80],
    "skillWhisperer.maxMatchesPerTurn": [1, 100],
    "skillWhisperer.maxActiveSkillsPerSession": [1, 100],
    "skillWhisperer.maxInjectedChars": [1, 32_000],
    "skillWhisperer.maxDescriptionChars": [1, 12_000],
    "skillWhisperer.sessionRetentionDays": [1, 3650],
    "myTurn.defaultHistoryMessages": [1, 50],
    "safetyWhisperer.defaultHistoryMessages": [0, 20],
    "safetyWhisperer.defaultTimeoutMs": [1, 10_000],
    "review.maxRedundancyPairs": [1, 6],
    "review.maxRedundancyStateBytes": [1, 24_000],
    "quality.judgeBatchSize": [1, 6],
    "quality.judgeBatchMaxStateBytes": [1, 18_000],
    "people.defaultWhispererMaxChars": [1, 4000],
    "people.defaultTodosMaxOpen": [1, 10_000],
    "people.primerBatchSize": [1, 4],
    "people.primerBatchMaxStateBytes": [1, 16_000],
    "people.primerRequestTimeoutMs": [1, 60_000],
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
    if (path === "memoryWhisperer.mode")
        return value === "v2" || value === "legacy";
    if (path === "decisionModel.endpoint")
        return validUrl(value, "loopback");
    if (path === "people.slackApiUrl")
        return validUrl(value, "none");
    return value.trim() === value && value.length > 0 && !/\s/u.test(value);
}
function merge(base, patch, parent = "") {
    if (!record(patch))
        throw new Error(`Invalid operational default ${parent || "(root)"}: expected an object`);
    const normalized = { ...patch };
    for (const key of retiredKeys[parent] ?? [])
        delete normalized[key];
    for (const [oldKey, newKey] of Object.entries(deprecatedKeys[parent] ?? {})) {
        if (!Object.hasOwn(normalized, oldKey))
            continue;
        if (Object.hasOwn(normalized, newKey) && normalized[newKey] !== normalized[oldKey]) {
            throw new Error(`Conflicting operational defaults ${parent}.${oldKey} and ${parent}.${newKey}`);
        }
        normalized[newKey] = normalized[oldKey];
        delete normalized[oldKey];
    }
    for (const key of Object.keys(normalized)) {
        if (!Object.hasOwn(base, key))
            throw new Error(`Unknown operational default ${parent ? `${parent}.` : ""}${key}`);
    }
    return Object.freeze(Object.fromEntries(Object.entries(base).map(([key, fallback]) => {
        const path = parent ? `${parent}.${key}` : key;
        const value = Object.hasOwn(normalized, key) ? normalized[key] : fallback;
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
    const { extraction, quality, responseAudit } = result;
    if (extraction.inputTargetTokens > extraction.inputLimitTokens ||
        extraction.historyTokenBudget + extraction.promptReserveTokens >= extraction.inputTargetTokens) {
        throw new Error("Invalid operational defaults: extraction history, reserve, target and limit token budgets conflict");
    }
    if (extraction.heartbeatMs >= extraction.leaseMs) {
        throw new Error("Invalid operational defaults: extraction heartbeat must be shorter than its lease");
    }
    if (quality.triageEvidenceLow > quality.triageEvidenceHigh || responseAudit.scoreLow > responseAudit.scoreHigh) {
        throw new Error("Invalid operational defaults: low score threshold exceeds high score threshold");
    }
    return result;
}
export const DEFAULTS = loadOperationalDefaults();
