import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveConfig } from "../src/config.js";
import { PeopleStore } from "../src/people-store.js";
import { Worker } from "node:worker_threads";
import { baselineFingerprint, baselineInputSnapshot, deviationReader, refreshEmotionBaselines } from "../src/emotion-baselines.js";
import { runInsideOut, reportInsideOut, refreshInsideOutBaselines, reportInsideOutBaselines, linkInsideOutPeople,
  purgeInsideOutPerson, refreshInsideOutBaselinesAsync } from "../src/inside-out.js";
import { openInsideOutStore, refreshWithFingerprint } from "../src/inside-out-store.js";

// Owns the persisted statistical contract: real PeopleSQL identities, transcript grading,
// snapshot refresh, operator export and immutable historical comparisons. Only Jev is offline.
test("person-relative grading uses preceding weeks and preserves comparisons across backfill and identity changes", async t => {
  const root = await mkdtemp(join(tmpdir(), "emotion-baselines-")), sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  const path = join(root, "unblock-memory.sqlite"), firstWeek = Date.UTC(2026, 8, 7), week = 7 * 86400_000;
  let now = firstWeek + 2 * week + 86400_000;
  t.mock.method(Date, "now", () => now);
  const people = new PeopleStore(path, { maxOpenTodos: 100, maxBlurbChars: 1000 });
  t.after(() => people.close());
  const expressive = people.upsertIdentity({ provider: "slack", accountScope: "one", externalId: "same" }).person.id;
  const restrained = people.upsertIdentity({ provider: "slack", accountScope: "two", externalId: "same" }).person.id;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++;
    const request: { model: string; state: [{ target: { text: string } }] } = JSON.parse(String(init.body));
    const text = request.state[0].target.text;
    return Response.json({ model: request.model === "liquid/d1.2-ultra" ? "liquid/d1.2-ultra-20261116" : request.model, answers: text === "failed" ? {} : Object.fromEntries(
      ["joy", "sadness", "fear", "anger", "disgust", "surprise"].map(e => [e, { type: "noul", noul: e === "joy" ? Number(text.replace("model:", "")) : 0.05 }])) });
  });
  const events: unknown[] = [{ type: "session", id: "s" }, { type: "message", id: "answer", timestamp: new Date(firstWeek).toISOString(),
    message: { role: "assistant", content: "Answer" } }];
  const add = (id: string, account: string, score: string, time?: number) => events.push({ type: "message", id,
    ...(time === undefined ? {} : { timestamp: new Date(time).toISOString() }),
    message: { role: "user", content: score, ...(time === undefined ? {} : { timestamp: time }),
      __openclaw: { senderIdentity: { senderKind: "human", id: "same", pluginId: "slack", accountId: account } } } });
  for (let i = 0; i < 20; i++) {
    add(`one-${i}`, "one", "0.8", firstWeek + 1000 + i);
    add(`two-${i}`, "two", "0.1", firstWeek + 1000 + i);
  }
  add("routine", "one", "0.8", firstWeek + week + 1000);
  add("unusual", "two", "0.8", firstWeek + week + 1000);
  add("less", "one", "0.2", firstWeek + 2 * week + 1000);
  add("unlinked", "unknown", "0.8", now);
  add("missing", "one", "0.8");
  add("future", "one", "0.8", now + 86400_000);
  add("failure", "one", "failed", now);
  const saveTranscript = () => writeFile(join(sessionsDir, "s.jsonl"), events.map(e => JSON.stringify(e)).join("\n"));
  await writeFile(join(sessionsDir, "other.jsonl"), [
    { type: "session", id: "other" },
    { type: "message", id: "other-a", timestamp: new Date(firstWeek).toISOString(), message: { role: "assistant", content: "Answer" } },
    { type: "message", id: "other-model", timestamp: new Date(firstWeek + 2000).toISOString(),
      message: { role: "user", content: "model:0.9", timestamp: firstWeek + 2000,
        __openclaw: { senderIdentity: { senderKind: "human", id: "same", pluginId: "slack", accountId: "one" } } } },
  ].map(e => JSON.stringify(e)).join("\n"));
  await runInsideOut({ agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir, storePath: path,
    config: resolveConfig({ typesafe: { apiKey: "offline", model: "other-model", timeoutMs: 1000 },
      insideOut: { enabled: true, intervalMinutes: 0, maxInteractions: 100 } }) });
  await saveTranscript();
  const config = resolveConfig({ typesafe: { apiKey: "offline", timeoutMs: 1000 },
    insideOut: { enabled: true, intervalMinutes: 0, maxInteractions: 100 } });
  const options = { agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir, storePath: path, config };
  await runInsideOut(options);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const deviation = (messageId: string) => {
    const result = deviationReader(db)(db.prepare("SELECT * FROM inside_out WHERE message_id=?").get(messageId)!);
    assert.ok("baselineId" in result, "the persisted runner assessed this grade");
    return result;
  };
  const routine = deviation("routine"), unusual = deviation("unusual"), less = deviation("less");
  assert.ok("cumulative" in routine && routine.cumulative?.emotions);
  assert.ok("cumulative" in unusual && unusual.cumulative?.emotions);
  assert.ok("cumulative" in less && less.cumulative?.emotions);
  assert.equal(routine.personId, expressive);
  assert.equal(unusual.personId, restrained, "identical external IDs in different accounts stay separate");
  assert.equal(routine.cumulative.count, 20);
  assert.equal(routine.cumulative.emotions.joy.percentile, 0.5);
  assert.equal(routine.cumulative.emotions.joy.unusualness, 0, "ties are ordinary, not extreme");
  assert.equal(unusual.cumulative.emotions.joy.percentile, 1);
  assert.ok(Math.abs(unusual.cumulative.emotions.joy.delta - 0.7) < 1e-12);
  assert.equal(less.cumulative.count, 21, "same-week and future replies cannot enter the comparison population");
  assert.equal(less.cumulative.emotions.joy.percentile, 0);
  assert.equal(less.weekly?.status, "insufficient_history");
  assert.equal(deviation("one-0").status, "insufficient_history");
  for (const [id, status] of [["unlinked", "unlinked_person"], ["missing", "missing_time"], ["future", "future_time"], ["failure", "grade_failed"]]) {
    assert.equal(deviation(id!).status, status);
  }
  const snapshots = reportInsideOutBaselines(path);
  assert.equal(snapshots.length, 6);
  assert.ok(snapshots.some(s => s.model === "other-model" && s.cumulative.joy.count === 1));
  const initial = snapshots.find(s => s.person_id === expressive && s.model === "liquid/d1.2-ultra" && s.week_end === firstWeek + week)!;
  assert.equal(initial.weekly.joy.count, 20);
  assert.equal(initial.weekly.joy.p10, 0.8);
  assert.equal(initial.cumulative.joy.mean, 0.8);
  const raw = db.prepare("SELECT * FROM inside_out ORDER BY interaction_id").all();
  const beforeCalls = calls;
  assert.deepEqual(refreshInsideOutBaselines(path), { snapshots: 0, comparisons: 0 });
  assert.deepEqual(db.prepare("SELECT * FROM inside_out ORDER BY interaction_id").all(), raw);
  assert.equal(calls, beforeCalls, "statistics require no inference");
  assert.deepEqual(reportInsideOut(path, { personal: true, personId: restrained }).find(r => r.message_id === "unusual")?.personal_deviation, unusual);

  // A delayed historical reply replaces the affected snapshots, not the already recorded comparison.
  now += 1000;
  add("late", "one", "0.2", firstWeek - week + 1000);
  await saveTranscript();
  await runInsideOut(options);
  assert.equal(calls, beforeCalls + 1, "backfill grades only the newly discovered reply");
  assert.deepEqual(deviation("routine"), routine);
  const replaced = reportInsideOutBaselines(path, { personId: expressive }).filter(s => s.model === "liquid/d1.2-ultra");
  assert.equal(replaced.length, 3, "the late reply's week joins; later weeks are replaced, never duplicated");
  assert.equal(replaced.some(s => s.id === initial.id), false);
  assert.equal(replaced.find(s => s.week_end === initial.week_end)?.cumulative.joy.count, 21);
  now += 1000;
  refreshInsideOutBaselines(path, { recompare: true });
  const revised = deviation("routine");
  assert.ok("cumulative" in revised && revised.cumulative?.emotions);
  assert.equal(revised.cumulative.count, 21);
  assert.notEqual(revised.baselineId, routine.baselineId);
  const exported = reportInsideOut(path, { personal: true, deviationHistory: true }).find(r => r.message_id === "routine")!.personal_deviation;
  assert.ok(exported && typeof exported === "object" && "history" in exported && Array.isArray(exported.history));
  assert.equal(exported.history.length, 2, "explicit re-comparison keeps the original as-of result");
  assert.deepEqual(refreshInsideOutBaselines(path, { recompare: true }), { snapshots: 0, comparisons: 0 });

  // An explicit return to an earlier population is another assessment, not a
  // duplicate that accidentally leaves the intervening result selected.
  const late = db.prepare("SELECT * FROM inside_out WHERE message_id='late'").get()!;
  db.prepare("DELETE FROM inside_out WHERE message_id='late'").run();
  now += 1000;
  refreshInsideOutBaselines(path, { recompare: true });
  assert.equal(deviation("routine").baselineId, routine.baselineId);
  assert.equal(deviation("routine").assessedAt, now);
  db.prepare(`INSERT INTO inside_out (${Object.keys(late).join(",")}) VALUES (${Object.keys(late).map(() => "?").join(",")})`)
    .run(...Object.values(late));
  now += 1000;
  refreshInsideOutBaselines(path, { recompare: true });
  const restored = deviation("routine");
  assert.equal(restored.baselineId, revised.baselineId);

  // Removing identity evidence must not leave stale baseline revisions selectable.
  const identity = db.prepare("SELECT * FROM person_identities WHERE account_scope='one'").get()!;
  db.exec("DELETE FROM person_identities WHERE account_scope='one'");
  refreshInsideOutBaselines(path);
  assert.equal(deviation("routine").status, "unlinked_person");
  assert.equal(reportInsideOutBaselines(path, { personId: expressive }).length, 0, "no snapshot outlives its identity link");
  db.prepare(`INSERT INTO person_identities (${Object.keys(identity).join(",")}) VALUES (${Object.keys(identity).map(() => "?").join(",")})`)
    .run(...Object.values(identity));
  refreshInsideOutBaselines(path, { recompare: true });
  assert.deepEqual(deviation("routine"), restored, "returning identity evidence reuses the current assessment");

  // Daily refreshes retain completed empty weeks, so a historical comparison
  // never substitutes the last populated week for the preceding calendar week.
  now = firstWeek + 5 * week + 86400_000;
  refreshInsideOutBaselines(path);
  assert.equal(deviation("future").status, "ok", "future_time described the clock; once due, a normal refresh compares it");
  const emptyWeek = reportInsideOutBaselines(path, { personId: expressive })
    .find(s => s.model === "liquid/d1.2-ultra" && s.week_start === firstWeek + 3 * week)!;
  assert.equal(emptyWeek.weekly.joy.count, 0);
  add("after-gap", "one", "0.8", firstWeek + 4 * week + 1000);
  await saveTranscript();
  await runInsideOut({ ...options, config: resolveConfig({ typesafe: { apiKey: "offline", timeoutMs: 1000 },
    insideOut: { enabled: true, intervalMinutes: 0, maxInteractions: 1 } }) });
  const afterGap = deviation("after-gap");
  assert.equal(afterGap.baselineEnd, firstWeek + 4 * week);
  assert.equal(afterGap.weekly?.count, 0);
  now += week;
  refreshInsideOutBaselines(path, { recompare: true });
  assert.equal(deviation("after-gap").baselineId, emptyWeek.id);
  assert.equal(calls, beforeCalls + 2);

  // Purging grades leaves tombstones: never relinked, compared, or sent to Jev again, even on --retry.
  const purged = purgeInsideOutPerson(path, expressive, { grades: true });
  assert.ok(purged.grades > 0 && purged.assessments > 0 && purged.baselines > 0);
  await runInsideOut({ ...options, retry: true });
  linkInsideOutPeople(path);
  refreshInsideOutBaselines(path, { recompare: true });
  assert.equal(calls, beforeCalls + 2, "purged replies are not regraded");
  assert.equal(reportInsideOutBaselines(path, { personId: expressive }).length, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM inside_out_deviations WHERE person_id=?").get(expressive)?.n, 0);
  assert.ok(db.prepare("SELECT * FROM inside_out WHERE error=?").all("Purged by operator")
    .every(row => row.person_id === null && row.joy === null), "tombstones keep no probabilities or person link");
  assert.ok(reportInsideOutBaselines(path, { personId: restrained }).length > 0, "other people are untouched");
  assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
});

