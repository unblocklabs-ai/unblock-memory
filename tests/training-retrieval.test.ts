import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay, setImmediate as yieldToEventLoop } from "node:timers/promises";
import { createStore, type QMDStore } from "@unblocklabs/qmd";
import { historicalPrefix, historicalTrainingSearch, historicalTrainingSource, HistoricalCorpusUnavailableError } from "../src/training-retrieval.js";
import { projectSessionDocument } from "../src/session-projector.js";
import { resolveSessionSource } from "../src/sources.js";
import { trainingExamples } from "../src/training-input.js";
import { trainingCandidates } from "../src/training-candidates.js";
import { renderMemoryPassage } from "../src/memory-passage.js";
import { QmdMemoryManager } from "../src/manager.js";
import { judgeMemoryPassage, memoryUsefulnessRequest } from "../src/decision-ranking.js";
import { contextJudgeRequest, judgeTrainingPassage } from "../src/training-judge.js";

const queries = Array.from({length: 10}, (_, i) => `Atlas decision ${i}`);

test("query lanes retrieve ten candidates from only their backend with literal keyword semantics", async t => {
  const qmd = await createStore({ dbPath: ":memory:", config: { collections: { sessions: { path: "/unused", pattern: "*.md" } } } });
  try {
    for (let i = 0; i < 12; i++) {
      qmd.internal.insertContent(`lex${i}`, `Exactneedle useful evidence ${i}`, "2026-01-01");
      qmd.internal.insertDocument("sessions", `lex${i}.md`, "Transcript", `lex${i}`, "2026-01-01", "2026-01-01");
    }
    qmd.internal.db.exec("CREATE TABLE vectors_vec (hash_seq TEXT PRIMARY KEY, embedding BLOB)");
    const vector = t.mock.method(qmd.internal, "searchVec", async (_query: string, _model: string, limit: number) => {
      assert.equal(limit, 10);
      return Array.from({ length: 10 }, (_, i) => ({ filepath: `qmd://sessions/vec${i}.md`, body: "Other evidence",
        chunkPos: 0, chunkLen: 14, score: 0.9 }));
    });
    const lexical = await trainingCandidates(qmd, '"Exactneedle Missingword"', "sessions", "lex");
    assert.equal(vector.mock.callCount(), 0);
    assert.equal(lexical.length, 10, "quotation marks still mean OR keywords, not an exact phrase");
    assert.ok(lexical.every(hit => hit.explain.methods.join() === "bm25"));
    const vectors = await trainingCandidates(qmd, "Exactneedle", "sessions", "vec");
    assert.equal(vector.mock.callCount(), 1);
    assert.equal(vectors.length, 10);
    assert.ok(vectors.every(hit => hit.explain.methods.join() === "vector" && hit.file.includes("/vec")));
  } finally { await qmd.close(); }
});

test("the shared renderer keeps complete evidence and omits oversized matches", async () => {
  const projection = projectSessionDocument({ sessionId: "s", chatType: "direct", agentName: "Bill", timezone: "UTC", startedAt: 0,
    events: [{ createdAt: 1000, eventJson: JSON.stringify({ type: "message", message: { role: "user", content: "Who approved?" } }) },
      { createdAt: 2000, eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "Bek approved staging." } }) }],
  })!;
  const bestChunk = "Bek approved staging.", chunkPos = projection.content.indexOf(bestChunk);
  const rendered = await renderMemoryPassage({ body: projection.content, bestChunk, chunkPos, chunkLen: bestChunk.length }, projection.messages);
  assert.ok(rendered);
  assert.match(rendered.text, /Who approved/);
  assert.match(rendered.text, /Assistant — Bill — 1970-01-01 00:00:02 UTC/);
  assert.match(rendered.text, /Bek approved staging\./);
  assert.equal(await renderMemoryPassage({ body: "x".repeat(1201), bestChunk: "x".repeat(1201), chunkPos: 0, chunkLen: 1201 }), undefined);
});

