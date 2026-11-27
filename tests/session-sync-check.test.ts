import assert from "node:assert/strict";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { syncSessionProjections, unchangedSessionSync } from "../src/session-sync.js";
import { MEMORY_DATABASE } from "../src/memory-database.js";
import { QmdMemoryRuntime } from "../src/runtime.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";
import { fakeSessionIndex, sqliteSessionState } from "./helpers/session-index.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "session-change-check-"));
  const state = join(root, "agents", "main", "unblock-memory");
  await mkdir(state, { recursive: true });
  const indexPath = join(state, "index.sqlite");
  const sqlite = sqliteSessionState(join(state, MEMORY_DATABASE), "main", state);
  t.after(sqlite.close);
  const fake = fakeSessionIndex({ path: indexPath });
  const params = {
    databasePath: join(root, "openclaw-agent.sqlite"), state: sqlite.store,
    agentId: "main", agentName: "main", timezone: "UTC", chatTypes: ["channel", "group"] as const,
  };
  const db = createAgentDatabase(params.databasePath);
  insertSession(db, { sessionId: "conversation", chatType: "channel",
    message: { type: "message", message: { role: "user", content: "Keep this decision." } } });
  insertSession(db, { sessionId: "empty", chatType: "group" });
  db.close();
  const run = (overrides: Partial<Parameters<typeof syncSessionProjections>[0]> = {}) =>
    syncSessionProjections({ ...params, index: fake.index, ...overrides });
  const append = (role: string, content: string, chat = "conversation") => {
    const db = new DatabaseSync(params.databasePath);
    try {
      const row = db.prepare("SELECT MAX(seq) AS seq FROM transcript_events WHERE session_id = ?").get(chat);
      const seq = Number(row?.seq ?? 0) + 1;
      db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, 4000)")
        .run(chat, seq, JSON.stringify({ type: "message", message: { role, content } }));
      db.prepare("INSERT INTO session_transcript_active_events VALUES (?, ?, ?, ?)").run(chat, seq - 1, seq, seq - 1);
    } finally { db.close(); }
  };
  return { root, indexPath, params, sqlite, fake, run, append, calls: () => fake.stats.embeds };
}

test("quiet checks avoid manager initialization, persist empty sessions, and respect force", async (t) => {
  const f = await fixture(t);
  const first = await f.run();
  assert.ok(first.manifest.ignoredSessions?.empty);
  const quiet = await unchangedSessionSync(f.params, f.indexPath);
  assert.equal(quiet?.skipReason, "no_changes");
  assert.equal(quiet?.lastIndexedAt, first.result.lastIndexedAt);
  assert.equal((await f.run()).result.embedded, 0);
  assert.equal(f.calls(), 1);
  const cfg = { agents: { defaults: { userTimezone: "UTC" }, entries: { main: { agentDir: f.root, workspace: f.root } } } };
  const runtime = new QmdMemoryRuntime([{ name: "sessions", kind: "sessions", chatTypes: ["channel", "group"],
    maxExpandedTokens: 500, syncIntervalMinutes: 60 }], { stateRoot: f.root });
  t.after(() => runtime.close());
  let managerCalls = 0;
  Object.defineProperty(runtime, "getMemorySearchManager", { value: async () => {
    managerCalls++;
    return { manager: { syncSessions: () => f.run({ force: true }).then(r => r.result) } };
  } });
  const wait = async () => {
    for (let i = 0; i < 200; i++) {
      const status = await runtime.sessionSyncStatus("main");
      if (status.status === "completed" || status.status === "failed") return status;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Error("sync did not finish");
  };
  await runtime.startSessionSync({ cfg, agentId: "main" });
  const status = await wait();
  assert.equal(status.status, "completed");
  if (status.status === "completed") assert.equal(status.skipReason, "no_changes");
  assert.equal(managerCalls, 0);
  await runtime.startSessionSync({ cfg, agentId: "main" }, true);
  assert.equal((await wait()).status, "completed");
  assert.equal(managerCalls, 1);
});

test("assistant-only additions index; filtered events only advance the source checkpoint", async (t) => {
  const f = await fixture(t);
  const first = await f.run();
  f.append("toolResult", "tool output must not be indexed");
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
  const filtered = await f.run();
  assert.equal(filtered.result.skipReason, "no_indexable_changes");
  assert.equal(filtered.result.lastIndexedAt, first.result.lastIndexedAt);
  assert.equal(f.calls(), 1);
  assert.equal((await unchangedSessionSync(f.params, f.indexPath))?.skipReason, "no_changes");
  f.append("assistant", "The final answer arrived after the human message.");
  const answer = await f.run();
  assert.equal(answer.result.updated, 1);
  assert.equal(f.calls(), 2);
  assert.match(f.fake.content(answer.manifest.sessions.conversation!.documentPath)!, /final answer/);
});

test("rewrites, removals, config changes and missing projections invalidate skipping", async (t) => {
  const f = await fixture(t);
  const first = await f.run();
  assert.equal(await unchangedSessionSync({ ...f.params, timezone: "America/New_York" }, f.indexPath), undefined);
  // A projected document vanishing from QMD bumps the collection generation and rewrites the index file.
  f.fake.documents.clear();
  f.fake.externalChange();
  await writeFile(f.indexPath, "external index mutation");
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
  const replacesBefore = f.fake.stats.replaces;
  await f.run();
  assert.equal(f.fake.stats.replaces, replacesBefore + 1, "a generation mismatch reconciles");
  assert.match(f.fake.content(first.manifest.sessions.conversation!.documentPath)!, /Keep this decision/);
  const db = new DatabaseSync(f.params.databasePath);
  db.prepare("UPDATE transcript_rewrite_watermarks SET generation = 'rewritten' WHERE session_id = 'conversation'").run();
  db.prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = 'conversation'")
    .run(JSON.stringify({ type: "message", message: { role: "user", content: "Corrected decision." } }));
  db.close();
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
  assert.equal((await f.run()).result.updated, 1);
  const removed = new DatabaseSync(f.params.databasePath);
  removed.prepare("DELETE FROM session_windows WHERE session_id = 'conversation'").run();
  removed.close();
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
  assert.equal((await f.run()).result.removed, 1);
  await unlink(f.indexPath);
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
  assert.equal((await f.run()).result.embedded, 1);
});

test("failed/incomplete indexing cannot certify a skip; arrivals during indexing remain pending", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.append("user", "New question");
  const before = JSON.stringify(f.sqlite.state.readManifest());
  f.fake.hooks.embed = () => { throw Error("embedding failed"); };
  await assert.rejects(f.run(), /embedding failed/);
  delete f.fake.hooks.embed;
  assert.equal(JSON.stringify(f.sqlite.state.readManifest()), before);
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
  f.fake.hooks.ready = () => false;
  await f.run();
  delete f.fake.hooks.ready;
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
  f.fake.hooks.embed = () => { f.append("assistant", "Concurrent answer"); return 1; };
  await f.run();
  delete f.fake.hooks.embed;
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
  await f.run();
  assert.equal((await unchangedSessionSync(f.params, f.indexPath))?.skipReason, "no_changes");
  await writeFile(`${f.indexPath}-wal`, "external index mutation");
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
  f.fake.hooks.ready = async () => {
    await writeFile(`${f.indexPath}-wal`, "mutation during readiness validation");
    return true;
  };
  await f.run();
  delete f.fake.hooks.ready;
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
  await f.run();
  assert.equal((await unchangedSessionSync(f.params, f.indexPath))?.skipReason, "no_changes");
});

