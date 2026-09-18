import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { syncSessionProjections, unchangedSessionSync } from "../src/session-sync.js";
import { QmdMemoryRuntime } from "../src/runtime.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "session-change-check-"));
  const state = join(root, "agents", "main", "unblock-memory");
  await mkdir(state, { recursive: true });
  const params = {
    databasePath: join(root, "openclaw-agent.sqlite"),
    outputDir: join(state, "sessions"), manifestPath: join(state, "sessions-manifest.json"),
    indexPath: join(state, "index.sqlite"), agentId: "main", agentName: "main",
    timezone: "UTC", chatTypes: ["channel", "group"] as const,
  };
  const db = createAgentDatabase(params.databasePath);
  insertSession(db, { sessionId: "conversation", chatType: "channel",
    message: { type: "message", message: { role: "user", content: "Keep this decision." } } });
  insertSession(db, { sessionId: "empty", chatType: "group" });
  db.close();
  let indexCalls = 0;
  const index = async () => {
    await writeFile(params.indexPath, `index-${++indexCalls}`);
    return 1;
  };
  const run = (overrides: Partial<Parameters<typeof syncSessionProjections>[0]> = {}) =>
    syncSessionProjections({ ...params, index, indexReady: async () => true, ...overrides });
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
  return { root, params, run, append, calls: () => indexCalls };
}

test("quiet checks avoid manager initialization, persist empty sessions, and respect force", async () => {
  const f = await fixture();
  const first = await f.run();
  assert.ok(first.manifest.ignoredSessions?.empty);
  const quiet = await unchangedSessionSync(f.params, f.params.indexPath);
  assert.equal(quiet?.skipReason, "no_changes");
  assert.equal(quiet?.lastIndexedAt, first.result.lastIndexedAt);
  assert.equal((await f.run()).result.embedded, 0);
  assert.equal(f.calls(), 1);
  const cfg = { agents: { defaults: { userTimezone: "UTC" }, list: [{ id: "main", agentDir: f.root, workspace: f.root }] } };
  const runtime = new QmdMemoryRuntime([{ name: "sessions", kind: "sessions", chatTypes: ["channel", "group"],
    maxExpandedTokens: 500, syncIntervalMinutes: 60 }], { stateRoot: f.root });
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

test("assistant-only additions index; filtered events only advance the source checkpoint", async () => {
  const f = await fixture();
  const first = await f.run();
  f.append("toolResult", "tool output must not be indexed");
  assert.equal(await unchangedSessionSync(f.params, f.params.indexPath), undefined);
  const filtered = await f.run();
  assert.equal(filtered.result.skipReason, "no_indexable_changes");
  assert.equal(filtered.result.lastIndexedAt, first.result.lastIndexedAt);
  assert.equal(f.calls(), 1);
  assert.equal((await unchangedSessionSync(f.params, f.params.indexPath))?.skipReason, "no_changes");
  f.append("assistant", "The final answer arrived after the human message.");
  const answer = await f.run();
  assert.equal(answer.result.updated, 1);
  assert.equal(f.calls(), 2);
  assert.match(await readFile(join(f.params.outputDir, answer.manifest.sessions.conversation!.documentPath), "utf8"), /final answer/);
});

test("rewrites, removals, config changes and missing projections invalidate skipping", async () => {
  const f = await fixture();
  const first = await f.run();
  assert.equal(await unchangedSessionSync({ ...f.params, timezone: "America/New_York" }, f.params.indexPath), undefined);
  await unlink(join(f.params.outputDir, first.manifest.sessions.conversation!.documentPath));
  assert.equal(await unchangedSessionSync(f.params, f.params.indexPath), undefined);
  assert.equal((await f.run()).result.updated, 1);
  const db = new DatabaseSync(f.params.databasePath);
  db.prepare("UPDATE transcript_rewrite_watermarks SET generation = 'rewritten' WHERE session_id = 'conversation'").run();
  db.prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = 'conversation'")
    .run(JSON.stringify({ type: "message", message: { role: "user", content: "Corrected decision." } }));
  db.close();
  assert.equal(await unchangedSessionSync(f.params, f.params.indexPath), undefined);
  assert.equal((await f.run()).result.updated, 1);
  const removed = new DatabaseSync(f.params.databasePath);
  removed.prepare("DELETE FROM session_windows WHERE session_id = 'conversation'").run();
  removed.close();
  assert.equal(await unchangedSessionSync(f.params, f.params.indexPath), undefined);
  assert.equal((await f.run()).result.removed, 1);
  await unlink(f.params.indexPath);
  assert.equal(await unchangedSessionSync(f.params, f.params.indexPath), undefined);
  assert.equal((await f.run()).result.embedded, 1);
});

test("failed/incomplete indexing cannot certify a skip; arrivals during indexing remain pending", async () => {
  const f = await fixture();
  await f.run();
  f.append("user", "New question");
  const before = await readFile(f.params.manifestPath, "utf8");
  await assert.rejects(f.run({ index: async () => { throw Error("embedding failed"); } }), /embedding failed/);
  assert.equal(await readFile(f.params.manifestPath, "utf8"), before);
  assert.equal(await unchangedSessionSync(f.params, f.params.indexPath), undefined);
  await f.run({ indexReady: async () => false });
  assert.equal(await unchangedSessionSync(f.params, f.params.indexPath), undefined);
  await f.run({ index: async () => { f.append("assistant", "Concurrent answer"); return 1; } });
  assert.equal(await unchangedSessionSync(f.params, f.params.indexPath), undefined);
  await f.run();
  assert.equal((await unchangedSessionSync(f.params, f.params.indexPath))?.skipReason, "no_changes");
  await writeFile(`${f.params.indexPath}-wal`, "external index mutation");
  assert.equal(await unchangedSessionSync(f.params, f.params.indexPath), undefined);
  await f.run({ indexReady: async () => {
    await writeFile(`${f.params.indexPath}-wal`, "mutation during readiness validation");
    return true;
  } });
  assert.equal(await unchangedSessionSync(f.params, f.params.indexPath), undefined);
  await f.run();
  assert.equal((await unchangedSessionSync(f.params, f.params.indexPath))?.skipReason, "no_changes");
});

test("excluded DMs do not trigger work and first eligible conversations do", async () => {
  const f = await fixture();
  await f.run();
  const db = new DatabaseSync(f.params.databasePath);
  insertSession(db, { sessionId: "private", chatType: "direct",
    message: { type: "message", message: { role: "user", content: "Private" } } });
  db.close();
  assert.equal((await unchangedSessionSync(f.params, f.params.indexPath))?.skipReason, "no_changes");
  const next = new DatabaseSync(f.params.databasePath);
  insertSession(next, { sessionId: "new", chatType: "channel",
    message: { type: "message", message: { role: "user", content: "New conversation" } } });
  next.close();
  assert.equal(await unchangedSessionSync(f.params, f.params.indexPath), undefined);
  assert.equal((await f.run()).result.updated, 1);
});
