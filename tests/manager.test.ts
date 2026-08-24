import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "@unblocklabs/qmd";
import {
  buildReadResult,
  cleanupRemovedDocuments,
  enableSecureDelete,
  pruneStaleCollections,
  QmdMemoryManager,
  type ManagerStore,
} from "../src/manager.js";
import { resolveSource } from "../src/sources.js";

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(25);
  }
}

async function assertMarkerAbsent(dbPath: string, marker: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const bytes = await readFile(`${dbPath}${suffix}`);
      assert.equal(bytes.includes(Buffer.from(marker)), false, `${marker} remains in index.sqlite${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

test("bounds default memory reads and provides continuation", () => {
  const content = Array.from({ length: 150 }, (_, index) => `line ${index + 1}`).join("\n");
  const result = buildReadResult({ content, path: "qmd://memory/daily.md" });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.lines, 120);
  assert.equal(result.nextFrom, 121);
  assert.equal(result.truncated, true);
  assert.match(result.text, /Use from=121/);
});

test("watches modified and new Markdown, serializes refreshes, and stops on close", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-qmd-watch-"));
  const memoryDir = join(workspace, "memory");
  const existing = join(memoryDir, "today.md");
  await mkdir(memoryDir);
  await writeFile(existing, "initial\n");

  let activeSyncs = 0;
  let maxActiveSyncs = 0;
  let syncRuns = 0;
  const store = {
    async update() {
      activeSyncs += 1;
      syncRuns += 1;
      maxActiveSyncs = Math.max(maxActiveSyncs, activeSyncs);
      await delay(250);
      return { collections: 1, indexed: 0, updated: 0, unchanged: 1, removed: 0, skipped: 0, needsEmbedding: 0 };
    },
    async embed() {
      await delay(250);
      activeSyncs -= 1;
      return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 250 };
    },
    async getStatus() {
      return { totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] };
    },
    async listCollections() { return []; },
    async searchLex() { return []; },
    async vsearch() { return []; },
    async get(query: string) { return { error: "not_found" as const, query, similarFiles: [] }; },
    async getDocumentBody() { return null; },
    async close() {},
  } satisfies ManagerStore;

  const manager = new QmdMemoryManager({
    dbPath: join(workspace, "index.sqlite"),
    workspaceDir: workspace,
    sources: [resolveSource(workspace, "memory/**/*.md")],
    storeFactory: async () => store,
  });

  await manager.start();
  syncRuns = 0;
  maxActiveSyncs = 0;

  await writeFile(existing, "modified\n");
  await waitFor(() => syncRuns === 1, "modified-file refresh");
  await writeFile(join(memoryDir, "new.md"), "new\n");
  await waitFor(() => syncRuns === 2 && activeSyncs === 0, "new-file refresh");
  assert.equal(maxActiveSyncs, 1);

  await manager.close();
  await writeFile(existing, "after close\n");
  await delay(500);
  assert.equal(syncRuns, 2);
});

test("purges documents and plaintext from collections removed from configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-qmd-stale-"));
  const sourceDir = join(root, "old");
  const dbPath = join(root, "index.sqlite");
  await mkdir(sourceDir);
  const marker = "configremovalplaintextmarkerx";
  await writeFile(join(sourceDir, "secret.md"), `${marker}\n`);

  const original = await createStore({
    dbPath,
    config: { collections: { old: { path: sourceDir, pattern: "**/*.md" } } },
  });
  await original.update();
  await original.close();

  const reopened = await createStore({ dbPath, config: { collections: {} } });
  try {
    await pruneStaleCollections(reopened, new Set());
    assert.equal((await reopened.getStatus()).totalDocuments, 0);
    const contentCount = reopened.internal.db
      .prepare("SELECT COUNT(*) AS count FROM content")
      .get() as { count: number };
    assert.equal(contentCount.count, 0);
    assert.deepEqual(await reopened.get("qmd://old/secret.md"), {
      error: "not_found",
      query: "qmd://old/secret.md",
      similarFiles: [],
    });
    await assertMarkerAbsent(dbPath, marker);
  } finally {
    await reopened.close();
  }
  await assertMarkerAbsent(dbPath, marker);
});

test("purges plaintext after an indexed Markdown file is deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-qmd-deleted-"));
  const sourceDir = join(root, "memory");
  const memoryFile = join(sourceDir, "deleted.md");
  await mkdir(sourceDir);
  const marker = "filedeletionplaintextmarkery";
  await writeFile(memoryFile, `${marker}\n`);

  const dbPath = join(root, "index.sqlite");
  const store = await createStore({
    dbPath,
    config: { collections: { memory: { path: sourceDir, pattern: "**/*.md" } } },
  });
  try {
    enableSecureDelete(store);
    await store.update();
    await unlink(memoryFile);
    const update = await store.update();
    cleanupRemovedDocuments(store, update.updated + update.removed);

    assert.equal((await store.getStatus()).totalDocuments, 0);
    const retainedMarker = store.internal.db
      .prepare("SELECT COUNT(*) AS count FROM content WHERE doc LIKE ?")
      .get(`%${marker}%`) as { count: number };
    assert.equal(retainedMarker.count, 0);
    await assertMarkerAbsent(dbPath, marker);
  } finally {
    await store.close();
  }
  await assertMarkerAbsent(dbPath, marker);
});

test("purges replaced plaintext after an indexed Markdown file is edited", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-qmd-edited-"));
  const sourceDir = join(root, "memory");
  const memoryFile = join(sourceDir, "edited.md");
  const marker = "oldeditplaintextmarkerz";
  const dbPath = join(root, "index.sqlite");
  await mkdir(sourceDir);
  await writeFile(memoryFile, `${marker}\n`);

  const store = await createStore({
    dbPath,
    config: { collections: { memory: { path: sourceDir, pattern: "**/*.md" } } },
  });
  try {
    enableSecureDelete(store);
    await store.update();
    await writeFile(memoryFile, "replacement content with a different length\n");
    const update = await store.update();
    cleanupRemovedDocuments(store, update.updated + update.removed);

    assert.equal((await store.getStatus()).totalDocuments, 1);
    const retainedMarker = store.internal.db
      .prepare("SELECT COUNT(*) AS count FROM content WHERE doc LIKE ?")
      .get(`%${marker}%`) as { count: number };
    assert.equal(retainedMarker.count, 0);
    await assertMarkerAbsent(dbPath, marker);
  } finally {
    await store.close();
  }
  await assertMarkerAbsent(dbPath, marker);
});

test("lexical-only search returns useful document content and its virtual path", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-qmd-lexical-"));
  const source = resolveSource(workspace, "MEMORY.md");
  const store = {
    async update() { return { collections: 1, indexed: 0, updated: 0, unchanged: 1, removed: 0, skipped: 0, needsEmbedding: 0 }; },
    async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
    async getStatus() { return { totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
    async listCollections() { return []; },
    async searchLex() {
      return [{
        filepath: `qmd://${source.collection}/MEMORY.md`,
        displayPath: `${source.collection}/MEMORY.md`,
        title: "Memory",
        context: null,
        hash: "hash",
        docid: "hash",
        collectionName: source.collection,
        modifiedAt: "",
        bodyLength: 27,
        body: "Rico leads client operations.",
        score: 0.8,
        source: "fts" as const,
      }];
    },
    async vsearch() { return []; },
    async get(query: string) { return { error: "not_found" as const, query, similarFiles: [] }; },
    async getDocumentBody() { return null; },
    async close() {},
  } satisfies ManagerStore;
  const manager = new QmdMemoryManager({
    dbPath: join(workspace, "index.sqlite"),
    workspaceDir: workspace,
    sources: [source],
    storeFactory: async () => store,
  });
  try {
    await manager.start();
    const [hit] = await manager.search("Rico", { lexicalOnly: true });
    assert.equal(hit?.path, `qmd://${source.collection}/MEMORY.md`);
    assert.equal(hit?.snippet, "Rico leads client operations.");
    assert.equal(hit?.textScore, 0.8);
  } finally {
    await manager.close();
  }
});
