import assert from "node:assert/strict";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OpenClawConfig, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "../src/config.js";
import type { CorpusMemorySearchResult } from "../src/contracts.js";
import { cancelAllDeepThoughtJobs, createDeepThoughtTool } from "../src/deep-thought.js";
import { DeepThoughtStore, findMatchingDerivedObservationsReadOnly, readDerivedObservationCandidates } from "../src/deep-thought-store.js";
import {
  FLEET_COMMONS_COLLECTION, fleetCommonsHit, resolveFleetCommonsConfig, syncFleetCommons, type FleetCommonsEntry, type FleetCommonsSyncResult,
} from "../src/fleet-commons.js";
import { QmdMemoryManager, type ManagerStore } from "../src/manager.js";
import { searchMemory } from "../src/memory-search.js";
import { registerMemoryWhisperer } from "../src/memory-whisperer.js";
import { QmdMemoryRuntime } from "../src/runtime.js";
import { resolveSource } from "../src/sources.js";
import { registerWhispererPrompt, type WhispererPrompt } from "../src/whisperer-prompt.js";

const endpoint = "https://fleet.example.test/api/v1/commons";
const entry: FleetCommonsEntry = {
  id: "task-run", revision: 1, category: "tool_pitfall", severity: "warn", title: "Retry after deployment",
  body: "Retry transient deploy failures with backoff.", tags: ["deployment"], updatedAt: Date.now() - 60_000,
};
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(5);
  }
}

type VectorHit = Awaited<ReturnType<ManagerStore["vsearch"]>>[number];

/** A fake QMD store whose vector search returns `hits()` for the fleet collection. */
function fakeStore(hits: () => VectorHit[]): ManagerStore {
  let active = 0;
  return {
    async update() { return { collections: 0, indexed: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0, needsEmbedding: 0 }; },
    async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
    async getStatus() { return { totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
    async listCollections() {
      return [{ name: FLEET_COMMONS_COLLECTION, pwd: "", glob_pattern: "", doc_count: active, active_count: active,
        last_modified: null, includeByDefault: false, projected: true }];
    },
    async vsearch(_query, options) {
      const collections = typeof options?.collection === "string" ? [options.collection] : [...(options?.collection ?? [])];
      return collections.includes(FLEET_COMMONS_COLLECTION) ? hits() : [];
    },
    async get(query) { return { error: "not_found" as const, query, similarFiles: [] }; },
    async close() {},
    async upsertDocument() { return { changed: false, hash: "", docid: "", generation: 0 }; },
    async retractDocument() { return { deactivated: false, generation: 0 }; },
    async syncProjectedCollection(_collection, docs) {
      active = [...docs].length;
      return { upserted: active, unchanged: 0, retracted: 0, embedded: 0, generation: 1 };
    },
    async getCollectionGeneration() { return 1; },
  };
}

async function fleetManager(t: test.TestContext, config: ReturnType<typeof resolveFleetCommonsConfig>, hits: () => VectorHit[] = () => []) {
  const dir = await mkdtempDisposable(join(tmpdir(), "fleet-runtime-"));
  t.after(() => dir[Symbol.asyncDispose]());
  await writeFile(join(dir.path, "MEMORY.md"), "memory body\n");
  const manager = new QmdMemoryManager({
    dbPath: join(dir.path, "index.sqlite"), curationPath: join(dir.path, "unblock-memory.sqlite"), workspaceDir: dir.path,
    sources: [resolveSource(dir.path, "MEMORY.md", "memory")], storeFactory: async () => fakeStore(hits), fleetCommons: config,
  });
  t.after(() => manager.close());
  await manager.start();
  return { manager, dir: dir.path };
}

test("a slow Fleet Commons fetch never holds the manager's write queue", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let fetched = false;
  t.mock.method(globalThis, "fetch", async () => { fetched = true; await gate; return Response.json([entry]); });
  const { manager } = await fleetManager(t, resolveFleetCommonsConfig({ enabled: true, endpoint }));
  const pending = manager.syncFleetCommons();
  await waitFor(() => fetched, "feed request");
  // search() waits on #operationChain; it must finish while the feed request is still outstanding.
  const searched = await Promise.race([manager.search("deploy", { corpora: ["memory"] }).then(() => "done"), delay(1_000).then(() => "blocked")]);
  assert.equal(searched, "done");
  release();
  assert.partialDeepStrictEqual(await pending, { status: "synced", count: 1, changed: true });
});

test("closing a manager aborts its in-flight Fleet Commons request; a caller signal propagates to fetch", async t => {
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signals.push(init!.signal!);
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  }));
  const { manager } = await fleetManager(t, resolveFleetCommonsConfig({ enabled: true, endpoint, timeoutMs: 60_000 }));
  const caller = new AbortController();
  const first = manager.syncFleetCommons(caller.signal);
  await waitFor(() => signals.length === 1, "first request");
  caller.abort(new Error("caller gave up"));
  await assert.rejects(first, /caller gave up/u);
  assert.equal(signals[0]!.aborted, true);
  const second = manager.syncFleetCommons();
  await waitFor(() => signals.length === 2, "second request");
  const started = Date.now();
  await manager.close();
  await assert.rejects(second);
  assert.ok(Date.now() - started < 1_000, "close did not wait out the request timeout");
});

