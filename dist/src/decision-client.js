import { abortedByTimeout, createDecisionClient, DEFAULT_DECISIONS_ENDPOINT, DecisionError, decisionModelScope as sdkDecisionModelScope, matchesDecisionModel, resolveDecisionApiKey, resolveDecisionConfig, validateDecisionEndpoint, } from "@unblocklabs/decisions";
import { Type } from "typebox";
import { DEFAULTS } from "./defaults.js";
export { matchesDecisionModel, DecisionError as DecisionRequestError, };
export const NOUL_SCHEMA = Type.Object({
    type: Type.Literal("noul"), noul: Type.Number({ minimum: 0, maximum: 1 }),
});
export const NOUL_ANSWERS_SCHEMA = Type.Object({ answers: Type.Record(Type.String(), NOUL_SCHEMA) });
export const DEFAULT_DECISION_MODEL = DEFAULTS.decisionModel.model;
export function decisionModelScope(model = DEFAULT_DECISION_MODEL, endpoint = DEFAULTS.decisionModel.endpoint) {
    return sdkDecisionModelScope(model, endpoint);
}
const CODEX_ORIGIN = new URL(DEFAULT_DECISIONS_ENDPOINT).origin;
/** A conservative estimate of serialized size, not a model-specific tokenizer. Non-ASCII is budgeted separately. */
export function estimateDecisionTokens(value) {
    let n = 0;
    for (const c of JSON.stringify(value))
        n += c.codePointAt(0) < 128 ? 1 / 3 : 2;
    return Math.ceil(n);
}
/** A decision-model deadline: the request's own timeout, or the caller's timed-out signal. */
export function isDecisionTimeout(error, signal) {
    return (error instanceof DecisionError && error.code === "timeout") || abortedByTimeout(signal);
}
/** Explicit credentials take precedence; a missing explicit file never selects another key. */
export async function resolveDecisionCredential(config) {
    if (!config.enabled)
        return undefined;
    if (config.apiKey !== undefined) {
        const trimmed = config.apiKey.trim();
        if (!trimmed)
            return undefined;
        if (/\s/u.test(trimmed)) {
            throw new DecisionError("Decision model apiKey must not contain whitespace", "invalid_credential");
        }
        return trimmed;
    }
    const endpoint = validateDecisionEndpoint(config.endpoint ?? DEFAULTS.decisionModel.endpoint);
    const codex = new URL(endpoint).origin === CODEX_ORIGIN;
    return resolveDecisionApiKey(resolveDecisionConfig({
        endpoint,
        model: DEFAULT_DECISION_MODEL,
        apiKeyFile: config.apiKeyFile,
        ambientEnvKeys: codex ? ["CODEX_LB_API_KEY"] : [],
        fileEnvKeys: codex ? ["CODEX_LB_API_KEY"] : ["CODEX_LB_API_KEY", "DECISION_MODEL_API_KEY"],
    }));
}
function requestClient(params, timeoutMs) {
    return createDecisionClient({
        endpoint: params.endpoint ?? DEFAULTS.decisionModel.endpoint,
        model: params.model ?? DEFAULT_DECISION_MODEL,
        apiKey: params.apiKey,
        ambientEnvKeys: [],
        fileEnvKeys: [],
        timeoutMs,
    });
}
/** Typed extraction call backed directly by @unblocklabs/decisions. */
export async function extractWithModel(params, state, fields, options) {
    const timeoutMs = params.timeoutMs ?? DEFAULTS.decisionModel.unboundedTimeoutMs;
    return requestClient(params, timeoutMs).extract(state, fields, {
        timeoutMs,
        signal: params.signal,
        validateModel: options?.validateModel ?? true,
    });
}
/** Typed decision call backed directly by @unblocklabs/decisions. */
export async function decideWithModel(params, state, questions, options) {
    const timeoutMs = params.timeoutMs ?? DEFAULTS.decisionModel.unboundedTimeoutMs;
    return requestClient(params, timeoutMs).decide(state, questions, {
        timeoutMs,
        signal: params.signal,
        validateModel: options?.validateModel ?? true,
        allowExtraAnswerKeys: options?.allowExtraAnswerKeys ?? false,
    });
}
/**
 * Low-level raw JSON decision request backed by @unblocklabs/decisions `decideRaw()`,
 * for callers that intentionally tolerate partial multi-question responses (e.g. Safety Whisperer).
 */
export async function requestDecision(params, state, questions) {
    const timeoutMs = params.timeoutMs ?? DEFAULTS.decisionModel.unboundedTimeoutMs;
    return requestClient(params, timeoutMs).decideRaw(state, questions, {
        timeoutMs,
        signal: params.signal,
    });
}
