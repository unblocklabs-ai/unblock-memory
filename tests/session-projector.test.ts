import assert from "node:assert/strict";
import test from "node:test";
import {
  projectSession,
  sessionContextSpans,
  sessionDocumentPath,
} from "../src/session-projector.js";

test("projects timestamped user and assistant text while excluding internal blocks", () => {
  const projected = projectSession({
    sessionId: "session-1",
    provider: "slack",
    chatType: "channel",
    accountId: "workspace-1",
    conversationId: "C123",
    label: "project-memory",
    startedAt: Date.parse("2026-08-25T14:00:00Z"),
    agentName: "Bill",
    timezone: "UTC",
    events: [
      {
        createdAt: Date.parse("2026-08-25T14:32:09Z"),
        eventJson: JSON.stringify({
          type: "message",
          timestamp: "2026-08-25T14:32:09Z",
          message: {
            role: "user",
            content: "From: Bek (U123)\nCan you review **memory**?",
            timestamp: 1,
            __openclaw: { senderName: "Bek" },
          },
        }),
      },
      {
        createdAt: Date.parse("2026-08-25T14:33:02Z"),
        eventJson: JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private" },
              { type: "toolCall", name: "read" },
              { type: "text", text: "Yes.\n\nIt uses vector search." },
            ],
          },
        }),
      },
      {
        createdAt: Date.parse("2026-08-25T14:33:03Z"),
        eventJson: JSON.stringify({
          type: "message",
          message: { role: "toolResult", content: "secret tool output" },
        }),
      },
      {
        createdAt: Date.parse("2026-08-25T14:33:04Z"),
        eventJson: JSON.stringify({
          type: "message",
          message: { role: "user", content: "[OpenClaw heartbeat poll]" },
        }),
      },
      {
        createdAt: Date.parse("2026-08-25T14:33:05Z"),
        eventJson: JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }] },
        }),
      },
    ],
  });

  assert.match(projected!, /## User — Bek — 2026-08-25 14:32:09 UTC\n\nCan you review \*\*memory\*\*\?/);
  assert.match(projected!, /## Assistant — Bill — 2026-08-25 14:33:02 UTC\n\nYes\.\n\nIt uses vector search\./);
  assert.doesNotMatch(projected!, /private|secret tool output|toolCall|heartbeat poll|HEARTBEAT_OK/);
  assert.match(projected!, /^# Transcript\n\n/);
  assert.doesNotMatch(projected!, /# Session|Session ID:|Provider:|Chat type:|Conversation:|Started:/);
});

test("finds the complete message and user-assistant turn around a projected position", () => {
  const projected = [
    "# Transcript\n\n",
    "## User — Rico — 2026-08-25 14:32:09 UTC\n\nPlease review memory.\n\n## Assistant — quoted format\n\n",
    "## Assistant — Bill — 2026-08-25 14:33:02 UTC\n\nI will inspect it.\n\n",
    "## Assistant — Bill — 2026-08-25 14:34:02 UTC\n\nThe index is healthy.\n\n",
    "## User — Bek — 2026-08-25 14:35:02 UTC\n\nThanks.\n",
  ].join("");
  const position = projected.indexOf("index is healthy");
  const spans = sessionContextSpans(projected, position);

  assert.equal(projected.slice(spans?.message.start, spans?.message.end).trim(), [
    "## Assistant — Bill — 2026-08-25 14:34:02 UTC",
    "",
    "The index is healthy.",
  ].join("\n"));
  assert.equal(projected.slice(spans?.turn.start, spans?.turn.end).trim(), [
    "## User — Rico — 2026-08-25 14:32:09 UTC",
    "",
    "Please review memory.",
    "",
    "## Assistant — quoted format",
    "",
    "## Assistant — Bill — 2026-08-25 14:33:02 UTC",
    "",
    "I will inspect it.",
    "",
    "## Assistant — Bill — 2026-08-25 14:34:02 UTC",
    "",
    "The index is healthy.",
  ].join("\n"));
});

test("returns no document for internal-only sessions and rejects malformed messages", () => {
  const base = {
    sessionId: "session-1",
    chatType: "group" as const,
    startedAt: 1,
    agentName: "Agent",
    timezone: "UTC",
  };
  assert.equal(projectSession({
    ...base,
    events: [{ createdAt: 1, eventJson: JSON.stringify({
      type: "message", message: { role: "assistant", content: [{ type: "toolCall" }] },
    }) }],
  }), undefined);
  assert.throws(() => projectSession({
    ...base,
    events: [{ createdAt: 1, eventJson: "{broken" }],
  }), /invalid transcript event JSON/);
  assert.throws(() => projectSession({
    ...base,
    events: [{ createdAt: 1, eventJson: JSON.stringify({ type: "message" }) }],
  }), /invalid transcript message event/);
});

test("creates provider-first safe paths and hashes private iMessage identities", () => {
  assert.equal(sessionDocumentPath({
    sessionId: "session-1",
    provider: "slack",
    chatType: "channel",
    accountId: "workspace-1",
    conversationId: "C123",
    startedAt: Date.parse("2026-08-25T14:00:00Z"),
  }), "slack/channel/workspace-1/C123/2026-08-25T14-00-00Z--session-1.md");
  const privatePath = sessionDocumentPath({
    sessionId: "session-2",
    provider: "imessage",
    chatType: "group",
    accountId: "+15551234567",
    conversationId: "family@example.com",
    startedAt: 1,
  });
  assert.doesNotMatch(privatePath, /15551234567|family@example/);
  assert.match(privatePath, /^imessage\/group\/id-/);
  assert.doesNotMatch(sessionDocumentPath({
    sessionId: "session-3",
    provider: "..",
    chatType: "channel",
    accountId: ".",
    conversationId: "..",
    startedAt: 1,
  }), /(^|\/)\.\.?\//);
});
