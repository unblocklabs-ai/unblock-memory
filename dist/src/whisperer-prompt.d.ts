import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { type WhispererName, type WhispererTriggersConfig } from "./config.js";
declare const apiTypes: OpenClawPluginApi;
type PromptHook = Parameters<typeof apiTypes.on<"before_prompt_build">>[1];
export type WhispererSurface = "user" | keyof WhispererTriggersConfig;
export type WhispererPrompt = (...args: [...Parameters<PromptHook>, surface?: WhispererSurface]) => ReturnType<PromptHook>;
/**
 * One whisperer's contribution. `finalize` is an optional, synchronous re-render invoked once every admitted whisperer has
 * settled, right before the combined prompt is emitted: it returns the contribution as it may be delivered NOW (e.g.
 * without a Fleet Commons hit retired while slower siblings were still finishing), or `undefined` to drop it.
 */
export type WhispererContribution = {
    appendContext: string;
    finalize?: () => {
        appendContext: string;
    } | undefined;
};
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
