import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openMemoryDatabase } from "../src/memory-database.js";
import { WorkFenceLostError, WorkStore, isSqliteBusy, startWorkHeartbeat, type WorkClaim } from "../src/work-store.js";

const KIND = "people_shadow";

async function storePath() {
  return join(await mkdtemp(join(tmpdir(), "work-store-")), "unblock-memory.sqlite");
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("work store registers schema v1 with a STRICT, JSON-checked work_items table on a shared or owned connection", async t => {
  const path = await storePath();
  const db = openMemoryDatabase(path);
  t.after(() => db.close());
  const shared = new WorkStore(db);
  assert.equal(shared.db, db, "an open DatabaseSync is used as-is so domain and work writes share one connection");
  assert.equal(db.prepare("SELECT version FROM memory_schema WHERE component='work'").get()?.version, 1);
  const table = db.prepare("SELECT sql FROM sqlite_schema WHERE name='work_items'").get();
  assert.match(String(table?.sql), /\) STRICT$/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='work_items_due'").get());
  assert.throws(() => db.prepare(`INSERT INTO work_items(kind,scope,mode,status,artifact_json,updated_at)
    VALUES('k','s','item','pending','{not json',0)`).run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`INSERT INTO work_items(kind,scope,mode,status,updated_at)
    VALUES('k','s','batch','pending',0)`).run(), /CHECK constraint failed/);

  // A second (owned) connection on the same file reuses the registered schema and sees the same rows.
  shared.enqueue({ kind: KIND, scope: "a", mode: "item" });
  const owned = new WorkStore(path);
  t.after(() => owned.close());
  assert.equal(owned.get(KIND, "a")?.status, "pending");
  assert.equal(owned.list().length, 1);

  db.prepare("UPDATE memory_schema SET version=2 WHERE component='work'").run();
  assert.throws(() => new WorkStore(db), /Unsupported work store schema version/);
});

test("work-store.ts and its local imports stay free of openclaw so plain-Node workers can load it", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
  const seen = new Set<string>();
  const visit = async (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const [, specifier] of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/g)) {
      assert.ok(!specifier!.startsWith("openclaw"), `${file} imports ${specifier}`);
      if (specifier!.startsWith(".")) await visit(resolve(dirname(file), specifier!.replace(/\.js$/, ".ts")));
    }
    assert.ok(!/import\(\s*["']openclaw/.test(source), `${file} dynamically imports openclaw`);
  };
  await visit(join(root, "work-store.ts"));
  assert.ok(seen.has(join(root, "memory-database.ts")));
});

