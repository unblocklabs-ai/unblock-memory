import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const ORDER = ["memory", "skill", "people", "safety"] as const;

/** One host contribution keeps every whisperer after the user in a stable order; safety stays closest to the reply. */
export function registerWhispererPrompt(
  api: OpenClawPluginApi,
  whisperers: Partial<Record<(typeof ORDER)[number], Parameters<typeof api.on<"before_prompt_build">>[1]>>,
): void {
  const ordered = ORDER.flatMap(name => whisperers[name] ? [{ name, handler: whisperers[name] }] : []);
  if (!ordered.length) return;
  api.on("before_prompt_build", async (event, context) => {
    const results = await Promise.all(ordered.map(async ({ name, handler }) => {
      try {
        return (await handler(event, context))?.appendContext;
      } catch {
        // One unavailable whisperer must not discard the others' context. Safety records its own failures first.
        api.logger.warn(`unblock-memory ${name} whisperer contribution failed`);
        return undefined;
      }
    }));
    const content = results.filter(Boolean).join("\n");
    if (content) return { appendContext: `<unblock_memory>\n${content}\n</unblock_memory>` };
  });
}
