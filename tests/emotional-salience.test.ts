import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  readPathSalience, readSessionMaxSalience, readSessionMessageSalience, resolveEmotionalSalienceOptions, salienceKey,
} from "../src/emotional-salience.js";
import { gradeSignature, intensityReader } from "../src/emotion-baselines.js";
import { openInsideOutStore } from "../src/inside-out-store.js";

const EMOTIONS = ["joy", "sadness", "fear", "anger", "disgust", "surprise"] as const;
type Emotions = Partial<Record<typeof EMOTIONS[number], number>>;

/** The pre-intensity Inside Out schema (as created by inside-out-store), optionally upgraded with intensity/valence. */
function insideOut(db: DatabaseSync, { graded = true, deviations = true } = {}) {
  db.exec(`CREATE TABLE inside_out (
    interaction_id TEXT NOT NULL, rubric TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
    assistant_id TEXT NOT NULL, human_key TEXT NOT NULL, sender_id TEXT NOT NULL, channel TEXT NOT NULL, source TEXT NOT NULL,
    target_at INTEGER, reviewed_at INTEGER NOT NULL, model TEXT NOT NULL, context_trimmed INTEGER NOT NULL,
    joy REAL, sadness REAL, fear REAL, anger REAL, disgust REAL, surprise REAL, error TEXT, person_id TEXT,
    PRIMARY KEY(interaction_id,rubric)) STRICT`);
  if (graded) db.exec("ALTER TABLE inside_out ADD COLUMN intensity REAL; ALTER TABLE inside_out ADD COLUMN valence REAL");
  if (deviations) {
    db.exec(`CREATE TABLE inside_out_deviations (
      id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL, rubric TEXT NOT NULL, grade_signature TEXT NOT NULL,
      assessed_at INTEGER NOT NULL, baseline_id TEXT, person_id TEXT, result_json TEXT NOT NULL) STRICT`);
  }
}

let interaction = 0;
function grade(db: DatabaseSync, row: {
  session: string; message: string; emotions?: Emotions; intensity?: number | null; valence?: number | null;
  rubric?: string; error?: string; at?: number; percentiles?: Emotions & { intensity?: number }; staleSignature?: boolean;
}) {
  const id = `i${++interaction}`, rubric = row.rubric ?? "v1";
  const graded = db.prepare("SELECT 1 FROM pragma_table_info('inside_out') WHERE name='intensity'").get() !== undefined;
  const values = EMOTIONS.map(emotion => row.emotions?.[emotion] ?? 0);
  db.prepare(`INSERT INTO inside_out (interaction_id,rubric,session_id,message_id,assistant_id,human_key,sender_id,channel,source,
      target_at,reviewed_at,model,context_trimmed,${EMOTIONS.join(",")},error${graded ? ",intensity,valence" : ""})
    VALUES (?,?,?,?,'a','h','s','slack','src',?,?,'m',0,?,?,?,?,?,?,?${graded ? ",?,?" : ""})`)
    .run(id, rubric, row.session, row.message, row.at ?? 1000, (row.at ?? 1000) + 1, ...values, row.error ?? null,
      ...(graded ? [row.intensity ?? null, row.valence ?? null] : []));
  if (row.percentiles) {
    const emotions = Object.fromEntries(Object.entries(row.percentiles).map(([name, percentile]) =>
      [name, { delta: 0, percentile, unusualness: Math.abs(2 * percentile - 1) }]));
    const result = { version: "personal-deviation-v2", status: "ok", cumulative: { status: "ok", count: 40, emotions }, weekly: null };
    // The deviation describes this exact grade unless the test simulates a regrade since it was assessed.
    const current = db.prepare(`SELECT interaction_id,rubric,model,person_id,target_at,reviewed_at,error,${EMOTIONS.join(",")}
      FROM inside_out WHERE interaction_id=?`).get(id)!;
    db.prepare("INSERT INTO inside_out_deviations VALUES (?,?,?,?,?,?,?,?)")
      .run(`d${id}`, id, rubric, row.staleSignature ? "stale" : gradeSignature(current), 2000, "b", "p", JSON.stringify(result));
  }
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "emotional-salience-"));
  const path = join(root, "memory.sqlite");
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, db };
}