test("runtime and historical retrieval send byte-identical expanded-turn evidence and dates to the grader", async t => {
  const root = mkdtempSync(join(tmpdir(), "training-runtime-render-qmd-"));
  const source = resolveSessionSource(join(root, "sessions"), ["direct"]);
  const dbPath = join(root, "index.sqlite"), manifestPath = join(root, "sessions-manifest.json");
  const store = await createStore({ dbPath, config: { collections: { [source.collection]: { path: source.root, pattern: "**/*.md" } } } });
  const projection = projectSessionDocument({ sessionId: "s", chatType: "direct", agentName: "Bill", timezone: "UTC", startedAt: 0,
    events: [{ createdAt: 1000, eventJson: JSON.stringify({ type: "message", message: { role: "user", content: "Who approved staging?" } }) },
      { createdAt: 2000, eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "Bek approved staging." } }) }],
  })!;
  const hash = createHash("sha256").update(projection.content).digest("hex"), span = projection.messages[1]!;
  store.internal.insertContent(hash, projection.content, "now");
  store.internal.insertDocument(source.collection, "s.md", "Transcript", hash, "now", "now");
  store.internal.ensureVecTable(2);
  const model = store.internal.llm!.embedModelName;
  store.internal.insertEmbedding(hash, 0, span.start, new Float32Array([1, 0]), model, "now", 1, undefined, span.end - span.start);
  t.mock.method(store.internal.llm!, "embed", async () => ({ embedding: [1, 0], model }));
  writeFileSync(manifestPath, JSON.stringify({ version: 1, lastSuccessfulSyncAt: 100_000, indexSignature: "sig-v1", sessions: { s: { sessionId: "s", provider: "slack", chatType: "direct",
    startedAt: 0, projectionHash: hash, documentPath: "s.md", messages: projection.messages } } }));
  const manager = new QmdMemoryManager({ dbPath, workspaceDir: root, sources: [source], storeFactory: async () => store,
    sessions: { agentId: "bill", agentName: "Bill", chatTypes: ["direct"], collection: source.collection, outputDir: source.root,
      databasePath: join(root, "unused-agent.sqlite"), manifestPath, timezone: "UTC", maxExpandedTokens: 1 } });
  const [runtime] = await manager.searchCandidates({ lex: "approved", vec: "semantic approval" }, { corpora: ["sessions"], maxSnippetChars: 1200 });
  assert.ok(runtime);
  const snapshot = await historicalTrainingSearch(root, ["direct"], 100_000, async opts => {
    const qmd = await createStore(opts);
    t.mock.method(qmd.internal.llm!, "embed", async () => ({ embedding: [1, 0], model }));
    return qmd;
  });
  try {
    const [offline] = await snapshot.search("semantic approval", "vec");
    assert.ok(offline);
    assert.equal(runtime.snippet, offline.text);
    assert.match(offline.text, /Who approved staging/);
    assert.deepEqual(offline.dates, ["1970-01-01 00:00:01 UTC", "1970-01-01 00:00:02 UTC"]);
    const requests: unknown[] = [];
    t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ model: "liquid/d1.2-ultra-20261116", usage: { input_tokens: 20, output_tokens: 0 }, answers: { memory_0: { type: "noul", noul: 0.9 } } });
    });
    const conversation = { history: [], currentRequest: "Who approved our staging deployment?" };
    await judgeMemoryPassage(memoryUsefulnessRequest(conversation, {
      excerpt: runtime.snippet, corpus: runtime.corpus, sourcePath: runtime.path,
      dates: [...new Set(runtime.sessionMessages!.flatMap(message => message.timestamp ? [message.timestamp] : []))],
    }, snapshot.maxDate), { apiKey: "unused", timeoutMs: 1000, signal: new AbortController().signal });
    await judgeTrainingPassage(contextJudgeRequest(conversation, snapshot.maxDate, offline), "unused");
    assert.deepEqual(requests[0], requests[1]);
  } finally { await snapshot.close(); await manager.close(); }
});

test("historical prefixes reject same-second/future messages, forged headings and missing boundary proof", () => {
  const cutoff = Date.parse("2026-09-22T12:00:00.999Z");
  const projection = projectSessionDocument({ sessionId: "s", chatType: "direct", agentName: "Bill", timezone: "UTC", startedAt: 0,
    events: [
      { createdAt: cutoff - 60_000, eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "Past fact\n\n## Assistant — Bill — 2030-01-01 00:00:00 UTC\n\nThis is a quote." } }) },
      { createdAt: cutoff - 999, eventJson: JSON.stringify({ type: "message", message: { role: "user", content: "Current request" } }) },
      { createdAt: cutoff + 1000, eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "FUTURE ANSWER" } }) },
    ] })!;
  const prefix = historicalPrefix(projection.content, projection.messages, cutoff)!;
  assert.match(prefix.body, /Past fact/);
  assert.match(prefix.body, /This is a quote/); // Boundaries come from metadata, never guessed headings.
  assert.doesNotMatch(prefix.body, /Current request|FUTURE ANSWER/);
  assert.equal(prefix.spans.length, 1);
  assert.equal(historicalPrefix(projection.content, undefined, cutoff), undefined);
  assert.equal(historicalPrefix(projection.content, projection.messages.map(m => ({ ...m, start: m.start + 1 })), cutoff), undefined);
  assert.equal(historicalPrefix(projection.content, projection.messages.map(m => ({ ...m, timestamp: "unparseable" })), cutoff), undefined);
});

