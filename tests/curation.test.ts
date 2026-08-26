import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CurationStore, chunkFingerprint } from "../src/curation.js";

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