test("acceptance: a paused worker whose lease expired is fenced out after another worker reclaims and commits (exactly one write)", async t => {
  const path = await storePath();
  // Two independent connections, as two gateways or a gateway and a CLI would have.
  const a = new WorkStore(path), b = new WorkStore(path);
  t.after(() => { a.close(); b.close(); });
  b.db.exec("CREATE TABLE IF NOT EXISTS destination (id TEXT PRIMARY KEY, body TEXT NOT NULL, writer TEXT NOT NULL) STRICT");
  a.enqueue({ kind: KIND, scope: "m1:p1:x1", mode: "item", inputRevision: "manifest-1", now: 0 });

  const claimA = a.claim({ kind: KIND, owner: "worker-a", leaseMs: 1000, now: 0 })!;
  assert.equal(claimA.attempt, 1);
  const stagedA = a.stageArtifact(claimA, { stage: "proposal", artifactJson: JSON.stringify({ proposal: "A" }),
    usageJson: JSON.stringify({ inputTokens: 10 }), now: 10 });
  // Worker A pauses (GC, laptop sleep, debugger) well past its lease.
  assert.equal(b.claim({ kind: KIND, owner: "worker-b", leaseMs: 1000, now: 500 }), undefined, "a live lease is never stolen");
  const claimB = b.claim({ kind: KIND, owner: "worker-b", leaseMs: 1000, now: 5000 })!;
  assert.equal(claimB.attempt, 2);
  assert.equal(claimB.stage, "proposal", "the reclaimer resumes from the staged artifact instead of re-running inference");
  assert.deepEqual(JSON.parse(claimB.artifactJson!), { proposal: "A" });
  assert.equal(b.get(KIND, claimB.scope)?.strikes, 0, "an expired lease that had saved progress is not a strike");

  b.commitWithDomain(claimB, { now: 5100 }, db => {
    db.prepare("INSERT INTO destination VALUES(?,?,?)").run(claimB.scope, String(JSON.parse(claimB.artifactJson!).proposal), "B");
  });
  assert.equal(b.get(KIND, claimB.scope)?.status, "completed");

  // Worker A resumes: every fenced write fails, and its domain callback never runs.
  assert.throws(() => a.renew(stagedA, 1000, 5200), WorkFenceLostError);
  assert.throws(() => a.stageArtifact(stagedA, { stage: "proposal", artifactJson: "{}", now: 5200 }), WorkFenceLostError);
  let domainRan = false;
  assert.throws(() => a.commitWithDomain(stagedA, { now: 5200 }, db => {
    domainRan = true;
    db.prepare("INSERT INTO destination VALUES(?,?,?)").run("late", "A", "A");
  }), WorkFenceLostError);
  assert.equal(domainRan, false, "fence is verified before the domain write executes");
  assert.throws(() => a.withFence(stagedA, () => { domainRan = true; }), WorkFenceLostError);
  assert.equal(domainRan, false);
  assert.throws(() => a.fail(stagedA, { error: "late", now: 5200 }), WorkFenceLostError);

  const rows = a.db.prepare("SELECT * FROM destination").all();
  assert.equal(rows.length, 1, "destination has exactly one write");
  assert.equal(rows[0]?.writer, "B");
  const row = a.get(KIND, claimB.scope)!;
  assert.equal(row.status, "completed"); assert.equal(row.attempt, 2); assert.equal(row.owner, null);
  assert.equal(row.stage, null, "commit clears the artifact unless keepArtifact is requested");
  assert.equal(row.usageJson, JSON.stringify({ inputTokens: 10 }), "usage accumulated before commit is retained");
});

test("a domain failure inside commitWithDomain rolls back both the domain write and the work transition", async t => {
  const store = new WorkStore(await storePath());
  t.after(() => store.close());
  store.db.exec("CREATE TABLE destination (id TEXT PRIMARY KEY) STRICT");
  store.enqueue({ kind: KIND, scope: "s", mode: "item", now: 0 });
  const claim = store.claim({ kind: KIND, owner: "w", leaseMs: 1000, now: 0 })!;
  assert.throws(() => store.commitWithDomain(claim, { now: 1 }, db => {
    db.prepare("INSERT INTO destination VALUES('s')").run();
    throw new Error("revision check failed");
  }), /revision check failed/);
  assert.equal(store.db.prepare("SELECT count(*) n FROM destination").get()?.n, 0);
  assert.equal(store.get(KIND, "s")?.status, "running", "the live attempt keeps its claim and may fail() cleanly");
  assert.equal(store.fail(claim, { error: "revision check failed", addStrike: true, now: 2 }), "pending");
});

test("clock jumps never abort a healthy attempt: renew, stage and commit are fenced on attempt only", async t => {
  const store = new WorkStore(await storePath());
  t.after(() => store.close());
  store.db.exec("CREATE TABLE destination (id TEXT PRIMARY KEY) STRICT");
  store.enqueue({ kind: KIND, scope: "s", mode: "item", now: 0 });
  const claim = store.claim({ kind: KIND, owner: "w", leaseMs: 1000, now: 0 })!;
  const jumped = 10 * 365 * 86_400_000; // NTP correction, VM resume, or manual clock change.
  store.renew(claim, 1000, jumped);
  assert.equal(store.get(KIND, "s")?.leaseUntil, jumped + 1000);
  const staged = store.stageArtifact(claim, { stage: "proposal", artifactJson: "{\"ok\":true}", now: jumped * 2 });
  // Even with the wall clock far past lease_until, the owner still commits (no reclaimer bumped the attempt).
  store.commitWithDomain(staged, { now: jumped * 3, keepArtifact: true }, db => db.prepare("INSERT INTO destination VALUES('s')").run());
  const row = store.get(KIND, "s")!;
  assert.equal(row.status, "completed"); assert.equal(row.stage, "proposal"); assert.equal(row.artifactJson, "{\"ok\":true}");
  assert.equal(store.db.prepare("SELECT count(*) n FROM destination").get()?.n, 1);
  // A backwards jump is equally harmless.
  store.enqueue({ kind: KIND, scope: "t", mode: "item", now: 0 });
  const back = store.claim({ kind: KIND, scope: "t", owner: "w", leaseMs: 1000, now: jumped })!;
  store.renew(back, 1000, 0);
  store.commitWithDomain(back, { now: 0 }, () => undefined);
  assert.equal(store.get(KIND, "t")?.status, "completed");
});