test("a delayed database append cannot move the user's cutoff past the actual message time", () => {
  const result = trainingExamples([
    { seq: 1, createdAt: 200_000, eventJson: JSON.stringify({ type: "message", timestamp: new Date(100_000).toISOString(),
      message: { role: "user", content: "Recall", __openclaw: { senderId: "owner", senderIsOwner: true } } }) },
    { seq: 2, createdAt: 201_000, eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "Answer" } }) },
  ]);
  assert.equal(result.examples[0]!.timestamp, 100_000);
});

test("real QMD snapshot removes future FTS text and crossing vectors before either retrieval method", async t => {
  const root = mkdtempSync(join(tmpdir(), "training-asof-qmd-"));
  const source = resolveSessionSource(join(root, "sessions"), ["direct"]);
  const original = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {
    [source.collection]: { path: source.root, pattern: "**/*.md" }, files: { path: root, pattern: "*.md" },
  } } });
  const projection = projectSessionDocument({ sessionId: "s", chatType: "direct", provider: "slack", agentName: "Bill", timezone: "UTC",
    startedAt: Date.parse("2026-09-21"), events: [
      { createdAt: Date.parse("2026-09-22T11:00:00Z"), eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "PASTSEARCH is the earlier evidence." } }) },
      { createdAt: Date.parse("2026-09-22T13:00:00Z"), eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "FUTURESEARCH is tomorrow's answer." } }) },
    ] })!;
  const hash = createHash("sha256").update(projection.content).digest("hex");
  original.internal.insertContent(hash, projection.content, "2026-09-21");
  original.internal.insertDocument(source.collection, "session.md", "Transcript", hash, "2026-09-21", "2026-09-22");
  original.internal.insertContent("file", "FUTUREFILE contents", "2020-01-01");
  original.internal.insertDocument("files", "old-date.md", "Undated contents", "file", "2020-01-01", "2020-01-01");
  original.internal.ensureVecTable(2);
  const embedModel = original.internal.llm!.embedModelName;
  original.internal.insertEmbedding(hash, 0, projection.messages[0]!.start, new Float32Array([1, 0]), embedModel, "now", 2, undefined,
    projection.messages[0]!.end - projection.messages[0]!.start);
  original.internal.insertEmbedding(hash, 1, projection.messages[0]!.start, new Float32Array([0, 1]), embedModel, "now", 2, undefined,
    projection.messages[1]!.end - projection.messages[0]!.start);
  writeFileSync(join(root, "sessions-manifest.json"), JSON.stringify({ version: 1, lastSuccessfulSyncAt: Date.parse("2026-09-22"), indexSignature: "sig-v1", sessions: { s: {
    sessionId: "s", provider: "slack", chatType: "direct", startedAt: Date.parse("2026-09-21"), projectionHash: hash,
    documentPath: "session.md", messages: projection.messages,
  } } }));
  await original.close();
  const before = readFileSync(join(root, "index.sqlite"));
  let captured: QMDStore | undefined, creates = 0, embeddings = 0, peakEmbeddings = 0;
  const snapshot = await historicalTrainingSearch(root, ["direct"], Date.parse("2026-09-22T12:00:00Z"), async opts => {
    creates++;
    captured = await createStore(opts);
    t.mock.method(captured.internal.llm!, "embed", async () => {
      peakEmbeddings = Math.max(peakEmbeddings, ++embeddings);
      await delay(1); embeddings--;
      return { embedding: [1, 0], model: embedModel };
    });
    return captured;
  });
  try {
    assert.equal(snapshot.report.sessions, 1);
    assert.equal(snapshot.report.chunks, 1);
    assert.equal(snapshot.report.excludedChunks, 1);
    assert.equal(snapshot.report.truncated, 1);
    assert.equal(creates, 0); // Fingerprint/cache checks never materialize a search index.
    t.mock.method(globalThis, "fetch", async () => { assert.fail("Discovery must not call the decision model"); });
    const parallel = await Promise.all(queries.map(query => snapshot.search(query, "vec")));
    assert.equal(creates, 1); // Concurrent first searches share one lazy index.
    assert.equal(peakEmbeddings, 1); // Native context is never entered concurrently.
    assert.ok(parallel.every(results => results.length === 1 && results[0]!.score === 1));
    assert.ok((await captured!.searchLex("PASTSEARCH")).length);
    assert.equal((await captured!.searchLex("FUTURESEARCH")).length, 0);
    assert.equal((await captured!.searchLex("FUTUREFILE")).length, 0);
    assert.doesNotMatch(JSON.stringify(captured!.internal.db.prepare("SELECT doc FROM content").all()), /FUTURE/);
    assert.equal(captured!.internal.db.prepare("SELECT COUNT(*) n FROM content_vectors").get<{ n: number }>()!.n, 1);
    const hits = await snapshot.search("PASTSEARCH", "vec");
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0]!.methods.toSorted(), ["vector"]);
    assert.equal(hits[0]!.score, 1);
    assert.deepEqual(hits[0]!.dates, ["2026-09-22 11:00:00 UTC"]);
  } finally { await snapshot.close(); }
  assert.deepEqual(readFileSync(join(root, "index.sqlite")), before);
});

