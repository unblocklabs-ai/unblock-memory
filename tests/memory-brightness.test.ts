import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { ExpectationsStore } from "../src/expectations-store.js";
import { brightnessRecipeHash, computeBrightnessMap } from "../src/memory-brightness.js";
import { OutcomeLedgerStore } from "../src/outcome-ledger.js";
import { writeRecallBatch, type RecallLedgerEvent } from "../src/recall-ledger.js";

const hour = 3_600_000;
const day = 24 * hour;
const nowMs = Date.UTC(2026, 10, 27);
const agentId = "main";
const pathFor = (name: string) => `qmd://memory/${name}.md`;

function temporaryDatabasePath(t: TestContext): string {
  const folder = mkdtempSync(join(tmpdir(), "memory-brightness-"));
  t.after(() => rmSync(folder, { recursive: true }));
  return join(folder, "ledger.sqlite");
}

test("missing ledgers are empty and never initialize files or tables", t => {
  const path = temporaryDatabasePath(t);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const recipe of ["actr_v1", "outcome_v1"] as const) {
    const options = { agentId, recipe, subjects: [pathFor("unknown")] };
    assert.equal(computeBrightnessMap(path, options).size, 0);
    assert.equal(computeBrightnessMap(db, options).size, 0);
  }
  assert.equal(existsSync(path), false);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema").all(), []);
});

test("ACT-R weights confirmed reads and delivered hits within the scoped window", t => {
  const path = temporaryDatabasePath(t);
  const recent = pathFor("recent"), old = pathFor("old"), unseen = pathFor("unseen");
  const read = (key: string, sourcePath: string, at: number, status: "ok" | "not_found" = "ok", agent = agentId): RecallLedgerEvent => ({
    kind: "read", record: { eventKey: key, agentId: agent, sourcePath, readAtMs: at, status },
  });
  const hit = (key: string, sourcePath: string, at: number, disposition: "emitted" | "returned" | "rank_limit", agent = agentId): RecallLedgerEvent => ({
    kind: "query", record: { eventKey: key, agentId: agent, createdAtMs: at, source: "tool", queryFallback: false,
      corpora: ["memory"], rankingMode: "decision", outcome: "tool_ok", hits: [{ sourcePath, corpus: "memory",
        rawLeafId: key, passageId: key, startLine: 1, endLine: 2, observedAtBasis: "unknown", retrievalRank: 1, disposition }] },
  });
  writeRecallBatch(path, [
    read("recent-1", recent, nowMs), read("recent-2", recent, nowMs - 4 * hour),
    read("failed", recent, nowMs, "not_found"), read("future", recent, nowMs + 1), read("other-read", unseen, nowMs, "ok", "other"),
    hit("delivered", recent, nowMs - hour, "returned"), hit("not-delivered", recent, nowMs, "rank_limit"),
    hit("old-hit", old, nowMs - 120 * day, "emitted"), hit("other-hit", unseen, nowMs, "emitted", "other"),
  ]);
  const options = { agentId, recipe: "actr_v1" as const, subjects: [recent, old, unseen], nowMs };
  const bounded = computeBrightnessMap(path, options);
  const all = computeBrightnessMap(path, { ...options, lookbackDays: 0 });
  const noDecay = computeBrightnessMap(path, { ...options, lookbackDays: 0, decayRate: 0 });
  assert.deepEqual(bounded.get(recent), { recipe: "actr_v1", score: Math.log1p(3.5), normalized: Math.tanh(Math.log1p(3.5) / 3), samples: 3 });
  assert.equal(bounded.get(old)?.samples, 0);
  assert.equal(all.get(old)?.score, Math.log1p(0.5 / Math.sqrt(120 * 24)));
  assert.ok(all.get(recent)!.normalized > all.get(old)!.normalized);
  assert.equal(noDecay.get(old)?.score, Math.log1p(0.5));
  assert.equal(noDecay.get(recent)?.score, Math.log1p(4.5));
  assert.deepEqual(all.get(unseen), { recipe: "actr_v1", score: 0, normalized: 0, samples: 0 });
  // Regression: log(total) went negative for faint evidence (< 1), ranking a used memory BELOW a never-seen one.
  assert.ok(all.get(old)!.score > 0, "a previously used memory never scores below zero");
  assert.ok(all.get(old)!.score > all.get(unseen)!.score, "old > unseen");
  assert.ok(all.get(old)!.normalized > all.get(unseen)!.normalized, "old > unseen after normalization");
});

