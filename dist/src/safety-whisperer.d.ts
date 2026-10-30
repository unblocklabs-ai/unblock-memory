import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
type SafetyPluginConfig = Pick<UnblockMemoryConfig, "safetyWhisperer" | "typesafe" | "memoryWhisperer" | "skillWhisperer">;
/**
 * The complete current human message, the channel context that arrived with it, and whole recent
 * messages. OpenClaw's identity header is never sent; an oversized current message is not truncated.
 */
export declare function safetyConversation(prompt: string, messages: readonly unknown[], historyMessages: number, senderId?: string): {
    history: {
        role: "user" | "assistant";
        content: string;
    }[];
    channelContext?: string | undefined;
    currentRequest: string;
};
/** Whether the host lets the check run at all; a skipped hook is not active protection. */
export declare function safetyStatus(cfg: unknown, config: SafetyPluginConfig): {
    readonly enabled: false;
    readonly active: false;
    readonly reason: "disabled";
} | {
    hostTimeoutMs?: number | undefined;
    slowestWhispererMs?: number | undefined;
    warnings?: string[] | undefined;
    reason?: string | undefined;
    enabled: boolean;
    active: boolean;
};
export declare function registerSafetyWhisperer(api: OpenClawPluginApi, plugin: SafetyPluginConfig, diagnostics?: WhispererDiagnostics): Parameters<typeof api.on<"before_prompt_build">>[1] | undefined;
export {};
