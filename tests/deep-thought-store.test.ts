import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  canonicalCorpora,
  deepThoughtAudienceKey,
  deepThoughtQuestionHash,
  DeepThoughtStore,
  derivedObservationGenerationsFresh,
  derivedObservationTokens,
  findMatchingDerivedObservationsReadOnly,
  normalizeDeepThoughtQuestion,
  readDerivedObservationCandidates,
  type SaveDerivedObservationInput,
} from "../src/deep-thought-store.js";
import { cancelAllDeepThoughtJobs, createDeepThoughtTool, type DeepThoughtRuntime } from "../src/deep-thought.js";
import type { CorpusMemorySearchResult, MemoryReadResult } from "../src/contracts.js";
import type { StewardRunRequest, StewardRunResult } from "../src/steward-runner.js";

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

/* ───────────── Derived-observation matching (whisperer path) ───────────── */

const MATCH = { agentId: "main", audienceKey: "aud-a", allowedCorpora: ["memory", "sessions"] };
const ROW_GENERATIONS: Record<string, Record<string, number>> = {
  '["memory","sessions"]': CURRENT,
  '["memory"]': { "memory-main": 4 },
};
const perRow = (corpora: readonly string[]) => ROW_GENERATIONS[JSON.stringify(corpora)];

test("matching: exact normalized question scores 1; token overlap matches paraphrases; ranking is score then newest", t => {
  const store = new DeepThoughtStore(tempDb(t));
  const launch = store.saveDerivedObservation({ ...OBS, nowMs: 1 });
  const pricing = store.saveDerivedObservation({ ...OBS, question: "What pricing did Acme agree to for the renewal?", answer: "$40k.", nowMs: 2 });
  const launchNewer = store.saveDerivedObservation({ ...OBS, question: "Why did the launch move to Friday?", answer: "QA.", nowMs: 3 });

  const exact = store.findMatchingDerivedObservations({ ...MATCH, queryText: "  when did the LAUNCH move?! ", currentGenerations: perRow });
  assert.equal(exact[0]!.observation.id, launch.id);
  assert.equal(exact[0]!.kind, "exact");
  assert.equal(exact[0]!.score, 1);
  assert.equal(exact[1]!.observation.id, launchNewer.id, "a paraphrase still ranks, below the exact hit");
  assert.equal(exact[1]!.kind, "overlap");
  assert.ok(exact[1]!.score < 1);

  const paraphrase = store.findMatchingDerivedObservations({ ...MATCH, queryText: "hey, remind me which renewal pricing Acme agreed on?",
    currentGenerations: perRow });
  assert.deepEqual(paraphrase.map(m => m.observation.id), [pricing.id]);
  assert.equal(paraphrase[0]!.sharedTokens, 3, "acme + pricing + renewal (agreed/agree are not folded)");

  // Ties on score sort newest first.
  const tie = store.findMatchingDerivedObservations({ ...MATCH, queryText: "launch move friday timing", currentGenerations: perRow });
  assert.deepEqual(tie.map(m => m.observation.id), [launchNewer.id, launch.id]);
  assert.equal(store.getDerivedObservation(launch.id)!.hitCount, 0, "whisper matches never count as served hits");
  store.close();
});

test("matching: stop words and single shared tokens never fire; thresholds are configurable; maxResults 0 = unlimited", t => {
  const store = new DeepThoughtStore(tempDb(t));
  store.saveDerivedObservation(OBS);
  for (const queryText of ["When did the?", "what did you do", "Tell me about the launch party", "Move it", "", "   ?!  "]) {
    assert.deepEqual(store.findMatchingDerivedObservations({ ...MATCH, queryText, currentGenerations: perRow }), [], queryText);
  }
  assert.equal(store.findMatchingDerivedObservations({ ...MATCH, queryText: "launch party", minSharedTokens: 1,
    currentGenerations: perRow }).length, 1, "minSharedTokens 1 opts into single-token matches");
  assert.equal(store.findMatchingDerivedObservations({ ...MATCH, queryText: "launch move", minTokenOverlap: 1,
    currentGenerations: perRow }).length, 0, "overlap matches never reach the exact score");

  for (let i = 0; i < 4; i += 1) store.saveDerivedObservation({ ...OBS, question: `Launch move variant ${i}?`, nowMs: 20 + i });
  const all = store.findMatchingDerivedObservations({ ...MATCH, queryText: "launch move variant", minTokenOverlap: 0, maxResults: 0,
    currentGenerations: perRow });
  assert.equal(all.length, 5, "0 = unlimited");
  assert.equal(store.findMatchingDerivedObservations({ ...MATCH, queryText: "launch move variant", maxResults: 2,
    currentGenerations: perRow }).length, 2);
  assert.throws(() => store.findMatchingDerivedObservations({ ...MATCH, queryText: "x", minTokenOverlap: 2, currentGenerations: perRow }), /between 0 and 1/u);
  assert.throws(() => store.findMatchingDerivedObservations({ ...MATCH, queryText: "x", maxResults: -1, currentGenerations: perRow }), /non-negative/u);
  store.close();
});

