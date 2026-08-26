import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore, type QMDStore } from "@unblocklabs/qmd";
import {
  buildReadResult,
  cleanupRemovedDocuments,
  enableSecureDelete,
  pruneStaleCollections,
  QmdMemoryManager,
  type ManagerStore,
} from "../src/manager.js";
import { resolveSessionSource, resolveSource } from "../src/sources.js";
import { createAgentDatabase } from "./helpers/session-database.js";

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

type ManagerStoreOverrides = Partial<ManagerStore> & Partial<Pick<QMDStore, "internal">>;

function createManagerStore(
  overrides: ManagerStoreOverrides = {},
): ManagerStore & Partial<Pick<QMDStore, "internal">> {
  return {
    async update() {
      return { collections: 0, indexed: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0, needsEmbedding: 0 };
    },
    async embed() {
      return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 };
    },
    async getStatus() {
      return { totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: true, collections: [] };
    },
    async listCollections() { return []; },
    async searchLex() { return []; },
    async vsearch() { return []; },
    async get(query: string) { return { error: "not_found" as const, query, similarFiles: [] }; },
    async getDocumentBody() { return null; },
    async close() {},
    ...overrides,
  };
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

test("initializes semantic chunking before collection-scoped embeds", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-memory-semantic-init-"));
  const dbPath = join(workspace, "index.sqlite");
  const manager = new QmdMemoryManager({
    dbPath,
    workspaceDir: workspace,
    sources: [resolveSource(workspace, "MEMORY.md")],
  });
  await manager.start();
  await manager.close();

  const store = await createStore({ dbPath, config: { collections: {} } });
  try {
    const configured = store.internal.db.prepare(
      "SELECT value FROM store_config WHERE key = 'embedding_chunk_strategy'",
    ).get() as { value?: unknown } | undefined;
    assert.equal(configured?.value, "semantic");
  } finally {
    await store.close();
  }
});

test("fails sync when QMD reports embedding errors", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-memory-embed-errors-"));
  const source = resolveSource(workspace, "MEMORY.md");
  const manager = new QmdMemoryManager({
    dbPath: join(workspace, "index.sqlite"),
    workspaceDir: workspace,
    sources: [source],
    storeFactory: async () => createManagerStore({
      async embed() {
        return { docsProcessed: 1, chunksEmbedded: 0, errors: 1, durationMs: 0 };
      },
    }),
  });
  await assert.rejects(manager.start(), /QMD failed to embed 1 chunk/);
  await manager.close();
});

test("watches modified and new Markdown, serializes refreshes, and stops on close", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-memory-watch-"));
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
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-stale-"));
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
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-deleted-"));
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
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-edited-"));
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
  const workspace = await mkdtemp(join(tmpdir(), "unblock-memory-lexical-"));
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
    assert.equal(hit?.corpus, "memory");
    assert.equal(hit?.snippet, "Rico leads client operations.");
    assert.equal(hit?.textScore, 0.8);
  } finally {
    await manager.close();
  }
});