test("a long Fleet entry is served as its bounded matched passage, with lines matching memory_get", async t => {
  const passage = "Retry with jitter after a 503.\nThen poll status.";
  const body = ["Intro line.", "x".repeat(1_300), passage, "Outro."].join("\n");
  const long = { ...entry, body };
  const feedDir = await mkdtempDisposable(join(tmpdir(), "fleet-feed-"));
  t.after(() => feedDir[Symbol.asyncDispose]());
  const feedPath = join(feedDir.path, "feed.json");
  await writeFile(feedPath, JSON.stringify([long]));
  const { manager } = await fleetManager(t, resolveFleetCommonsConfig({ enabled: true, feedPath }), () => [{
    file: `qmd://${FLEET_COMMONS_COLLECTION}/task-run/1`, displayPath: `${FLEET_COMMONS_COLLECTION}/task-run/1`, title: long.title,
    body, score: 0.9, context: null, docid: "task-run", bestChunk: passage, chunkPos: body.indexOf(passage), chunkLen: passage.length,
  }]);
  await manager.syncFleetCommons();
  const [hit] = await manager.search("retry jitter", { corpora: ["fleet"], maxSnippetChars: 1_200 });
  assert.ok(hit, "the long entry is not dropped");
  assert.equal(hit.snippet, passage);
  const read = await manager.readFile({ relPath: hit.path, from: hit.startLine, lines: hit.endLine - hit.startLine + 1 });
  // The cited line range is exactly the passage (followed only by the read continuation notice).
  assert.equal(read.text.split("\n").slice(0, 2).join("\n"), passage);
  assert.match(read.text, /Use from=7 to continue/u);
  const whole = await manager.search("retry jitter", { corpora: ["fleet"] });
  assert.equal(whole[0]?.snippet, body, "ordinary search without a budget still returns the whole body");
});

function fleetRuntime(t: test.TestContext, root: string) {
  const runtime = new QmdMemoryRuntime([{ name: "memory", kind: "files", paths: ["MEMORY.md"] }], {
    stateRoot: root, fleetCommons: resolveFleetCommonsConfig({ enabled: true, endpoint, syncIntervalMinutes: 0.0005 }),
  });
  t.after(() => runtime.close());
  return runtime;
}

