import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveConfig } from "../src/config.js";
import { responseEpisodes, ResponseTranscriptReader } from "../src/response-episodes.js";
import { auditResponses, responseCohort } from "../src/response-audit.js";
import { judgeResponse, judgeResponseFollowup, judgeMemoryOpportunity } from "../src/response-judge.js";
import { responseUserText } from "../src/response-text.js";
import { ResponseAuditStore } from "../src/response-store.js";
import { responseOutcome } from "../src/response-outcome.js";
import { responseMemoryCandidates } from "../src/response-memory.js";
import { resolveSource } from "../src/sources.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";
import { ResponsePeople } from "../src/response-identity.js";

const session = { sessionId: "s", accountId: "workspace", conversationId: "conversation-s", chatType: "direct" };
const config = resolveConfig({ typesafe: { apiKey: "fake-secret", timeoutMs: 1000 },
  responseAudit: { enabled: true, senderIds: ["owner"], intervalMinutes: 0 } });
const user = (text: string, extra: Record<string, unknown> = {}) => ({ role: "user", content: text,
  __openclaw: { senderId: "owner", senderIdentity: { senderKind: "human" }, transport: { channel: "slack", conversationRef: "conversation-s", threadId: "thread" } }, ...extra });
const answer = (text: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content: [{ type: "text", text }], model: "agent-model", stopReason: "stop", ...extra });
const rows = (messages: unknown[]) => messages.map((message, i) => ({ seq: i + 1, createdAt: Date.now() - 10000 + i,
  eventJson: JSON.stringify({ type: "message", message }) }));
