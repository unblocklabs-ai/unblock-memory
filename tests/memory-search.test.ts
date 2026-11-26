import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@unblocklabs/qmd";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerUnblockMemory } from "../src/plugin.js";
import type { QmdMemoryRuntime } from "../src/runtime.js";
import { QmdMemoryManager } from "../src/manager.js";
import { resolveSource, resolveSessionSource } from "../src/sources.js";
import { memoryPassageId, searchMemory } from "../src/memory-search.js";

test("fallback ranks a real vector-only top match above a full lexical candidate lane", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-fallback-order-"));
  const source = resolveSource(root, "*.md", "memory");
  const qmd = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {
    [source.collection]: { path: source.root, pattern: source.pattern },
  } } });
  qmd.internal.ensureVecTable(2);
  const model = qmd.internal.llm!.embedModelName;
  for (let i = 0; i < 7; i++) {
    const semantic = i === 6;
    const text = semantic ? "Bek approved the international expansion budget." : `Clutterkeyword unrelated planning detail ${i}.`;
    const hash = `fallback-order-${i}`;
    qmd.internal.insertContent(hash, text, "2026-10-10");
    qmd.internal.insertDocument(source.collection, `${semantic ? "semantic" : `lexical-${i}`}.md`, "Evidence", hash, "2026-10-10", "2026-10-10");
    qmd.internal.insertEmbedding(hash, 0, 0, new Float32Array(semantic ? [1, 0] : [0, 1]), model, "2026-10-10", 1, undefined, text.length);
  }
  t.mock.method(qmd.internal.llm!, "embed", async () => ({ embedding: [1, 0], model }));
  const manager = new QmdMemoryManager({ dbPath: qmd.dbPath, workspaceDir: root, sources: [source], storeFactory: async () => qmd });
  t.after(() => manager.close());
  const queries = { lex: "Clutterkeyword", vec: "Who approved the international expansion budget?" };
  const candidates = await manager.searchCandidates(queries, {});
  assert.equal(candidates.length, 7);
  assert.ok(candidates.slice(0, 2).some(hit => hit.path.endsWith("semantic.md")), "passage-level RRF keeps vector rank one in the top two");
  assert.ok(candidates.every((hit, index) => !index || candidates[index - 1]!.score >= hit.score), "discovery returns fused RRF order");
  assert.ok(candidates[0]!.score > candidates.at(-1)!.score, "top-rank/dual-lane hits outrank tail hits");
  const result = await searchMemory(manager, queries, { apiKey: undefined, timeoutMs: 10,
    conversation: { history: [], currentRequest: queries.vec }, allowRetrievalFallback: true, maxResults: 5 });
  assert.equal(result.results.length, 5);
  assert.ok(result.results.slice(0, 2).some(hit => hit.path.endsWith("semantic.md")), "vector rank one competes before truncation");
  assert.ok(result.results.every((hit, index) => !index || result.results[index - 1]!.score >= hit.score));
});