test("graded intensity: objectively huge joy and grief both score high; routine stays quiet", t => {
  const { db } = fixture(t);
  insideOut(db);
  grade(db, { session: "s1", message: "joy", emotions: { joy: 0.95 }, intensity: 2.6, valence: 0.9 });
  grade(db, { session: "s1", message: "grief", emotions: { sadness: 0.9, fear: 0.4 }, intensity: 2.4, valence: -0.85 });
  grade(db, { session: "s1", message: "routine", emotions: { joy: 0.2 }, intensity: 0.3, valence: 0.1 });
  const map = readSessionMessageSalience(db, ["s1"]);
  const joy = map.get(salienceKey("s1", "joy"))!, grief = map.get(salienceKey("s1", "grief"))!;
  const routine = map.get(salienceKey("s1", "routine"))!;
  assert.equal(joy.highSalience, true);
  assert.equal(joy.label, "joy/milestone");
  assert.equal(joy.absoluteIntensity, 2.6);
  assert.ok(Math.abs(joy.salienceScore - 2.6 / 3) < 1e-9);
  assert.equal(grief.highSalience, true);
  assert.equal(grief.label, "sadness/setback");
  assert.equal(grief.valence, -0.85);
  assert.equal(routine.highSalience, false);
  assert.ok(routine.salienceScore < 0.2);
  assert.equal(map.size, 3);
});

test("a rare spike for a stoic person scores high only with a high personal percentile", t => {
  const { db } = fixture(t);
  insideOut(db);
  grade(db, { session: "stoic", message: "spike", emotions: { fear: 0.5 }, intensity: 1.6, valence: -0.6,
    percentiles: { fear: 0.98, joy: 0.4 } });
  grade(db, { session: "stoic", message: "same-no-baseline", emotions: { fear: 0.5 }, intensity: 1.6, valence: -0.6 });
  grade(db, { session: "stoic", message: "rare-but-trivial", emotions: { fear: 0.2 }, intensity: 0.6, percentiles: { fear: 0.99 } });
  grade(db, { session: "stoic", message: "intensity-baseline", emotions: { joy: 0.5 }, intensity: 1.5, valence: 0.5,
    percentiles: { intensity: 0.99, joy: 0.6 } });
  const map = readSessionMessageSalience(db, ["stoic"]);
  const spike = map.get(salienceKey("stoic", "spike"))!;
  assert.equal(spike.highSalience, true);
  assert.equal(spike.label, "stress/setback");
  assert.equal(spike.relativeIntensityPercentile, 0.98);
  assert.ok(Math.abs(spike.maxEmotionUnusualness! - 0.96) < 1e-9, "one-sided upper tail of the hottest emotion");
  assert.equal(map.get(salienceKey("stoic", "same-no-baseline"))!.highSalience, false);
  assert.equal(map.get(salienceKey("stoic", "rare-but-trivial"))!.highSalience, false, "relative spikes need minRelativeIntensity");
  grade(db, { session: "stoic", message: "regraded", emotions: { fear: 0.5 }, intensity: 1.6, valence: -0.6,
    percentiles: { fear: 0.98 }, staleSignature: true });
  const regraded = readSessionMessageSalience(db, ["stoic"]).get(salienceKey("stoic", "regraded"))!;
  assert.equal(regraded.relativeIntensityPercentile, null, "a deviation assessed for an earlier grade is never this grade's baseline");
  assert.equal(regraded.highSalience, false);
  const direct = map.get(salienceKey("stoic", "intensity-baseline"))!;
  assert.equal(direct.relativeIntensityPercentile, 0.99, "an intensity baseline is preferred over per-emotion percentiles");
  assert.equal(direct.highSalience, true);
  assert.equal(direct.label, "joy/milestone");
});

test("legacy NULL-intensity rows fall back to peak emotion plus deviations, discounted, never zero or a crash", t => {
  const { db } = fixture(t);
  insideOut(db, { graded: false });
  grade(db, { session: "old", message: "panic", emotions: { fear: 0.95, sadness: 0.3 } });
  grade(db, { session: "old", message: "mild", emotions: { joy: 0.2 } });
  grade(db, { session: "old", message: "stoic", emotions: { sadness: 0.6 }, percentiles: { sadness: 0.995 } });
  const map = readSessionMessageSalience(db, ["old"]);
  const panic = map.get(salienceKey("old", "panic"))!;
  assert.equal(panic.absoluteIntensity, null);
  assert.equal(panic.valence, null);
  assert.equal(panic.highSalience, true);
  assert.equal(panic.label, "stress/setback");
  assert.ok(Math.abs(panic.salienceScore - 0.85 * 0.95) < 1e-9, "legacy confidence discount");
  const mild = map.get(salienceKey("old", "mild"))!;
  assert.ok(mild.salienceScore > 0 && !mild.highSalience);
  assert.equal(map.get(salienceKey("old", "stoic"))!.highSalience, true, "legacy rows still use personal deviations");
  // NULL intensity on an upgraded table takes the same fallback.
  const upgraded = fixture(t).db;
  insideOut(upgraded);
  grade(upgraded, { session: "mid", message: "m", emotions: { joy: 0.95 }, intensity: null });
  const signal = readSessionMessageSalience(upgraded, ["mid"]).get(salienceKey("mid", "m"))!;
  assert.equal(signal.absoluteIntensity, null);
  assert.equal(signal.highSalience, true);
});