test("matching ACL: exact agent + audience only; every searched corpus must be allowed", t => {
  const store = new DeepThoughtStore(tempDb(t));
  const mine = store.saveDerivedObservation(OBS);
  store.saveDerivedObservation({ ...OBS, audienceKey: "aud-b", answer: "B's answer" });
  store.saveDerivedObservation({ ...OBS, agentId: "ops", answer: "ops answer" });
  const secret = store.saveDerivedObservation({ ...OBS, corpora: ["memory", "secret"], answer: "secret answer",
    collectionGenerations: { "memory-main": 4, "secret-main": 1 } });
  const queryText = OBS.question;
  const anyGenerations = (corpora: readonly string[]) => corpora.includes("secret") ? { "memory-main": 4, "secret-main": 1 } : perRow(corpora);

  assert.deepEqual(store.findMatchingDerivedObservations({ ...MATCH, queryText, currentGenerations: anyGenerations })
    .map(m => m.observation.id), [mine.id], "other audiences, agents and disallowed corpora never surface");
  assert.deepEqual(store.findMatchingDerivedObservations({ ...MATCH, audienceKey: "aud-b", queryText, currentGenerations: anyGenerations })
    .map(m => m.observation.answer), ["B's answer"]);
  assert.deepEqual(store.findMatchingDerivedObservations({ ...MATCH, allowedCorpora: ["memory", "secret", "sessions"], queryText,
    currentGenerations: anyGenerations }).map(m => m.observation.id).sort(), [mine.id, secret.id].sort());
  assert.deepEqual(store.findMatchingDerivedObservations({ ...MATCH, allowedCorpora: ["memory"], queryText, currentGenerations: anyGenerations }),
    [], "a synthesis over sessions is hidden from a memory-only turn");
  assert.deepEqual(store.findMatchingDerivedObservations({ ...MATCH, allowedCorpora: [], queryText, currentGenerations: anyGenerations }), []);
  store.close();
});

test("matching freshness: empty snapshot returns []; a generation advance skips and stales the row; flat snapshots stay conservative", t => {
  const store = new DeepThoughtStore(tempDb(t));
  const both = store.saveDerivedObservation(OBS);
  const memoryOnly = store.saveDerivedObservation({ ...OBS, corpora: ["memory"], collectionGenerations: { "memory-main": 4 } });
  const queryText = OBS.question;

  assert.deepEqual(store.findMatchingDerivedObservations({ ...MATCH, queryText, currentGenerations: {} }), [], "never serve unverified");
  assert.deepEqual(store.findMatchingDerivedObservations({ ...MATCH, queryText, currentGenerations: () => ({}) }), []);
  assert.deepEqual(store.findMatchingDerivedObservations({ ...MATCH, queryText, currentGenerations: () => { throw new Error("cold"); } }), []);
  assert.equal(store.getDerivedObservation(both.id)!.status, "fresh", "unverifiable lookups never invalidate");

  // Flat snapshot for exactly allowedCorpora: the matching-corpora row verifies; the narrower row is unverifiable, not stale.
  assert.deepEqual(store.findMatchingDerivedObservations({ ...MATCH, queryText, currentGenerations: CURRENT })
    .map(m => m.observation.id), [both.id]);
  assert.equal(store.getDerivedObservation(memoryOnly.id)!.status, "fresh");
  // Per-row snapshots verify both exactly.
  assert.equal(store.findMatchingDerivedObservations({ ...MATCH, queryText, currentGenerations: perRow }).length, 2);

  // Read-only helper: same answer, never writes, even when a generation moved.
  const path = String(store.db.prepare("PRAGMA database_list").get()?.file);
  const bumped = { ...CURRENT, "sessions-main": 10 };
  const bumpedPerRow = (corpora: readonly string[]) => corpora.includes("sessions") ? bumped : { "memory-main": 4 };
  assert.deepEqual(findMatchingDerivedObservationsReadOnly(path, { ...MATCH, queryText, currentGenerations: bumpedPerRow })
    .map(m => m.observation.id), [memoryOnly.id]);
  assert.equal(store.getDerivedObservation(both.id)!.status, "fresh", "read-only never marks stale");

  // Writable: the advanced row is skipped AND marked stale; the untouched memory-only row still serves.
  assert.deepEqual(store.findMatchingDerivedObservations({ ...MATCH, queryText, currentGenerations: bumpedPerRow, nowMs: 50 })
    .map(m => m.observation.id), [memoryOnly.id]);
  assert.equal(store.getDerivedObservation(both.id)!.status, "stale");
  assert.equal(store.getDerivedObservation(both.id)!.invalidatedAt, 50);

  // A flat snapshot that shows a recorded collection moved is definitive even for the narrower row.
  store.findMatchingDerivedObservations({ ...MATCH, queryText, currentGenerations: { ...CURRENT, "memory-main": 5 } });
  assert.equal(store.getDerivedObservation(memoryOnly.id)!.status, "stale");
  // A new collection appearing under the same corpora is also stale.
  const again = store.saveDerivedObservation(OBS);
  store.findMatchingDerivedObservations({ ...MATCH, queryText, currentGenerations: { ...CURRENT, "memory-extra": 0 } });
  assert.equal(store.getDerivedObservation(again.id)!.status, "stale");
  assert.deepEqual(store.findMatchingDerivedObservations({ ...MATCH, queryText, currentGenerations: perRow }), []);
  store.close();
});

