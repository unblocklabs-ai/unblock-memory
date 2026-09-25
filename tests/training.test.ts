import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "../src/config.js";
import { registerUnblockMemory } from "../src/plugin.js";
import { trainingExamples, TrainingTranscriptReader } from "../src/training-input.js";
import { TrainingStore } from "../src/training-store.js";
import { collectTraining, runTraining } from "../src/training.js";
import { judgeTrainingInput } from "../src/training-gate.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

const config = resolveConfig({ typesafe: { apiKey: "private-test-key" } });
const user = (content: string, extra = {}) => ({ role: "user", content,
  __openclaw: { senderId: "human", senderIdentity: { senderKind: "human" } }, ...extra });
const assistant = (content: string, extra = {}) => ({ role: "assistant", content, stopReason: "stop", ...extra });
const rows = (messages: unknown[]) => messages.map((message, i) => ({ seq: i + 1, createdAt: 10_000 + i,
  eventJson: JSON.stringify({ type: "message", message }) }));
const payload = (probability: number) => ({ model: "jev-1.13.0", answers: { recall_needed: { type: "noul", noul: probability } },
  usage: { input_tokens: 123, output_tokens: 20 } });
const bounds = { maxExamples: 100, maxInputBytes: 3_000_000 };
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "memory-training-"));
  const source = { databasePath: join(root, "agent.sqlite"), agentId: "main" };
  const db = createAgentDatabase(source.databasePath);
  const storePath = join(root, "training.sqlite"), store = new TrainingStore(storePath, "main");
  const append = (sessionId: string, messages: unknown[]) => {
    const offset = Number(db.prepare("SELECT COALESCE(MAX(seq),0) n FROM transcript_events WHERE session_id=?").get(sessionId)!.n);
    for (const row of rows(messages)) {
      db.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run(sessionId, offset + row.seq, row.eventJson, offset + row.createdAt);
      db.prepare("INSERT INTO session_transcript_active_events VALUES (?,?,?,?)").run(sessionId, offset + row.seq, offset + row.seq, offset + row.seq);
    }
  };
  const add = (id: string, messages: unknown[]) => { insertSession(db, { sessionId: id, chatType: "direct" }); append(id, messages); };
  t.after(() => { db.close(); store.close(); });
  return { root, source, db, store, storePath, append, add };
}

test("inputs never contain the following answer, thinking, tools or injected user envelopes", () => {
  const result = trainingExamples(rows([
    user("Earlier question"), assistant("Earlier answer"), user("What did we decide?"),
    { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE THOUGHT" }, { type: "toolCall", name: "memory_search" }] },
    { role: "toolResult", content: "PRIVATE TOOL" }, assistant("FUTURE ANSWER"),
  ]));
  assert.equal(result.examples.length, 2);
  assert.deepEqual(result.examples[1]!.input, { currentRequest: "What did we decide?", history: [
    { role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" },
  ] });
  assert.doesNotMatch(JSON.stringify(result.examples), /FUTURE|PRIVATE/);
  const envelope = user("SYSTEM WRAPPER", { __openclaw: { senderId: "owner", senderIsOwner: true, upstreamUserText: "Actual user text" } });
  assert.equal(trainingExamples(rows([envelope, assistant("Answer")])).examples[0]!.input.currentRequest, "Actual user text");
});

test("internal messages, explicit bots and compaction remain context boundaries", () => {
  for (const bad of [user("bot", { __openclaw: { senderId: "bot", senderIsOwner: true, senderIdentity: { senderKind: "bot" } } }),
    user("internal", { provenance: { kind: "internal_system" } })]) {
    const result = trainingExamples(rows([user("Do not bridge"), bad, user("Fresh"), assistant("Answer")]));
    assert.deepEqual(result.examples.at(-1)!.input.history, []);
  }
  const withCompaction = [...rows([user("Old"), assistant("Old answer")]),
    { seq: 3, createdAt: 10003, eventJson: JSON.stringify({ type: "compaction", summary: "PRIVATE" }) },
    ...rows([user("New"), assistant("New answer")]).map(r => ({ ...r, seq: r.seq + 3 }))];
  assert.deepEqual(trainingExamples(withCompaction).examples.at(-1)!.input.history, []);
  const consecutive = trainingExamples(rows([user("A"), user("B"), assistant("B answer"), user("Unanswered")]));
  assert.equal(consecutive.examples.length, 1);
  assert.equal(consecutive.examples[0]!.seq, 2);
  assert.equal(consecutive.coverage.unanswered, 2);
});

test("ordinary users need no identity enrichment; each reply or tool action yields one input", () => {
  const sequence = Array.from({ length: 10 }, (_, i) => [
    user(`Question ${i}`, { __openclaw: i % 2 ? { senderIsOwner: false, senderIdentity: { senderKind: "unknown" } } : {} }),
    { role: "assistant", channel: "analysis", content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "toolCall", name: "search" }] },
    { role: "toolResult", content: "PRIVATE TOOL" },
    assistant(`Answer ${i}`, { __openclaw: { turnTainted: true } }),
    assistant(`Answer ${i}`, { provider: "openclaw", model: "delivery-mirror" }),
  ]).flat();
  const result = trainingExamples(rows(sequence));
  assert.equal(result.examples.length, 10);
  assert.equal(result.examples[9]!.input.history.length, 18);
  assert.doesNotMatch(JSON.stringify(result.examples), /PRIVATE/);
  assert.deepEqual(result.examples[0]!.input, { history: [], currentRequest: "Question 0" });
});

