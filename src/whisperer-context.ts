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

export function memoryConversation(prompt: string, messages: readonly unknown[]) {
  const currentRequest = prompt.trim().slice(-16_000);
  let remaining = 16_000 - currentRequest.length;
  let truncated = currentRequest.length < prompt.trim().length;
  const history: { role: "user" | "assistant"; content: string }[] = [];
  const available = messages.flatMap(message => {
    const parsed = messageText(message);
    return parsed ? [parsed] : [];
  });
  // Hosts may include the current user message in messages as well as prompt.
  if (available.at(-1)?.role === "user" && available.at(-1)?.text === prompt.trim()) available.pop();
  for (const message of available.reverse()) {
    if (message.text.length > remaining) truncated = true;
    if (remaining <= 0) continue;
    const content = message.text.slice(-remaining);
    history.unshift({ role: message.role, content });
    remaining -= content.length;
  }
  return { currentRequest, history, truncated };
}