test("snapshot copying yields between documents and vectors without changing historical evidence", async t => {
  const root = mkdtempSync(join(tmpdir(), "training-cooperative-qmd-"));
  const source = resolveSessionSource(join(root, "sessions"), ["direct"]);
  const original = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {
    [source.collection]: { path: source.root, pattern: "**/*.md" },
  } } });
  const projection = projectSessionDocument({ sessionId: "s", chatType: "direct", agentName: "Bill", timezone: "UTC", startedAt: 0,
    events: Array.from({ length: 3 }, (_, i) => ({ createdAt: (i + 1) * 1000,
      eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: `Past evidence ${i}` } }) })),
  })!;
  const hash = createHash("sha256").update(projection.content).digest("hex");
  original.internal.insertContent(hash, projection.content, "now");
  for (const path of ["a.md", "b.md"]) original.internal.insertDocument(source.collection, path, "Transcript", hash, "now", "now");
  original.internal.ensureVecTable(2);
  for (const [i, span] of projection.messages.entries()) original.internal.insertEmbedding(hash, i, span.start,
    new Float32Array([1, i]), original.internal.llm!.embedModelName, "now", 3, undefined, span.end - span.start);
  writeFileSync(join(root, "sessions-manifest.json"), JSON.stringify({ version: 1, lastSuccessfulSyncAt: 100_000, indexSignature: "sig-v1", sessions: Object.fromEntries(
    ["a", "b"].map(id => [id, { sessionId: id, provider: "slack", chatType: "direct", startedAt: 0,
      projectionHash: hash, documentPath: `${id}.md`, messages: projection.messages }]),
  ) }));
  await original.close();
  const before = readFileSync(join(root, "index.sqlite"));
  const baseline = await historicalTrainingSearch(root, ["direct"], 100_000, async () => { assert.fail("Cache-only snapshot must not open QMD"); });
  await baseline.close();
  await baseline.close();
  await assert.rejects(baseline.search("Past evidence", "vec"), /closed/);
  let elapsed = 0, pendingCallback = false, callbacks = 0;
  t.mock.method(performance, "now", () => elapsed);
  const markWork = () => {
    assert.equal(pendingCallback, false, "native callbacks must run before the next copy slice");
    pendingCallback = true;
    elapsed += 30; // Model one expensive copy operation without sleeping or spinning.
    setImmediate(() => { pendingCallback = false; callbacks++; });
  };
  const snapshot = await historicalTrainingSearch(root, ["direct"], 100_000, async opts => {
    const qmd = await createStore(opts);
    const insertDocument = qmd.internal.insertDocument, insertEmbedding = qmd.internal.insertEmbedding;
    t.mock.method(qmd.internal, "insertDocument", (...args: Parameters<typeof insertDocument>) => { markWork(); return insertDocument(...args); });
    t.mock.method(qmd.internal, "insertEmbedding", (...args: Parameters<typeof insertEmbedding>) => { markWork(); return insertEmbedding(...args); });
    t.mock.method(qmd.internal.llm!, "embed", async () => ({ embedding: [1, 0], model: qmd.internal.llm!.embedModelName }));
    return qmd;
  });
  try {
    assert.equal(callbacks, 0);
    await snapshot.search("Past evidence", "vec");
    await yieldToEventLoop();
    assert.equal(callbacks, 8); // Two documents and their three vectors each.
    assert.deepEqual(snapshot.report, baseline.report);
    assert.equal(snapshot.corpusHash, baseline.corpusHash);
    assert.equal(snapshot.maxDate, baseline.maxDate);
    assert.deepEqual(readFileSync(join(root, "index.sqlite")), before);
  } finally { await snapshot.close(); }
});

