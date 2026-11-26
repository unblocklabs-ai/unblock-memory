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
type StewardErrorCode = "aborted" | "timeout" | "lifecycle_reload" | "missing_credentials" | "context_overflow" | "transient_provider" | "invalid_output" | "budget_exhausted" | "provider_error";
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
    maxTurns: number;
    maxToolCalls: number;
    maxInputTokens?: number;
    maxToolResultChars?: number;
    wallTimeoutMs: number;
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
    hostLlmComplete?: OpenClawPluginApi["runtime"]["llm"]["complete"];
    fetch?: typeof fetch;
};
export declare function createStewardRunner(deps: Deps): StewardRunner;
export {};
