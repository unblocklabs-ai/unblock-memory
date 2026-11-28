import assert from "node:assert/strict";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { DeepThoughtStore, findMatchingDerivedObservationsReadOnly, readDerivedObservationCandidates } from "../src/deep-thought-store.js";
import {
  FLEET_COMMONS_COLLECTION, resolveFleetCommonsConfig, syncFleetCommons, type FleetCommonsEntry, type FleetCommonsSyncResult,
} from "../src/fleet-commons.js";
import { QmdMemoryManager, type ManagerStore } from "../src/manager.js";
import { QmdMemoryRuntime } from "../src/runtime.js";
import { resolveSource } from "../src/sources.js";

const endpoint = "https://fleet.example.test/api/v1/commons";
const entry: FleetCommonsEntry = {
  id: "task-run", revision: 1, category: "tool_pitfall", severity: "warn", title: "Retry after deployment",
  body: "Retry transient deploy failures with backoff.", tags: ["deployment"], updatedAt: Date.now() - 60_000,
};
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
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

test("the gateway abort signal reaches scheduled syncs and stops the schedule", async t => {
  await using dir = await mkdtempDisposable(join(tmpdir(), "fleet-runtime-abort-"));
  const signals: Array<AbortSignal | undefined> = [];
  t.mock.method(QmdMemoryManager.prototype, "start", async () => {});
  t.mock.method(QmdMemoryManager.prototype, "close", async () => {});
  t.mock.method(QmdMemoryManager.prototype, "syncFleetCommons", async (signal?: AbortSignal): Promise<FleetCommonsSyncResult> => {
    signals.push(signal);
    return { status: "not_modified", count: 0, changed: false, rejected: [] };
  });
  const runtime = fleetRuntime(t, dir.path);
  const gateway = new AbortController();
  const errors: unknown[] = [];
  runtime.startFleetCommonsSchedule(error => errors.push(error), { signal: gateway.signal });
  await runtime.getMemorySearchManager({ cfg: { agents: { defaults: { workspace: dir.path } } }, agentId: "main" });
  await waitFor(() => signals.length >= 2, "initial and scheduled sync");
  assert.ok(signals.every(signal => signal && !signal.aborted));
  gateway.abort();
  assert.ok(signals.every(signal => signal?.aborted), "every sync signal follows the gateway signal");
  const seen = signals.length;
  await delay(100);
  assert.equal(signals.length, seen, "no ticks after the gateway aborts");
  assert.deepEqual(errors, []);
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
