import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createStore, type QMDStore } from "@unblocklabs/qmd";
import {
  FleetCommonsReader, fleetCitationsActive, fleetCommonsDocument, fleetCommonsHit, fleetCommonsPath, fleetCommonsUri,
  getFleetCommonsEntry, readFleetCommonsEntries,
  resolveFleetCommonsConfig, summarizeFleetCommons, syncFleetCommons, validateFleetCommonsEntry,
  type FleetCommonsEntry,
} from "../src/fleet-commons.js";

const entry: FleetCommonsEntry = {
  id: "task-run", revision: 1, category: "tool_pitfall", severity: "warn",
  title: "Retry after deployment", body: "Retry transient failures with backoff.\nHonor the retry header.",
  tags: ["deployment"], updatedAt: 1_800_000_000_000,
};
const workaround: FleetCommonsEntry = {
  ...entry, id: "poll-after-create", category: "api_workaround", title: "Poll for readiness",
  body: "Poll the /users/{id}/status API route until it returns success.",
};
const outage: FleetCommonsEntry = {
  ...entry, id: "queue-outage", category: "platform_outage", severity: "critical", title: "Queue outage",
  body: "On 2026-11-27, requests returned status 503. Pause retries while the queue recovers.",
};
const endpoint = "https://fleet.example.test/commons";
const fixture = () => mkdtempDisposable(join(tmpdir(), "fleet-commons-test-"));
const projectionResult = { upserted: 0, unchanged: 0, retracted: 0, embedded: 0, generation: 0 };

test("accepts clean operational entries in all supported categories", () => {
  for (const candidate of [entry, workaround, outage, { ...entry, category: "procedure", expiresAt: null }]) {
    assert.deepEqual(validateFleetCommonsEntry(candidate), { ok: true, entry: candidate });
  }
});

test("rejects client identifiers, contact information, credentials, and paths across all text fields", () => {
  const options = { forbiddenTerms: ["example tenant"] };
  for (const [candidate, reason] of [
    [{ body: "xoxb-fake-sample" }, /credential/],
    [{ title: "sk-fakeSample" }, /credential/],
    [{ source: "ghp_fakeSample" }, /credential/],
    [{ body: "AKIAIOSFODNN7EXAMPLE" }, /credential/],
    [{ body: "Authorization: Bearer abc123def456ghi789" }, /credential/],
    [{ body: "export token=ghx9Q2mZ81" }, /credential/],
    [{ body: "password: 'correcthorsebattery'" }, /credential/],
    [{ body: "Call +1-555-123-4567" }, /phone number/],
    [{ body: "Call 555-123-4567" }, /phone number/],
    [{ body: "-----BEGIN OPENSSH PRIVATE KEY-----" }, /credential/],
    [{ tags: ["hello@example.test"] }, /email address/],
    [{ body: "Call +1 (202) 555-0123" }, /phone number/],
    [{ title: "C0AK9PLCPQF" }, /Slack ID/],
    [{ source: "slack://user?team=public&id=U0AAV2LB402" }, /Slack ID/],
    [{ id: "b0aav2lb402" }, /Slack ID/],
    [{ body: "See /Users/fictional/workspace" }, /local filesystem path/],
    [{ body: "See /home/fictional/workspace" }, /local filesystem path/],
    [{ body: "See C:\\Users\\fictional\\workspace" }, /local filesystem path/],
    [{ body: "See %2FUsers%2Ffictional%2Fworkspace" }, /local filesystem path/],
    [{ title: "EXAMPLE TENANT procedure" }, /forbidden term/],
    [{ id: "example_tenant-procedure" }, /forbidden term/],
    [{ body: "Client name: Example" }, /personal identifier/],
  ] as const) {
    const result = validateFleetCommonsEntry({ ...entry, ...candidate }, options);
    assert.equal(result.ok, false, reason.source);
    if (!result.ok) assert.match(result.reasons.join(" "), reason);
  }
});