test("strikes: graceful stops add none, expired no-progress leases quarantine items, run singletons never quarantine", async t => {
  const store = new WorkStore(await storePath());
  t.after(() => store.close());
  // Three graceful gateway stops.
  store.enqueue({ kind: KIND, scope: "graceful", mode: "item", now: 0 });
  for (let i = 0; i < 3; i++) {
    const claim = store.claim({ kind: KIND, scope: "graceful", owner: `gateway-${i}`, leaseMs: 1000, now: i * 10 })!;
    assert.ok(claim, `graceful stop ${i} leaves the item claimable`);
    assert.equal(store.interruptOwner(`gateway-${i}`, i * 10 + 1), 1);
    assert.throws(() => store.renew(claim, 1000, i * 10 + 2), WorkFenceLostError, "interrupt fences out the stopped attempt");
  }
  let row = store.get(KIND, "graceful")!;
  assert.equal(row.strikes, 0); assert.equal(row.status, "pending"); assert.equal(row.owner, null); assert.equal(row.leaseUntil, 0);
  assert.equal(row.attempt, 3);

  // Three expired leases with no progress (crash, OOM, kill -9).
  store.enqueue({ kind: KIND, scope: "poison", mode: "item", now: 0 });
  let now = 100;
  for (let i = 0; i < 3; i++) {
    assert.ok(store.claim({ kind: KIND, scope: "poison", owner: `crashy-${i}`, leaseMs: 10, now }), `crash ${i} claims`);
    now += 50;
  }
  assert.equal(store.claim({ kind: KIND, scope: "poison", owner: "next", leaseMs: 10, now }), undefined, "the third strike quarantines");
  row = store.get(KIND, "poison")!;
  assert.equal(row.status, "quarantined"); assert.equal(row.strikes, 3); assert.equal(row.lastError, "lease expired");
  assert.equal(store.claim({ kind: KIND, owner: "other", leaseMs: 10, now: now + 1000, ignoreDueAt: true })?.scope, "graceful",
    "quarantined rows are skipped while other work stays claimable");
  // Operator re-drive.
  assert.equal(store.requeue(KIND, "poison", now, now), true);
  row = store.get(KIND, "poison")!;
  assert.equal(row.status, "pending"); assert.equal(row.strikes, 0);

  // A run singleton is never quarantined, whatever its strike count.
  store.enqueue({ kind: "inside_out_grade", scope: "agent", mode: "run", now: 0 });
  now = 10_000;
  for (let i = 0; i < 6; i++) {
    assert.ok(store.claim({ kind: "inside_out_grade", owner: `crashy-${i}`, leaseMs: 10, now, maxStrikes: 3 }), `run attempt ${i}`);
    now += 50;
  }
  assert.ok(store.claim({ kind: "inside_out_grade", owner: "survivor", leaseMs: 10, now, maxStrikes: 3 }));
  row = store.get("inside_out_grade", "agent")!;
  assert.equal(row.status, "running"); assert.equal(row.strikes, 6);
  const runClaim = store.claim({ kind: "inside_out_grade", owner: "x", leaseMs: 10, now: now + 100 })!;
  assert.equal(store.fail(runClaim, { error: "bad input", addStrike: true, now: now + 101 }), "pending",
    "deterministic failures on a run singleton strike but never quarantine");
});