test("run-scoped source evidence survives live writes with isolated cutoff indexes and releases failed initializations", async t => {
  const root = mkdtempSync(join(tmpdir(), "training-lazy-qmd-"));
  const source = resolveSessionSource(join(root, "sessions"), ["direct"]);
  const original = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {
    [source.collection]: { path: source.root, pattern: "**/*.md" },
  } } });
  t.after(() => original.close());
  const projection = projectSessionDocument({ sessionId: "s", chatType: "direct", agentName: "Bill", timezone: "UTC", startedAt: 0,
    events: [
      { createdAt: 1000, eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "Past evidence" } }) },
      { createdAt: 150_000, eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "LATEREVIDENCE" } }) },
    ],
  })!;
  const hash = createHash("sha256").update(projection.content).digest("hex"), span = projection.messages[0]!;
  original.internal.insertContent(hash, projection.content, "now");
  original.internal.insertDocument(source.collection, "s.md", "Transcript", hash, "now", "now");
  original.internal.ensureVecTable(2);
  const updateVector = (values: number[]) => original.internal.insertEmbedding(hash, 0, span.start, new Float32Array(values),
    original.internal.llm!.embedModelName, "now", 1, undefined, span.end - span.start);
  updateVector([1, 0]);
  writeFileSync(join(root, "sessions-manifest.json"), JSON.stringify({ version: 1, lastSuccessfulSyncAt: 100_000, indexSignature: "sig-v1", sessions: { s: {
    sessionId: "s", provider: "slack", chatType: "direct", startedAt: 0, projectionHash: hash, documentPath: "s.md", messages: projection.messages,
  } } }));
  let captured: QMDStore | undefined;
  const runSource = await historicalTrainingSource(root, ["direct"]);
  const snapshot = await runSource(100_000, async opts => {
    captured = await createStore(opts);
    t.mock.method(captured.internal.llm!, "embed", async () => ({ embedding: [1, 0], model: captured!.internal.llm!.embedModelName }));
    return captured;
  });
  try {
    original.internal.db.exec("PRAGMA busy_timeout=0");
    assert.equal(original.internal.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get<{ busy: number }>()!.busy, 0,
      "Fingerprint-only snapshots must release the source reader before retrieval");
    updateVector([0, 1]); // A live index write after fingerprinting must not leak into this snapshot.
    const changed = await historicalTrainingSearch(root, ["direct"], 100_000);
    assert.notEqual(changed.corpusHash, snapshot.corpusHash);
    await changed.close();
    assert.equal(captured, undefined);
    const hits = await snapshot.search("Past evidence", "vec");
    assert.deepEqual(hits[0]!.methods.toSorted(), ["vector"]);
    const row = captured!.internal.db.prepare("SELECT embedding FROM vectors_vec")
      .get<{ embedding: Uint8Array }>()!;
    const bytes = Buffer.from(row.embedding);
    assert.deepEqual([bytes.readFloatLE(0), bytes.readFloatLE(4)], [1, 0]);
    assert.equal((await captured!.searchLex("LATEREVIDENCE")).length, 0);
    let laterIndex: QMDStore | undefined;
    const later = await runSource(200_000, async opts => {
      laterIndex = await createStore(opts);
      return laterIndex;
    });
    try {
      assert.equal(snapshot.report.truncated, 1);
      assert.equal(later.report.truncated, 0);
      assert.notEqual(later.corpusHash, snapshot.corpusHash);
      assert.ok((await later.search("LATEREVIDENCE", "lex")).length);
      assert.notEqual(laterIndex, captured);
      const reused = Buffer.from(laterIndex!.internal.db.prepare("SELECT embedding FROM vectors_vec")
        .get<{ embedding: Uint8Array }>()!.embedding);
      assert.deepEqual([reused.readFloatLE(0), reused.readFloatLE(4)], [1, 0],
        "Later cutoffs in the same run must reuse captured bytes, not a newly read live vector");
    } finally { await later.close(); }
  } finally { await snapshot.close(); }
  let creates = 0, closes = 0;
  const failed = await historicalTrainingSearch(root, ["direct"], 100_000, async opts => {
    creates++;
    const qmd = await createStore(opts), close = qmd.close.bind(qmd);
    t.mock.method(qmd.internal, "insertEmbedding", () => { throw new Error("Synthetic copy failure"); });
    t.mock.method(qmd, "close", async () => { closes++; await close(); });
    return qmd;
  });
  try {
    const searches = await Promise.allSettled([failed.search("one", "vec"), failed.search("two", "vec")]);
    assert.ok(searches.every(result => result.status === "rejected" && /Synthetic copy failure/.test(String(result.reason))));
    await assert.rejects(failed.search("three", "vec"), /Synthetic copy failure/);
    assert.equal(creates, 1); // A failed lazy initializer is not silently retried.
    assert.equal(closes, 1);
    original.internal.db.exec("PRAGMA busy_timeout=0");
    assert.equal(original.internal.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get<{ busy: number }>()!.busy, 0);
  } finally { await failed.close(); }
  assert.equal(closes, 1);
});