test("scopes vector search to named corpora and labels results", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-memory-search-corpora-"));
  await mkdir(join(workspace, "projects"));
  await writeFile(join(workspace, "MEMORY.md"), "memory body\n");
  await writeFile(join(workspace, "projects", "note.md"), "projects body\n");
  const memory = resolveSource(workspace, "MEMORY.md", "memory");
  const projects = resolveSource(workspace, "projects/**/*.md", "projects");
  const hits = [memory, projects].map((source) => ({
    file: `qmd://${source.collection}/${source.corpus === "memory" ? "MEMORY.md" : "note.md"}`,
    displayPath: `${source.collection}/${source.corpus === "memory" ? "MEMORY.md" : "note.md"}`,
    title: source.corpus,
    body: `${source.corpus} body`,
    score: 0.8,
    context: null,
    docid: `${source.corpus}-hash`,
    bestChunk: `${source.corpus} body`,
    chunkPos: 0,
    chunkLen: source.corpus.length + 5,
  }));
  const searchedCollections: string[][] = [];
  const store = createManagerStore({
    async vsearch(_query, options) {
      const collections = typeof options?.collection === "string"
        ? [options.collection]
        : [...(options?.collection ?? [])];
      searchedCollections.push(collections);
      return hits.filter((hit) => collections.some((collection) => hit.file.startsWith(`qmd://${collection}/`)));
    },
    async get(query) {
      return {
        filepath: query,
        displayPath: "note.md",
        title: "note",
        context: null,
        hash: "projects-hash",
        docid: "projects-hash",
        collectionName: projects.collection,
        modifiedAt: "",
        bodyLength: 13,
      };
    },
    async getDocumentBody() { return "projects body\n"; },
  });
  const manager = new QmdMemoryManager({
    dbPath: join(workspace, "index.sqlite"),
    workspaceDir: workspace,
    sources: [memory, projects],
    storeFactory: async () => store,
  });
  try {
    await manager.start();
    assert.deepEqual((await manager.search("notes")).map((hit) => hit.corpus), ["memory", "projects"]);
    assert.deepEqual((await manager.search("notes", { corpora: ["all"] })).map((hit) => hit.corpus), ["memory", "projects"]);
    const [projectHit] = await manager.search("notes", { corpora: ["projects"] });
    assert.equal(projectHit?.corpus, "projects");
    assert.equal((await manager.readFile({ relPath: projectHit!.path })).status, "ok");
    assert.deepEqual(
      (await manager.search("notes", { corpora: ["memory", "projects", "memory"] })).map((hit) => hit.corpus),
      ["memory", "projects"],
    );
    assert.deepEqual(searchedCollections, [
      [memory.collection, projects.collection],
      [memory.collection, projects.collection],
      [projects.collection],
      [memory.collection, projects.collection],
    ]);
    await assert.rejects(manager.search("notes", { corpora: ["unknown"] }), /unknown corpus: unknown/);
    await assert.rejects(manager.search("notes", { corpora: ["all", "memory"] }), /must be used alone/);
    await assert.rejects(manager.search("notes", { corpora: [] }), /must not be empty/);
    assert.deepEqual(manager.status().custom?.corpora, [
      { name: "memory", kind: "files", paths: ["MEMORY.md"] },
      { name: "projects", kind: "files", paths: ["projects/**/*.md"] },
    ]);
  } finally {
    await manager.close();
  }
});

test("adds manifest metadata to session search results", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-search-sessions-"));
  const sessionsDir = join(root, "sessions");
  const documentPath = "slack/channel/workspace/C123/2026-08-25T14-00-00Z--session-1.md";
  const document = join(sessionsDir, documentPath);
  await mkdir(join(document, ".."), { recursive: true });
  await writeFile(document, "session body\n");
  const source = resolveSessionSource(sessionsDir, ["channel", "group"]);
  const manifestPath = join(root, "sessions-manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    sessions: {
      "session-1": {
        sessionId: "session-1",
        provider: "slack",
        chatType: "channel",
        accountId: "workspace",
        conversationId: "C123",
        startedAt: 1,
        sourceGeneration: "generation",
        maxSeq: 1,
        activeEventCount: 1,
        sizeBytes: 13,
        projectionHash: "hash",
        documentPath,
        projectorVersion: 1,
      },
    },
  }));
  const store = createManagerStore({
    async vsearch() {
      return [{
        file: `qmd://${source.collection}/${documentPath}`,
        displayPath: `${source.collection}/${documentPath}`,
        title: "Session",
        body: "session body",
        score: 0.8,
        context: null,
        docid: "hash",
        bestChunk: "session body",
        chunkPos: 0,
        chunkLen: 12,
      }];
    },
  });
  const manager = new QmdMemoryManager({
    dbPath: join(root, "index.sqlite"),
    workspaceDir: root,
    sources: [source],
    storeFactory: async () => store,
    sessions: {
      agentId: "main",
      agentName: "Agent",
      chatTypes: ["channel", "group"],
      collection: source.collection,
      databasePath: join(root, "openclaw-agent.sqlite"),
      manifestPath,
      outputDir: sessionsDir,
      timezone: "UTC",
    },
  });
  try {
    await manager.start();
    const [hit] = await manager.search("session", { corpora: ["sessions"] });
    assert.deepEqual(hit?.session, {
      sessionId: "session-1",
      provider: "slack",
      chatType: "channel",
      accountId: "workspace",
      conversationId: "C123",
      startedAt: 1,
    });
    assert.deepEqual(manager.status().custom?.corpora, [{
      name: "sessions",
      kind: "sessions",
      chatTypes: ["channel", "group"],
    }]);
  } finally {
    await manager.close();
  }
});

