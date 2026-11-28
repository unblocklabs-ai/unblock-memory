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
  for (const recipe of ["actr_v1", "outcome_v1", "emotion_v1"] as const) {
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

test("Flashbulb brightness retains both joyful and sad memories longer without rewarding hurt", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  new OutcomeLedgerStore(db);
  const joyful = "qmd://sessions/slack/channel/2026-10-28--graduation.md";
  const sad = "qmd://sessions/slack/channel/2026-10-28--major-loss.md";
  const mundane = pathFor("ordinary");
  const hurt = "qmd://sessions/slack/channel/2026-10-28--failed-recall.md";
  db.exec(`CREATE TABLE inside_out (session_id TEXT, intensity REAL, joy REAL, sadness REAL, error TEXT) STRICT;
    INSERT INTO inside_out VALUES ('graduation', 2.4, 0.2, NULL, NULL), ('major-loss', NULL, NULL, 1, NULL),
      ('failed-recall', NULL, NULL, 1, NULL), ('ordinary', 3, 1, NULL, 'failed');`);
  const insert = db.prepare(`INSERT INTO memory_outcomes
    (id,agent_id,subject_kind,subject_id,verdict,confidence,evidence_turn_id,signals_json,measured_at)
    VALUES (?,?,'memory_hit',?,?,1,'turn','{}',?)`);
  const subjects = [joyful, sad, mundane, hurt];
  for (const [i, path] of subjects.entries()) insert.run(`help-${i}`, agentId, path, "helped", nowMs);
  insert.run("hurt", agentId, hurt, "hurt", nowMs);
  db.exec("PRAGMA query_only=ON");

  const options = { agentId, recipe: "emotion_v1" as const, subjects, nowMs };
  const recent = computeBrightnessMap(db, options);
  const later = computeBrightnessMap(db, { ...options, nowMs: nowMs + 60 * day });
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
  // The unified salience reader discounts legacy (NULL-intensity) grades by its default legacyConfidence 0.85.
  const legacySad = 0.85;
  for (const [path, decayDays, bonus] of [[joyful, 102, 0.28], [sad, 30 * (1 + legacySad * 3), 0.35 * legacySad]] as const) {
    near(recent.get(path)!.score, 1 + bonus);
    near(later.get(path)!.score, Math.exp(-60 / decayDays) + bonus);
    assert.ok(recent.get(path)!.score - later.get(path)!.score < recent.get(mundane)!.score - later.get(mundane)!.score);
    assert.ok(later.get(path)!.normalized > later.get(mundane)!.normalized);
  }
  near(later.get(mundane)!.score, Math.exp(-60 / 30));
  assert.ok(recent.get(hurt)!.score < 0);
  const prior = computeBrightnessMap(db, { ...options, recipe: "outcome_v1", nowMs: nowMs + 60 * day });
  assert.ok(later.get(hurt)!.score < prior.get(hurt)!.score, "hurt persists instead of being canceled by the bonus");
  const tuned = computeBrightnessMap(db, { ...options, nowMs: nowMs + 60 * day, emotionDecayStretch: 1, emotionMaxBonus: 0 });
  near(tuned.get(sad)!.score, Math.exp(-60 / (30 * (1 + legacySad))));
});

test("Flashbulb takes the strongest grounded day or legacy session score and tolerates either missing source", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const dated = pathFor("2026-11-26"), legacy = "qmd://sessions/slack/channel/legacy-session/transcript.md", neutral = pathFor("neutral");
  db.exec(`CREATE TABLE inside_out (session_id TEXT, joy REAL, fear REAL) STRICT;
    INSERT INTO inside_out VALUES ('legacy-session', NULL, 0.8), ('2026-11-26', 0.5, NULL), ('', 1, 1);
    CREATE TABLE captains_log_entries (agent_id TEXT, day TEXT);
    CREATE TABLE core_memories (agent_id TEXT, source_path TEXT) STRICT;`);
  db.prepare("INSERT INTO core_memories VALUES (?,?)").run(agentId, neutral);
  const options = { agentId, recipe: "emotion_v1" as const, subjects: [dated, legacy, neutral], nowMs };
  const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-12, message ?? `${actual} != ${expected}`);
  const legacyOnly = computeBrightnessMap(db, options);
  near(legacyOnly.get(legacy)!.score, 0.35 * 0.8 * 0.85, "legacy grades carry the reader's legacyConfidence discount");
  assert.equal(legacyOnly.get(dated)?.score, 0, "a daily log is grounded by Captain's Log only, never by a look-alike session id");
  db.exec(`ALTER TABLE captains_log_entries ADD COLUMN salience_score REAL;
    INSERT INTO captains_log_entries VALUES ('main', '2026-11-26', 0.65), ('main', '2026-11-26', 0.3),
      ('other', '2026-11-26', 1), ('main', '2026-11-25', 1);`);
  assert.equal(computeBrightnessMap(db, options).get(dated)?.score, 0.35 * 0.65, "sources take max rather than stacking");
  db.exec("DROP TABLE inside_out");
  assert.equal(computeBrightnessMap(db, options).get(dated)?.score, 0.35 * 0.65);
  assert.equal(computeBrightnessMap(db, options).get(legacy)?.score, 0);
  db.exec("DROP TABLE captains_log_entries");
  const outcomeOnly = computeBrightnessMap(db, { ...options, recipe: "outcome_v1" });
  assert.equal(outcomeOnly.get(neutral)?.score, 0.35);
  assert.deepEqual(computeBrightnessMap(db, options), new Map([...outcomeOnly].map(([path, score]) => [path, { ...score, recipe: "emotion_v1" }])));
});

test("a locked Flashbulb ledger is neutral until it is readable again", t => {
  const path = temporaryDatabasePath(t);
  const writer = new DatabaseSync(path);
  t.after(() => writer.close());
  writer.exec(`CREATE TABLE captains_log_entries (agent_id TEXT, day TEXT, salience_score REAL) STRICT;
    INSERT INTO captains_log_entries VALUES ('main', '2026-11-26', 1);
    BEGIN EXCLUSIVE;`);
  const subject = pathFor("2026-11-26");
  const options = { agentId, recipe: "emotion_v1" as const, subjects: [subject], nowMs };
  assert.equal(computeBrightnessMap(path, options).size, 0);
  writer.exec("ROLLBACK");
  assert.equal(computeBrightnessMap(path, options).get(subject)?.score, 0.35);
});

test("recipe tags are stable and distinct for Outcome Ledger cohorts", () => {
  assert.equal(brightnessRecipeHash("off"), "default");
  assert.equal(brightnessRecipeHash("actr_v1"), "brightness:actr_v1");
  assert.equal(brightnessRecipeHash("outcome_v1"), "brightness:outcome_v1");
  assert.equal(brightnessRecipeHash("emotion_v1"), "brightness:emotion_v1");
});