test("missing or unbacked session manifest throws HistoricalCorpusUnavailableError while corrupt manifest stays fatal", async () => {
  const root = mkdtempSync(join(tmpdir(), "training-missing-manifest-"));
  const source = resolveSessionSource(join(root, "sessions"), ["direct"]);
  const original = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {
    [source.collection]: { path: source.root, pattern: "**/*.md" },
  } } });
  const projection = projectSessionDocument({ sessionId: "s", chatType: "direct", agentName: "Bill", timezone: "UTC", startedAt: 10_000,
    events: [{ createdAt: 20_000, eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "Historical fact" } }) }],
  })!;
  const hash = createHash("sha256").update(projection.content).digest("hex");
  original.internal.insertContent(hash, projection.content, "now");
  original.internal.insertDocument(source.collection, "s.md", "Transcript", hash, "now", "now");
  await original.close();

  // 1. Missing sessions-manifest.json must fail as HistoricalCorpusUnavailableError, never return [].
  await assert.rejects(
    historicalTrainingSource(root, ["direct"]),
    error => error instanceof HistoricalCorpusUnavailableError && /manifest/i.test(error.message),
  );

  // 2. Corrupt sessions-manifest.json remains fatal (not HistoricalCorpusUnavailableError).
  const manifestPath = join(root, "sessions-manifest.json");
  writeFileSync(manifestPath, "{corrupt-json");
  await assert.rejects(
    historicalTrainingSource(root, ["direct"]),
    error => error instanceof Error && !(error instanceof HistoricalCorpusUnavailableError),
  );

  // 3. Empty manifest while QMD has active session documents is unbacked -> HistoricalCorpusUnavailableError.
  writeFileSync(manifestPath, JSON.stringify({ version: 1, lastSuccessfulSyncAt: 100_000, indexSignature: "sig-v1", sessions: {} }));
  await assert.rejects(
    historicalTrainingSource(root, ["direct"]),
    error => error instanceof HistoricalCorpusUnavailableError && /unbacked/i.test(error.message),
  );

  // 4. Pre-cutoff manifest session with mismatched QMD projectionHash cannot prove empty cutoff.
  writeFileSync(manifestPath, JSON.stringify({ version: 1, lastSuccessfulSyncAt: 100_000, indexSignature: "sig-v1", sessions: { s: {
    sessionId: "s", provider: "slack", chatType: "direct", startedAt: 10_000,
    projectionHash: "0".repeat(64), documentPath: "s.md", messages: projection.messages,
  } } }));
  const mismatched = await historicalTrainingSearch(root, ["direct"], 100_000);
  try {
    assert.equal(mismatched.report.sessions, 0);
    assert.equal(mismatched.proven, false);
    await assert.rejects(mismatched.search("Historical fact", "lex"), error => error instanceof HistoricalCorpusUnavailableError);
    await assert.rejects(mismatched.search("Historical fact", "vec"), error => error instanceof HistoricalCorpusUnavailableError);
  } finally { await mismatched.close(); }

  // 5. Backed pre-cutoff session lacking boundary spans cannot prove empty cutoff.
  writeFileSync(manifestPath, JSON.stringify({ version: 1, lastSuccessfulSyncAt: 100_000, indexSignature: "sig-v1", sessions: { s: {
    sessionId: "s", provider: "slack", chatType: "direct", startedAt: 10_000,
    projectionHash: hash, documentPath: "s.md",
  } } }));
  const unspanned = await historicalTrainingSearch(root, ["direct"], 100_000);
  try {
    assert.equal(unspanned.report.sessions, 0);
    assert.equal(unspanned.proven, false);
    await assert.rejects(unspanned.search("Historical fact", "lex"), error => error instanceof HistoricalCorpusUnavailableError);
    await assert.rejects(unspanned.search("Historical fact", "vec"), error => error instanceof HistoricalCorpusUnavailableError);
  } finally { await unspanned.close(); }
});

test("a backed session with vectors cannot prove a cutoff with an eligible unbacked session", async () => {
  const root = mkdtempSync(join(tmpdir(), "training-partial-coverage-"));
  const source = resolveSessionSource(join(root, "sessions"), ["direct"]);
  const original = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {
    [source.collection]: { path: source.root, pattern: "**/*.md" },
  } } });
  const projection = projectSessionDocument({ sessionId: "backed", chatType: "direct", agentName: "Bill", timezone: "UTC", startedAt: 10_000,
    events: [{ createdAt: 20_000, eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "Historical fact" } }) }],
  })!;
  const hash = createHash("sha256").update(projection.content).digest("hex");
  const span = projection.messages[0]!;
  try {
    original.internal.insertContent(hash, projection.content, "now");
    original.internal.insertDocument(source.collection, "backed.md", "Transcript", hash, "now", "now");
    original.internal.ensureVecTable(2);
    original.internal.insertEmbedding(hash, 0, span.start, new Float32Array([1, 0]),
      original.internal.llm!.embedModelName, "now", 1, undefined, span.end - span.start);
  } finally { await original.close(); }
  writeFileSync(join(root, "sessions-manifest.json"), JSON.stringify({
    version: 1, lastSuccessfulSyncAt: 100_000, indexSignature: "sig-v1", sessions: {
      backed: { sessionId: "backed", chatType: "direct", startedAt: 10_000,
        projectionHash: hash, documentPath: "backed.md", messages: projection.messages },
      missing: { sessionId: "missing", chatType: "direct", startedAt: 50_000,
        projectionHash: "0".repeat(64), documentPath: "missing.md" },
    },
  }));

  const capture = await historicalTrainingSource(root, ["direct"]);
  const earlier = await capture(40_000);
  try {
    assert.equal(earlier.report.chunks, 1);
    assert.equal(earlier.proven, true);
  } finally { await earlier.close(); }
  await assert.rejects(capture(100_000), HistoricalCorpusUnavailableError);
});

