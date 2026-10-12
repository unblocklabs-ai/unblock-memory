import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveConfig } from "../src/config.js";
import { PeopleStore } from "../src/people-store.js";
import { personalDeviation } from "../src/emotion-baselines.js";
import { runInsideOut, reportInsideOut, refreshInsideOutBaselines, reportInsideOutBaselines } from "../src/inside-out.js";

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
    const request: { state: { target: { text: string } } } = JSON.parse(String(init.body));
    const text = request.state.target.text;
    return Response.json({ model: text.startsWith("model:") ? "other-model" : "jev-test", answers: text === "failed" ? {} : Object.fromEntries(
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
  add("other-model", "one", "model:0.9", firstWeek + 2000);
  add("routine", "one", "0.8", firstWeek + week + 1000);
  add("unusual", "two", "0.8", firstWeek + week + 1000);
  add("less", "one", "0.2", firstWeek + 2 * week + 1000);
  add("unlinked", "unknown", "0.8", now);
  add("missing", "one", "0.8");
  add("future", "one", "0.8", now + 86400_000);
  add("failure", "one", "failed", now);
  const saveTranscript = () => writeFile(join(sessionsDir, "s.jsonl"), events.map(e => JSON.stringify(e)).join("\n"));
  await saveTranscript();
  const config = resolveConfig({ typesafe: { apiKey: "offline", timeoutMs: 1000 },
    insideOut: { enabled: true, intervalMinutes: 0, maxInteractions: 100 } });
  const options = { agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir, storePath: path, config };
  await runInsideOut(options);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const deviation = (messageId: string) => {
    const result = personalDeviation(db, db.prepare("SELECT * FROM inside_out WHERE message_id=?").get(messageId)!);
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
  const initial = snapshots.find(s => s.person_id === expressive && s.model === "jev-test" && s.week_end === firstWeek + week)!;
  assert.equal(initial.weekly.joy.count, 20);
  assert.equal(initial.weekly.joy.p10, 0.8);
  assert.equal(initial.cumulative.joy.mean, 0.8);
  const raw = db.prepare("SELECT * FROM inside_out ORDER BY interaction_id").all();
  const beforeCalls = calls;
  assert.deepEqual(refreshInsideOutBaselines(path), { snapshots: 0, comparisons: 0 });
  assert.deepEqual(db.prepare("SELECT * FROM inside_out ORDER BY interaction_id").all(), raw);
  assert.equal(calls, beforeCalls, "statistics require no inference");
  assert.deepEqual(reportInsideOut(path, { personal: true, personId: restrained }).find(r => r.message_id === "unusual")?.personal_deviation, unusual);

  // A delayed historical reply changes baseline revisions, not the already recorded comparison.
  now += 1000;
  add("late", "one", "0.2", firstWeek - week + 1000);
  await saveTranscript();
  await runInsideOut(options);
  assert.equal(calls, beforeCalls + 1, "backfill grades only the newly discovered reply");
  assert.deepEqual(deviation("routine"), routine);
  assert.deepEqual(reportInsideOutBaselines(path).find(s => s.id === initial.id)?.cumulative, initial.cumulative);
  assert.equal(reportInsideOutBaselines(path).find(s => s.id === initial.id)?.is_current, 0);
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
  assert.ok(reportInsideOutBaselines(path, { personId: expressive }).every(s => s.is_current === 0));
  db.prepare(`INSERT INTO person_identities (${Object.keys(identity).join(",")}) VALUES (${Object.keys(identity).map(() => "?").join(",")})`)
    .run(...Object.values(identity));
  refreshInsideOutBaselines(path, { recompare: true });
  assert.deepEqual(deviation("routine"), restored, "returning identity evidence reuses the current assessment");

  // Daily refreshes retain completed empty weeks, so a historical comparison
  // never substitutes the last populated week for the preceding calendar week.
  now = firstWeek + 5 * week + 86400_000;
  refreshInsideOutBaselines(path);
  const emptyWeek = reportInsideOutBaselines(path, { personId: expressive })
    .find(s => s.model === "jev-test" && s.week_start === firstWeek + 3 * week && s.is_current === 1)!;
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
    return Response.json({ model: "jev-test", answers: Object.fromEntries(
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
