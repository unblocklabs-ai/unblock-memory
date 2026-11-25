export const MAX_SKILL_QUERY_CHARS = 12_000;
// Leaves room for the longest decision question under a 32k state-plus-question limit.
export const MAX_STATE_TOKENS = 24_000;

/** Only visible user/assistant text; never system, tool, image, or thinking blocks. */
export function messageText(message: unknown): { role: "user" | "assistant"; text: string } | undefined {
  if (!message || typeof message !== "object" || !("role" in message) || !("content" in message) ||
    (message.role !== "user" && message.role !== "assistant")) return undefined;
  const text = typeof message.content === "string" ? message.content.trim() :
    Array.isArray(message.content) ? message.content.flatMap((part: unknown) => {
      return part && typeof part === "object" && "type" in part && part.type === "text" &&
        "text" in part && typeof part.text === "string" ? [part.text] : [];
    }).join("\n").trim() : "";
  return text ? { role: message.role, text } : undefined;
}

export function recentSkillMessages(messages: readonly unknown[], limit: number) {
  const history: NonNullable<ReturnType<typeof messageText>>[] = [];
  for (let i = messages.length - 1; i >= 0 && history.length < limit; i--) {
    const parsed = messageText(messages[i]);
    if (parsed) history.push(parsed);
  }
  return history.reverse();
}

export function buildSkillWhispererQuery(prompt: string, history: readonly NonNullable<ReturnType<typeof messageText>>[]): string {
  return [...history.map(message => `${message.role}: ${message.text}`), `user: ${prompt.trim()}`]
    .join("\n\n").slice(-MAX_SKILL_QUERY_CHARS);
}

/** Collect whole recent entries from newest to oldest within a token budget, returning oldest first. */
export function takeRecentWithinTokens<In, Out = In>(
  items: readonly In[],
  options: {
    endIndex?: number;
    maxItems?: number;
    maxTokens: number;
    usedTokens: number;
    estimateTokens: (item: Out) => number;
    transform?: (item: In) => Out | undefined;
  },
): { items: Out[]; usedTokens: number } {
  const { maxTokens, estimateTokens, transform } = options;
  const maxItems = options.maxItems ?? Infinity;
  let usedTokens = options.usedTokens;
  const kept: Out[] = [];
  const start = Math.min(options.endIndex ?? items.length - 1, items.length - 1);
  for (let i = start; i >= 0 && kept.length < maxItems; i--) {
    const item = transform ? transform(items[i]!) : (items[i] as unknown as Out);
    if (item === undefined) continue;
    const cost = estimateTokens(item) + 1;
    if (usedTokens + cost > maxTokens) break;
    kept.push(item);
    usedTokens += cost;
  }
  return { items: kept.reverse(), usedTokens };
}