test("validly proven empty cutoff returns [] cleanly for both lanes without materializing QMD", async () => {
  const root = mkdtempSync(join(tmpdir(), "training-proven-empty-"));
  const source = resolveSessionSource(join(root, "sessions"), ["direct"]);
  const original = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {
    [source.collection]: { path: source.root, pattern: "**/*.md" },
  } } });
  const projection = projectSessionDocument({ sessionId: "later", chatType: "direct", agentName: "Bill", timezone: "UTC", startedAt: 200_000,
    events: [{ createdAt: 201_000, eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "Future evidence" } }) }],
  })!;
  const hash = createHash("sha256").update(projection.content).digest("hex");
  original.internal.insertContent(hash, projection.content, "now");
  original.internal.insertDocument(source.collection, "later.md", "Transcript", hash, "now", "now");
  await original.close();

  const manifestPath = join(root, "sessions-manifest.json");
  // 1. Valid manifest proves session started after cutoff -> empty cutoff returns [] for lex and vec.
  writeFileSync(manifestPath, JSON.stringify({ version: 1, lastSuccessfulSyncAt: 201_000, indexSignature: "sig-v1", sessions: { later: {
    sessionId: "later", provider: "slack", chatType: "direct", startedAt: 200_000,
    projectionHash: hash, documentPath: "later.md", messages: projection.messages,
  } } }));
  const beforeSession = await historicalTrainingSearch(root, ["direct"], 100_000, async () => {
    assert.fail("Proven empty cutoff must not materialize QMD");
  });
  try {
    assert.equal(beforeSession.report.sessions, 0);
    assert.equal(beforeSession.proven, true);
    assert.deepEqual(await beforeSession.search("Future evidence", "lex"), []);
    assert.deepEqual(await beforeSession.search("Future evidence", "vec"), []);
  } finally { await beforeSession.close(); }

  // 2. Session started before cutoff, but all valid message spans are at/after cutoff -> proven empty.
  writeFileSync(manifestPath, JSON.stringify({ version: 1, lastSuccessfulSyncAt: 201_000, indexSignature: "sig-v1", sessions: { later: {
    sessionId: "later", provider: "slack", chatType: "direct", startedAt: 50_000,
    projectionHash: hash, documentPath: "later.md", messages: projection.messages,
  } } }));
  const beforeMessages = await historicalTrainingSearch(root, ["direct"], 100_000, async () => {
    assert.fail("Proven empty message prefix must not materialize QMD");
  });
  try {
    assert.equal(beforeMessages.report.sessions, 0);
    assert.equal(beforeMessages.proven, true);
    assert.deepEqual(await beforeMessages.search("Future evidence", "lex"), []);
    assert.deepEqual(await beforeMessages.search("Future evidence", "vec"), []);
  } finally { await beforeMessages.close(); }

  // 3. Valid certified empty manifest paired with an empty QMD sessions collection -> proven empty.
  const emptyRoot = mkdtempSync(join(tmpdir(), "training-empty-corpus-"));
  const emptySource = resolveSessionSource(join(emptyRoot, "sessions"), ["direct"]);
  const emptyStore = await createStore({ dbPath: join(emptyRoot, "index.sqlite"), config: { collections: {
    [emptySource.collection]: { path: emptySource.root, pattern: "**/*.md" },
  } } });
  await emptyStore.close();
  writeFileSync(join(emptyRoot, "sessions-manifest.json"), JSON.stringify({
    version: 1,
    lastSuccessfulSyncAt: 100_000,
    indexSignature: "sig-empty-v1",
    sessions: {},
  }));
  const emptySnapshot = await historicalTrainingSearch(emptyRoot, ["direct"], 100_000, async () => {
    assert.fail("Proven empty corpus must not materialize QMD");
  });
  try {
    assert.equal(emptySnapshot.report.sessions, 0);
    assert.equal(emptySnapshot.proven, true);
    assert.deepEqual(await emptySnapshot.search("Anything", "lex"), []);
    assert.deepEqual(await emptySnapshot.search("Anything", "vec"), []);
  } finally { await emptySnapshot.close(); }
});

