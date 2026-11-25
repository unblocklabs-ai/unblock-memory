import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { DEFAULTS } from "../src/defaults.js";
import { MEMORY_DATABASE, openMemoryDatabase } from "../src/memory-database.js";
import { QmdMemoryManager } from "../src/manager.js";
import { memoryPassageId, searchMemory, type RecallCandidateTrace } from "../src/memory-search.js";
import { registerMemoryWhisperer } from "../src/memory-whisperer.js";
import {
  attachHitLocator,
  getHitLocator,
  openRecallLedger,
  parseDailyFilenameDateMs,
  purgeRecallPerson,
  RECALL_LEDGER_SCHEMA_VERSION,
  RecallLedgerWriter,
  sha256Text,
  writeRecallBatch,
  type RecallQueryRecord,
} from "../src/recall-ledger.js";
import { projectSessionDocument, sessionContextSpans } from "../src/session-projector.js";
import { resolveSources } from "../src/sources.js";
import type { CorpusMemorySearchResult } from "../src/contracts.js";

const tempDir = () => mkdtemp(join(tmpdir(), "recall-ledger-"));

function sampleQuery(overrides: Partial<RecallQueryRecord> = {}): RecallQueryRecord {
  const leaf = "Bek only wears Yeezys now.";
  const now = Date.now();
  return {
    eventKey: "whisperer:sess-1:msg-1",
    createdAtMs: now,
    agentId: "bill",
    source: "whisperer",
    sessionId: "sess-1",
    sessionKey: "agent:bill:slack:channel:c1",
    runId: "run-1",
    provider: "slack",
    accountId: "default",
    senderId: "U123",
    channelId: "c1",
    threadId: "1712.01",
    chatType: "channel",
    lexQuery: "Bek shoes Yeezys",
    vecQuery: "What shoes does Bek wear?",
    queryFallback: false,
    corpora: ["memory", "sessions"],
    rankingMode: "decision",
    decisionModel: "liquid/d1.2-ultra",
    minUsefulness: 0.7,
    outcome: "emitted",
    hits: [
      {
        rawLeafId: memoryPassageId(leaf),
        passageId: memoryPassageId(leaf),
        docHash: sha256Text(`# Daily\n${leaf}`),
        qmdSeq: 2,
        chunkPos: 8,
        chunkLen: leaf.length,
        corpus: "memory",
        sourcePath: "qmd://source-1/2026-11-20.md",
        startLine: 2,
        endLine: 2,
        observedAtMs: Date.UTC(2026, 10, 20),
        observedAtBasis: "filename_date",
        retrievalRank: 1,
        retrievalScore: 0.082,
        usefulnessScore: 0.94,
        disposition: "emitted",
        finalRank: 1,
      },
    ],
    ...overrides,
  };
}

test("resolveConfig and openclaw.plugin.json manifest declare recallLedger with defaults.json alignment", async () => {
  const defaults = resolveConfig({});
  assert.deepEqual(defaults.recallLedger, { enabled: false, retentionDays: DEFAULTS.recallLedger.defaultRetentionDays });

  const enabled = resolveConfig({ recallLedger: { enabled: true, retentionDays: 30 } });
  assert.deepEqual(enabled.recallLedger, { enabled: true, retentionDays: 30 });

  assert.throws(() => resolveConfig({ recallLedger: { enabled: "yes" } }), /boolean/);
  assert.throws(() => resolveConfig({ recallLedger: { enabled: null } }), /boolean/);
  assert.throws(() => resolveConfig({ recallLedger: { retentionDays: 0 } }), /integer between 1/);
  assert.throws(() => resolveConfig({ recallLedger: { retentionDays: null } }), /integer between 1/);
  assert.throws(() => resolveConfig({ recallLedger: { bogus: true } }), /unknown recallLedger key/);

  const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as {
    configSchema: { properties: { recallLedger?: { additionalProperties: boolean; properties: Record<string, unknown> } } };
  };
  assert.ok(manifest.configSchema.properties.recallLedger);
  assert.equal(manifest.configSchema.properties.recallLedger.additionalProperties, false);
  assert.ok("enabled" in manifest.configSchema.properties.recallLedger.properties);
  assert.ok("retentionDays" in manifest.configSchema.properties.recallLedger.properties);
});

