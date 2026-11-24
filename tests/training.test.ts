import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "../src/config.js";
import { registerUnblockMemory } from "../src/plugin.js";
import { trainingExamples, TrainingTranscriptReader } from "../src/training-input.js";
import { TrainingStore } from "../src/training-store.js";
import { writeTrainingExportJsonl } from "../src/training-runtime.js";
import { collectTraining, runTraining } from "../src/training.js";
import { judgeTrainingInput } from "../src/training-gate.js";
import { compressAgentTranscripts, createAgentDatabase, insertSession } from "./helpers/session-database.js";

const config = resolveConfig({ typesafe: { apiKey: "private-test-key" } });
const user = (content: string, extra = {}) => ({ role: "user", content,
  __openclaw: { senderId: "human", senderIdentity: { senderKind: "human" } }, ...extra });
const assistant = (content: string, extra = {}) => ({ role: "assistant", content, stopReason: "stop", ...extra });
const rows = (messages: unknown[]) => messages.map((message, i) => ({ seq: i + 1, createdAt: 10_000 + i,
  eventJson: JSON.stringify({ type: "message", message }) }));
const payload = (probability: number) => ({ model: "liquid/d1.2-ultra-20261116", answers: { recall_needed: { type: "noul", noul: probability } },
  usage: { input_tokens: 123, output_tokens: 0 } });
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
  f.add("oversized", [user("x".repeat(24001)), assistant("Answer")]);
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
  assert.deepEqual(result.review, [{ sessionId: "oversized", seq: 1, reason: "current-request-exceeds-context-budget" }]);
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
    return new Response(JSON.stringify(payload(body.state[0].currentRequest === "Thanks" ? 0.05 : 0.9)));
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
    assert.deepEqual(collectTraining(f.source, f.store), { sessions: 1, excludedSessions: 0, oversizedSessions: 0, unavailableSessions: 0, eligible: 3,
      users: 3, filtered: 0, oversized: 0, unanswered: 0, added: 1, changed: 0, unchanged: 2, retired: 0, review: [] });
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
    const retryIds = other.status(0.7).retryable.map(row => String(row.id));
    assert.equal(other.retry(false, retryIds), 0);
    assert.equal((await runTraining(f.source, other, config, bounds)).calls, 0);
    assert.equal(other.retry(true, retryIds), 1);
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
    assert.equal(f.store.retry(false, f.store.status(0.7).retryable.map(row => String(row.id))), 0);
  });
  const db = new DatabaseSync(f.storePath, { readOnly: true });
  try { assert.equal(db.prepare("SELECT error FROM training_gates").get()!.error, "request_or_response_uncertain"); }
  finally { db.close(); }
});

test("a failed recall input is preserved for review while unrelated inputs continue", async t => {
  const f = fixture(t);
  for (const name of ["One", "Two", "Three"]) f.add(name, [user(name), assistant("Answer")]);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1 ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify(payload(0.9)));
  });
  await f.store.locked(async () => {
    collectTraining(f.source, f.store);
    const result = await runTraining(f.source, f.store, config, { ...bounds, concurrency: 1 });
    assert.equal(result.calls, 3);
    assert.equal(result.completed, 2);
    assert.equal(result.ambiguous, 1);
    assert.equal((await runTraining(f.source, f.store, config, bounds)).calls, 0);
  });
  assert.equal(calls, 3);
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
    assert.equal(f.store.retry(false, f.store.status(0.7).retryable.map(row => String(row.id))), 1);
  });
  for (const bad of [{ ...payload(0.9), usage: undefined }, payload(2), { ...payload(0.5), model: undefined }]) {
    mocked.mock.mockImplementation(async () => new Response(JSON.stringify(bad)));
    await assert.rejects(judgeTrainingInput({ history: [], currentRequest: "Question" }, "key", AbortSignal.timeout(1000)), { code: "invalid_response" });
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
    compressAgentTranscripts(f.db);
    assert.equal(collectTraining(f.source, f.store).unchanged, 1);
    f.db.prepare("INSERT INTO session_transcript_cold_archives VALUES ('s')").run();
    assert.equal(collectTraining(f.source, f.store).unavailableSessions, 1);
    assert.equal(f.store.pending(100).length, 0);
    assert.deepEqual(f.store.status(0.7).examples.map(row => ({ ...row })), [{ active: -1, count: 1 }]);
    f.db.exec("DELETE FROM session_transcript_cold_archives");
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
      assert.throws(() => f.store.finish(job.id, attempt, { probability: 0.9, model: "liquid/d1.2-ultra-20261116", usage: { input_tokens: 123, output_tokens: 0 } }), /lease lost/);
      assert.equal(other.pending(1).length, 0);
      assert.equal(other.retry(false, [job.id]), 0);
      assert.equal(other.retry(true, [job.id]), 1);
    });
    assert.throws(() => f.store.renew(), /lease lost/);
  });
});

