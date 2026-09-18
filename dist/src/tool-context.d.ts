import type { OpenClawConfig, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { MemoryRequestContext } from "./contracts.js";
export declare function getContext(ctx: OpenClawPluginToolContext): {
    cfg: OpenClawConfig;
    agentId: string;
    requestContext: MemoryRequestContext;
} | undefined;
