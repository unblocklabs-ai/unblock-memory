/** Infer legacy transport sender metadata only to unwrap visible conversation text. */
export function conversationUserText(raw: string, sender?: unknown) {
  let senderId = typeof sender === "string" ? sender : undefined;
  if (senderId === undefined) {
    const header = /^Conversation info: ⟦openclaw:ctx⟧\r?\n```json\r?\n([^]*?)\r?\n```\r?\n/.exec(raw.trim());
    if (header) {
      let metadata: unknown;
      try { metadata = JSON.parse(header[1]!); } catch { return; }
      if (metadata && typeof metadata === "object" && "sender" in metadata && metadata.sender &&
          typeof metadata.sender === "object" && "id" in metadata.sender && typeof metadata.sender.id === "string") {
        senderId = metadata.sender.id;
      }
    }
    senderId ??= /^From: [^\r\n]+ \(([^()\r\n]+)\)\r?\n/.exec(raw.trim())?.[1];
  }
  return responseUserText(raw, senderId ?? "");
}

/** Parse only recognized transport envelopes. Ambiguous wrappers are excluded,
 * never flattened into a human's request or used to approve embedded speakers. */
export function responseUserText(input: string, senderId: string) {
  let text = input.trim();
  let contextLimited = false;
  const header = /^Conversation info: ⟦openclaw:ctx⟧\r?\n```json\r?\n([^]*?)\r?\n```\r?\n/.exec(text);
  if (header) {
    let meta: { sender?: { id?: unknown; name?: unknown }; history_truncated?: unknown };
    try { meta = JSON.parse(header[1]!); } catch { return undefined; }
    if (!meta || meta.sender?.id !== senderId || typeof meta.sender.name !== "string") return undefined;
    const rest = text.slice(header[0].length);
    const markers = [...rest.matchAll(/^System: \[[^\]\r\n]+\] Slack (?:message in [^\r\n]+|DM) from ([^\r\n]+)\r?\n\r?\n/gm)];
    if (markers.length !== 1 || markers[0]![1] !== meta.sender.name) return undefined;
    const marker = markers[0]!;
    contextLimited = meta.history_truncated === true || rest.slice(0, marker.index).includes("Chat history since last reply:");
    text = rest.slice(marker.index! + marker[0].length).trim();
  } else {
    const from = /^From: [^\r\n]+ \(([^()\r\n]+)\)\r?\n/.exec(text);
    if (from) {
      if (from[1] !== senderId) return undefined;
      text = text.slice(from[0].length).trim();
    }
  }
  // Unrecognized/nested envelopes cannot safely supply the current human text.
  if (!text || text.includes("⟦openclaw:ctx⟧") || /^Chat history since last reply:/m.test(text)) return undefined;
  return { text, contextLimited };
}
