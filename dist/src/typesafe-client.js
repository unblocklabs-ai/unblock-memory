import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { Type } from "typebox";
import { abortedByTimeout } from "./abortable.js";
export const TYPESAFE_DEFAULT_ENDPOINT = "https://codex.unblocklabs.ai/v1/decisions";
const TYPESAFE_LEGACY_MODEL = "jev-1.13.0";
export const TYPESAFE_MODEL = "liquid/d1.2-ultra";
export const TYPESAFE_NOUL_SCHEMA = Type.Object({
    type: Type.Literal("noul"), noul: Type.Number({ minimum: 0, maximum: 1 }),
});
export const TYPESAFE_NOUL_ANSWERS_SCHEMA = Type.Object({ answers: Type.Record(Type.String(), TYPESAFE_NOUL_SCHEMA) });
const LEGACY_TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DATE_SNAPSHOT_SUFFIX = /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/u;
const JEV_VERSION = /^jev-\d+\.\d+\.\d+$/u;
/** Accept the exact requested model, a provider-dated snapshot (e.g. liquid/d1.2-ultra-20261116), or jev-latest -> jev-X.Y.Z. */
export function matchesDecisionModel(returned, requested = TYPESAFE_MODEL) {
    if (typeof returned !== "string" || !returned)
        return false;
    if (returned === requested)
        return true;
    if (requested === "jev-latest")
        return JEV_VERSION.test(returned);
    if (returned.startsWith(`${requested}-`)) {
        return DATE_SNAPSHOT_SUFFIX.test(returned.slice(requested.length + 1));
    }
    return false;
}
export function isLoopbackHostname(hostname) {
    const lower = hostname.toLowerCase();
    return lower === "localhost" || lower === "127.0.0.1" || lower === "[::1]" || lower === "::1";
}
function isLegacyTypeSafeEndpoint(endpoint) {
    if (!endpoint)
        return false;
    try {
        const url = new URL(endpoint);
        return url.protocol === "https:" && url.origin === "https://api.typesafe.ai";
    }
    catch {
        return false;
    }
}
function isCodexDecisionsEndpoint(endpoint) {
    if (!endpoint)
        return true;
    try {
        const url = new URL(endpoint);
        return url.protocol === "https:" && url.origin === "https://codex.unblocklabs.ai";
    }
    catch {
        return false;
    }
}
function isSystemOneEndpoint(endpoint) {
    try {
        return new URL(endpoint).pathname.replace(/\/+$/u, "").endsWith("/systemone");
    }
    catch {
        return false;
    }
}
export function defaultDecisionModel(endpoint = TYPESAFE_DEFAULT_ENDPOINT) {
    return isLegacyTypeSafeEndpoint(endpoint) ? TYPESAFE_LEGACY_MODEL : TYPESAFE_MODEL;
}
/** Namespace caches/cohorts by canonical endpoint when a non-default route is used. */
export function decisionModelScope(model = TYPESAFE_MODEL, endpoint) {
    if (!endpoint)
        return model;
    const canonical = endpoint.replace(/\/+$/u, "");
    if (canonical === TYPESAFE_DEFAULT_ENDPOINT && model === TYPESAFE_MODEL)
        return model;
    if (canonical === LEGACY_TYPESAFE_ENDPOINT && model.startsWith("jev-"))
        return model;
    return `${model}@${canonical}`;
}
function ambientCredentialEnvNames(endpoint) {
    if (isCodexDecisionsEndpoint(endpoint))
        return ["CODEX_LB_API_KEY"];
    if (isLegacyTypeSafeEndpoint(endpoint))
        return ["TYPESAFE_API_KEY"];
    return [];
}
function fileCredentialEnvNames(endpoint) {
    if (isCodexDecisionsEndpoint(endpoint))
        return ["CODEX_LB_API_KEY"];
    if (isLegacyTypeSafeEndpoint(endpoint))
        return ["TYPESAFE_API_KEY"];
    return endpoint && isSystemOneEndpoint(endpoint) ? ["TYPESAFE_API_KEY"] : ["CODEX_LB_API_KEY"];
}
function firstNonEmpty(values, names) {
    for (const name of names) {
        const value = values[name]?.trim();
        if (value)
            return value;
    }
    return undefined;
}
/** A conservative estimate of serialized size, not Jev's tokenizer. Non-ASCII is budgeted separately. */
export function estimateJevTokens(value) {
    let n = 0;
    for (const c of JSON.stringify(value))
        n += c.codePointAt(0) < 128 ? 1 / 3 : 2;
    return Math.ceil(n);
}
export class TypeSafeRequestError extends Error {
    code;
    status;
    retryAfter;
    constructor(message, code, status, retryAfter) {
        super(message);
        this.code = code;
        this.status = status;
        this.retryAfter = retryAfter;
    }
}
/** A TypeSafe deadline: the request's own timeout, or the caller's timed-out signal. */
export function isTypeSafeTimeout(error, signal) {
    return (error instanceof TypeSafeRequestError && error.code === "timeout") || abortedByTimeout(signal);
}
/** Explicit credentials take precedence; a missing explicit file never selects another key. */
export async function resolveTypeSafeApiKey(config) {
    if (!config.enabled)
        return undefined;
    if (config.apiKey)
        return config.apiKey.trim() || undefined;
    if (!config.apiKeyFile)
        return firstNonEmpty(process.env, ambientCredentialEnvNames(config.endpoint));
    let contents;
    try {
        contents = (await readFile(config.apiKeyFile, "utf8")).trim();
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return undefined;
        throw new Error("TypeSafe credential file could not be read");
    }
    if (!contents)
        return undefined;
    if (/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(contents) || contents.startsWith("#")) {
        return firstNonEmpty(parseEnv(contents), fileCredentialEnvNames(config.endpoint));
    }
    if (/\s/.test(contents))
        throw new Error("TypeSafe credential file must contain a key or dotenv entries");
    return contents;
}
/** One decision-model request. The caller owns the response schema and failure policy. */
export async function requestTypeSafe(params, state, questions) {
    const endpoint = params.endpoint ?? TYPESAFE_DEFAULT_ENDPOINT;
    const model = params.model ?? defaultDecisionModel(endpoint);
    const requestState = isSystemOneEndpoint(endpoint) || Array.isArray(state) || typeof state === "string"
        ? state : [state];
    const timeout = params.timeoutMs === undefined ? undefined : AbortSignal.timeout(params.timeoutMs);
    const signal = params.signal && timeout ? AbortSignal.any([params.signal, timeout]) : params.signal ?? timeout;
    try {
        signal?.throwIfAborted();
        const response = await fetch(endpoint, {
            method: "POST", redirect: "error", signal,
            headers: { Authorization: `Bearer ${params.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model, state: requestState, questions }),
        });
        if (!response.ok) {
            const retryAfter = response.status === 503 && isCodexDecisionsEndpoint(endpoint) && response.headers.has("retry-after");
            try {
                await response.body?.cancel();
            }
            catch { /* Status is authoritative; discard unsafe cancellation detail. */ }
            throw new TypeSafeRequestError(`TypeSafe HTTP ${response.status}`, "http_error", response.status, retryAfter);
        }
        try {
            return await response.json();
        }
        catch (error) {
            if (error instanceof SyntaxError)
                throw new TypeSafeRequestError("TypeSafe returned invalid JSON", "invalid_response");
            throw error;
        }
    }
    catch (error) {
        if (error instanceof TypeSafeRequestError)
            throw error;
        if (signal?.aborted) {
            const timedOut = abortedByTimeout(signal);
            throw new TypeSafeRequestError(timedOut ? "TypeSafe request timed out" : "TypeSafe request cancelled", timedOut ? "timeout" : "cancelled");
        }
        throw new TypeSafeRequestError("TypeSafe request failed", "network_error");
    }
}