test("filters session paths without restricting file corpora", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-filter-sessions-"));
  const sessionsDir = join(root, "sessions");
  const memory = resolveSource(root, "MEMORY.md", "memory");
  const sessions = resolveSessionSource(sessionsDir, ["channel", "group"]);
  const firstPath = "slack/channel/workspace/C123/first.md";
  const secondPath = "discord/group/team/G456/second.md";
  const startedAt = Date.parse("2026-08-25T12:00:00Z");
  const manifestPath = join(root, "sessions-manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    sessions: {
      first: {
        sessionId: "first",
        provider: "Slack",
        chatType: "channel",
        accountId: "workspace",
        conversationId: "C123",
        startedAt,
        documentPath: firstPath,
      },
      second: {
        sessionId: "second",
        provider: "discord",
        chatType: "group",
        accountId: "team",
        conversationId: "G456",
        startedAt: Date.parse("2026-08-20T12:00:00Z"),
        documentPath: secondPath,
      },
    },
  }));
  const hits = [
    { file: `qmd://${memory.collection}/MEMORY.md`, body: "file memory" },
    { file: `qmd://${sessions.collection}/${firstPath}`, body: "first session" },
    { file: `qmd://${sessions.collection}/${secondPath}`, body: "second session" },
  ];
  const receivedFilters: unknown[] = [];
  const store = createManagerStore({
    async vsearch(_query, options) {
      receivedFilters.push(options?.allowedPaths);
      const collections = typeof options?.collection === "string"
        ? [options.collection]
        : [...(options?.collection ?? [])];
      return hits.flatMap((hit) => {
        const match = /^qmd:\/\/([^/]+)\/(.*)$/u.exec(hit.file);
        if (!match || !collections.includes(match[1]!)) return [];
        const restricted = options?.allowedPaths?.[match[1]!];
        if (restricted && !restricted.includes(match[2]!)) return [];
        return [{
          ...hit,
          displayPath: hit.file.slice("qmd://".length),
          title: "Memory",
          score: 0.8,
          context: null,
          docid: hit.file,
          bestChunk: hit.body,
          chunkPos: 0,
          chunkLen: hit.body.length,
        }];
      });
    },
  });
  const manager = new QmdMemoryManager({
    dbPath: join(root, "index.sqlite"),
    workspaceDir: root,
    sources: [memory, sessions],
    storeFactory: async () => store,
    sessions: {
      agentId: "main",
      agentName: "Agent",
      chatTypes: ["channel", "group"],
      collection: sessions.collection,
      databasePath: join(root, "openclaw-agent.sqlite"),
      manifestPath,
      outputDir: sessionsDir,
      timezone: "UTC",
    },
  });
  try {
    await manager.start();
    const results = await manager.search("decision", {
      sessionFilter: {
        startedFrom: "2026-08-25T12:00:00Z",
        startedTo: "2026-08-25T12:00:00Z",
        provider: " slack ",
        chatType: "channel",
        accountId: " workspace ",
        conversationId: " C123 ",
      },
    });
    assert.deepEqual(results.map((result) => result.corpus), ["memory", "sessions"]);
    assert.deepEqual(receivedFilters[0], { [sessions.collection]: [firstPath] });

    assert.deepEqual(await manager.search("decision", {
      corpora: ["sessions"],
      sessionFilter: { provider: "teams" },
    }), []);
    assert.deepEqual(receivedFilters[1], { [sessions.collection]: [] });
    await assert.rejects(manager.search("decision", {
      sessionFilter: {
        startedFrom: "2026-08-26T00:00:00Z",
        startedTo: "2026-08-25T00:00:00Z",
      },
    }), /must not be after startedTo/);
  } finally {
    await manager.close();
  }
});

