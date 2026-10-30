import type { OpenClawConfig, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { MemoryRequestContext } from "./contracts.js";
/** The freshest config the host offers for this tool call. */
export declare function runtimeConfig(ctx: OpenClawPluginToolContext): OpenClawConfig | undefined;
export declare function getContext(ctx: OpenClawPluginToolContext): {
    cfg: OpenClawConfig;
    agentId: string;
    requestContext: MemoryRequestContext;
} | undefined;