const basic = () => rows([user("Give me a brief explanation. Don't edit files."), answer("A brief explanation."), user("Great, now elaborate."), answer("More detail.")]);
const wrapped = (text: string) => 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"sender":{"id":"owner","name":"Bek"},"history_truncated":true}\n```\n\nChat history since last reply: ⟦openclaw:ctx⟧\nPRIVATE EMBEDDED HISTORY\n\nSystem: [2026-09-10 10:26:38 EDT] Slack message in #test from Bek\n\n' + text;
function choice(criteria: Record<string, unknown>, selected?: string) {
  const keys = Object.keys(criteria), key = selected ?? keys[0]!;
  return { type: "choice", choice: key, confidence: 0.95, probabilities: Object.fromEntries(keys.map(k => [k, k === key ? 1 : 0])) };
}
function payload(body: { questions: Record<string, { type: string; criteria?: unknown }> }) {
  return { answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => [key,
    q.type === "choice" ? choice(q.criteria as Record<string, unknown>) :
    q.type === "score" ? { type: "score", score: 3, confidence: 0.95, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 } } :
    { type: "noul", noul: 0.05 },
  ])) };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "response-audit-"));
  const databasePath = join(root, "agent.sqlite"), db = createAgentDatabase(databasePath);
  insertSession(db, { sessionId: "s", chatType: "direct" });
  for (const [i, row] of basic().entries()) {
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("s", row.seq, row.eventJson, row.createdAt);
    db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run("s", i, row.seq, i);
  }
  return { db, options: { agentId: "main", config, databasePath, storePath: join(root, "audit/response.sqlite"), indexPath: join(root, "absent.sqlite"), sources: [] } };
}

test("response audit config is separately opted in and explicitly scopes humans and evidence", () => {
  assert.equal(resolveConfig({}).responseAudit.enabled, false);
  assert.equal(resolveConfig(undefined).responseAudit.enabled, false);
  assert.equal(resolveConfig({}).responseAudit.sentimentEnabled, true);
  for (const responseAudit of [true, { enabled: true }, { senderIds: [" "] }, { chatTypes: [] }, { chatTypes: ["all"] },
    { historyMessages: 21 }, { maxEpisodes: 101 }, { intervalMinutes: -1 }, { sentimentEnabled: "true" },
    { sentimentEnabled: null }, { memoryCorpora: ["sessions"] }, { invented: true }]) {
    assert.throws(() => resolveConfig({ responseAudit }), /responseAudit/);
  }
  assert.notEqual(responseCohort(config.responseAudit), responseCohort({ ...config.responseAudit, historyMessages: 3 }));
  assert.notEqual(responseCohort(config.responseAudit), responseCohort({ ...config.responseAudit, sentimentEnabled: false }));
  assert.equal(responseCohort(config.responseAudit), responseCohort({ ...config.responseAudit, intervalMinutes: 15 }));
});

test("recognized envelopes expose only current human text and preserve ordinary Markdown/JSON", () => {
  assert.deepEqual(responseUserText(wrapped("Current request"), "owner"), { text: "Current request", contextLimited: true });
  const dmWrapped = wrapped("Current request").replace("Slack message in #test", "Slack DM");
  assert.deepEqual(responseUserText(dmWrapped, "owner"), { text: "Current request", contextLimited: true });
  assert.equal(responseUserText(wrapped("Current request"), "stranger"), undefined);
  assert.equal(responseUserText(wrapped("Current request").replace("from Bek", "from Other"), "owner"), undefined);
  assert.equal(responseUserText(wrapped("Current request").replace("```json", "```broken"), "owner"), undefined);
  assert.equal(responseUserText(wrapped("Current request") + "\nSystem: [later] Slack message in #test from Bek\n\nAmbiguous", "owner"), undefined);
  assert.equal(responseUserText(dmWrapped + "\nSystem: [later] Slack message in #test from Bek\n\nAmbiguous", "owner"), undefined);
  const normal = 'Please explain this JSON:\n```json\n{"history_truncated":true}\n```\nDo not delete it.';
  assert.deepEqual(responseUserText(normal, "owner"), { text: normal, contextLimited: false });
  const meta = user("x").__openclaw;
  const input = rows([user("fallback", { __openclaw: { ...meta, upstreamUserText: wrapped("Question") } }),
    answer("Answer"), user(wrapped("Thanks")), answer("Welcome")]);
  const e = responseEpisodes(session, input, config.responseAudit).episodes[0]!;
  assert.equal(e.request[0]!.text, "Question"); assert.equal(e.feedback[0]!.text, "Thanks");
  assert.equal(e.contextLimited, true); assert.equal(JSON.stringify(e).includes("PRIVATE EMBEDDED"), false);
  const dmEpisode = responseEpisodes(session, rows([user(dmWrapped), answer("Answer"), user("Thanks"), answer("Welcome")]), config.responseAudit).episodes[0]!;
  assert.equal(dmEpisode.request[0]!.text, "Current request");
});

test("bounded later evidence preserves original inputs, rejects unsafe boundaries and expires incomplete turns", async t => {
  const input = rows([user("Status?"), answer("The index was deleted."), user("Investigate."),
    answer("Checking.", { channel: "commentary" }), answer("Correction: it was intentionally migrated."), user("Thanks"), answer("Welcome")]);
  const e = responseEpisodes(session, input, config.responseAudit).episodes[0]!;
  assert.equal(e.followup.status, "complete"); assert.equal(e.followup.messages.length, 2);
  assert.equal(e.answer.length, 1);
  const seen: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); seen.push(body.state); return Response.json(payload(body));
  });
  const params = { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal };
  await judgeResponse(e, params); await judgeResponseFollowup(e, params);
  assert.equal(seen.length, 3);
  assert.equal(JSON.stringify(seen.slice(0, 2)).includes("intentionally migrated"), false);
  assert.equal(JSON.stringify(seen[0]).includes("Investigate."), false);
  assert.equal(JSON.stringify(seen[2]).includes("intentionally migrated"), true);
  for (const tail of [user("UNAPPROVED", { __openclaw: {} }), answer("TAINTED", { __openclaw: { turnTainted: true } })]) {
    const bad = responseEpisodes(session, [...input.slice(0, 4), ...rows([tail])], config.responseAudit).episodes[0]!;
    assert.equal(bad.followup.status, "unavailable"); assert.deepEqual(bad.followup.messages, []);
  }
  const pending = responseEpisodes(session, input.slice(0, 4), config.responseAudit).episodes[0]!;
  assert.equal(pending.followup.status, "pending");
  const oversized = responseEpisodes(session, rows([user("Q"), answer("A"), user("F"), answer("x".repeat(12001))]), config.responseAudit).episodes[0]!;
  assert.equal(oversized.followup.status, "oversized");
  await judgeResponseFollowup(oversized, params); assert.equal(seen.length, 4);
  assert.deepEqual(seen.at(-1)!.nextAssistantResponse, []);
  assert.notEqual(pending.inputHash, e.inputHash);
  const partial = responseEpisodes(session, [...input.slice(0, 5), ...rows([answer("PRIVATE SYNTHETIC NOTICE", { provider: "openclaw", model: "delivery-mirror" })])], config.responseAudit).episodes[0]!;
  assert.equal(partial.followup.status, "partial");
  assert.equal(partial.followup.messages.length, 2);
  assert.equal(JSON.stringify(partial).includes("PRIVATE SYNTHETIC"), false);
  await judgeResponseFollowup(partial, params);
  assert.equal(seen.at(-1)!.evidenceStatus, "partial");
});

test("episode grouping keeps progress with final output and closes feedback only at the next agent turn", () => {
  const messages = [user("Explain only."), answer("Looking into it.", { channel: "commentary" }),
    { role: "assistant", content: [{ type: "toolCall", name: "memory_search" }], stopReason: "toolUse" },
    { role: "toolResult", content: "PRIVATE TOOL" }, answer("Explanation."), user("No, I meant the other API."), user("Keep it short.")];
  const pending = responseEpisodes(session, rows(messages), config.responseAudit);
  assert.equal(pending.coverage.pendingFeedback, 1); assert.equal(pending.episodes.length, 0);
  const done = responseEpisodes(session, rows([...messages, answer("Corrected.")]), config.responseAudit);
  assert.equal(done.episodes.length, 1);
  assert.equal(done.episodes[0]!.answer.length, 2);
  assert.equal(done.episodes[0]!.feedback.length, 2);
  assert.equal(done.episodes[0]!.memorySearchCalls, 1);
  assert.equal(JSON.stringify(done.episodes).includes("PRIVATE TOOL"), false);
  assert.equal(done.coverage.noFeedback, 1);
});

test("internal events, bots, unapproved humans and unrelated threads cannot supply feedback or leak context", () => {
  const identity = user("x").__openclaw;
  const badUsers = [user("private", { provenance: { kind: "inter_session" } }), user("private", { __openclaw: {} }),
    user("private", { __openclaw: { ...identity, senderId: "other" } }),
    user("private", { __openclaw: { ...identity, senderIdentity: { senderKind: "bot" } } }),
    user("private", { __openclaw: { ...identity, transport: { ...identity.transport, threadId: "other" } } })];
  for (const bad of badUsers) {
    const result = responseEpisodes(session, rows([user("Request"), answer("Answer"), bad, answer("Ignored"),
      user("New request"), answer("New answer"), user("Thanks"), answer("Welcome")]), config.responseAudit);
    assert.equal(result.episodes.length, 1);
    assert.equal(result.episodes[0]!.before.length, 0);
    assert.equal(JSON.stringify(result.episodes).includes("private"), false);
  }
});

test("oversized answers and unfinished or failed agent turns are not graded", () => {
  for (const a of [answer("x".repeat(25000)), answer("Incomplete", { channel: "commentary" }),
    answer("Failed", { stopReason: "error" }), answer("Tainted", { __openclaw: { turnTainted: true } }),
    answer("Relayed", { provenance: { kind: "inter_session" } }),
    answer("Mirrored", { provider: "openclaw", model: "delivery-mirror" }),
    answer("Injected", { provider: "openclaw", model: "gateway-injected" })]) {
    assert.equal(responseEpisodes(session, rows([user("Request"), a, user("Thanks"), answer("Next")]), config.responseAudit).episodes.length, 0);
  }
});

test("explicitly approved trusted owners work with older unknown identity metadata, but bots never do", () => {
  const meta = user("x").__openclaw;
  for (const senderKind of ["unknown", "bot"]) {
    const owner = (text: string) => user(text, { __openclaw: { ...meta, senderIsOwner: true, senderIdentity: { senderKind } } });
    const result = responseEpisodes(session, rows([owner("Request"), answer("Answer"), owner("Thanks"), answer("Next")]), config.responseAudit);
    assert.equal(result.episodes.length, senderKind === "bot" ? 0 : 1);
  }
});

test("quality request cannot see later feedback; schema errors and provider errors fail safely", async t => {
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  let n = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (n++ === 0) { assert.equal(body.state.feedback, undefined); assert.equal(JSON.stringify(body).includes("Great, now elaborate."), false); }
    else assert.equal(body.state.feedback[0].text, "Great, now elaborate.");
    return Response.json(payload(body));
  });
  await judgeResponse(e, { apiKey: "fake", signal: new AbortController().signal, timeoutMs: 1000 });
  assert.equal(n, 2);
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const result = payload(JSON.parse(String(init.body)));
    result.answers.fulfillment = { type: "score", score: 0, confidence: 0.95, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 } };
    return Response.json(result);
  });
  await assert.rejects(judgeResponse(e, { apiKey: "fake", signal: new AbortController().signal, timeoutMs: 1000 }), /probability distribution/);
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: {} }));
  await assert.rejects(judgeResponse(e, { apiKey: "fake", signal: new AbortController().signal, timeoutMs: 1000 }), /Invalid/);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("PRIVATE PROVIDER DETAILS"); });
  await assert.rejects(judgeResponse(e, { apiKey: "fake", signal: new AbortController().signal, timeoutMs: 1000 }),
    { message: "TypeSafe request failed", code: "network_error" });
});

test("audit persists deduplicated results, skips retired active branches and reports denominators", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { calls++; return Response.json(payload(JSON.parse(String(init.body)))); });
  const preview = await auditResponses({ ...options, dryRun: true });
  assert.equal(preview.status, "dry_run"); assert.equal(calls, 0); assert.equal(existsSync(options.storePath), false);
  assert.equal((await auditResponses(options)).status, "ok"); assert.equal(calls, 3);
  assert.equal((await auditResponses(options)).status, "ok"); assert.equal(calls, 3);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const report = store.report(responseCohort(config.responseAudit), 0);
  assert.equal(report.stored, 1); assert.equal(report.groups[0]!.assessable, 1); assert.equal(report.groups[0]!.fulfillmentMean, 3);
  assert.equal(report.groups[0]!.smallSample, true);
  assert.equal(JSON.stringify(report).includes("Give me a brief"), false);
  assert.equal((await stat(options.storePath)).mode & 0o777, 0o600);
  db.prepare("DELETE FROM session_transcript_active_events WHERE active_position>=2").run();
  await auditResponses(options);
  assert.equal(store.report(responseCohort(config.responseAudit), 0).stored, 0);
  assert.equal(calls, 3);
});

test("disabled, missing key and already-running gates prevent API work", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async () => { assert.fail("must not call TypeSafe"); });
  assert.equal((await auditResponses({ ...options, config: resolveConfig({}) })).status, "disabled");
  assert.equal((await auditResponses({ ...options, config: { ...config, typesafe: { enabled: true, timeoutMs: 1000, apiKeyFile: "/not-found-response-key" } } })).status, "unavailable");
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const lease = store.acquire(Date.now())!;
  assert.equal((await auditResponses(options)).status, "already_running");
  store.release(lease);
});

test("reconciliation retires whole removed branches, deleted sessions and disallowed transports", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++; return Response.json(payload(JSON.parse(String(init.body))));
  });
  for (const mutation of ["DELETE FROM session_transcript_active_events", "DELETE FROM session_windows",
    "UPDATE session_windows SET channel='internal'"]) {
    const { db, options } = await fixture(); t.after(() => db.close());
    await auditResponses(options);
    const before = calls;
    const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
    assert.equal(store.report(responseCohort(config.responseAudit), 0).stored, 1);
    db.exec(mutation);
    const result = await auditResponses(options);
    assert.equal(result.coverage?.sessions, 1); // Includes saved-session reconciliation, not just new inference selection.
    assert.equal(result.coverage?.reconciledSessions, 1);
    assert.equal(store.report(responseCohort(config.responseAudit), 0).stored, 0);
    assert.equal(calls, before);
  }
});

test("reconciliation verifies saved sessions beyond the inference cap without retiring valid evidence", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  await auditResponses(options);
  for (let i = 0; i < 101; i++) {
    const id = `new-${i}`;
    insertSession(db, { sessionId: id, chatType: "direct" });
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run(id, 1,
      JSON.stringify({ type: "message", message: user("New request") }), Date.now());
    db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run(id, 0, 1, 0);
  }
  t.mock.method(globalThis, "fetch", async () => { assert.fail("no new eligible answers"); });
  const result = await auditResponses(options);
  assert.equal(result.coverage?.sessionLimitReached, true);
  assert.equal(result.coverage?.sessions, 100);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  assert.equal(store.report(responseCohort(config.responseAudit), 0).stored, 1);
  db.prepare("DELETE FROM session_transcript_active_events WHERE session_id='s'").run();
  await auditResponses(options);
  assert.equal(store.report(responseCohort(config.responseAudit), 0).stored, 0);
});

test("oversized saved sessions defer reconciliation instead of masquerading as deleted", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  await auditResponses(options);
  db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=4").run(JSON.stringify({ type: "message", message: answer("x".repeat(2_000_001)) }));
  const result = await auditResponses(options);
  assert.equal(result.coverage?.reconciliationDeferred, 1);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  assert.equal(store.report(responseCohort(config.responseAudit), 0).stored, 1);
});

test("unrelated later tool appends do not discard an unchanged episode or consume retries", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  let seq = 5;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("s", seq,
      JSON.stringify({ type: "message", message: { role: "toolResult", content: "Later tool result" } }), Date.now());
    db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run("s", seq, seq, seq); seq++;
    return Response.json(payload(JSON.parse(String(init.body))));
  });
  const result = await auditResponses(options);
  assert.equal(result.coverage?.stale, 0); assert.equal(result.coverage?.evaluated, 1);
  assert.equal((await auditResponses(options)).coverage?.attempted, 0);
});

test("actual episode rewrites invalidate inference and immediately retry the new input", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  let changed = false;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (!changed) {
      changed = true;
      db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=2").run(JSON.stringify({ type: "message", message: answer("Rewritten answer") }));
    }
    return Response.json(payload(JSON.parse(String(init.body))));
  });
  const result = await auditResponses(options);
  assert.equal(result.coverage?.stale, 1); assert.equal(result.coverage?.evaluated, 0);
  const next = await auditResponses(options);
  assert.equal(next.coverage?.evaluated, 1); assert.equal(next.coverage?.stale, 0);
});

test("unverifiable snapshots do not permanently consume provider retry attempts", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  let makeOversized = true;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (makeOversized) {
      db.prepare("INSERT OR REPLACE INTO transcript_events VALUES(?,?,?,?)").run("s", 5,
        JSON.stringify({ type: "message", message: { role: "toolResult", content: "x".repeat(2_000_001) } }), Date.now());
      db.prepare("INSERT OR REPLACE INTO session_transcript_active_events VALUES(?,?,?,?)").run("s", 4, 5, 4);
    }
    return Response.json(payload(JSON.parse(String(init.body))));
  });
  for (let i = 0; i < 3; i++) {
    const result = await auditResponses(options);
    assert.equal(result.coverage?.attempted, 1); assert.equal(result.coverage?.stale, 1);
    db.prepare("DELETE FROM session_transcript_active_events WHERE event_seq=5").run();
    // A genuinely new original answer requires inference again; unchanged successful
    // stages are now reusable even when the earlier snapshot could not be activated.
    db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=2").run(JSON.stringify({ type: "message", message: answer(`Revision ${i}`) }));
  }
  makeOversized = false;
  assert.equal((await auditResponses(options)).coverage?.evaluated, 1);
});

test("transcript changes during inference reject stale judgments", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    db.prepare("DELETE FROM session_transcript_active_events WHERE active_position=3").run();
    return Response.json(payload(JSON.parse(String(init.body))));
  });
  const result = await auditResponses(options);
  assert.equal(result.coverage?.stale, 1); assert.equal(result.coverage?.evaluated, 0);
});

test("cancellation settles even with an uncooperative provider and releases the audit lease", { timeout: 2000 }, async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, "fetch", () => { started(); return new Promise<Response>(() => {}); });
  const run = auditResponses({ ...options, signal: controller.signal });
  await ready; controller.abort();
  assert.equal((await run).status, "unavailable");
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  assert.ok(store.acquire(Date.now()));
});

test("reader rejects another agent and oversized sessions without returning partial context", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  assert.throws(() => new ResponseTranscriptReader(options.databasePath, "other"), /schema or agent/);
  db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=1").run("x".repeat(2_000_001));
  const reader = new ResponseTranscriptReader(options.databasePath, "main"); t.after(() => reader.close());
  assert.equal(reader.read(session, config.responseAudit), undefined);
});

test("memory investigation limits to approved active whole documents before ranking", async t => {
  const root = await mkdtemp(join(tmpdir(), "response-memory-"));
  const path = join(root, "index.sqlite"), db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec(`CREATE TABLE documents(id INTEGER PRIMARY KEY,collection TEXT,path TEXT,hash TEXT,active INTEGER);
    CREATE TABLE content(hash TEXT PRIMARY KEY,doc TEXT);
    CREATE VIRTUAL TABLE documents_fts USING fts5(body);`);
  const source = resolveSource(root, "memory/**/*.md");
  const insert = (id: number, collection: string, text: string, active = 1) => {
    db.prepare("INSERT INTO documents VALUES(?,?,?,?,?)").run(id, collection, `${id}.md`, String(id), active);
    db.prepare("INSERT INTO content VALUES(?,?)").run(String(id), text);
    db.prepare("INSERT INTO documents_fts(rowid,body) VALUES(?,?)").run(id, text);
  };
  for (let i = 1; i <= 105; i++) insert(i, "not-approved", "Atlas");
  insert(106, source.collection, "Atlas staging must stay in the EU.");
  insert(107, source.collection, "Atlas", 0);
  insert(108, source.collection, "Atlas " + "x".repeat(2001));
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  e.request[0]!.text = 'Atlas " OR *'; e.feedback[0]!.text = "";
  const result = responseMemoryCandidates(path, [source], e);
  assert.deepEqual(result, [{ path: `qmd://${source.collection}/106.md`, text: "Atlas staging must stay in the EU.", hash: "106" }]);
  assert.deepEqual(responseMemoryCandidates("/absent-index", [], e), []);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.state.candidates, [{ text: result[0]!.text }]);
    return Response.json(payload(body));
  });
  const params = { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal };
  const judged = await judgeMemoryOpportunity(e, result, params);
  assert.equal(judged[0]!.usefulness, 0.05);
  assert.match(judged[0]!.basis, /historical availability.*unknown/);
  assert.equal(JSON.stringify(judged).includes("staging"), false);
  assert.deepEqual(await judgeMemoryOpportunity(e, [], params), []);
  assert.equal(calls, 1);
});

