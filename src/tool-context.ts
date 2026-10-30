import type { OpenClawConfig, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { MemoryRequestContext } from "./contracts.js";

/** The freshest config the host offers for this tool call. */
export function runtimeConfig(ctx: OpenClawPluginToolContext): OpenClawConfig | undefined {
  return ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
}

export function getContext(ctx: OpenClawPluginToolContext): { cfg: OpenClawConfig; agentId: string; requestContext: MemoryRequestContext } | undefined {
  const cfg = runtimeConfig(ctx);
  if (!cfg || !ctx.agentId) return undefined;
  return {
    cfg,
    agentId: ctx.agentId,
    requestContext: {
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      messageChannel: ctx.messageChannel,
      agentAccountId: ctx.agentAccountId,
      nativeChannelId: ctx.nativeChannelId,
      deliveryContext: ctx.deliveryContext,
    },
  };
}