test("read-only helpers return [] for a missing database or a database without derived_observations", t => {
  const path = tempDb(t);
  const query = { ...MATCH, queryText: OBS.question };
  assert.deepEqual(readDerivedObservationCandidates(path, query), []);
  assert.deepEqual(findMatchingDerivedObservationsReadOnly(path, { ...query, currentGenerations: CURRENT }), []);
  const bare = new DatabaseSync(path);
  bare.exec("CREATE TABLE unrelated (x INTEGER)");
  bare.close();
  assert.deepEqual(readDerivedObservationCandidates(path, query), []);
  const store = new DeepThoughtStore(path);
  store.saveDerivedObservation(OBS);
  store.close();
  assert.equal(readDerivedObservationCandidates(path, query).length, 1);
  assert.equal(findMatchingDerivedObservationsReadOnly(path, { ...query, currentGenerations: CURRENT }).length, 1);
  assert.equal(derivedObservationGenerationsFresh(CURRENT, undefined), false);
  assert.equal(derivedObservationGenerationsFresh(CURRENT, {}), false);
  assert.equal(derivedObservationGenerationsFresh(CURRENT, { ...CURRENT }), true);
});

test("tokens: stop words, possessives and simple plurals fold; numbers survive", () => {
  assert.deepEqual([...derivedObservationTokens("What's Acme's renewal pricing for the 2 launches?")].sort(),
    ["2", "acme", "launche", "pricing", "renewal"].sort());
  assert.deepEqual([...derivedObservationTokens("Can you tell me what you remember?")], []);
});