test("rejects malformed entry schema and path traversal slugs", () => {
  for (const [candidate, reason] of [
    [{ id: "../escape" }, /id/], [{ id: ".." }, /id/], [{ id: "escape\n" }, /id/],
    [{ revision: 0 }, /revision/], [{ revision: 1.5 }, /revision/], [{ category: "client_note" }, /category/],
    [{ severity: "urgent" }, /severity/], [{ title: " " }, /title/], [{ body: "" }, /body/],
    [{ tags: [3] }, /tags/], [{ updatedAt: Infinity }, /updatedAt/], [{ expiresAt: "tomorrow" }, /expiresAt/],
    [{ source: {} }, /source/], [{ privateMetadata: "ignored?" }, /unknown/],
  ] as const) {
    const result = validateFleetCommonsEntry({ ...entry, ...candidate });
    assert.equal(result.ok, false, reason.source);
    if (!result.ok) assert.match(result.reasons.join(" "), reason);
  }
});

test("config defaults off and validates source, policy, and scheduling fields", () => {
  assert.deepEqual(resolveFleetCommonsConfig(undefined), {
    enabled: false, syncIntervalMinutes: 15, timeoutMs: 10_000, maxEntries: 0, maxFeedBytes: 5 * 1024 * 1024, allowExpired: false,
  });
  assert.deepEqual(resolveFleetCommonsConfig({ enabled: true, endpoint, allowExpired: true, maxEntries: 100_000,
    syncIntervalMinutes: 2, timeoutMs: 120_000, maxFeedBytes: 0 }), {
    enabled: true, endpoint, allowExpired: true, maxEntries: 100_000, syncIntervalMinutes: 2, timeoutMs: 120_000, maxFeedBytes: 0,
  });
  // `@` may appear in the path; only the authority is credential-free.
  assert.equal(resolveFleetCommonsConfig({ endpoint: "https://fleet.example.test/@team/commons" }).endpoint,
    "https://fleet.example.test/@team/commons");
  assert.equal(resolveFleetCommonsConfig({ enabled: true, feedPath: join(tmpdir(), "feed.json") }).enabled, true);
  for (const [candidate, reason] of [
    [{ enabled: true }, /requires endpoint or feedPath/], [{ enabled: "true" }, /enabled/],
    [{ endpoint: "file:///feed.json" }, /endpoint/], [{ feedPath: "feed.json" }, /feedPath/],
    [{ maxEntries: -1 }, /maxEntries/], [{ timeoutMs: 0 }, /timeoutMs/],
    [{ maxFeedBytes: -1 }, /maxFeedBytes/], [{ maxFeedBytes: 1.5 }, /maxFeedBytes/],
    [{ endpoint: "https://user@fleet.example.test/commons" }, /endpoint/], [{ endpoint: "https://fleet.example.test/a b" }, /endpoint/],
    [{ syncIntervalMinutes: Infinity }, /syncIntervalMinutes/], [{ allowExpired: "true" }, /allowExpired/],
    [{ unexpected: true }, /Unknown/],
  ] as const) assert.throws(() => resolveFleetCommonsConfig(candidate), reason);
});

test("lookups do not initialize a missing or unrelated memory database", async () => {
  await using dir = await fixture();
  const storePath = join(dir.path, "cache.sqlite");
  function lookups() {
    assert.deepEqual(readFleetCommonsEntries(storePath), []);
    assert.equal(getFleetCommonsEntry(storePath, entry.id), undefined);
    assert.deepEqual(summarizeFleetCommons(storePath), { count: 0 });
  }
  lookups();
  assert.equal(existsSync(storePath), false);
  using db = new DatabaseSync(storePath);
  db.exec("CREATE TABLE unrelated (value TEXT)");
  lookups();
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema").get()?.count, 1);
});

test("HTTP sync uses bearer credentials and ETag, and prunes expired entries on 304", async t => {
  await using dir = await fixture();
  const storePath = join(dir.path, "cache.sqlite"), apiKeyFile = join(dir.path, "token");
  await writeFile(apiKeyFile, "fixture-secret\n");
  const config = resolveFleetCommonsConfig({ enabled: true, endpoint, apiKeyFile });
  const clock = t.mock.method(Date, "now", () => 100);
  const temporary = { ...outage, expiresAt: 200 };
  const fetchImpl = t.mock.fn<typeof fetch>(async (url, init) => {
    assert.equal(url, endpoint);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer fixture-secret");
    if (headers.has("if-none-match")) {
      assert.equal(headers.get("if-none-match"), '"commons-v1"');
      return new Response(null, { status: 304 });
    }
    return Response.json({ entries: [entry, temporary, { ...entry, id: "fixture-secret" }] }, { headers: { ETag: '"commons-v1"' } });
  });
  const store = { syncProjectedCollection: t.mock.fn<QMDStore["syncProjectedCollection"]>(async () => projectionResult) };
  const options = { storePath, store, config, fetchImpl };
  assert.deepEqual(await syncFleetCommons(options), {
    status: "synced", changed: true, count: 2, rejected: [{ id: "#3", reasons: ["id: forbidden term"] }],
  });
  assert.deepEqual(await syncFleetCommons(options), { status: "not_modified", changed: false, count: 2, rejected: [] });
  clock.mock.mockImplementation(() => 200);
  assert.deepEqual(await syncFleetCommons(options), { status: "not_modified", changed: true, count: 1, rejected: [] });
  assert.equal(fetchImpl.mock.callCount(), 3);
  assert.equal(store.syncProjectedCollection.mock.callCount(), 2);
  assert.deepEqual(readFleetCommonsEntries(storePath), [entry]);
  assert.equal(summarizeFleetCommons(storePath).lastSyncAt, 200);
});

