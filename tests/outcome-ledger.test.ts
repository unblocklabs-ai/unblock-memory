import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { openInsideOutStore } from "../src/inside-out-store.js";
import {
  getSubjectOutcomeStats, OUTCOME_LEDGER_KIND, OutcomeLedgerStore, runOutcomeLedgerPass,
  summarizeOutcomeMetrics, type OutcomeLedgerPassOptions,
} from "../src/outcome-ledger.js";
import { PeopleStore } from "../src/people-store.js";
import { writeRecallBatch, type RecallHitRecord, type RecallLedgerEvent } from "../src/recall-ledger.js";
import { ResponseAuditStore } from "../src/response-store.js";
import { WorkStore } from "../src/work-store.js";

const day = 86_400_000;
const base = Date.UTC(2026, 10, 20);
const agentId = "main";
const job = { kind: OUTCOME_LEDGER_KIND, scope: agentId, mode: "run" } as const;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "outcome-ledger-"));
  const dbPath = join(root, "unblock-memory.sqlite");
  const store = new OutcomeLedgerStore(dbPath);
  const workStore = new WorkStore(store.db);
  t.after(() => { store.close(); rmSync(root, { recursive: true }); });
  const run = (at: number, extra?: Partial<OutcomeLedgerPassOptions>) => runOutcomeLedgerPass({
    agentId, owner: "worker", workStore, intervalMinutes: 1, lookbackMs: 5 * day, matchWindowMs: 100,
    leaseMs: 500, heartbeatMs: 100, now: () => at, ...extra,
  });
  return { dbPath, db: store.db, store, workStore, run };
}

function hit(path: string, disposition: RecallHitRecord["disposition"] = "emitted", rank = 1, line = 5): RecallHitRecord {
  return { sourcePath: path, corpus: "memory", rawLeafId: `${path}:${line}`, passageId: `${path}:${line}`,
    startLine: line, endLine: line + 2, observedAtBasis: "unknown", retrievalRank: rank, disposition };
}

function query(runId: string, at: number, hits: RecallHitRecord[], sessionId = "session"): RecallLedgerEvent {
  return { kind: "query", record: { agentId, eventKey: runId, sessionId, runId, createdAtMs: at, source: "whisperer",
    provider: "slack", accountId: "workspace", senderId: "sender", queryFallback: false, corpora: ["memory"],
    rankingMode: "decision", outcome: "emitted", hits } };
}

function route(runId: string, at: number, emitted: string[], hasRunId = true): RecallLedgerEvent {
  return { kind: "skill_routing", record: { agentId, eventKey: runId, sessionId: "session",
    runId: hasRunId ? runId : undefined, createdAtMs: at,
    mode: "direct", candidateCount: emitted.length, emitted, scores: [], outcome: "emitted" } };
}

function open(runId: string, at: number, skillPath: string): RecallLedgerEvent {
  return { kind: "skill_open", record: { agentId, sessionId: "session", runId, createdAtMs: at, skillPath,
    wasWhispered: true, wasPinned: true, toolName: "skills_read" } };
}

function read(runId: string, at: number, sourcePath: string, sessionId = "session", startLine = 5): RecallLedgerEvent {
  return { kind: "read", record: { agentId, eventKey: `${runId}/${startLine}/${at}`, sessionId, runId, readAtMs: at,
    sourcePath, startLine, lineCount: 2, status: "ok" } };
}

function auditPayload(outcome: "success" | "correction") {
  const noul = (value: number) => ({ noul: value });
  return JSON.stringify({
    quality: { underdelivery: noul(0) },
    retrospective: { judgment: {
      correction: noul(outcome === "correction" ? 0.99 : 0), deliveryAdmission: noul(0), regression: noul(0),
      outcome: { choice: outcome === "success" ? "acknowledged_success" : "unknown", confidence: 0.95 },
      scopeClarification: noul(0), reason: { choice: "none_or_unclear", confidence: 0.95 },
    } },
  });
}