test("stage progress resets strikes and the next attempt resumes from the saved artifact", async t => {
  const store = new WorkStore(await storePath());
  t.after(() => store.close());
  store.enqueue({ kind: KIND, scope: "s", mode: "item", now: 0 });
  store.claim({ kind: KIND, owner: "c1", leaseMs: 10, now: 0 });
  store.claim({ kind: KIND, owner: "c2", leaseMs: 10, now: 20 });
  const third = store.claim({ kind: KIND, owner: "c3", leaseMs: 10, now: 40 })!;
  assert.equal(store.get(KIND, "s")?.strikes, 2);
  assert.equal(third.stage, null);
  const staged = store.stageArtifact(third, { stage: "proposal", artifactJson: "{\"answer\":42}", now: 45 });
  assert.equal(store.get(KIND, "s")?.strikes, 0, "saved progress resets strikes");
  assert.equal(store.get(KIND, "s")?.status, "running", "staging keeps the live lease");
  store.renew(staged, 10, 46);
  // This attempt crashes after staging; the reclaim adds no strike and keeps the artifact resumable.
  const resumed = store.claim({ kind: KIND, owner: "c4", leaseMs: 10, now: 100 })!;
  assert.equal(resumed.stage, "proposal");
  assert.equal(resumed.artifactJson, "{\"answer\":42}");
  assert.equal(store.get(KIND, "s")?.strikes, 0);
  // Interrupting a resumed attempt leaves it staged (still resumable) with no strike.
  store.interruptOwner("c4", 101);
  assert.equal(store.get(KIND, "s")?.status, "staged");
  const again = store.claim({ kind: KIND, owner: "c5", leaseMs: 10, now: 102 })!;
  assert.equal(again.artifactJson, "{\"answer\":42}");
  assert.equal(again.attempt, 5);
  assert.throws(() => store.stageArtifact(again, { stage: "proposal", artifactJson: "{bad" }), /valid JSON/);
});

test("fail(): transient failures requeue at retryAt with 0 strikes; deterministic failures quarantine items at maxStrikes", async t => {
  const store = new WorkStore(await storePath());
  t.after(() => store.close());
  store.enqueue({ kind: KIND, scope: "s", mode: "item", now: 0 });
  let claim = store.claim({ kind: KIND, owner: "w", leaseMs: 1000, now: 0 })!;
  assert.equal(store.fail(claim, { error: "bad item", addStrike: true, now: 1 }), "pending");
  claim = store.claim({ kind: KIND, owner: "w", leaseMs: 1000, now: 2 })!;
  assert.equal(store.fail(claim, { error: "429 rate limited", retryAt: 1000, now: 3, usageJson: "{\"requests\":2}" }), "pending");
  let row = store.get(KIND, "s")!;
  assert.equal(row.strikes, 0, "transient failures clear strikes");
  assert.equal(row.dueAt, 1000); assert.equal(row.lastError, "429 rate limited"); assert.equal(row.usageJson, "{\"requests\":2}");
  assert.equal(store.claim({ kind: KIND, owner: "w", leaseMs: 1000, now: 999 }), undefined, "not claimable before retryAt");
  for (let i = 0; i < 2; i++) {
    claim = store.claim({ kind: KIND, owner: "w", leaseMs: 1000, now: 1000 + i })!;
    assert.equal(store.fail(claim, { error: "schema invalid", addStrike: true, maxStrikes: 2, now: 1000 + i }), i ? "quarantined" : "pending");
  }
  row = store.get(KIND, "s")!;
  assert.equal(row.status, "quarantined"); assert.equal(row.strikes, 2);
  assert.equal(store.claim({ kind: KIND, owner: "w", leaseMs: 1000, now: 5000, ignoreDueAt: true }), undefined);
  // A failure after staging keeps the artifact for resume.
  store.enqueue({ kind: KIND, scope: "t", mode: "item", now: 0 });
  claim = store.claim({ kind: KIND, scope: "t", owner: "w", leaseMs: 1000, now: 0 })!;
  store.stageArtifact(claim, { stage: "proposal", artifactJson: "[]", now: 1 });
  assert.equal(store.fail(claim, { error: "publish busy", now: 2 }), "staged");
});

