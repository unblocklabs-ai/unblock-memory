import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CurationStore, chunkFingerprint } from "../src/curation.js";

test("upgrades the legacy inbox without losing decisions and persists quality judgment cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-quality-migration-"));
  const path = join(root, "curation.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE maintenance_tasks (
    id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('ambiguous_event_time', 'exact_duplicate')),
    corpus TEXT NOT NULL, collection TEXT NOT NULL, path TEXT NOT NULL, reason TEXT NOT NULL,
    content_fingerprint TEXT NOT NULL, detail TEXT, resolution_note TEXT, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(type, corpus, collection, path, reason, content_fingerprint));
    CREATE INDEX maintenance_tasks_status_created ON maintenance_tasks(status, created_at);
    INSERT INTO maintenance_tasks VALUES ('old', 'exact_duplicate', 'memory', 'source', 'note.md',
      'duplicate', 'fingerprint', 'detail', 'intentional history', 'irrelevant', 'then', 'now');`);
  db.close();
  let store = new CurationStore(path);
  try {
    const preserved = store.listTasks({ status: "irrelevant" })[0];
    assert.equal(preserved.id, "old");
    assert.equal(preserved.resolutionNote, "intentional history");
    const item = { type: "quality_review" as const, corpus: "memory", collection: "source",
      path: "note.md", reason: "possible_ingestion_noise", contentFingerprint: "first" };
    const task = store.addTask(item);
    assert.throws(() => store.updateTask({ id: task.id, status: "resolved" }), /verification/);
    store.updateTask({ id: task.id, status: "resolved", note: "Repaired parser, reindexed and checked source/chunks." });
    assert.equal(store.addTask(item).status, "resolved");
    assert.equal(store.addTask({ ...item, contentFingerprint: "changed" }).status, "pending");
    store.cacheQualityJudgment("v1", { noise: 0.95, evidence: 0.99 });
    store.close();
    store = new CurationStore(path);
    assert.deepEqual(store.qualityJudgment("v1"), Object.assign(Object.create(null), { noise: 0.95, evidence: 0.99 }));
    assert.equal(store.qualityJudgment("v2"), undefined);
    assert.equal(store.listTasks({ status: "resolved" })[0].id, task.id);
  } finally { store.close(); }
});

test("keeps fingerprint-specific tasks distinct without reopening reviewed work", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-curation-"));
  const store = new CurationStore(join(root, "curation.sqlite"));
  try {
    const candidate = {
      type: "ambiguous_event_time" as const,
      corpus: "memory",
      collection: "source-memory",
      path: "notes.md",
      reason: "cluster chronology has no reliable event time",
      contentFingerprint: chunkFingerprint("first"),
    };
    store.addTask(candidate);
    store.addTask({ ...candidate, contentFingerprint: chunkFingerprint("second") });
    const pending = store.listTasks({ limit: 10 });
    assert.deepEqual(pending.map((entry) => entry.contentFingerprint).sort(), [
      chunkFingerprint("first"),
      chunkFingerprint("second"),
    ].sort());
    const first = pending.find((entry) => entry.contentFingerprint === chunkFingerprint("first"))!;
    const second = pending.find((entry) => entry.contentFingerprint === chunkFingerprint("second"))!;
    assert.throws(() => store.updateTask({ id: first.id, status: "resolved" }),
      /requires a date annotation/);

    const updated = store.updateTask({ id: first.id, status: "irrelevant" });
    assert.equal(updated?.status, "irrelevant");
    store.addTask(candidate);
    assert.deepEqual(store.listTasks().map((entry) => entry.id), [second.id]);
    assert.equal(store.listTasks({ status: "irrelevant" }).length, 1);

    const resolvedCandidate = { ...candidate, path: "resolved.md", contentFingerprint: chunkFingerprint("one") };
    store.addTask(resolvedCandidate);
    const resolvedTask = store.listTasks().find((entry) => entry.path === "resolved.md")!;
    store.updateTask({
      id: resolvedTask.id,
      status: "resolved",
      annotation: {
        scope: "chunk",
        eventTime: "2026-08-01T00:00:00.000Z",
        basis: "agent_verified",
        evidence: "Verified.",
      },
    });
    store.addTask({ ...resolvedCandidate, contentFingerprint: chunkFingerprint("two") });
    assert.equal(store.listTasks().find((entry) => entry.path === "resolved.md")?.contentFingerprint,
      chunkFingerprint("two"));
  } finally {
    store.close();
  }
});

test("resolves ambiguity with chunk or document temporal annotations", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-annotations-"));
  const store = new CurationStore(join(root, "curation.sqlite"));
  try {
    const add = (path: string, fingerprint: string) => store.addTask({
      type: "ambiguous_event_time",
      corpus: "memory",
      collection: "source-memory",
      path,
      reason: "cluster chronology has no reliable event time",
      contentFingerprint: fingerprint,
    });
    add("chunk.md", chunkFingerprint("chunk"));
    add("document.md", chunkFingerprint("document"));
    const tasks = store.listTasks({ limit: 10 });
    const chunkTask = tasks.find((entry) => entry.path === "chunk.md");
    const documentTask = tasks.find((entry) => entry.path === "document.md");
    assert.ok(chunkTask);
    assert.ok(documentTask);

    store.updateTask({
      id: chunkTask.id,
      status: "resolved",
      annotation: {
        scope: "chunk",
        eventTime: "2026-08-20T12:00:00.000Z",
        basis: "agent_verified",
        evidence: "Confirmed against the deployment ledger.",
      },
    });
    store.updateTask({
      id: documentTask.id,
      status: "resolved",
      annotation: {
        scope: "document",
        eventTime: "2026-08-21T00:00:00.000Z",
        basis: "frontmatter",
        evidence: "The document frontmatter dates the whole entry.",
      },
    });

    const annotations = store.annotations();
    assert.equal(annotations.length, 2);
    assert.equal(annotations.find((entry) => entry.path === "chunk.md")?.contentFingerprint,
      chunkFingerprint("chunk"));
    assert.equal(annotations.find((entry) => entry.path === "document.md")?.contentFingerprint, "");
    assert.deepEqual(store.listTasks(), []);
  } finally {
    store.close();
  }
});

test("date annotations cannot be attached to duplicate proposals", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-duplicate-task-"));
  const store = new CurationStore(join(root, "curation.sqlite"));
  try {
    store.addTask({
      type: "exact_duplicate",
      corpus: "memory",
      collection: "source-memory",
      path: "notes.md",
      reason: "exact chunk content repeats in this source document",
    });
    const duplicate = store.listTasks()[0]!;
    assert.throws(() => store.updateTask({
      id: duplicate.id,
      status: "resolved",
      annotation: {
        scope: "document",
        eventTime: "2026-08-21T00:00:00.000Z",
        basis: "agent_verified",
        evidence: "not applicable",
      },
    }), /only resolve ambiguous event-time tasks/);
  } finally {
    store.close();
  }
});