test("plain Node loads the ledger without OpenClaw, registers v1 and supports borrowed connections", () => {
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { registerHooks } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "openclaw" || specifier.startsWith("openclaw/") || specifier.startsWith("@openclaw/")) {
        throw new Error("Unexpected host SDK import");
      }
      return nextResolve(specifier, context);
    } });
    const { OutcomeLedgerStore } = await import(${JSON.stringify(new URL("../src/outcome-ledger.ts", import.meta.url).href)});
    const db = new DatabaseSync(":memory:");
    new OutcomeLedgerStore(db).close();
    db.close();
  `]);
  const db = new DatabaseSync(":memory:");
  try {
    new OutcomeLedgerStore(db).close();
    assert.equal(db.prepare("SELECT version FROM memory_schema WHERE component=?").get(OUTCOME_LEDGER_KIND)?.version, 1);
    assert.equal(db.prepare("SELECT strict FROM pragma_table_list WHERE name='memory_outcomes'").get()?.strict, 1);
    assert.throws(() => db.exec(`INSERT INTO memory_outcomes VALUES
      ('invalid','main','memory_hit','doc','default','helped',1.01,'turn',NULL,'{}',0)`), /CHECK constraint/);
    db.exec("UPDATE memory_schema SET version=2");
    assert.throws(() => new OutcomeLedgerStore(db), /Unsupported outcome ledger schema version/);
  } finally { db.close(); }
});

test("joins delivered memory, opened skills and People receipts; deduplicates turns and rolls up recipes", async t => {
  const { dbPath, db, store, run } = fixture(t);
  const memory = "qmd://memory/guide.md", hidden = "qmd://memory/not-delivered.md", unopened = "/skills/unopened/SKILL.md";
  const skill = "/skills/guide/SKILL.md";
  writeRecallBatch(dbPath, [
    query("good", base, [hit(memory), hit(memory, "emitted", 2, 20), hit(hidden, "below_threshold", 3)]),
    route("good", base, [skill, skill, unopened], false),
    read("good", base + 10, memory), open("good", base + 12, skill),
    query("bad", base + 200, [hit(memory), hit(hidden, "below_threshold", 2)]),
    route("bad", base + 200, [skill, unopened]),
    open("bad", base + 210, skill), open("another-run", base + 210, unopened),
    query("unknown", base + 400, [hit(memory, "returned")]),
    read("another-run", base + 405, memory), read("unknown", base + 410, memory, "session", 20),
    // A later run's shortfall must not get pulled backward to the unevaluated run.
    route("later", base + 470, []),
  ]);
  db.exec("ALTER TABLE recall_queries ADD COLUMN recipe_hash TEXT");
  db.exec("UPDATE recall_queries SET recipe_hash='trial-b' WHERE run_id='bad'");
  new ResponseAuditStore(dbPath).close();
  const insertAudit = db.prepare(`INSERT INTO response_results
    (cohort,id,session_id,input_hash,episode_at,active,status,assessed_at,result) VALUES
    ('current',?,'session','hash',?,1,?,?,?)`);
  insertAudit.run("good-answer", base + 50, "ok", base + 100, auditPayload("success"));
  insertAudit.run("bad-answer", base + 250, "ok", base + 300, auditPayload("correction"));
  insertAudit.run("later-answer", base + 495, "ok", base + 500, auditPayload("correction"));
  const people = new PeopleStore(dbPath, { maxOpenTodos: 10, maxBlurbChars: 1000 });
  const personId = people.upsertIdentity({ provider: "slack", accountScope: "workspace", externalId: "sender" }).person.id;
  for (const runId of ["good", "bad", "unlinked"]) {
    people.recordWhisperReceipt({ runId, personId, threadKey: JSON.stringify(["slack:workspace:C1:thread", runId]),
      contribution: "private contribution must not be copied" });
  }
  people.close();
  const setReceiptTime = db.prepare("UPDATE person_whisper_receipts SET injected_at=? WHERE run_id=?");
  for (const [runId, offset] of [["good", 2], ["bad", 202], ["unlinked", 260]] as const) {
    setReceiptTime.run(new Date(base + offset).toISOString(), runId);
  }

  assert.equal((await run(base + 1_000, { responseCohort: "current" })).status, "ok");
  const summary = summarizeOutcomeMetrics(store, { agentId });
  // Below-threshold candidates were never shown to the model, so they are not scored at all.
  assert.equal(summary.totalOutcomes, 10);
  assert.deepEqual(summary.byVerdict, { helped: 3, ignored: 4, hurt: 3 });
  assert.deepEqual(summary.bySubjectKind, { memory_hit: 3, skill: 4, person_whisper: 3 });
  assert.equal(db.prepare("SELECT count(*) n FROM memory_outcomes WHERE subject_id=?").get(hidden)?.n, 0);
  assert.equal(summary.whisperUsedRate, 1 / 3);
  assert.equal(summary.skillOpenRate, 0.5);
  assert.equal(summary.shortfallsPer100Turns, 25);
  assert.deepEqual(summary.byRecipe["trial-b"]?.byVerdict, { helped: 0, ignored: 0, hurt: 1 });
  assert.equal(summary.byRecipe.default?.totalOutcomes, 9);
  assert.equal(summary.byRecipe["trial-b"]?.shortfallsPer100Turns, 100);
  assert.equal(summarizeOutcomeMetrics(db, { agentId, recipeHash: "trial-b", sinceMs: base + 200, untilMs: base + 201 }).totalOutcomes, 1);
  assert.equal(summarizeOutcomeMetrics(db, { agentId, untilMs: base }).shortfallsPer100Turns, null);
  assert.equal(summarizeOutcomeMetrics(db, { agentId: "other" }).totalOutcomes, 0);
  assert.deepEqual(getSubjectOutcomeStats(db, { agentId, subjectKind: "memory_hit", subjectId: memory }),
    { helped: 1, ignored: 1, hurt: 1, netScore: 0 });
  assert.deepEqual(getSubjectOutcomeStats(db, { agentId, subjectKind: "person_whisper", subjectId: personId, sinceMs: base + 200 }),
    { helped: 0, ignored: 1, hurt: 1, netScore: -1 });
  const unknown = db.prepare("SELECT id,verdict,signals_json FROM memory_outcomes WHERE evidence_turn_id='query:unknown'");
  const before = unknown.get();
  assert.equal(before?.verdict, "ignored");
  assert.equal(JSON.parse(String(before?.signals_json)).read, false);
  assert.equal(db.prepare("SELECT count(*) n FROM memory_outcomes WHERE signals_json LIKE '%private contribution%'").get()?.n, 0);

  // Audit is asynchronous. A subsequent sweep updates the existing outcome in place.
  insertAudit.run("late-answer", base + 450, "ok", base + 2_000, auditPayload("success"));
  assert.equal((await run(base + 61_000, { responseCohort: "current" })).status, "ok");
  assert.equal(unknown.get()?.id, before?.id);
  assert.equal(unknown.get()?.verdict, "helped");
  assert.equal(summarizeOutcomeMetrics(db, { agentId }).totalOutcomes, 10);
});

test("undelivered candidates are not scored, purge legacy rows and do not dilute whisperUsedRate", async t => {
  const { dbPath, db, run } = fixture(t);
  const shown = "qmd://memory/shown.md";
  const rejected = ["below_threshold", "rank_limit", "cooldown", "judge_failed", "unjudged_cap",
    "redundant", "payload_limit", "below_threshold", "rank_limit"] as const;
  writeRecallBatch(dbPath, [query("turn", base, [hit(shown),
    ...rejected.map((disposition, index) => hit(`qmd://memory/candidate-${index}.md`, disposition, index + 2))]),
    read("turn", base + 10, shown)]);
  // A row an earlier version scored for an unshown candidate is removed when its window is re-swept.
  new OutcomeLedgerStore(db).close();
  const legacyId = createHash("sha256")
    .update(JSON.stringify([agentId, "memory_hit", "qmd://memory/candidate-0.md", "query:turn", "default"])).digest("hex");
  db.prepare(`INSERT INTO memory_outcomes VALUES (?,?,'memory_hit','qmd://memory/candidate-0.md','default','ignored',0.8,
    'query:turn','session',?,?)`).run(legacyId, agentId, JSON.stringify({ delivered: false, read: false }), base);

  assert.equal((await run(base + 1_000)).status, "ok");
  const rows = db.prepare("SELECT subject_id,verdict FROM memory_outcomes").all();
  assert.deepEqual(rows.map(row => [row.subject_id, row.verdict]), [[shown, "helped"]]);
  const summary = summarizeOutcomeMetrics(db, { agentId });
  assert.equal(summary.whisperUsedRate, 1);
  assert.deepEqual(summary.byVerdict, { helped: 1, ignored: 0, hurt: 0 });
});

