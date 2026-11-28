import { WHISPERER_NAMES as ORDER } from "./config.js";
import { nonBlank } from "./guards.js";
/** Direct calls lack a dispatcher surface, so only the host's user trigger admits them. */
export function hasWhispererTrigger(trigger, surface) {
    return Boolean(surface) || trigger === "user";
}
/** Normalize only host-supplied identifiers, never claims in the prompt. */
export function trustedWhispererOrigin(context) {
    const provider = nonBlank(context.messageProvider)?.toLowerCase();
    const accountId = nonBlank(context.accountId)?.toLowerCase();
    const senderId = nonBlank(context.senderId);
    const rawChannel = nonBlank(context.chatId) ?? nonBlank(context.channelId);
    const lower = rawChannel?.toLowerCase();
    const thread = lower?.lastIndexOf(":thread:") ?? -1;
    const topic = lower?.lastIndexOf(":topic:") ?? -1;
    const split = Math.max(thread, topic);
    const channel = split > 0 ? rawChannel.slice(0, split).toLowerCase() : lower;
    const threadId = split > 0 ? nonBlank(rawChannel.slice(split + (split === thread ? ":thread:".length : ":topic:".length))) : undefined;
    // The host can fall back to the provider name when there is no channel.
    const channelId = channel && channel !== provider ? channel : undefined;
    return { provider, accountId, senderId, channelId, threadId };
}
export function whispererSurface(context) {
    if (typeof context.sessionKey === "string" && context.sessionKey.includes(":subagent:"))
        return "subagent";
    const { trigger } = context;
    if (trigger === "cron" || trigger === "heartbeat" || trigger === "user")
        return trigger;
}
/** One host contribution keeps every whisperer after the user in a stable order; safety stays closest to the reply. */
export function registerWhispererPrompt(api, whisperers, triggers) {
    const ordered = ORDER.flatMap(name => {
        const handler = whisperers[name];
        return handler ? [{ name, handler }] : [];
    });
    if (!ordered.length)
        return;
    api.on("before_prompt_build", async (event, context) => {
        const surface = whispererSurface(context);
        if (!surface)
            return;
        const admitted = surface === "user" ? ordered : ordered.filter(({ name }) => triggers[surface].includes(name));
        const results = await Promise.all(admitted.map(async ({ name, handler }) => {
            try {
                return (await handler(event, context, surface))?.appendContext;
            }
            catch {
                // One unavailable whisperer must not discard the others' context. Safety records its own failures first.
                api.logger.warn(`unblock-memory ${name} whisperer contribution failed`);
                return undefined;
            }
        }));
        const content = results.filter(Boolean).join("\n");
        if (content)
            return { appendContext: `<unblock_memory>\n${content}\n</unblock_memory>` };
    });
}
