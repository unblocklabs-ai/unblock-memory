import { createHash } from "node:crypto";
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function nonEmptyString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function timestamp(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value !== "string")
        return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function textContent(value) {
    if (typeof value === "string")
        return value.trim() || undefined;
    if (!Array.isArray(value))
        return undefined;
    const text = value.flatMap((item) => {
        const block = record(item);
        if (!block || typeof block.type !== "string")
            throw new Error("invalid transcript content block");
        if (!["text", "toolCall", "toolResult", "thinking", "image"].includes(block.type)) {
            throw new Error(`unsupported transcript content block: ${block.type}`);
        }
        if (block.type === "text" && typeof block.text !== "string") {
            throw new Error("invalid transcript text block");
        }
        return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
    }).join("\n").trim();
    return text || undefined;
}
function projectMessage(row, input) {
    let event;
    try {
        event = JSON.parse(row.eventJson);
    }
    catch {
        throw new Error("invalid transcript event JSON");
    }
    const eventRecord = record(event);
    if (eventRecord?.type !== "message")
        return undefined;
    const message = record(eventRecord?.message);
    if (!message)
        throw new Error("invalid transcript message event");
    const role = message.role;
    if (role !== "user" && role !== "assistant")
        return undefined;
    if (typeof message.content !== "string" && !Array.isArray(message.content)) {
        throw new Error("invalid transcript message content");
    }
    let text = textContent(message.content);
    if (!text)
        return undefined;
    if (text === "HEARTBEAT_OK")
        return undefined;
    if (role === "user" && (text === "[OpenClaw heartbeat poll]" ||
        text.startsWith("[Subagent Context]") ||
        text.startsWith("<relevant-memories>")))
        return undefined;
    const metadata = record(message.__openclaw);
    const speaker = role === "assistant"
        ? input.agentName
        : nonEmptyString(metadata?.senderName) ??
            nonEmptyString(metadata?.senderUsername) ??
            nonEmptyString(metadata?.senderId) ??
            nonEmptyString(message.senderName) ??
            nonEmptyString(message.senderLabel) ??
            nonEmptyString(message.senderId) ??
            "User";
    if (role === "user" && speaker !== "User") {
        text = text.replace(/^From:[^\n]*\n/u, "").trim();
    }
    if (!text)
        return undefined;
    return {
        speaker: speaker.replace(/[\r\n]+/gu, " "),
        text,
        timestamp: timestamp(eventRecord.timestamp) ?? row.createdAt ?? timestamp(message.timestamp) ?? input.startedAt,
    };
}
function formatTimestamp(value, timezone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short",
    }).formatToParts(value);
    const part = (type) => parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")} ` +
        `${part("hour")}:${part("minute")}:${part("second")} ${part("timeZoneName")}`.trim();
}
export function projectSession(input) {
    const messages = input.events.flatMap((event) => {
        const projected = projectMessage(event, input);
        return projected ? [projected] : [];
    });
    if (messages.length === 0)
        return undefined;
    const transcript = messages.map((message) => `${formatTimestamp(message.timestamp, input.timezone)} — ${message.speaker}: ${message.text}`);
    return `# Transcript\n\n${transcript.join("\n\n")}\n`;
}
function hash(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
function pathComponent(value, fallback, privateId = false) {
    const normalized = value?.trim();
    if (!normalized)
        return fallback;
    if (privateId || normalized.includes("@") || /^\+?\d{6,}$/u.test(normalized)) {
        return `id-${hash(normalized)}`;
    }
    const safe = normalized.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
    return safe && safe !== "." && safe !== ".." ? safe.slice(0, 80) : `id-${hash(normalized)}`;
}
export function sessionDocumentPath(metadata) {
    const provider = pathComponent(metadata.provider?.toLowerCase(), "unknown");
    const privateConversation = provider === "imessage";
    const account = pathComponent(metadata.accountId, "default", privateConversation);
    const conversation = pathComponent(metadata.conversationId, `session-${hash(metadata.sessionId)}`, privateConversation);
    const started = new Date(metadata.startedAt).toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/u, "Z");
    const sessionId = pathComponent(metadata.sessionId, hash(metadata.sessionId));
    return `${provider}/${metadata.chatType}/${account}/${conversation}/${started}--${sessionId}.md`;
}
export function resolveTimezone(configured) {
    if (configured) {
        try {
            new Intl.DateTimeFormat("en-US", { timeZone: configured }).format();
            return configured;
        }
        catch {
            // OpenClaw normally validates this; use the host timezone for stale config.
        }
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