test("keeps analysis fresh for a no-op manual session sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-session-noop-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const sessionsDir = join(root, "sessions");
  const source = resolveSessionSource(sessionsDir, ["channel", "group"]);
  createAgentDatabase(databasePath).close();
  const backing = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  const manager = new QmdMemoryManager({
    dbPath: backing.dbPath,
    workspaceDir: root,
    sources: [source],
    storeFactory: async () => createManagerStore({
      internal: backing.internal,
      async close() { await backing.close(); },
    }),
    sessions: {
      agentId: "main",
      agentName: "Agent",
      chatTypes: ["channel", "group"],
      collection: source.collection,
      databasePath,
      manifestPath: join(root, "sessions-manifest.json"),
      outputDir: sessionsDir,
      timezone: "UTC",
    },
  });
  try {
    await manager.start();
    backing.internal.db.prepare(`INSERT INTO memory_analysis_runs
      (id, created_at, completed_at, input_digest, model, embedding_fingerprint, dimensions, params_json, stale_at)
      VALUES ('run', 'now', 'done', 'digest', 'model', 'fingerprint', 768, '{}', NULL)`).run();
    await manager.syncSessions();
    assert.equal((await manager.listClusters()).stale, false);
  } finally {
    await manager.close();
  }
});

test("serializes QMD writes and analysis on one operation queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-serialize-analysis-"));
  const backing = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  const enter = (event: string) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`${event}:start`);
  };
  const leave = (event: string) => {
    events.push(`${event}:end`);
    active -= 1;
  };
  const store = createManagerStore({
    internal: backing.internal,
    async update() {
      enter("sync");
      await delay(50);
      return { collections: 0, indexed: 1, updated: 0, unchanged: 0, removed: 0, skipped: 0, needsEmbedding: 0 };
    },
    async embed() {
      await delay(50);
      leave("sync");
      return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 50 };
    },
    async close() { await backing.close(); },
  });
  const manager = new QmdMemoryManager({
    dbPath: backing.dbPath,
    workspaceDir: root,
    sources: [],
    storeFactory: async () => store,
    analysisExecutable: "/worker",
    analysisRunner: async () => {
      enter("analysis");
      await delay(25);
      backing.internal.db.prepare(`INSERT INTO memory_analysis_runs
        (id, created_at, completed_at, input_digest, model, embedding_fingerprint, dimensions, params_json, stale_at)
        VALUES ('run', 'now', 'done', 'digest', 'model', 'fingerprint', 768, '{}', NULL)`).run();
      leave("analysis");
    },
  });
  try {
    const sync = manager.sync();
    const analysis = manager.recluster();
    await Promise.all([sync, analysis]);
    assert.equal(maxActive, 1);
    assert.deepEqual(events, ["sync:start", "sync:end", "analysis:start", "analysis:end"]);
  } finally {
    await manager.close();
  }
});