test("new grades use history linked since the preceding grading run", async t => {
  const root = await mkdtemp(join(tmpdir(), "emotion-late-identity-")), sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  const storePath = join(root, "unblock-memory.sqlite"), week = 7 * 86400_000, firstWeek = Date.UTC(2026, 8, 7);
  t.mock.method(Date, "now", () => firstWeek + 2 * week);
  const people = new PeopleStore(storePath, { maxOpenTodos: 100, maxBlurbChars: 1000 });
  t.after(() => people.close());
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ model: "liquid/d1.2-ultra-20261116", answers: Object.fromEntries(
      ["joy", "sadness", "fear", "anger", "disgust", "surprise"].map(e => [e, { type: "noul", noul: 0.8 }])) });
  });
  const reply = (id: string, time: number) => ({ type: "message", id, timestamp: new Date(time).toISOString(),
    message: { role: "user", content: "Thanks!", timestamp: time,
      __openclaw: { senderIdentity: { senderKind: "human", id: "late-person", pluginId: "slack", accountId: "one" } } } });
  const events = [{ type: "message", id: "answer", timestamp: new Date(firstWeek).toISOString(),
    message: { role: "assistant", content: "Answer" } },
    ...Array.from({ length: 20 }, (_, i) => reply(`old-${i}`, firstWeek + 1000 + i))];
  const save = () => writeFile(join(sessionsDir, "s.jsonl"), events.map(e => JSON.stringify(e)).join("\n"));
  const options = { agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir, storePath,
    config: resolveConfig({ typesafe: { apiKey: "offline" }, insideOut: { enabled: true, intervalMinutes: 0 } }) };
  await save();
  await runInsideOut(options);
  assert.ok(reportInsideOut(storePath).every(row => row.person_id === null));
  const person = people.upsertIdentity({ provider: "slack", accountScope: "one", externalId: "late-person" }).person.id;
  events.push(reply("new", firstWeek + week + 1000));
  await save();
  await runInsideOut(options);
  const rows = reportInsideOut(storePath, { personal: true, deviationHistory: true });
  assert.ok(rows.every(row => row.person_id === person), "the grading path refreshes historical identity links");
  const result = rows.find(row => row.message_id === "new")!.personal_deviation as {
    status: string; cumulative: { count: number }; history: unknown[];
  };
  assert.equal(result.status, "ok");
  assert.equal(result.cumulative.count, 20);
  assert.equal(result.history.length, 1, "the first assessment is correct without explicit re-comparison");
  assert.equal(calls, 21, "linking old replies never repeats inference");
});

