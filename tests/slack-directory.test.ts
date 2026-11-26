import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { DEFAULTS } from "../src/defaults.js";
import { primePersonDossier } from "../src/people-primer.js";
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
                id: "U123",
                name: "bek",
                profile: {
                  display_name: " Bek ",
                  image_192: "https://example.test/bek.png?name=A%2BB",
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
      avatarUrl: "https://example.test/bek.png?name=A%2BB",
      isBot: undefined,
      isDeactivated: undefined,
    },
  ]);
  assert.deepEqual(inspected, [{ accountId: "workspace", cfg: runtimeConfig }]);
  assert.equal(requests[0]?.url.href, "https://slack.com/api/users.list?limit=25");
  assert.equal(requests[0]?.authorization, "Bearer resolved-token");
});

test("rejects invalid preferred Slack credentials without falling back or exposing the token", async () => {
  for (const userToken of ["", 123, " padded-token ", "u".repeat(DEFAULTS.people.slackTokenMaxChars + 1)]) {
    let requests = 0;
    const reader = createOpenClawSlackDirectory({
      getConfig: () => ({}),
      inspectAccount: async () => ({ userToken, botToken: "fallback-bot-token" }),
      request: async () => {
        requests++;
        return { ok: true, status: 200, json: async () => ({ ok: true, members: [] }) };
      },
    });
    await assert.rejects(reader.listUsers({ accountId: "default", limit: 1 }), {
      message: "Slack directory account has an invalid userToken",
    });
    assert.equal(requests, 0);
  }
});

test("does not echo a Slack credential from a failed request or response", async () => {
  const userToken = "synthetic-user-secret";
  for (const request of [
    async () => { throw new Error(userToken); },
    async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: userToken }) }),
  ]) {
    const reader = createOpenClawSlackDirectory({
      getConfig: () => ({}),
      inspectAccount: async () => ({ userToken }),
      request,
    });
    await assert.rejects(reader.listUsers({ accountId: "default", limit: 1 }), (error: Error) =>
      /Slack directory request failed/.test(error.message) && !error.message.includes(userToken));
  }
});

test("skips invalid Slack member IDs and omits invalid metadata; only display names are cropped", async t => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-slack-values-"));
  const store = new PeopleStore(join(root, "people.sqlite"), { maxOpenTodos: 10, maxBlurbChars: 1200 });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const validId = "U".repeat(DEFAULTS.people.slackIdMaxChars);
  const validName = "a".repeat(DEFAULTS.people.slackDisplayNameMaxChars - 1);
  const reader = createOpenClawSlackDirectory({
    getConfig: () => ({}),
    inspectAccount: async () => ({ botToken: "resolved-bot-token" }),
    request: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          members: [
            { id: " U-padded " },
            { id: validId + "X", profile: { display_name: "Must not overwrite" } },
            {
              id: validId,
              name: "a".repeat(DEFAULTS.people.slackHandleMaxChars + 1),
              profile: {
                display_name: ` ${validName}🦉suffix `,
                image_512: "https://example.test/" + "a".repeat(DEFAULTS.people.slackAvatarUrlMaxChars),
                image_192: "not-a-url",
              },
            },
          ],
        };
      },
    }),
  });
  assert.equal((await syncSlackDirectory({ store, reader, accountId: "default", limit: 10 })).created, 1);
  assert.equal(store.findIdentity("slack", "default", "U-padded"), undefined);
  const saved = store.findIdentity("slack", "default", validId);
  assert.equal(saved?.displayName, validName);
  assert.equal(saved?.handle, null);
  assert.equal(saved?.avatarUrl, null);
});

test("Slack sync refuses malformed, oversized, and repeated cursors before writing any page", async t => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-slack-cursors-"));
  const store = new PeopleStore(join(root, "people.sqlite"), { maxOpenTodos: 10, maxBlurbChars: 1200 });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const validCursor = "a+b/c==";
  for (const [cursor, error] of [
    [123, /invalid cursor/],
    [" ", /invalid cursor/],
    ["a".repeat(DEFAULTS.people.slackCursorMaxChars + 1), /invalid cursor/],
    [validCursor, /repeated cursor/],
  ] as const) {
    const requests: URL[] = [];
    const reader = createOpenClawSlackDirectory({
      getConfig: () => ({}),
      inspectAccount: async () => ({ userToken: "resolved-user-token" }),
      request: async (input) => {
        requests.push(new URL(input));
        const firstPage = requests.length === 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            members: [{ id: firstPage ? "U1" : "U2" }],
            response_metadata: { next_cursor: firstPage ? validCursor : cursor },
          }),
        };
      },
    });
    await assert.rejects(syncSlackDirectory({ store, reader, accountId: "default", limit: 2 }), error);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.searchParams.get("cursor"), validCursor);
    assert.equal(store.findIdentity("slack", "default", "U1"), undefined);
    assert.equal(store.findIdentity("slack", "default", "U2"), undefined);
  }
});

