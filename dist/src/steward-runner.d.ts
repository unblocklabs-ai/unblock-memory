import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { type TSchema } from "typebox";
import type { StewardConfig } from "./steward-config.js";
type JsonObject = Record<string, unknown>;
/** Plain JSON Schema or a TypeBox schema (TypeBox interfaces lack an index signature). */
type Schema = JsonObject | TSchema;
export type StewardUsage = {
    requests: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    costUsd?: number;
};
export type StewardToolDef<TParams = JsonObject> = {
    name: string;
    description: string;
    parameters: Schema;
    execute: (params: TParams, signal: AbortSignal) => Promise<unknown>;
};
type Prompt = {
    purpose: string;
    systemPrompt: string;
    userPrompt: string;
    model?: string;
    reasoning?: StewardConfig["reasoning"];
    signal?: AbortSignal;
};
export type StewardCompleteRequest<T> = Prompt & {
    schema: Schema;
    timeoutMs?: number;
    maxRetries?: number;
};
type StewardErrorCode = "aborted" | "timeout" | "lifecycle_reload" | "missing_credentials" | "auth_denied" | "context_overflow" | "transient_provider" | "invalid_output" | "budget_exhausted" | "provider_error";
type Failure = {
    ok: false;
    code: StewardErrorCode;
    error: string;
    retryable: boolean;
    usage: StewardUsage;
};
export type StewardCompleteResult<T> = Failure | {
    ok: true;
    data: T;
    usage: StewardUsage;
    model?: string;
    backend: "host_llm" | "responses_api";
};
export type StewardRunRequest<T> = Prompt & {
    tools: readonly StewardToolDef[];
    submitSchema: Schema;
    submitDescription?: string;
    /** Maximum investigation turns (`0` = unlimited). */
    maxTurns: number;
    /** Maximum tool calls (`0` = unlimited). */
    maxToolCalls: number;
    /** Maximum client-side input tokens per request (`0` = unlimited). */
    maxInputTokens?: number;
    /** Maximum characters per tool result (`0` = unlimited). */
    maxToolResultChars?: number;
    /** Wall-clock timeout in ms (`0` = unlimited; caller `signal` still aborts). */
    wallTimeoutMs: number;
    /** When `wallTimeoutMs > 0`, reserve this many ms to force a final wrap-up submission (`0` = disabled). */
    wrapUpReserveMs?: number;
    onToolCall?: (event: {
        name: string;
        ok: boolean;
        elapsedMs: number;
    }) => void;
};
type Status = "complete" | "incomplete" | "needs_decision";
type Counts = {
    turns: number;
    toolCalls: number;
};
export type StewardRunResult<T> = Counts & (Failure | {
    ok: true;
    status: Status;
    data: T;
    summary: string;
    usage: StewardUsage;
    model?: string;
});
export interface StewardRunner {
    complete<T>(req: StewardCompleteRequest<T>): Promise<StewardCompleteResult<T>>;
    run<T>(req: StewardRunRequest<T>): Promise<StewardRunResult<T>>;
}
type Deps = {
    config: StewardConfig;
    resolveApiKey: () => Promise<string | undefined>;
    /**
     * Opt-in only (`useHostLlm: true`): OpenClaw denies plugin model overrides by default
     * (`LLM_COMPLETION_NOT_AUTHORIZED`) and ignores `steward.endpoint`/credentials, so `complete()` defaults to
     * the direct `/v1/responses` path.
     */
    hostLlmComplete?: OpenClawPluginApi["runtime"]["llm"]["complete"];
    useHostLlm?: boolean;
    fetch?: typeof fetch;
};
/**
 * Wire form of `schema` for OpenAI/codex-lb `strict: true`: every object closes `additionalProperties`, lists
 * every property in `required` (originally optional ones become nullable) and drops unsupported validation
 * keywords. Decode replies with `stripOptionalNulls` and validate them against the ORIGINAL schema.
 */
export declare function toStrictJsonSchema(schema: Schema): JsonObject;
/** Remove the `null`s strict mode forces onto originally optional keys (unless the original accepts null). */
export declare function stripOptionalNulls(value: unknown, schema: Schema): unknown;
export declare function createStewardRunner(deps: Deps): StewardRunner;
export {};