test("mixed joy and grief is high salience and labelled bittersweet; strongest rubric wins; failed grades are ignored", t => {
  const { db } = fixture(t);
  insideOut(db);
  grade(db, { session: "s", message: "birth-and-loss", emotions: { joy: 0.8, sadness: 0.75 }, intensity: 2.5, valence: 0.05 });
  grade(db, { session: "s", message: "two-rubrics", emotions: { joy: 0.3 }, intensity: 0.9, rubric: "a" });
  grade(db, { session: "s", message: "two-rubrics", emotions: { joy: 0.9 }, intensity: 2.7, valence: 0.9, rubric: "b" });
  grade(db, { session: "s", message: "failed", emotions: { joy: 1 }, intensity: 3, error: "timeout" });
  grade(db, { session: "s", message: "purged", emotions: { joy: 1 }, intensity: 3, error: "Purged by operator" });
  const map = readSessionMessageSalience(db, ["s", "s"]);
  const mixed = map.get(salienceKey("s", "birth-and-loss"))!;
  assert.equal(mixed.highSalience, true);
  assert.equal(mixed.label, "mixed/bittersweet");
  assert.equal(map.get(salienceKey("s", "two-rubrics"))!.absoluteIntensity, 2.7);
  assert.equal(map.has(salienceKey("s", "failed")), false);
  assert.equal(map.has(salienceKey("s", "purged")), false);
  const max = readSessionMaxSalience(db, ["s", "absent"]);
  assert.deepEqual([...max.keys()], ["s"]);
  assert.equal(max.get("s")!.messageId, "two-rubrics");
});

test("missing files, tables and columns are tolerated as no signal", t => {
  const { db, root, path } = fixture(t);
  assert.equal(readSessionMessageSalience(db, ["s"]).size, 0, "no inside_out table");
  assert.equal(readSessionMessageSalience(join(root, "absent.sqlite"), ["s"]).size, 0, "no file");
  assert.equal(readSessionMessageSalience(db, []).size, 0);
  assert.equal(readPathSalience(db, "main", ["memory/2026-11-26.md", "sessions/x--s.md"]).size, 0);
  db.exec("CREATE TABLE inside_out (session_id TEXT, message_id TEXT, joy REAL)");
  db.exec("INSERT INTO inside_out VALUES ('s','m',0.9)");
  const sparse = readSessionMessageSalience(path, ["s"]).get(salienceKey("s", "m"));
  assert.ok(sparse, "a minimal table still yields a fallback signal when read by path");
  assert.equal(sparse.absoluteIntensity, null);
  assert.equal(sparse.relativeIntensityPercentile, null);
  // A read by path never writes.
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='memory_schema'").get()!.n, 0);
});

test("thresholds and weights are configurable and validated", t => {
  const { db } = fixture(t);
  insideOut(db);
  grade(db, { session: "s", message: "m", emotions: { joy: 0.9 }, intensity: 2.4, valence: 0.8 });
  const key = salienceKey("s", "m");
  assert.equal(readSessionMessageSalience(db, ["s"]).get(key)!.highSalience, true);
  assert.equal(readSessionMessageSalience(db, ["s"], { minSalienceScore: 0.95, minAbsoluteIntensity: 3 }).get(key)!.highSalience, false);
  assert.equal(readSessionMessageSalience(db, ["s"], { minSalienceScore: 0.95, minAbsoluteIntensity: 2.4 }).get(key)!.highSalience, true);
  assert.equal(readSessionMessageSalience(db, ["s"], { minSalienceScore: 0 }).get(key)!.highSalience, true);
  assert.throws(() => resolveEmotionalSalienceOptions({ relativeWeight: 1.5 }), RangeError);
  assert.throws(() => resolveEmotionalSalienceOptions({ minAbsoluteIntensity: -1 }), RangeError);
  assert.equal(resolveEmotionalSalienceOptions({ minSalienceScore: undefined }).minSalienceScore, 0.7);
});