test("the runtime syncs a manager when it opens and then only already-open managers, logging rejected entries", async t => {
  await using dir = await mkdtempDisposable(join(tmpdir(), "fleet-runtime-schedule-"));
  const started: QmdMemoryManager[] = [];
  const synced: QmdMemoryManager[] = [];
  t.mock.method(QmdMemoryManager.prototype, "start", async function (this: QmdMemoryManager) { started.push(this); });
  t.mock.method(QmdMemoryManager.prototype, "close", async () => {});
  t.mock.method(QmdMemoryManager.prototype, "syncFleetCommons", async function (this: QmdMemoryManager): Promise<FleetCommonsSyncResult> {
    synced.push(this);
    return { status: "synced", count: 1, changed: false, rejected: [{ id: "leaky", reasons: ["body: email address"] }] };
  });
  const runtime = fleetRuntime(t, dir.path);
  const cfg = { agents: { defaults: { workspace: dir.path }, list: [{ id: "main" }, { id: "other" }] } } as OpenClawConfig;
  const warnings: string[] = [];
  const errors: unknown[] = [];
  // Initial sync on open; no schedule hooks yet, so the rejection goes to console.warn.
  const warn = t.mock.method(console, "warn", () => {});
  const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "main" });
  assert.ok(manager);
  await waitFor(() => synced.length === 1, "initial sync");
  await waitFor(() => warn.mock.callCount() === 1, "initial rejection warning");
  warn.mock.restore();
  runtime.startFleetCommonsSchedule(error => errors.push(error), { onRejected: message => warnings.push(message) });
  await waitFor(() => synced.length >= 3, "scheduled syncs");
  runtime.stopFleetCommonsSchedule();
  assert.deepEqual(new Set(synced), new Set([manager]), "only the open manager syncs");
  assert.equal(started.length, 1, "the unused agent was never cold-started");
  assert.ok(warnings.length >= 2);
  assert.equal(warnings[0], "unblock-memory fleet commons rejected 1 entry for agent main: leaky (body: email address)");
  assert.deepEqual(errors, []);
});

test("gateway abort cancels the current sync and does not start the next manager in that sweep", async t => {
  await using dir = await mkdtempDisposable(join(tmpdir(), "fleet-runtime-abort-"));
  const signals = new Map<QmdMemoryManager, Array<AbortSignal | undefined>>();
  const fetching = deferred<void>(), release = deferred<void>();
  let first: QmdMemoryManager | undefined;
  t.mock.method(QmdMemoryManager.prototype, "start", async () => {});
  t.mock.method(QmdMemoryManager.prototype, "close", async () => {});
  t.mock.method(QmdMemoryManager.prototype, "syncFleetCommons", async function (
    this: QmdMemoryManager, signal?: AbortSignal,
  ): Promise<FleetCommonsSyncResult> {
    first ??= this;
    const seen = signals.get(this) ?? [];
    signals.set(this, seen);
    seen.push(signal);
    if (this === first && seen.length === 2) { fetching.resolve(); await release.promise; }
    return { status: "not_modified", count: 0, changed: false, rejected: [] };
  });
  const runtime = fleetRuntime(t, dir.path);
  const gateway = new AbortController();
  const errors: unknown[] = [];
  const cfg = { agents: { defaults: { workspace: dir.path }, list: [{ id: "main" }, { id: "other" }] } };
  runtime.startFleetCommonsSchedule(error => errors.push(error), { signal: gateway.signal });
  const { manager: main } = await runtime.getMemorySearchManager({ cfg, agentId: "main" });
  const { manager: other } = await runtime.getMemorySearchManager({ cfg, agentId: "other" });
  assert.ok(main && other);
  await waitFor(() => signals.get(main)?.length === 2, "scheduled sync");
  await fetching.promise;
  gateway.abort();
  release.resolve();
  assert.ok([...signals.values()].flat().every(signal => signal?.aborted));
  await delay(100);
  assert.equal(signals.get(main)?.length, 2);
  assert.equal(signals.get(other)?.length, 1, "the aborted sweep cannot start an uncancelled sync for the next agent");
  assert.deepEqual(errors, []);
});