test("directory sync repairs already-enriched ID names and primer searches the human name", async t => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-slack-name-"));
  const path = join(root, "people.sqlite");
  const store = new PeopleStore(path, { maxOpenTodos: 10, maxBlurbChars: 1200 });
  t.after(() => store.close());
  const identity = { provider: "slack", accountScope: "workspace", externalId: "U123" };
  const person = store.upsertIdentity(identity).person;
  // Reproduce an old record whose identity was enriched but canonical name was not.
  const db = new DatabaseSync(path);
  try {
    db.prepare("UPDATE person_identities SET display_name = ? WHERE person_id = ?").run("Mira Example", person.id);
  } finally { db.close(); }
  const reader = { listUsers: async () => [{ id: "U123", name: "Mira Example" }] };
  const result = await syncSlackDirectory({ store, reader, accountId: "workspace", limit: 10 });
  assert.equal(result.updated, 1);
  assert.equal(result.unchanged, 0);
  assert.equal(store.getPerson(person.id)?.displayName, "Mira Example");
  const queries: string[] = [];
  const config = resolveConfig({ people: { enabled: true }, peoplePrimer: { enabled: true, corpora: ["memory"] } });
  await primePersonDossier({ store, personId: person.id, agentName: "Bill", config: config.peoplePrimer,
    apiKey: "unused", signal: new AbortController().signal,
    search: async query => { queries.push(query); return []; },
  });
  assert.equal(queries.length, 5);
  assert.ok(queries.every(query => query.includes("Mira Example") && !query.includes("U123")));
  assert.equal((await syncSlackDirectory({ store, reader, accountId: "workspace", limit: 10 })).unchanged, 1);
});

test("preserves Slack flags through ingestion and excludes bots and deactivated people from primer", async t => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-slack-flags-"));
  const store = new PeopleStore(join(root, "people.sqlite"), { maxOpenTodos: 10, maxBlurbChars: 1200 });
  t.after(() => store.close());
  let members: Record<string, unknown>[] = [
    { id: "bot", is_bot: true, deleted: false },
    { id: "gone", is_bot: false, deleted: true },
    { id: "human", is_bot: false, deleted: false },
    { id: "unknown" },
  ];
  const reader = createOpenClawSlackDirectory({
    getConfig: () => ({}),
    inspectAccount: async () => ({ botToken: "test-token" }),
    request: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, members }) }),
  });
  const sync = () => syncSlackDirectory({ store, reader, accountId: "workspace", limit: 10 });
  assert.equal((await sync()).created, 4);
  const config = resolveConfig({ people: { enabled: true }, peoplePrimer: { enabled: true, corpora: ["memory"] } });
  for (const [id, isBot, isDeactivated] of [
    ["bot", true, false], ["gone", false, true], ["human", false, false], ["unknown", null, false],
  ] as const) {
    const identity = store.findIdentity("slack", "workspace", id)!;
    assert.equal(identity.isBot, isBot);
    assert.equal(identity.isDeactivated, isDeactivated);
    let searches = 0;
    const result = await primePersonDossier({ store, personId: identity.personId, agentName: "Bill",
      config: config.peoplePrimer, apiKey: "fake-key", signal: new AbortController().signal,
      search: async () => { searches++; return []; },
    });
    assert.equal(searches, id === "bot" || id === "gone" ? 0 : 5);
    assert.equal(result.status, id === "gone" ? "not_found" : id === "bot" ? "unavailable" : "ok");
  }
  members = [{ id: "bot" }];
  assert.equal((await sync()).unchanged, 1);
  assert.equal(store.findIdentity("slack", "workspace", "bot")?.isBot, true, "missing does not clear a known flag");
  members = [{ id: "bot", is_bot: false, deleted: false }];
  assert.equal((await sync()).updated, 1, "flag-only changes count as updates");
  assert.equal(store.findIdentity("slack", "workspace", "bot")?.isBot, false);
  members = [{ id: "gone", is_bot: false, deleted: false }];
  assert.equal((await sync()).skipped, 1, "directory sync must not restore an unavailable person");
  assert.equal(store.findIdentity("slack", "workspace", "gone")?.isDeactivated, true);
});

test("Slack deactivation preserves the existing person-wide policy for linked identities", async t => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-slack-linked-"));
  const path = join(root, "people.sqlite");
  const store = new PeopleStore(path, { maxOpenTodos: 10, maxBlurbChars: 1200 });
  t.after(() => store.close());
  const slack = store.upsertIdentity({ provider: "slack", accountScope: "workspace", externalId: "U1" });
  const linked = store.upsertIdentity({ provider: "email", accountScope: "work", externalId: "user@example.test" });
  // Seed a linked identity without adding a new identity-management API.
  const db = new DatabaseSync(path);
  db.prepare("UPDATE person_identities SET person_id = ? WHERE person_id = ?").run(slack.person.id, linked.person.id);
  db.close();
  const result = await syncSlackDirectory({ store, accountId: "workspace", limit: 10,
    reader: { listUsers: async () => [{ id: "U1", isDeactivated: true }] },
  });
  assert.equal(result.updated, 1);
  assert.equal(store.listIdentities(slack.person.id).length, 2);
  assert.equal(store.getPerson(slack.person.id)?.status, "unavailable");
  assert.equal(store.getPerson(slack.person.id)?.injectionEnabled, false);
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
          return [{ id: "U123", name: "Changed Name", handle: "changed", isBot: false, isDeactivated: false }];
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