test("readPathSalience maps daily logs to Captain's Log salience and session projections to Inside Out", t => {
  const { db } = fixture(t);
  insideOut(db);
  grade(db, { session: "0b6f8f3e-7a1c-4f7e-9a51-1f2a3b4c5d6e", message: "m", emotions: { joy: 0.9 }, intensity: 2.7, valence: 0.9, at: 5000 });
  grade(db, { session: "plain-session", message: "m", emotions: { sadness: 0.5 }, intensity: 1.2, valence: -0.4, at: 6000 });
  db.exec(`CREATE TABLE captains_log_entries (id TEXT PRIMARY KEY, agent_id TEXT, day TEXT, captured_at_ms INTEGER,
    salience_score REAL, emotional_intensity REAL, relative_salience REAL)`);
  db.exec(`INSERT INTO captains_log_entries VALUES
    ('a','main','2026-11-26',100,0.4,1.2,NULL), ('b','main','2026-11-26',200,0.9,2.7,0.95),
    ('c','other','2026-11-25',300,0.99,3,1), ('d','main','2026-11-24',400,NULL,NULL,NULL)`);
  const uuidPath = "slack/channel/acct/conv/2026-11-26T10-00--0b6f8f3e-7a1c-4f7e-9a51-1f2a3b4c5d6e.md";
  const plainPath = "sessions/slack/direct/acct/dm/2026-11-26T11-00--plain-session.md";
  const map = readPathSalience(db, "main", ["memory/2026-11-26.md", "/ws/memory/2026-11-25.md", "memory/2026-11-24.md",
    uuidPath, plainPath, "notes/unrelated.md"]);
  assert.deepEqual(map.get("memory/2026-11-26.md"),
    { salienceScore: 0.9, highSalience: true, absoluteIntensity: 2.7, relativePercentile: 0.95, observedAtMs: 200 });
  assert.equal(map.has("/ws/memory/2026-11-25.md"), false, "another agent's ledger is not this agent's salience");
  assert.equal(map.has("memory/2026-11-24.md"), false, "an entry without salience is no signal");
  const session = map.get(uuidPath)!;
  assert.ok(Math.abs(session.salienceScore - 0.9) < 1e-9);
  assert.deepEqual({ ...session, salienceScore: 0 },
    { salienceScore: 0, highSalience: true, absoluteIntensity: 2.7, relativePercentile: null, observedAtMs: 5000 });
  assert.equal(map.get(plainPath)!.absoluteIntensity, 1.2);
  assert.equal(map.get(plainPath)!.observedAtMs, 6000);
  assert.equal(map.has("notes/unrelated.md"), false);
});

test("personal intensity percentiles are batched: 500 grades × 5,000 history stay fast and match the per-grade reader", t => {
  const { path } = fixture(t);
  const db = openInsideOutStore(path);
  t.after(() => db.close());
  const insert = db.prepare(`INSERT INTO inside_out (interaction_id,rubric,session_id,message_id,assistant_id,human_key,sender_id,
      channel,source,target_at,reviewed_at,model,context_trimmed,joy,sadness,fear,anger,disgust,surprise,error,person_id,
      intensity,intensity_rubric,valence)
    VALUES (?,'v1',?,?,'a','h','s','slack','src',?,?,'m',0,0.5,0,0,0,0,0,NULL,'alice',?,'ir1',0.5)`);
  // Deterministic, tie-heavy intensities exercise the midrank tolerance.
  const value = (i: number) => Math.round(((i * 7919) % 3001) / 1000 * 4) / 4;
  db.exec("BEGIN");
  for (let i = 0; i < 5_000; i++) insert.run(`h${i}`, `history-${i % 50}`, `m${i}`, 1_000 + i * 10, 1_001 + i * 10, value(i));
  for (let i = 0; i < 500; i++) insert.run(`t${i}`, "hot", `t${i}`, 1_000 + i * 100 + 5, 1_000 + i * 100 + 6, value(i + 17));
  db.exec("COMMIT");
  const started = performance.now();
  const map = readSessionMessageSalience(db, ["hot"], { baselineMinInteractions: 20 });
  const elapsed = performance.now() - started;
  assert.equal(map.size, 500);
  assert.ok(elapsed < 250, `500 graded rows against 5,000 history took ${elapsed.toFixed(1)}ms`);
  const reader = intensityReader(db, { minInteractions: 20 });
  for (const row of db.prepare("SELECT * FROM inside_out WHERE session_id='hot'").all()) {
    const expected = reader(row);
    const actual = map.get(salienceKey("hot", String(row.message_id)))!.relativeIntensityPercentile;
    assert.equal(actual, expected.status === "ok" ? expected.intensityPercentile : null, String(row.message_id));
  }
  assert.ok(db.prepare("SELECT 1 FROM pragma_index_list('inside_out') WHERE name='idx_inside_out_session_target'").get(),
    "the store indexes grades by session and time");
});

