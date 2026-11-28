import assert from "node:assert/strict";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { FLEET_COMMONS_COLLECTION, resolveFleetCommonsConfig, type FleetCommonsEntry } from "../src/fleet-commons.js";
import { QmdMemoryManager, type ManagerStore } from "../src/manager.js";
import { QmdMemoryRuntime } from "../src/runtime.js";
import { resolveSource } from "../src/sources.js";

const NOW = Date.now();
const pitfall: FleetCommonsEntry = {
  id: "task-run", revision: 1, category: "tool_pitfall", severity: "warn", title: "Retry after deployment",
  body: "Retry transient deploy failures with backoff.", tags: ["deployment"], updatedAt: NOW - 60_000,
};
const expiring: FleetCommonsEntry = { ...pitfall, id: "queue-outage", category: "platform_outage", title: "Queue outage",
  body: "Pause queue retries while the platform recovers.", expiresAt: NOW + 60 * 60_000 };

type VectorHit = Awaited<ReturnType<ManagerStore["vsearch"]>>[number];
const hit = (path: string, body: string): VectorHit => ({
  file: `qmd://${FLEET_COMMONS_COLLECTION}/${path}`, displayPath: `${FLEET_COMMONS_COLLECTION}/${path}`, title: path, body,
  score: 0.9, context: null, docid: path, bestChunk: body, chunkPos: 0, chunkLen: body.length,
});

/** A fake QMD store recording projected Fleet Commons writes and the scope each vector search was given. */
function fleetStore(hits: readonly VectorHit[]) {
  const projected: Array<{ collection: string; paths: string[] }> = [];
  /** Active projected documents per collection, as QMD's `listCollections` reports them. */
  const active = new Map<string, number>();
  const searches: Array<{ collections: string[]; allowed?: readonly string[] }> = [];
  const store: ManagerStore = {
    async update() { return { collections: 0, indexed: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0, needsEmbedding: 0 }; },
    async embed() { return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }; },
    async getStatus() { return { totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: true, collections: [] }; },
    async listCollections() {
      return [...active].map(([name, active_count]) => ({ name, pwd: "", glob_pattern: "", doc_count: active_count, active_count,
        last_modified: null, includeByDefault: false, projected: true }));
    },
    async vsearch(_query, options) {
      const collections = typeof options?.collection === "string" ? [options.collection] : [...(options?.collection ?? [])];
      searches.push({ collections, allowed: options?.allowedPaths?.[FLEET_COMMONS_COLLECTION] });
      return hits.filter(candidate => collections.some(collection => candidate.file.startsWith(`qmd://${collection}/`)));
    },
    async get(query) { return { error: "not_found" as const, query, similarFiles: [] }; },
    async close() {},
    async upsertDocument() { return { changed: false, hash: "", docid: "", generation: 0 }; },
    async retractDocument() { return { deactivated: false, generation: 0 }; },
    async syncProjectedCollection(collection, docs) {
      const paths = [...docs].map(doc => doc.path);
      projected.push({ collection, paths });
      active.set(collection, paths.length);
      return { upserted: 1, unchanged: 0, retracted: 0, embedded: 0, generation: 1 };
    },
    async getCollectionGeneration(collection) { return collection === FLEET_COMMONS_COLLECTION ? 7 : 0; },
  };
  return { store, projected, searches, active };
}

