const MAX_SKILL_QUERY_CHARS = 12_000;
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