test("local feed projects only clean entries into QMD, skips unchanged sets, and retracts stale revisions", async t => {
  await using dir = await fixture();
  const storePath = join(dir.path, "cache.sqlite"), feedPath = join(dir.path, "feed.json");
  const qmd = await createStore({ dbPath: join(dir.path, "index.sqlite"), config: { collections: { "unblock-fleet": { projected: true } } } });
  try {
    // Use the real projected collection without downloading an embedding model.
    const store = { syncProjectedCollection: t.mock.fn<QMDStore["syncProjectedCollection"]>((name, docs, options) =>
      qmd.syncProjectedCollection(name, docs, { ...options, embed: false })) };
    const config = resolveFleetCommonsConfig({ enabled: true, endpoint, feedPath });
    const fetchImpl: typeof fetch = async () => assert.fail("offline feed should not fetch");
    const options = { storePath, store, config, fetchImpl };
    const unsafe = { ...entry, id: "c0ak9plcpqf", body: "Email hello@example.test" };
    await writeFile(feedPath, JSON.stringify([entry, unsafe, workaround, { ...outage, body: unsafe.body }]));
    const first = await syncFleetCommons(options);
    assert.deepEqual(first, { status: "synced", changed: true, count: 2, rejected: [
      { id: "#2", reasons: ["id: Slack ID", "body: email address"] }, { id: "queue-outage", reasons: ["body: email address"] },
    ] });
    assert.equal(store.syncProjectedCollection.mock.calls[0]?.arguments[0], "unblock-fleet");
    assert.deepEqual(store.syncProjectedCollection.mock.calls[0]?.arguments[2], { embed: true, chunkStrategy: "semantic", cleanup: true });
    assert.deepEqual(readFleetCommonsEntries(storePath), [workaround, entry]);
    assert.equal(await qmd.getDocumentBody("qmd://unblock-fleet/task-run/1"), entry.body);
    assert.equal(await qmd.getDocumentBody("qmd://unblock-fleet/c0ak9plcpqf/1"), null);
    const digest = summarizeFleetCommons(storePath).feedDigest;
    assert.match(digest ?? "", /^[a-f0-9]{64}$/);
    await writeFile(feedPath, JSON.stringify({ entries: [workaround, entry] }));
    assert.deepEqual(await syncFleetCommons(options), { status: "synced", changed: false, count: 2, rejected: [] });
    assert.equal(store.syncProjectedCollection.mock.callCount(), 1);
    assert.equal(summarizeFleetCommons(storePath).feedDigest, digest);
    const revised = { ...entry, revision: 2, body: "Use jitter in the retry delay." };
    await writeFile(feedPath, JSON.stringify([revised]));
    assert.deepEqual(await syncFleetCommons(options), { status: "synced", changed: true, count: 1, rejected: [] });
    assert.equal(getFleetCommonsEntry(storePath, "task-run", 1), undefined);
    assert.deepEqual(getFleetCommonsEntry(storePath, "task-run", 2), revised);
    assert.equal(await qmd.getDocumentBody("qmd://unblock-fleet/task-run/1"), null);
    assert.equal(await qmd.getDocumentBody("qmd://unblock-fleet/poll-after-create/1"), null);
    assert.equal(await qmd.getDocumentBody("qmd://unblock-fleet/task-run/2"), revised.body);
  } finally { await qmd.close(); }
});

