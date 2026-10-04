import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { QmdMemoryRuntime } from "./runtime.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
import { getContext } from "./tool-context.js";
/** Bound initialization as well as inference, without cancelling shared managers. */
export declare function reviewRequestContext(runtime: QmdMemoryRuntime, active: NonNullable<ReturnType<typeof getContext>>, typesafe: UnblockMemoryConfig["typesafe"], signal?: AbortSignal): Promise<{
    readonly status: "unavailable";
    readonly reason: "TypeSafe API key not configured";
    readonly manager?: undefined;
    readonly apiKey?: undefined;
    readonly signal?: undefined;
    readonly timeoutMs?: undefined;
} | {
    readonly status: "unavailable";
    readonly reason: "Memory manager unavailable";
    readonly manager?: undefined;
    readonly apiKey?: undefined;
    readonly signal?: undefined;
    readonly timeoutMs?: undefined;
} | {
    readonly status: "ready";
    readonly manager: import("./manager.js").QmdMemoryManager;
    readonly apiKey: string;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    reason?: undefined;
}>;
export declare function registerReviewTools(api: OpenClawPluginApi, runtime: QmdMemoryRuntime, config: UnblockMemoryConfig, diagnostics: WhispererDiagnostics): void;