test("legacy envelopes are normalized and real mirrors qualify without admitting silent or suppressed replies", () => {
  const envelope = 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"sender":{"id":"legacy","name":"Bek"}}\n```\n' +
    'System: [date] Slack message in channel from Bek\n\nActual request';
  const dmEnvelope = envelope.replace("Slack message in channel", "Slack DM");
  for (const raw of ["From: Bek (legacy)\nActual request", envelope, dmEnvelope]) {
    const result = trainingExamples(rows([user(raw, { __openclaw: {} }),
      assistant("Delivered", { provider: "openclaw", model: "delivery-mirror" }), assistant("Delivered"),
      user("Next"), assistant("Answer")]));
    assert.equal(result.examples[0]!.input.currentRequest, "Actual request");
    assert.deepEqual(result.examples[1]!.input.history, [
      { role: "user", content: "Actual request" }, { role: "assistant", content: "Delivered" },
    ]);
  }
  assert.equal(trainingExamples(rows([user(envelope), assistant("Answer")])).examples.length, 0); // Conflicting sender.
  for (const reply of [assistant("NO_REPLY"), assistant("HEARTBEAT_OK"), assistant("Failed", { stopReason: "error" }),
    assistant("Aborted", { stopReason: "aborted" }), assistant("Hidden", { provider: "openclaw", model: "gateway-injected" }),
    assistant("Suppressed", { provider: "openclaw", model: "delivery-mirror", openclawDeliveryMirror: { kind: "channel-final-suppressed" } })]) {
    assert.equal(trainingExamples(rows([user("Question"), reply])).examples.length, 0);
    const retried = trainingExamples(rows([user("Earlier"), assistant("Earlier answer"), user("Question"), reply, assistant("Actual answer")]));
    assert.equal(retried.examples.length, 2);
    assert.equal(retried.examples[1]!.input.history.length, 2);
  }
});

test("input bounds preserve whole messages and skip oversized latest requests rather than silently slicing", () => {
  const sequence = Array.from({ length: 40 }, (_, i) => [user(`Question ${i} ${"字".repeat(1000)}`), assistant(`Answer ${i}`)]).flat();
  const result = trainingExamples(rows(sequence));
  const last = result.examples.at(-1)!;
  assert.ok(Buffer.byteLength(JSON.stringify(last.input)) <= 24000);
  assert.equal(last.contextLimited, true);
  assert.equal(last.input.currentRequest, `Question 39 ${"字".repeat(1000)}`);
  assert.equal(trainingExamples(rows([user("x".repeat(24001)), assistant("Answer")])).coverage.oversized, 1);
  assert.equal(trainingExamples(rows(sequence)).examples[0]!.inputHash, result.examples[0]!.inputHash);
});

test("read-only extraction excludes cron sessions and inactive branches; dry collection creates no store", t => {
  const f = fixture(t);
  f.add("real", [user("Real"), assistant("Answer")]);
  f.add("cron", [user("Cron"), assistant("Answer")]);
  f.db.prepare("UPDATE session_windows SET session_key='agent:main:cron:job' WHERE session_id='cron'").run();
  f.append("real", [user("Retracted"), assistant("Answer")]);
  f.db.prepare("DELETE FROM session_transcript_active_events WHERE session_id='real' AND event_seq>2").run();
  const reader = new TrainingTranscriptReader(f.source.databasePath, "main");
  try {
    assert.equal(reader.read("cron"), null);
    const result = reader.read("real");
    assert.ok(result && "examples" in result);
    assert.equal(result.examples.length, 1);
  } finally { reader.close(); }
  const beforeFiles = f.store.status(0.7);
  const result = collectTraining(f.source);
  assert.equal(result.eligible, 1);
  assert.equal(result.excludedSessions, 1);
  assert.deepEqual(f.store.status(0.7), beforeFiles);
});

test("positives, negatives and identical inputs across sessions are cached; repeats spend zero tokens", async t => {
  const f = fixture(t);
  f.add("s", [user("Recall"), assistant("Answer"), user("Thanks"), assistant("Welcome")]);
  f.add("mirror", [user("Recall"), assistant("Other answer")]);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    assert.doesNotMatch(JSON.stringify(body.state), /Welcome|Other answer/);
    return new Response(JSON.stringify(payload(body.state.currentRequest === "Thanks" ? 0.05 : 0.9)));
  });
  await f.store.locked(async () => {
    assert.equal(collectTraining(f.source, f.store).added, 3);
    const first = await runTraining(f.source, f.store, config, bounds);
    assert.equal(first.calls, 2);
    assert.equal(first.inputTokens, 246);
    assert.equal(collectTraining(f.source, f.store).unchanged, 3);
    assert.equal((await runTraining(f.source, f.store, resolveConfig({ typesafe: { enabled: false } }), bounds)).calls, 0);
    assert.equal(f.store.status(0.7).positive, 1);
    assert.equal(f.store.status(0.99).positive, 0);
    const exported = [...f.store.exportRows(0.7)];
    assert.equal(exported.length, 2);
    assert.equal(exported.find(e => e.input.currentRequest === "Recall")!.sources.length, 2);
    assert.ok(exported.every(e => e.stage === "recall-gate" && !("target" in e)));
  });
  assert.equal(calls, 2);
  assert.equal(statSync(f.storePath).mode & 0o777, 0o600);
});

test("appends preserve previous gates; edits invalidate only affected inputs; removed branches retire", async t => {
  const f = fixture(t);
  f.add("s", [user("First"), assistant("Original answer"), user("Second"), assistant("Second answer")]);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload(0.8))));
  await f.store.locked(async () => {
    collectTraining(f.source, f.store);
    await runTraining(f.source, f.store, config, bounds);
    f.append("s", [user("Third"), assistant("Third answer")]);
    assert.deepEqual(collectTraining(f.source, f.store), { sessions: 1, excludedSessions: 0, oversizedSessions: 0, eligible: 3,
      users: 3, filtered: 0, oversized: 0, unanswered: 0, added: 1, changed: 0, unchanged: 2, retired: 0 });
    assert.equal((await runTraining(f.source, f.store, config, bounds)).calls, 1);
    f.db.prepare("UPDATE transcript_events SET event_json=? WHERE session_id='s' AND seq=4")
      .run(JSON.stringify({ type: "message", message: assistant("Edited second answer") }));
    assert.equal(collectTraining(f.source, f.store).changed, 1);
    assert.equal((await runTraining(f.source, f.store, config, bounds)).calls, 1);
    f.db.prepare("DELETE FROM session_transcript_active_events WHERE session_id='s' AND event_seq>2").run();
    assert.equal(collectTraining(f.source, f.store).retired, 2);
    assert.equal([...f.store.exportRows(0.7)].length, 1);
    f.db.prepare("DELETE FROM session_windows WHERE session_id='s'").run();
    assert.equal(collectTraining(f.source, f.store).retired, 1);
  });
});

test("run refreshes changed or deleted sources before inference and never expands the collected cohort", async t => {
  const f = fixture(t);
  f.add("s", [user("Retracted"), assistant("Answer")]);
  await f.store.locked(async () => {
    collectTraining(f.source, f.store);
    f.db.prepare("DELETE FROM session_transcript_active_events WHERE session_id='s'").run();
    f.append("s", [user("Uncollected"), assistant("Answer")]);
    t.mock.method(globalThis, "fetch", () => { throw new Error("Must not request"); });
    assert.equal((await runTraining(f.source, f.store, config, bounds)).calls, 0);
  });
});

test("concurrent runs are excluded; interrupted requests stay ambiguous until explicit retry", async t => {
  const f = fixture(t), other = new TrainingStore(f.storePath, "main");
  t.after(() => other.close());
  f.add("s", [user("Recall"), assistant("Answer")]);
  await f.store.locked(async () => {
    collectTraining(f.source, f.store);
    await assert.rejects(other.locked(() => assert.fail("Entered concurrently")), /Another memory-training/);
    assert.equal(other.status(0.7).complete, 0); // Monitoring does not need the writer lease.
    f.store.start(f.store.pending(1)[0]!.id); // Crash after commit, before saving provider response.
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(JSON.stringify(payload(0.9))); });
  await other.locked(async () => {
    assert.equal(other.retry(false), 0);
    assert.equal((await runTraining(f.source, other, config, bounds)).calls, 0);
    assert.equal(other.retry(true), 1);
    assert.equal((await runTraining(f.source, other, config, bounds)).calls, 1);
  });
  assert.equal(calls, 1);
});

test("ambiguous transport failures are not silently retried; errors cannot leak credentials", async t => {
  const f = fixture(t);
  f.add("s", [user("Question"), assistant("Answer")]);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private-test-key provider body"); });
  await f.store.locked(async () => {
    collectTraining(f.source, f.store);
    const result = await runTraining(f.source, f.store, config, bounds);
    assert.equal(result.ambiguous, 1);
    assert.equal((await runTraining(f.source, f.store, config, bounds)).calls, 0);
    assert.doesNotMatch(JSON.stringify(f.store.status(0.7)), /private-test-key|provider body/);
    assert.equal(f.store.retry(false), 0);
  });
  const db = new DatabaseSync(f.storePath, { readOnly: true });
  try { assert.equal(db.prepare("SELECT error FROM training_gates").get()!.error, "request_or_response_uncertain"); }
  finally { db.close(); }
});

test("paid calls and serialized input have hard bounds; dry run and missing key do not attempt requests", async t => {
  const f = fixture(t);
  f.add("s", [user("One"), assistant("Answer"), user("Two"), assistant("Answer")]);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload(0.1))));
  await f.store.locked(async () => {
    collectTraining(f.source, f.store);
    assert.equal((await runTraining(f.source, f.store, config, { ...bounds, maxInputBytes: 1 })).calls, 0);
    assert.equal((await runTraining(f.source, f.store, config, { ...bounds, dryRun: true })).calls, 0);
    assert.equal((await runTraining(f.source, f.store, config, { ...bounds, maxExamples: 1 })).calls, 1);
    await assert.rejects(runTraining(f.source, f.store, config, { ...bounds, maxExamples: NaN }), /Invalid training/);
    await assert.rejects(runTraining(f.source, f.store, resolveConfig({ typesafe: { enabled: false } }), bounds), /credential/);
    assert.equal(f.store.pending(100).length, 1);
  });
});

test("gate requires a valid probability, actual model and usage; HTTP rejection is retryable only explicitly", async t => {
  const f = fixture(t);
  f.add("s", [user("One"), assistant("Answer")]);
  const mocked = t.mock.method(globalThis, "fetch", async () => new Response("secret body", { status: 401 }));
  await f.store.locked(async () => {
    collectTraining(f.source, f.store);
    assert.equal((await runTraining(f.source, f.store, config, bounds)).failed, 1);
    assert.equal((await runTraining(f.source, f.store, config, bounds)).calls, 0);
    assert.equal(f.store.retry(false), 1);
  });
  for (const bad of [{ ...payload(0.9), usage: undefined }, payload(2), { ...payload(0.5), model: undefined }]) {
    mocked.mock.mockImplementation(async () => new Response(JSON.stringify(bad)));
    await assert.rejects(judgeTrainingInput({ history: [], currentRequest: "Question" }, "key", AbortSignal.timeout(1000)), /Invalid training gate/);
  }
});

test("omitting the count limit processes more than 100 inputs; optional caps still validate and completed inputs stay cached", async t => {
  const f = fixture(t);
  for (let i = 0; i < 125; i++) f.add(`s-${i}`, [user(`Question ${i}`), assistant("Answer")]);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(JSON.stringify(payload(0.1))); });
  await f.store.locked(async () => {
    collectTraining(f.source, f.store);
    // No arbitrary upper bound on an explicitly supplied positive count, either.
    assert.equal((await runTraining(f.source, f.store, config, { ...bounds, maxExamples: 10001, dryRun: true })).pendingSelected, 125);
    for (const maxExamples of [0, -1, 1.5, NaN, Infinity]) {
      await assert.rejects(runTraining(f.source, f.store, config, { ...bounds, maxExamples }), /Invalid training/);
    }
    const result = await runTraining(f.source, f.store, config, { maxInputBytes: bounds.maxInputBytes });
    assert.equal(result.calls, 125);
    assert.equal(result.completed, 125);
    assert.equal(result.budgetLimited, false);
    assert.equal((await runTraining(f.source, f.store, config, { maxInputBytes: bounds.maxInputBytes })).calls, 0);
  });
  assert.equal(calls, 125);
});

test("memory-training is discoverable in CLI metadata mode without runtime registrations", () => {
  const commands: string[] = [];
  const api = { registrationMode: "cli-metadata", pluginConfig: {},
    registerCli(_register: unknown, options: { descriptors: { name: string }[] }) {
      commands.push(...options.descriptors.map(d => d.name));
    },
    on() { assert.fail("No hooks in metadata mode"); },
    registerTool() { assert.fail("No tools in metadata mode"); },
  } as unknown as OpenClawPluginApi;
  registerUnblockMemory(api);
  assert.ok(commands.includes("memory-training"));
});

test("date bounds use user-event timestamps; narrowing collection preserves previously collected sources", async t => {
  const f = fixture(t);
  f.add("s", [user("First"), assistant("Answer"), user("Second"), assistant("Answer")]);
  await f.store.locked(() => {
    assert.equal(collectTraining(f.source, f.store, { since: 10002, until: 10003 }).added, 1);
    assert.equal(collectTraining(f.source, f.store, { since: 10000, until: 10001 }).added, 1);
    assert.equal(f.store.pending(100).length, 2);
  });
});

test("schema 19 lineage excludes spawned/hook sessions and oversized sessions suspend, not delete, examples", async t => {
  const f = fixture(t);
  f.db.exec(`PRAGMA user_version=19; UPDATE schema_meta SET schema_version=19;
    ALTER TABLE session_windows ADD COLUMN parent_session_key TEXT;
    ALTER TABLE session_windows ADD COLUMN spawned_by TEXT;
    ALTER TABLE session_windows ADD COLUMN plugin_owner_id TEXT;
    ALTER TABLE session_windows ADD COLUMN hook_external_content_source TEXT;`);
  // Existing helper uses positional inserts, so create this evolved-schema row explicitly.
  f.db.prepare("INSERT INTO session_windows (session_id,session_key,chat_type) VALUES ('s','agent:main:slack:direct:user','direct')").run();
  f.append("s", [user("Question"), assistant("Answer")]);
  await f.store.locked(() => {
    assert.equal(collectTraining(f.source, f.store).added, 1);
    const original = f.db.prepare("SELECT event_json FROM transcript_events WHERE session_id='s' AND seq=2").get()!.event_json;
    f.db.prepare("UPDATE transcript_events SET event_json=? WHERE session_id='s' AND seq=2").run(" ".repeat(32_000_001));
    assert.equal(collectTraining(f.source, f.store).oversizedSessions, 1);
    assert.equal(f.store.pending(100).length, 0);
    assert.deepEqual(f.store.status(0.7).examples.map(row => ({ ...row })), [{ active: -1, count: 1 }]);
    f.db.prepare("UPDATE transcript_events SET event_json=? WHERE session_id='s' AND seq=2").run(original);
    assert.equal(collectTraining(f.source, f.store).changed, 1);
    assert.equal(f.store.pending(100).length, 1);
    f.db.prepare("UPDATE session_windows SET spawned_by='agent:main:parent' WHERE session_id='s'").run();
    assert.equal(collectTraining(f.source, f.store).retired, 1);
  });
});

test("expired leases fence old writers and preserve interrupted attempts for explicit recovery", async t => {
  const f = fixture(t), other = new TrainingStore(f.storePath, "main");
  t.after(() => other.close());
  f.add("s", [user("Question"), assistant("Answer")]);
  await f.store.locked(async () => {
    collectTraining(f.source, f.store);
    const job = f.store.pending(1)[0]!;
    const attempt = f.store.start(job.id);
    const external = new DatabaseSync(f.storePath);
    try { external.exec("UPDATE training_lock SET expires=0"); } finally { external.close(); }
    await other.locked(() => {
      assert.throws(() => f.store.finish(job.id, attempt, { probability: 0.9, model: "jev-1.13.0", usage: { input_tokens: 123, output_tokens: 20 } }), /lease lost/);
      assert.equal(other.pending(1).length, 0);
      assert.equal(other.retry(false), 0);
      assert.equal(other.retry(true), 1);
    });
    assert.throws(() => f.store.renew(), /lease lost/);
  });
});

test("existing training databases gain indexed, live exclusion lookups without changing checkpoints", async t => {
  const f = fixture(t), db = new DatabaseSync(f.storePath);
  t.after(() => db.close());
  // Simulate a pre-index database, including non-exclusions with similar JSON.
  db.exec("DROP INDEX training_judgment_exclusions");
  const insert = db.prepare("INSERT INTO training_steps (id,stage,status,request_json,result_json) VALUES (?,?,?,?,?)");
  for (const [id, stage, status, result] of [
    ["old", "judge", "complete", { excluded: true, reason: "operator-exclusion" }],
    ["failed", "judge", "failed", { excluded: true }],
    ["ordinary", "judge", "complete", { usefulness: 1 }],
    ["other-stage", "generate", "complete", { excluded: true }],
  ] as const) insert.run(id, stage, status, JSON.stringify({ identity: id }), JSON.stringify(result));
  const before = db.prepare("SELECT * FROM training_steps ORDER BY id").all();
  const reopened = new TrainingStore(f.storePath, "main");
  t.after(() => reopened.close());
  assert.deepEqual(db.prepare("SELECT * FROM training_steps ORDER BY id").all(), before);
  assert.equal(reopened.judgmentExcluded("old"), true);
  for (const identity of ["failed", "ordinary", "other-stage", "missing"]) assert.equal(reopened.judgmentExcluded(identity), false);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM training_steps WHERE stage='judge' AND status='complete'
    AND json_extract(request_json,'$.identity')=? AND json_extract(result_json,'$.excluded')=1 LIMIT 1`).all("old");
  assert.match(plan.map(row => row.detail).join("\n"), /SEARCH training_steps USING INDEX training_judgment_exclusions/);
  await reopened.locked(() => {
    const request = { identity: "new", excluded: true }, step = reopened.step("judge", request);
    const attempt = reopened.startStep("judge", step.id, request);
    assert.equal(reopened.judgmentExcluded("new"), false);
    reopened.finishStep("judge", step.id, attempt, { result: { excluded: true, reason: "operator-exclusion" } });
    assert.equal(reopened.judgmentExcluded("new"), true);
    // An already-open store sees the new exclusion too; there is no stale cache.
    assert.equal(f.store.judgmentExcluded("new"), true);
  });
});