test("analysis failure does not disable ordinary memory search", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-analysis-failure-"));
  const backing = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  const source = resolveSource(root, "MEMORY.md");
  const store = createManagerStore({
    internal: backing.internal,
    async searchLex() { return [{
      filepath: `qmd://${source.collection}/MEMORY.md`, displayPath: `${source.collection}/MEMORY.md`,
      title: "Memory", context: null, hash: "hash", docid: "hash", collectionName: source.collection,
      modifiedAt: "", bodyLength: 11, body: "still works", score: 0.8, source: "fts" as const,
    }]; },
    async close() { await backing.close(); },
  });
  const manager = new QmdMemoryManager({
    dbPath: backing.dbPath,
    workspaceDir: root,
    sources: [source],
    storeFactory: async () => store,
    analysisExecutable: "/missing-worker",
    analysisRunner: async () => { throw new Error("worker missing"); },
  });
  try {
    await assert.rejects(manager.recluster(), /worker missing/);
    assert.equal((await manager.search("memory", { lexicalOnly: true }))[0]?.snippet, "still works");
  } finally {
    await manager.close();
  }
});

test("analysis is unavailable until an explicit worker is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-analysis-disabled-"));
  const backing = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  const manager = new QmdMemoryManager({
    dbPath: backing.dbPath,
    workspaceDir: root,
    sources: [],
    storeFactory: async () => createManagerStore({
      internal: backing.internal,
      async close() { await backing.close(); },
    }),
  });
  try {
    await assert.rejects(manager.recluster(), /configure analysis\.executable/);
  } finally {
    await manager.close();
  }
});

test("refuses reclustering while QMD reports chunks needing embedding", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-analysis-needs-embedding-"));
  const backing = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  let workerCalled = false;
  const store = createManagerStore({
    internal: backing.internal,
    async update() { return { collections: 0, indexed: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0, needsEmbedding: 2 }; },
    async getStatus() { return { totalDocuments: 2, needsEmbedding: 2, hasVectorIndex: true, collections: [] }; },
    async close() { await backing.close(); },
  });
  const manager = new QmdMemoryManager({
    dbPath: backing.dbPath,
    workspaceDir: root,
    sources: [],
    storeFactory: async () => store,
    analysisExecutable: "/worker",
    analysisRunner: async () => { workerCalled = true; },
  });
  try {
    await assert.rejects(
      manager.recluster(),
      /2 chunks need embedding.*Run memory sync.*retry memory_recluster/,
    );
    assert.equal(workerCalled, false);
  } finally {
    await manager.close();
  }
});

test("keeps analysis fresh for a no-op sync and marks it stale before embedding changed inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-analysis-invalidation-"));
  const backing = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  let inputsChanged = false;
  const store = createManagerStore({
    internal: backing.internal,
    async update() {
      return {
        collections: 0,
        indexed: inputsChanged ? 1 : 0,
        updated: 0,
        unchanged: inputsChanged ? 0 : 1,
        removed: 0,
        skipped: 0,
        needsEmbedding: 0,
      };
    },
    async embed() {
      if (inputsChanged) throw new Error("embedding failed");
      return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 };
    },
    async close() { await backing.close(); },
  });
  const manager = new QmdMemoryManager({
    dbPath: backing.dbPath,
    workspaceDir: root,
    sources: [],
    storeFactory: async () => store,
  });
  try {
    await manager.start();
    backing.internal.db.prepare(`INSERT INTO memory_analysis_runs
      (id, created_at, completed_at, input_digest, model, embedding_fingerprint, dimensions, params_json, stale_at)
      VALUES ('run', 'now', 'done', 'digest', 'model', 'fingerprint', 768, '{}', NULL)`).run();

    await manager.sync();
    assert.equal((await manager.listClusters()).status, "ok");
    assert.equal((await manager.listClusters()).stale, false);

    inputsChanged = true;
    await assert.rejects(manager.sync(), /embedding failed/);
    const stale = await manager.listClusters();
    assert.equal(stale.status, "ok");
    assert.equal(stale.stale, true);
    assert.match(stale.hint ?? "", /memory_recluster/);
  } finally {
    await manager.close();
  }
});