test("a starting manager cannot stall ready managers or sync after gateway abort", async t => {
  await using dir = await mkdtempDisposable(join(tmpdir(), "fleet-runtime-starting-"));
  const startup = deferred<void>();
  const started: QmdMemoryManager[] = [], synced: QmdMemoryManager[] = [];
  t.mock.method(QmdMemoryManager.prototype, "start", async function (this: QmdMemoryManager) {
    started.push(this);
    if (started.length === 1) await startup.promise;
  });
  t.mock.method(QmdMemoryManager.prototype, "close", async () => {});
  t.mock.method(QmdMemoryManager.prototype, "syncFleetCommons", async function (this: QmdMemoryManager): Promise<FleetCommonsSyncResult> {
    synced.push(this);
    return { status: "not_modified", count: 0, changed: false, rejected: [] };
  });
  const runtime = fleetRuntime(t, dir.path);
  const cfg = { agents: { defaults: { workspace: dir.path }, list: [{ id: "main" }, { id: "other" }] } };
  const gateway = new AbortController();
  runtime.startFleetCommonsSchedule(error => assert.fail(String(error)), { signal: gateway.signal });
  const opening = runtime.getMemorySearchManager({ cfg, agentId: "main" });
  try {
    const { manager } = await runtime.getMemorySearchManager({ cfg, agentId: "other" });
    assert.ok(manager);
    await waitFor(() => synced.length >= 2, "ready manager's initial and scheduled syncs");
    assert.ok(synced.every(candidate => candidate === manager));
  } finally {
    gateway.abort();
    startup.resolve();
    await opening;
  }
  assert.ok(!synced.includes(started[0]!));
});

test("a cached derived observation citing an expired or retired Fleet entry is stale", async t => {
  await using dir = await mkdtempDisposable(join(tmpdir(), "fleet-derived-"));
  const dbPath = join(dir.path, "unblock-memory.sqlite"), feedPath = join(dir.path, "feed.json");
  const now = Date.now();
  const outage = { ...entry, id: "queue-outage", category: "platform_outage" as const, expiresAt: now + 60_000 };
  await writeFile(feedPath, JSON.stringify([entry, outage]));
  const sync = () => syncFleetCommons({ storePath: dbPath, config: resolveFleetCommonsConfig({ enabled: true, feedPath }),
    store: { syncProjectedCollection: async () => ({ upserted: 0, unchanged: 0, retracted: 0, embedded: 0, generation: 0 }) } });
  await sync();
  const store = new DeepThoughtStore(dbPath);
  t.after(() => store.close());
  const generations = { [FLEET_COMMONS_COLLECTION]: 3 };
  const base = { agentId: "main", audienceKey: "aud", corpora: ["fleet"], collectionGenerations: generations, answer: "Pause retries.",
    confidence: "high", nowMs: now };
  store.saveDerivedObservation({ ...base, question: "Should queue retries pause during the outage?",
    citations: [{ source: `qmd://${FLEET_COMMONS_COLLECTION}/queue-outage/1#L3-L3`, quote: "Pause" }] });
  store.saveDerivedObservation({ ...base, question: "How should deploy retries back off?",
    citations: [{ source: "fleet:task-run@r1", quote: "backoff" }] });
  const key = { agentId: "main", audienceKey: "aud", corpora: ["fleet"] };
  const match = { agentId: "main", audienceKey: "aud", allowedCorpora: ["fleet"], minTokenOverlap: 0 };
  const outageQuestion = "Should queue retries pause during the outage?";
  assert.ok(store.findFreshDerivedObservation({ ...key, question: outageQuestion, currentGenerations: generations, nowMs: now }));

  // Expiry does not move the collection generation, yet the synthesis must not be served past it.
  const later = outage.expiresAt + 1;
  assert.deepEqual(readDerivedObservationCandidates(dbPath, { ...match, queryText: outageQuestion }, later), []);
  assert.deepEqual(findMatchingDerivedObservationsReadOnly(dbPath, { ...match, queryText: outageQuestion,
    currentGenerations: generations, nowMs: later }), []);
  assert.equal(store.findFreshDerivedObservation({ ...key, question: outageQuestion, currentGenerations: generations, nowMs: later }),
    undefined);
  assert.deepEqual(store.listDerivedObservations({ agentId: "main", status: "stale" }).map(found => found.question), [outageQuestion]);

  // Retired from the feed: the matching path marks it stale too.
  const deployQuestion = "How should deploy retries back off?";
  assert.equal(store.findMatchingDerivedObservations({ ...match, queryText: deployQuestion, currentGenerations: generations }).length, 1);
  await writeFile(feedPath, JSON.stringify([outage]));
  await sync();
  assert.deepEqual(store.findMatchingDerivedObservations({ ...match, queryText: deployQuestion, currentGenerations: generations }), []);
  assert.equal(store.listDerivedObservations({ agentId: "main", status: "fresh" }).length, 0);
});