const WEEK = 7 * 86400_000, FIRST_WEEK = Date.UTC(2026, 0, 5);
const EMOTIONS = ["joy", "sadness", "fear", "anger", "disgust", "surprise"] as const;
/** Linked grades written straight to the store: statistics need neither transcripts nor Jev. */
async function gradedStore(people: { account: string; grades: number; weeks: number }[]) {
  const root = await mkdtemp(join(tmpdir(), "emotion-store-")), path = join(root, "unblock-memory.sqlite");
  const store = new PeopleStore(path, { maxOpenTodos: 100, maxBlurbChars: 1000 });
  const ids = people.map(p => store.upsertIdentity({ provider: "slack", accountScope: p.account, externalId: "u" }).person.id);
  store.close();
  const db = openInsideOutStore(path);
  const insert = db.prepare(`INSERT INTO inside_out (interaction_id,rubric,session_id,message_id,assistant_id,human_key,sender_id,
    channel,source,target_at,reviewed_at,model,context_trimmed,${EMOTIONS.join(",")},error,person_id) VALUES (${Array(21).fill("?").join(",")})`);
  db.exec("BEGIN");
  people.forEach((p, n) => {
    for (let i = 0; i < p.grades; i++) {
      // Distinct raw floats: the previous format stored one histogram entry per grade.
      const at = FIRST_WEEK + Math.floor(i * p.weeks / p.grades) * WEEK + i, score = ((i * 7919) % p.grades + 0.5) / p.grades;
      insert.run(`${p.account}-${i}`, "emotion-presence-v2", "s", `${p.account}-${i}`, "a", JSON.stringify(["slack", p.account, "u"]), "u",
        "slack", "s.jsonl", at, at, "jev-test", 0, ...EMOTIONS.map(() => score), null, ids[n]!);
    }
  });
  db.exec("COMMIT");
  db.close();
  return { root, path, ids, now: FIRST_WEEK + Math.max(...people.map(p => p.weeks)) * WEEK + 86400_000 };
}

test("snapshots stay bounded, are replaced rather than duplicated, and commit in short batches", async t => {
  const { path, ids: [person], now } = await gradedStore([{ account: "one", grades: 3000, weeks: 30 }]);
  const exec = DatabaseSync.prototype.exec;
  let transactions = 0;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") transactions++;
    return exec.call(this, sql);
  });
  const first = refreshInsideOutBaselines(path, { now });
  assert.deepEqual(first, { snapshots: 30, comparisons: 3000 });
  assert.ok(transactions >= 7, `3,030 writes commit in batches of at most 500, not one long transaction (${transactions})`);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const size = () => db.prepare("SELECT count(*) n,max(length(weekly_json)) largest FROM person_emotion_baselines").get()!;
  assert.equal(size().n, 30);
  assert.ok(Number(size().largest) < 8000, "100 distinct grades per week fit in at most 101 bins per emotion");

  // Backfill and regrading change week ids from the affected week onwards; rows are rewritten in place.
  for (let round = 1; round <= 3; round++) {
    db.prepare("UPDATE inside_out SET reviewed_at=reviewed_at+1,joy=? WHERE interaction_id='one-0'").run(round / 10);
    assert.equal(refreshInsideOutBaselines(path, { now }).snapshots, 30);
    assert.equal(size().n, 30, "every refresh keeps exactly one snapshot per completed week");
  }
  assert.deepEqual(refreshInsideOutBaselines(path, { now }), { snapshots: 0, comparisons: 0 });
  const [latest] = reportInsideOutBaselines(path, { personId: person, limit: 1 });
  assert.equal(latest!.cumulative.joy.count, 3000);
  assert.equal(latest!.weekly.joy.count, 100);
  assert.ok(latest!.cumulative.joy.distribution.length <= 101);
  const raw = db.prepare("SELECT avg(sadness) mean,min(sadness) min,max(sadness) max FROM inside_out").get()!;
  assert.ok(Math.abs(latest!.cumulative.sadness.mean! - Number(raw.mean)) < 1e-12, "means use exact sums, not bin centres");
  assert.equal(latest!.cumulative.sadness.min, raw.min);
  assert.equal(latest!.cumulative.sadness.max, raw.max);
  // week_end is the exclusive next Monday: --since a Monday excludes the week that ended the day before.
  assert.equal(reportInsideOutBaselines(path, { since: FIRST_WEEK + 29 * WEEK }).length, 1);
  assert.equal(reportInsideOutBaselines(path, { since: FIRST_WEEK + 29 * WEEK - 86400_000 }).length, 2);

  // Relinking reads matches first and writes only changes, in short batches.
  db.exec("UPDATE inside_out SET person_id=NULL");
  transactions = 0;
  assert.equal(linkInsideOutPeople(path).updated, 3000);
  assert.ok(transactions >= 6, `3,000 relinks commit in batches of at most 500 (${transactions})`);
  transactions = 0;
  assert.equal(linkInsideOutPeople(path).updated, 0);
  assert.equal(transactions, 0, "an unchanged link pass takes no write lock");
});