test("deepThoughtAudienceKey stays in lockstep with the key deep_thought saves under", async t => {
  t.after(() => cancelAllDeepThoughtJobs());
  const path = tempDb(t);
  const store = new DeepThoughtStore(path);
  t.after(() => store.close());
  const runtime: DeepThoughtRuntime = {
    searchableCorpora: () => ["memory"],
    async getMemorySearchManager() {
      return { manager: {
        async searchCandidates() {
          return [{ path: "qmd://memory/launch.md", startLine: 1, endLine: 2, snippet: "the launch moved to Friday", source: "memory",
            corpus: "memory", score: 0.5 } as CorpusMemorySearchResult];
        },
        async readFile(params): Promise<MemoryReadResult> { return { status: "ok", path: params.relPath, text: "x", from: 1, lines: 1 }; },
      } };
    },
  };
  const runner = {
    async run<T>(request: StewardRunRequest<T>): Promise<StewardRunResult<T>> {
      const search = request.tools.find(tool => tool.name === "search_memory")!;
      await search.execute({ bm25Query: "launch", vectorQuery: "launch" }, request.signal!);
      const data = { answer: "Friday.", confidence: "high", openQuestions: [],
        citations: [{ source: "qmd://memory/launch.md", quote: "the launch moved to Friday" }] } as unknown as T;
      return { ok: true, status: "complete", data, summary: "Friday.", turns: 2, toolCalls: 1, usage: { requests: 2 } };
    },
  };
  const ctx = { config: {}, agentId: "main", sessionKey: "agent:main:slack:channel:c1", sessionId: "s1", messageChannel: "slack",
    agentAccountId: "Acct-A", nativeChannelId: "C1", runId: "r1" } as unknown as OpenClawPluginToolContext;
  const tool = createDeepThoughtTool(ctx, {
    runtime, runner, store, getCollectionGenerations: () => ({ memory: 1 }), resolveCredential: async () => undefined,
    config: { enabled: true, maxTurns: 4, maxToolCalls: 4, timeoutMs: 5_000, maxConcurrent: 1 },
    decisionModel: { enabled: true, endpoint: "https://decisions.invalid/v1", model: "test", timeoutMs: 50 },
  })!;
  const outcome = (await tool.execute("c1", { question: "When did the launch move?" })).details as { status: string; derivedObservationId?: string };
  assert.equal(outcome.status, "complete");
  const saved = store.getDerivedObservation(outcome.derivedObservationId!)!;
  assert.equal(saved.audienceKey, deepThoughtAudienceKey({ agentId: "main", sessionKey: "agent:main:slack:channel:c1",
    provider: "slack", accountId: "Acct-A" }));
  // The hook side never sees nativeChannelId; its chatId is the lowercased session-key id. Neither is part of the key.
  assert.equal(saved.audienceKey, deepThoughtAudienceKey({ agentId: "main", sessionKey: "agent:main:slack:channel:c1",
    provider: "Slack", accountId: "Acct-A", senderId: "U-anyone" }), "provider is case-folded; channel sessions share across senders");
  assert.notEqual(saved.audienceKey, deepThoughtAudienceKey({ agentId: "main", sessionKey: "agent:main:slack:channel:c1",
    provider: "slack", accountId: "acct-a" }), "account ids are hashed verbatim");
});

test("deepThoughtAudienceKey splits non-shared sessions per sender and shared group/channel sessions per conversation", () => {
  const key = (sessionKey: string, senderId?: string) =>
    deepThoughtAudienceKey({ agentId: "main", sessionKey, provider: "slack", accountId: "a", ...(senderId ? { senderId } : {}) });
  // dmScope=main: two DM peers share one session key, so the sender separates them.
  assert.notEqual(key("agent:main:main", "U-alice"), key("agent:main:main", "U-bob"));
  assert.notEqual(key("agent:main:slack:direct:u-alice", "U-alice"), key("agent:main:slack:direct:u-alice"));
  for (const shared of ["agent:main:slack:channel:c1", "agent:main:discord:group:g1", "agent:main:slack:channel:c1:thread:171"]) {
    assert.equal(key(shared, "U-alice"), key(shared, "U-bob"), shared);
  }
  assert.notEqual(key("agent:main:slack:channel:c1"), key("agent:main:slack:channel:c2"));
  assert.notEqual(key("agent:main:slack:channel:c1"), key("agent:main:slack:channel:c1:thread:171"), "threads are their own session");
  assert.equal(key(" agent:main:main ", " U-alice "), key("agent:main:main", "U-alice"), "host values are trimmed on both surfaces");
});

test("deepThoughtAudienceKey fails closed on a multiplexed session without a verified sender", () => {
  const key = (sessionKey: string | undefined, senderId?: string) =>
    deepThoughtAudienceKey({ agentId: "main", ...(sessionKey ? { sessionKey } : {}), provider: "slack", accountId: "a",
      ...(senderId !== undefined ? { senderId } : {}) });
  // dmScope=main multiplexes several DM peers onto `agent:main:main`: hashing "" would pool every unknown caller.
  for (const multiplexed of ["agent:main:main", "agent:main:slack:direct:u-alice", undefined]) {
    assert.equal(key(multiplexed), undefined, String(multiplexed));
    assert.equal(key(multiplexed, "   "), undefined, `${String(multiplexed)} with a blank sender`);
    assert.match(key(multiplexed, "U-alice") ?? "", /^caller:[a-f0-9]{64}$/u);
  }
  assert.match(key("agent:main:slack:channel:c1") ?? "", /^caller:/u, "shared conversations need no sender");
});