test("excluded DMs do not trigger work and first eligible conversations do", async (t) => {
  const f = await fixture(t);
  await f.run();
  const db = new DatabaseSync(f.params.databasePath);
  insertSession(db, { sessionId: "private", chatType: "direct",
    message: { type: "message", message: { role: "user", content: "Private" } } });
  db.close();
  assert.equal((await unchangedSessionSync(f.params, f.indexPath))?.skipReason, "no_changes");
  const next = new DatabaseSync(f.params.databasePath);
  insertSession(next, { sessionId: "new", chatType: "channel",
    message: { type: "message", message: { role: "user", content: "New conversation" } } });
  next.close();
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
  assert.equal((await f.run()).result.updated, 1);
});

test("a legacy manifest never certifies the quiet check before the projected pipeline reconciles", async (t) => {
  const f = await fixture(t);
  const synced = await f.run();
  const legacy = structuredClone(synced.manifest);
  delete legacy.generation;
  f.sqlite.state.writeManifest(legacy);
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
  await f.run();
  assert.equal((await unchangedSessionSync(f.params, f.indexPath))?.skipReason, "no_changes");
});

test("initial sync with failures records failedSessions, leaves lastSuccessfulSyncAt unset, never certifies skip, and clears once healthy", async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.params.databasePath);
  db.prepare("UPDATE transcript_events SET event_json = '{broken' WHERE session_id = 'conversation'").run();
  db.close();

  const failedFirst = await f.run();
  assert.equal(failedFirst.result.failed, 1);
  assert.equal(failedFirst.result.lastSuccessfulSyncAt, undefined);
  assert.equal(failedFirst.manifest.lastSuccessfulSyncAt, undefined);
  assert.equal(failedFirst.manifest.indexSignature, undefined);
  assert.equal(failedFirst.manifest.sessions.conversation, undefined);
  assert.equal(typeof failedFirst.manifest.failedSessions?.conversation, "string");
  assert.deepEqual(f.sqlite.state.readManifest().failedSessions, failedFirst.manifest.failedSessions);
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);

  const repairedDb = new DatabaseSync(f.params.databasePath);
  repairedDb.prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = 'conversation'")
    .run(JSON.stringify({ type: "message", message: { role: "user", content: "Repaired decision." } }));
  repairedDb.close();

  const repaired = await f.run();
  assert.equal(repaired.result.failed, 0);
  assert.equal(repaired.result.updated, 1);
  assert.equal(repaired.manifest.failedSessions, undefined);
  assert.equal(f.sqlite.state.readManifest().failedSessions, undefined);
  assert.equal((await unchangedSessionSync(f.params, f.indexPath))?.skipReason, "no_changes");

  // Even with a valid indexSignature and lastSuccessfulSyncAt, non-empty failedSessions must invalidate skip.
  const tampered = structuredClone(repaired.manifest);
  tampered.failedSessions = { conversation: "stale-failed-fingerprint" };
  f.sqlite.state.writeManifest(tampered);
  assert.equal(await unchangedSessionSync(f.params, f.indexPath), undefined);
});