test("a refresh never writes back a person purged after it read their grades", async t => {
  const { path, ids: [one, two], now } = await gradedStore([{ account: "one", grades: 60, weeks: 3 }, { account: "two", grades: 60, weeks: 3 }]);
  purgeInsideOutPerson(path, "nobody");
  const db = openInsideOutStore(path);
  t.after(() => db.close());
  const exec = DatabaseSync.prototype.exec;
  let raced = false;
  // The refresh's first write batch starts only after all reads: purge exactly then, from another connection.
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (this === db && sql === "BEGIN IMMEDIATE" && !raced) { raced = true; purgeInsideOutPerson(path, one!, { grades: true }); }
    return exec.call(this, sql);
  });
  const result = refreshEmotionBaselines(db, { minInteractions: 20, now });
  assert.equal(raced, true);
  assert.deepEqual(result, { snapshots: 3, comparisons: 60 }, "only the untouched person is written");
  assert.equal(db.prepare("SELECT count(*) n FROM inside_out_deviations WHERE person_id=?").get(one)?.n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(one)?.n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(two)?.n, 3);
});

test("purging grades first links replies whose identity arrived after the last refresh", async () => {
  const { path, ids: [one] } = await gradedStore([{ account: "one", grades: 60, weeks: 3 }]);
  const db = new DatabaseSync(path);
  db.exec("UPDATE inside_out SET person_id=NULL WHERE rowid % 2 = 0");
  db.close();
  assert.equal(purgeInsideOutPerson(path, one!, { grades: true }).grades, 60);
});

test("the refresh fingerprint changes with every input a refresh reads", async () => {
  const { path, ids: [one], now } = await gradedStore([{ account: "one", grades: 60, weeks: 3 }]);
  refreshInsideOutBaselines(path, { now });
  const db = openInsideOutStore(path);
  const print = (overrides: { now?: number; minInteractions?: number } = {}) => baselineFingerprint(db, { minInteractions: 20, now, ...overrides });
  const initial = print();
  assert.equal(print(), initial);
  assert.notEqual(print({ now: now + WEEK }), initial, "a new week can add a snapshot");
  assert.notEqual(print({ minInteractions: 21 }), initial);
  const changed = (sql: string, ...params: (string | number)[]) => {
    const before = print();
    db.prepare(sql).run(...params);
    assert.notEqual(print(), before, sql);
  };
  changed("UPDATE inside_out SET reviewed_at=reviewed_at+1 WHERE rowid=1");
  changed("UPDATE inside_out SET person_id=NULL WHERE rowid=2");
  changed("UPDATE inside_out SET error='x' WHERE rowid=3");
  changed("UPDATE inside_out SET target_at=? WHERE rowid=4", now + 86400_000);
  changed("DELETE FROM inside_out_deviations WHERE rowid=1");
  changed("DELETE FROM person_emotion_baselines WHERE person_id=? AND week_start=?", one!, FIRST_WEEK);
  db.close();
  // In-process async refreshes skip unchanged inputs; explicit re-comparison never skips.
  const fresh = await gradedStore([{ account: "one", grades: 60, weeks: 3 }]);
  assert.deepEqual(await refreshInsideOutBaselinesAsync(fresh.path, { now: fresh.now }), { snapshots: 3, comparisons: 60 });
  assert.deepEqual(await refreshInsideOutBaselinesAsync(fresh.path, { now: fresh.now }), { snapshots: 0, comparisons: 0 });
  assert.deepEqual(await refreshInsideOutBaselinesAsync(fresh.path, { now: fresh.now, minInteractions: 61, recompare: true }),
    { snapshots: 0, comparisons: 60 });
});

// The worker resolves imports with plain Node, without the host's `openclaw` aliases. This
// checkout has openclaw installed, so the worker tests above would still pass if one slipped in.
test("the baseline worker's import graph stays free of openclaw", () => {
  const visited = new Set<string>();
  const pending = [new URL("../src/inside-out-store.ts", import.meta.url)];
  for (let file = pending.pop(); file; file = pending.pop()) {
    if (visited.has(file.href)) continue;
    visited.add(file.href);
    // Runtime imports only: `import type` is erased before the worker loads anything.
    const imports = readFileSync(file, "utf8").matchAll(
      /^(?:import|export)\s+(?!type\s)(?:[\w$*{},\s]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm);
    for (const match of imports) {
      const specifier = match[1] ?? match[2]!;
      assert.ok(!specifier.startsWith("openclaw"), `${file.pathname} imports ${specifier}`);
      if (specifier.startsWith(".")) pending.push(new URL(specifier.replace(/\.js$/, ".ts"), file));
    }
  }
  // json-hash is reached only through emotion-baselines, so this proves the walk is transitive.
  assert.ok([...visited].some(href => href.endsWith("/src/json-hash.ts")), "followed the worker's transitive imports");
});

test("terminating a worker mid-transaction rolls back and releases the shared store", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "emotion-terminate-")), "store.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x)");
  const worker = new Worker(`
    const { DatabaseSync } = require("node:sqlite"), { parentPort, workerData } = require("node:worker_threads");
    const db = new DatabaseSync(workerData);
    db.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (1)");
    parentPort.postMessage("locked");
    for (;;) {}
  `, { eval: true, workerData: path });
  await new Promise(resolve => worker.once("message", resolve));
  db.exec("PRAGMA busy_timeout=0");
  assert.throws(() => db.exec("INSERT INTO t VALUES (2)"), /locked/);
  await worker.terminate();
  db.exec("INSERT INTO t VALUES (3)");
  assert.deepEqual(db.prepare("SELECT x FROM t").all().map(row => row.x), [3]);
  db.close();
});

test("purging without grades removes derived history; the next refresh rebuilds only from current links", async () => {
  const { path, ids: [one, two], now } = await gradedStore([{ account: "one", grades: 60, weeks: 3 }, { account: "two", grades: 60, weeks: 3 }]);
  refreshInsideOutBaselines(path, { now });
  assert.deepEqual(purgeInsideOutPerson(path, one!), { baselines: 3, assessments: 60, grades: 0 });
  assert.equal(reportInsideOutBaselines(path, { personId: one }).length, 0);
  assert.equal(reportInsideOutBaselines(path, { personId: two }).length, 3);
  assert.deepEqual(refreshInsideOutBaselines(path, { now }), { snapshots: 3, comparisons: 60 }, "grades remain, so statistics return");
  assert.deepEqual(purgeInsideOutPerson(path, "unknown-person", { grades: true }), { baselines: 0, assessments: 0, grades: 0 });
  assert.throws(() => purgeInsideOutPerson(path, " "), /person ID is required/);
  const empty = join(await mkdtemp(join(tmpdir(), "emotion-empty-")), "unblock-memory.sqlite");
  new PeopleStore(empty, { maxOpenTodos: 100, maxBlurbChars: 1000 }).close();
  assert.deepEqual(purgeInsideOutPerson(empty, one!), { baselines: 0, assessments: 0, grades: 0 });
  const probe = new DatabaseSync(empty, { readOnly: true });
  assert.equal(probe.prepare("SELECT 1 FROM sqlite_schema WHERE name='inside_out'").get(), undefined, "purge never creates Inside Out tables");
  probe.close();
});