function fleetWhisperer(dbPath: string, allowExpired: boolean, searchCandidates: () => Promise<CorpusMemorySearchResult[]> = async () => []) {
  const config = resolveConfig({
    fleetCommons: { enabled: true, endpoint, allowExpired },
    memoryWhisperer: { enabled: true, mode: "legacy", corpora: ["fleet"], timeoutMs: 5000 },
    decisionModel: { apiKey: "dummy-test-key" },
  });
  const runtime = new QmdMemoryRuntime(config.corpora, { fleetCommons: config.fleetCommons });
  const api = { config: {}, on() {}, logger: { warn() {}, info() {} } } as unknown as OpenClawPluginApi;
  const whisper = registerMemoryWhisperer(api, {
    fleetCommonsAllowExpired: runtime.fleetCommonsAllowExpired,
    async getMemorySearchManager() { return { manager: { searchCandidates } }; },
  }, config.memoryWhisperer, config.decisionModel, undefined, undefined, { derivedObservations: {
    dbPathForAgent: () => dbPath, audienceKey: () => "aud",
    getCollectionGenerations: async () => ({ [FLEET_COMMONS_COLLECTION]: 1 }),
  } });
  assert.ok(whisper);
  return (runId: string) => whisper({ prompt: "How should deploy retries back off?", messages: [] },
    { trigger: "user", agentId: "main", sessionKey: "agent:main:main", runId });
}

async function derivedFleetFixture(t: test.TestContext) {
  const dir = await mkdtempDisposable(join(tmpdir(), "fleet-whisper-delivery-"));
  const dbPath = join(dir.path, "cache.sqlite"), feedPath = join(dir.path, "feed.json");
  const now = Date.now(), expiresAt = now + 60_000;
  const sync = async (entries: FleetCommonsEntry[], allowExpired: boolean) => {
    await writeFile(feedPath, JSON.stringify(entries));
    await syncFleetCommons({ storePath: dbPath, config: resolveFleetCommonsConfig({ enabled: true, feedPath, allowExpired }),
      store: { syncProjectedCollection: async () => ({ upserted: 0, unchanged: 0, retracted: 0, embedded: 0, generation: 0 }) } });
  };
  const store = new DeepThoughtStore(dbPath);
  t.after(async () => { store.close(); await dir[Symbol.asyncDispose](); });
  store.saveDerivedObservation({
    agentId: "main", audienceKey: "aud", corpora: ["fleet"], collectionGenerations: { [FLEET_COMMONS_COLLECTION]: 1 },
    question: "How should deploy retries back off?", answer: "Wait a minute before retrying.", confidence: "high",
    citations: [{ source: "fleet:task-run@r1", quote: "backoff" }], nowMs: now,
  });
  return { dbPath, sync, now, expiresAt };
}