test("marks retained analysis stale for add, edit, delete, embedding, and forced sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-analysis-stale-cases-"));
  const backing = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  let update = { collections: 0, indexed: 0, updated: 0, unchanged: 1, removed: 0, skipped: 0, needsEmbedding: 0 };
  let chunksEmbedded = 0;
  const store = createManagerStore({
    internal: backing.internal,
    async update() { return update; },
    async embed() { return { docsProcessed: 0, chunksEmbedded, errors: 0, durationMs: 0 }; },
    async close() { await backing.close(); },
  });
  const manager = new QmdMemoryManager({
    dbPath: backing.dbPath,
    workspaceDir: root,
    sources: [],
    storeFactory: async () => store,
  });
  try {
    await manager.start();
    backing.internal.db.prepare(`INSERT INTO memory_analysis_runs
      (id, created_at, completed_at, input_digest, model, embedding_fingerprint, dimensions, params_json, stale_at)
      VALUES ('run', 'now', 'done', 'digest', 'model', 'fingerprint', 768, '{}', NULL)`).run();
    const resetFresh = () => backing.internal.db.prepare(
      "UPDATE memory_analysis_runs SET stale_at = NULL WHERE id = 'run'",
    ).run();
    const assertStale = async () => assert.equal((await manager.listClusters()).stale, true);

    for (const changed of [
      { indexed: 1 },
      { updated: 1 },
      { removed: 1 },
      { needsEmbedding: 1 },
    ]) {
      resetFresh();
      update = { collections: 0, indexed: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0, needsEmbedding: 0, ...changed };
      chunksEmbedded = 0;
      await manager.sync();
      await assertStale();
    }

    resetFresh();
    update = { collections: 0, indexed: 0, updated: 0, unchanged: 1, removed: 0, skipped: 0, needsEmbedding: 0 };
    chunksEmbedded = 1;
    await manager.sync();
    await assertStale();

    resetFresh();
    chunksEmbedded = 0;
    await manager.sync({ force: true });
    await assertStale();
  } finally {
    await manager.close();
  }
});

test("failed reclustering preserves stale results and successful reclustering replaces them fresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-recluster-lifecycle-"));
  const backing = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  let fail = true;
  let capturedOptions: unknown;
  const store = createManagerStore({
    internal: backing.internal,
    async update() { return { collections: 0, indexed: 0, updated: 0, unchanged: 1, removed: 0, skipped: 0, needsEmbedding: 0 }; },
    async close() { await backing.close(); },
  });
  const manager = new QmdMemoryManager({
    dbPath: backing.dbPath,
    workspaceDir: root,
    sources: [],
    storeFactory: async () => store,
    analysisExecutable: "/worker",
    analysisRunner: async ({ options }) => {
      capturedOptions = options;
      if (fail) throw new Error("worker failed");
      backing.internal.db.transaction(() => {
        backing.internal.db.prepare("DELETE FROM memory_analysis_runs").run();
        backing.internal.db.prepare(`INSERT INTO memory_analysis_runs
          (id, created_at, completed_at, input_digest, model, embedding_fingerprint, dimensions, params_json, stale_at)
          VALUES ('fresh', 'later', 'later', 'new-digest', 'model', 'fingerprint', 768, '{}', NULL)`).run();
      }).immediate();
    },
  });
  try {
    await manager.start();
    backing.internal.db.prepare(`INSERT INTO memory_analysis_runs
      (id, created_at, completed_at, input_digest, model, embedding_fingerprint, dimensions, params_json, stale_at)
      VALUES ('stale', 'now', 'now', 'digest', 'model', 'fingerprint', 768, '{}', 'stale-time')`).run();

    await assert.rejects(manager.recluster(), /worker failed/);
    const retained = await manager.listClusters();
    assert.equal(retained.runId, "stale");
    assert.equal(retained.stale, true);

    fail = false;
    const options = { hdbscan: { minClusterSize: 12 }, seed: 7 };
    const summary = await manager.recluster(options);
    assert.deepEqual(capturedOptions, options);
    assert.equal(summary.runId, "fresh");
    assert.equal(summary.stale, false);
    assert.equal((await manager.listClusters()).runId, "fresh");
  } finally {
    await manager.close();
  }
});
