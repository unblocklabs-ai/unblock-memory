import type { OpenClawConfig, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { MemoryRequestContext } from "./contracts.js";

export function getContext(ctx: OpenClawPluginToolContext): { cfg: OpenClawConfig; agentId: string; requestContext: MemoryRequestContext } | undefined {
  const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
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