test("whisper delivery uses active allowExpired regardless of the last sync's policy", async t => {
  const { dbPath, sync, now, expiresAt } = await derivedFleetFixture(t);
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  await sync([{ ...entry, expiresAt }], false);
  clock = expiresAt;
  assert.match((await fleetWhisperer(dbPath, true)("serves-expired"))?.appendContext ?? "", /Wait a minute/u);
  await sync([{ ...entry, expiresAt }], true);
  assert.equal(await fleetWhisperer(dbPath, false)("refuses-expired"), undefined);
});

test("whisper delivery and same-run replay drop a derived synthesis whose Fleet citation was retired", async t => {
  const { dbPath, sync } = await derivedFleetFixture(t);
  await sync([entry], false);
  const rawStarted = deferred<void>(), release = deferred<CorpusMemorySearchResult[]>();
  const pendingWhisper = fleetWhisperer(dbPath, false, () => { rawStarted.resolve(); return release.promise; });
  const replayWhisper = fleetWhisperer(dbPath, false);
  assert.match((await replayWhisper("rebuild"))?.appendContext ?? "", /Wait a minute/u);
  const pending = pendingWhisper("in-flight");
  await rawStarted.promise;
  await sync([], false);
  release.resolve([]);
  assert.equal(await pending, undefined, "the synthesis selected before retirement is not injected");
  assert.equal(await replayWhisper("rebuild"), undefined, "a prompt rebuild cannot replay a retired citation");
});

test("a raw Fleet hit retired while async judging ran is dropped at delivery and never replayed", async t => {
  const feedDir = await mkdtempDisposable(join(tmpdir(), "fleet-raw-retire-"));
  t.after(() => feedDir[Symbol.asyncDispose]());
  const feedPath = join(feedDir.path, "feed.json");
  await writeFile(feedPath, JSON.stringify([entry]));
  const { manager } = await fleetManager(t, resolveFleetCommonsConfig({ enabled: true, feedPath }));
  await manager.syncFleetCommons();
  let gate: Promise<void> | undefined;
  const judging = deferred<void>();
  t.mock.method(globalThis, "fetch", async () => {
    judging.resolve();
    await gate;
    return Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { memory_0: { type: "noul", noul: 0.95 } } });
  });
  const config = resolveConfig({
    fleetCommons: { enabled: true, feedPath }, decisionModel: { apiKey: "dummy-test-key" },
    memoryWhisperer: { enabled: true, mode: "legacy", corpora: ["fleet"], timeoutMs: 5000 },
  });
  const api = { config: {}, on() {}, logger: { warn() {}, info() {} } } as unknown as OpenClawPluginApi;
  // Discovery is canned (the fake store has no QMD lanes); the delivery recheck is the real manager's live Fleet cache.
  const raw = { searchCandidates: async () => [fleetCommonsHit(entry, 0.9)],
    activeFleetHits: <T extends { path: string }>(hits: readonly T[]) => manager.activeFleetHits(hits) };
  const whisper = registerMemoryWhisperer(api, { async getMemorySearchManager() { return { manager: raw }; } },
    config.memoryWhisperer, config.decisionModel);
  assert.ok(whisper);
  const ask = (runId: string, sessionKey = "agent:main:main") => whisper({ prompt: "How should deploy retries back off?", messages: [] },
    { trigger: "user", agentId: "main", sessionKey, runId });

  // Delivered while live; a same-run rebuild replays it.
  const live = await ask("live", "agent:main:live");
  assert.match(live?.appendContext ?? "", /task-run\/1/u);
  assert.match((await ask("live", "agent:main:live"))?.appendContext ?? "", /task-run\/1/u);

  // Retired while the judge is in flight: the selected hit is not injected.
  let release!: () => void;
  gate = new Promise<void>(resolve => { release = resolve; });
  const pending = ask("in-flight");
  await judging.promise;
  await writeFile(feedPath, JSON.stringify([]));
  await manager.syncFleetCommons();
  release();
  assert.equal(await pending, undefined, "a raw Fleet hit retired during judging is never rendered");
  assert.equal(await ask("live", "agent:main:live"), undefined, "a prompt rebuild cannot replay a retired raw Fleet hit");
});