test("maxEntries limits eligible entries only; zero is unlimited and allowExpired opts out of pruning", async () => {
  await using dir = await fixture();
  const storePath = join(dir.path, "cache.sqlite"), feedPath = join(dir.path, "feed.json");
  const store = { syncProjectedCollection: async () => projectionResult };
  const expired = { ...outage, expiresAt: 0 };
  await writeFile(feedPath, JSON.stringify([expired, entry, { ...workaround, revision: 0 }, workaround]));
  const config = resolveFleetCommonsConfig({ enabled: true, feedPath });
  await syncFleetCommons({ storePath, store, config: { ...config, maxEntries: 1 } });
  // Equal severity and age: the id breaks the tie, never feed order.
  assert.deepEqual(readFleetCommonsEntries(storePath), [workaround]);
  await syncFleetCommons({ storePath, store, config });
  assert.deepEqual(readFleetCommonsEntries(storePath), [workaround, entry]);
  await syncFleetCommons({ storePath, store, config: { ...config, allowExpired: true } });
  assert.deepEqual(readFleetCommonsEntries(storePath), [workaround, expired, entry]);
});

test("a failed QMD projection is retried on a 304 for the same feed", async t => {
  await using dir = await fixture();
  const storePath = join(dir.path, "cache.sqlite");
  const config = resolveFleetCommonsConfig({ enabled: true, endpoint });
  const fetchImpl: typeof fetch = async (_url, init) => new Headers(init?.headers).has("if-none-match") ?
    new Response(null, { status: 304 }) : Response.json([entry], { headers: { ETag: '"commons-v1"' } });
  const store = { syncProjectedCollection: t.mock.fn<QMDStore["syncProjectedCollection"]>(async () => projectionResult) };
  store.syncProjectedCollection.mock.mockImplementationOnce(async () => { throw new Error("Projection unavailable"); });
  const options = { storePath, store, config, fetchImpl };
  await assert.rejects(syncFleetCommons(options), /Projection unavailable/);
  assert.deepEqual(readFleetCommonsEntries(storePath), [entry]);
  assert.deepEqual(summarizeFleetCommons(storePath), { count: 1 });
  assert.deepEqual(await syncFleetCommons(options), { status: "not_modified", changed: true, count: 1, rejected: [] });
  assert.equal(store.syncProjectedCollection.mock.callCount(), 2);
  assert.ok(summarizeFleetCommons(storePath).feedDigest);
});

test("an HTTP deadline cancels a stalled response body without replacing the last good snapshot", async () => {
  await using dir = await fixture();
  const storePath = join(dir.path, "cache.sqlite"), feedPath = join(dir.path, "feed.json");
  const store = { syncProjectedCollection: async () => projectionResult };
  await writeFile(feedPath, JSON.stringify([entry]));
  await syncFleetCommons({ storePath, store, config: resolveFleetCommonsConfig({ enabled: true, feedPath }) });
  const config = resolveFleetCommonsConfig({ enabled: true, endpoint, timeoutMs: 10 });
  // AbortSignal.timeout uses an unref'ed timer. A ref'ed guard keeps this isolated test alive.
  const guard = setTimeout(() => assert.fail("deadline did not fire"), 1_000);
  try {
    await assert.rejects(syncFleetCommons({ storePath, store, config,
      fetchImpl: async () => new Response(new ReadableStream()) }), { name: "TimeoutError" });
    assert.deepEqual(readFleetCommonsEntries(storePath), [entry]);
  } finally { clearTimeout(guard); }
});

test("fleet hit uses revision-qualified citations, native QMD paths, and memory_get document line numbers", () => {
  const record = { ...entry, revision: 4 };
  assert.equal(fleetCommonsPath(record), "task-run/4");
  assert.equal(fleetCommonsUri(record), "qmd://unblock-fleet/task-run/4");
  // The body starts on line 3 of the read document (title, blank line, body).
  assert.deepEqual(fleetCommonsDocument(record).split("\n").slice(2, 4).join("\n"), entry.body);
  assert.deepEqual(fleetCommonsHit(record, 0.9), {
    path: "qmd://unblock-fleet/task-run/4", startLine: 3, endLine: 4, score: 0.9,
    snippet: entry.body, corpus: "fleet", source: "memory", citation: "fleet:task-run@r4",
  });
});

