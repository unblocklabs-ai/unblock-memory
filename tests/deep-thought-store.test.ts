import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalCorpora,
  deepThoughtQuestionHash,
  DeepThoughtStore,
  normalizeDeepThoughtQuestion,
  type SaveDerivedObservationInput,
} from "../src/deep-thought-store.js";

function tempDb(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "deep-thought-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "memory.sqlite");
}

const JOB = {
  jobId: "dt_job1", agentId: "main", ownerKey: JSON.stringify(["main", "agent:main:slack:direct:u1", "slack", "acct-a"]),
  question: "When did the launch move?", corpora: ["sessions", "memory"], status: "running", toolCallsUsed: 0, startedAt: 1_000,
};

const OBS: SaveDerivedObservationInput = {
  agentId: "main", question: "When did the launch move?", audienceKey: "aud-a", corpora: ["memory", "sessions"],
  collectionGenerations: { "memory-main": 4, "sessions-main": 9 }, answer: "Friday.", confidence: "high",
  citations: [{ source: "qmd://memory/launch.md", quote: "the launch moved to Friday" }], openQuestions: ["Retro?"],
  sourceJobId: "dt_job1", nowMs: 10_000,
};
const CURRENT = { "memory-main": 4, "sessions-main": 9 };
const key = { agentId: "main", question: OBS.question, audienceKey: "aud-a", corpora: ["memory", "sessions"] };

test("schema: registers component deep_thought v1 with STRICT tables; wraps an existing DatabaseSync without closing it", t => {
  const path = tempDb(t);
  const store = new DeepThoughtStore(path);
  const version = store.db.prepare("SELECT version FROM memory_schema WHERE component='deep_thought'").get()?.version;
  assert.equal(version, 1);
  for (const table of ["deep_thought_jobs", "derived_observations"]) {
    const sql = String(store.db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(table)?.sql);
    assert.match(sql, /\)\s*STRICT$/u, `${table} is STRICT`);
  }
  assert.throws(() => store.db.prepare(`INSERT INTO derived_observations (id,agent_id,question,question_hash,audience_key,corpora_json,
    collection_generations_json,answer,confidence,citations_json,open_questions_json,status,created_at)
    VALUES ('x','main','q','h','a','not json','{}','a','high','[]','[]','fresh',1)`).run(), /CHECK constraint/u);
  assert.throws(() => store.saveDerivedObservation({ ...OBS, collectionGenerations: {} }), /at least one collection generation/u);
  assert.throws(() => store.saveDerivedObservation({ ...OBS, collectionGenerations: { a: -1 } }), /non-negative integer/u);
  store.close();

  const shared = new DatabaseSync(path);
  const wrapped = new DeepThoughtStore(shared);
  wrapped.close();
  assert.equal(shared.prepare("SELECT count(*) AS n FROM deep_thought_jobs").get()?.n, 0, "wrapped connection stays open");
  shared.close();
});

test("question fingerprint is case/whitespace/edge-punctuation insensitive; focus and corpora order are canonical", () => {
  assert.equal(normalizeDeepThoughtQuestion("  When did   the LAUNCH move?!  "), "when did the launch move");
  assert.equal(deepThoughtQuestionHash("When did the launch move?"), deepThoughtQuestionHash("¿when did the launch   MOVE"));
  assert.notEqual(deepThoughtQuestionHash("When did the launch move?"), deepThoughtQuestionHash("When did the launch move?", "dates"));
  assert.equal(deepThoughtQuestionHash("q", "  "), deepThoughtQuestionHash("q"), "blank focus is no focus");
  assert.deepEqual(canonicalCorpora([" sessions", "memory", "sessions"]), ["memory", "sessions"]);
});