test("enqueue resets only on a new input revision or recipe, superseding in-flight attempts", async t => {
  const store = new WorkStore(await storePath());
  t.after(() => store.close());
  assert.equal(store.enqueue({ kind: KIND, scope: "s", mode: "item", inputRevision: "r1", recipeHash: "h1", now: 0 }), true);
  let claim = store.claim({ kind: KIND, owner: "w", leaseMs: 1000, now: 0 })!;
  store.stageArtifact(claim, { stage: "proposal", artifactJson: "{}", now: 1 });
  store.commitWithDomain(claim, { keepArtifact: true, now: 2 }, () => undefined);
  assert.equal(store.enqueue({ kind: KIND, scope: "s", mode: "item", inputRevision: "r1", recipeHash: "h1", now: 3 }), false,
    "same inputs are a no-op: completed work is not redone");
  assert.equal(store.get(KIND, "s")?.status, "completed");

  assert.equal(store.enqueue({ kind: KIND, scope: "s", mode: "item", inputRevision: "r2", recipeHash: "h1", dueAt: 50, now: 4 }), true);
  let row = store.get(KIND, "s")!;
  assert.equal(row.status, "pending"); assert.equal(row.stage, null); assert.equal(row.artifactJson, null);
  assert.equal(row.strikes, 0); assert.equal(row.dueAt, 50); assert.equal(row.inputRevision, "r2");

  claim = store.claim({ kind: KIND, owner: "old", leaseMs: 1000, now: 60 })!;
  assert.equal(store.enqueue({ kind: KIND, scope: "s", mode: "item", inputRevision: "r2", recipeHash: "h2", now: 61 }), true);
  assert.throws(() => store.renew(claim, 1000, 62), WorkFenceLostError, "a recipe change supersedes the running attempt");
  assert.throws(() => store.commitWithDomain(claim, { now: 62 }, () => undefined), WorkFenceLostError);
  row = store.get(KIND, "s")!;
  assert.equal(row.status, "pending"); assert.equal(row.owner, null); assert.equal(row.recipeHash, "h2");
  const fresh = store.claim({ kind: KIND, owner: "new", leaseMs: 1000, now: 63 })!;
  assert.equal(fresh.attempt, claim.attempt + 1);
  assert.equal(fresh.recipeHash, "h2");
});

test("claim ordering, scope/mode filters, due times, explicit early claims and re-arming via nextDueAt", async t => {
  const store = new WorkStore(await storePath());
  t.after(() => store.close());
  store.enqueue({ kind: KIND, scope: "late", mode: "item", dueAt: 300, now: 0 });
  store.enqueue({ kind: KIND, scope: "early", mode: "item", dueAt: 100, now: 0 });
  store.enqueue({ kind: KIND, scope: "run", mode: "run", dueAt: 200, now: 0 });
  store.enqueue({ kind: "other", scope: "x", mode: "item", now: 0 });
  assert.equal(store.claim({ kind: KIND, owner: "w", leaseMs: 1000, now: 50 }), undefined, "nothing due yet");
  assert.equal(store.claim({ kind: KIND, owner: "w", leaseMs: 1000, now: 500, mode: "run" })?.scope, "run");
  assert.equal(store.claim({ kind: KIND, owner: "w", leaseMs: 1000, now: 500 })?.scope, "early");
  const early = store.claim({ kind: KIND, scope: "late", owner: "w", leaseMs: 1000, now: 0, ignoreDueAt: true })!;
  assert.equal(early.scope, "late", "an explicit operator run may start before its schedule");
  assert.equal(store.claim({ kind: KIND, scope: "late", owner: "x", leaseMs: 1000, now: 0, ignoreDueAt: true }), undefined,
    "but never overlaps a live lease");
  assert.equal(store.requeue(KIND, "late", 0, 1), false, "re-drive never steals a live lease");
  store.commitWithDomain(early, { nextDueAt: 9000, now: 10 }, () => undefined);
  const row = store.get(KIND, "late")!;
  assert.equal(row.status, "pending"); assert.equal(row.dueAt, 9000); assert.equal(row.owner, null);
  assert.equal(store.claim({ kind: KIND, scope: "late", owner: "w", leaseMs: 1000, now: 8999 }), undefined);
  assert.deepEqual(store.list("other").map(r => r.scope), ["x"]);
  assert.equal(store.list().length, 4);
  assert.throws(() => store.claim({ kind: KIND, owner: "w", leaseMs: 0 }), /leaseMs/);
  assert.throws(() => store.claim({ kind: KIND, owner: "", leaseMs: 10 }), /owner/);
});

