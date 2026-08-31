import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readPersonSessionEvidence } from "../src/people-evidence.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

test("uses the conversation channel when the session window channel is null", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-people-evidence-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const db = createAgentDatabase(databasePath, "bill");
  try {
    insertSession(db, {
      sessionId: "conversation-channel",
      chatType: "direct",
      message: {
        type: "message",
        timestamp: "2026-08-28T13:00:00Z",
        message: {
          role: "user",
          content: "CONVERSATION_CHANNEL",
          __openclaw: { senderId: "U123" },
        },
      },
    });
    db.prepare("UPDATE session_windows SET channel = NULL WHERE session_id = ?")
      .run("conversation-channel");
  } finally {
    db.close();
  }

  assert.deepEqual(
    readPersonSessionEvidence({
      databasePath,
      agentId: "bill",
      accountScope: "workspace",
      externalId: "U123",
      limit: 10,
    }).map((entry) => entry.text),
    ["CONVERSATION_CHANNEL"],
  );
});

test("attributes direct-message evidence only with explicit sender metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-people-evidence-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const db = createAgentDatabase(databasePath, "bill");
  try {
    insertSession(db, {
      sessionId: "peer-only",
      chatType: "direct",
      message: {
        type: "message",
        timestamp: "2026-08-28T12:00:00Z",
        message: { role: "user", content: "PEER_ONLY" },
      },
    });
    insertSession(db, {
      sessionId: "explicit-sender",
      chatType: "direct",
      message: {
        type: "message",
        timestamp: "2026-08-28T13:00:00Z",
        message: {
          role: "user",
          content: "EXPLICIT_SENDER",
          __openclaw: { senderId: "U123" },
        },
      },
    });
    db.prepare("UPDATE conversations SET native_direct_user_id = 'U123', peer_id = 'U123'").run();
  } finally {
    db.close();
  }

  assert.deepEqual(
    readPersonSessionEvidence({
      databasePath,
      agentId: "bill",
      accountScope: "workspace",
      externalId: "U123",
      limit: 10,
    }).map((entry) => entry.text),
    ["EXPLICIT_SENDER"],
  );
});

test("returns bounded conversation turns around each exact-attributed message", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-people-evidence-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const db = createAgentDatabase(databasePath, "bill");
  try {
    insertSession(db, {
      sessionId: "interaction",
      chatType: "channel",
      message: {
        type: "message",
        timestamp: "2026-08-28T13:00:00Z",
        message: {
          role: "user",
          content: "Please make it lean.",
          __openclaw: { senderId: "U123" },
        },
      },
    });
    db.prepare("INSERT INTO transcript_events VALUES (?, 2, ?, 4000)").run(
      "interaction",
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-28T13:00:01Z",
        message: { role: "assistant", content: "I will remove the extra layer." },
      }),
    );
    db.prepare("INSERT INTO session_transcript_active_events VALUES (?, 1, 2, 1)").run(
      "interaction",
    );
  } finally {
    db.close();
  }

  const [evidence] = readPersonSessionEvidence({
    databasePath,
    agentId: "bill",
    accountScope: "workspace",
    externalId: "U123",
  });
  assert.deepEqual(evidence?.context, [
    {
      locator: "session:interaction:event:1",
      role: "user",
      text: "Please make it lean.",
      senderId: "U123",
    },
    {
      locator: "session:interaction:event:2",
      role: "assistant",
      text: "I will remove the extra layer.",
    },
  ]);
});

test("scans past processed recent messages to return bounded older evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-people-evidence-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const db = createAgentDatabase(databasePath, "bill");
  try {
    for (const [sessionId, timestamp, content] of [
      ["older", "2026-08-28T12:00:00Z", "OLDER"],
      ["newer", "2026-08-28T13:00:00Z", "NEWER"],
    ] as const) {
      insertSession(db, {
        sessionId,
        chatType: "channel",
        message: {
          type: "message",
          timestamp,
          message: { role: "user", content, __openclaw: { senderId: "U123" } },
        },
      });
    }
    db.prepare("UPDATE transcript_events SET created_at = 4000 WHERE session_id = 'newer'").run();
  } finally {
    db.close();
  }

  assert.deepEqual(
    readPersonSessionEvidence({
      databasePath,
      agentId: "bill",
      accountScope: "workspace",
      externalId: "U123",
      limit: 1,
      excludeLocators: new Set(["session:newer:event:1"]),
    }).map((entry) => entry.locator),
    ["session:older:event:1"],
  );
});