test("disabled Response Audit (no cohort) never attaches historical audit rows", async t => {
  const { dbPath, db, run } = fixture(t);
  const memory = "qmd://memory/guide.md";
  writeRecallBatch(dbPath, [query("turn", base, [hit(memory)])]);
  new ResponseAuditStore(dbPath).close();
  db.prepare(`INSERT INTO response_results (cohort,id,session_id,input_hash,episode_at,active,status,assessed_at,result)
    VALUES ('old-cohort','stale','session','hash',?,1,'ok',?,?)`).run(base + 20, base + 30, auditPayload("correction"));

  assert.equal((await run(base + 1_000)).status, "ok");
  const row = db.prepare("SELECT verdict,evidence_turn_id,signals_json FROM memory_outcomes").get();
  assert.equal(row?.verdict, "ignored");
  const signals = JSON.parse(String(row?.signals_json));
  assert.equal(signals.responseOutcome, null);
  assert.equal(signals.responseEpisodeId, null);
  assert.equal(signals.turnId, "run:turn");

  // The same row is attached once its cohort is the configured one.
  assert.equal((await run(base + 61_000, { responseCohort: "old-cohort" })).status, "ok");
  assert.equal(db.prepare("SELECT verdict FROM memory_outcomes").get()?.verdict, "hurt");
});