test("searchMemory respects maxJudgeCandidates after dedup/cooldown while leaving uncapped searches intact", async t => {
  const hits = Array.from({ length: 16 }, (_, i) => ({
    path: `qmd://memory/doc-${i}.md`, startLine: 1, endLine: 2,
    score: (16 - i) / 100, snippet: `candidate passage ${i}`, source: "memory" as const, corpus: "memory",
  }));
  // Include a duplicate of top hit doc-1 and shuffle input order to verify dedup/cooldown happen before top-K.
  const manager = { searchCandidates: async () => [...hits.slice(8), hits[1]!, ...hits.slice(0, 8)] };
  const judged: string[] = [];
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    const request = JSON.parse(String(init?.body));
    judged.push(request.state[0].candidates[0].excerpt);
    return Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { memory_0: { type: "noul", noul: 0.9 } } });
  });
  const excludedPassages = new Map([[memoryPassageId(hits[0]!.snippet), 1]]);
  const capped = await searchMemory(manager, { lex: "k", vec: "v" }, {
    apiKey: "test", timeoutMs: 100, conversation: { history: [], currentRequest: "v" },
    maxJudgeCandidates: 6, maxResults: 4, excludedPassages,
  });
  assert.equal(capped.eligible, 15);
  assert.equal(capped.requestsSucceeded, 6);
  assert.deepEqual(judged, hits.slice(1, 7).map(hit => hit.snippet), "cooled-down and duplicate top hits never consume judge slots");
  judged.length = 0;
  const uncapped = await searchMemory(manager, { lex: "k", vec: "v" }, {
    apiKey: "test", timeoutMs: 100, conversation: { history: [], currentRequest: "v" },
    maxResults: 20,
  });
  assert.equal(uncapped.requestsSucceeded, 16);
  assert.equal(judged.length, 16);
  judged.length = 0;
  const nanCap = await searchMemory(manager, { lex: "k", vec: "v" }, {
    apiKey: "test", timeoutMs: 100, conversation: { history: [], currentRequest: "v" },
    maxJudgeCandidates: Number.NaN, maxResults: 20,
  });
  assert.equal(nanCap.requestsSucceeded, 16, "non-finite maxJudgeCandidates is ignored rather than coerced to zero");
});