test("openRecallLedger initializes recall_ledger:1 cleanly with openMemoryDatabase and rejects unknown versions", async () => {
  const root = await tempDir();
  try {
    const dbPath = join(root, MEMORY_DATABASE);
    const db = openRecallLedger(dbPath);
    try {
      const storage = db.prepare("SELECT version FROM memory_schema WHERE component = 'storage'").get();
      const ledger = db.prepare("SELECT version FROM memory_schema WHERE component = 'recall_ledger'").get();
      assert.equal(storage?.version, 1);
      assert.equal(ledger?.version, RECALL_LEDGER_SCHEMA_VERSION);
      db.prepare("UPDATE memory_schema SET version = 99 WHERE component = 'recall_ledger'").run();
    } finally {
      db.close();
    }
    assert.throws(() => openRecallLedger(dbPath), /Unsupported recall_ledger schema version: 99/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeRecallBatch is idempotent on event_key, surfaces CHECK violations, and prunes expired parents cleanly", async () => {
  const root = await tempDir();
  try {
    const dbPath = join(root, MEMORY_DATABASE);
    const freshMs = Date.now();
    const oldMs = freshMs - 120 * 86_400_000;

    const first = writeRecallBatch(dbPath, [
      { kind: "query", record: sampleQuery({ eventKey: "whisperer:s1:m1", createdAtMs: oldMs }) },
      // Duplicate event_key in the same batch is ignored cleanly via ON CONFLICT(event_key) DO NOTHING.
      { kind: "query", record: sampleQuery({ eventKey: "whisperer:s1:m1", createdAtMs: oldMs }) },
    ]);
    assert.equal(first.written, 1);

    // Invalid CHECK constraint values must throw rather than being silently ignored.
    assert.throws(
      () => writeRecallBatch(dbPath, [{
        kind: "query",
        record: sampleQuery({ eventKey: "bad-outcome", outcome: "not_a_real_outcome" as never }),
      }]),
      /CHECK constraint failed/,
    );

    const dbRead = openRecallLedger(dbPath);
    const parentId = Number(dbRead.prepare("SELECT id FROM recall_queries WHERE event_key = 'whisperer:s1:m1'").get()?.id);
    dbRead.close();
    assert.ok(parentId > 0);

    const second = writeRecallBatch(
      dbPath,
      [
        {
          kind: "query",
          record: sampleQuery({
            eventKey: "drift:parent-1:fresh",
            source: "drift_rerun",
            createdAtMs: freshMs,
            parentQueryId: parentId,
          }),
        },
        {
          kind: "read",
          record: {
            eventKey: "get:tc-old",
            readAtMs: oldMs,
            agentId: "bill",
            sourcePath: "qmd://source-1/2026-01-01.md",
            status: "ok",
          },
        },
        {
          kind: "read",
          record: {
            eventKey: "get:tc-fresh",
            readAtMs: freshMs,
            agentId: "bill",
            sourcePath: "qmd://source-1/2026-11-20.md",
            startLine: 1,
            lineCount: 20,
            status: "ok",
          },
        },
      ],
      { retentionDays: 90, nowMs: freshMs, prune: true },
    );
    assert.equal(second.written, 3);
    assert.equal(second.pruned, 2);

    const verify = openRecallLedger(dbPath);
    try {
      const queries = verify.prepare("SELECT event_key, parent_query_id FROM recall_queries").all();
      assert.equal(queries.length, 1);
      assert.equal(queries[0]?.event_key, "drift:parent-1:fresh");
      assert.equal(queries[0]?.parent_query_id, null);
      const reads = verify.prepare("SELECT event_key, status FROM recall_reads").all();
      assert.equal(reads.length, 1);
      assert.equal(reads[0]?.event_key, "get:tc-fresh");
    } finally {
      verify.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RecallLedgerWriter reuses a persistent worker, orders purge behind queued writes, enforces global queue cap, and never blocks on SQLite locks", async () => {
  const root = await tempDir();
  try {
    const dbPath = join(root, MEMORY_DATABASE);
    const blocker = openRecallLedger(dbPath);
    blocker.exec("BEGIN IMMEDIATE");

    let drops = 0;
    const writer = new RecallLedgerWriter({
      retentionDays: 90,
      maxQueueSize: 3,
      onDrop: () => { drops++; },
    });

    const started = performance.now();
    assert.equal(writer.enqueue(dbPath, { kind: "query", record: sampleQuery({ eventKey: "w:1", senderId: "U-PURGE" }) }), true);
    assert.equal(writer.enqueue(dbPath, { kind: "query", record: sampleQuery({ eventKey: "w:2", senderId: "U-KEEP" }) }), true);
    assert.equal(writer.enqueue(dbPath, {
      kind: "read",
      record: { eventKey: "get:1", readAtMs: Date.now(), agentId: "bill", sourcePath: "qmd://s/MEMORY.md", status: "ok" },
    }), true);
    // 4th synchronous enqueue exceeds global maxQueueSize=3 and must drop cleanly.
    assert.equal(writer.enqueue(dbPath, { kind: "query", record: sampleQuery({ eventKey: "w:overflow" }) }), false);
    assert.ok(performance.now() - started < 200, "enqueue must be non-blocking");
    assert.equal(drops, 1);

    // Queue an ordered person purge behind the pending batch before releasing the DB lock.
    const purgePromise = writer.purgePerson(dbPath, { provider: "slack", accountId: "default", senderId: "U-PURGE" });

    await new Promise((resolve) => setTimeout(resolve, 120));
    blocker.exec("COMMIT");
    blocker.close();

    const purged = await purgePromise;
    assert.equal(purged.queries, 1);

    await writer.close();
    assert.equal(writer.enqueue(dbPath, { kind: "query", record: sampleQuery({ eventKey: "after-close" }) }), false);
    assert.equal(writer.stats().written, 3);
    assert.equal(writer.stats().errors, 0);

    const db = openRecallLedger(dbPath);
    try {
      const keys = db.prepare("SELECT event_key FROM recall_queries ORDER BY event_key").all().map((r) => r.event_key);
      assert.deepEqual(keys, ["w:2"]);
      assert.equal(Number(db.prepare("SELECT count(*) AS n FROM recall_reads").get()?.n), 1);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("purgeRecallPerson never creates tables in an uninitialized DB", async () => {
  const root = await tempDir();
  try {
    const emptyDb = join(root, "empty.sqlite");
    const dbInit = openMemoryDatabase(emptyDb);
    dbInit.close();
    assert.deepEqual(purgeRecallPerson(emptyDb, { provider: "slack", senderId: "U123" }), { queries: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchMemory onTrace distinguishes rank_limit, below_threshold, judge_failed, and cooldown", async () => {
  const hits: CorpusMemorySearchResult[] = [
    { path: "qmd://s/2026-11-20.md", startLine: 1, endLine: 2, score: 0.09, snippet: "Hit A high score", corpus: "memory", source: "memory" },
    { path: "qmd://s/2026-11-19.md", startLine: 1, endLine: 2, score: 0.08, snippet: "Hit B also high score", corpus: "memory", source: "memory" },
    { path: "qmd://s/2026-11-18.md", startLine: 1, endLine: 2, score: 0.07, snippet: "Hit C low score", corpus: "memory", source: "memory" },
    { path: "qmd://s/2026-11-17.md", startLine: 1, endLine: 2, score: 0.065, snippet: "Hit E fails judge", corpus: "memory", source: "memory" },
    { path: "qmd://s/2026-11-16.md", startLine: 1, endLine: 2, score: 0.06, snippet: "Hit D cooled down", corpus: "memory", source: "memory" },
  ];
  attachHitLocator(hits[0]!, {
    rawLeafId: "leaf-a", docHash: "hash-a", qmdSeq: 4, chunkPos: 0, chunkLen: 16,
    observedAtMs: Date.UTC(2026, 10, 20), observedAtBasis: "filename_date",
  });

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      if (body.includes("Hit E")) {
        res.statusCode = 500;
        res.end("boom");
        return;
      }
      const prob = body.includes("Hit A") ? 0.95 : body.includes("Hit B") ? 0.88 : 0.25;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "liquid/d1.2-ultra", answers: { memory_0: { type: "noul", noul: prob } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/v1/decisions`;

  try {
    const cooldown = new Map([[memoryPassageId(hits[4]!.snippet), 1]]);
    let traced: RecallCandidateTrace[] = [];
    const res = await searchMemory(
      { async searchCandidates() { return hits; } },
      { lex: "shoes", vec: "What shoes?" },
      {
        corpora: ["memory"],
        apiKey: "test-key",
        endpoint,
        model: "liquid/d1.2-ultra",
        timeoutMs: 2000,
        minUsefulness: 0.7,
        maxResults: 1,
        conversation: { currentRequest: "What shoes?", history: [] },
        excludedPassages: cooldown,
        onTrace: (items) => { traced = items; },
      },
    );
    assert.equal(res.rankingMode, "decision");
    assert.equal(res.results.length, 1);
    assert.equal("rawLeafId" in res.results[0]!, false);

    assert.equal(traced.length, 5);
    assert.equal(traced[0]?.disposition, "passed");
    assert.equal(traced[0]?.finalRank, 1);
    assert.equal(traced[0]?.locator.qmdSeq, 4);
    // Hit B scored 0.88 >= 0.7 but exceeded maxResults=1 -> rank_limit, NOT below_threshold.
    assert.equal(traced[1]?.disposition, "rank_limit");
    assert.equal(traced[1]?.usefulnessScore, 0.88);
    assert.equal(traced[2]?.disposition, "below_threshold");
    assert.equal(traced[3]?.disposition, "judge_failed");
    assert.equal(traced[4]?.disposition, "cooldown");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("QmdMemoryManager resolves content_vectors (docHash, qmdSeq) and rooted memory/**/*.md daily dates when trackRecallLocators is enabled", async () => {
  const root = await tempDir();
  try {
    const workspace = join(root, "ws");
    const memDir = join(workspace, "memory");
    await mkdir(memDir, { recursive: true });
    const body = "# Daily\n\nBek only wears Yeezys now.\n";
    const chunk = "Bek only wears Yeezys now.";
    const chunkPos = body.indexOf(chunk);
    await writeFile(join(memDir, "2026-11-20.md"), body, "utf8");

    const sources = resolveSources(workspace, [{ name: "memory", kind: "files", paths: ["memory/**/*.md"] }]);
    const dailySource = sources[0]!;
    const fileUri = `qmd://${dailySource.collection}/2026-11-20.md`;
    const docHash = sha256Text(body);

    const vecDb = new DatabaseSync(":memory:");
    vecDb.exec("CREATE TABLE content_vectors (hash TEXT NOT NULL, seq INTEGER NOT NULL, pos INTEGER NOT NULL, chunk_len INTEGER NOT NULL)");
    vecDb.prepare("INSERT INTO content_vectors VALUES (?, ?, ?, ?)").run(docHash, 7, chunkPos, chunk.length);

    const mockStore = {
      dbPath: join(root, "index.sqlite"),
      internal: { db: vecDb },
      async discoverCandidates({ lane }: { lane: string }) {
        return lane === "vec"
          ? [{ method: "vector", rank: 0, score: 0.91, file: fileUri, body, bestChunk: chunk, bestChunkPos: chunkPos }]
          : [];
      },
      async close() { vecDb.close(); },
    };

    const manager = new QmdMemoryManager({
      dbPath: join(root, "index.sqlite"),
      workspaceDir: workspace,
      sources,
      storeFactory: async () => mockStore as never,
      trackRecallLocators: true,
    });
    const hits = await manager.searchCandidates({ lex: "Yeezys", vec: "What shoes?" }, { corpora: ["memory"] });
    assert.equal(hits.length, 1);
    const locator = getHitLocator(hits[0]!);
    assert.ok(locator);
    assert.equal(locator.docHash, docHash);
    assert.equal(locator.qmdSeq, 7);
    assert.equal(locator.rawLeafId, memoryPassageId(chunk));
    assert.equal(locator.observedAtBasis, "filename_date");
    assert.equal(locator.observedAtMs, Date.UTC(2026, 10, 20));
    await manager.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registerMemoryWhisperer writes emitted, rank_limit (when complementaryHints=false), and thread origin to RecallLedgerWriter", async () => {
  const root = await tempDir();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const prob = body.includes("First memory") ? 0.96 : 0.89;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "liquid/d1.2-ultra", answers: { memory_0: { type: "noul", noul: prob } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/v1/decisions`;

  try {
    const dbPath = join(root, MEMORY_DATABASE);
    const writer = new RecallLedgerWriter({ retentionDays: 90 });
    const hits: CorpusMemorySearchResult[] = [
      { path: "qmd://s/2026-11-20.md", startLine: 1, endLine: 2, score: 0.09, snippet: "First memory excerpt", corpus: "memory", source: "memory" },
      { path: "qmd://s/2026-11-19.md", startLine: 1, endLine: 2, score: 0.08, snippet: "Second memory excerpt", corpus: "memory", source: "memory" },
    ];
    const api = {
      config: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      on() {},
    };
    const runtime = {
      async getMemorySearchManager() {
        return { manager: { async searchCandidates() { return hits; } } };
      },
    };
    const hook = registerMemoryWhisperer(
      api as never,
      runtime,
      {
        enabled: true,
        complementaryHints: false,
        corpora: ["memory"],
        minUsefulness: 0.7,
        maxHints: 1,
        cooldownTurns: 10,
        timeoutMs: 3000,
        api: { endpoint: "" },
      },
      { enabled: true, endpoint, model: "liquid/d1.2-ultra", apiKey: "k", timeoutMs: 2000 },
      undefined,
      { writer, dbPathForAgent: () => dbPath },
    );
    assert.ok(hook);
    const res = await hook(
      { prompt: "What shoes do I wear?", messages: [] } as never,
      {
        trigger: "user",
        agentId: "bill",
        runId: "run-w-1",
        sessionId: "sess-w-1",
        sessionKey: "agent:bill:slack:channel:c123",
        messageProvider: "slack",
        accountId: "default",
        senderId: "U123",
        channelId: "C123:thread:1700.01",
      } as never,
    );
    assert.ok(res && "appendContext" in res);
    await writer.close();

    const db = openRecallLedger(dbPath);
    try {
      const q = db.prepare("SELECT * FROM recall_queries").get() as Record<string, unknown>;
      assert.equal(q.outcome, "emitted");
      assert.equal(q.provider, "slack");
      assert.equal(q.channel_id, "c123");
      assert.equal(q.thread_id, "1700.01");
      assert.equal(q.chat_type, "channel");
      const h = db.prepare("SELECT disposition, final_rank FROM recall_hits ORDER BY retrieval_rank").all() as Array<{
        disposition: string;
        final_rank: number | null;
      }>;
      assert.deepEqual(h.map((row) => ({ ...row })), [
        { disposition: "emitted", final_rank: 1 },
        // Dropped by maxHints=1 with complementaryHints=false -> rank_limit, NOT redundant!
        { disposition: "rank_limit", final_rank: null },
      ]);
    } finally {
      db.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("parseDailyFilenameDateMs handles both rooted and prefixed paths and SessionMessageSpan stores timestampMs", () => {
  assert.equal(parseDailyFilenameDateMs("2026-09-14.md"), Date.UTC(2026, 8, 14));
  assert.equal(parseDailyFilenameDateMs("memory/2026-09-14.md"), Date.UTC(2026, 8, 14));
  assert.equal(parseDailyFilenameDateMs("qmd://src/2026-09-14.md"), Date.UTC(2026, 8, 14));
  assert.equal(parseDailyFilenameDateMs("2026-02-30.md"), undefined);
  assert.equal(parseDailyFilenameDateMs("MEMORY.md"), undefined);

  const ts = Date.UTC(2026, 7, 25, 18, 33, 2);
  const projected = projectSessionDocument({
    sessionId: "s-1",
    chatType: "channel",
    startedAt: ts,
    agentName: "Bill",
    timezone: "America/New_York",
    events: [
      {
        createdAt: ts,
        eventJson: JSON.stringify({
          type: "message",
          message: { role: "user", content: "I only wear Yeezys now." },
          timestamp: ts,
        }),
      },
    ],
  });
  assert.ok(projected);
  assert.equal(projected.messages[0]?.timestampMs, ts);
  const span = sessionContextSpans(projected.content, projected.messages[0]!.bodyStart, projected.messages);
  assert.equal(span?.message.timestampMs, ts);
});

test("registerMemoryWhisperer with complementaryHints=true labels redundant hits vs maxHints rank_limit accurately", async () => {
  const root = await tempDir();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const { questions } = JSON.parse(body) as { questions: Record<string, unknown> };
      if (questions.pair_0_1) {
        // Only Hit 2 is redundant with Hit 1; Hit 3 and Hit 4 are distinct.
        const answers = Object.fromEntries(Object.keys(questions).map(key =>
          [key, { type: "noul", noul: key === "pair_0_1" ? 0.96 : 0.1 }]));
        res.end(JSON.stringify({ model: "liquid/d1.2-ultra", answers }));
        return;
      }
      const prob = body.includes("Hit 1") ? 0.98 : body.includes("Hit 2") ? 0.94 : body.includes("Hit 3") ? 0.90 : 0.86;
      res.end(JSON.stringify({ model: "liquid/d1.2-ultra", answers: { memory_0: { type: "noul", noul: prob } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/v1/decisions`;

  try {
    const dbPath = join(root, MEMORY_DATABASE);
    const writer = new RecallLedgerWriter({ retentionDays: 90 });
    const hits: CorpusMemorySearchResult[] = [
      { path: "qmd://s/1.md", startLine: 1, endLine: 2, score: 0.09, snippet: "Hit 1 primary", corpus: "memory", source: "memory" },
      { path: "qmd://s/2.md", startLine: 1, endLine: 2, score: 0.08, snippet: "Hit 2 paraphrase", corpus: "memory", source: "memory" },
      { path: "qmd://s/3.md", startLine: 1, endLine: 2, score: 0.07, snippet: "Hit 3 distinct", corpus: "memory", source: "memory" },
      { path: "qmd://s/4.md", startLine: 1, endLine: 2, score: 0.06, snippet: "Hit 4 overflow", corpus: "memory", source: "memory" },
    ];
    const api = { config: {}, logger: { info() {}, warn() {}, error() {}, debug() {} }, on() {} };
    const runtime = { async getMemorySearchManager() { return { manager: { async searchCandidates() { return hits; } } }; } };
    const hook = registerMemoryWhisperer(
      api as never,
      runtime,
      {
        enabled: true,
        complementaryHints: true,
        corpora: ["memory"],
        minUsefulness: 0.7,
        maxHints: 2,
        cooldownTurns: 10,
        timeoutMs: 3000,
        api: { endpoint: "" },
      },
      { enabled: true, endpoint, model: "liquid/d1.2-ultra", apiKey: "k", timeoutMs: 2000 },
      undefined,
      { writer, dbPathForAgent: () => dbPath },
    );
    assert.ok(hook);
    await hook(
      { prompt: "Tell me everything", messages: [] } as never,
      { trigger: "user", agentId: "bill", runId: "run-c-1", sessionId: "sess-c-1" } as never,
    );
    await writer.close();

    const db = openRecallLedger(dbPath);
    try {
      const rows = db.prepare("SELECT disposition, final_rank FROM recall_hits ORDER BY retrieval_rank").all()
        .map((row) => ({ ...row }));
      assert.deepEqual(rows, [
        { disposition: "emitted", final_rank: 1 },
        { disposition: "redundant", final_rank: null },
        { disposition: "emitted", final_rank: 2 },
        { disposition: "rank_limit", final_rank: null },
      ]);
    } finally {
      db.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("RecallLedgerWriter close(timeoutMs) coalesces concurrent calls, rejects queued purges, counts drops, and safely bounds extreme ints", async () => {
  const root = await tempDir();
  try {
    const dbPath = join(root, MEMORY_DATABASE);
    // Extreme unsafe integer (e.g. 1e20) must not fail SQLite STRICT INTEGER or roll back neighbor rows.
    const safeBatch = writeRecallBatch(dbPath, [
      {
        kind: "read",
        record: {
          eventKey: "get:huge",
          readAtMs: Date.now(),
          agentId: "bill",
          sourcePath: "qmd://s/MEMORY.md",
          startLine: 1e20,
          lineCount: 1e20,
          status: "ok",
        },
      },
      { kind: "query", record: sampleQuery({ eventKey: "q:neighbor" }) },
    ]);
    assert.equal(safeBatch.written, 2);

    // Hold a write lock so the worker stalls past a short 150ms shutdown budget.
    const blocker = openRecallLedger(dbPath);
    blocker.exec("BEGIN IMMEDIATE");
    const writer = new RecallLedgerWriter({ retentionDays: 90 });
    writer.enqueue(dbPath, { kind: "query", record: sampleQuery({ eventKey: "q:blocked-1" }) });
    const queuedPurge = writer.purgePerson(dbPath, { provider: "slack", senderId: "U123" });
    writer.enqueue(dbPath, { kind: "query", record: sampleQuery({ eventKey: "q:blocked-2" }) });

    // Coalesce concurrent close() calls.
    const c1 = writer.close(150);
    const c2 = writer.close(150);
    assert.equal(c1, c2);
    await Promise.all([
      c1,
      assert.rejects(queuedPurge, /timed out/u),
    ]);
    blocker.exec("COMMIT");
    blocker.close();
    assert.ok(writer.stats().dropped >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiled dist/src/recall-ledger.js worker commits in plain Node even under --input-type=module", async () => {
  const root = await tempDir();
  try {
    const dbPath = join(root, MEMORY_DATABASE);
    const distUrl = new URL("../dist/src/recall-ledger.js", import.meta.url).href;
    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { RecallLedgerWriter, openRecallLedger } from ${JSON.stringify(distUrl)};
        const writer = new RecallLedgerWriter({ retentionDays: 90 });
        writer.enqueue(${JSON.stringify(dbPath)}, {
          kind: "read",
          record: { eventKey: "get:compiled-1", readAtMs: Date.now(), agentId: "bill", sourcePath: "qmd://s/MEMORY.md", status: "ok" }
        });
        await writer.close();
        const db = openRecallLedger(${JSON.stringify(dbPath)});
        const count = Number(db.prepare("SELECT count(*) AS n FROM recall_reads").get().n);
        db.close();
        console.log(JSON.stringify({ count, stats: writer.stats() }));
        `,
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout.trim()) as { count: number; stats: { written: number; errors: number } };
    assert.equal(parsed.count, 1);
    assert.equal(parsed.stats.written, 1);
    assert.equal(parsed.stats.errors, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