/** A live Fleet feed + manager, and a canned-discovery manager whose delivery recheck is the real live Fleet cache. */
async function retirableFleet(t: test.TestContext, extra: CorpusMemorySearchResult[] = []) {
  const feedDir = await mkdtempDisposable(join(tmpdir(), "fleet-boundary-"));
  t.after(() => feedDir[Symbol.asyncDispose]());
  const feedPath = join(feedDir.path, "feed.json");
  await writeFile(feedPath, JSON.stringify([entry]));
  const { manager } = await fleetManager(t, resolveFleetCommonsConfig({ enabled: true, feedPath }));
  await manager.syncFleetCommons();
  const raw = { searchCandidates: async () => [fleetCommonsHit(entry, 0.9), ...extra],
    activeFleetHits: <T extends { path: string }>(hits: readonly T[]) => manager.activeFleetHits(hits) };
  const retire = async () => { await writeFile(feedPath, JSON.stringify([])); await manager.syncFleetCommons(); };
  return { feedPath, raw, retire };
}

test("memory_search / deep_thought: a Fleet hit retired during async judging is dropped before searchMemory returns", async t => {
  const local: CorpusMemorySearchResult = { path: "qmd://memory/MEMORY.md", startLine: 1, endLine: 1, snippet: "Local retry memo",
    source: "memory", corpus: "memory", score: 0.5 };
  const { raw, retire } = await retirableFleet(t, [local]);
  let gate: Promise<void> | undefined;
  let judging = deferred<void>();
  t.mock.method(globalThis, "fetch", async () => {
    judging.resolve();
    await gate;
    return Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { memory_0: { type: "noul", noul: 0.95 } } });
  });
  const queries = { lex: "deploy retries", vec: "How should deploy retries back off?" };
  // Exactly the options shape memory_search and deep_thought's search_memory pass (explicit search, fallback allowed).
  const search = () => searchMemory(raw, queries, { corpora: ["fleet", "memory"], apiKey: "dummy-test-key", timeoutMs: 5_000,
    conversation: { history: [], currentRequest: queries.vec }, allowRetrievalFallback: true, maxResults: 5 });
  assert.deepEqual((await search()).results.map(hit => hit.path).sort(), [fleetCommonsHit(entry, 0.9).path, local.path].sort(),
    "both are returned while the Fleet entry is live");

  let release!: () => void;
  gate = new Promise<void>(resolve => { release = resolve; });
  judging = deferred<void>();
  const pending = search();
  await judging.promise;
  await retire();
  release();
  const result = await pending;
  assert.equal(result.rankingMode, "decision");
  assert.deepEqual(result.results.map(hit => hit.path), [local.path], "the retired Fleet hit is dropped; local evidence stays");
});