test("aborting a baseline refresh skips queued work, terminates the worker and leaves the store writable", async () => {
  const { path, now } = await gradedStore([{ account: "one", grades: 2000, weeks: 20 }]);
  const before = new AbortController();
  before.abort();
  await assert.rejects(refreshInsideOutBaselinesAsync(path, { now }, before.signal), { name: "AbortError" });
  const during = new AbortController();
  const job = refreshInsideOutBaselinesAsync(path, { now }, during.signal);
  await new Promise(setImmediate);
  during.abort();
  await assert.rejects(job, { name: "AbortError" });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=0; CREATE TABLE probe(x); DROP TABLE probe;");
  db.close();
  const resumed = await refreshInsideOutBaselinesAsync(path, { now });
  assert.equal(resumed.snapshots, 20);
  assert.equal(resumed.comparisons, 2000);
});

test("unreleased v1 baseline tables are rebuilt as bounded v2 storage", async () => {
  const { path, now } = await gradedStore([{ account: "one", grades: 40, weeks: 2 }]);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE person_emotion_baselines (id TEXT PRIMARY KEY, cumulative_json TEXT) STRICT;
    CREATE TABLE inside_out_deviations (id TEXT PRIMARY KEY, baseline_id TEXT REFERENCES person_emotion_baselines(id)) STRICT;
    INSERT INTO person_emotion_baselines VALUES ('old','{}'); INSERT INTO inside_out_deviations VALUES ('old','old');
    INSERT INTO memory_schema VALUES ('emotion-baselines',1);`);
  db.close();
  assert.deepEqual(refreshInsideOutBaselines(path, { now }), { snapshots: 2, comparisons: 40 });
  const migrated = new DatabaseSync(path, { readOnly: true });
  assert.equal(migrated.prepare("SELECT version FROM memory_schema WHERE component='emotion-baselines'").get()?.version, 2);
  assert.equal(migrated.prepare("SELECT count(*) n FROM inside_out_deviations WHERE id='old'").get()?.n, 0);
  migrated.close();
});

test("a failed baseline refresh never turns a saved grading run into a failure", async t => {
  const root = await mkdtemp(join(tmpdir(), "emotion-refresh-failure-")), sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  const storePath = join(root, "unblock-memory.sqlite");
  t.mock.method(globalThis, "fetch", async () => Response.json({ model: "liquid/d1.2-ultra-20261116",
    answers: Object.fromEntries(EMOTIONS.map(e => [e, { type: "noul", noul: 0.4 }])) }));
  await writeFile(join(sessionsDir, "s.jsonl"), [{ type: "message", id: "answer", message: { role: "assistant", content: "Answer" } },
    { type: "message", id: "reply", message: { role: "user", content: "Thanks!" } }].map(e => JSON.stringify(e)).join("\n"));
  const blocker = openInsideOutStore(storePath);
  blocker.exec("INSERT INTO memory_schema VALUES ('emotion-baselines',99)");
  blocker.close();
  const result = await runInsideOut({ agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir, storePath,
    config: resolveConfig({ typesafe: { apiKey: "offline" }, insideOut: { enabled: true, intervalMinutes: 0 } }) });
  assert.ok("reviewed" in result);
  assert.equal(result.reviewed, 1);
  assert.match(result.baselineError ?? "", /Unsupported Inside Out baseline storage version/);
  assert.equal(reportInsideOut(storePath).length, 1, "the grade stays saved");
});

test("the compiled baseline worker runs under plain Node and never imports the OpenClaw SDK", async () => {
  const entry = new URL("../dist/src/inside-out-store.js", import.meta.url), seen = new Set<string>();
  const visit = (url: URL) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    for (const [, specifier] of readFileSync(url, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      assert.ok(!specifier!.startsWith("openclaw"), `${url.pathname} imports ${specifier}`);
      if (specifier!.startsWith(".")) visit(new URL(specifier!, url));
    }
  };
  visit(entry);
  assert.ok(seen.size >= 3, "the worker graph includes the store, database and statistics modules");
  const { root, path, now } = await gradedStore([{ account: "one", grades: 40, weeks: 2 }]);
  // No tsx: the worker must load compiled JavaScript exactly as an installed plugin does.
  const script = join(root, "compiled-worker.mjs");
  await writeFile(script, `const m = await import(${JSON.stringify(entry.href)});
    process.stdout.write(JSON.stringify(await m.refreshInsideOutBaselinesAsync(${JSON.stringify(path)}, { now: ${now} })));`);
  const { stdout } = await promisify(execFile)(process.execPath, [script], { env: { ...process.env, NODE_OPTIONS: "" }, timeout: 30_000 });
  assert.deepEqual(JSON.parse(stdout), { snapshots: 2, comparisons: 40 });
});

test("an input change arriving mid-refresh prevents false fingerprint certification and forces another refresh pass", async t => {
  const { path, ids: [one], now } = await gradedStore([{ account: "one", grades: 60, weeks: 3 }]);
  // Initialize baseline schema v2 beforehand so the first BEGIN IMMEDIATE occurs at the write batch after reads.
  purgeInsideOutPerson(path, "nobody");
  const exec = DatabaseSync.prototype.exec;
  let raced = false;
  // Inject a new grade into week 0 right when the first write batch begins.
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && !raced) {
      raced = true;
      const writer = new DatabaseSync(path);
      try {
        writer.prepare(`INSERT INTO inside_out (interaction_id,rubric,session_id,message_id,assistant_id,human_key,sender_id,
          channel,source,target_at,reviewed_at,model,context_trimmed,${EMOTIONS.join(",")},error,person_id)
          VALUES (${Array(21).fill("?").join(",")})`)
          .run("midpass-grade", "emotion-presence-v2", "s", "midpass-grade", "a", JSON.stringify(["slack", "one", "u"]), "u",
            "slack", "s.jsonl", FIRST_WEEK + 500, FIRST_WEEK + 500, "jev-test", 0, ...EMOTIONS.map(() => 0.9), null, one!);
      } finally { writer.close(); }
    }
    return exec.call(this, sql);
  });

  const first = refreshWithFingerprint(path, { now, link: false });
  assert.equal(raced, true);
  assert.equal(first.fingerprint, undefined, "mid-pass input changes must never be certified as processed");
  assert.equal(first.result.snapshots, 0, "stale snapshots affected by the mid-pass grade are fenced out");

  // Because no fingerprint was certified, the next pass runs and picks up the new grade.
  const second = refreshWithFingerprint(path, { now, link: false, unless: first.fingerprint });
  assert.equal(second.result.snapshots, 3);
  assert.equal(typeof second.fingerprint, "string");
  const [latest] = reportInsideOutBaselines(path, { personId: one, limit: 1 });
  assert.equal(latest?.cumulative.joy.count, 61, "follow-up refresh includes the mid-pass grade");

  // Once inputs are stable, the certified fingerprint skips redundant passes.
  const third = refreshWithFingerprint(path, { now, link: false, unless: second.fingerprint });
  assert.deepEqual(third.result, { snapshots: 0, comparisons: 0 });
  assert.equal(third.fingerprint, second.fingerprint);
});

test("population drop is fenced against concurrent relinks and failing workers release SQLite before settling", async t => {
  const { path, ids: [one, two], now } = await gradedStore([
    { account: "one", grades: 40, weeks: 2 },
    { account: "two", grades: 40, weeks: 2 },
  ]);
  assert.deepEqual(refreshInsideOutBaselines(path, { now }), { snapshots: 4, comparisons: 80 });

  // Unlink person `two` before refresh starts so `refreshEmotionBaselines` schedules a population drop for `two`.
  const setup = new DatabaseSync(path);
  setup.prepare("UPDATE inside_out SET person_id=NULL WHERE person_id=?").run(two!);
  setup.close();

  const db = openInsideOutStore(path);
  t.after(() => db.close());
  const exec = DatabaseSync.prototype.exec;
  let relinked = false;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (this === db && sql === "BEGIN IMMEDIATE" && !relinked) {
      relinked = true;
      const writer = new DatabaseSync(path);
      try {
        writer.prepare("UPDATE inside_out SET person_id=? WHERE human_key=?").run(two!, JSON.stringify(["slack", "two", "u"]));
      } finally { writer.close(); }
    }
    return exec.call(this, sql);
  });
  refreshEmotionBaselines(db, { minInteractions: 20, now });
  assert.equal(relinked, true);
  assert.equal(db.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(two!)?.n, 2,
    "concurrently relinked population keeps its baselines");
  assert.equal(db.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(one!)?.n, 2);

  // Worker error settles only on exit so the store is immediately unlocked and a subsequent refresh succeeds.
  const errorStore = await gradedStore([{ account: "one", grades: 40, weeks: 2 }]);
  const blocker = openInsideOutStore(errorStore.path);
  blocker.exec("INSERT INTO memory_schema VALUES ('emotion-baselines',99)");
  blocker.close();
  await assert.rejects(
    refreshInsideOutBaselinesAsync(errorStore.path, { now: errorStore.now }),
    /Unsupported Inside Out baseline storage version/,
  );
  const probe = new DatabaseSync(errorStore.path);
  probe.exec("PRAGMA busy_timeout=0; CREATE TABLE exit_probe(x); DROP TABLE exit_probe;");
  probe.exec("DELETE FROM memory_schema WHERE component='emotion-baselines'");
  probe.close();
  assert.deepEqual(await refreshInsideOutBaselinesAsync(errorStore.path, { now: errorStore.now }), { snapshots: 2, comparisons: 40 });
});

test("post-pass fingerprint certification runs in one read snapshot and never certifies unprocessed mutations", async t => {
  // Case 1: a grade committed right after refreshEmotionBaselines finishes (before the post-pass snapshot starts)
  // invalidates certification instead of being folded into a cached fingerprint.
  const firstStore = await gradedStore([{ account: "one", grades: 40, weeks: 2 }]);
  purgeInsideOutPerson(firstStore.path, "nobody");
  const exec = DatabaseSync.prototype.exec;
  let sawWriteBatch = false;
  let injectedBeforePostPass = false;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") sawWriteBatch = true;
    if (sawWriteBatch && sql === "BEGIN" && !injectedBeforePostPass) {
      injectedBeforePostPass = true;
      const writer = new DatabaseSync(firstStore.path);
      try {
        writer.prepare(`INSERT INTO inside_out (interaction_id,rubric,session_id,message_id,assistant_id,human_key,sender_id,
          channel,source,target_at,reviewed_at,model,context_trimmed,${EMOTIONS.join(",")},error,person_id)
          VALUES (${Array(21).fill("?").join(",")})`)
          .run("post-pass-grade", "emotion-presence-v2", "s", "post-pass-grade", "a", JSON.stringify(["slack", "one", "u"]), "u",
            "slack", "s.jsonl", FIRST_WEEK + 500, FIRST_WEEK + 500, "jev-test", 0, ...EMOTIONS.map(() => 0.9), null, firstStore.ids[0]!);
      } finally { writer.close(); }
    }
    return exec.call(this, sql);
  });
  const afterPassRace = refreshWithFingerprint(firstStore.path, { now: firstStore.now, link: false });
  assert.equal(injectedBeforePostPass, true);
  assert.equal(afterPassRace.fingerprint, undefined, "post-pass mutation must not be certified");
  const afterPassFollowUp = refreshWithFingerprint(firstStore.path, { now: firstStore.now, link: false, unless: afterPassRace.fingerprint });
  assert.equal(afterPassFollowUp.result.snapshots, 2);
  assert.equal(afterPassFollowUp.result.comparisons, 1);
  assert.equal(reportInsideOutBaselines(firstStore.path, { personId: firstStore.ids[0]!, limit: 1 })[0]?.cumulative.joy.count, 41);

  // Case 2: a grade committed mid-snapshot during post-pass certificate creation (between scanning inputs and
  // counting derived tables) is invisible to the consistent snapshot, so the returned certificate only covers
  // the pre-mutation state and the next refresh still processes the new grade.
  const secondStore = await gradedStore([{ account: "one", grades: 40, weeks: 2 }]);
  purgeInsideOutPerson(secondStore.path, "nobody");
  const prepare = DatabaseSync.prototype.prepare;
  let injectedMidSnapshot = false;
  t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    if (sql === "SELECT count(*) n FROM person_emotion_baselines" && !injectedMidSnapshot) {
      injectedMidSnapshot = true;
      const writer = new DatabaseSync(secondStore.path);
      try {
        writer.prepare(`INSERT INTO inside_out (interaction_id,rubric,session_id,message_id,assistant_id,human_key,sender_id,
          channel,source,target_at,reviewed_at,model,context_trimmed,${EMOTIONS.join(",")},error,person_id)
          VALUES (${Array(21).fill("?").join(",")})`)
          .run("mid-snapshot-grade", "emotion-presence-v2", "s", "mid-snapshot-grade", "a", JSON.stringify(["slack", "one", "u"]), "u",
            "slack", "s.jsonl", FIRST_WEEK + 500, FIRST_WEEK + 500, "jev-test", 0, ...EMOTIONS.map(() => 0.9), null, secondStore.ids[0]!);
      } finally { writer.close(); }
    }
    return prepare.call(this, sql);
  });
  const midSnapRace = refreshWithFingerprint(secondStore.path, { now: secondStore.now, link: false });
  assert.equal(injectedMidSnapshot, true);
  assert.equal(typeof midSnapRace.fingerprint, "string", "consistent pre-mutation snapshot produces a pre-mutation certificate");
  const midSnapFollowUp = refreshWithFingerprint(secondStore.path, { now: secondStore.now, link: false, unless: midSnapRace.fingerprint });
  assert.equal(midSnapFollowUp.result.snapshots, 2, "next refresh must not skip a grade committed mid-certification");
  assert.equal(midSnapFollowUp.result.comparisons, 1);
  assert.equal(reportInsideOutBaselines(secondStore.path, { personId: secondStore.ids[0]!, limit: 1 })[0]?.cumulative.joy.count, 41);
  const midSnapStable = refreshWithFingerprint(secondStore.path, { now: secondStore.now, link: false, unless: midSnapFollowUp.fingerprint });
  assert.deepEqual(midSnapStable.result, { snapshots: 0, comparisons: 0 });
  assert.equal(midSnapStable.fingerprint, midSnapFollowUp.fingerprint);
});

test("analytics-only purge during an in-flight refresh prevents restoring purged baselines or deviations", async t => {
  const { path, ids: [one, two], now } = await gradedStore([
    { account: "one", grades: 60, weeks: 3 },
    { account: "two", grades: 60, weeks: 3 },
  ]);
  purgeInsideOutPerson(path, "nobody");
  const exec = DatabaseSync.prototype.exec;
  let racedFresh = false;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && !racedFresh) {
      racedFresh = true;
      // Analytics-only purge on a second connection: leaves raw grades in inside_out untouched.
      purgeInsideOutPerson(path, one!);
    }
    return exec.call(this, sql);
  });
  const first = refreshWithFingerprint(path, { now, link: false });
  assert.equal(racedFresh, true);
  assert.deepEqual(first.result, { snapshots: 3, comparisons: 60 }, "only untouched person commits");
  assert.equal(first.fingerprint, undefined, "mid-pass analytics purge invalidates certification");
  const check = new DatabaseSync(path);
  t.after(() => check.close());
  assert.equal(check.prepare("SELECT count(*) n FROM inside_out WHERE person_id=?").get(one!)?.n, 60, "raw grades remain");
  assert.equal(check.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(one!)?.n, 0);
  assert.equal(check.prepare("SELECT count(*) n FROM inside_out_deviations WHERE person_id=?").get(one!)?.n, 0);
  assert.equal(check.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(two!)?.n, 3);
  assert.equal(check.prepare("SELECT count(*) n FROM inside_out_deviations WHERE person_id=?").get(two!)?.n, 60);

  // Subsequent refresh started after the purge rebuilds cleanly from the remaining grades.
  const rebuilt = refreshWithFingerprint(path, { now, link: false, unless: first.fingerprint });
  assert.deepEqual(rebuilt.result, { snapshots: 3, comparisons: 60 });
  assert.equal(check.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(one!)?.n, 3);
  assert.equal(check.prepare("SELECT count(*) n FROM inside_out_deviations WHERE person_id=?").get(one!)?.n, 60);

  // Analytics-only purge committing during an in-flight recompare must not restore purged history either.
  let racedRecompare = false;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && !racedRecompare) {
      racedRecompare = true;
      const purged = purgeInsideOutPerson(path, one!);
      assert.deepEqual(purged, { baselines: 3, assessments: 60, grades: 0 });
    }
    return exec.call(this, sql);
  });
  const recompareRun = refreshWithFingerprint(path, { now, minInteractions: 21, recompare: true, link: false });
  assert.equal(racedRecompare, true);
  assert.equal(recompareRun.fingerprint, undefined);
  assert.equal(check.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(one!)?.n, 0,
    "in-flight recompare must not restore purged baselines");
  assert.equal(check.prepare("SELECT count(*) n FROM inside_out_deviations WHERE person_id=?").get(one!)?.n, 0,
    "in-flight recompare must not restore purged deviations");
  assert.equal(check.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(two!)?.n, 3);
});

test("earlier week grade mutation during an in-flight refresh fences out later week deviations from phantom or stale baselines", async t => {
  // Part A: Week 0 grade unlinks mid-refresh before Week 0 baseline commits -> Week 1 deviations must not
  // commit against the phantom Week 0 baseline ID.
  const storeA = await gradedStore([{ account: "one", grades: 40, weeks: 2 }]);
  purgeInsideOutPerson(storeA.path, "nobody");
  const exec = DatabaseSync.prototype.exec;
  let racedA = false;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && !racedA) {
      racedA = true;
      const writer = new DatabaseSync(storeA.path);
      try {
        writer.prepare("UPDATE inside_out SET person_id=NULL WHERE interaction_id='one-0'").run();
      } finally { writer.close(); }
    }
    return exec.call(this, sql);
  });
  const firstA = refreshWithFingerprint(storeA.path, { now: storeA.now, link: false });
  assert.equal(racedA, true);
  assert.equal(firstA.result.snapshots, 0);
  assert.equal(firstA.fingerprint, undefined);
  const dbA = new DatabaseSync(storeA.path);
  t.after(() => dbA.close());
  assert.equal(dbA.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(storeA.ids[0]!)?.n, 0);
  assert.equal(
    dbA.prepare("SELECT count(*) n FROM inside_out_deviations WHERE person_id=? AND baseline_id IS NOT NULL").get(storeA.ids[0]!)?.n,
    0,
    "week-2 deviations must never commit against a phantom week-1 baseline",
  );
  // Follow-up refresh builds the real Week 0 baseline (19 grades) and assesses Week 1 against it.
  const secondA = refreshWithFingerprint(storeA.path, { now: storeA.now, link: false, unless: firstA.fingerprint });
  assert.equal(secondA.result.snapshots, 2);
  const week0BaselineA = dbA.prepare("SELECT id FROM person_emotion_baselines WHERE person_id=? AND week_start=?").get(storeA.ids[0]!, FIRST_WEEK)!;
  const week1DevsA = dbA.prepare("SELECT baseline_id,result_json FROM inside_out_deviations WHERE person_id=? AND interaction_id='one-20'").all(storeA.ids[0]!);
  assert.equal(week1DevsA.length, 1);
  assert.equal(week1DevsA[0]!.baseline_id, week0BaselineA.id);
  assert.equal(JSON.parse(String(week1DevsA[0]!.result_json)).cumulative.count, 19);

  // Part B: Week 0 baseline already exists; a new Week 1 grade arrives while a Week 0 grade changes mid-refresh ->
  // Week 1 deviation must not commit against the stale replaced Week 0 baseline ID.
  const storeB = await gradedStore([{ account: "one", grades: 20, weeks: 1 }]);
  const nowB = FIRST_WEEK + 2 * WEEK + 86400_000;
  refreshInsideOutBaselines(storeB.path, { now: nowB, link: false });
  const dbB = new DatabaseSync(storeB.path);
  t.after(() => dbB.close());
  const oldWeek0Id = String(dbB.prepare("SELECT id FROM person_emotion_baselines WHERE person_id=? AND week_start=?").get(storeB.ids[0]!, FIRST_WEEK)!.id);
  dbB.prepare(`INSERT INTO inside_out (interaction_id,rubric,session_id,message_id,assistant_id,human_key,sender_id,
    channel,source,target_at,reviewed_at,model,context_trimmed,${EMOTIONS.join(",")},error,person_id)
    VALUES (${Array(21).fill("?").join(",")})`)
    .run("w1-target", "emotion-presence-v2", "s", "w1-target", "a", JSON.stringify(["slack", "one", "u"]), "u",
      "slack", "s.jsonl", FIRST_WEEK + WEEK + 1000, FIRST_WEEK + WEEK + 1000, "jev-test", 0, ...EMOTIONS.map(() => 0.8), null, storeB.ids[0]!);
  let racedB = false;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && !racedB) {
      racedB = true;
      const writer = new DatabaseSync(storeB.path);
      try {
        writer.prepare("UPDATE inside_out SET reviewed_at=reviewed_at+1, joy=0.1 WHERE interaction_id='one-0'").run();
      } finally { writer.close(); }
    }
    return exec.call(this, sql);
  });
  const firstB = refreshWithFingerprint(storeB.path, { now: nowB, link: false });
  assert.equal(racedB, true);
  assert.equal(firstB.fingerprint, undefined);
  assert.equal(
    dbB.prepare("SELECT count(*) n FROM inside_out_deviations WHERE interaction_id='w1-target'").get()?.n,
    0,
    "week-2 deviation must not commit against a stale week-1 baseline after week-1 mutates",
  );
  const secondB = refreshWithFingerprint(storeB.path, { now: nowB, link: false, unless: firstB.fingerprint });
  assert.equal(typeof secondB.fingerprint, "string");
  const newWeek0Id = String(dbB.prepare("SELECT id FROM person_emotion_baselines WHERE person_id=? AND week_start=?").get(storeB.ids[0]!, FIRST_WEEK)!.id);
  assert.notEqual(newWeek0Id, oldWeek0Id);
  const targetDevs = dbB.prepare("SELECT baseline_id FROM inside_out_deviations WHERE interaction_id='w1-target'").all();
  assert.equal(targetDevs.length, 1);
  assert.equal(targetDevs[0]!.baseline_id, newWeek0Id, "follow-up refresh assesses week-2 against the updated week-1 baseline");
});

test("analytics-only purge between pre-pass snapshot and refreshEmotionBaselines is fenced out", async t => {
  // Part A: refreshWithFingerprint (no `unless`) — purge commits immediately after pre-pass readSnapshot COMMIT,
  // before refreshEmotionBaselines starts.
  const storeA = await gradedStore([
    { account: "one", grades: 40, weeks: 2 },
    { account: "two", grades: 40, weeks: 2 },
  ]);
  const [oneA, twoA] = storeA.ids;
  // Seed existing baselines so the analytics-only purge actually deletes rows and bumps generation.
  assert.deepEqual(refreshInsideOutBaselines(storeA.path, { now: storeA.now, link: false }), { snapshots: 4, comparisons: 80 });

  const exec = DatabaseSync.prototype.exec;
  let racedA = false;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    const out = exec.call(this, sql);
    if (sql === "COMMIT" && !racedA) {
      racedA = true;
      const purged = purgeInsideOutPerson(storeA.path, oneA!);
      assert.deepEqual(purged, { baselines: 2, assessments: 40, grades: 0 });
    }
    return out;
  });

  const outcomeA = refreshWithFingerprint(storeA.path, { now: storeA.now, link: false });
  assert.equal(racedA, true);
  assert.equal(outcomeA.fingerprint, undefined, "purge between pre-pass snapshot and refresh invalidates certification");
  assert.deepEqual(outcomeA.result, { snapshots: 0, comparisons: 0 });
  const checkA = new DatabaseSync(storeA.path);
  t.after(() => checkA.close());
  assert.equal(checkA.prepare("SELECT count(*) n FROM inside_out WHERE person_id=?").get(oneA!)?.n, 40, "raw grades remain");
  assert.equal(checkA.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(oneA!)?.n, 0,
    "purged baselines must not be recreated");
  assert.equal(checkA.prepare("SELECT count(*) n FROM inside_out_deviations WHERE person_id=?").get(oneA!)?.n, 0,
    "purged deviations must not be recreated");
  assert.equal(checkA.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(twoA!)?.n, 2);

  // Part B: refreshWithFingerprint (with stale `unless` using baselineFingerprints) — same pre-pass race window.
  const storeB = await gradedStore([
    { account: "one", grades: 40, weeks: 2 },
    { account: "two", grades: 40, weeks: 2 },
  ]);
  const [oneB, twoB] = storeB.ids;
  let racedB = false;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    const out = exec.call(this, sql);
    if (sql === "COMMIT" && !racedB) {
      racedB = true;
      purgeInsideOutPerson(storeB.path, oneB!);
    }
    return out;
  });
  const outcomeB = refreshWithFingerprint(storeB.path, { now: storeB.now, link: false, unless: "stale-fingerprint" });
  assert.equal(racedB, true);
  assert.equal(outcomeB.fingerprint, undefined);
  assert.deepEqual(outcomeB.result, { snapshots: 2, comparisons: 40 }, "only untouched person commits");
  const checkB = new DatabaseSync(storeB.path);
  t.after(() => checkB.close());
  assert.equal(checkB.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(oneB!)?.n, 0);
  assert.equal(checkB.prepare("SELECT count(*) n FROM inside_out_deviations WHERE person_id=?").get(oneB!)?.n, 0);
  assert.equal(checkB.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(twoB!)?.n, 2);
  assert.equal(checkB.prepare("SELECT count(*) n FROM inside_out_deviations WHERE person_id=?").get(twoB!)?.n, 40);

  // Part C: direct baselineInputSnapshot -> concurrent purge on second connection -> refreshEmotionBaselines(..., { expectedGenerations }).
  const storeC = await gradedStore([
    { account: "one", grades: 40, weeks: 2 },
    { account: "two", grades: 40, weeks: 2 },
  ]);
  const [oneC, twoC] = storeC.ids;
  const dbC = openInsideOutStore(storeC.path);
  t.after(() => dbC.close());
  const snapshotC = baselineInputSnapshot(dbC, { minInteractions: 20, now: storeC.now });
  purgeInsideOutPerson(storeC.path, oneC!);
  const direct = refreshEmotionBaselines(dbC, {
    minInteractions: 20,
    now: storeC.now,
    expectedGenerations: snapshotC.personGenerations,
  });
  assert.deepEqual(direct, { snapshots: 2, comparisons: 40 });
  assert.equal(dbC.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(oneC!)?.n, 0);
  assert.equal(dbC.prepare("SELECT count(*) n FROM inside_out_deviations WHERE person_id=?").get(oneC!)?.n, 0);
  assert.equal(dbC.prepare("SELECT count(*) n FROM person_emotion_baselines WHERE person_id=?").get(twoC!)?.n, 2);
  assert.equal(dbC.prepare("SELECT count(*) n FROM inside_out_deviations WHERE person_id=?").get(twoC!)?.n, 40);
});
