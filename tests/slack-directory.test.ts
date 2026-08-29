import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PeopleStore } from "../src/people-store.js";
import { syncSlackDirectory } from "../src/slack-directory.js";

test("skips changed directory metadata for an unavailable person without mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-slack-directory-"));
  const store = new PeopleStore(join(root, "people.sqlite"), {
    maxOpenTodos: 10,
    maxBlurbChars: 1200,
  });
  try {
    const created = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U123",
      displayName: "Original Name",
      handle: "original",
    });
    store.softDeletePerson(created.person.id);

    const result = await syncSlackDirectory({
      store,
      accountId: "workspace",
      limit: 10,
      syncedAt: "2026-08-28T12:00:00.000Z",
      reader: {
        async listUsers() {
          return [{ id: "U123", name: "Changed Name", handle: "changed" }];
        },
      },
    });

    assert.deepEqual(
      {
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        skipped: result.skipped,
        failed: result.failed,
      },
      { created: 0, updated: 0, unchanged: 0, skipped: 1, failed: 0 },
    );
    const identity = store.findIdentity("slack", "workspace", "U123");
    assert.equal(identity?.displayName, "Original Name");
    assert.equal(identity?.handle, "original");
    assert.equal(store.getPerson(created.person.id)?.status, "unavailable");
  } finally {
    store.close();
  }
});