test("uses earlier grades from the same person and rubric to distinguish blunt feedback from a sharp drop", async t => {
  const { dbPath, db, run } = fixture(t);
  const memory = "qmd://memory/guide.md";
  writeRecallBatch(dbPath, [
    query("blunt", base, [hit(memory)], "blunt"), read("blunt", base + 5, memory, "blunt"),
    query("drop", base, [hit(memory)], "drop"), read("drop", base + 5, memory, "drop"),
  ]);
  openInsideOutStore(dbPath).close();
  const grade = db.prepare(`INSERT INTO inside_out (interaction_id,rubric,session_id,message_id,assistant_id,human_key,
    sender_id,channel,source,target_at,reviewed_at,model,context_trimmed,joy,sadness,fear,anger,disgust,surprise,person_id)
    VALUES (?,'v1',?,'message','assistant',?,'sender','slack','transcript',?,?,'model',0,?,0,0,?,0,0,?)`);
  const add = (person: string, session: string, at: number, joy: number, anger: number) =>
    grade.run(`${person}/${at}`, session, JSON.stringify(["slack", "workspace", "sender"]), at, at + 200, joy, anger, person);
  for (const offset of [200, 300, 400]) {
    add("blunt", "history", base - offset, 0.1, 0.65);
    add("drop", "history", base - offset, 0.7, 0.2);
  }
  add("blunt", "blunt", base + 40, 0.1, 0.67);
  add("drop", "drop", base + 40, 0.1, 0.6);
  add("drop", "drop", base + 500, 0, 1); // Future grade is not part of the prior baseline.

  assert.equal((await run(base + 1_000, { baselineMinInteractions: 3 })).status, "ok");
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_inside_out_session_target'").get()?.["1"], 1);
  const rows = db.prepare("SELECT session_id,verdict,signals_json FROM memory_outcomes ORDER BY session_id").all();
  assert.deepEqual(rows.map(row => [row.session_id, row.verdict]), [["blunt", "helped"], ["drop", "hurt"]]);
  assert.deepEqual(rows.map(row => JSON.parse(String(row.signals_json)).baselineCount), [3, 3]);
  assert.equal(JSON.parse(String(rows[1]?.signals_json)).insideOutDelta, -1);
  assert.equal(summarizeOutcomeMetrics(db, { agentId }).shortfallsPer100Turns, 50);
});

