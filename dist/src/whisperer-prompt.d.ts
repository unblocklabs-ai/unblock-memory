import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { type WhispererName, type WhispererTriggersConfig } from "./config.js";
declare const apiTypes: OpenClawPluginApi;
type PromptHook = Parameters<typeof apiTypes.on<"before_prompt_build">>[1];
export type WhispererSurface = "user" | keyof WhispererTriggersConfig;
export type WhispererPrompt = (...args: [...Parameters<PromptHook>, surface?: WhispererSurface]) => ReturnType<PromptHook>;
/** Direct calls lack a dispatcher surface, so only the host's user trigger admits them. */
export declare function hasWhispererTrigger(trigger: Parameters<PromptHook>[1]["trigger"], surface?: WhispererSurface): boolean;
/** Normalize only host-supplied identifiers, never claims in the prompt. */
export declare function trustedWhispererOrigin(context: Record<string, unknown>): {
    provider: string | undefined;
    accountId: string | undefined;
    senderId: string | undefined;
    channelId: string | undefined;
    threadId: string | undefined;
};
export declare function whispererSurface(context: Pick<Parameters<PromptHook>[1], "sessionKey" | "trigger">): WhispererSurface | undefined;
/** One host contribution keeps every whisperer after the user in a stable order; safety stays closest to the reply. */
export declare function registerWhispererPrompt(api: OpenClawPluginApi, whisperers: Partial<Record<WhispererName, WhispererPrompt>>, triggers: WhispererTriggersConfig): void;
export {};