test("hygiene passes operational prose that only looks like identifiers, and still blocks real ones", () => {
  for (const body of [
    "Retry on 500 502 503 with backoff.", "Fixed in release 2026.11.28.1.", "Send Authorization: Bearer <token> on each call.",
    "The access token: must be refreshed hourly.", "Use Bearer authentication for the hub.", "token=${FLEET_TOKEN} from the env.",
    "Upstream returned UNAVAILABLE.", "Sockets fail with CONNECTION_RESET when idle.", "WORKSPACE scoped retries.",
    "Pinned to commit b0a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9.", "Digest DEADBEEF00112233 matched.", "Build c0ffee1234 is bad.",
    "Recorded at 1800000000000 ms.", "On 2026-11-27 the queue stalled.", "Install @types/node first.",
  ]) assert.deepEqual(validateFleetCommonsEntry({ ...entry, body }), { ok: true, entry: { ...entry, body } }, body);
  for (const [body, reason] of [
    ["xoxb-1234-abcd", /credential/], ["sk-proj-abc123", /credential/], ["Call +1-555-123-4567", /phone number/],
    ["Mail ops@example.test", /email address/], ["See /Users/someone/notes", /local filesystem path/],
    ["Ping C0AK9PLCPQF", /Slack ID/], ["Ping U0AAV2LB402", /Slack ID/],
  ] as const) {
    const result = validateFleetCommonsEntry({ ...entry, body });
    assert.equal(result.ok, false, body);
    if (!result.ok) assert.match(result.reasons.join(" "), reason);
  }
});

test("maxFeedBytes rejects an oversized HTTP or file feed while streaming and keeps the last good cache; 0 is unlimited", async t => {
  await using dir = await fixture();
  const storePath = join(dir.path, "cache.sqlite"), feedPath = join(dir.path, "feed.json");
  const store = { syncProjectedCollection: async () => projectionResult };
  await writeFile(feedPath, JSON.stringify([entry]));
  await syncFleetCommons({ storePath, store, config: resolveFleetCommonsConfig({ enabled: true, feedPath }) });
  await writeFile(feedPath, JSON.stringify([entry, workaround]));
  await assert.rejects(syncFleetCommons({ storePath, store, config: resolveFleetCommonsConfig({ enabled: true, feedPath, maxFeedBytes: 64 }) }),
    /maxFeedBytes \(64\)/u);
  assert.deepEqual(readFleetCommonsEntries(storePath), [entry]);

  // An endless body is cut off at the limit instead of being buffered.
  let pulls = 0, cancelled = false;
  const endless = () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1024).fill(0x20)); },
    cancel() { cancelled = true; },
  }));
  const config = resolveFleetCommonsConfig({ enabled: true, endpoint, maxFeedBytes: 4096 });
  await assert.rejects(syncFleetCommons({ storePath, store, config, fetchImpl: async () => endless() }), /maxFeedBytes/u);
  assert.ok(pulls <= 6 && cancelled, `stream stopped after ${pulls} chunks`);
  // A declared Content-Length over the limit fails before the body is read.
  const declared = t.mock.fn(async () => new Response("[]", { headers: { "Content-Length": "999999" } }));
  await assert.rejects(syncFleetCommons({ storePath, store, config, fetchImpl: declared }), /maxFeedBytes/u);
  assert.deepEqual(readFleetCommonsEntries(storePath), [entry]);
  const big = { ...workaround, body: "Poll again. ".repeat(1_000) };
  await writeFile(feedPath, JSON.stringify([entry, big]));
  await syncFleetCommons({ storePath, store, config: resolveFleetCommonsConfig({ enabled: true, feedPath, maxFeedBytes: 0 }) });
  assert.deepEqual(readFleetCommonsEntries(storePath), [big, entry]);
});

test("maxEntries keeps the most severe, then newest entries regardless of feed order", async () => {
  await using dir = await fixture();
  const feedPath = join(dir.path, "feed.json");
  const store = { syncProjectedCollection: async () => projectionResult };
  const info = { ...entry, id: "a-info", severity: "info" as const, updatedAt: entry.updatedAt + 10 };
  const older = { ...entry, id: "z-old-warn", updatedAt: entry.updatedAt - 10 };
  const feed = [info, older, entry, outage];
  const kept: string[][] = [];
  for (const [index, order] of [feed, [...feed].reverse()].entries()) {
    const storePath = join(dir.path, `cache-${index}.sqlite`);
    await writeFile(feedPath, JSON.stringify(order));
    await syncFleetCommons({ storePath, store, config: resolveFleetCommonsConfig({ enabled: true, feedPath, maxEntries: 2 }) });
    kept.push(readFleetCommonsEntries(storePath).map(found => found.id));
  }
  assert.deepEqual(kept, [["queue-outage", "task-run"], ["queue-outage", "task-run"]]);
});