test("pre-dispatch 503 Retry-After records failed (retryable without --include-ambiguous) while plain 503 records ambiguous", async t => {
  const f = fixture(t);
  f.add("s", [user("First question"), assistant("A1"), user("Second question"), assistant("A2")]);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1
      ? new Response("busy", { status: 503, headers: { "Retry-After": "1" } })
      : new Response("busy", { status: 503 });
  });
  await f.store.locked(async () => {
    collectTraining(f.source, f.store);
    const result = await runTraining(f.source, f.store, config, { ...bounds, concurrency: 1 });
    assert.equal(result.failed, 1);
    assert.equal(result.ambiguous, 1);
    const retryable = f.store.status(0.7).retryable as { id: string; status: string }[];
    const failedId = retryable.find(item => item.status === "failed")!.id;
    const ambiguousId = retryable.find(item => item.status === "ambiguous")!.id;
    assert.equal(f.store.retry(false, [failedId]), 1);
    assert.equal(f.store.retry(false, [ambiguousId]), 0);
  });
});

test("finish() rejects non-attempted rows, retry() clears completed_at, and lease fencing guards all mutations", async t => {
  const f = fixture(t), other = new TrainingStore(f.storePath, "main");
  const inspect = new DatabaseSync(f.storePath);
  t.after(() => { other.close(); inspect.close(); });
  f.add("s", [user("Question"), assistant("Answer")]);
  await f.store.locked(async () => {
    collectTraining(f.source, f.store);
    const job = f.store.pending(1)[0]!;
    // Reject finishing a pending gate row before start().
    assert.throws(
      () => f.store.finish(job.id, 999, { probability: 0.8, model: "liquid/d1.2-ultra-20261116", usage: { input_tokens: 10, output_tokens: 0 } }),
      /gate attempt lost/,
    );
    const attempt = f.store.start(job.id);
    // Reject finishing with a mismatched attempt ID and roll back the gate row to attempted.
    assert.throws(
      () => f.store.finish(job.id, attempt + 999, { probability: 0.8, model: "liquid/d1.2-ultra-20261116", usage: { input_tokens: 10, output_tokens: 0 } }),
      /Training attempt lost/,
    );
    assert.equal(inspect.prepare("SELECT status FROM training_gates WHERE id=?").get(job.id)!.status, "attempted");
    // Fail the attempt, verify completed_at is set, then retry() clears completed_at.
    f.store.finish(job.id, attempt, { status: "failed", error: "http_400" });
    assert.ok(inspect.prepare("SELECT completed_at FROM training_gates WHERE id=?").get(job.id)!.completed_at !== null);
    assert.throws(
      () => f.store.finish(job.id, attempt, { probability: 0.8, model: "liquid/d1.2-ultra-20261116", usage: { input_tokens: 10, output_tokens: 0 } }),
      /gate attempt lost/,
    );
    assert.equal(f.store.retry(false, [job.id]), 1);
    assert.equal(inspect.prepare("SELECT completed_at FROM training_gates WHERE id=?").get(job.id)!.completed_at, null);

    // Also verify retry() clears completed_at on training_steps.
    const step = f.store.step("retrieve", { query: "q", lane: "lex" });
    const stepAttempt = f.store.startStep(step.stage, step.id, step.request);
    f.store.finishStep(step.stage, step.id, stepAttempt, { status: "failed", error: "historical_corpus_unavailable" });
    assert.ok(inspect.prepare("SELECT completed_at FROM training_steps WHERE id=?").get(step.id)!.completed_at !== null);
    assert.equal(f.store.retry(false, [step.id]), 1);
    assert.equal(inspect.prepare("SELECT completed_at FROM training_steps WHERE id=?").get(step.id)!.completed_at, null);

    // Finish gate so we have an active query example for review/saveStep lease tests.
    const a2 = f.store.start(job.id);
    f.store.finish(job.id, a2, { probability: 0.9, model: "liquid/d1.2-ultra-20261116", usage: { input_tokens: 10, output_tokens: 0 } });
    const [example] = f.store.queryExamples(0.7);
    assert.ok(example);

    // Expire lease and take over from another store -> all fenced mutations must reject.
    inspect.exec("UPDATE training_lock SET expires=0");
    await other.locked(() => {
      assert.throws(() => f.store.unavailable("s"), /lease lost/);
      assert.throws(() => f.store.retry(false, [job.id]), /lease lost/);
      assert.throws(() => f.store.flagReview(example, "evaluation-unresolved", { steps: [step.id] }), /lease lost/);
      assert.throws(() => f.store.clearReview(example.id), /lease lost/);
      const scoreStep = f.store.step("score", { query: "q", lane: "lex" });
      assert.throws(
        () => f.store.saveStep("score", scoreStep.id, scoreStep.request, {
          query: "q", lane: "lex", round: 1, retrievalId: step.id, score: 0.5, maxProbability: 0.5, judgments: [],
        }),
        /lease lost/,
      );
    });
  });
});