test("explicit two-query search retrieves, scopes, deduplicates and judges real indexed evidence without generation or recall gating", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-search-e2e-"));
  const files = resolveSource(root, "*.md", "memory");
  const sessions = resolveSessionSource(join(root, "sessions"), ["channel", "direct"]);
  const qmd = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: Object.fromEntries(
    [files, sessions].map(source => [source.collection, { path: source.root, pattern: source.pattern }]),
  ) } });
  const docs = [
    { collection: files.collection, path: "keyword.md", text: "Exactneedle rollout was approved by Bek.", vector: [0, 1] },
    { collection: files.collection, path: "semantic.md", text: "The decision was to deploy only after review.", vector: [1, 0] },
    { collection: files.collection, path: "unrelated.md", text: "Exactneedle was mentioned in unrelated lunch planning.", vector: [0, 1] },
    { collection: sessions.collection, path: "channel.md", text: "Exactneedle channel discussion records the rollout approval.", vector: [1, 0] },
    { collection: sessions.collection, path: "direct.md", text: "Exactneedle secret direct-message content must not be sent.", vector: [1, 0] },
  ];
  qmd.internal.ensureVecTable(2);
  const model = qmd.internal.llm!.embedModelName;
  await mkdir(sessions.root, { recursive: true });
  for (const [index, doc] of docs.entries()) {
    await writeFile(join(doc.collection === files.collection ? files.root : sessions.root, doc.path), doc.text);
    const hash = `search-e2e-${index}`;
    qmd.internal.insertContent(hash, doc.text, "2026-10-10");
    qmd.internal.insertDocument(doc.collection, doc.path, "Evidence", hash, "2026-10-10", "2026-10-10");
    qmd.internal.insertEmbedding(hash, 0, 0, new Float32Array(doc.vector), model, "2026-10-10", 1, undefined, doc.text.length);
  }
  const embeddings: string[] = [];
  t.mock.method(qmd.internal.llm!, "embed", async (query: string) => {
    embeddings.push(query);
    return { embedding: [1, 0], model };
  });
  const manifestPath = join(root, "sessions-manifest.json");
  await writeFile(manifestPath, JSON.stringify({ version: 1, sessions: Object.fromEntries(["channel", "direct"].map(chatType =>
    [chatType, { sessionId: chatType, provider: "slack", chatType, startedAt: 0, documentPath: `${chatType}.md` }])) }));
  const manager = new QmdMemoryManager({ dbPath: qmd.dbPath, workspaceDir: root, sources: [files, sessions],
    storeFactory: async () => qmd, sessions: { agentId: "bill", agentName: "Bill", chatTypes: ["channel", "direct"],
      collection: sessions.collection, databasePath: join(root, "unused.sqlite"), manifestPath,
      outputDir: sessions.root, timezone: "UTC", maxExpandedTokens: 500 } });
  t.after(() => manager.close());
  type Tool = { execute(id: string, input: unknown, signal?: AbortSignal): Promise<unknown> };
  let factory: ((context: OpenClawPluginToolContext) => Tool | null) | undefined;
  let diagnosticsFactory: typeof factory;
  let getFactory: typeof factory;
  const api = {
    pluginConfig: { decisionModel: { enabled: true, apiKey: "test-key" } },
    registerCli() {}, registerService() {}, on() {}, registerGatewayMethod() {},
    registerMemoryCapability({ runtime }: { runtime: QmdMemoryRuntime }) {
      Object.defineProperty(runtime, "getMemorySearchManager", { value: async () => ({ manager }) });
    },
    registerTool(candidate: typeof factory, options: { names: string[] }) {
      if (options.names.includes("memory_search")) factory = candidate;
      if (options.names.includes("memory_diagnostics")) diagnosticsFactory = candidate;
      if (options.names.includes("memory_get")) getFactory = candidate;
    },
  } as unknown as OpenClawPluginApi;
  registerUnblockMemory(api);
  const context = { agentId: "search-e2e", config: {} } as OpenClawPluginToolContext;
  const tool = factory!(context)!;
  const diagnostics = diagnosticsFactory!(context)!;
  const judged: string[] = [];
  let provider: "partial" | "failed" | "healthy" = "partial";
  t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    assert.equal(url, "https://codex.unblocklabs.ai/v1/decisions", "no query generation service");
    const request = JSON.parse(String(init?.body));
    const [state] = request.state;
    assert.deepEqual(Object.keys(request.questions), ["memory_0"], "no recall gate");
    assert.deepEqual(state.conversation, { history: [], currentRequest: "Who approved the rollout and under what conditions?" });
    assert.equal(state.candidates.length, 1);
    const path: string = state.candidates[0].sourcePath;
    assert.ok(!path.endsWith("direct.md"), "session filter applies before external judging");
    judged.push(path);
    if (provider === "failed" || (provider === "partial" && path.endsWith("channel.md"))) return new Response(null, { status: 529 });
    const noul = path.endsWith("semantic.md") ? 0.956 : path.endsWith("keyword.md") ? 0.854 : 0.1;
    return Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { memory_0: { type: "noul", noul } } });
  });
  const input = { bm25Query: "Exactneedle", vectorQuery: "Who approved the rollout and under what conditions?",
    corpora: ["memory", "sessions"], sessionFilter: { chatType: "channel" }, maxResults: 2 };
  const result = await tool.execute("search", input) as { details: { results: { path: string; score: number; snippet: string }[]; warning: string } };
  assert.deepEqual(result.details.results.map(hit => [hit.path.split("/").at(-1), hit.score]), [["semantic.md", 0.96], ["keyword.md", 0.85]]);
  assert.equal(result.details.results[0]!.snippet, docs[1]!.text);
  assert.equal(new Set(judged).size, judged.length, "each deduplicated passage is judged once");
  assert.equal(judged.length, 4, "both lanes contribute while the DM is excluded");
  assert.equal(embeddings.length, 1);
  assert.ok(embeddings[0]!.endsWith(input.vectorQuery));
  assert.match(result.details.warning, /partial/);
  provider = "failed";
  const failed = await tool.execute("failed", { ...input, minUsefulness: 1 }) as { details: {
    results: { path: string; score: number; startLine: number; endLine: number }[];
    warning: string; rankingMode: string; minUsefulnessApplied: boolean;
  } };
  assert.equal(failed.details.results.length, 2);
  assert.ok(failed.details.results.every(hit => !hit.path.endsWith("direct.md")));
  assert.equal(failed.details.rankingMode, "retrieval");
  assert.equal(failed.details.minUsefulnessApplied, false);
  assert.match(failed.details.warning, /unjudged/);
  for (const hit of failed.details.results) {
    const read = await getFactory!(context)!.execute("read-fallback", {
      path: hit.path, from: hit.startLine, lines: hit.endLine - hit.startLine + 1,
    }) as { details: { status: string; text: string } };
    assert.equal(read.details.status, "ok");
    const expected = docs.find(doc => hit.path.endsWith(`/${doc.path}`))!;
    assert.ok(read.details.text.includes(expected.text), "fallback references resolve to the exact indexed evidence");
  }
  const snapshot = await diagnostics.execute("diagnostics", {}) as { details: {
    whisperers: { telemetry: { operations: Record<string, {
      calls: number; outcomes: Record<string, number>;
      measurements: Record<string, { samples: number; total: number }>;
      slowestRecent: ({ outcome: string } & Partial<Record<string, number | string>>)[];
    }> } };
  } };
  const operations = snapshot.details.whisperers.telemetry.operations;
  assert.equal(operations.memorySearch?.calls, 2);
  assert.equal(operations.memorySearch!.outcomes.partial, 1);
  assert.equal(operations.memorySearch!.outcomes.degraded, 1);
  assert.equal(operations.memorySearch!.measurements.fallbackAllJudgmentsFailed!.total, 1);
  assert.equal(operations.memorySearch!.measurements.elapsedMs!.samples, 2);
  assert.equal(operations.memorySearch!.measurements.results!.total, 4);
  assert.equal(operations.memorySearch!.measurements.retrievalMs!.samples, 2);
  assert.equal(operations.memorySearch!.measurements.judgeMs!.samples, 2);
  for (const stage of ["setupMs", "queueWaitMs", "metadataMs", "storeSetupMs", "bm25Ms", "vectorMs",
    "embeddingMs", "vectorScanMs", "hydrationMs", "vectorMappingMs", "passageMs", "candidatePrepMs", "otherMs"]) {
    assert.equal(operations.memorySearch!.measurements[stage]!.samples, 2, `${stage} reached real tool diagnostics`);
  }
  assert.ok(operations.memorySearch!.measurements.vectorScanAttempts!.total >= 2);
  const slow = operations.memorySearch!.slowestRecent[0]!;
  assert.ok(Number(slow.retrievalMs) >= Number(slow.queueWaitMs) + Number(slow.bm25Ms) + Number(slow.vectorMs));
  assert.equal(operations.memoryWhisperer, undefined, "manual search must not count as automatic recall");
  assert.ok(!JSON.stringify(operations).includes("Exactneedle"), "telemetry contains no query or evidence text");
  const calls = judged.length;
  await assert.rejects(tool.execute("legacy", { query: "Exactneedle" }));
  await assert.rejects(tool.execute("too-large", { ...input, vectorQuery: "x".repeat(24_001) }), /context budget/);
  await assert.rejects(tool.execute("cancelled", input, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(judged.length, calls, "invalid input never reaches decision model");
  const finalSnapshot = await diagnostics.execute("diagnostics", {}) as typeof snapshot;
  const finalOperations = finalSnapshot.details.whisperers.telemetry.operations;
  assert.equal(finalOperations.memorySearch!.calls, 5, "one observation per tool invocation, even on early failures");
  assert.deepEqual(finalOperations.memorySearch!.outcomes, { partial: 1, degraded: 1, failed: 1, skipped: 1, cancelled: 1 });
  assert.equal(finalOperations.memorySearch!.measurements.elapsedMs!.samples, 5);

  // A native embedding can outlive cancellation. Keep partial timing, send no
  // passages, and preserve queue waiting for a second search behind that work.
  let embeddingStartedResolve: () => void = () => {};
  let releaseEmbeddingResolve: () => void = () => {};
  const embeddingStarted = new Promise<void>(resolve => { embeddingStartedResolve = resolve; });
  const releaseEmbedding = new Promise<void>(resolve => { releaseEmbeddingResolve = resolve; });
  t.mock.method(qmd.internal.llm!, "embed", async () => {
    embeddingStartedResolve();
    await releaseEmbedding;
    return { embedding: [1, 0], model };
  });
  const controller = new AbortController();
  const cancelled = assert.rejects(tool.execute("mid-retrieval", input, controller.signal), { name: "AbortError" });
  await embeddingStarted;
  const queueController = new AbortController();
  const queued = assert.rejects(tool.execute("queued", input, queueController.signal), { name: "AbortError" });
  await setImmediate();
  controller.abort();
  queueController.abort();
  releaseEmbeddingResolve();
  await Promise.all([cancelled, queued]);
  assert.equal(judged.length, calls, "cancelled discovery must not disclose passages");
  const cancelledSnapshot = await diagnostics.execute("diagnostics", {}) as typeof snapshot;
  const cancelledSearch = cancelledSnapshot.details.whisperers.telemetry.operations.memorySearch!;
  assert.equal(cancelledSearch.outcomes.cancelled, 3);
  assert.equal(cancelledSearch.measurements.retrievalMs!.samples, 4);
  assert.equal(cancelledSearch.measurements.vectorMs!.samples, 3, "queued cancellation never entered vector retrieval");
  assert.equal(cancelledSearch.measurements.judgeMs!.samples, 2, "unexecuted ranking is absent, not zero");

  provider = "healthy";
  const recovered = await tool.execute("recovered", { ...input, minUsefulness: 0.9 }) as { details: {
    rankingMode: string; minUsefulnessApplied: boolean; warning?: string; fallbackReason?: string;
    results: { path: string; score: number }[];
  } };
  assert.equal(recovered.details.rankingMode, "decision");
  assert.equal(recovered.details.minUsefulnessApplied, true);
  assert.equal(recovered.details.warning, undefined);
  assert.equal(recovered.details.fallbackReason, undefined);
  assert.deepEqual(recovered.details.results.map(hit => [hit.path.split("/").at(-1), hit.score]), [["semantic.md", 0.96]],
    "the next healthy call restores usefulness ranking and its threshold without reinitializing the tool");
});