test("memory opportunity judgments isolate concurrent candidates and retain source alignment", { timeout: 2000 }, async t => {
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const pending: ((response: Response) => void)[] = [];
  const candidates = ["first", "second"].map(text => ({ text, path: `qmd://memory/${text}.md`, hash: text }));
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.state.candidates, [{ text: candidates[pending.length].text }]);
    assert.deepEqual(Object.keys(body.questions), ["candidate_0"]);
    assert.doesNotMatch(JSON.stringify(body), /qmd:\/\/|"hash"/);
    return new Promise<Response>(resolve => pending.push(resolve));
  });
  const results = judgeMemoryOpportunity(e, candidates, { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal });
  assert.equal(pending.length, 2);
  pending[1](Response.json({ answers: { candidate_0: { type: "noul", noul: 0.9 } } }));
  pending[0](Response.json({ answers: { candidate_0: { type: "noul", noul: 0.1 } } }));
  assert.deepEqual((await results).map(result => [result.hash, result.usefulness]), [["first", 0.1], ["second", 0.9]]);
});

test("uncertain or unassessable grades do not become score means, and retry backoff is bounded", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const result = payload(body);
    if (body.questions.assessability) result.answers.assessability = choice(body.questions.assessability.criteria, "not_assessable");
    return Response.json(result);
  });
  await auditResponses(options);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const cohort = responseCohort(config.responseAudit);
  const report = store.report(cohort, 0);
  assert.equal(report.groups[0]!.assessable, 0);
  assert.equal(report.groups[0]!.fulfillmentMean, null);
  assert.equal(report.groups[0]!.deliverableFitMean, 3);
  const reader = new ResponseTranscriptReader(options.databasePath, "main"); t.after(() => reader.close());
  const e = reader.read(session, config.responseAudit)!.episodes[0]!;
  const result = await judgeResponse(e, { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal });
  result.quality.assessability.choice = "assessable";
  result.quality.deliverableFit.confidence = 0.4;
  const retrospective = await judgeResponseFollowup(e, { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal });
  retrospective.judgment!.correction.noul = 0.95;
  store.save(cohort, e, { ...result, retrospective,
    references: { sessionId: "s", request: [1], answer: [2], feedback: [3], followup: [4], inputHash: e.inputHash },
    agentModel: e.model, contextLimited: false, memorySearchCalls: 0, memory: { status: "not_requested", candidates: [] } }, Date.now());
  const independent = store.report(cohort, 0).groups[0]!;
  assert.equal(independent.assessable, 1);
  assert.equal(independent.fulfillmentScored, 1);
  assert.equal(independent.fulfillmentMean, 3);
  assert.equal(independent.deliverableFitScored, 0);
  assert.equal(independent.deliverableFitMean, null);
  assert.equal(independent.laterCorrections, 1);
  assert.ok(store.report(cohort, 0).examples[0]!.signals.includes("later_correction"));
  e.inputHash = "changed";
  store.observe(cohort, "s", [e]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = 1_000_000 + attempt * 600_000;
    assert.equal(store.needsJudgment(cohort, e, now), true);
    store.attempted(cohort, e, now);
    assert.equal(store.needsJudgment(cohort, e, now + 1), false);
  }
  assert.equal(store.needsJudgment(cohort, e, 10_000_000), false);
});

