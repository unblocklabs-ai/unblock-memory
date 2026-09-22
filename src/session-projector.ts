import { createHash } from "node:crypto";
import type { ChatType } from "./config.js";
import { projectLoggieMessage } from "./loggie-projection.js";
import { applyProposal, parseAttachments, parseInternalMessage } from "./session-noise.js";

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
  /** Optional counters for this projection pass; never contains source text. */
  diagnostics?: { internalMessagesCleaned: number; attachmentsCleaned: number; attachmentBudgetSkipped: number };
};

type ProjectedMessage = {
  role: "user" | "assistant";
  speaker: string;
  text: string;
  timestamp: number;
  meeting?: ReturnType<typeof projectLoggieMessage>;
};

export type SessionSnippetMessage = {
  type?: "user" | "assistant";
  name?: string;
  timestamp?: string;
  body: string;
  partial?: true;
};

/** Character offsets in the exact indexed projection; end excludes message separators. */
export type SessionMessageSpan = {
  type: "user" | "assistant";
  name: string;
  timestamp: string;
  start: number;
  bodyStart: number;
  end: number;
};

export type SessionContextSpans = {
  message: { start: number; end: number; timestamp: string };
  turn: { start: number; end: number };
};

const MESSAGE_HEADING =
  /^## (User|Assistant) — (.+) — (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S.*)$/u;

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
  if (role === "assistant" && text === "NO_REPLY") return undefined;
  if (role === "user" && (
    text === "[OpenClaw heartbeat poll]" ||
    text === "[Queued messages while agent was busy]" ||
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
  if (role === "user" && input.provider?.toLowerCase() !== "loggie") {
    const provenance = record(message.provenance);
    const trusted = provenance?.kind === "inter_session" &&
      (provenance.sourceTool === "subagent_announce" || provenance.sourceTool === "agent_harness_task");
    const internal = parseInternalMessage(text, trusted);
    const proposal = internal.edits.length ? internal : parseAttachments(text);
    if (input.diagnostics) {
      if (internal.edits.length) input.diagnostics.internalMessagesCleaned++;
      input.diagnostics.attachmentsCleaned += proposal.edits.filter(edit => edit.reason === "attachment-envelope-prefix").length;
      if (proposal.budgetSkipped) input.diagnostics.attachmentBudgetSkipped++;
    }
    text = applyProposal(text, proposal);
  }
  const meeting = role === "user" && input.provider?.toLowerCase() === "loggie"
    ? projectLoggieMessage(text, input.accountId) : undefined;
  return {
    role,
    speaker: speaker.replace(/[\r\n]+/gu, " "),
    text: meeting?.text ?? text,
    meeting,
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
  return projectSessionDocument(input)?.content;
}

export function projectSessionDocument(input: SessionProjectionInput): {
  content: string;
  messages: SessionMessageSpan[];
} | undefined {
  const messages = input.events.flatMap((event) => {
    const projected = projectMessage(event, input);
    return projected ? [projected] : [];
  });
  if (messages.length === 0) return undefined;

  // Retry copies disappear only in the derived index. Source history is untouched.
  const latest = new Map<string, ProjectedMessage>();
  const hidden = new Set<ProjectedMessage>();
  for (const message of messages) {
    const meeting = message.meeting;
    if (!meeting?.key) continue;
    const previous = latest.get(meeting.key);
    if (previous?.meeting && previous.meeting.hash === meeting.hash &&
      (meeting.complete || previous.meeting.complete || previous.text === message.text)) {
      if (meeting.complete && !previous.meeting.complete) { hidden.add(previous); latest.set(meeting.key, message); }
      else hidden.add(message);
    } else if (previous?.meeting?.complete && meeting.complete &&
      previous.meeting.sequence !== undefined && meeting.sequence !== undefined) {
      // Keep historical revisions alongside their assistant follow-ups, but label
      // supersession explicitly rather than silently presenting both as current.
      if (meeting.sequence > previous.meeting.sequence) {
        previous.text = `Transcript revision ${previous.meeting.sequence} (superseded by revision ${meeting.sequence}).\n\n${previous.text}`;
        latest.set(meeting.key, message);
      } else if (meeting.sequence < previous.meeting.sequence) {
        message.text = `Transcript revision ${meeting.sequence} (superseded by revision ${previous.meeting.sequence}).\n\n${message.text}`;
      }
    } else if (!previous || (!previous.meeting?.complete && meeting.complete)) latest.set(meeting.key, message);
  }
  let content = "# Transcript\n\n";
  const spans: SessionMessageSpan[] = [];
  for (const message of messages.filter(message => !hidden.has(message))) {
    if (spans.length) content += "\n\n";
    const start = content.length;
    const timestamp = formatTimestamp(message.timestamp, input.timezone);
    content += `## ${message.role === "user" ? "User" : "Assistant"} — ${message.speaker} — ${timestamp}\n\n`;
    const bodyStart = content.length;
    content += message.text;
    spans.push({ type: message.role, name: message.speaker, timestamp, start, bodyStart, end: content.length });
  }
  return { content: `${content}\n`, messages: spans };
}

/** Legacy fallback only. New projections retain exact boundaries before rendering Markdown. */
export function parseSessionMessageSpans(content: string): SessionMessageSpan[] {
  const messages: SessionMessageSpan[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of content.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const text = line[0].replace(/\n$/u, "");
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
    if (fence) {
      if (delimiter?.[1]?.[0] === fence.char && delimiter[1].length >= fence.length && !delimiter[2]?.trim()) fence = undefined;
      continue;
    }
    if (delimiter) {
      fence = { char: delimiter[1]![0]!, length: delimiter[1]!.length };
      continue;
    }
    const match = MESSAGE_HEADING.exec(text);
    // Only the projector's complete heading + blank-line form is recognized.
    if (!match || !content.startsWith("\n\n", line.index + text.length)) continue;
    const previous = messages.at(-1);
    if (previous) previous.end = content.startsWith("\n\n", line.index - 2) ? line.index - 2 : line.index;
    messages.push({ type: match[1] === "User" ? "user" : "assistant", name: match[2]!, timestamp: match[3]!,
      start: line.index, bodyStart: line.index + text.length + 2,
      end: content.endsWith("\n") ? content.length - 1 : content.length });
  }
  return messages;
}

export function sessionContextSpans(
  content: string,
  position: number,
  markers = parseSessionMessageSpans(content),
): SessionContextSpans | undefined {
  const containing = markers.findLastIndex((marker) => marker.start <= position);
  if (containing < 0) return undefined;

  const message = {
    start: markers[containing]!.start,
    end: markers[containing + 1]?.start ?? content.length,
    timestamp: markers[containing]!.timestamp,
  };
  let turnStart = containing;
  while (turnStart > 0 && markers[turnStart]!.type !== "user") turnStart -= 1;
  if (markers[turnStart]!.type !== "user") turnStart = containing;
  const nextUser = markers.findIndex(
    (marker, index) => index > turnStart && marker.type === "user",
  );
  return {
    message,
    turn: {
      start: markers[turnStart]!.start,
      end: nextUser < 0 ? content.length : markers[nextUser]!.start,
    },
  };
}

export function sessionSnippetMessages(
  content: string,
  selected: { text: string; position: number; sourceText?: string },
  spans: readonly SessionMessageSpan[],
  identity?: { agentId: string; agentName: string },
): SessionSnippetMessage[] {
  const sourceText = selected.sourceText ?? selected.text;
  const end = selected.position + sourceText.length;
  // Added meeting speaker/revision context is evidence too; retain it in the first body.
  const prefix = selected.text.endsWith(sourceText) ? selected.text.slice(0, selected.text.length - sourceText.length) : "";
  const messages: SessionSnippetMessage[] = [];
  let cursor = selected.position;
  const keepUnattributed = (from: number, to: number) => {
    const body = content.slice(from, to);
    if (body.trim() && !(from === 0 && body === "# Transcript\n\n")) messages.push({ body, partial: true });
  };
  for (const span of spans) {
    if (span.start >= end || span.end <= selected.position) continue;
    if (span.start > cursor) keepUnattributed(cursor, span.start);
    const from = Math.max(span.bodyStart, selected.position);
    const to = Math.min(span.end, end);
    messages.push({ type: span.type,
      name: span.type === "assistant" && span.name === identity?.agentId ? identity.agentName : span.name,
      timestamp: span.timestamp, body: content.slice(from, Math.max(from, to)),
      ...(from > span.bodyStart || to < span.end ? { partial: true as const } : {}),
    });
    cursor = Math.min(span.end, end);
  }
  if (cursor < end) keepUnattributed(cursor, end);
  if (!messages.length) return [{ body: selected.text, partial: true }];
  messages[0]!.body = prefix + messages[0]!.body;
  return messages;
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