function topicHit(snippet: string, score: number, corpus = "memory") {
  return { path: `qmd://${corpus}/${snippet}.md`, startLine: 1, endLine: 2, score, snippet, source: "memory" as const, corpus };
}
function judgeAll(t: test.TestContext, judged: string[] = []) {
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    judged.push(JSON.parse(String(init?.body)).state[0].candidates[0].excerpt);
    return Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { memory_0: { type: "noul", noul: 0.9 } } });
  });
  return judged;
}
const judgeOptions = { apiKey: "k", timeoutMs: 100, conversation: { history: [], currentRequest: "Check Sarah's invoice and Pearl's disk" } };

test("searchMemory keeps single-query behavior identical for a pair or a one-element list", async t => {
  const pair = { lex: "Sarah invoice", vec: "Sarah's invoice status" };
  const hits = [topicHit("alpha", 0.3), topicHit("beta", 0.2)];
  const calls: unknown[] = [];
  const manager = { searchCandidates: async (queries: unknown) => { calls.push(queries); return hits; } };
  judgeAll(t);
  const single = await searchMemory(manager, pair, { ...judgeOptions, maxJudgeCandidates: 6 });
  const listed = await searchMemory(manager, [pair], { ...judgeOptions, maxJudgeCandidates: 6 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0], pair);
  assert.equal(calls[1], pair);
  const strip = (result: typeof single) => ({ ...result, retrievalMs: 0, judgeMs: 0, candidatePrepMs: 0, retrievalOtherMs: 0 });
  assert.deepEqual(strip(listed), strip(single));
  await assert.rejects(searchMemory(manager, [], judgeOptions), RangeError);
});