test("outcome brightness uses scoped confidence-weighted outcomes, durable anchors, and explicitly linked surprise", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const ledger = new OutcomeLedgerStore(db);
  const expectations = new ExpectationsStore(db);
  const helped = pathFor("helped"), hurt = pathFor("hurt"), ignored = pathFor("ignored"), anchored = pathFor("anchored");
  const surprised = pathFor("surprised"), neutral = pathFor("neutral");
  const insert = ledger.db.prepare(`INSERT INTO memory_outcomes
    (id,agent_id,subject_kind,subject_id,verdict,confidence,evidence_turn_id,signals_json,measured_at)
    VALUES (?,?,?,?,?,?,'turn','{}',?)`);
  let index = 0;
  const outcome = (path: string, verdict: string, confidence: number, at = nowMs, agent = agentId, kind = "memory_hit") =>
    insert.run(String(++index), agent, kind, path, verdict, confidence, at);
  outcome(helped, "helped", 0.8, nowMs - 30 * day);
  for (let count = 0; count < 3; count++) {
    outcome(hurt, "hurt", 1);
    outcome(ignored, "ignored", 1);
  }
  outcome(neutral, "helped", 1, nowMs - 120 * day);
  outcome(neutral, "helped", 1, nowMs, "other");
  outcome(neutral, "helped", 1, nowMs, agentId, "skill");
  db.exec("CREATE TABLE core_memories (agent_id TEXT, source_path TEXT, corpus TEXT) STRICT");
  const anchor = db.prepare("INSERT INTO core_memories VALUES (?,?,'memory')");
  anchor.run(agentId, anchored);
  anchor.run(agentId, anchored);
  anchor.run("other", neutral);
  for (const [label, evidence, surpriseScore] of [
    ["linked", { sourcePath: surprised }, 0.8],
    ["low", { sourcePath: neutral }, 0.4],
    ["unlinked", { note: neutral }, 1],
  ] as const) {
    const { expectation } = expectations.upsertExpectation({
      agentId, dedupKey: label, kind: "prediction", sourceKind: "manual", sourceRef: label,
      audienceKey: "workspace", chatType: "workspace", summary: label, expectedState: "known", evidence, nowMs: nowMs - day,
    });
    assert.equal(expectations.resolveExpectation({ id: expectation.id, agentId, status: "wrong", surpriseScore, resolvedAtMs: nowMs }), true);
  }
  const scores = computeBrightnessMap(db, { agentId, recipe: "outcome_v1", nowMs,
    subjects: [helped, hurt, ignored, anchored, surprised, neutral] });
  const expected = new Map([[helped, [0.8 * Math.exp(-1), 1]], [hurt, [-4.5, 3]], [ignored, [-0.36, 3]],
    [anchored, [0.35, 1]], [surprised, [0.28, 1]], [neutral, [0, 0]]] as const);
  for (const [subject, [score, samples]] of expected) {
    const actual = scores.get(subject)!;
    assert.ok(Math.abs(actual.score - score) < 1e-12, subject);
    assert.ok(Math.abs(actual.normalized - Math.tanh(score / 3)) < 1e-12, subject);
    assert.equal(actual.samples, samples);
  }
});

test("recipe tags are stable and distinct for Outcome Ledger cohorts", () => {
  assert.equal(brightnessRecipeHash("off"), "default");
  assert.equal(brightnessRecipeHash("actr_v1"), "brightness:actr_v1");
  assert.equal(brightnessRecipeHash("outcome_v1"), "brightness:outcome_v1");
});