test("saveStep() commits local score/evaluate steps and review clears in one atomic transaction", async t => {
  const f = fixture(t);
  const inspect = new DatabaseSync(f.storePath);
  t.after(() => inspect.close());
  f.add("s", [user("Question"), assistant("Answer")]);
  await f.store.locked(() => {
    collectTraining(f.source, f.store);
    const job = f.store.pending(1)[0]!;
    f.store.finish(job.id, f.store.start(job.id), { probability: 0.9, model: "liquid/d1.2-ultra-20261116", usage: { input_tokens: 10, output_tokens: 0 } });
    const [example] = f.store.queryExamples(0.7);
    assert.ok(example);

    // 1. Deterministic score step commits in one transaction and rejects duplicate save.
    const scoreStep = f.store.step("score", { query: "q", lane: "lex", sourceId: example.id });
    const scoreResult = { query: "q", lane: "lex" as const, round: 1 as const, retrievalId: "r", score: 0.8, maxProbability: 0.8, judgments: [] };
    f.store.saveStep("score", scoreStep.id, scoreStep.request, scoreResult);
    assert.equal(f.store.step("score", { query: "q", lane: "lex", sourceId: example.id }).status, "complete");
    assert.throws(() => f.store.saveStep("score", scoreStep.id, scoreStep.request, scoreResult), /not pending/);

    // 2. If clearReview fails inside saveStep("evaluate"), BOTH step write and review delete roll back atomically.
    f.store.flagReview(example, "evaluation-unresolved", { steps: [scoreStep.id] }, "__legacy__");
    const evalStep = f.store.step("evaluate", { sourceId: example.id, corpusHash: "c1" });
    const evalResult = {
      sourceId: example.id, inputHash: example.inputHash, timestamp: example.timestamp, corpusHash: "c1",
      corpusReport: { sessions: 1, chunks: 1, excluded: 0, truncated: 0, excludedChunks: 0 },
      teacherIds: [], queries: [scoreResult], selected: { lex: "q", vec: "q" }, review: [],
    };
    const attemptsBefore = Number(inspect.prepare("SELECT COUNT(*) n FROM training_step_attempts").get()!.n);
    assert.throws(
      () => f.store.saveStep("evaluate", evalStep.id, evalStep.request, evalResult, {
        sourceId: example.id,
        scope: "judge-a",
        matchesLegacyUnresolved: () => { throw new Error("synthetic clear failure"); },
      }),
      /synthetic clear failure/,
    );
    assert.equal(f.store.step("evaluate", { sourceId: example.id, corpusHash: "c1" }).status, "pending");
    assert.equal(Number(inspect.prepare("SELECT COUNT(*) n FROM training_step_attempts").get()!.n), attemptsBefore);
    assert.equal(f.store.reviews().length, 1);

    // 3. Successful saveStep("evaluate") atomically commits completion and clears the matching review.
    f.store.saveStep("evaluate", evalStep.id, evalStep.request, evalResult, {
      sourceId: example.id,
      scope: "judge-a",
      matchesLegacyUnresolved: () => true,
    });
    assert.equal(f.store.step("evaluate", { sourceId: example.id, corpusHash: "c1" }).status, "complete");
    assert.equal(f.store.reviews().length, 0);
  });
});

test("writeTrainingExportJsonl publishes private files atomically without partial outputs or overwrites", () => {
  const dir = mkdtempSync(join(tmpdir(), "training-export-atomic-"));
  const failedOutput = join(dir, "failed.jsonl");
  function* failingRows() {
    yield { row: 1 };
    throw new Error("mid-stream export error");
  }
  assert.throws(() => writeTrainingExportJsonl(failedOutput, failingRows()), /mid-stream export error/);
  assert.equal(existsSync(failedOutput), false);
  assert.deepEqual(readdirSync(dir), []);

  const output = join(dir, "export.jsonl");
  const rows = writeTrainingExportJsonl(output, [{ row: 1 }, { row: 2 }]);
  assert.equal(rows, 2);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(readFileSync(output, "utf8"), '{"row":1}\n{"row":2}\n');
  assert.deepEqual(readdirSync(dir), ["export.jsonl"]);

  assert.throws(
    () => writeTrainingExportJsonl(output, [{ row: 3 }]),
    error => error instanceof Error && "code" in error && error.code === "EEXIST",
  );
  assert.equal(readFileSync(output, "utf8"), '{"row":1}\n{"row":2}\n');
});