test("performance deltas require like cohorts and per-dimension samples, with visible failure reasons", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const judgment = await judgeResponse(e, { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal });
  const retrospective = await judgeResponseFollowup(e, { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal });
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const cohort = responseCohort(config.responseAudit);
  const episodes = Array.from({ length: 40 }, (_, i) => ({ ...e, id: `trend-${i}`, inputHash: `hash-${i}`,
    timestamp: Date.UTC(2026, 8, i < 20 ? 7 : 14) }));
  store.observe(cohort, "s", episodes);
  for (const [i, episode] of episodes.entries()) {
    const quality = structuredClone(judgment.quality);
    const later = structuredClone(retrospective);
    later.judgment!.outcome.choice = "acknowledged_success";
    if (i >= 20) {
      quality.fulfillment = { type: "score", score: 1, confidence: 0.95, probabilities: { "0": 0, "1": 1, "2": 0, "3": 0 } };
      quality.underdelivery.noul = 0.95;
      quality.failureReason.choice = "missing_requested_work";
      quality.deliverableFit.confidence = 0.5;
      later.judgment!.correction.noul = 0.95;
    }
    store.save(cohort, episode, { ...judgment, quality, retrospective: later,
      references: { sessionId: "s", request: [1], answer: [2], feedback: [3], followup: [], inputHash: episode.inputHash },
      agentModel: "same-model", contextLimited: false, memorySearchCalls: 0, memory: { status: "not_requested", candidates: [] } }, Date.now());
  }
  const report = store.report(cohort, 0);
  assert.equal(report.trends.find(t => t.dimension === "fulfillment")!.delta, -2);
  assert.equal(report.trends.find(t => t.dimension === "acknowledgedRate")!.delta, -1);
  assert.equal(report.trends.find(t => t.dimension === "reportedShortfallRate")!.delta, 1);
  assert.equal(report.trends.find(t => t.dimension === "unknownRate")!.delta, 0);
  assert.equal(report.trends.find(t => t.dimension === "acknowledgedRate")!.afterCoverage, 1);
  assert.equal(report.trends.find(t => t.dimension === "deliverableFit")!.status, "insufficient_samples");
  assert.equal(report.trends.find(t => t.dimension === "deliverableFit")!.delta, null);
  assert.equal(report.groups.find(g => g.week === "2026-09-14")!.failureReasons.missing_requested_work, 20);
  assert.ok(report.examples[0]!.signals.includes("clear_underdelivery"));
  assert.deepEqual(store.report("different-rubric", 0).trends, []);
  for (const episode of episodes) {
    store.save(cohort, episode, { ...judgment, retrospective,
      references: { sessionId: "s", request: [1], answer: [2], feedback: [3], followup: [], inputHash: episode.inputHash },
      agentModel: "unknown", contextLimited: false, memorySearchCalls: 0, memory: { status: "not_requested", candidates: [] } }, Date.now());
  }
  const unknown = store.report(cohort, 0).trends;
  assert.equal(unknown.length, 10);
  assert.ok(unknown.every(t => t.status === "unknown_stratum" && t.delta === null));
});