test("interruptOwner only releases the stopping owner's running rows, synchronously", async t => {
  const store = new WorkStore(await storePath());
  t.after(() => store.close());
  for (const scope of ["a", "b", "c"]) store.enqueue({ kind: KIND, scope, mode: "item", now: 0 });
  const a = store.claim({ kind: KIND, scope: "a", owner: "gw-1", leaseMs: 1000, now: 0 })!;
  store.stageArtifact(a, { stage: "proposal", artifactJson: "{}", now: 1 });
  store.claim({ kind: KIND, scope: "b", owner: "gw-1", leaseMs: 1000, now: 0 });
  store.claim({ kind: KIND, scope: "c", owner: "gw-2", leaseMs: 1000, now: 0 });
  assert.equal(store.interruptOwner("gw-1", 5), 2);
  assert.deepEqual(store.list(KIND).map(r => [r.scope, r.status, r.strikes, r.owner]),
    [["a", "staged", 0, null], ["b", "pending", 0, null], ["c", "running", 0, "gw-2"]]);
  assert.equal(store.interruptOwner("gw-1", 6), 0, "idempotent");
});

test("heartbeat renews, skips SQLITE_BUSY beats without losing the fence, and reports fence loss exactly once", async t => {
  const path = await storePath();
  const store = new WorkStore(path);
  t.after(() => store.close());
  store.enqueue({ kind: KIND, scope: "s", mode: "item" });
  const claim: WorkClaim = store.claim({ kind: KIND, owner: "w", leaseMs: 60_000 })!;
  const before = store.get(KIND, "s")!.leaseUntil;
  const lost: WorkFenceLostError[] = [], errors: unknown[] = [];
  const heartbeat = startWorkHeartbeat(store, claim, { intervalMs: 15, leaseMs: 120_000,
    onFenceLost: error => lost.push(error), onError: error => errors.push(error) });
  t.after(() => heartbeat.stop());
  await waitFor(() => store.get(KIND, "s")!.leaseUntil > before);

  // Another process holds the write lock: beats are skipped, not treated as fence loss.
  const blocker = new DatabaseSync(path);
  t.after(() => { if (blocker.isOpen) blocker.close(); });
  blocker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  let busy: unknown;
  try { store.renew(claim, 1000, undefined, { busyTimeoutMs: 1 }); } catch (error) { busy = error; }
  assert.ok(isSqliteBusy(busy), "renew under contention surfaces SQLITE_BUSY rather than a fence error");
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(lost, []); assert.deepEqual(errors, []);
  blocker.exec("ROLLBACK"); blocker.close();
  assert.equal(Number(store.db.prepare("PRAGMA busy_timeout").get()?.timeout) > 100, true,
    "the heartbeat's short busy timeout is restored after each beat");
  const renewed = store.get(KIND, "s")!.leaseUntil;
  await waitFor(() => store.get(KIND, "s")!.leaseUntil > renewed);

  store.interruptOwner("w");
  await waitFor(() => lost.length > 0);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(lost.length, 1, "fence loss is reported once and the heartbeat stops");
  assert.ok((lost as unknown[])[0] instanceof WorkFenceLostError, "deepEqual narrowed the array type above");
  assert.deepEqual(errors, []);
});
