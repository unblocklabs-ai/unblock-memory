/** One host contribution keeps every whisperer after the user in a stable order. */
export function registerWhispererPrompt(api, whisperers) {
    const ordered = [whisperers.memory, whisperers.skill, whisperers.people].filter(handler => handler !== undefined);
    if (!ordered.length)
        return;
    api.on("before_prompt_build", async (event, context) => {
        const results = await Promise.all(ordered.map(async (handler) => {
            try {
                return (await handler(event, context))?.appendContext;
            }
            catch {
                // One unavailable whisperer must not discard the others' context.
                api.logger.warn("unblock-memory whisperer contribution failed");
                return undefined;
            }
        }));
        const content = results.filter(Boolean).join("\n");
        if (content)
            return { appendContext: `<unblock_memory>\n${content}\n</unblock_memory>` };
    });
}