test("observed outcomes exclude unknowns, preserve original grades and count reasons only for confident shortfalls", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const params = { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal };
  const judgment = await judgeResponse(e, params);
  const retrospective = await judgeResponseFollowup(e, params);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const cohort = responseCohort(config.responseAudit);
  const episodes = Array.from({ length: 4 }, (_, i) => ({ ...e, id: `outcome-${i}` }));
  store.observe(cohort, "s", episodes);
  for (const [i, episode] of episodes.entries()) {
    const later = structuredClone(retrospective);
    later.judgment!.outcome.choice = i === 0 ? "acknowledged_success" : i === 1 ? "unknown" : "reported_shortfall";
    if (i === 3) later.judgment!.outcome.confidence = 0.6;
    later.judgment!.reason.choice = "incorrect_claim";
    store.save(cohort, episode, { ...judgment, retrospective: later,
      references: { sessionId: "s", request: [1], answer: [2], feedback: [3], followup: [4], inputHash: episode.inputHash },
      agentModel: "same-model", contextLimited: false, memorySearchCalls: 0, memory: { status: "not_requested", candidates: [] } }, Date.now());
  }
  const report = store.report(cohort, 0), group = report.groups[0]!;
  assert.equal(group.outcomeKnown, 2); assert.equal(group.outcomeUnknown, 2);
  assert.equal(group.observedSuccessRate, 0.5);
  assert.equal(group.acknowledgedRate, 0.25);
  assert.equal(group.reportedShortfallRate, 0.25);
  assert.equal(group.unknownRate, 0.5);
  assert.equal(group.outcomeReasons.incorrect_claim, 1);
  assert.equal(group.fulfillmentMean, 3);
  assert.deepEqual(report.examples.map(e => e.id), ["outcome-2"]);
  const composed = { ...judgment, retrospective };
  retrospective.judgment!.outcome.choice = "reported_shortfall";
  retrospective.judgment!.scopeClarification.noul = 0.95;
  assert.equal(responseOutcome(composed).status, "unknown");
  retrospective.judgment!.scopeClarification.noul = 0.5;
  assert.equal(responseOutcome(composed).status, "unknown");
  retrospective.judgment!.outcome.choice = "acknowledged_success";
  retrospective.judgment!.reason.choice = "none_or_unclear";
  retrospective.judgment!.regression.noul = 0.95;
  assert.equal(responseOutcome(composed).status, "reported_shortfall");
  assert.deepEqual(responseOutcome(composed).basis, ["regression_admission"]);
  assert.deepEqual(responseOutcome(composed).reasons, ["regression"]);
  retrospective.judgment!.deliveryAdmission.noul = 0.9;
  assert.deepEqual(responseOutcome(composed).reasons, ["failed_delivery", "regression"]);
  assert.equal(responseOutcome({ ...judgment, retrospective: { status: "pending", judgment: null } }).status, "unknown");
  judgment.quality.underdelivery.noul = 0.95;
  judgment.quality.failureReason.choice = "wrong_deliverable";
  assert.deepEqual(responseOutcome({ ...judgment, retrospective: { status: "pending", judgment: null } }), {
    status: "reported_shortfall", basis: ["visible_underdelivery"], reasons: ["wrong_deliverable"],
    reasonStatus: "classified", reasonDetails: [{ reason: "wrong_deliverable", strength: judgment.quality.failureReason.confidence,
      source: "visible_quality", measure: "choice_confidence" }],
  });
});

test("correction evidence does not manufacture a reason or require a confident broad outcome", async t => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const params = { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal };
  const result = { ...await judgeResponse(e, params), retrospective: await judgeResponseFollowup(e, params) };
  const later = result.retrospective.judgment!;
  later.outcome.confidence = 0.79;
  later.correction.noul = 0.91;
  later.reason.choice = "missing_requested_work";
  later.reason.confidence = 0.85;
  assert.deepEqual(responseOutcome(result).reasons, ["missing_requested_work"]);
  assert.deepEqual(responseOutcome(result).reasonDetails, [{ reason: "missing_requested_work", strength: 0.85,
    measure: "choice_confidence", source: "retrospective_reason" }]);
  later.reason.confidence = 0.79;
  assert.equal(responseOutcome(result).status, "reported_shortfall");
  assert.equal(responseOutcome(result).reasonStatus, "uncertain");
  assert.deepEqual(responseOutcome(result).reasons, []);
  later.correction.noul = 0.1;
  later.reason.confidence = 0.99;
  assert.equal(responseOutcome(result).status, "unknown");
  assert.deepEqual(responseOutcome(result).reasons, []);
});