test("multi-topic search fans out in parallel, fuses by passage RRF, and reserves a judge slot per topic", async t => {
  const sarah = { lex: "Sarah's invoice", vec: "Sarah's invoice: check it" };
  const pearl = { lex: "Pearl's disk", vec: "Pearl's disk: check it" };
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const shared = "Shared ops note covering Sarah and Pearl";
  const results: Record<string, ReturnType<typeof topicHit>[]> = {
    [sarah.lex]: [topicHit(shared, 0.5), ...Array.from({ length: 6 }, (_, i) => topicHit(`Sarah invoice detail ${i}`, 0.9 - i / 100))],
    [pearl.lex]: [topicHit("Pearl disk at 97 percent", 0.05), topicHit(shared, 0.7), topicHit("Pearl disk cleanup plan", 0.04)],
  };
  const manager = { searchCandidates: async (queries: { lex: string }, options: { corpora?: readonly string[] }) => {
    started.push(queries.lex);
    assert.deepEqual(options.corpora, ["memory"]);
    await gate;
    return results[queries.lex]!;
  } };
  const judged = judgeAll(t);
  const pending = searchMemory(manager, [sarah, pearl], { ...judgeOptions, corpora: ["memory"], maxJudgeCandidates: 2, maxResults: 4 });
  await setImmediate();
  assert.deepEqual(started, [sarah.lex, pearl.lex], "both topic searches start before either resolves");
  release();
  const search = await pending;
  // Shared passage: 1/61 (Sarah rank 1) + 1/62 (Pearl rank 2) beats every single-topic hit.
  assert.equal(judged[0], shared);
  assert.equal(judged.length, 2);
  assert.ok(judged.includes("Pearl disk at 97 percent"), "Pearl's own top hit is reserved even though Sarah's hits fuse higher");
  assert.equal(search.candidates, 1 + 6 + 2, "candidates are deduplicated by passage identity");
  const sharedResult = search.results.find(hit => hit.snippet === shared)!;
  assert.equal(sharedResult.path, `qmd://memory/${shared}.md`);
});

