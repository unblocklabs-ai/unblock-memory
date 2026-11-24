export const MAX_SKILL_QUERY_CHARS = 12_000;
// Leaves room for the longest decision question under Jev's 32k state-plus-question limit.
export const MAX_STATE_TOKENS = 24_000;
/** Only visible user/assistant text; never system, tool, image, or thinking blocks. */
export function messageText(message) {
    if (!message || typeof message !== "object" || !("role" in message) || !("content" in message) ||
        (message.role !== "user" && message.role !== "assistant"))
        return undefined;
    const text = typeof message.content === "string" ? message.content.trim() :
        Array.isArray(message.content) ? message.content.flatMap((part) => {
            return part && typeof part === "object" && "type" in part && part.type === "text" &&
                "text" in part && typeof part.text === "string" ? [part.text] : [];
        }).join("\n").trim() : "";
    return text ? { role: message.role, text } : undefined;
}
export function recentSkillMessages(messages, limit) {
    const history = [];
    for (let i = messages.length - 1; i >= 0 && history.length < limit; i--) {
        const parsed = messageText(messages[i]);
        if (parsed)
            history.push(parsed);
    }
    return history.reverse();
}
export function buildSkillWhispererQuery(prompt, history) {
    return [...history.map(message => `${message.role}: ${message.text}`), `user: ${prompt.trim()}`]
        .join("\n\n").slice(-MAX_SKILL_QUERY_CHARS);
}
/** Collect whole recent entries from newest to oldest within a token budget, returning oldest first. */
export function takeRecentWithinTokens(items, options) {
    const { maxTokens, estimateTokens, transform } = options;
    const maxItems = options.maxItems ?? Infinity;
    let usedTokens = options.usedTokens;
    const kept = [];
    const start = Math.min(options.endIndex ?? items.length - 1, items.length - 1);
    for (let i = start; i >= 0 && kept.length < maxItems; i--) {
        const item = transform ? transform(items[i]) : items[i];
        if (item === undefined)
            continue;
        const cost = estimateTokens(item) + 1;
        if (usedTokens + cost > maxTokens)
            break;
        kept.push(item);
        usedTokens += cost;
    }
    return { items: kept.reverse(), usedTokens };
}