test("a lookback window drops out-of-range grades before the strongest grade is chosen", t => {
  const { db } = fixture(t);
  insideOut(db);
  const day = 86_400_000, now = 100 * day;
  grade(db, { session: "s", message: "old-peak", emotions: { joy: 1 }, intensity: 3, valence: 1, at: now - 30 * day });
  grade(db, { session: "s", message: "recent", emotions: { joy: 0.5 }, intensity: 1.2, valence: 0.5, at: now - day });
  grade(db, { session: "s", message: "future", emotions: { sadness: 1 }, intensity: 3, valence: -1, at: now + day });
  assert.equal(readSessionMaxSalience(db, ["s"]).get("s")!.messageId, "old-peak", "unbounded by default");
  assert.equal(readSessionMaxSalience(db, ["s"], { nowMs: now, lookbackDays: 7 }).get("s")!.messageId, "recent");
  assert.equal(readSessionMaxSalience(db, ["s"], { nowMs: now, lookbackDays: 0 }).get("s")!.messageId, "old-peak",
    "lookbackDays 0 has no lower bound but still excludes the future");
  const path = "sessions/slack/channel/acct/conv/2026-11-26T10-00--s.md";
  assert.equal(readPathSalience(db, "main", [path], { nowMs: now, lookbackDays: 7 }).get(path)!.absoluteIntensity, 1.2);
  assert.throws(() => readSessionMessageSalience(db, ["s"], { lookbackDays: -1 }), RangeError);
});

test("a locked store is no signal: readers return empty instead of throwing", t => {
  const { db, path } = fixture(t);
  db.exec("PRAGMA journal_mode=DELETE");
  insideOut(db);
  grade(db, { session: "s", message: "m", emotions: { joy: 0.9 }, intensity: 2.7, valence: 0.9 });
  db.exec("BEGIN EXCLUSIVE");
  const other = new DatabaseSync(path);
  t.after(() => other.close());
  other.exec("PRAGMA busy_timeout=1");
  assert.equal(readSessionMessageSalience(path, ["s"], { busyTimeoutMs: 1 }).size, 0);
  assert.equal(readSessionMessageSalience(other, ["s"]).size, 0);
  assert.equal(readPathSalience(other, "main", ["memory/2026-11-26.md", "sessions/x/2026-11-26--s.md"]).size, 0);
  db.exec("ROLLBACK");
  assert.equal(readSessionMessageSalience(path, ["s"]).size, 1, "readable again once the lock is released");
});

test("real QMD daily-note URIs map to Captain's Log; unrelated path segments never name a session", t => {
  const { db } = fixture(t);
  insideOut(db);
  grade(db, { session: "private", message: "m", emotions: { sadness: 1 }, intensity: 3, valence: -1 });
  grade(db, { session: "knowledge", message: "m", emotions: { sadness: 1 }, intensity: 3, valence: -1 });
  grade(db, { session: "dm-session", message: "m", emotions: { joy: 1 }, intensity: 2.8, valence: 1 });
  db.exec(`CREATE TABLE captains_log_entries (id TEXT PRIMARY KEY, agent_id TEXT, day TEXT, captured_at_ms INTEGER,
    salience_score REAL, emotional_intensity REAL, relative_salience REAL, salience_signals_json TEXT)`);
  db.exec(`INSERT INTO captains_log_entries VALUES ('a','main','2026-05-05',100,0.9,2.7,NULL,'{"highSalience":true}'),
    ('b','main','2026-05-06',100,0.75,2.1,NULL,'{"highSalience":false}')`);
  const native = "qmd://source-8881d62392f9/2026-05-05.md";
  const archived = "qmd://source-8881d62392f9/prior-months/may-2026/2026-05-05.md";
  const unflagged = "qmd://memory/2026-05-06.md";
  const policy = "qmd://knowledge/private/policy.md";
  const sessionDay = "qmd://sessions/direct/2026-05-05--dm-session.md";
  const map = readPathSalience(db, "main", [native, archived, unflagged, policy, sessionDay]);
  for (const path of [native, archived]) assert.deepEqual(map.get(path),
    { salienceScore: 0.9, highSalience: true, absoluteIntensity: 2.7, relativePercentile: null, observedAtMs: 100 }, path);
  assert.equal(map.get(unflagged)!.highSalience, false, "the stored Captain's Log flag decides, not the score alone");
  assert.equal(map.has(policy), false, "qmd://knowledge/private/policy.md never inherits a session named `private` or `knowledge`");
  assert.equal(map.get(sessionDay)!.absoluteIntensity, 2.8, "a dated session projection is a session, not a daily note");
});