test("trend rates retain unknowns and score deltas abstain when scored coverage changes", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const params = { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal };
  const judgment = await judgeResponse(e, params), retrospective = await judgeResponseFollowup(e, params);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const episodes = Array.from({ length: 50 }, (_, i) => ({ ...e, id: `coverage-${i}`,
    timestamp: Date.UTC(2026, 8, i < 25 ? 7 : 14) }));
  store.observe("fixed", "s", episodes);
  for (const [i, episode] of episodes.entries()) {
    const quality = structuredClone(judgment.quality), later = structuredClone(retrospective);
    later.judgment!.outcome.choice = "acknowledged_success";
    if (i >= 45) { later.judgment!.outcome.confidence = 0.79; quality.fulfillment.confidence = 0.79; }
    store.save("fixed", episode, { ...judgment, quality, retrospective: later, references: { sessionId: "s", request: [],
      answer: [], feedback: [], followup: [], inputHash: episode.inputHash }, agentModel: "same", contextLimited: false,
      memorySearchCalls: 0, memory: { status: "not_requested", candidates: [] } }, Date.now());
  }
  const report = store.report("fixed", 0);
  assert.equal(report.reportVersion, "response-report-v4");
  const score = report.trends.find(t => t.dimension === "fulfillment")!;
  assert.equal(score.beforeN, 25); assert.equal(score.afterN, 20);
  assert.equal(score.status, "coverage_changed"); assert.equal(score.delta, null);
  const rates = report.trends.filter(t => t.denominator === "all_evaluated_exchanges");
  assert.ok(rates.every(t => t.beforeN === 25 && t.afterN === 25 && t.coverageChanged));
  assert.ok(Math.abs(rates.find(t => t.dimension === "acknowledgedRate")!.delta! + 0.2) < 1e-9);
  assert.equal(rates.find(t => t.dimension === "reportedShortfallRate")!.delta, 0);
  assert.equal(rates.find(t => t.dimension === "unknownRate")!.delta, 0.2);
});

test("sentiment opt-out removes every emotion question and stored field without disabling quality", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  options.config = resolveConfig({ typesafe: { apiKey: "fake" }, responseAudit: {
    enabled: true, senderIds: ["owner"], sentimentEnabled: false, intervalMinutes: 0 } });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    for (const name of ["sentiment", "annoyance", "frustration", "dissatisfactionIntensity"]) assert.equal(body.questions[name], undefined);
    const result = payload(body);
    // Unrequested provider extras must not turn sentiment back on.
    result.answers.annoyance = { type: "noul", noul: 0.99 };
    return Response.json(result);
  });
  assert.equal((await auditResponses(options)).coverage?.evaluated, 1);
  assert.equal(calls, 3);
  assert.equal((await auditResponses(options)).coverage?.attempted, 0);
  assert.equal(calls, 3);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const e = responseEpisodes(session, basic(), options.config.responseAudit).episodes[0]!;
  const report = store.report(responseCohort(options.config.responseAudit), 0, e.id);
  const g = report.groups[0]!;
  assert.equal(g.evaluated, 1); assert.equal(g.sentimentNotAssessed, 1);
  assert.equal(g.sentimentAssessed, 0); assert.equal(g.dissatisfactionRate, null);
  assert.equal(g.annoyanceRate, null); assert.equal(g.dissatisfactionIntensityMean, null);
  assert.equal(report.episode!.result.feedback.annoyance, undefined);
});

test("sentiment schema requires all enabled questions and validates intensity distributions", async t => {
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const params = { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), result = payload(body);
    if (body.questions.annoyance) {
      assert.ok(body.state.feedback); assert.equal(body.state.nextAssistantResponse, undefined);
      assert.equal(body.questions.annoyance.type, "noul");
      assert.equal(body.questions.frustration.type, "noul");
      assert.equal(body.questions.dissatisfactionIntensity.type, "score");
      delete result.answers.frustration;
    }
    return Response.json(result);
  });
  await assert.rejects(judgeResponse(e, params), /Invalid response sentiment/);
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const result = payload(JSON.parse(String(init.body)));
    const intensity = result.answers.dissatisfactionIntensity;
    if (intensity && "score" in intensity) intensity.score = 1;
    return Response.json(result);
  });
  await assert.rejects(judgeResponse(e, params), /probability distribution/);
});

test("sentiment reporting separates mixed displeasure, overlapping emotions, intensity and unknowns from failure", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const params = { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal };
  const judgment = await judgeResponse(e, params), retrospective = await judgeResponseFollowup(e, params);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const episodes = Array.from({ length: 6 }, (_, i) => ({ ...e, id: `sentiment-${i}` }));
  store.observe("fixed", "s", episodes);
  for (const [i, episode] of episodes.entries()) {
    const feedback = structuredClone(judgment.feedback);
    if (i === 0) {
      feedback.sentiment!.choice = "mixed";
      feedback.annoyance!.noul = 0.99; feedback.frustration!.noul = 0.98;
      // High presence probability with LOW expressed intensity is valid.
      feedback.dissatisfactionIntensity = { type: "score", score: 1, confidence: 0.99, probabilities: { "0": 0, "1": 1, "2": 0, "3": 0 } };
    } else if (i < 3) {
      feedback.sentiment!.choice = i === 1 ? "unclear" : "dissatisfied";
      feedback.sentiment!.confidence = i === 1 ? 0.95 : 0.6;
      feedback.annoyance!.noul = 0.5; feedback.frustration!.noul = 0.5;
      feedback.dissatisfactionIntensity!.confidence = 0.4;
    } else if (i === 3) {
      feedback.sentiment!.choice = "unrelated";
      feedback.dissatisfactionIntensity = { type: "score", score: 0, confidence: 0.99, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 } };
    } else {
      // Legacy v9 has polarity only; disabled assessments have neither.
      delete feedback.annoyance; delete feedback.frustration; delete feedback.dissatisfactionIntensity;
      if (i === 5) delete feedback.sentiment;
    }
    store.save("fixed", episode, { ...judgment, feedback, retrospective, references: { sessionId: "s", request: [], answer: [],
      feedback: [], followup: [], inputHash: episode.inputHash }, agentModel: "same", contextLimited: false,
      memorySearchCalls: 0, memory: { status: "not_requested", candidates: [] } }, Date.now());
  }
  const report = store.report("fixed", 0), g = report.groups[0]!;
  assert.equal(g.sentimentAssessed, 5); assert.equal(g.sentimentNotAssessed, 1); assert.equal(g.sentimentUnknown, 2);
  assert.equal(g.dissatisfied, 1); assert.equal(g.dissatisfactionRate, 1 / 5); assert.equal(g.sentimentUnknownRate, 2 / 5);
  assert.equal(g.emotionAssessed, 4); assert.equal(g.annoyed, 1); assert.equal(g.frustrated, 1);
  assert.equal(g.annoyanceUncertain, 2); assert.equal(g.frustrationUncertain, 2);
  assert.equal(g.dissatisfactionIntensityScored, 2); assert.equal(g.dissatisfactionIntensityMean, 0.5);
  assert.equal(g.reportedShortfall, 0);
  assert.ok(report.examples.find(x => x.id === "sentiment-0")?.signals.includes("annoyed:current_answer"));
});