test("a missing or emptied unblock-fleet projection is re-projected on 304 and on an unchanged feed", async t => {
  await using dir = await fixture();
  const storePath = join(dir.path, "cache.sqlite"), feedPath = join(dir.path, "feed.json");
  const qmd = await createStore({ dbPath: join(dir.path, "index.sqlite"), config: { collections: { "unblock-fleet": { projected: true } } } });
  try {
    const sync = t.mock.fn<QMDStore["syncProjectedCollection"]>((name, docs, options) =>
      qmd.syncProjectedCollection(name, docs, { ...options, embed: false }));
    const store = { syncProjectedCollection: sync, listCollections: () => qmd.listCollections() };
    await writeFile(feedPath, JSON.stringify([entry, workaround]));
    const options = { storePath, store, config: resolveFleetCommonsConfig({ enabled: true, feedPath }) };
    await syncFleetCommons(options);
    assert.partialDeepStrictEqual(await syncFleetCommons(options), { changed: false });
    assert.equal(sync.mock.callCount(), 1);
    // The index lost the projection (e.g. rebuilt index.sqlite); the cache and feed digest are unchanged.
    await qmd.syncProjectedCollection("unblock-fleet", [], { cleanup: true, embed: false });
    assert.equal(await qmd.getDocumentBody("qmd://unblock-fleet/task-run/1"), null);
    assert.deepEqual(await syncFleetCommons(options), { status: "synced", changed: true, count: 2, rejected: [] });
    assert.equal(await qmd.getDocumentBody("qmd://unblock-fleet/task-run/1"), entry.body);
  } finally { await qmd.close(); }

  // Same on a 304: the cached rows are re-projected without a new feed body.
  const httpPath = join(dir.path, "http.sqlite");
  let active = 0;
  const projected = t.mock.fn<QMDStore["syncProjectedCollection"]>(async (_name, docs) => {
    active = [...docs].length;
    return projectionResult;
  });
  const fake = { syncProjectedCollection: projected,
    listCollections: async () => [{ name: "unblock-fleet", active_count: active }] as Awaited<ReturnType<QMDStore["listCollections"]>> };
  const fetchImpl: typeof fetch = async (_url, init) => new Headers(init?.headers).has("if-none-match") ?
    new Response(null, { status: 304 }) : Response.json([entry], { headers: { ETag: '"v1"' } });
  const http = { storePath: httpPath, store: fake, fetchImpl, config: resolveFleetCommonsConfig({ enabled: true, endpoint }) };
  await syncFleetCommons(http);
  assert.deepEqual(await syncFleetCommons(http), { status: "not_modified", changed: false, count: 1, rejected: [] });
  active = 0;
  assert.deepEqual(await syncFleetCommons(http), { status: "not_modified", changed: true, count: 1, rejected: [] });
  assert.equal(projected.mock.callCount(), 2);
});

