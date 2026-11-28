import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, mkdtempDisposable, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { DiscoveryCandidate, QMDStore } from "@unblocklabs/qmd";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "../src/config.js";
import { DEFAULTS } from "../src/defaults.js";
import { MEMORY_DATABASE, openMemoryDatabase } from "../src/memory-database.js";
import { QmdMemoryManager } from "../src/manager.js";
import { memoryPassageId, searchMemory, type RecallCandidateTrace } from "../src/memory-search.js";
import { registerMemoryWhisperer } from "../src/memory-whisperer.js";
import { registerUnblockMemory } from "../src/plugin.js";
import {
  openRecallLedger,
  parseDailyFilenameDateMs,
  purgeRecallPerson,
  RECALL_LEDGER_SCHEMA_VERSION,
  RecallLedgerWriter,
  writeRecallBatch,
  type RecallQueryRecord,
} from "../src/recall-ledger.js";
import { projectSessionDocument, sessionContextSpans } from "../src/session-projector.js";
import type { QmdMemoryRuntime } from "../src/runtime.js";
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
        docHash: createHash("sha256").update(`# Daily\n${leaf}`).digest("hex"),
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

test("openRecallLedger migrates a populated v1 database without losing hits and rejects unknown versions", async () => {
  const root = await tempDir();
  try {
    const dbPath = join(root, MEMORY_DATABASE);
    writeRecallBatch(dbPath, [{ kind: "query", record: sampleQuery({ eventKey: "legacy" }) }]);
    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(`ALTER TABLE recall_queries DROP COLUMN input_tokens;
        ALTER TABLE recall_queries DROP COLUMN output_tokens;
        DROP TABLE skill_routing_events; DROP TABLE skill_open_events;
        UPDATE memory_schema SET version = 1 WHERE component = 'recall_ledger'`);
    } finally { legacy.close(); }
    writeRecallBatch(dbPath, [{ kind: "query", record: sampleQuery({ eventKey: "new", inputTokens: 80, outputTokens: 0 }) }]);
    const db = openRecallLedger(dbPath);
    try {
      const storage = db.prepare("SELECT version FROM memory_schema WHERE component = 'storage'").get();
      const ledger = db.prepare("SELECT version FROM memory_schema WHERE component = 'recall_ledger'").get();
      assert.equal(storage?.version, 1);
      assert.equal(RECALL_LEDGER_SCHEMA_VERSION, 1, "additive-only changes keep v1 so a v0.16.0 rollback still opens the ledger");
      assert.equal(ledger?.version, 1);
      for (const table of ["skill_routing_events", "skill_open_events"]) {
        assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table), `${table} healed on open`);
      }
      assert.deepEqual(db.prepare(`SELECT event_key, input_tokens, output_tokens FROM recall_queries q
        JOIN recall_hits h ON h.query_id = q.id ORDER BY q.id`).all().map(row => [row.event_key, row.input_tokens, row.output_tokens]),
        [["legacy", null, null], ["new", 80, 0]]);
      db.prepare("UPDATE memory_schema SET version = 99 WHERE component = 'recall_ledger'").run();
    } finally {
      db.close();
    }
    assert.throws(() => openRecallLedger(dbPath), /Unsupported recall_ledger schema version: 99/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the writer upgrades unstamped v1 exposure tables and preserves historical recipes on reopen", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "recall-ledger-recipes-"));
  const dbPath = join(directory.path, MEMORY_DATABASE);
  const now = Date.now();
  const events = (eventKey: string, recipeHash?: string) => [
    { kind: "query", record: sampleQuery({ eventKey, createdAtMs: now, recipeHash }) },
    { kind: "skill_routing", record: { eventKey, createdAtMs: now, agentId: "bill", mode: "direct",
      candidateCount: 1, emitted: ["/skills/a/SKILL.md"], scores: [], outcome: "emitted", recipeHash } },
  ] as const;
  const tables = ["recall_queries", "skill_routing_events"];
  writeRecallBatch(dbPath, events("legacy"));
  const legacy = new DatabaseSync(dbPath);
  try {
    const hasRecipe = legacy.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name='recipe_hash'");
    for (const table of tables) {
      if (hasRecipe.get(table)) legacy.exec(`ALTER TABLE ${table} DROP COLUMN recipe_hash`);
    }
  } finally { legacy.close(); }

  const writer = new RecallLedgerWriter();
  for (const event of [...events("a", "recipe-a"), ...events("b", "recipe-b"), ...events("blank", " \t ")]) {
    writer.enqueue(dbPath, event);
  }
  await writer.close();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const table of tables) {
      const rows = db.prepare(`SELECT event_key, recipe_hash FROM ${table} ORDER BY id`).all();
      assert.deepEqual(rows.map(row => [row.event_key, row.recipe_hash]),
        [["legacy", "default"], ["a", "recipe-a"], ["b", "recipe-b"], ["blank", "default"]]);
    }
    assert.equal(db.prepare("SELECT version FROM memory_schema WHERE component = 'recall_ledger'").get()?.version, 1);
  } finally { db.close(); }
  openRecallLedger(dbPath).close();
});