test("jobs persist across a simulated restart; identity columns are owner-fenced; interrupted running jobs recover as cancelled", t => {
  const path = tempDb(t);
  const first = new DeepThoughtStore(path);
  first.upsertJob({ ...JOB, nowMs: 1_000 });
  first.upsertJob({ ...JOB, status: "running", toolCallsUsed: 2, lastTool: "read_memory", nowMs: 1_500 });
  first.upsertJob({ ...JOB, jobId: "dt_job2", nowMs: 1_000 });
  first.upsertJob({ ...JOB, jobId: "dt_live", nowMs: 1_000 });
  first.upsertJob({ ...JOB, jobId: "dt_other_agent", agentId: "ops", nowMs: 1_000 });
  first.upsertJob({ ...JOB, jobId: "dt_done", status: "complete", toolCallsUsed: 3,
    outcome: { status: "complete", answer: "Friday.", citations: [] }, completedAt: 2_000, expiresAt: 99_000, nowMs: 2_000 });
  assert.throws(() => first.upsertJob({ ...JOB, ownerKey: "intruder", status: "complete" }), /belongs to another caller/u);
  assert.throws(() => first.upsertJob({ ...JOB, jobId: "dt_nul", ownerKey: "a\0b" }), /NUL/u, "keys that cannot round-trip are refused");
  first.close();

  // Restart: a brand-new connection sees exactly what was committed.
  const second = new DeepThoughtStore(path);
  const restored = second.getJob("dt_job1")!;
  assert.equal(restored.ownerKey, JOB.ownerKey, "owner never rewritten by a mismatched upsert");
  assert.equal(restored.status, "running");
  assert.equal(restored.toolCallsUsed, 2);
  assert.equal(restored.lastTool, "read_memory");
  assert.deepEqual(restored.corpora, ["memory", "sessions"]);
  assert.equal(restored.expiresAt, undefined, "running jobs never expire");
  assert.deepEqual(second.getJob("dt_done")!.outcome, { status: "complete", answer: "Friday.", citations: [] });

  assert.equal(second.markInterruptedJobs("main", 5_000, { keepJobIds: ["dt_live"], retentionMs: 60_000 }), 2);
  const interrupted = second.getJob("dt_job1")!;
  assert.equal(interrupted.status, "cancelled");
  assert.equal(interrupted.completedAt, 5_000);
  assert.equal(interrupted.expiresAt, 65_000);
  assert.equal(interrupted.outcome?.status, "cancelled");
  assert.equal(interrupted.outcome?.jobId, "dt_job1");
  assert.equal(interrupted.outcome?.toolCallsUsed, 2);
  assert.match(String(interrupted.outcome?.note), /interrupted when the Gateway restarted/u);
  assert.equal(second.getJob("dt_live")!.status, "running", "a job still live in this process is kept");
  assert.equal(second.getJob("dt_other_agent")!.status, "running", "other agents are recovered separately");
  assert.equal(second.getJob("dt_done")!.status, "complete", "finished jobs untouched");
  assert.equal(second.markInterruptedJobs("main", 6_000, { keepJobIds: ["dt_live"] }), 0, "idempotent");
  second.close();
});

test("retention: expired jobs are pruned; expires_at NULL (retention 0 = unlimited) is kept forever", t => {
  const store = new DeepThoughtStore(tempDb(t));
  store.upsertJob({ ...JOB, jobId: "dt_short", status: "complete", outcome: { status: "complete" }, completedAt: 1, expiresAt: 5_000 });
  store.upsertJob({ ...JOB, jobId: "dt_forever", status: "complete", outcome: { status: "complete" }, completedAt: 1 });
  store.upsertJob({ ...JOB, jobId: "dt_running" });
  store.markInterruptedJobs("main", 100, { retentionMs: 0 });
  assert.equal(store.getJob("dt_running")!.expiresAt, undefined, "retentionMs 0 keeps interrupted records with no expiry");
  assert.equal(store.pruneExpiredJobs(4_999), 0);
  assert.equal(store.pruneExpiredJobs(Number.MAX_SAFE_INTEGER), 1);
  assert.equal(store.getJob("dt_short"), undefined);
  assert.ok(store.getJob("dt_forever"));
  assert.ok(store.getJob("dt_running"));
  assert.equal(store.deleteJob("dt_forever"), true);
  assert.equal(store.getJob("dt_forever"), undefined);
  store.close();
});