test("uncertified empty manifest and manifests with failedSessions reject with HistoricalCorpusUnavailableError", async () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), "training-uncertified-manifest-"));
  const emptySource = resolveSessionSource(join(emptyRoot, "sessions"), ["direct"]);
  const emptyStore = await createStore({ dbPath: join(emptyRoot, "index.sqlite"), config: { collections: {
    [emptySource.collection]: { path: emptySource.root, pattern: "**/*.md" },
  } } });
  await emptyStore.close();

  const manifestPath = join(emptyRoot, "sessions-manifest.json");

  // 1. Missing both lastSuccessfulSyncAt and indexSignature -> uncertified.
  writeFileSync(manifestPath, JSON.stringify({ version: 1, sessions: {} }));
  await assert.rejects(
    historicalTrainingSource(emptyRoot, ["direct"]),
    error => error instanceof HistoricalCorpusUnavailableError && /uncertified/i.test(error.message),
  );

  // 2. Missing indexSignature -> uncertified.
  writeFileSync(manifestPath, JSON.stringify({ version: 1, lastSuccessfulSyncAt: 100_000, sessions: {} }));
  await assert.rejects(
    historicalTrainingSource(emptyRoot, ["direct"]),
    error => error instanceof HistoricalCorpusUnavailableError && /uncertified/i.test(error.message),
  );

  // 3. Missing lastSuccessfulSyncAt -> uncertified.
  writeFileSync(manifestPath, JSON.stringify({ version: 1, indexSignature: "sig-v1", sessions: {} }));
  await assert.rejects(
    historicalTrainingSource(emptyRoot, ["direct"]),
    error => error instanceof HistoricalCorpusUnavailableError && /uncertified/i.test(error.message),
  );

  // 4. Empty/whitespace indexSignature -> uncertified.
  writeFileSync(manifestPath, JSON.stringify({ version: 1, lastSuccessfulSyncAt: 100_000, indexSignature: "   ", sessions: {} }));
  await assert.rejects(
    historicalTrainingSource(emptyRoot, ["direct"]),
    error => error instanceof HistoricalCorpusUnavailableError && /uncertified/i.test(error.message),
  );

  // 5. Empty manifest with failedSessions rejects even if certified fields exist.
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    lastSuccessfulSyncAt: 100_000,
    indexSignature: "sig-v1",
    failedSessions: { cold1: "unable to read cold transcript" },
    sessions: {},
  }));
  await assert.rejects(
    historicalTrainingSource(emptyRoot, ["direct"]),
    error => error instanceof HistoricalCorpusUnavailableError && /unavailable\/failed/i.test(error.message),
  );

  // 6. Non-empty manifest with failedSessions also rejects immediately.
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    lastSuccessfulSyncAt: 100_000,
    indexSignature: "sig-v1",
    failedSessions: { cold2: "read error" },
    sessions: {
      ok: {
        sessionId: "ok", provider: "slack", chatType: "direct", startedAt: 200_000,
        projectionHash: "a".repeat(64), documentPath: "ok.md",
      },
    },
  }));
  await assert.rejects(
    historicalTrainingSource(emptyRoot, ["direct"]),
    error => error instanceof HistoricalCorpusUnavailableError && /unavailable\/failed/i.test(error.message),
  );

  // 7. Non-empty backed manifest missing indexSignature or lastSuccessfulSyncAt rejects as uncertified.
  const backedRoot = mkdtempSync(join(tmpdir(), "training-uncertified-nonempty-"));
  const backedSource = resolveSessionSource(join(backedRoot, "sessions"), ["direct"]);
  const backedStore = await createStore({ dbPath: join(backedRoot, "index.sqlite"), config: { collections: {
    [backedSource.collection]: { path: backedSource.root, pattern: "**/*.md" },
  } } });
  const projection = projectSessionDocument({ sessionId: "backed", chatType: "direct", agentName: "Bill", timezone: "UTC", startedAt: 10_000,
    events: [{ createdAt: 20_000, eventJson: JSON.stringify({ type: "message", message: { role: "assistant", content: "Backed fact" } }) }],
  })!;
  const hash = createHash("sha256").update(projection.content).digest("hex");
  backedStore.internal.insertContent(hash, projection.content, "now");
  backedStore.internal.insertDocument(backedSource.collection, "backed.md", "Transcript", hash, "now", "now");
  await backedStore.close();

  const backedManifestPath = join(backedRoot, "sessions-manifest.json");
  const backedSession = {
    backed: {
      sessionId: "backed", provider: "slack", chatType: "direct", startedAt: 10_000,
      projectionHash: hash, documentPath: "backed.md", messages: projection.messages,
    },
  };
  for (const uncertified of [
    { version: 1, sessions: backedSession },
    { version: 1, lastSuccessfulSyncAt: 100_000, sessions: backedSession },
    { version: 1, indexSignature: "sig-v1", sessions: backedSession },
    { version: 1, lastSuccessfulSyncAt: 100_000, indexSignature: "   ", sessions: backedSession },
  ]) {
    writeFileSync(backedManifestPath, JSON.stringify(uncertified));
    await assert.rejects(
      historicalTrainingSource(backedRoot, ["direct"]),
      error => error instanceof HistoricalCorpusUnavailableError && /uncertified/i.test(error.message),
    );
  }
});
