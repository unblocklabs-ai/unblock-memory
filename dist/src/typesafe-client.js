import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
export const TYPESAFE_MODEL = "jev-1.13.0";
export class TypeSafeRequestError extends Error {
    code;
    status;
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
/** Explicit credentials take precedence; a missing explicit file never selects another key. */
export async function resolveTypeSafeApiKey(config) {
    if (!config.enabled)
        return undefined;
    if (config.apiKey)
        return config.apiKey.trim() || undefined;
    if (!config.apiKeyFile)
        return process.env.TYPESAFE_API_KEY?.trim() || undefined;
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
        return parseEnv(contents).TYPESAFE_API_KEY?.trim() || undefined;
    }
    if (/\s/.test(contents))
        throw new Error("TypeSafe credential file must contain a key or dotenv entries");
    return contents;
}
/** One TypeSafe request. The caller owns the response schema and failure policy. */
export async function requestTypeSafe(params, state, questions) {
    const timeout = params.timeoutMs === undefined ? undefined : AbortSignal.timeout(params.timeoutMs);
    const signal = params.signal && timeout ? AbortSignal.any([params.signal, timeout]) : params.signal ?? timeout;
    try {
        signal?.throwIfAborted();
        const response = await fetch("https://api.typesafe.ai/v1/systemone", {
            method: "POST", redirect: "error", signal,
            headers: { Authorization: `Bearer ${params.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: TYPESAFE_MODEL, state, questions }),
        });
        if (!response.ok) {
            try {
                await response.body?.cancel();
            }
            catch { /* Status is authoritative; discard unsafe cancellation detail. */ }
            throw new TypeSafeRequestError(`TypeSafe HTTP ${response.status}`, "http_error", response.status);
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
            const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
            throw new TypeSafeRequestError(timedOut ? "TypeSafe request timed out" : "TypeSafe request cancelled", timedOut ? "timeout" : "cancelled");
        }
        throw new TypeSafeRequestError("TypeSafe request failed", "network_error");
    }
}