test("sentiment trends require samples and comparable coverage, and never include unassessed as neutral", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const params = { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal };
  const judgment = await judgeResponse(e, params), retrospective = await judgeResponseFollowup(e, params);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const episodes = Array.from({ length: 65 }, (_, i) => ({ ...e, id: `sentiment-trend-${i}`,
    timestamp: Date.UTC(2026, 8, i < 20 ? 7 : i < 40 ? 14 : 21) }));
  store.observe("fixed", "s", episodes);
  for (const [i, episode] of episodes.entries()) {
    const feedback = structuredClone(judgment.feedback);
    if (i >= 20) feedback.sentiment!.choice = "dissatisfied";
    if (i >= 60) { delete feedback.sentiment; delete feedback.annoyance; delete feedback.frustration; delete feedback.dissatisfactionIntensity; }
    store.save("fixed", episode, { ...judgment, feedback, retrospective, references: { sessionId: "s", request: [], answer: [],
      feedback: [], followup: [], inputHash: episode.inputHash }, agentModel: "same", contextLimited: false,
      memorySearchCalls: 0, memory: { status: "not_requested", candidates: [] } }, Date.now());
  }
  const report = store.report("fixed", 0);
  const trend = report.trends.find(x => x.dimension === "dissatisfactionRate" && x.toWeek === "2026-09-14")!;
  assert.equal(trend.delta, 1); assert.equal(trend.beforeN, 20); assert.equal(trend.afterN, 20);
  assert.equal(trend.denominator, "sentiment_assessed_exchanges");
  const changed = report.trends.find(x => x.dimension === "dissatisfactionRate" && x.toWeek === "2026-09-21")!;
  assert.equal(changed.after, 1); assert.equal(changed.afterCoverage, 0.8);
  assert.equal(changed.status, "coverage_changed"); assert.equal(changed.delta, null);
});

test("exact checkpoints skip extraction; only changed follow-up stages are assessed", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  const requests: string[][] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests.push(Object.keys(body.questions)); return Response.json(payload(body));
  });
  assert.equal((await auditResponses(options)).coverage?.stageAttempts, 4);
  const repeated = await auditResponses(options);
  assert.equal(repeated.coverage?.unchangedSessions, 1); assert.equal(repeated.coverage?.extractedSessions, 0);
  assert.equal(repeated.coverage?.stageAttempts, 0); assert.equal(requests.length, 3);
  db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=4").run(JSON.stringify({ type: "message", message: answer("A different later answer.") }));
  const revised = await auditResponses(options);
  assert.equal(revised.coverage?.stageAttempts, 1); assert.equal(revised.coverage?.stageCacheHits, 3);
  assert.equal(requests.length, 4); assert.ok(requests.at(-1)!.includes("correction"));
  // Off reuses quality, feedback and retrospective without inference; back on uses
  // its existing cohort and successful sentiment, not a fabricated neutral result.
  const off = { ...options, config: { ...options.config, responseAudit: { ...options.config.responseAudit, sentimentEnabled: false } } };
  assert.equal((await auditResponses(off)).coverage?.stageAttempts, 0);
  assert.equal((await auditResponses(options)).coverage?.stageAttempts, 0);
  assert.equal(requests.length, 4);
});

test("stage successes survive later API failure and only failed stages retry", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  let fail = true; const seen: string[][] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); seen.push(Object.keys(body.questions));
    if (fail && body.questions.feedbackType) throw new Error("synthetic provider failure");
    return Response.json(payload(body));
  });
  assert.equal((await auditResponses(options)).coverage?.failed, 1);
  assert.equal((await auditResponses(options)).coverage?.attempted, 0);
  const state = new DatabaseSync(options.storePath); t.after(() => state.close());
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  assert.equal(store.retryFailed(responseCohort(config.responseAudit)).stages, 2);
  assert.equal(state.prepare("SELECT attempts FROM response_stages WHERE stage='quality'").get()!.attempts, 1);
  fail = false;
  const next = await auditResponses(options);
  assert.equal(next.coverage?.evaluated, 1); assert.equal(next.coverage?.stageCacheHits, 1);
  assert.equal(seen.filter(keys => keys.includes("fulfillment")).length, 1);
  assert.equal(state.prepare("SELECT COUNT(*) n FROM response_stages WHERE status='ok'").get()!.n, 4);
});

test("fair durable cursor lets another session run before a busy session backlog", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  options.config = { ...config, responseAudit: { ...config.responseAudit, maxEpisodes: 1 } };
  insertSession(db, { sessionId: "z", chatType: "direct" });
  for (const row of basic()) {
    const event = JSON.parse(row.eventJson);
    if (event.message.__openclaw) event.message.__openclaw.transport.conversationRef = "conversation-z";
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("z", row.seq, JSON.stringify(event), row.createdAt);
    db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run("z", row.seq - 1, row.seq, row.seq - 1);
  }
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  await auditResponses(options);
  // New work arrives in the first session before the next scan.
  for (const [i, message] of [user("Next question"), answer("Next answer"), user("Thanks"), answer("Welcome")].entries()) {
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("s", 5 + i, JSON.stringify({ type: "message", message }), Date.now());
    db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run("s", 4 + i, 5 + i, 4 + i);
  }
  assert.equal((await auditResponses(options)).coverage?.evaluated, 1);
  const state = new DatabaseSync(options.storePath); t.after(() => state.close());
  assert.equal(state.prepare("SELECT COUNT(*) n FROM response_results WHERE session_id='z' AND status='ok'").get()!.n, 1);
});

test("human identities are scoped, link read-only, and report filters never mix people", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  const peoplePath = join(options.storePath, "..", "people.sqlite");
  const bootstrap = new ResponseAuditStore(options.storePath); bootstrap.close();
  const peopleDb = new DatabaseSync(peoplePath); t.after(() => peopleDb.close());
  peopleDb.exec(`CREATE TABLE people(id TEXT PRIMARY KEY,status TEXT); CREATE TABLE person_identities(person_id TEXT,provider TEXT,account_scope TEXT,external_id TEXT);
    INSERT INTO people VALUES('person-1','active'); INSERT INTO person_identities VALUES('person-1','slack','workspace','owner')`);
  const people = new ResponsePeople(peoplePath); t.after(() => people.close());
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  assert.equal(people.resolve(e).personId, "person-1");
  const other = { ...e, session: { ...e.session, accountId: "different-workspace" } };
  assert.equal(people.resolve(other).personId, null); assert.notEqual(people.resolve(other).key, people.resolve(e).key);
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  await auditResponses({ ...options, peoplePath });
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const cohort = responseCohort(config.responseAudit);
  assert.equal(store.report(cohort, 0).groups[0]!.human?.personId, "person-1");
  assert.equal(store.report(cohort, 0, undefined, { personId: "person-1", bucket: "day" }).stored, 1);
  assert.equal(store.report(cohort, 0, undefined, { senderId: "owner", accountScope: "different-workspace" }).stored, 0);
  assert.throws(() => store.report(cohort, 0, undefined, { senderId: "owner" }), /account scope/);
  assert.throws(() => store.report(cohort, 10, undefined, { until: 9 }), /range/);
});