test("derived observations: exact hit counts; any generation advance, missing or new collection marks the row stale", t => {
  const store = new DeepThoughtStore(tempDb(t));
  const saved = store.saveDerivedObservation(OBS);
  assert.equal(saved.status, "fresh");
  assert.deepEqual(saved.corpora, ["memory", "sessions"]);
  assert.deepEqual(saved.collectionGenerations, CURRENT);

  const hit = store.findFreshDerivedObservation({ ...key, question: "  when did the LAUNCH move ", corpora: ["sessions", "memory"],
    currentGenerations: { "sessions-main": 9, "memory-main": 4 }, nowMs: 11_000 })!;
  assert.equal(hit.id, saved.id);
  assert.equal(hit.hitCount, 1);
  assert.equal(hit.lastHitAt, 11_000);
  assert.equal(hit.answer, "Friday.");
  assert.deepEqual(hit.citations, OBS.citations);
  assert.deepEqual(hit.openQuestions, ["Retro?"]);
  assert.equal(store.findFreshDerivedObservation({ ...key, currentGenerations: CURRENT })!.hitCount, 2);

  // ACL: different audience, corpora, agent or focus never match (and never invalidate the row).
  for (const miss of [{ audienceKey: "aud-b" }, { corpora: ["memory"] }, { agentId: "ops" }, { focus: "dates" }]) {
    assert.equal(store.findFreshDerivedObservation({ ...key, ...miss, currentGenerations: CURRENT }), undefined, JSON.stringify(miss));
  }
  assert.equal(store.findFreshDerivedObservation({ ...key, currentGenerations: {} }), undefined, "empty snapshot cannot verify");
  assert.equal(store.getDerivedObservation(saved.id)!.status, "fresh", "misses above never staled the row");

  store.findFreshDerivedObservation({ ...key, currentGenerations: { ...CURRENT, "sessions-main": 10 }, nowMs: 12_000 });
  const stale = store.getDerivedObservation(saved.id)!;
  assert.equal(stale.status, "stale");
  assert.equal(stale.invalidatedAt, 12_000);
  assert.equal(stale.hitCount, 2);
  assert.equal(store.findFreshDerivedObservation({ ...key, currentGenerations: CURRENT }), undefined, "stale rows never serve again");

  for (const current of [{ "memory-main": 4 }, { ...CURRENT, "memory-new": 0 }]) {
    const row = store.saveDerivedObservation(OBS);
    assert.equal(store.findFreshDerivedObservation({ ...key, currentGenerations: current }), undefined, JSON.stringify(current));
    assert.equal(store.getDerivedObservation(row.id)!.status, "stale");
  }
  store.close();
});

test("re-saving supersedes the prior fresh row atomically; list supports status/audience filters and limit 0 = unlimited", t => {
  const store = new DeepThoughtStore(tempDb(t));
  const first = store.saveDerivedObservation({ ...OBS, nowMs: 1 });
  const second = store.saveDerivedObservation({ ...OBS, answer: "Friday, confirmed.", nowMs: 2 });
  const otherAudience = store.saveDerivedObservation({ ...OBS, audienceKey: "aud-b", nowMs: 3 });
  assert.equal(store.getDerivedObservation(first.id)!.status, "superseded");
  assert.equal(store.getDerivedObservation(first.id)!.invalidatedAt, 2);
  assert.equal(store.getDerivedObservation(otherAudience.id)!.status, "fresh", "another audience's row is independent");
  assert.equal(store.findFreshDerivedObservation({ ...key, currentGenerations: CURRENT })!.answer, "Friday, confirmed.");
  assert.throws(() => store.db.prepare(`UPDATE derived_observations SET status='fresh' WHERE id=?`).run(first.id), /UNIQUE/u,
    "at most one fresh row per (agent, question, audience, corpora)");

  for (let i = 0; i < 5; i += 1) store.saveDerivedObservation({ ...OBS, question: `Question ${i}`, nowMs: 10 + i });
  assert.equal(store.listDerivedObservations({ agentId: "main", limit: 0 }).length, 8, "limit 0 = unlimited");
  assert.equal(store.listDerivedObservations({ agentId: "main" }).length, 8, "default is unlimited");
  assert.deepEqual(store.listDerivedObservations({ agentId: "main", limit: 2 }).map(o => o.question), ["Question 4", "Question 3"]);
  assert.deepEqual(store.listDerivedObservations({ agentId: "main", status: "superseded" }).map(o => o.id), [first.id]);
  assert.deepEqual(store.listDerivedObservations({ agentId: "main", audienceKey: "aud-b" }).map(o => o.id), [otherAudience.id]);
  assert.equal(store.listDerivedObservations({ agentId: "ops" }).length, 0);
  assert.equal(second.sourceJobId, "dt_job1");
  assert.throws(() => store.listDerivedObservations({ agentId: "main", limit: -1 }), /non-negative/u);
  store.close();
});
