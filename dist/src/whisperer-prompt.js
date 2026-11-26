import { WHISPERER_NAMES as ORDER } from "./config.js";
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
