import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nextPeopleRefinement } from "../src/people-refinement.js";
import { PeopleStore } from "../src/people-store.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

test("returns one person's unseen exact-attributed evidence and advances only on commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-people-refinement-test-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const db = createAgentDatabase(databasePath, "bill");
  insertSession(db, {
    sessionId: "matching",
    chatType: "channel",
    message: {
      type: "message",
      timestamp: "2026-08-28T12:00:00Z",
      message: {
        role: "user",
        content: "Keep this concise.",
        __openclaw: { senderId: "U123" },
      },
    },
  });
  db.close();

  const store = new PeopleStore(join(root, "people.sqlite"), {
    maxOpenTodos: 10,
    maxBlurbChars: 1200,
  });
  try {
    const person = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U123",
      displayName: "Bek",
    }).person;

    const first = nextPeopleRefinement({ store, agentId: "bill", agentDatabasePath: databasePath });
    assert.equal(first?.person.id, person.id);
    assert.deepEqual(first?.evidence.map((entry) => entry.locator), [
      "session:matching:event:1",
    ]);
    assert.equal(
      nextPeopleRefinement({ store, agentId: "bill", agentDatabasePath: databasePath })?.person.id,
      person.id,
    );

    store.replaceDossier(person.id, undefined, ["session:matching:event:1"]);
    assert.equal(
      nextPeopleRefinement({ store, agentId: "bill", agentDatabasePath: databasePath }),
      undefined,
    );
  } finally {
    store.close();
  }
});

test("scans past active people without attributed Slack evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-people-refinement-test-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const db = createAgentDatabase(databasePath, "bill");
  insertSession(db, {
    sessionId: "second-person",
    chatType: "channel",
    message: {
      type: "message",
      timestamp: "2026-08-28T12:00:00Z",
      message: { role: "user", content: "Grounded", __openclaw: { senderId: "U456" } },
    },
  });
  db.close();

  const store = new PeopleStore(join(root, "people.sqlite"), {
    maxOpenTodos: 10,
    maxBlurbChars: 1200,
  });
  try {
    store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U123",
      seenAt: "2026-08-28T15:00:00Z",
    });
    const second = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U456",
      seenAt: "2026-08-28T14:00:00Z",
    }).person;

    assert.equal(
      nextPeopleRefinement({ store, agentId: "bill", agentDatabasePath: databasePath })?.person.id,
      second.id,
    );
  } finally {
    store.close();
  }
});