test("leases gate periodic work, tied timestamps page without loss, and a failed commit rolls back rows and cursor", async t => {
  const { dbPath, db, workStore, run } = fixture(t);
  const one = "qmd://memory/one.md", two = "qmd://memory/two.md", three = "qmd://memory/three.md";
  writeRecallBatch(dbPath, [
    query("old", base - 2 * day, [hit("qmd://memory/old.md")]),
    query("tied", base, [hit(one), hit(two, "emitted", 2), hit(three, "emitted", 3)]),
  ], { prune: false });
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('inside_out','response_results','person_whisper_receipts')").all().length, 0);
  workStore.enqueue({ ...job, recipeHash: "default" });
  const expired = workStore.claim({ ...job, owner: "crashed", leaseMs: 500, now: base + 500 })!;
  assert.deepEqual(await run(base + 999), { status: "already_running" });
  const first = await run(base + 1_000, { maxRowsPerPass: 1, retentionDays: 0 });
  assert.deepEqual(first, { status: "ok", measured: 1, pruned: 0, lastMeasuredAtMs: base - 2 * day, nextDueAt: base + 61_000 });
  assert.throws(() => workStore.withFence(expired, () => assert.fail("expired owner must not publish")), /Work fence lost/);
  assert.deepEqual(await run(base + 60_999), { status: "not_due" });
  assert.equal((await run(base + 61_000, { maxRowsPerPass: 1 })).status, "ok");
  const cursor = workStore.get(job.kind, job.scope)?.artifactJson;
  assert.equal(JSON.parse(String(cursor)).lastMeasuredAtMs, base);
  assert.equal(summarizeOutcomeMetrics(db, { agentId }).totalOutcomes, 2);

  // The page writes "three" first and then "two"; the trigger fails the second insert.
  db.exec(`CREATE TRIGGER fail_outcome BEFORE INSERT ON memory_outcomes
    WHEN NEW.subject_id='qmd://memory/two.md' BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END`);
  assert.deepEqual(await run(base + 121_000, { maxRowsPerPass: 0 }), { status: "failed", reason: "injected commit failure" });
  assert.equal(summarizeOutcomeMetrics(db, { agentId }).totalOutcomes, 2);
  assert.equal(workStore.get(job.kind, job.scope)?.artifactJson, cursor);
  db.exec("DROP TRIGGER fail_outcome");

  const replay = await run(base + 181_000, { maxRowsPerPass: 0, retentionDays: 0 });
  assert.deepEqual(replay, { status: "ok", measured: 2, pruned: 0, lastMeasuredAtMs: base + 900, nextDueAt: base + 241_000 });
  assert.deepEqual(JSON.parse(String(workStore.get(job.kind, job.scope)?.artifactJson)),
    { schemaVersion: 1, lastMeasuredAtMs: base + 900 });
  const ids = () => db.prepare("SELECT id FROM memory_outcomes ORDER BY id").all().map(row => row.id);
  const recovered = ids();
  assert.equal(recovered.length, 4);
  // Steady-state sweeps re-score a bounded window behind the watermark, not the whole lookback.
  const resweep = await run(base + 241_000, { retentionDays: 0 });
  assert.equal(resweep.status === "ok" && resweep.measured, 3);
  assert.deepEqual(ids(), recovered);
  const pruned = await run(base + 301_000, { retentionDays: 1 });
  assert.equal(pruned.status === "ok" && pruned.pruned, 1);
  assert.equal(summarizeOutcomeMetrics(db, { agentId }).totalOutcomes, 3);
});
