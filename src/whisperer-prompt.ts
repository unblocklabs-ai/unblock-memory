import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { WHISPERER_NAMES as ORDER, type WhispererName, type WhispererTriggersConfig } from "./config.js";
import { nonBlank } from "./guards.js";

declare const apiTypes: OpenClawPluginApi;
type PromptHook = Parameters<typeof apiTypes.on<"before_prompt_build">>[1];
export type WhispererSurface = "user" | keyof WhispererTriggersConfig;
export type WhispererPrompt = (...args: [...Parameters<PromptHook>, surface?: WhispererSurface]) => ReturnType<PromptHook>;

/**
 * One whisperer's contribution. `finalize` is an optional, synchronous re-render invoked once every admitted whisperer has
 * settled, right before the combined prompt is emitted: it returns the contribution as it may be delivered NOW (e.g.
 * without a Fleet Commons hit retired while slower siblings were still finishing), or `undefined` to drop it.
 */
export type WhispererContribution = { appendContext: string; finalize?: () => { appendContext: string } | undefined };

/** Direct calls lack a dispatcher surface, so only the host's user trigger admits them. */
export function hasWhispererTrigger(trigger: Parameters<PromptHook>[1]["trigger"], surface?: WhispererSurface): boolean {
  return Boolean(surface) || trigger === "user";
}

/** Normalize only host-supplied identifiers, never claims in the prompt. */
export function trustedWhispererOrigin(context: Record<string, unknown>) {
  const provider = nonBlank(context.messageProvider)?.toLowerCase();
  const accountId = nonBlank(context.accountId)?.toLowerCase();
  const senderId = nonBlank(context.senderId);
  const rawChannel = nonBlank(context.chatId) ?? nonBlank(context.channelId);
  const lower = rawChannel?.toLowerCase();
  const thread = lower?.lastIndexOf(":thread:") ?? -1;
  const topic = lower?.lastIndexOf(":topic:") ?? -1;
  const split = Math.max(thread, topic);
  const channel = split > 0 ? rawChannel!.slice(0, split).toLowerCase() : lower;
  const threadId = split > 0 ? nonBlank(rawChannel!.slice(split + (split === thread ? ":thread:".length : ":topic:".length))) : undefined;
  // The host can fall back to the provider name when there is no channel.
  const channelId = channel && channel !== provider ? channel : undefined;
  return { provider, accountId, senderId, channelId, threadId };
}

export function whispererSurface(context: Pick<Parameters<PromptHook>[1], "sessionKey" | "trigger">): WhispererSurface | undefined {
  if (typeof context.sessionKey === "string" && context.sessionKey.includes(":subagent:")) return "subagent";
  const { trigger } = context;
  if (trigger === "cron" || trigger === "heartbeat" || trigger === "user") return trigger;
}

/** One host contribution keeps every whisperer after the user in a stable order; safety stays closest to the reply. */
export function registerWhispererPrompt(
  api: OpenClawPluginApi,
  whisperers: Partial<Record<WhispererName, WhispererPrompt>>,
  triggers: WhispererTriggersConfig,
): void {
  const ordered = ORDER.flatMap(name => {
    const handler = whisperers[name];
    return handler ? [{ name, handler }] : [];
  });
  if (!ordered.length) return;
  api.on("before_prompt_build", async (event, context) => {
    const surface = whispererSurface(context);
    if (!surface) return;
    const admitted = surface === "user" ? ordered : ordered.filter(({ name }) => triggers[surface].includes(name));
    const settled = await Promise.all(admitted.map(async ({ name, handler }) => {
      try {
        return { name, result: await handler(event, context, surface) as WhispererContribution | undefined | void };
      } catch {
        // One unavailable whisperer must not discard the others' context. Safety records its own failures first.
        api.logger.warn(`unblock-memory ${name} whisperer contribution failed`);
        return undefined;
      }
    }));
    // Final delivery boundary: every contribution is re-rendered as of NOW, after the slowest sibling settled.
    const results = settled.map(entry => {
      if (!entry?.result?.finalize) return entry?.result?.appendContext;
      try { return entry.result.finalize()?.appendContext; }
      catch {
        api.logger.warn(`unblock-memory ${entry.name} whisperer contribution failed`);
        return undefined;
      }
    });
    const content = results.filter(Boolean).join("\n");
    if (content) return { appendContext: `<unblock_memory>\n${content}\n</unblock_memory>` };
  });
}