test("writeRecallBatch is idempotent on event_key, surfaces CHECK violations, and prunes expired parents cleanly", async () => {
  const root = await tempDir();
  try {
    const dbPath = join(root, MEMORY_DATABASE);
    const freshMs = Date.now();
    const oldMs = freshMs - 120 * 86_400_000;
    const skillEvents = (createdAtMs: number) => [
      { kind: "skill_routing", record: { eventKey: String(createdAtMs), createdAtMs, agentId: "bill", mode: "direct",
        candidateCount: 0, emitted: [], scores: [], outcome: "no_candidates" } },
      { kind: "skill_open", record: { createdAtMs, agentId: "bill", skillPath: "/skills/a/SKILL.md", toolName: "read",
        wasWhispered: false, wasPinned: false } },
    ] as const;

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
        ...skillEvents(oldMs), ...skillEvents(freshMs),
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
    assert.equal(second.written, 7);
    assert.equal(second.pruned, 4);

    const verify = openRecallLedger(dbPath);
    try {
      const queries = verify.prepare("SELECT event_key, parent_query_id FROM recall_queries").all();
      assert.equal(queries.length, 1);
      assert.equal(queries[0]?.event_key, "drift:parent-1:fresh");
      assert.equal(queries[0]?.parent_query_id, null);
      const reads = verify.prepare("SELECT event_key, status FROM recall_reads").all();
      assert.equal(reads.length, 1);
      assert.equal(reads[0]?.event_key, "get:tc-fresh");
      for (const table of ["skill_routing_events", "skill_open_events"]) {
        assert.deepEqual(verify.prepare(`SELECT created_at_ms FROM ${table}`).all().map(row => row.created_at_ms), [freshMs]);
      }
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
    assert.deepEqual(purgeRecallPerson(emptyDb, { provider: "slack", senderId: "U123" }), { queries: 0, skillEvents: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchMemory onTrace distinguishes rank_limit, below_threshold, judge_failed, and cooldown", async () => {
  const hits: CorpusMemorySearchResult[] = [
    { path: "qmd://s/2026-11-20.md", startLine: 1, endLine: 2, score: 0.09, snippet: "Hit A high score", corpus: "memory", source: "memory",
      locator: { rawLeafId: "leaf-a", docHash: "hash-a", qmdSeq: 4, chunkPos: 0, chunkLen: 16,
        observedAtMs: Date.UTC(2026, 10, 20), observedAtBasis: "filename_date" } },
    { path: "qmd://s/2026-11-19.md", startLine: 1, endLine: 2, score: 0.08, snippet: "Hit B also high score", corpus: "memory", source: "memory" },
    { path: "qmd://s/2026-11-18.md", startLine: 1, endLine: 2, score: 0.07, snippet: "Hit C low score", corpus: "memory", source: "memory" },
    { path: "qmd://s/2026-11-17.md", startLine: 1, endLine: 2, score: 0.065, snippet: "Hit E fails judge", corpus: "memory", source: "memory" },
    { path: "qmd://s/2026-11-16.md", startLine: 1, endLine: 2, score: 0.06, snippet: "Hit D cooled down", corpus: "memory", source: "memory" },
  ];
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
      res.end(JSON.stringify({ model: "liquid/d1.2-ultra", answers: { memory_0: { type: "noul", noul: prob } },
        usage: { input_tokens: body.includes("Hit A") ? 100 : 10, output_tokens: 3 } }));
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
    // Judged A, B, C report usage; E failed and D was cooled down (never judged).
    assert.equal(res.inputTokens, 120, "decision input tokens are summed across judged candidates");
    assert.equal(res.outputTokens, 9);

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

test("memory_search records canonical vector and lexical locators without exposing them or querying QMD's database", async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "recall-ledger-tool-"));
  const workspace = directory.path;
  await mkdir(join(workspace, "memory"));
  const sources = resolveSources(workspace, [{ name: "memory", kind: "files", paths: ["memory/**/*.md"] }]);
  const { collection } = sources[0]!;
  const dbPath = join(workspace, MEMORY_DATABASE);
  const candidate = (path: string, bestChunk: string, docHash: string, seq: number | null): DiscoveryCandidate => {
    const heading = "# Daily\n\n";
    return {
      file: `qmd://${collection}/${path}`, displayPath: `${collection}/${path}`, title: "Daily", context: null,
      docid: docHash.slice(0, 6), body: `${heading}${bestChunk}\n`, bestChunk, bestChunkPos: heading.length,
      method: seq === null ? "bm25" : "vector", rank: 0, score: 0.91,
      ref: { collection, path, docHash, chunkPos: heading.length, chunkLen: bestChunk.length,
        seq, embedFingerprint: seq === null ? null : "test-fingerprint" },
    };
  };
  const lexical = candidate("2026-11-19.md", "Shoes are stored by the door.", "canonical-lexical-hash", null);
  const vector = candidate("2026-11-20.md", "Bek only wears Yeezys now.", "canonical-vector-hash", 7);
  const qmdDb = new DatabaseSync(":memory:");
  const prepare = t.mock.method(qmdDb, "prepare");
  const mockStore = {
    dbPath: join(workspace, "index.sqlite"),
    internal: { db: qmdDb },
    async discoverCandidates({ lane }) { return [lane === "lex" ? lexical : vector]; },
    async close() { qmdDb.close(); },
  } satisfies Pick<QMDStore, "dbPath" | "discoverCandidates" | "close"> & { internal: object };
  const manager = new QmdMemoryManager({
    dbPath: mockStore.dbPath, workspaceDir: workspace, sources,
    storeFactory: async () => mockStore as unknown as QMDStore, trackRecallLocators: true,
  });
  type Payload = { details: { results: unknown[] }; content: { text: string }[] };
  type ToolFactory = (ctx: OpenClawPluginToolContext) => { execute(id: string, params: unknown): Promise<Payload> };
  let createSearch: ToolFactory | undefined;
  const stop: (() => unknown)[] = [];
  const warnings: string[] = [];
  registerUnblockMemory({
    pluginConfig: { recallLedger: { enabled: true }, decisionModel: { enabled: false } },
    logger: { warn(message: string) { warnings.push(message); } },
    registerCli() {}, registerService() {}, registerGatewayMethod() {},
    on(event: string, handler: () => unknown) { if (event === "gateway_stop") stop.push(handler); },
    registerMemoryCapability({ runtime }: { runtime: QmdMemoryRuntime }) {
      t.mock.method(runtime, "getMemorySearchManager", async () => ({ manager }));
      t.mock.method(runtime, "memoryDatabasePath", () => dbPath);
    },
    registerTool(factory: ToolFactory, { names }: { names: string[] }) {
      if (names.includes("memory_search")) createSearch = factory;
    },
  } as unknown as OpenClawPluginApi);
  let response: Payload;
  try {
    assert.ok(createSearch);
    response = await createSearch({ agentId: "bill", config: {} })
      .execute("search", { bm25Query: "Shoes", vectorQuery: "What shoes?" });
  } finally {
    await Promise.all([...stop.map(handler => handler()), manager.close()]);
  }
  assert.deepEqual(prepare.mock.calls.filter(({ arguments: [sql] }) => /\bcontent_vectors\b/i.test(sql)), []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(JSON.parse(response.content[0]!.text), response.details);
  assert.deepEqual(response.details.results, [lexical, vector].map(hit => ({
    path: hit.file, startLine: 3, endLine: 3, score: 1 / 61 + 0.05, snippet: hit.bestChunk, corpus: "memory",
  })));

  const db = openRecallLedger(dbPath);
  try {
    const rows = db.prepare(`SELECT doc_hash, qmd_seq, chunk_pos, chunk_len, raw_leaf_id, observed_at_ms, observed_at_basis
      FROM recall_hits ORDER BY retrieval_rank`).all();
    assert.deepEqual(rows.map(row => ({ ...row })), [lexical, vector].map(hit => ({
      doc_hash: hit.ref!.docHash, qmd_seq: hit.ref!.seq, chunk_pos: hit.bestChunkPos, chunk_len: hit.bestChunk.length,
      raw_leaf_id: memoryPassageId(hit.bestChunk), observed_at_ms: Date.parse(hit.ref!.path.replace(".md", "")),
      observed_at_basis: "filename_date",
    })));
  } finally { db.close(); }
});

test("registerMemoryWhisperer writes emitted, rank_limit (when complementaryHints=false), and thread origin to RecallLedgerWriter", async () => {
  const root = await tempDir();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const prob = body.includes("First memory") ? 0.96 : 0.89;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "liquid/d1.2-ultra", answers: { memory_0: { type: "noul", noul: prob } },
        ...(body.includes("memory excerpt") ? { usage: { input_tokens: 40, output_tokens: 2 } } : {}) }));
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
      assert.equal(q.input_tokens, 80, "both judged passages' decision tokens reach recall_queries");
      assert.equal(q.output_tokens, 4);
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
      const { questions = {} } = JSON.parse(body) as { questions?: Record<string, unknown> };
      if (req.url?.endsWith("/v1/extractions")) {
        res.end(JSON.stringify({ model: "liquid/d1.2-ultra", answers: { topics: { type: "list", value: [] } } }));
        return;
      }
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

test("a pre-release v2 ledger heals back to v1 and a v1 ledger missing additive objects self-heals on open", async () => {
  const root = await tempDir();
  try {
    const dbPath = join(root, MEMORY_DATABASE);
    writeRecallBatch(dbPath, [{ kind: "query", record: sampleQuery({ eventKey: "pre" }) }]);
    const raw = new DatabaseSync(dbPath);
    try { raw.exec("UPDATE memory_schema SET version = 2 WHERE component = 'recall_ledger'"); } finally { raw.close(); }
    let db = openRecallLedger(dbPath);
    try {
      assert.equal(db.prepare("SELECT version FROM memory_schema WHERE component = 'recall_ledger'").get()?.version, 1);
      assert.equal(Number(db.prepare("SELECT count(*) n FROM recall_queries").get()?.n), 1, "healing keeps rows");
      // A v1 stamp whose additive table vanished (rollback, then roll forward) is not trusted by the fast path.
      db.exec("DROP TABLE skill_open_events");
    } finally { db.close(); }
    db = openRecallLedger(dbPath);
    try {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='skill_open_events'").get());
      assert.equal(db.prepare("SELECT version FROM memory_schema WHERE component = 'recall_ledger'").get()?.version, 1);
    } finally { db.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recall_queries carries the (agent_id, run_id, created_at_ms) index the Skills pass reads by, also on an existing v1 ledger", async () => {
  const root = await tempDir();
  try {
    const dbPath = join(root, MEMORY_DATABASE);
    writeRecallBatch(dbPath, [{ kind: "query", record: sampleQuery({ eventKey: "indexed" }) }]);
    const indexColumns = (db: DatabaseSync) => db.prepare("SELECT name FROM pragma_index_info('recall_queries_agent_run') ORDER BY seqno")
      .all().map(row => row.name);
    let db = openRecallLedger(dbPath);
    try {
      assert.deepEqual(indexColumns(db), ["agent_id", "run_id", "created_at_ms"]);
      db.exec("DROP INDEX recall_queries_agent_run"); // a v1 ledger written before the index shipped
    } finally { db.close(); }
    db = openRecallLedger(dbPath);
    try {
      assert.deepEqual(indexColumns(db), ["agent_id", "run_id", "created_at_ms"], "the fast path does not skip the missing index");
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT run_id FROM recall_queries WHERE agent_id=? AND run_id=? AND created_at_ms>=?`)
        .all("main", "r", 0).map(row => String(row.detail)).join("\n");
      assert.match(plan, /recall_queries_agent_run/u);
    } finally { db.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("purging a person also erases skill routing and open events bound to their sessions and runs", async () => {
  const root = await tempDir();
  try {
    const dbPath = join(root, MEMORY_DATABASE);
    const now = Date.now();
    const routing = (eventKey: string, ctx: { agentId?: string; sessionId?: string; sessionKey?: string; runId?: string }) => ({
      kind: "skill_routing" as const, record: { eventKey, createdAtMs: now, agentId: ctx.agentId ?? "bill", sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey, runId: ctx.runId, mode: "direct" as const, candidateCount: 1, emitted: ["/skills/a/SKILL.md"],
        scores: [{ path: "/skills/a/SKILL.md", name: "a", score: 0.9 }], outcome: "emitted" } });
    const open = (ctx: { agentId?: string; sessionId?: string; sessionKey?: string; runId?: string }) => ({
      kind: "skill_open" as const, record: { createdAtMs: now, agentId: ctx.agentId ?? "bill", sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey, runId: ctx.runId, skillPath: "/skills/a/SKILL.md", toolName: "read" as const,
        wasWhispered: true, wasPinned: true } });
    writeRecallBatch(dbPath, [
      { kind: "query", record: sampleQuery({ eventKey: "purged-1", sessionId: "s-purge", sessionKey: "k-purge", runId: "r-purge" }) },
      { kind: "query", record: sampleQuery({ eventKey: "kept-1", senderId: "U-OTHER", sessionId: "s-keep", sessionKey: "k-keep", runId: "r-keep" }) },
      routing("route-by-session", { sessionId: "s-purge" }),
      routing("route-by-key", { sessionKey: "k-purge" }),
      routing("route-by-run", { runId: "r-purge" }),
      routing("route-other-agent", { agentId: "other", sessionId: "s-purge" }),
      routing("route-kept", { sessionId: "s-keep", sessionKey: "k-keep", runId: "r-keep" }),
      open({ sessionId: "s-purge" }),
      open({ runId: "r-purge" }),
      open({ sessionId: "s-keep" }),
    ]);
    assert.deepEqual(purgeRecallPerson(dbPath, { provider: "slack", accountId: "default", senderId: "U123" }), { queries: 1, skillEvents: 5 });
    const db = openRecallLedger(dbPath);
    try {
      assert.deepEqual(db.prepare("SELECT event_key FROM recall_queries").all().map(r => r.event_key), ["kept-1"]);
      assert.deepEqual(db.prepare("SELECT event_key FROM skill_routing_events ORDER BY event_key").all().map(r => r.event_key),
        ["route-kept", "route-other-agent"], "other sessions and other agents keep their routing events");
      assert.deepEqual(db.prepare("SELECT session_id FROM skill_open_events").all().map(r => r.session_id), ["s-keep"]);
    } finally { db.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("purging one sender in a shared session never erases another sender's routing or open events", async () => {
  const root = await tempDir();
  try {
    const dbPath = join(root, MEMORY_DATABASE);
    const now = Date.now();
    // Memory Whisperer off: no recall_queries at all, only Skill Whisperer's attributed routing rows + open events.
    const shared = { agentId: "main", sessionId: "main-session", sessionKey: "agent:main:main" };
    const routing = (senderId: string, runId: string) => ({
      kind: "skill_routing" as const, record: { ...shared, eventKey: `route-${senderId}`, createdAtMs: now, runId,
        provider: "slack", accountId: "default", senderId, requestText: `request from ${senderId}`, chatType: "direct",
        mode: "direct" as const, candidateCount: 1, emitted: ["/skills/a/SKILL.md"],
        scores: [{ path: "/skills/a/SKILL.md", name: "a", score: 0.9 }], outcome: "emitted" } });
    const open = (runId: string | undefined) => ({
      kind: "skill_open" as const, record: { ...shared, createdAtMs: now, runId, skillPath: "/skills/a/SKILL.md",
        toolName: "read" as const, wasWhispered: true, wasPinned: true } });
    writeRecallBatch(dbPath, [routing("UA", "run-a"), open("run-a"), routing("UB", "run-b"), open("run-b"), open(undefined)]);
    assert.deepEqual(purgeRecallPerson(dbPath, { provider: "slack", accountId: "default", senderId: "UA" }),
      { queries: 0, skillEvents: 2 }, "exactly sender A's routing row and open event");
    const db = openRecallLedger(dbPath);
    try {
      assert.deepEqual(db.prepare("SELECT sender_id, request_text FROM skill_routing_events").all().map(r => ({ ...r })),
        [{ sender_id: "UB", request_text: "request from UB" }], "sender B's routing row survives the shared session key");
      assert.deepEqual(db.prepare("SELECT run_id FROM skill_open_events ORDER BY id").all().map(r => r.run_id), ["run-b", null],
        "B's open event and the run-less event of a session B also uses both survive");
    } finally { db.close(); }
    assert.deepEqual(purgeRecallPerson(dbPath, { provider: "slack", accountId: "default", senderId: "UB" }),
      { queries: 0, skillEvents: 3 }, "once no other sender shares the session, its run-less open event goes too");
    // Shared session where B's recall query identifies B, but B's routing row is senderless (legacy):
    // purging A must preserve B's query, B's senderless routing row, AND B's run-bound open event!
    writeRecallBatch(dbPath, [
      { kind: "query", record: { ...shared, eventKey: "q-b", createdAtMs: now, runId: "run-b2", source: "whisperer",
        provider: "slack", accountId: "default", senderId: "UB", chatType: "direct", queryFallback: false,
        corpora: ["memory"], rankingMode: "retrieval", outcome: "emitted", hits: [] } },
      { kind: "skill_routing", record: { ...shared, eventKey: "route-b2-legacy", createdAtMs: now, runId: "run-b2",
        mode: "direct", candidateCount: 1, emitted: ["/skills/a/SKILL.md"],
        scores: [{ path: "/skills/a/SKILL.md", name: "a", score: 0.9 }], outcome: "emitted" } },
      open("run-b2"),
      routing("UA", "run-a2"),
      open("run-a2"),
    ]);
    assert.deepEqual(purgeRecallPerson(dbPath, { provider: "slack", accountId: "default", senderId: "UA" }),
      { queries: 0, skillEvents: 2 }, "purging A deletes only A's attributed routing + open event, never B's");
    const db2 = openRecallLedger(dbPath);
    try {
      assert.deepEqual(db2.prepare("SELECT run_id FROM skill_open_events").all().map(r => r.run_id), ["run-b2"],
        "B's run-bound open event survives even when B's routing row was senderless");
      assert.deepEqual(db2.prepare("SELECT run_id FROM skill_routing_events").all().map(r => r.run_id), ["run-b2"],
        "B's senderless routing row survives in a shared session");
    } finally { db2.close(); }
    // Shared session with Memory Whisperer OFF: B has ONLY a pre-upgrade senderless route + open event (no attributed
    // row for B at all). Purging A must preserve B's senderless route, B's run-bound open event, AND run-less open!
    writeRecallBatch(dbPath, [
      { kind: "skill_routing", record: { ...shared, agentId: "solo-off", eventKey: "route-b3-legacy", createdAtMs: now,
        runId: "run-b3", mode: "direct", candidateCount: 1, emitted: ["/skills/a/SKILL.md"],
        scores: [{ path: "/skills/a/SKILL.md", name: "a", score: 0.9 }], outcome: "emitted" } },
      { kind: "skill_open", record: { ...shared, agentId: "solo-off", createdAtMs: now, runId: "run-b3",
        skillPath: "/skills/a/SKILL.md", toolName: "read", wasWhispered: true, wasPinned: true } },
      { kind: "skill_open", record: { ...shared, agentId: "solo-off", createdAtMs: now,
        skillPath: "/skills/a/SKILL.md", toolName: "read", wasWhispered: true, wasPinned: true } },
      { kind: "skill_routing", record: { ...shared, agentId: "solo-off", eventKey: "route-a3", createdAtMs: now,
        runId: "run-a3", provider: "slack", accountId: "default", senderId: "UA", requestText: "private A3",
        chatType: "direct", mode: "direct", candidateCount: 1, emitted: ["/skills/a/SKILL.md"],
        scores: [{ path: "/skills/a/SKILL.md", name: "a", score: 0.9 }], outcome: "emitted" } },
      { kind: "skill_open", record: { ...shared, agentId: "solo-off", createdAtMs: now, runId: "run-a3",
        skillPath: "/skills/a/SKILL.md", toolName: "read", wasWhispered: true, wasPinned: true } },
    ]);
    assert.deepEqual(purgeRecallPerson(dbPath, { provider: "slack", accountId: "default", senderId: "UA" }),
      { queries: 0, skillEvents: 2 }, "purging A deletes only A's 2 events even when B has no attributed rows");
    const db3 = openRecallLedger(dbPath);
    try {
      assert.deepEqual(db3.prepare("SELECT run_id FROM skill_routing_events WHERE agent_id = 'solo-off'").all().map(r => r.run_id),
        ["run-b3"], "B's pre-upgrade senderless route survives");
      assert.deepEqual(db3.prepare("SELECT run_id FROM skill_open_events WHERE agent_id = 'solo-off' ORDER BY id").all().map(r => r.run_id),
        ["run-b3", null], "B's run-bound open event and shared run-less open event survive");
    } finally { db3.close(); }
    // Account-scoped purge erases an account-less direct route `(slack, NULL, UA)` tied to the same run as UA's query,
    // without touching a route belonging to another account on any run.
    writeRecallBatch(dbPath, [
      { kind: "query", record: { ...shared, agentId: "acct", eventKey: "q-acct", createdAtMs: now, runId: "run-acct",
        source: "whisperer", provider: "slack", accountId: "default", senderId: "UA", chatType: "direct",
        queryFallback: false, corpora: ["memory"], rankingMode: "retrieval", outcome: "emitted", hits: [] } },
      { kind: "skill_routing", record: { ...shared, agentId: "acct", eventKey: "route-acct-null", createdAtMs: now,
        runId: "run-acct", provider: "slack", senderId: "UA", requestText: "private without account",
        chatType: "direct", mode: "direct", candidateCount: 1, emitted: ["/skills/a/SKILL.md"],
        scores: [{ path: "/skills/a/SKILL.md", name: "a", score: 0.9 }], outcome: "emitted" } },
      { kind: "skill_routing", record: { ...shared, agentId: "acct", eventKey: "route-acct-other", createdAtMs: now,
        runId: "run-other-acct", provider: "slack", accountId: "work", senderId: "UA", requestText: "work account",
        chatType: "direct", mode: "direct", candidateCount: 1, emitted: ["/skills/a/SKILL.md"],
        scores: [{ path: "/skills/a/SKILL.md", name: "a", score: 0.9 }], outcome: "emitted" } },
    ]);
    assert.deepEqual(purgeRecallPerson(dbPath, { provider: "slack", accountId: "default", senderId: "UA" }),
      { queries: 1, skillEvents: 1 }, "account-scoped purge erases same-run account-less route for that sender");
    const db4 = openRecallLedger(dbPath);
    try {
      assert.deepEqual(db4.prepare("SELECT event_key FROM skill_routing_events WHERE agent_id = 'acct'").all().map(r => r.event_key),
        ["route-acct-other"], "other account's route survives");
    } finally { db4.close(); }
    // Candidate-level foreign check: A has `(session-a, shared key)`, B has legacy run-bound route `(session-b, no key)`
    // plus run-less route and open event on `(session-b, shared key)`. Purging A must preserve ALL 3 of B's rows!
    writeRecallBatch(dbPath, [
      { kind: "skill_routing", record: { agentId: "split-sess", sessionId: "session-a", sessionKey: "agent:split-sess:main",
        eventKey: "route-a4", createdAtMs: now, runId: "run-a4", provider: "slack", accountId: "default", senderId: "UA",
        requestText: "private A4", chatType: "direct", mode: "direct", candidateCount: 1, emitted: ["/skills/a/SKILL.md"],
        scores: [{ path: "/skills/a/SKILL.md", name: "a", score: 0.9 }], outcome: "emitted" } },
      { kind: "skill_routing", record: { agentId: "split-sess", sessionId: "session-b",
        eventKey: "route-b4-run", createdAtMs: now, runId: "run-b4", mode: "direct", candidateCount: 1,
        emitted: ["/skills/a/SKILL.md"], scores: [{ path: "/skills/a/SKILL.md", name: "a", score: 0.9 }], outcome: "emitted" } },
      { kind: "skill_routing", record: { agentId: "split-sess", sessionId: "session-b", sessionKey: "agent:split-sess:main",
        eventKey: "route-b4-runless", createdAtMs: now, mode: "direct", candidateCount: 1,
        emitted: ["/skills/a/SKILL.md"], scores: [{ path: "/skills/a/SKILL.md", name: "a", score: 0.9 }], outcome: "emitted" } },
      { kind: "skill_open", record: { agentId: "split-sess", sessionId: "session-b", sessionKey: "agent:split-sess:main",
        createdAtMs: now, skillPath: "/skills/a/SKILL.md", toolName: "read", wasWhispered: true, wasPinned: true } },
    ]);
    assert.deepEqual(purgeRecallPerson(dbPath, { provider: "slack", accountId: "default", senderId: "UA" }),
      { queries: 0, skillEvents: 1 }, "purging A erases only A's route, never B's run-less events on another sessionId");
    const db5 = openRecallLedger(dbPath);
    try {
      assert.deepEqual(db5.prepare("SELECT event_key FROM skill_routing_events WHERE agent_id = 'split-sess' ORDER BY event_key").all().map(r => r.event_key),
        ["route-b4-run", "route-b4-runless"], "both B's run-bound and run-less routes survive");
      assert.equal(Number(db5.prepare("SELECT count(*) AS n FROM skill_open_events WHERE agent_id = 'split-sess'").get()?.n),
        1, "B's run-less open event survives");
    } finally { db5.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory_search writes summed decision-judge token usage into recall_queries", async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "recall-ledger-usage-"));
  const dbPath = join(directory.path, MEMORY_DATABASE);
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "liquid/d1.2-ultra", answers: { memory_0: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: body.includes("Alpha") ? 70 : 30, output_tokens: 5 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const hits: CorpusMemorySearchResult[] = [
    { path: "qmd://s/2026-11-20.md", startLine: 1, endLine: 2, score: 0.09, snippet: "Alpha memory", corpus: "memory", source: "memory" },
    { path: "qmd://s/2026-11-19.md", startLine: 1, endLine: 2, score: 0.08, snippet: "Beta memory", corpus: "memory", source: "memory" },
  ];
  type ToolFactory = (ctx: OpenClawPluginToolContext) => { execute(id: string, params: unknown): Promise<unknown> };
  let createSearch: ToolFactory | undefined;
  const stop: (() => unknown)[] = [];
  registerUnblockMemory({
    pluginConfig: { recallLedger: { enabled: true },
      decisionModel: { endpoint: `http://127.0.0.1:${address.port}/v1/decisions`, apiKey: "k", timeoutMs: 2000 } },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    registerCli() {}, registerService() {}, registerGatewayMethod() {},
    on(event: string, handler: () => unknown) { if (event === "gateway_stop") stop.push(handler); },
    registerMemoryCapability({ runtime }: { runtime: QmdMemoryRuntime }) {
      t.mock.method(runtime, "getMemorySearchManager", async () => ({ manager: { async searchCandidates() { return hits; } } }));
      t.mock.method(runtime, "memoryDatabasePath", () => dbPath);
    },
    registerTool(factory: ToolFactory, { names }: { names: string[] }) {
      if (names.includes("memory_search")) createSearch = factory;
    },
  } as unknown as OpenClawPluginApi);
  try {
    assert.ok(createSearch);
    await createSearch({ agentId: "bill", config: {} }).execute("usage", { bm25Query: "memory", vectorQuery: "Which memory?" });
  } finally {
    await Promise.all(stop.map(handler => handler()));
  }
  const db = openRecallLedger(dbPath);
  try {
    const row = db.prepare("SELECT source, ranking_mode, input_tokens, output_tokens FROM recall_queries").get();
    assert.deepEqual({ ...row }, { source: "tool", ranking_mode: "decision", input_tokens: 100, output_tokens: 10 });
  } finally { db.close(); }
});

test("skill_routing_events gains additive request_text / chat_type columns and persists the routed request", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "recall-ledger-request-text-"));
  const dbPath = join(directory.path, MEMORY_DATABASE);
  const now = Date.now();
  const routing = (eventKey: string, patch: { requestText?: string; chatType?: string } = {}) => ({ kind: "skill_routing" as const,
    record: { eventKey, createdAtMs: now, agentId: "bill", runId: eventKey, mode: "direct" as const, candidateCount: 1,
      emitted: [], scores: [], outcome: "rejected", ...patch } });
  writeRecallBatch(dbPath, [routing("legacy")]);
  // A database from before the columns existed.
  const legacy = new DatabaseSync(dbPath);
  try {
    for (const column of ["request_text", "chat_type"]) legacy.exec(`ALTER TABLE skill_routing_events DROP COLUMN ${column}`);
  } finally { legacy.close(); }
  writeRecallBatch(dbPath, [routing("routed", { requestText: "ship the release", chatType: " Channel " }), routing("blank", { requestText: "  " })]);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT event_key, request_text, chat_type FROM skill_routing_events ORDER BY id").all();
    assert.deepEqual(rows.map(row => [row.event_key, row.request_text, row.chat_type]),
      [["legacy", null, null], ["routed", "ship the release", "channel"], ["blank", null, null]]);
  } finally { db.close(); }
});
