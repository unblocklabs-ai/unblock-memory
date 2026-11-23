export const CONVERSATION_INFO = /^(?:\[OpenClaw conversation info: [^\r\n]*\]\r?\n)?Conversation info: ⟦openclaw:ctx⟧\r?\n```json\r?\n([^]*?)\r?\n```\r?\n/;
const FROM_HEADER = /^From: [^\r\n]+ \(([^()\r\n]+)\)(?:\r?\n|$)/;
const SLACK_MESSAGE_LINE = /^System: \[[^\]\r\n]+\] Slack (?:message in [^\r\n]+|DM) from ([^\r\n]+)$/gm;
const SYSTEM_EVENT_LINE = /^System: \[[^\]\r\n]+\] [^\r\n]+$/;
const INBOUND_HISTORY_MARKER = /^(?:Chat history since last reply|Recent chat history)(?: \(untrusted, for context\))?:/m;
const INBOUND_CTX_HEADER = /^[A-Za-z][A-Za-z0-9 _()/-]*: ⟦openclaw:ctx⟧$/;
const INBOUND_DELIVERY_HINT = /^Delivery: (?:to send a message, use the `message` tool\.|Final assistant text is not automatically delivered in this run\.[^\r\n]*|No visible reply is delivered automatically in this run[^\r\n]*)$/;
const LEGACY_REQUESTER_PROFILE_HINT = 'requester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available.';
const ACTIVE_GOAL_LINE = /^Active goal: [^\r\n]+$/;
const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";
function readLine(text, start) {
    if (start >= text.length)
        return undefined;
    const lf = text.indexOf("\n", start);
    const end = lf < 0 ? text.length : lf;
    const next = lf < 0 ? text.length : lf + 1;
    return { start, end, next, trimmed: text.slice(start, end).trim() };
}
function parseConversationHeader(rawJson) {
    let meta;
    try {
        meta = JSON.parse(rawJson);
    }
    catch {
        return undefined;
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta))
        return undefined;
    return {
        senderId: typeof meta.sender?.id === "string" ? meta.sender.id : undefined,
        senderName: typeof meta.sender?.name === "string" ? meta.sender.name : undefined,
        historyTruncated: meta.history_truncated === true,
    };
}
function stripChannelContextSuffix(text) {
    const contexts = [...text.matchAll(/\r?\n\r?\nContext: ⟦openclaw:ctx⟧\r?\n/g)];
    if (!contexts.length)
        return { text, stripped: false };
    if (contexts.length !== 1)
        return undefined;
    const context = contexts[0];
    const suffix = text.slice(context.index + context[0].length);
    if (!suffix.trim() || suffix.includes("⟦openclaw:ctx⟧") || INBOUND_HISTORY_MARKER.test(suffix))
        return undefined;
    return { text: text.slice(0, context.index).trim(), stripped: true };
}
/** Advance past one validated Slack message line, any adjacent non-message System lines, and the required blank separator line. */
function slackMarkerBodyStart(rest, markerEnd) {
    let pos = markerEnd;
    if (rest[pos] === "\r")
        pos++;
    if (rest[pos] !== "\n")
        return undefined;
    pos++;
    while (pos < rest.length) {
        const line = readLine(rest, pos);
        if (!line)
            return undefined;
        if (line.trimmed === "")
            return line.next;
        if (!SYSTEM_EVENT_LINE.test(line.trimmed))
            return undefined;
        pos = line.next;
    }
    return undefined;
}
/** Infer legacy transport sender metadata only to unwrap visible conversation text. */
export function conversationUserText(raw, sender) {
    const parsed = conversationEnvelope(raw, sender);
    return parsed && { text: parsed.text, contextLimited: parsed.contextLimited };
}
/** Unwrap human text for recall query generation, including non-Slack OpenClaw inbound envelopes. */
export function queryUserText(raw, sender) {
    const standard = conversationUserText(raw, sender);
    if (standard)
        return standard.text;
    const trimmed = raw.trim();
    const header = CONVERSATION_INFO.exec(trimmed);
    if (!header)
        return undefined;
    const meta = parseConversationHeader(header[1]);
    if (!meta || (typeof sender === "string" && meta.senderId !== sender))
        return undefined;
    const rest = trimmed.slice(header[0].length);
    // Slack envelopes must pass strict speaker-marker validation in userEnvelope.
    if ([...rest.matchAll(SLACK_MESSAGE_LINE)].length > 0)
        return undefined;
    let pos = 0;
    while (pos < rest.length) {
        let line = readLine(rest, pos);
        while (line && line.trimmed === "") {
            pos = line.next;
            line = readLine(rest, pos);
        }
        if (!line)
            break;
        if (line.trimmed === "Conversation info: ⟦openclaw:ctx⟧")
            return undefined;
        if (INBOUND_CTX_HEADER.test(line.trimmed) && line.trimmed !== "Context: ⟦openclaw:ctx⟧") {
            const label = line.trimmed;
            pos = line.next;
            const open = readLine(rest, pos);
            if (open?.trimmed === "```json") {
                pos = open.next;
                const jsonStart = pos;
                let close = readLine(rest, pos);
                while (close && close.trimmed !== "```") {
                    pos = close.next;
                    close = readLine(rest, pos);
                }
                if (!close)
                    return undefined;
                if (label === "Sender: ⟦openclaw:ctx⟧" && meta.senderId !== undefined) {
                    let senderMeta;
                    try {
                        senderMeta = JSON.parse(rest.slice(jsonStart, close.start));
                    }
                    catch {
                        return undefined;
                    }
                    if (typeof senderMeta?.id === "string" && senderMeta.id !== meta.senderId)
                        return undefined;
                }
                pos = close.next;
            }
            else {
                let content = open;
                while (content && content.trimmed !== "") {
                    pos = content.next;
                    content = readLine(rest, pos);
                }
            }
            continue;
        }
        if (line.trimmed === "Context:") {
            const open = readLine(rest, line.next);
            if (open?.trimmed === "<active_memory_plugin>") {
                let scan = readLine(rest, open.next);
                while (scan && scan.trimmed !== "</active_memory_plugin>")
                    scan = readLine(rest, scan.next);
                if (!scan)
                    return undefined;
                pos = scan.next;
                continue;
            }
        }
        if (INBOUND_DELIVERY_HINT.test(line.trimmed) || line.trimmed === CURRENT_MESSAGE_MARKER ||
            line.trimmed === LEGACY_REQUESTER_PROFILE_HINT || ACTIVE_GOAL_LINE.test(line.trimmed)) {
            pos = line.next;
            continue;
        }
        break;
    }
    const stripped = stripChannelContextSuffix(rest.slice(pos).trim());
    if (!stripped)
        return undefined;
    let body = stripped.text;
    const from = FROM_HEADER.exec(body);
    if (from) {
        if (meta.senderId === undefined || from[1] !== meta.senderId)
            return undefined;
        body = body.slice(from[0].length).trim();
    }
    if (!body || body.includes("⟦openclaw:ctx⟧") || INBOUND_HISTORY_MARKER.test(body))
        return undefined;
    return body;
}
/** Like conversationUserText, plus the untrusted inbound context (thread starter, reply target,
 * chat history) that a recognized envelope carries before the current message. */