test("integration: an enabled fleetCommons is synced, scoped, searched, cited and read as the \"fleet\" corpus", async t => {
  await using dir = await mkdtempDisposable(join(tmpdir(), "fleet-integration-"));
  await writeFile(join(dir.path, "MEMORY.md"), "memory body\n");
  const feedPath = join(dir.path, "feed.json");
  await writeFile(feedPath, JSON.stringify({ entries: [pitfall, expiring, { ...pitfall, id: "leaky", body: "Ask alice@example.com" }] }));
  const fake = fleetStore([hit("task-run/1", pitfall.body), hit("queue-outage/1", expiring.body), hit("retired/3", "Old advice.")]);
  const manager = new QmdMemoryManager({
    dbPath: join(dir.path, "index.sqlite"), curationPath: join(dir.path, "unblock-memory.sqlite"), workspaceDir: dir.path,
    sources: [resolveSource(dir.path, "MEMORY.md", "memory")], storeFactory: async () => fake.store,
    fleetCommons: resolveFleetCommonsConfig({ enabled: true, feedPath }),
  });
  t.after(() => manager.close());
  await manager.start();

  const synced = await manager.syncFleetCommons();
  assert.partialDeepStrictEqual(synced, { status: "synced", count: 2, changed: true, rejected: [{ id: "leaky" }] });
  assert.deepEqual(fake.projected, [{ collection: FLEET_COMMONS_COLLECTION, paths: ["queue-outage/1", "task-run/1"] }]);
  assert.equal(manager.corpusForCollection(FLEET_COMMONS_COLLECTION), "fleet");
  assert.deepEqual(await manager.getCollectionGenerations(["fleet"]), { [FLEET_COMMONS_COLLECTION]: 7 });

  const hits = await manager.search("deploy retries", { corpora: ["fleet"] });
  // Only cached, unexpired entries are in scope; a stale projection row ("retired/3") is never rendered.
  assert.deepEqual(fake.searches.at(-1), { collections: [FLEET_COMMONS_COLLECTION], allowed: ["queue-outage/1", "task-run/1"] });
  assert.deepEqual(hits.map(found => [found.corpus, found.citation, found.path]), [
    ["fleet", "fleet:task-run@r1", `qmd://${FLEET_COMMONS_COLLECTION}/task-run/1`],
    ["fleet", "fleet:queue-outage@r1", `qmd://${FLEET_COMMONS_COLLECTION}/queue-outage/1`],
  ]);
  const all = await manager.search("deploy retries", { corpora: ["all"] });
  assert.ok(fake.searches.at(-1)!.collections.includes(FLEET_COMMONS_COLLECTION), "\"all\" includes the fleet collection");
  assert.ok(all.some(found => found.corpus === "fleet"));

  const read = await manager.readFile({ relPath: hits[0]!.path });
  assert.match(read.text, /^Retry after deployment\n\nRetry transient deploy failures with backoff\.\nUpdated: .+\nSource: fleet:task-run@r1$/u);
  assert.equal((await manager.readFile({ relPath: `qmd://${FLEET_COMMONS_COLLECTION}/retired/3` })).status, "not_found");
  assert.partialDeepStrictEqual(await manager.syncFleetCommons(), { status: "synced", changed: false });
  assert.equal(fake.projected.length, 1, "an unchanged feed never re-projects");
});

test("integration: a disabled fleetCommons exposes no fleet corpus, collection, sync or reads", async t => {
  await using dir = await mkdtempDisposable(join(tmpdir(), "fleet-integration-off-"));
  await writeFile(join(dir.path, "MEMORY.md"), "memory body\n");
  const fake = fleetStore([hit("task-run/1", pitfall.body)]);
  const manager = new QmdMemoryManager({
    dbPath: join(dir.path, "index.sqlite"), curationPath: join(dir.path, "unblock-memory.sqlite"), workspaceDir: dir.path,
    sources: [resolveSource(dir.path, "MEMORY.md", "memory")], storeFactory: async () => fake.store,
    fleetCommons: resolveFleetCommonsConfig(undefined),
  });
  t.after(() => manager.close());
  await manager.start();
  assert.deepEqual(await manager.syncFleetCommons(), { status: "disabled" });
  await assert.rejects(manager.search("deploy", { corpora: ["fleet"] }), /unknown corpus: fleet/u);
  await manager.search("deploy", { corpora: ["all"] });
  assert.ok(fake.searches.every(search => !search.collections.includes(FLEET_COMMONS_COLLECTION)));
  assert.equal(manager.corpusForCollection(FLEET_COMMONS_COLLECTION), undefined);
  assert.equal((await manager.readFile({ relPath: `qmd://${FLEET_COMMONS_COLLECTION}/task-run/1` })).status, "not_found");
  assert.deepEqual(fake.projected, []);
});

test("integration: the runtime adds \"fleet\" to searchable corpora exactly when fleetCommons is enabled", async () => {
  const off = resolveConfig({});
  const on = resolveConfig({ fleetCommons: { enabled: true, endpoint: "https://fleet.example.test/api/v1/commons" } });
  const runtime = (config: typeof off) => new QmdMemoryRuntime(config.corpora, { fleetCommons: config.fleetCommons });
  assert.deepEqual(runtime(off).searchableCorpora(), ["memory"]);
  assert.deepEqual(runtime(on).searchableCorpora(), ["memory", "fleet"]);
  // Disabled: reports without ever building a manager (no agent list or workspace needed).
  assert.deepEqual(await runtime(off).syncFleetCommons({ cfg: {}, agentId: "main" }), { status: "disabled" });
  const scheduled = runtime(off);
  scheduled.startFleetCommonsSchedule(error => { throw error; });
  scheduled.stopFleetCommonsSchedule();
  await scheduled.close();
});
