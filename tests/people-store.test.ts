import assert from "node:assert/strict";
import { access, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PeopleStore, PeopleStores } from "../src/people-store.js";

const options = { maxOpenTodos: 2, maxBlurbChars: 1200 };

async function temporaryPath(name = "people.sqlite"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-people-"));
  return join(root, name);
}

test("creates only the five version-1 tables with secure SQLite settings", async () => {
  const path = await temporaryPath();
  const store = new PeopleStore(path, options);
  store.close();

  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const db = new DatabaseSync(path);
  try {
    const tables = db
      .prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
      .all()
      .map((row) => (row as { name: string }).name);
    assert.deepEqual(tables, [
      "companies",
      "people",
      "people_todos",
      "person_dossiers",
      "person_identities",
    ]);
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      1,
    );
    assert.equal(
      (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      "wal",
    );
  } finally {
    db.close();
  }

  const reopened = new PeopleStore(path, options);
  reopened.close();
});

test("opens one store lazily per agent and preserves it across reopen", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-people-owner-"));
  const path = join(stateRoot, "agents", "bill", "unblock-memory", "people.sqlite");
  const stores = new PeopleStores({ stateRoot, ...options });
  await assert.rejects(access(path));

  const first = stores.get("bill");
  assert.equal(stores.get("bill"), first);
  assert.equal(
    first.upsertIdentity({
      provider: "slack",
      accountScope: "default",
      externalId: "U123",
      displayName: "Bek",
    }).created,
    true,
  );
  await access(path);
  stores.closeAll();

  const reopened = new PeopleStores({ stateRoot, ...options });
  assert.equal(
    reopened.get("bill").findPersonByIdentity("slack", "default", "U123")?.displayName,
    "Bek",
  );
  reopened.closeAll();
});

test("rejects agent ids that could escape the state root", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-people-owner-"));
  const stores = new PeopleStores({ stateRoot, ...options });
  try {
    assert.throws(() => stores.get("../../outside"), /invalid agent id/);
  } finally {
    stores.closeAll();
  }
});

test("deduplicates exact identities and defaults both policies off", async () => {
  const store = new PeopleStore(await temporaryPath(), options);
  try {
    const first = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
      displayName: "First Name",
    });
    const second = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
      displayName: "Current Slack Name",
    });
    const otherAccount = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-b",
      externalId: "U123",
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.person.id, first.person.id);
    assert.equal(second.identity.displayName, "Current Slack Name");
    assert.equal(second.person.displayName, "First Name");
    assert.equal(second.person.refinementEnabled, false);
    assert.equal(second.person.injectionEnabled, false);
    assert.notEqual(otherAccount.person.id, first.person.id);
  } finally {
    store.close();
  }
});

test("directory sync leaves needs-enrichment todos open until explicitly resolved", async () => {
  const store = new PeopleStore(await temporaryPath(), options);
  try {
    store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    });
    store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
      displayName: "Directory Name",
      syncedAt: "2026-08-28T12:00:00.000Z",
    });

    const key = "needs-enrichment:slack:workspace-a:U123";
    assert.equal(store.listTodos().find((todo) => todo.deduplicationKey === key)?.status, "open");
    assert.equal(store.resolveTodoByKey(key)?.status, "resolved");
  } finally {
    store.close();
  }
});

test("does not update identities after a person becomes unavailable", async () => {
  const store = new PeopleStore(await temporaryPath(), options);
  try {
    const first = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
      displayName: "Original Name",
      seenAt: "2026-08-28T12:00:00.000Z",
    });
    store.softDeletePerson(first.person.id);

    const repeated = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
      displayName: "Changed Name",
      seenAt: "2026-08-29T12:00:00.000Z",
    });

    assert.equal(repeated.person.status, "unavailable");
    assert.equal(repeated.identity.displayName, "Original Name");
    assert.equal(repeated.identity.lastSeenAt, "2026-08-28T12:00:00.000Z");
  } finally {
    store.close();
  }
});

test("deduplicates todos and caps open rows with one overflow counter", async () => {
  const store = new PeopleStore(await temporaryPath(), options);
  try {
    store.upsertTodo({
      deduplicationKey: "missing:a",
      kind: "missing_identity",
      context: { sender: "a" },
    });
    store.upsertTodo({
      deduplicationKey: "missing:a",
      kind: "missing_identity",
      context: { sender: "a" },
    });
    store.upsertTodo({ deduplicationKey: "missing:b", kind: "missing_identity" });
    store.upsertTodo({ deduplicationKey: "missing:c", kind: "missing_identity" });
    store.upsertTodo({ deduplicationKey: "missing:d", kind: "missing_identity" });

    const todos = store.listTodos();
    assert.equal(todos.filter((todo) => todo.status === "open").length, 2);
    assert.equal(todos.find((todo) => todo.deduplicationKey === "missing:a")?.occurrenceCount, 2);
    const overflow = todos.filter((todo) => todo.status === "overflow");
    assert.equal(overflow.length, 1);
    assert.equal(overflow[0]?.occurrenceCount, 2);
  } finally {
    store.close();
  }
});

test("reopens a recurring resolved todo", async () => {
  const store = new PeopleStore(await temporaryPath(), options);
  try {
    store.upsertTodo({ deduplicationKey: "missing:a", kind: "missing_identity" });
    store.resolveTodoByKey("missing:a", "fixed");
    const reopened = store.upsertTodo({ deduplicationKey: "missing:a", kind: "missing_identity" });

    assert.equal(reopened.status, "open");
    assert.equal(reopened.occurrenceCount, 2);
    assert.equal(reopened.resolvedAt, null);
    assert.equal(reopened.resolutionNote, null);
  } finally {
    store.close();
  }
});