export function conversationEnvelope(raw, sender) {
    let senderId = typeof sender === "string" ? sender : undefined;
    if (senderId === undefined) {
        const header = CONVERSATION_INFO.exec(raw.trim());
        if (header) {
            const meta = parseConversationHeader(header[1]);
            if (!meta || meta.senderId === undefined)
                return;
            senderId = meta.senderId;
        }
        senderId ??= FROM_HEADER.exec(raw.trim())?.[1];
    }
    return userEnvelope(raw, senderId ?? "");
}
/** Parse only recognized transport envelopes. Ambiguous wrappers are excluded,
 * never flattened into a human's request or used to approve embedded speakers. */
export function responseUserText(input, senderId) {
    const parsed = userEnvelope(input, senderId);
    return parsed && { text: parsed.text, contextLimited: parsed.contextLimited };
}
function userEnvelope(input, senderId) {
    let text = input.trim();
    let contextLimited = false;
    let context;
    const header = CONVERSATION_INFO.exec(text);
    if (header) {
        const meta = parseConversationHeader(header[1]);
        if (!meta || meta.senderId !== senderId || meta.senderName === undefined)
            return undefined;
        const rest = text.slice(header[0].length);
        const markers = [...rest.matchAll(SLACK_MESSAGE_LINE)];
        if (markers.length !== 1 || markers[0][1] !== meta.senderName)
            return undefined;
        const marker = markers[0];
        const bodyStart = slackMarkerBodyStart(rest, marker.index + marker[0].length);
        if (bodyStart === undefined)
            return undefined;
        const prefix = rest.slice(0, marker.index);
        context = prefix.trim() || undefined;
        contextLimited = meta.historyTruncated || INBOUND_HISTORY_MARKER.test(prefix);
        text = rest.slice(bodyStart).trim();
        // OpenClaw appends channel metadata after the current Slack message. Only
        // recognize its exact boundary inside an already validated envelope.
        const stripped = stripChannelContextSuffix(text);
        if (!stripped)
            return undefined;
        text = stripped.text;
        if (stripped.stripped)
            contextLimited = true;
    }
    else {
        const from = FROM_HEADER.exec(text);
        if (from) {
            if (from[1] !== senderId)
                return undefined;
            text = text.slice(from[0].length).trim();
        }
    }
    // Unrecognized/nested envelopes cannot safely supply the current human text.
    if (!text || text.includes("⟦openclaw:ctx⟧") || INBOUND_HISTORY_MARKER.test(text))
        return undefined;
    return { text, contextLimited, ...(context ? { context } : {}) };
}