test("commit runs only after the feed is fetched and validated", async () => {
  await using dir = await fixture();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl: typeof fetch = async () => { events.push("fetch"); await gate; events.push("fetched"); return Response.json([entry]); };
  const pending = syncFleetCommons({
    storePath: join(dir.path, "cache.sqlite"), fetchImpl, config: resolveFleetCommonsConfig({ enabled: true, endpoint }),
    commit: async apply => { events.push("commit"); return apply({ syncProjectedCollection: async () => projectionResult }); },
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ["fetch"]);
  release();
  assert.partialDeepStrictEqual(await pending, { status: "synced", count: 1 });
  assert.deepEqual(events, ["fetch", "fetched", "commit"]);
});

test("a long entry yields its matched passage bounded to the budget, with lines into the memory_get document", () => {
  const body = ["Intro line.", "x".repeat(1_300), "Retry with jitter after a 503.", "Then poll status.", "Outro."].join("\n");
  const long = { ...entry, body };
  const lines = fleetCommonsDocument(long).split("\n");
  const passage = "Retry with jitter after a 503.\nThen poll status.";
  const hit = fleetCommonsHit(long, 0.8, 1_200, { text: passage, start: body.indexOf(passage) });
  assert.equal(hit.snippet, passage);
  assert.deepEqual([hit.startLine, hit.endLine], [5, 6]);
  assert.equal(lines.slice(hit.startLine - 1, hit.endLine).join("\n"), passage);
  // A stale chunk offset is relocated; a passage over the budget is clipped, never dropped.
  assert.equal(fleetCommonsHit(long, 0.8, 1_200, { text: passage, start: 0 }).startLine, 5);
  const clipped = fleetCommonsHit(long, 0.8, 20, { text: passage, start: body.indexOf(passage) });
  assert.equal(clipped.snippet, passage.slice(0, 20));
  assert.deepEqual([clipped.startLine, clipped.endLine], [5, 5]);
  assert.equal(fleetCommonsHit(long, 0.8, 1_200).snippet, body.slice(0, 1_200));
  assert.equal(fleetCommonsHit(long, 0.8).snippet, body, "no budget returns the whole body");
});

test("FleetCommonsReader re-reads rows only after a commit and checks expiry in memory", async t => {
  await using dir = await fixture();
  const storePath = join(dir.path, "cache.sqlite"), feedPath = join(dir.path, "feed.json");
  const store = { syncProjectedCollection: async () => projectionResult };
  const reader = new FleetCommonsReader(storePath);
  t.after(() => reader.close());
  assert.deepEqual(reader.current(false), []);
  const temporary = { ...outage, expiresAt: Date.now() + 60_000 };
  await writeFile(feedPath, JSON.stringify([entry, temporary]));
  await syncFleetCommons({ storePath, store, config: resolveFleetCommonsConfig({ enabled: true, feedPath }) });
  assert.deepEqual(reader.current(false), [temporary, entry]);
  const prepare = t.mock.method(DatabaseSync.prototype, "prepare");
  for (let read = 0; read < 3; read++) assert.deepEqual(reader.current(false), [temporary, entry]);
  assert.equal(reader.current(false, temporary.expiresAt).length, 1, "expiry is applied without a query");
  assert.equal(reader.current(true, temporary.expiresAt).length, 2);
  assert.equal(prepare.mock.callCount(), 0, "unchanged cache: no reopen and no re-query");
  await writeFile(feedPath, JSON.stringify([workaround]));
  await syncFleetCommons({ storePath, store, config: resolveFleetCommonsConfig({ enabled: true, feedPath }) });
  const beforeRead = prepare.mock.callCount();
  assert.ok(beforeRead > 0, "the spy observes statement preparation");
  assert.deepEqual(reader.current(false), [workaround]);
  assert.ok(prepare.mock.callCount() > beforeRead, "a commit by another connection triggers one re-read");
});

test("fleetCitationsActive invalidates citations of expired or retired entries", async () => {
  await using dir = await fixture();
  const storePath = join(dir.path, "cache.sqlite"), feedPath = join(dir.path, "feed.json");
  const store = { syncProjectedCollection: async () => projectionResult };
  const now = Date.now();
  const temporary = { ...outage, expiresAt: now + 60_000 };
  await writeFile(feedPath, JSON.stringify([entry, temporary]));
  await syncFleetCommons({ storePath, store, config: resolveFleetCommonsConfig({ enabled: true, feedPath }) });
  using db = new DatabaseSync(storePath, { readOnly: true });
  assert.equal(fleetCitationsActive(db, ["qmd://memory/notes.md", "person:ada"], now), true);
  assert.equal(fleetCitationsActive(db, ["fleet:task-run@r1", "qmd://unblock-fleet/queue-outage/1#L3-L3"], now), true);
  assert.equal(fleetCitationsActive(db, ["qmd://unblock-fleet/queue-outage/1"], temporary.expiresAt), false, "expired");
  assert.equal(fleetCitationsActive(db, ["fleet:task-run@r2"], now), false, "superseded revision");
  assert.equal(fleetCitationsActive(db, ["fleet:retired@r1"], now), false, "retired");
  await syncFleetCommons({ storePath, store, config: resolveFleetCommonsConfig({ enabled: true, feedPath, allowExpired: true }) });
  assert.equal(fleetCitationsActive(db, ["fleet:queue-outage@r1"], temporary.expiresAt), true, "allowExpired keeps serving it");
});