test("lists actionable todos before applying the requested limit", async () => {
  const store = new PeopleStore(await temporaryPath(), options);
  try {
    store.upsertTodo({ deduplicationKey: "missing:resolved", kind: "missing_identity" });
    assert.equal(store.resolveTodoByKey("missing:resolved")?.status, "resolved");
    const open = store.upsertTodo({ deduplicationKey: "missing:open", kind: "missing_identity" });

    assert.deepEqual(
      store.listTodos(1).map((todo) => todo.deduplicationKey),
      [open.deduplicationKey],
    );
  } finally {
    store.close();
  }
});

test("aggregates recurring resolved todos to overflow when the open cap is full", async () => {
  const path = await temporaryPath();
  const store = new PeopleStore(path, options);
  try {
    store.upsertTodo({ deduplicationKey: "missing:a", kind: "missing_identity" });
    assert.equal(store.resolveTodoByKey("missing:a")?.status, "resolved");
    store.upsertTodo({ deduplicationKey: "missing:b", kind: "missing_identity" });
    store.upsertTodo({ deduplicationKey: "missing:c", kind: "missing_identity" });

    const overflow = store.upsertTodo({ deduplicationKey: "missing:a", kind: "missing_identity" });
    assert.equal(overflow.status, "overflow");
    assert.equal(overflow.occurrenceCount, 1);
    assert.equal(store.resolveTodoByKey("missing:a"), undefined);

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const resolved = db
        .prepare("SELECT status FROM people_todos WHERE deduplication_key = 'missing:a'")
        .get() as { status: string };
      assert.equal(resolved.status, "resolved");
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
});

test("resolves each actionable todo once and reopens recurring overflow", async () => {
  const store = new PeopleStore(await temporaryPath(), options);
  try {
    store.upsertTodo({ deduplicationKey: "missing:a", kind: "missing_identity" });
    assert.equal(store.resolveTodoByKey("missing:a")?.status, "resolved");
    assert.equal(store.resolveTodoByKey("missing:a"), undefined);

    store.upsertTodo({ deduplicationKey: "missing:b", kind: "missing_identity" });
    store.upsertTodo({ deduplicationKey: "missing:c", kind: "missing_identity" });
    const overflow = store.upsertTodo({ deduplicationKey: "missing:d", kind: "missing_identity" });
    assert.equal(overflow.status, "overflow");
    assert.equal(store.resolveTodoByKey(overflow.deduplicationKey)?.status, "resolved");
    assert.equal(store.resolveTodoByKey(overflow.deduplicationKey), undefined);
    const recurring = store.upsertTodo({ deduplicationKey: "missing:e", kind: "missing_identity" });
    assert.equal(recurring.status, "overflow");
    assert.equal(recurring.occurrenceCount, 2);
  } finally {
    store.close();
  }
});

test("validates and replaces one bounded baseline dossier", async () => {
  const store = new PeopleStore(await temporaryPath(), { ...options, maxBlurbChars: 20 });
  try {
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "default",
      externalId: "U123",
    });
    const dossier = {
      schemaVersion: 1,
      blurb: "Prefers decisions.",
      sections: [
        {
          category: "preferences",
          claims: [
            {
              statement: "Prefers the decision first.",
              evidence: [{ source: "session", locator: "session-1#message-4" }],
              epistemicType: "observed",
              confidence: "high",
            },
          ],
        },
      ],
    };
    assert.deepEqual(store.replaceDossier(person.id, dossier), dossier);
    assert.deepEqual(store.getDossier(person.id)?.dossier, dossier);
    assert.equal(store.getDossierBlurb(person.id), dossier.blurb);

    assert.throws(
      () => store.replaceDossier(person.id, { ...dossier, blurb: "x".repeat(21) }),
      /20 characters/,
    );
    assert.throws(() =>
      store.replaceDossier(person.id, {
        ...dossier,
        sections: [{ ...dossier.sections[0], category: "custom:sales" }],
      }),
    );
    assert.throws(
      () =>
        store.replaceDossier(person.id, {
          ...dossier,
          sections: [dossier.sections[0], dossier.sections[0]],
        }),
      /unique categories/,
    );
  } finally {
    store.close();
  }
});

test("restores an unavailable person without restoring policies or deleting related records", async () => {
  const store = new PeopleStore(await temporaryPath(), options);
  try {
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    });
    store.setPolicies(person.id, { refinementEnabled: true, injectionEnabled: true });
    const company = store.setCompany(person.id, { name: "Unblock Labs" });
    const dossier = {
      schemaVersion: 1,
      blurb: "Prefers concise decisions.",
      sections: [],
    } as const;
    store.replaceDossier(person.id, dossier);
    assert.equal(store.softDeletePerson(person.id)?.status, "unavailable");

    const restored = store.restorePerson(person.id);
    assert.equal(restored?.status, "active");
    assert.equal(restored?.refinementEnabled, false);
    assert.equal(restored?.injectionEnabled, false);
    assert.equal(restored?.companyId, company?.id);
    assert.equal(store.listIdentities(person.id).length, 1);
    assert.deepEqual(store.getDossier(person.id)?.dossier, dossier);
    assert.equal(
      store.listTodos().find((todo) => todo.deduplicationKey === `soft-delete-review:${person.id}`)
        ?.status,
      "open",
    );
    assert.equal(store.restorePerson(person.id), undefined);
    assert.equal(store.restorePerson("missing"), undefined);
  } finally {
    store.close();
  }
});
