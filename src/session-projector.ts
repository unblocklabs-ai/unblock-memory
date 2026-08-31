import { createHash } from "node:crypto";
import type { ChatType } from "./config.js";

export type SessionMetadata = {
  sessionId: string;
  provider?: string;
  chatType: ChatType;
  accountId?: string;
  conversationId?: string;
  startedAt: number;
};

export type SessionProjectionInput = SessionMetadata & {
  label?: string;
  agentName: string;
  timezone: string;
  events: readonly { eventJson: string; createdAt: number }[];
};

type ProjectedMessage = {
  role: "user" | "assistant";
  speaker: string;
  text: string;
  timestamp: number;
};

export type SessionContextSpans = {
  message: { start: number; end: number };
  turn: { start: number; end: number };
};

const MESSAGE_HEADING =
  /^## (User|Assistant) — .* — \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S.*$/gmu;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((item) => {
    const block = record(item);
    if (!block || typeof block.type !== "string") throw new Error("invalid transcript content block");
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

function projectMessage(row: SessionProjectionInput["events"][number], input: SessionProjectionInput): ProjectedMessage | undefined {
  let event: unknown;
  try {
    event = JSON.parse(row.eventJson);
  } catch {
    throw new Error("invalid transcript event JSON");
  }
  const eventRecord = record(event);
  if (eventRecord?.type !== "message") return undefined;
  const message = record(eventRecord?.message);
  if (!message) throw new Error("invalid transcript message event");
  const role = message.role;
  if (role !== "user" && role !== "assistant") return undefined;
  if (typeof message.content !== "string" && !Array.isArray(message.content)) {
    throw new Error("invalid transcript message content");
  }
  let text = textContent(message.content);
  if (!text) return undefined;
  if (text === "HEARTBEAT_OK") return undefined;
  if (role === "user" && (
    text === "[OpenClaw heartbeat poll]" ||
    text.startsWith("[Subagent Context]") ||
    text.startsWith("<relevant-memories>")
  )) return undefined;

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
  if (!text) return undefined;
  return {
    role,
    speaker: speaker.replace(/[\r\n]+/gu, " "),
    text,
    timestamp: timestamp(eventRecord.timestamp) ?? row.createdAt ?? timestamp(message.timestamp) ?? input.startedAt,
  };
}

function formatTimestamp(value: number, timezone: string): string {
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
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ` +
    `${part("hour")}:${part("minute")}:${part("second")} ${part("timeZoneName")}`.trim();
}

export function projectSession(input: SessionProjectionInput): string | undefined {
  const messages = input.events.flatMap((event) => {
    const projected = projectMessage(event, input);
    return projected ? [projected] : [];
  });
  if (messages.length === 0) return undefined;

  const transcript = messages.map((message) =>
    `## ${message.role === "user" ? "User" : "Assistant"} — ${message.speaker} — ` +
    `${formatTimestamp(message.timestamp, input.timezone)}\n\n${message.text}`);
  return `# Transcript\n\n${transcript.join("\n\n")}\n`;
}

export function sessionContextSpans(content: string, position: number): SessionContextSpans | undefined {
  const markers = [...content.matchAll(MESSAGE_HEADING)].map((match) => ({
    start: match.index,
    role: match[1] === "User" ? "user" as const : "assistant" as const,
  }));
  const containing = markers.findLastIndex((marker) => marker.start <= position);
  if (containing < 0) return undefined;

  const message = {
    start: markers[containing]!.start,
    end: markers[containing + 1]?.start ?? content.length,
  };
  let turnStart = containing;
  while (turnStart > 0 && markers[turnStart]!.role !== "user") turnStart -= 1;
  if (markers[turnStart]!.role !== "user") turnStart = containing;
  const nextUser = markers.findIndex(
    (marker, index) => index > turnStart && marker.role === "user",
  );
  return {
    message,
    turn: {
      start: markers[turnStart]!.start,
      end: nextUser < 0 ? content.length : markers[nextUser]!.start,
    },
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function pathComponent(value: string | undefined, fallback: string, privateId = false): string {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (privateId || normalized.includes("@") || /^\+?\d{6,}$/u.test(normalized)) {
    return `id-${hash(normalized)}`;
  }
  const safe = normalized.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return safe && safe !== "." && safe !== ".." ? safe.slice(0, 80) : `id-${hash(normalized)}`;
}

export function sessionDocumentPath(metadata: SessionMetadata): string {
  const provider = pathComponent(metadata.provider?.toLowerCase(), "unknown");
  const privateConversation = provider === "imessage";
  const account = pathComponent(metadata.accountId, "default", privateConversation);
  const conversation = pathComponent(metadata.conversationId, `session-${hash(metadata.sessionId)}`, privateConversation);
  const started = new Date(metadata.startedAt).toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/u, "Z");
  const sessionId = pathComponent(metadata.sessionId, hash(metadata.sessionId));
  return `${provider}/${metadata.chatType}/${account}/${conversation}/${started}--${sessionId}.md`;
}

export function resolveTimezone(configured?: string): string {
  if (configured) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: configured }).format();
      return configured;
    } catch {
      // OpenClaw normally validates this; use the host timezone for stale config.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
