import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readPersonSessionEvidence } from "../src/people-evidence.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

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