test("multi-topic reservation still caps at maxJudgeCandidates and tolerates one failed topic", async t => {
  const topics = [{ lex: "a", vec: "a" }, { lex: "b", vec: "b" }, { lex: "c", vec: "c" }];
  const manager = { searchCandidates: async (queries: { lex: string }) => {
    if (queries.lex === "b") throw new Error("qmd lane failed");
    return Array.from({ length: 4 }, (_, i) => topicHit(`${queries.lex} hit ${i}`, 0.5));
  } };
  const judged = judgeAll(t);
  const search = await searchMemory(manager, topics, { ...judgeOptions, maxJudgeCandidates: 3 });
  assert.equal(judged.length, 3);
  assert.ok(judged.includes("a hit 0") && judged.includes("c hit 0"));
  assert.equal(search.eligible, 8);
  assert.equal(search.topicsFailed, 1, "a partial topic failure is reported, not hidden");
  const failing = { searchCandidates: async () => { throw new Error("all down"); } };
  await assert.rejects(searchMemory(failing, topics, judgeOptions), /all down/u);
});

function judgeBy(t: test.TestContext, score: (excerpt: string) => number, bodies: string[] = []) {
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    bodies.push(String(init?.body));
    const excerpt = JSON.parse(String(init?.body)).state[0].candidates[0].excerpt;
    return Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { memory_0: { type: "noul", noul: score(excerpt) } } });
  });
  return bodies;
}

