import { abortedByTimeout, classifyDecisionFailure, createDecisionClient, DEFAULT_DECISIONS_MODEL, DecisionError, decisionModelScope, defaultDecisionModel, LEGACY_SYSTEMONE_ENDPOINT, matchesDecisionModel, resolveDecisionApiKey, resolveDecisionConfig, } from "@unblocklabs/decisions";
import { Type } from "typebox";
export { classifyDecisionFailure, decisionModelScope, defaultDecisionModel, LEGACY_SYSTEMONE_ENDPOINT, matchesDecisionModel, DEFAULT_DECISIONS_MODEL as TYPESAFE_MODEL, DecisionError as TypeSafeRequestError, };
export const TYPESAFE_NOUL_SCHEMA = Type.Object({
    type: Type.Literal("noul"), noul: Type.Number({ minimum: 0, maximum: 1 }),
});
export const TYPESAFE_NOUL_ANSWERS_SCHEMA = Type.Object({ answers: Type.Record(Type.String(), TYPESAFE_NOUL_SCHEMA) });
const DEFAULT_UNBOUNDED_TIMEOUT_MS = 60_000;
/** A conservative estimate of serialized size, not a model-specific tokenizer. Non-ASCII is budgeted separately. */
export function estimateJevTokens(value) {
    let n = 0;
    for (const c of JSON.stringify(value))
        n += c.codePointAt(0) < 128 ? 1 / 3 : 2;
    return Math.ceil(n);
}
/** A decision-model deadline: the request's own timeout, or the caller's timed-out signal. */
export function isTypeSafeTimeout(error, signal) {
    return (error instanceof DecisionError && error.code === "timeout") || abortedByTimeout(signal);
}
/** Explicit credentials take precedence; a missing explicit file never selects another key. */
export async function resolveTypeSafeApiKey(config) {
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
    let resolved;
    try {
        resolved = resolveDecisionConfig({
            endpoint: config.endpoint,
            apiKeyFile: config.apiKeyFile,
        });
    }
    catch (error) {
        if (error instanceof DecisionError && error.code === "invalid_config" && !config.apiKeyFile) {
            return undefined;
        }
        throw error;
    }
    return resolveDecisionApiKey(resolved);
}
/** Typed decision call backed directly by @unblocklabs/decisions. */
export async function decideWithModel(params, state, questions, options) {
    const timeoutMs = params.timeoutMs ?? DEFAULT_UNBOUNDED_TIMEOUT_MS;
    const client = createDecisionClient({
        endpoint: params.endpoint,
        model: params.model,
        apiKey: params.apiKey,
        timeoutMs,
    });
    return client.decide(state, questions, {
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
export async function requestTypeSafe(params, state, questions) {
    const timeoutMs = params.timeoutMs ?? DEFAULT_UNBOUNDED_TIMEOUT_MS;
    const client = createDecisionClient({
        endpoint: params.endpoint,
        model: params.model,
        apiKey: params.apiKey,
        timeoutMs,
    });
    return client.decideRaw(state, questions, {
        timeoutMs,
        signal: params.signal,
    });
}
