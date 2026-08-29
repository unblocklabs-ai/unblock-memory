import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PeopleStore } from "../src/people-store.js";
import { createOpenClawSlackDirectory, syncSlackDirectory } from "../src/slack-directory.js";

test("reads Slack users in-process from the active resolved account", async () => {
  const runtimeConfig = { channels: { slack: {} } };
  const inspected: Array<{ accountId: string; cfg: unknown }> = [];
  const requests: Array<{ url: URL; authorization: string }> = [];
  const reader = createOpenClawSlackDirectory({
    getConfig: () => runtimeConfig,
    inspectAccount: async ({ accountId, cfg }) => {
      inspected.push({ accountId, cfg });
      return { identity: "bot", botToken: "resolved-token" };
    },
    request: async (input, init) => {
      assert.equal(init.signal.aborted, false);
      requests.push({ url: new URL(input), authorization: init.headers.authorization });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            members: [
              {
                id: " U123 ",
                name: " bek ",
                profile: {
                  display_name: " Bek ",
                  image_192: " https://example.test/bek.png ",
                  title: "not persisted",
                },
              },
            ],
          };
        },
      };
    },
  });

  assert.deepEqual(await reader.listUsers({ accountId: "workspace", limit: 25 }), [
    {
      id: "U123",
      name: "Bek",
      handle: "bek",
      avatarUrl: "https://example.test/bek.png",
    },
  ]);
  assert.deepEqual(inspected, [{ accountId: "workspace", cfg: runtimeConfig }]);
  assert.equal(requests[0]?.url.href, "https://slack.com/api/users.list?limit=25");
  assert.equal(requests[0]?.authorization, "Bearer resolved-token");
});

test("paginates Slack users and rejects repeated cursors", async () => {
  let calls = 0;
  const reader = createOpenClawSlackDirectory({
    getConfig: () => ({}),
    inspectAccount: async () => ({ identity: "bot", userToken: "resolved-user-token" }),
    request: async () => ({
      ok: true,
      status: 200,
      async json() {
        calls += 1;
        return {
          ok: true,
          members: calls === 1 ? [{ id: "U1", raw_secret: "DO_NOT_COPY" }] : [],
          response_metadata: { next_cursor: "same-cursor" },
        };
      },
    }),
  });

  await assert.rejects(reader.listUsers({ accountId: "default", limit: 2 }), /repeated cursor/);
  assert.equal(calls, 2);
});

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