test("review tasks are idempotent, preserve decisions and become stale after source rewrite", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), result = payload(body);
    for (const key of ["underdelivery", "annoyance", "frustration"]) if (body.questions[key]) result.answers[key] = { type: "noul", noul: 0.99 };
    return Response.json(result);
  });
  await auditResponses(options);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const cohort = responseCohort(config.responseAudit), tasks = store.reviews.list(cohort);
  assert.equal(tasks.length, 2); assert.ok(tasks.every(x => x.evidenceStatus === "current"));
  store.reviews.decide(cohort, tasks[0]!.id, "dismissed", "human", "Reviewed evidence; no preference change warranted.");
  await auditResponses(options);
  assert.equal(store.reviews.list(cohort).length, 2);
  assert.equal(store.reviews.list(cohort, tasks[0]!.id)[0]!.status, "dismissed");
  // Changed feedback: same tasks and prior decision, updated evidence, no auto-reopen.
  db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=3").run(JSON.stringify({ type: "message", message: user("Please reconsider.") }));
  await auditResponses(options);
  assert.equal(store.reviews.list(cohort).length, 2);
  assert.equal(store.reviews.list(cohort, tasks[0]!.id)[0]!.status, "dismissed");
  db.exec("DELETE FROM session_transcript_active_events");
  await auditResponses(options);
  assert.ok(store.reviews.list(cohort).every(x => x.evidenceStatus === "stale"));
  assert.throws(() => store.reviews.decide("unapproved-cohort", tasks[0]!.id, "resolved", "agent", "No"), /Unknown/);
  const annotation = store.reviews.annotate(Date.UTC(2026, 8, 18), "prompt", "Operator-recorded prompt update; not a causal claim.");
  assert.equal(store.reviews.annotations(Date.UTC(2026, 8, 18), Date.UTC(2026, 8, 19))[0]!.id, annotation);
});

test("restored ineligible sessions reactivate exact evidence without re-inference", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++; const body = JSON.parse(String(init.body)), result = payload(body);
    if (body.questions.underdelivery) result.answers.underdelivery = { type: "noul", noul: 0.99 };
    return Response.json(result);
  });
  await auditResponses(options);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const cohort = responseCohort(config.responseAudit), task = store.reviews.list(cohort)[0]!;
  store.reviews.decide(cohort, task.id, "dismissed", "human", "Reviewed");
  db.exec("UPDATE session_windows SET channel='internal'");
  await auditResponses(options);
  assert.equal(store.report(cohort, 0).stored, 0);
  assert.equal(store.reviews.list(cohort)[0]!.evidenceStatus, "stale");
  db.exec("UPDATE session_windows SET channel='slack'");
  const restored = await auditResponses(options);
  assert.equal(restored.coverage?.extractedSessions, 1); assert.equal(calls, 3);
  assert.equal(store.report(cohort, 0).stored, 1);
  assert.equal(store.reviews.list(cohort)[0]!.evidenceStatus, "current");
  assert.equal(store.reviews.list(cohort)[0]!.status, "dismissed");
});

test("a rewritten human never inherits a different person's dismissed task", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  options.config = { ...config, responseAudit: { ...config.responseAudit, senderIds: ["owner", "other"] } };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), result = payload(body);
    if (body.questions.underdelivery) result.answers.underdelivery = { type: "noul", noul: 0.99 };
    return Response.json(result);
  });
  await auditResponses(options);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const cohort = responseCohort(options.config.responseAudit), original = store.reviews.list(cohort)[0]!;
  store.reviews.decide(cohort, original.id, "dismissed", "human", "Reviewed first person's evidence");
  for (const seq of [1, 3]) {
    const row = db.prepare("SELECT event_json FROM transcript_events WHERE seq=?").get(seq)!;
    const event = JSON.parse(String(row.event_json)); event.message.__openclaw.senderId = "other";
    db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=?").run(JSON.stringify(event), seq);
  }
  await auditResponses(options);
  const tasks = store.reviews.list(cohort);
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find(x => x.id === original.id)!.evidenceStatus, "superseded");
  assert.equal(tasks.find(x => x.id !== original.id)!.status, "pending");
  assert.equal(store.report(cohort, 0).groups[0]!.human?.senderId, "other");
});

test("sentiment cache cannot overwrite independently refreshed feedback labels with provider extras", async t => {
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const params = { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  const initial = await judgeResponse(e, params);
  const f = initial.feedback;
  assert.ok(f.sentiment && f.annoyance && f.frustration && f.dissatisfactionIntensity);
  const sentiment = { ...f, sentiment: f.sentiment, annoyance: f.annoyance, frustration: f.frustration, dissatisfactionIntensity: f.dissatisfactionIntensity };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), result = payload(body);
    assert.equal(body.questions.sentiment, undefined);
    result.answers.target = choice(body.questions.target.criteria, "delivery");
    return Response.json(result);
  });
  const fresh = await judgeResponse(e, params, true, { quality: initial.quality, sentiment, begin() {}, save() {} });
  assert.equal(fresh.feedback.target.choice, "delivery");
  t.mock.method(globalThis, "fetch", () => { throw new Error("Cache should avoid API calls"); });
  const cached = await judgeResponse(e, params, true, { quality: initial.quality, feedback: fresh.feedback, sentiment, begin() {}, save() {} });
  assert.equal(cached.feedback.target.choice, "delivery");
});

test("review policy uses grouped intensity and attribution probabilities and refreshes cached results without inference", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++; const body = JSON.parse(String(init.body)), result = payload(body);
    if (body.questions.annoyance) {
      result.answers.annoyance = { type: "noul", noul: 0.97 };
      result.answers.dissatisfactionIntensity = { type: "score", score: 1.94, confidence: 0.94,
        probabilities: { "0": 0, "1": 0.06, "2": 0.94, "3": 0 } };
      result.answers.target = { ...choice(body.questions.target.criteria), confidence: 0.6,
        probabilities: { current_answer: 0.7, earlier_behavior: 0.3, delivery: 0, proactive_action: 0, external: 0, new_work: 0, mixed: 0, unclear: 0 } };
    }
    return Response.json(result);
  });
  await auditResponses(options);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const cohort = responseCohort(config.responseAudit), task = store.reviews.list(cohort)[0]!;
  assert.equal(task.family, "human_experience");
  store.reviews.decide(cohort, task.id, "dismissed", "human", "Reviewed");
  const state = new DatabaseSync(options.storePath); t.after(() => state.close());
  state.exec("UPDATE response_review_versions SET policy='older-policy'");
  assert.equal((await auditResponses(options)).coverage?.stageAttempts, 0);
  assert.equal(calls, 3); assert.equal(store.reviews.list(cohort).length, 1);
  assert.equal(store.reviews.list(cohort)[0]!.status, "dismissed");
  assert.equal(store.reviews.refresh(cohort, 0), 0);
});