test("multi-topic finalists reserve each topic's best qualifying hit before filling by usefulness", async t => {
  const topics = [{ lex: "a", vec: "a" }, { lex: "b", vec: "b" }];
  const manager = { searchCandidates: async (queries: { lex: string }) => queries.lex === "a"
    ? Array.from({ length: 5 }, (_, i) => topicHit(`Topic A hit ${i}`, 0.9))
    : [topicHit("Topic B hit", 0.1)] };
  judgeBy(t, excerpt => excerpt.startsWith("Topic B") ? 0.75 : 0.95 - Number(excerpt.at(-1)) / 100);
  const search = await searchMemory(manager, topics, { ...judgeOptions, maxJudgeCandidates: 6, maxResults: 4, minUsefulness: 0.7 });
  assert.equal(search.results.length, 4);
  assert.ok(search.results.some(hit => hit.snippet === "Topic B hit"), "topic B's qualifying hit survives four stronger topic A hits");
  assert.deepEqual(search.results.map(hit => hit.score), [...search.results.map(hit => hit.score)].sort((a, b) => b - a),
    "finalists stay in usefulness order");
  // Reservation never admits a hit below the usefulness threshold.
  judgeBy(t, excerpt => excerpt.startsWith("Topic B") ? 0.5 : 0.95);
  const strict = await searchMemory(manager, topics, { ...judgeOptions, maxJudgeCandidates: 6, maxResults: 4, minUsefulness: 0.7 });
  assert.ok(!strict.results.some(hit => hit.snippet === "Topic B hit"));
  assert.equal(strict.results.length, 4);
});

test("usefulness judging sees an extracted observation's own date", async t => {
  const observedAt = "2025-03-14T09:30:00.000Z";
  const extracted = { ...topicHit("Bek lives in Brooklyn.", 0.9, "extracted"),
    extracted: { id: "x1", revision: 1, observedAt, sessionId: "s1", evidence: [] } };
  const bodies = judgeBy(t, () => 0.9);
  await searchMemory({ searchCandidates: async () => [extracted] as never }, { lex: "Bek", vec: "where does Bek live" },
    { ...judgeOptions, maxJudgeCandidates: 6 });
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0]!.includes(observedAt), "the observation date is passed as a candidate date");
});

test("parallel topic searches record into separate timing buckets and merge without overwriting", async t => {
  const topics = [{ lex: "slow", vec: "slow" }, { lex: "fast", vec: "fast" }];
  const sinks: object[] = [];
  const manager = { searchCandidates: async (queries: { lex: string }, options: { timings?: Record<string, number> }) => {
    sinks.push(options.timings!);
    // Mimic startTiming: read the previous value, await, then write previous + elapsed.
    const previous = options.timings!.bm25Ms ?? 0;
    await new Promise(resolve => setTimeout(resolve, queries.lex === "slow" ? 30 : 1));
    options.timings!.bm25Ms = previous + (queries.lex === "slow" ? 30 : 1);
    options.timings!.vectorScanAttempts = (options.timings!.vectorScanAttempts ?? 0) + 1;
    return [topicHit(`${queries.lex} hit`, 0.5)];
  } };
  judgeAll(t);
  const timings: Record<string, number> = { bm25Ms: 5 };
  await searchMemory(manager, topics, { ...judgeOptions, timings, maxJudgeCandidates: 6 });
  assert.notEqual(sinks[0], sinks[1], "each topic gets its own sink");
  assert.notEqual(sinks[0], timings);
  assert.equal(timings.bm25Ms, 5 + 30, "overlapping durations add their maximum to the outer sink");
  assert.equal(timings.vectorScanAttempts, 2, "counters add up");
});

test("managers with searchCandidateTopics run every topic in one call", async t => {
  const calls: unknown[][] = [];
  const manager = {
    searchCandidates: async () => assert.fail("one-job managers must not be queued once per topic"),
    searchCandidateTopics: async (topics: readonly { lex: string }[]) => {
      calls.push([...topics]);
      return topics.map(topic => topic.lex === "b"
        ? { status: "rejected" as const, reason: new Error("lane failed") }
        : { status: "fulfilled" as const, value: [topicHit(`${topic.lex} hit`, 0.5)] });
    },
  };
  judgeAll(t);
  const topics = [{ lex: "a", vec: "a" }, { lex: "b", vec: "b" }, { lex: "c", vec: "c" }];
  const search = await searchMemory(manager, topics, { ...judgeOptions, maxJudgeCandidates: 6 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], topics);
  assert.equal(search.topicsFailed, 1);
  assert.deepEqual(search.results.map(hit => hit.snippet).sort(), ["a hit", "c hit"]);
});
