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

test("creates only the seven version-2 tables with secure SQLite settings", async () => {
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
      "person_evidence_receipts",
      "person_identities",
      "person_whisper_receipts",
    ]);
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      2,
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

test("deduplicates exact identities and enables injection for new people", async () => {
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
    assert.equal(second.person.injectionEnabled, true);
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

    assert.throws(() => store.replaceDossier(person.id, { ...dossier, blurb: "   " }));
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

test("restores an unavailable person without restoring injection or deleting related records", async () => {
  const store = new PeopleStore(await temporaryPath(), options);
  try {
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    });
    store.setInjection(person.id, true);
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

test("atomically replaces or retains a dossier while consuming exact evidence", async () => {
  const store = new PeopleStore(await temporaryPath(), { ...options, maxBlurbChars: 50 });
  try {
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    });
    const first = {
      schemaVersion: 1,
      blurb: "Initial blurb.",
      sections: [],
    } as const;
    const firstLocator = "session:first:event:1";
    assert.deepEqual(store.replaceDossier(person.id, first, [firstLocator]), first);
    assert.equal(
      store.listProcessedEvidenceLocators(person.id, "session").has(firstLocator),
      true,
    );

    const secondLocator = "session:second:event:2";
    assert.deepEqual(store.replaceDossier(person.id, undefined, [secondLocator]), first);
    assert.equal(
      store.listProcessedEvidenceLocators(person.id, "session").has(secondLocator),
      true,
    );
    assert.deepEqual(store.getDossier(person.id)?.dossier, first);

    const rejectedLocator = "session:rejected:event:3";
    assert.throws(
      () =>
        store.replaceDossier(person.id, { ...first, blurb: "x".repeat(51) }, [rejectedLocator]),
      /50 characters/,
    );
    assert.equal(
      store.listProcessedEvidenceLocators(person.id, "session").has(rejectedLocator),
      false,
    );
    assert.deepEqual(store.getDossier(person.id)?.dossier, first);

    assert.equal(store.deleteDossier(person.id), true);
    assert.equal(store.getDossier(person.id), undefined);
    assert.equal(store.deleteDossier(person.id), false);
  } finally {
    store.close();
  }
});

test("stores one durable whisper receipt per thread and person", async () => {
  const store = new PeopleStore(await temporaryPath(), options);
  try {
    const first = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    }).person;
    const second = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U456",
    }).person;

    const receipt = store.recordWhisperReceipt({
      threadKey: "slack:workspace-a:C1:1.0",
      personId: first.id,
      runId: "run-1",
      contribution: "first contribution",
    });
    assert.equal(receipt.runId, "run-1");
    assert.deepEqual(store.getWhisperReceipt("slack:workspace-a:C1:1.0", first.id), receipt);
    assert.deepEqual(
      store.recordWhisperReceipt({
        threadKey: "slack:workspace-a:C1:1.0",
        personId: first.id,
        runId: "run-2",
        contribution: "replacement",
      }),
      receipt,
    );
    assert.equal(
      store.recordWhisperReceipt({
        threadKey: "slack:workspace-a:C1:1.0",
        personId: second.id,
        runId: "run-3",
        contribution: "second person",
      }).runId,
      "run-3",
    );
  } finally {
    store.close();
  }
});

test("migrates version 1 people to agent-owned injection semantics", async () => {
  const path = await temporaryPath();
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_domain TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, preferred_name TEXT,
      status TEXT NOT NULL, company_id TEXT REFERENCES companies(id),
      refinement_enabled INTEGER NOT NULL DEFAULT 0, injection_enabled INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE person_identities (person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, account_scope TEXT NOT NULL, external_id TEXT NOT NULL,
      display_name TEXT, real_name TEXT, handle TEXT, avatar_url TEXT, title TEXT, is_bot INTEGER,
      is_deactivated INTEGER NOT NULL DEFAULT 0, first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, last_synced_at TEXT,
      PRIMARY KEY (provider, account_scope, external_id)) STRICT;
    CREATE TABLE person_dossiers (person_id TEXT PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
      dossier_json TEXT NOT NULL, blurb TEXT NOT NULL, reviewed_at TEXT NOT NULL) STRICT;
    CREATE TABLE people_todos (id TEXT PRIMARY KEY, deduplication_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, context_json TEXT NOT NULL, status TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      resolved_at TEXT, resolution_note TEXT) STRICT;
    CREATE INDEX people_policy_seen ON people(refinement_enabled, last_seen_at);
    INSERT INTO people VALUES
      ('active', 'Active', NULL, 'active', NULL, 0, 0, NULL, 'now', 'now'),
      ('archived', 'Archived', NULL, 'archived', NULL, 1, 0, NULL, 'now', 'now');
    PRAGMA user_version = 1;
  `);
  db.close();

  const store = new PeopleStore(path, options);
  try {
    assert.equal(store.getPerson("active")?.injectionEnabled, true);
    assert.equal(store.getPerson("archived")?.injectionEnabled, false);
    const migrated = new DatabaseSync(path, { readOnly: true });
    try {
      const columns = migrated
        .prepare("PRAGMA table_info(people)")
        .all()
        .map((row) => (row as { name: string }).name);
      assert.equal(columns.includes("refinement_enabled"), false);
      assert.equal(
        (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        2,
      );
    } finally {
      migrated.close();
    }
  } finally {
    store.close();
  }
});