test("a Fleet hit retired while a sibling whisperer is still finishing is dropped from the combined prompt", async t => {
  const { feedPath, raw, retire } = await retirableFleet(t);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { memory_0: { type: "noul", noul: 0.95 } } }));
  const config = resolveConfig({
    fleetCommons: { enabled: true, feedPath }, decisionModel: { apiKey: "dummy-test-key" },
    memoryWhisperer: { enabled: true, mode: "legacy", corpora: ["fleet"], timeoutMs: 5000 },
  });
  let hook: ((event: unknown, ctx: unknown) => Promise<{ appendContext: string } | undefined>) | undefined;
  const api = { config: {}, logger: { warn() {}, info() {} },
    on(name: string, handler: typeof hook) { if (name === "before_prompt_build") hook = handler; } } as unknown as OpenClawPluginApi;
  const whisper = registerMemoryWhisperer(api, { async getMemorySearchManager() { return { manager: raw }; } },
    config.memoryWhisperer, config.decisionModel);
  assert.ok(whisper);
  let memoryDone = deferred<void>();
  let siblingGate: Promise<void> = Promise.resolve();
  const memory: WhispererPrompt = async (...args) => {
    const result = await whisper(...args);
    memoryDone.resolve();
    return result;
  };
  const skill: WhispererPrompt = async () => { await siblingGate; return { appendContext: "<skills>sibling skill</skills>" }; };
  registerWhispererPrompt(api, { memory, skill }, config.whispererTriggers);
  assert.ok(hook);
  const ask = (runId: string) => hook!({ prompt: "How should deploy retries back off?", messages: [] },
    { trigger: "user", agentId: "main", sessionKey: `agent:main:${runId}`, runId });

  const live = (await ask("live"))?.appendContext ?? "";
  assert.match(live, /task-run\/1/u, "delivered while live");
  assert.match(live, /sibling skill/u);

  let release!: () => void;
  siblingGate = new Promise<void>(resolve => { release = resolve; });
  memoryDone = deferred<void>();
  const pending = ask("slow-sibling");
  await memoryDone.promise; // the memory whisperer has already rendered the Fleet hit
  await retire();
  release();
  const combined = (await pending)?.appendContext ?? "";
  assert.doesNotMatch(combined, /task-run\/1/u, "the retired Fleet hit never reaches the delivered prompt");
  assert.match(combined, /sibling skill/u, "the sibling's contribution is still delivered");
});

test("deep_thought's direct cache hit honors the running allowExpired, not the last sync's persisted flag", async t => {
  t.after(() => cancelAllDeepThoughtJobs());
  const { dbPath, sync, now, expiresAt } = await derivedFleetFixture(t);
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  await sync([{ ...entry, expiresAt }], false); // persisted allow_expired = 0
  clock = expiresAt + 1;
  const store = new DeepThoughtStore(dbPath);
  t.after(() => store.close());
  const ask = async (fleetCommonsAllowExpired: boolean, runId: string) => {
    const ctx = { config: {}, agentId: "main", sessionKey: "agent:main:slack:channel:c1", sessionId: "s1", runId } as unknown as OpenClawPluginToolContext;
    const tool = createDeepThoughtTool(ctx, {
      runtime: { searchableCorpora: () => ["fleet"], fleetCommonsAllowExpired, async getMemorySearchManager() { return { manager: null }; } },
      runner: { async run() { throw new Error("the investigation is not under test"); } },
      store, audienceKey: "aud", getCollectionGenerations: () => ({ [FLEET_COMMONS_COLLECTION]: 1 }), resolveCredential: async () => undefined,
      config: { enabled: true, maxTurns: 2, maxToolCalls: 2, timeoutMs: 5_000, maxConcurrent: 0 },
      decisionModel: { enabled: true, endpoint: "https://decisions.invalid/v1", model: "test", timeoutMs: 50 },
    })!;
    return (await tool.execute(runId, { question: "How should deploy retries back off?", corpora: ["fleet"] })).details as
      { status: string; cached?: boolean; answer?: string };
  };
  // Running opt-in serves the cached answer even though the last sync persisted allow_expired = 0.
  const served = await ask(true, "opted-in");
  assert.equal(served.cached, true, JSON.stringify(served));
  assert.equal(served.answer, "Wait a minute before retrying.");
  // Flipping allowExpired off takes effect at once, even though the last sync persisted allow_expired = 1.
  await sync([{ ...entry, expiresAt }], true);
  const refused = await ask(false, "opted-out");
  assert.notEqual(refused.cached, true, JSON.stringify(refused));
  assert.equal(refused.status, "unavailable", "the cache missed, so the (unavailable) investigation path ran");
  assert.deepEqual(store.listDerivedObservations({ agentId: "main", status: "stale" }).map(found => found.answer),
    ["Wait a minute before retrying."], "the synthesis citing the expired entry is invalidated");
});
