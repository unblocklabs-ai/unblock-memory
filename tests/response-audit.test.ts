import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "../src/config.js";
import { registerResponseAudit } from "../src/response-runtime.js";
import { RESPONSE_EXTRACTOR_VERSION, responseEpisodes, ResponseTranscriptReader } from "../src/response-episodes.js";
import { auditResponses, responseCohort } from "../src/response-audit.js";
import {
  judgeResponse,
  judgeResponseFollowup,
  judgeMemoryOpportunity,
  RESPONSE_STAGE_VERSIONS,
  responseRubricVersion,
  validateCachedStage,
} from "../src/response-judge.js";
import { jsonHash } from "../src/json-hash.js";
import { responseUserText } from "../src/response-text.js";
import { ResponseAuditStore } from "../src/response-store.js";
import { responseOutcome } from "../src/response-outcome.js";
import { responseMemoryCandidates } from "../src/response-memory.js";
import { resolveSource } from "../src/sources.js";
import { compressAgentTranscripts, createAgentDatabase, insertSession } from "./helpers/session-database.js";
import { ResponsePeople } from "../src/response-identity.js";

const session = { sessionId: "s", accountId: "workspace", conversationId: "conversation-s", chatType: "direct" };
const config = resolveConfig({ decisionModel: { apiKey: "fake-secret", timeoutMs: 1000 },
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
  assert.notEqual(responseCohort(config.responseAudit, "liquid/d1.2-ultra", "https://codex.unblocklabs.ai/v1/decisions"),
    responseCohort(config.responseAudit, "liquid/d1.2-ultra", "https://openrouter.ai/api/alpha/decisions"));
  assert.equal(responseCohort(config.responseAudit), responseCohort({ ...config.responseAudit, intervalMinutes: 15 }));
});

test("recognized envelopes expose only current human text and preserve ordinary Markdown/JSON", () => {
  assert.deepEqual(responseUserText(wrapped("Current request"), "owner"), { text: "Current request", contextLimited: true });
  const dmWrapped = wrapped("Current request").replace("Slack message in #test", "Slack DM");
  assert.deepEqual(responseUserText(dmWrapped, "owner"), { text: "Current request", contextLimited: true });
  // OpenClaw 2026.10+/11+ prefixed upstreamUserText, Recent chat history, and batched edit system lines stay verifiable.
  const prefixedEdited = '[OpenClaw conversation info: sender={"id":"owner","name":"Bek"}]\n' +
    'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"sender":{"id":"owner","name":"Bek"}}\n```\n\n' +
    'Recent chat history: ⟦openclaw:ctx⟧\nPRIVATE EMBEDDED HISTORY\n\n' +
    'System: [2026-09-10 10:26:38 EDT] Slack message in #test from Bek\n' +
    'System: [2026-09-10 10:26:38 EDT] Slack message edited in #test.\n\nCurrent request';
  assert.deepEqual(responseUserText(prefixedEdited, "owner"), { text: "Current request", contextLimited: true });
  assert.equal(responseUserText(prefixedEdited, "stranger"), undefined);
  // Two adjacent Slack message markers in one block must remain rejected as ambiguous.
  assert.equal(responseUserText(prefixedEdited.replace("Slack message edited in #test.", "Slack message in #test from Other"), "owner"), undefined);
  assert.equal(responseUserText(prefixedEdited.replace("Slack message edited in #test.", "Slack DM from Bek"), "owner"), undefined);
  // Bare From header with no body must still enforce sender verification and never leak as human text.
  assert.equal(responseUserText("From: Other (stranger)\n", "owner"), undefined);
  assert.equal(responseUserText("From: Bek (owner)\n", "owner"), undefined);
  const channelContext = "\n\nContext: ⟦openclaw:ctx⟧\nPRIVATE CHANNEL CONTEXT";
  for (const envelope of [wrapped("Current request"), dmWrapped]) {
    const contextual = envelope + channelContext;
    assert.deepEqual(responseUserText(contextual, "owner"), { text: "Current request", contextLimited: true });
    assert.deepEqual(responseUserText(contextual.replaceAll("\n", "\r\n"), "owner"), { text: "Current request", contextLimited: true });
    for (const ambiguous of [contextual + channelContext,
      contextual + "\nConversation info: ⟦openclaw:ctx⟧\n```json\n{}\n```",
      contextual + "\nSystem: [later] Slack DM from Bek\n\nAnother request",
      envelope + "\n\nContext: ⟦openclaw:ctx⟧\n",
      envelope.replace("from Bek", "from Other") + channelContext,
    ]) assert.equal(responseUserText(ambiguous, "owner"), undefined);
    assert.equal(responseUserText(contextual, "stranger"), undefined);
  }
  assert.equal(responseUserText("Current request" + channelContext, "owner"), undefined);
  assert.equal(responseUserText(wrapped("Current request"), "stranger"), undefined);
  assert.equal(responseUserText(wrapped("Current request").replace("from Bek", "from Other"), "owner"), undefined);
  assert.equal(responseUserText(wrapped("Current request").replace("```json", "```broken"), "owner"), undefined);
  assert.equal(responseUserText(wrapped("Current request") + "\nSystem: [later] Slack message in #test from Bek\n\nAmbiguous", "owner"), undefined);
  assert.equal(responseUserText(dmWrapped + "\nSystem: [later] Slack message in #test from Bek\n\nAmbiguous", "owner"), undefined);
  const normal = 'Please explain this JSON:\n```json\n{"history_truncated":true}\n```\nDo not delete it.';
  assert.deepEqual(responseUserText(normal, "owner"), { text: normal, contextLimited: false });
  const meta = user("x").__openclaw;
  const input = rows([user("fallback", { __openclaw: { ...meta, upstreamUserText: wrapped("Question") + channelContext } }),
    answer("Answer"), user(wrapped("Thanks")), answer("Welcome")]);
  const e = responseEpisodes(session, input, config.responseAudit).episodes[0]!;
  assert.equal(e.request[0]!.text, "Question"); assert.equal(e.feedback[0]!.text, "Thanks");
  assert.equal(e.contextLimited, true); assert.equal(JSON.stringify(e).includes("PRIVATE EMBEDDED"), false);
  assert.equal(JSON.stringify(e).includes("PRIVATE CHANNEL"), false);
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
    const body = JSON.parse(String(init.body)); seen.push(body.state[0]); return Response.json(payload(body));
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

test("senderIds wildcard ['*'] grades all verified Slack humans while still excluding bots and unverified senders", () => {
  const wildcardConfig = resolveConfig({
    responseAudit: { enabled: true, senderIds: ["*", "U_EXTRA"], intervalMinutes: 0 },
  }).responseAudit;
  assert.deepEqual(wildcardConfig.senderIds, ["*"]);
  const meta = user("x").__openclaw;
  const alice = (text: string) => user(text, { __openclaw: { ...meta, senderId: "U_ALICE", senderIdentity: { senderKind: "human" } } });
  const bot = (text: string) => user(text, { __openclaw: { ...meta, senderId: "U_BOT", senderIdentity: { senderKind: "bot" } } });
  const unverified = (text: string) => user(text, { __openclaw: { ...meta, senderId: "U_UNKNOWN", senderIdentity: { senderKind: "unknown" } } });

  const ok = responseEpisodes(session, rows([alice("Help me"), answer("Done"), alice("Thanks!"), answer("Welcome")]), wildcardConfig);
  assert.equal(ok.episodes.length, 1);
  assert.equal(ok.episodes[0]!.senderId, "U_ALICE");

  assert.equal(responseEpisodes(session, rows([bot("Automated ping"), answer("Ack"), bot("Ok"), answer("Done")]), wildcardConfig).episodes.length, 0);
  assert.equal(responseEpisodes(session, rows([unverified("Hi"), answer("Hello"), unverified("Thanks"), answer("Bye")]), wildcardConfig).episodes.length, 0);
});

test("quality request cannot see later feedback; schema errors and provider errors fail safely", async t => {
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  let n = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const [state] = body.state;
    if (n++ === 0) { assert.equal(state.feedback, undefined); assert.equal(JSON.stringify(body).includes("Great, now elaborate."), false); }
    else assert.equal(state.feedback[0].text, "Great, now elaborate.");
    return Response.json(payload(body));
  });
  await judgeResponse(e, { apiKey: "fake", signal: new AbortController().signal, timeoutMs: 1000 });
  assert.equal(n, 2);
  // Two-decimal rounding across an 8-option choice can sum to 1.04 (0.13 * 8) legitimately.
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const result = payload(body);
    if (result.answers.target && "probabilities" in result.answers.target && result.answers.target.probabilities) {
      result.answers.target.probabilities = Object.fromEntries(
        Object.keys(result.answers.target.probabilities).map(k => [k, 0.13]),
      );
    }
    return Response.json(result);
  });
  await judgeResponse(e, { apiKey: "fake", signal: new AbortController().signal, timeoutMs: 1000 });
  // Extra unknown probability keys must be rejected rather than inflating sum tolerance.
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const result = payload(body);
    if (result.answers.target && "probabilities" in result.answers.target && result.answers.target.probabilities) {
      result.answers.target.probabilities = {
        ...Object.fromEntries(Object.keys(result.answers.target.probabilities).map(k => [k, 0.132])),
        unknown_a: 0, unknown_b: 0, unknown_c: 0,
      };
    }
    return Response.json(result);
  });
  await assert.rejects(judgeResponse(e, { apiKey: "fake", signal: new AbortController().signal, timeoutMs: 1000 }), { code: "invalid_response" });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const result = payload(JSON.parse(String(init.body)));
    result.answers.fulfillment = { type: "score", score: 0, confidence: 0.95, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 } };
    return Response.json(result);
  });
  await assert.rejects(judgeResponse(e, { apiKey: "fake", signal: new AbortController().signal, timeoutMs: 1000 }), /score distribution/);
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: {} }));
  await assert.rejects(judgeResponse(e, { apiKey: "fake", signal: new AbortController().signal, timeoutMs: 1000 }), { code: "invalid_response" });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("PRIVATE PROVIDER DETAILS"); });
  await assert.rejects(judgeResponse(e, { apiKey: "fake", signal: new AbortController().signal, timeoutMs: 1000 }),
    { message: "Decision model request failed", code: "network_error" });
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
  t.mock.method(globalThis, "fetch", async () => { assert.fail("must not call decision model"); });
  assert.equal((await auditResponses({ ...options, config: resolveConfig({}) })).status, "disabled");
  assert.equal((await auditResponses({ ...options, config: { ...config, decisionModel: { ...config.decisionModel, apiKey: undefined, apiKeyFile: "/not-found-response-key" } } })).status, "unavailable");
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

test("dry-run discovery applies the session cap only to approved senders, including compressed events", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  for (let i = 0; i < 110; i++) {
    insertSession(db, { sessionId: `a-${String(i).padStart(3, "0")}`, chatType: "direct",
      message: { type: "message", message: i % 2 ? answer("Scheduled update") :
        user("Unapproved request", { __openclaw: { ...user("").__openclaw, senderId: "stranger" } }) } });
  }
  db.exec("UPDATE transcript_events SET created_at=strftime('%s','now')*1000");
  compressAgentTranscripts(db);
  t.mock.method(globalThis, "fetch", () => { assert.fail("dry run must not infer"); });
  const preview = await auditResponses({ ...options, dryRun: true });
  assert.equal(preview.status, "dry_run");
  assert.equal(preview.coverage?.sessions, 1);
  assert.equal(preview.coverage?.eligible, 1);
  assert.equal(preview.coverage?.sessionLimitReached, false);
  assert.equal(existsSync(options.storePath), false);
});

test("reader budgets decoded UTF-8 bytes regardless of database encoding", async t => {
  const root = await mkdtemp(join(tmpdir(), "response-encoding-"));
  for (const encoding of ["UTF-8", "UTF-16le"] as const) {
    const path = join(root, `${encoding}.sqlite`), db = createAgentDatabase(path, "main", "2026.8.1", 19, encoding);
    t.after(() => db.close());
    insertSession(db, { sessionId: "s", chatType: "direct",
      message: { type: "message", message: answer("x".repeat(1_100_000)) } });
    const reader = new ResponseTranscriptReader(path, "main"); t.after(() => reader.close());
    assert.ok(reader.read(session, config.responseAudit), `${encoding}: below UTF-8 budget`);
    db.prepare("UPDATE transcript_events SET event_json=?").run(JSON.stringify({ type: "message", message: answer("🦉".repeat(500_001)) }));
    assert.equal(reader.read(session, config.responseAudit), undefined, `${encoding}: above UTF-8 budget`);
  }
});

test("reader discovers compressed human events, defers cold history and enforces decoded UTF-8 budgets", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  assert.throws(() => new ResponseTranscriptReader(options.databasePath, "other"), /schema or agent/);
  const original = new ResponseTranscriptReader(options.databasePath, "main");
  t.after(() => original.close());
  const before = original.read(session, config.responseAudit);
  compressAgentTranscripts(db);
  const reader = new ResponseTranscriptReader(options.databasePath, "main"); t.after(() => reader.close());
  assert.deepEqual(reader.read(session, config.responseAudit), before);
  assert.ok(reader.sessions(config.responseAudit, 0).some(s => s.sessionId === session.sessionId));
  db.prepare("INSERT INTO session_transcript_cold_archives VALUES (?)").run(session.sessionId);
  db.exec("DELETE FROM session_transcript_active_events");
  assert.equal(reader.read(session, config.responseAudit), undefined);
  assert.equal(original.read(session, config.responseAudit), undefined,
    "a reader opened before migration must not mistake newly cold history for empty history");
  db.exec("DELETE FROM session_transcript_cold_archives");
  db.exec("INSERT INTO session_transcript_active_events SELECT session_id,seq-1,seq,seq-1 FROM transcript_events");
  db.prepare("UPDATE transcript_events SET event_utf8_bytes=2000001 WHERE seq=1").run();
  assert.equal(reader.read(session, config.responseAudit), undefined);
  // Plaintext uses bytes too: SQLite length(TEXT) would count these as only 500,001 characters.
  db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=1").run("🦉".repeat(500_001));
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
    assert.deepEqual(body.state[0].candidates, [{ text: result[0]!.text }]);
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
    assert.deepEqual(body.state[0].candidates, [{ text: candidates[pending.length].text }]);
    assert.deepEqual(Object.keys(body.questions), ["candidate_0"]);
    assert.doesNotMatch(JSON.stringify(body), /qmd:\/\/|"hash"/);
    return new Promise<Response>(resolve => pending.push(resolve));
  });
  const results = judgeMemoryOpportunity(e, candidates, { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal });
  await new Promise(resolve => setImmediate(resolve));
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
  const evaluated = { ...result, retrospective,
    references: { sessionId: "s", request: [1], answer: [2], feedback: [3], followup: [4], inputHash: e.inputHash },
    agentModel: e.model, contextLimited: false, memorySearchCalls: 0, memory: { status: "not_requested" as const, candidates: [] } };
  store.save(cohort, e, evaluated, Date.now());
  assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 0);
  store.stage(cohort, e, "quality", "failed-stage");
  store.stageBegin(["failed-stage"], Date.now());
  assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 1, "a linked failed stage remains unfinished despite a saved aggregate");
  store.stageSave("failed-stage", result.quality, Date.now());
  assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 0);
  store.save(cohort, e, { ...evaluated, memory: { status: "unavailable", candidates: [] } }, Date.now());
  assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 1, "unavailable optional analysis must remain unresolved");
  store.save(cohort, e, evaluated, Date.now());
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
    assert.equal(store.unresolvedWork(cohort, e.timestamp, e.timestamp + 1), 1, "backoff is still unfinished work");
  }
  assert.equal(store.needsJudgment(cohort, e, 10_000_000), false);
  assert.equal(store.pendingWork(cohort, 0, 10_000_000), 0);
  assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 1, "retry exhaustion must not look complete");
  assert.equal(store.unresolvedWork("other-cohort", 0, Number.MAX_SAFE_INTEGER), 0);
  assert.equal(store.unresolvedWork(cohort, 0, e.timestamp), 0, "review windows remain isolated");
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
  options.config = resolveConfig({ decisionModel: { apiKey: "fake" }, responseAudit: {
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
      assert.ok(body.state[0].feedback); assert.equal(body.state[0].nextAssistantResponse, undefined);
      assert.equal(body.questions.annoyance.type, "noul");
      assert.equal(body.questions.frustration.type, "noul");
      assert.equal(body.questions.dissatisfactionIntensity.type, "score");
      delete result.answers.frustration;
    }
    return Response.json(result);
  });
  await assert.rejects(judgeResponse(e, params), { code: "invalid_response" });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const result = payload(JSON.parse(String(init.body)));
    const intensity = result.answers.dissatisfactionIntensity;
    if (intensity && "score" in intensity) intensity.score = 1;
    return Response.json(result);
  });
  await assert.rejects(judgeResponse(e, params), /score distribution/);
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

test("ok episodes with unavailable memory automatically retry only memory after backoff and clear unresolvedWork", async t => {
  const start = Date.UTC(2026, 8, 20, 12, 0, 0);
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const { db, options } = await fixture(); t.after(() => db.close());
  const root = join(options.storePath, "..");
  const source = resolveSource(root, "memory/**/*.md");
  const indexDb = new DatabaseSync(options.indexPath); t.after(() => indexDb.close());
  indexDb.exec(`CREATE TABLE documents(id INTEGER PRIMARY KEY,collection TEXT,path TEXT,hash TEXT,active INTEGER);
    CREATE TABLE content(hash TEXT PRIMARY KEY,doc TEXT);
    CREATE VIRTUAL TABLE documents_fts USING fts5(body);`);
  for (const [id, doc] of [[1, "Brief explanation guidelines for Atlas."], [2, "Elaborate explanation notes for Atlas."]] as const) {
    indexDb.prepare("INSERT INTO documents VALUES(?,?,?,?,1)").run(id, source.collection, `${id}.md`, `h${id}`);
    indexDb.prepare("INSERT INTO content VALUES(?,?)").run(`h${id}`, doc);
    indexDb.prepare("INSERT INTO documents_fts(rowid,body) VALUES(?,?)").run(id, doc);
  }
  const memConfig = resolveConfig({
    decisionModel: { apiKey: "fake-secret", timeoutMs: 1000 },
    responseAudit: { enabled: true, senderIds: ["owner"], intervalMinutes: 0, memoryCorpora: [source.corpus] },
  });
  const memOptions = { ...options, config: memConfig, sources: [source] };
  const cohort = responseCohort(memConfig.responseAudit);
  let failMemory = true;
  const seenQuestions: string[][] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const keys = Object.keys(body.questions);
    seenQuestions.push(keys);
    if (body.questions.candidate_0) {
      if (failMemory && body.state[0].candidates[0].text.includes("Elaborate")) {
        throw new Error("transient memory candidate outage");
      }
      const noul = body.state[0].candidates[0].text.includes("Brief") ? 0.85 : 0.65;
      return Response.json({ answers: { candidate_0: { type: "noul", noul } } });
    }
    const result = payload(body);
    if (body.questions.memoryGap) result.answers.memoryGap = { type: "noul", noul: 0.95 };
    return Response.json(result);
  });

  const first = await auditResponses(memOptions);
  assert.equal(first.status, "ok");
  assert.equal(first.coverage?.evaluated, 1);
  const store = new ResponseAuditStore(memOptions.storePath); t.after(() => store.close());
  const e = responseEpisodes(session, basic(), memConfig.responseAudit).episodes[0]!;
  assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 1);
  assert.equal(store.report(cohort, 0, e.id).episode!.result.memory.status, "unavailable");
  // Within backoff: not due, no API calls on immediate re-scan.
  assert.equal(store.needsJudgment(cohort, e, Date.now() + 1), false);
  assert.equal(store.sessionWork(cohort, "s", 0, Date.now() + 1).due, 0);
  assert.equal(store.pendingWork(cohort, 0, Date.now() + 1), 0);
  const beforeBackoffCalls = seenQuestions.length;
  const skipped = await auditResponses(memOptions);
  assert.equal(skipped.coverage?.attempted, 0);
  assert.equal(seenQuestions.length, beforeBackoffCalls);

  // After backoff: automatically retries ONLY the memory stage.
  t.mock.timers.tick(600_000);
  assert.equal(store.needsJudgment(cohort, e, Date.now()), true);
  assert.equal(store.sessionWork(cohort, "s", 0, Date.now()).due, 1);
  assert.equal(store.pendingWork(cohort, 0, Date.now()), 1);
  failMemory = false;
  const retry = await auditResponses(memOptions);
  assert.equal(retry.status, "ok");
  assert.equal(retry.coverage?.attempted, 1);
  assert.equal(retry.coverage?.evaluated, 1);
  assert.equal(retry.coverage?.failed, 0);
  const retryCalls = seenQuestions.slice(beforeBackoffCalls);
  assert.equal(retryCalls.length, 2);
  assert.ok(retryCalls.every(keys => keys.length === 1 && keys[0] === "candidate_0"),
    "memory retry must not re-call quality, feedback, sentiment or retrospective stages");
  assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 0);
  assert.equal(store.needsJudgment(cohort, e, Date.now() + 600_000), false);
  assert.equal(store.pendingWork(cohort, 0, Date.now() + 600_000), 0);
  const finalMemory = store.report(cohort, 0, e.id).episode!.result.memory;
  assert.equal(finalMemory.status, "checked");
  assert.deepEqual(finalMemory.candidates.map((c: { hash: string; usefulness: number }) => [c.hash, c.usefulness]),
    [["h1", 0.85], ["h2", 0.65]]);
});

test("memory failures before stage-key creation respect retry bounds and retryFailed resets cleanly", async t => {
  const start = Date.UTC(2026, 8, 20, 12, 0, 0);
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const { db, options } = await fixture(); t.after(() => db.close());
  const root = join(options.storePath, "..");
  const source = resolveSource(root, "memory/**/*.md");
  const memConfig = resolveConfig({
    decisionModel: { apiKey: "fake-secret", timeoutMs: 1000 },
    responseAudit: { enabled: true, senderIds: ["owner"], intervalMinutes: 0, memoryCorpora: [source.corpus] },
  });
  const memOptions = { ...options, config: memConfig, sources: [source] };
  const cohort = responseCohort(memConfig.responseAudit);
  const coreCalls: string[][] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const keys = Object.keys(body.questions);
    if (!body.questions.candidate_0) coreCalls.push(keys);
    const result = payload(body);
    if (body.questions.memoryGap) result.answers.memoryGap = { type: "noul", noul: 0.95 };
    return Response.json(result);
  });

  // Attempt 1: index DB does not exist yet -> fails before stage key creation.
  assert.equal((await auditResponses(memOptions)).coverage?.evaluated, 1);
  assert.equal(coreCalls.length, 3);
  const rawDb = new DatabaseSync(memOptions.storePath); t.after(() => rawDb.close());
  const store = new ResponseAuditStore(memOptions.storePath); t.after(() => store.close());
  assert.equal(rawDb.prepare("SELECT COUNT(*) n FROM response_stage_links WHERE stage='memory'").get()!.n, 0);
  assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 1);

  // Attempts 2 and 3 after backoff still fail without re-calling core stages, then exhaust.
  for (const expectedAttempt of [2, 3]) {
    t.mock.timers.tick(600_000);
    const res = await auditResponses(memOptions);
    assert.equal(res.coverage?.attempted, 1);
    assert.equal(res.coverage?.failed, 1);
    assert.equal(res.coverage?.evaluated, 0);
    assert.equal(coreCalls.length, 3);
    assert.equal(rawDb.prepare("SELECT status,attempts FROM response_results").get()!.attempts, expectedAttempt);
    assert.equal(rawDb.prepare("SELECT status FROM response_results").get()!.status, "ok");
  }
  // Exhausted after MAX_RETRY_ATTEMPTS = 3: no further automatic retries.
  t.mock.timers.tick(600_000);
  assert.equal(store.pendingWork(cohort, 0, Date.now()), 0);
  assert.equal((await auditResponses(memOptions)).coverage?.attempted, 0);
  assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 1);

  // Restore index DB and use operator retryFailed: keeps valid 'ok' row intact while resetting retry budget.
  const indexDb = new DatabaseSync(memOptions.indexPath); t.after(() => indexDb.close());
  indexDb.exec(`CREATE TABLE documents(id INTEGER PRIMARY KEY,collection TEXT,path TEXT,hash TEXT,active INTEGER);
    CREATE TABLE content(hash TEXT PRIMARY KEY,doc TEXT);
    CREATE VIRTUAL TABLE documents_fts USING fts5(body);`);
  indexDb.prepare("INSERT INTO documents VALUES(1,?,?,?,1)").run(source.collection, "1.md", "h1");
  indexDb.prepare("INSERT INTO content VALUES(?,?)").run("h1", "Brief explanation note.");
  indexDb.prepare("INSERT INTO documents_fts(rowid,body) VALUES(1,?)").run("Brief explanation note.");

  assert.deepEqual(store.retryFailed(cohort), { stages: 0, episodes: 1 });
  const afterReset = rawDb.prepare("SELECT status,attempts,attempted_at,result FROM response_results").get()!;
  assert.equal(afterReset.status, "ok");
  assert.equal(afterReset.attempts, 0);
  assert.equal(afterReset.attempted_at, null);
  assert.ok(typeof afterReset.result === "string");

  const recovered = await auditResponses(memOptions);
  assert.equal(recovered.coverage?.attempted, 1);
  assert.equal(recovered.coverage?.evaluated, 1);
  assert.equal(coreCalls.length, 3);
  assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 0);

  // retryFailed on a broken non-memory episode clears stale result and assessed_at when resetting to pending.
  rawDb.prepare("UPDATE response_results SET status='failed',assessed_at=12345").run();
  assert.equal(store.retryFailed(cohort).episodes, 1);
  const cleaned = rawDb.prepare("SELECT status,assessed_at,result FROM response_results").get()!;
  assert.equal(cleaned.status, "pending");
  assert.equal(cleaned.assessed_at, null);
  assert.equal(cleaned.result, null);
});

test("judgeMemoryOpportunity aborts sibling candidate requests cleanly on transient failure", { timeout: 2000 }, async t => {
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const signals: AbortSignal[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++;
    if (init.signal) signals.push(init.signal);
    if (calls === 1) return new Promise<Response>(() => {});
    throw new Error("transient candidate failure");
  });
  const candidates = ["first", "second"].map(text => ({ text, path: `qmd://memory/${text}.md`, hash: text }));
  await assert.rejects(
    judgeMemoryOpportunity(e, candidates, { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal }),
    { code: "network_error" },
  );
  assert.equal(calls, 2);
  assert.equal(signals[0]?.aborted, true, "sibling request must be aborted when another candidate fails");
});

test("cached stage hydration rejects corrupted probability distributions and inconsistent score means", async t => {
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const params = { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  const valid = await judgeResponse(e, params);
  const validSentiment = {
    sentiment: valid.feedback.sentiment!,
    annoyance: valid.feedback.annoyance!,
    frustration: valid.feedback.frustration!,
    dissatisfactionIntensity: valid.feedback.dissatisfactionIntensity!,
  };

  let fetched = 0, began = 0;
  t.mock.method(globalThis, "fetch", async () => { fetched++; throw new Error("must not fetch on corrupted cache"); });
  const cacheHooks = { begin() { began++; }, save() {} };

  // Quality: distribution summing to 0 rejected.
  const zeroQuality = structuredClone(valid.quality);
  zeroQuality.fulfillment.probabilities = { "0": 0, "1": 0, "2": 0, "3": 0 };
  await assert.rejects(
    judgeResponse(e, params, true, { quality: zeroQuality, feedback: valid.feedback, sentiment: validSentiment, ...cacheHooks }),
    /probability distribution/,
  );

  // Quality: expected score mismatch rejected.
  const badScoreQuality = structuredClone(valid.quality);
  badScoreQuality.fulfillment.score = 0;
  await assert.rejects(
    judgeResponse(e, params, true, { quality: badScoreQuality, feedback: valid.feedback, sentiment: validSentiment, ...cacheHooks }),
    /probability distribution/,
  );

  // Feedback: choice distribution summing to 0 rejected (both fully cached and partial cache before API call).
  const zeroFeedback = structuredClone(valid.feedback);
  zeroFeedback.target.probabilities = Object.fromEntries(Object.keys(zeroFeedback.target.probabilities).map(k => [k, 0])) as typeof zeroFeedback.target.probabilities;
  await assert.rejects(
    judgeResponse(e, params, true, { quality: valid.quality, feedback: zeroFeedback, sentiment: validSentiment, ...cacheHooks }),
    /probability distribution/,
  );
  await assert.rejects(
    judgeResponse(e, params, true, { quality: valid.quality, feedback: zeroFeedback, ...cacheHooks }),
    /probability distribution/,
  );

  // Sentiment: choice distribution summing to 0 and intensity expected-score mismatch rejected.
  const zeroSentiment = structuredClone(validSentiment);
  zeroSentiment.sentiment.probabilities = Object.fromEntries(Object.keys(zeroSentiment.sentiment.probabilities).map(k => [k, 0])) as typeof zeroSentiment.sentiment.probabilities;
  await assert.rejects(
    judgeResponse(e, params, true, { quality: valid.quality, feedback: valid.feedback, sentiment: zeroSentiment, ...cacheHooks }),
    /probability distribution/,
  );
  await assert.rejects(
    judgeResponse(e, params, true, { quality: valid.quality, sentiment: zeroSentiment, ...cacheHooks }),
    /probability distribution/,
  );
  const badIntensitySentiment = structuredClone(validSentiment);
  badIntensitySentiment.dissatisfactionIntensity.score = 0;
  await assert.rejects(
    judgeResponse(e, params, true, { quality: valid.quality, feedback: valid.feedback, sentiment: badIntensitySentiment, ...cacheHooks }),
    /probability distribution/,
  );
  assert.equal(fetched, 0);
  assert.equal(began, 0);

  // Valid 8-option 2-decimal rounding drift (0.13 * 8 = 1.04 <= 1 + 0.045) remains accepted.
  const roundedFeedback = structuredClone(valid.feedback);
  roundedFeedback.target.probabilities = Object.fromEntries(
    Object.keys(roundedFeedback.target.probabilities).map(k => [k, 0.13]),
  ) as typeof roundedFeedback.target.probabilities;
  const hydrated = await judgeResponse(e, params, true, { quality: valid.quality, feedback: roundedFeedback, sentiment: validSentiment, ...cacheHooks });
  assert.equal(hydrated.feedback.target.choice, valid.feedback.target.choice);
});

test("later non-terminal assistant events preserve current.final and errored next turns do not close feedback", () => {
  // Later visible commentary or toolUse assistant event must not overwrite current.final = true.
  for (const trailing of [
    answer("Postscript commentary.", { channel: "commentary", stopReason: "stop" }),
    answer("Running follow-up tool.", { stopReason: "toolUse" }),
  ]) {
    const out = responseEpisodes(
      session,
      rows([user("Question"), answer("Final answer."), trailing, user("Thanks!"), answer("You are welcome.")]),
      config.responseAudit,
    );
    assert.equal(out.episodes.length, 1);
    assert.equal(out.episodes[0]!.answer.length, 2);
    assert.equal(out.episodes[0]!.feedback[0]!.text, "Thanks!");
    assert.equal(out.episodes[0]!.followup.status, "complete");
  }

  // Errored or aborted next assistant turn must be rejected BEFORE closing current's feedback window.
  for (const stopReason of ["error", "aborted"] as const) {
    const out = responseEpisodes(
      session,
      rows([user("Question"), answer("Original answer."), user("That missed part 2."), answer("Partial crash", { stopReason })]),
      config.responseAudit,
    );
    assert.equal(out.episodes.length, 0);
    assert.equal(out.coverage.completedResponses, 1);
    assert.equal(out.coverage.pendingFeedback, 1);
  }
});

test("corrupted persisted ok stage rows are invalidated and recomputed across all stages while preserving valid siblings", async t => {
  const start = Date.UTC(2026, 8, 22, 12, 0, 0);
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const { db, options } = await fixture(); t.after(() => db.close());
  const root = join(options.storePath, "..");
  const source = resolveSource(root, "memory/**/*.md");
  const indexDb = new DatabaseSync(options.indexPath); t.after(() => indexDb.close());
  indexDb.exec(`CREATE TABLE documents(id INTEGER PRIMARY KEY,collection TEXT,path TEXT,hash TEXT,active INTEGER);
    CREATE TABLE content(hash TEXT PRIMARY KEY,doc TEXT);
    CREATE VIRTUAL TABLE documents_fts USING fts5(body);`);
  indexDb.prepare("INSERT INTO documents VALUES(1,?,?,?,1)").run(source.collection, "1.md", "h1");
  indexDb.prepare("INSERT INTO content VALUES(?,?)").run("h1", "Brief explanation guidelines for Atlas.");
  indexDb.prepare("INSERT INTO documents_fts(rowid,body) VALUES(1,?)").run("Brief explanation guidelines for Atlas.");

  const memConfig = resolveConfig({
    decisionModel: { apiKey: "fake-secret", timeoutMs: 1000 },
    responseAudit: { enabled: true, senderIds: ["owner"], intervalMinutes: 0, memoryCorpora: [source.corpus] },
  });
  const memOptions = { ...options, config: memConfig, sources: [source] };
  const cohort = responseCohort(memConfig.responseAudit);

  let failProvider = false;
  const seenRequests: string[][] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seenRequests.push(Object.keys(body.questions));
    if (failProvider) throw new Error("transient provider outage");
    if (body.questions.candidate_0) {
      return Response.json({ answers: { candidate_0: { type: "noul", noul: 0.85 } } });
    }
    const result = payload(body);
    if (body.questions.memoryGap) result.answers.memoryGap = { type: "noul", noul: 0.95 };
    return Response.json(result);
  });

  // Seed all 5 valid stages (quality, feedback, sentiment, retrospective, memory).
  const initial = await auditResponses(memOptions);
  assert.equal(initial.status, "ok");
  assert.equal(initial.coverage?.evaluated, 1);

  const rawDb = new DatabaseSync(memOptions.storePath); t.after(() => rawDb.close());
  const store = new ResponseAuditStore(memOptions.storePath); t.after(() => store.close());
  const readStages = () => Object.fromEntries(
    rawDb.prepare("SELECT stage, key, status, attempts, assessed_at, result FROM response_stages").all()
      .map(row => [String(row.stage), {
        key: String(row.key),
        status: String(row.status),
        attempts: Number(row.attempts),
        assessedAt: Number(row.assessed_at),
        result: String(row.result),
      }]),
  );
  assert.deepEqual(Object.keys(readStages()).sort(), ["feedback", "memory", "quality", "retrospective", "sentiment"]);

  // 1) Corrupted 'quality' stage with provider failure -> invalidated to 'failed' (retryable via retryFailed), siblings preserved.
  t.mock.timers.tick(5_000);
  const beforeQuality = readStages();
  const brokenQuality = JSON.parse(beforeQuality.quality!.result);
  brokenQuality.fulfillment.probabilities = { "0": 0, "1": 0, "2": 0, "3": 0 };
  rawDb.prepare("UPDATE response_stages SET status='ok',attempts=3,attempted_at=?,result=? WHERE stage='quality'")
    .run(Date.now(), JSON.stringify(brokenQuality));
  rawDb.prepare("UPDATE response_results SET status='pending',attempts=0,attempted_at=NULL,assessed_at=NULL,result=NULL").run();

  seenRequests.length = 0;
  failProvider = true;
  const failedRun = await auditResponses(memOptions);
  assert.equal(failedRun.coverage?.failed, 1);
  assert.equal(failedRun.coverage?.stageAttempts, 1);
  assert.equal(seenRequests.length, 1);
  assert.ok(seenRequests[0]!.includes("fulfillment"));
  // Rejected stage is now 'failed' (not stranded as 'ok'), while valid siblings remain untouched 'ok'.
  assert.equal(rawDb.prepare("SELECT status FROM response_stages WHERE stage='quality'").get()!.status, "failed");
  for (const sibling of ["feedback", "sentiment", "retrospective", "memory"]) {
    const row = rawDb.prepare("SELECT status, assessed_at FROM response_stages WHERE stage=?").get(sibling)!;
    assert.equal(row.status, "ok");
    assert.equal(Number(row.assessed_at), beforeQuality[sibling]!.assessedAt);
  }
  assert.deepEqual(store.retryFailed(cohort), { stages: 1, episodes: 1 });

  t.mock.timers.tick(5_000);
  seenRequests.length = 0;
  failProvider = false;
  const recoveredQuality = await auditResponses(memOptions);
  assert.equal(recoveredQuality.coverage?.evaluated, 1);
  assert.equal(recoveredQuality.coverage?.stageAttempts, 1);
  assert.equal(recoveredQuality.coverage?.stageCacheHits, 4);
  assert.equal(seenRequests.length, 1);
  assert.ok(seenRequests[0]!.includes("fulfillment"));
  assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 0);
  for (const sibling of ["feedback", "sentiment", "retrospective", "memory"]) {
    assert.equal(
      Number(rawDb.prepare("SELECT assessed_at FROM response_stages WHERE stage=?").get(sibling)!.assessed_at),
      beforeQuality[sibling]!.assessedAt,
      `${sibling} must remain cached and untouched while quality recovers`,
    );
  }

  // 2) Immediate invalidation and recomputation for feedback, sentiment, retrospective, and memory stages.
  const corruptions: { stage: "feedback" | "sentiment" | "retrospective" | "memory"; expectedQuestion: string; corrupt: (raw: string) => string }[] = [
    {
      stage: "feedback",
      expectedQuestion: "feedbackType",
      corrupt(raw) {
        const parsed = JSON.parse(raw);
        parsed.target.probabilities = Object.fromEntries(Object.keys(parsed.target.probabilities).map(k => [k, 0]));
        return JSON.stringify(parsed);
      },
    },
    {
      stage: "sentiment",
      expectedQuestion: "dissatisfactionIntensity",
      corrupt(raw) {
        const parsed = JSON.parse(raw);
        parsed.dissatisfactionIntensity.score = 0;
        return JSON.stringify(parsed);
      },
    },
    {
      stage: "retrospective",
      expectedQuestion: "outcome",
      corrupt(raw) {
        const parsed = JSON.parse(raw);
        parsed.judgment.outcome.probabilities = Object.fromEntries(Object.keys(parsed.judgment.outcome.probabilities).map(k => [k, 0]));
        return JSON.stringify(parsed);
      },
    },
    {
      stage: "memory",
      expectedQuestion: "candidate_0",
      corrupt() {
        return JSON.stringify([{ path: "qmd://memory/1.md", hash: "h1", usefulness: 2.5, basis: "bad" }]);
      },
    },
  ];

  for (const { stage, expectedQuestion, corrupt } of corruptions) {
    t.mock.timers.tick(5_000);
    const before = readStages();
    rawDb.prepare("UPDATE response_stages SET status='ok',attempts=3,attempted_at=?,result=? WHERE stage=?")
      .run(Date.now(), corrupt(before[stage]!.result), stage);
    if (stage === "memory") {
      // Exercise memory-only retry path where response_results is ok + memory.unavailable.
      const saved = JSON.parse(String(rawDb.prepare("SELECT result FROM response_results").get()!.result));
      saved.memory = { status: "unavailable", candidates: [] };
      rawDb.prepare("UPDATE response_results SET status='ok',attempts=0,attempted_at=NULL,result=?").run(JSON.stringify(saved));
    } else {
      rawDb.prepare("UPDATE response_results SET status='pending',attempts=0,attempted_at=NULL,assessed_at=NULL,result=NULL").run();
    }

    seenRequests.length = 0;
    const recovered = await auditResponses(memOptions);
    assert.equal(recovered.status, "ok", `${stage} recovery status`);
    assert.equal(recovered.coverage?.evaluated, 1, `${stage} recovery evaluated`);
    assert.equal(recovered.coverage?.stageAttempts, 1, `${stage} must recompute only the corrupted stage`);
    assert.equal(seenRequests.length, 1, `${stage} must make exactly one provider request`);
    assert.ok(seenRequests[0]!.includes(expectedQuestion), `${stage} request must target ${expectedQuestion}`);
    assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 0);

    const after = readStages();
    assert.equal(after[stage]!.status, "ok");
    assert.ok(after[stage]!.assessedAt > before[stage]!.assessedAt, `${stage} should have a fresh assessed_at`);
    for (const sibling of Object.keys(before)) {
      if (sibling === stage) continue;
      assert.equal(after[sibling]!.assessedAt, before[sibling]!.assessedAt, `${sibling} must be preserved when ${stage} is evicted`);
    }
  }

  // 3) Malformed JSON in an ok stage row is also evicted cleanly on direct hydration.
  const e = responseEpisodes(session, basic(), memConfig.responseAudit).episodes[0]!;
  const feedbackKey = readStages().feedback!.key;
  rawDb.prepare("UPDATE response_stages SET status='ok',attempts=2,attempted_at=?,result='{broken-json' WHERE key=?")
    .run(Date.now(), feedbackKey);
  assert.equal(store.stage(cohort, e, "feedback", feedbackKey), undefined);
  const evicted = rawDb.prepare("SELECT status,attempts,attempted_at,assessed_at,result FROM response_stages WHERE key=?").get(feedbackKey)!;
  assert.equal(evicted.status, "pending");
  assert.equal(evicted.attempts, 0);
  assert.equal(evicted.attempted_at, null);
  assert.equal(evicted.assessed_at, null);
  assert.equal(evicted.result, null);
});

test("upgrading RESPONSE_EXTRACTOR_VERSION to 7 re-extracts unchanged v6 checkpoints cleanly without mixing v6 and v7 verdicts", async t => {
  assert.equal(RESPONSE_EXTRACTOR_VERSION, 7);
  const root = await mkdtemp(join(tmpdir(), "response-upgrade-v7-"));
  const databasePath = join(root, "agent.sqlite");
  const db = createAgentDatabase(databasePath); t.after(() => db.close());
  insertSession(db, { sessionId: "s", chatType: "direct" });
  // Transcript with Batch 1 trailing-commentary boundary fix: v6 dropped this episode; v7 extracts it.
  const transcriptRows = rows([
    user("Explain the rollout plan."),
    answer("Here is the rollout plan."),
    answer("Postscript commentary.", { channel: "commentary", stopReason: "stop" }),
    user("Thanks, looks good."),
    answer("Happy to help."),
  ]);
  for (const [i, row] of transcriptRows.entries()) {
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("s", row.seq, row.eventJson, row.createdAt);
    db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run("s", i, row.seq, i);
  }
  const options = {
    agentId: "main",
    config,
    databasePath,
    storePath: join(root, "audit/response.sqlite"),
    indexPath: join(root, "absent.sqlite"),
    sources: [],
  };

  const v6Cohort = responseRubricVersion() + ":" + jsonHash({
    extractor: 6,
    historyMessages: config.responseAudit.historyMessages,
    stages: RESPONSE_STAGE_VERSIONS,
    sentimentEnabled: config.responseAudit.sentimentEnabled,
    senderIds: [...config.responseAudit.senderIds].sort(),
    chatTypes: [...config.responseAudit.chatTypes].sort(),
    memoryCorpora: [...config.responseAudit.memoryCorpora].sort(),
  }).slice(0, 16);
  const v7Cohort = responseCohort(config.responseAudit);
  assert.notEqual(v7Cohort, v6Cohort);

  const v6Revision = jsonHash([
    6,
    session,
    config.responseAudit.historyMessages,
    [...config.responseAudit.senderIds].sort(),
    transcriptRows,
  ]);

  // Direct reader check: a v6 checkpoint revision on the unchanged transcript must NOT short-circuit as unchanged.
  const reader = new ResponseTranscriptReader(databasePath, "main"); t.after(() => reader.close());
  const readResult = reader.read(session, config.responseAudit, v6Revision);
  assert.ok(readResult && !("unchanged" in readResult), "v6 checkpoint revision must force re-extraction under v7");
  assert.notEqual(readResult.revision, v6Revision);
  assert.equal(readResult.episodes.length, 1);

  // Seed persisted store with a v6 checkpoint and an old v6 verdict (score = 0) before upgrading to v7.
  const seedStore = new ResponseAuditStore(options.storePath); t.after(() => seedStore.close());
  seedStore.checkpointSave(v6Cohort, "s", v6Revision, {
    completedResponses: 0, eligible: 0, noFeedback: 0, pendingFeedback: 0, oversized: 0, filteredEvents: 0,
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++;
    return Response.json(payload(JSON.parse(String(init.body))));
  });
  const params = { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal };
  const sampleEpisode = readResult.episodes[0]!;
  const legacyJudgment = await judgeResponse(sampleEpisode, params);
  const legacyRetrospective = await judgeResponseFollowup(sampleEpisode, params);
  legacyJudgment.quality.fulfillment = { type: "score", score: 0, confidence: 0.95, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 } };
  const legacyEpisode = { ...sampleEpisode, id: "legacy-v6-episode", inputHash: "legacy-v6-hash" };
  seedStore.observe(v6Cohort, "s", [legacyEpisode]);
  seedStore.save(v6Cohort, legacyEpisode, {
    ...legacyJudgment,
    retrospective: legacyRetrospective,
    references: { sessionId: "s", request: [1], answer: [2], feedback: [4], followup: [5], inputHash: legacyEpisode.inputHash },
    agentModel: "agent-model",
    contextLimited: false,
    memorySearchCalls: 0,
    memory: { status: "not_requested", candidates: [] },
  }, Date.now());
  // Even if a pre-upgrade v6 revision existed on the v7 cohort row, v7 still re-extracts because revision hashes v7.
  seedStore.checkpointSave(v7Cohort, "s", v6Revision, {
    completedResponses: 0, eligible: 0, noFeedback: 0, pendingFeedback: 0, oversized: 0, filteredEvents: 0,
  });

  calls = 0;
  const upgraded = await auditResponses(options);
  assert.equal(upgraded.status, "ok");
  assert.equal(upgraded.cohort, v7Cohort);
  assert.equal(upgraded.coverage?.extractedSessions, 1);
  assert.equal(upgraded.coverage?.unchangedSessions, 0);
  assert.equal(upgraded.coverage?.evaluated, 1);
  assert.equal(calls, 3);

  // v7 report contains ONLY the newly extracted v7 verdict (score = 3), never mixed with the old v6 verdict (score = 0).
  const v7Report = seedStore.report(v7Cohort, 0);
  assert.equal(v7Report.stored, 1);
  assert.equal(v7Report.groups[0]!.fulfillmentMean, 3);
  const v6Report = seedStore.report(v6Cohort, 0);
  assert.equal(v6Report.stored, 1);
  assert.equal(v6Report.groups[0]!.fulfillmentMean, 0);

  // Subsequent pass on the unchanged transcript now hits the persisted v7 checkpoint cleanly.
  const steady = await auditResponses(options);
  assert.equal(steady.coverage?.unchangedSessions, 1);
  assert.equal(steady.coverage?.extractedSessions, 0);
  assert.equal(calls, 3);
});

test("retryFailed resets legacy status=ok rows lacking $.memory.status when linked stages are failed", async t => {
  const root = await mkdtemp(join(tmpdir(), "response-retry-legacy-"));
  const storePath = join(root, "response.sqlite");
  const store = new ResponseAuditStore(storePath); t.after(() => store.close());
  const rawDb = new DatabaseSync(storePath); t.after(() => rawDb.close());
  const cohort = responseCohort(config.responseAudit);
  const base = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const brokenLegacy = { ...base, id: "legacy-broken", inputHash: "hash-legacy-broken" };
  const healthyLegacy = { ...base, id: "legacy-healthy", inputHash: "hash-legacy-healthy" };
  store.observe(cohort, "s", [brokenLegacy, healthyLegacy]);

  const legacyJsonWithoutMemory = JSON.stringify({ agentModel: "agent-model", contextLimited: false, memorySearchCalls: 0 });
  const now = Date.now();
  for (const ep of [brokenLegacy, healthyLegacy]) {
    rawDb.prepare(`UPDATE response_results
      SET status='ok',attempts=3,attempted_at=?,assessed_at=12345,result=?
      WHERE cohort=? AND id=?`).run(now, legacyJsonWithoutMemory, cohort, ep.id);
  }
  // Broken legacy row has a failed linked 'memory' stage (so only the negated COALESCE disjunct matches it).
  rawDb.prepare("INSERT INTO response_stages(key,stage,status,attempts,attempted_at) VALUES('legacy-mem-fail','memory','failed',3,?)").run(now);
  rawDb.prepare("INSERT INTO response_stage_links(cohort,episode_id,input_hash,stage,key) VALUES(?,?,?,'memory','legacy-mem-fail')")
    .run(cohort, brokenLegacy.id, brokenLegacy.inputHash);
  // Healthy legacy row has only an ok linked stage and must remain untouched.
  rawDb.prepare("INSERT INTO response_stages(key,stage,status,attempts,attempted_at,assessed_at,result) VALUES('legacy-mem-ok','memory','ok',1,?,?,?)")
    .run(now, now, "[]");
  rawDb.prepare("INSERT INTO response_stage_links(cohort,episode_id,input_hash,stage,key) VALUES(?,?,?,'memory','legacy-mem-ok')")
    .run(cohort, healthyLegacy.id, healthyLegacy.inputHash);

  assert.deepEqual(store.retryFailed(cohort), { stages: 1, episodes: 1 });

  const brokenRow = rawDb.prepare("SELECT status,attempts,attempted_at,assessed_at,result FROM response_results WHERE id=?")
    .get(brokenLegacy.id)!;
  assert.equal(brokenRow.status, "pending");
  assert.equal(brokenRow.attempts, 0);
  assert.equal(brokenRow.attempted_at, null);
  assert.equal(brokenRow.assessed_at, null);
  assert.equal(brokenRow.result, null);

  const failedStage = rawDb.prepare("SELECT status,attempts,attempted_at FROM response_stages WHERE key='legacy-mem-fail'").get()!;
  assert.equal(failedStage.status, "pending");
  assert.equal(failedStage.attempts, 0);
  assert.equal(failedStage.attempted_at, null);

  const healthyRow = rawDb.prepare("SELECT status,attempts,assessed_at,result FROM response_results WHERE id=?")
    .get(healthyLegacy.id)!;
  assert.equal(healthyRow.status, "ok");
  assert.equal(healthyRow.attempts, 3);
  assert.equal(healthyRow.assessed_at, 12345);
  assert.equal(healthyRow.result, legacyJsonWithoutMemory);
});

test("cached retrospective complete-with-null-judgment and mismatched memory candidates are evicted and recomputed", async t => {
  const start = Date.UTC(2026, 8, 23, 12, 0, 0);
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const { db, options } = await fixture(); t.after(() => db.close());
  const root = join(options.storePath, "..");
  const source = resolveSource(root, "memory/**/*.md");
  const indexDb = new DatabaseSync(options.indexPath); t.after(() => indexDb.close());
  indexDb.exec(`CREATE TABLE documents(id INTEGER PRIMARY KEY,collection TEXT,path TEXT,hash TEXT,active INTEGER);
    CREATE TABLE content(hash TEXT PRIMARY KEY,doc TEXT);
    CREATE VIRTUAL TABLE documents_fts USING fts5(body);`);
  indexDb.prepare("INSERT INTO documents VALUES(1,?,?,?,1)").run(source.collection, "1.md", "h1");
  indexDb.prepare("INSERT INTO content VALUES(?,?)").run("h1", "Brief explanation guidelines for Atlas.");
  indexDb.prepare("INSERT INTO documents_fts(rowid,body) VALUES(1,?)").run("Brief explanation guidelines for Atlas.");

  const memConfig = resolveConfig({
    decisionModel: { apiKey: "fake-secret", timeoutMs: 1000 },
    responseAudit: { enabled: true, senderIds: ["owner"], intervalMinutes: 0, memoryCorpora: [source.corpus] },
  });
  const memOptions = { ...options, config: memConfig, sources: [source] };
  const cohort = responseCohort(memConfig.responseAudit);

  const seenRequests: string[][] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seenRequests.push(Object.keys(body.questions));
    if (body.questions.candidate_0) {
      return Response.json({ answers: { candidate_0: { type: "noul", noul: 0.85 } } });
    }
    const result = payload(body);
    if (body.questions.memoryGap) result.answers.memoryGap = { type: "noul", noul: 0.95 };
    return Response.json(result);
  });

  // Seed all 5 valid stages.
  assert.equal((await auditResponses(memOptions)).coverage?.evaluated, 1);

  const rawDb = new DatabaseSync(memOptions.storePath); t.after(() => rawDb.close());
  const store = new ResponseAuditStore(memOptions.storePath); t.after(() => store.close());
  const readStages = () => Object.fromEntries(
    rawDb.prepare("SELECT stage, key, status, assessed_at, result FROM response_stages").all()
      .map(row => [String(row.stage), {
        key: String(row.key),
        status: String(row.status),
        assessedAt: Number(row.assessed_at),
        result: String(row.result),
      }]),
  );

  // Direct validateCachedStage contract checks.
  const validRetro = JSON.parse(readStages().retrospective!.result);
  assert.throws(
    () => validateCachedStage("retrospective", { status: "complete", judgment: null }),
    /complete status requires judgment/,
  );
  assert.throws(
    () => validateCachedStage("retrospective", { status: "partial", judgment: validRetro.judgment }, { status: "complete" }),
    /mismatches expected followup status/,
  );
  assert.throws(
    () => validateCachedStage(
      "memory",
      [{ path: "qmd://memory/wrong.md", hash: "h1", usefulness: 0.85, basis: "ok" }],
      [{ path: "qmd://memory/1.md", hash: "h1" }],
    ),
    /mismatches candidate contract/,
  );
  assert.throws(
    () => validateCachedStage(
      "memory",
      [{ path: "qmd://memory/1.md", hash: "wrong-hash", usefulness: 0.85, basis: "ok" }],
      [{ path: "qmd://memory/1.md", hash: "h1" }],
    ),
    /mismatches candidate contract/,
  );
  assert.throws(
    () => validateCachedStage("memory", [], [{ path: "qmd://memory/1.md", hash: "h1" }]),
    /mismatches candidate contract/,
  );

  // 1) Retrospective stage with status="complete" and judgment:null is evicted and recomputed cleanly.
  t.mock.timers.tick(5_000);
  const beforeRetroNull = readStages();
  rawDb.prepare("UPDATE response_stages SET status='ok',result=? WHERE stage='retrospective'")
    .run(JSON.stringify({ status: "complete", judgment: null }));
  rawDb.prepare("UPDATE response_results SET status='pending',attempts=0,attempted_at=NULL,assessed_at=NULL,result=NULL").run();

  seenRequests.length = 0;
  const retroRecovered = await auditResponses(memOptions);
  assert.equal(retroRecovered.status, "ok");
  assert.equal(retroRecovered.coverage?.evaluated, 1);
  assert.equal(retroRecovered.coverage?.stageAttempts, 1);
  assert.equal(retroRecovered.coverage?.stageCacheHits, 4);
  assert.equal(seenRequests.length, 1);
  assert.ok(seenRequests[0]!.includes("outcome"));
  const afterRetroNull = readStages();
  assert.ok(afterRetroNull.retrospective!.assessedAt > beforeRetroNull.retrospective!.assessedAt);
  assert.ok(JSON.parse(afterRetroNull.retrospective!.result).judgment !== null);
  for (const sibling of ["quality", "feedback", "sentiment", "memory"]) {
    assert.equal(afterRetroNull[sibling]!.assessedAt, beforeRetroNull[sibling]!.assessedAt);
  }

  // 2) Retrospective stage with wrong followup status (partial vs complete) is evicted and recomputed cleanly.
  t.mock.timers.tick(5_000);
  const beforeRetroStatus = readStages();
  rawDb.prepare("UPDATE response_stages SET status='ok',result=? WHERE stage='retrospective'")
    .run(JSON.stringify({ status: "partial", judgment: validRetro.judgment }));
  rawDb.prepare("UPDATE response_results SET status='pending',attempts=0,attempted_at=NULL,assessed_at=NULL,result=NULL").run();

  seenRequests.length = 0;
  const retroStatusRecovered = await auditResponses(memOptions);
  assert.equal(retroStatusRecovered.coverage?.stageAttempts, 1);
  assert.equal(seenRequests.length, 1);
  assert.ok(seenRequests[0]!.includes("outcome"));
  assert.equal(JSON.parse(readStages().retrospective!.result).status, "complete");
  assert.equal(readStages().quality!.assessedAt, beforeRetroStatus.quality!.assessedAt);

  // 3) Memory stage with mismatched candidate path or hash is evicted to pending and recomputed cleanly.
  for (const badEntry of [
    { path: "qmd://memory/stale-other.md", hash: "h1", usefulness: 0.9, basis: "stale" },
    { path: `qmd://${source.collection}/1.md`, hash: "stale-hash", usefulness: 0.9, basis: "stale" },
  ]) {
    t.mock.timers.tick(5_000);
    const beforeMem = readStages();
    rawDb.prepare("UPDATE response_stages SET status='ok',result=? WHERE stage='memory'")
      .run(JSON.stringify([badEntry]));
    const saved = JSON.parse(String(rawDb.prepare("SELECT result FROM response_results").get()!.result));
    saved.memory = { status: "unavailable", candidates: [] };
    rawDb.prepare("UPDATE response_results SET status='ok',attempts=0,attempted_at=NULL,result=?").run(JSON.stringify(saved));

    seenRequests.length = 0;
    const memRecovered = await auditResponses(memOptions);
    assert.equal(memRecovered.status, "ok");
    assert.equal(memRecovered.coverage?.evaluated, 1);
    assert.equal(memRecovered.coverage?.stageAttempts, 1);
    assert.equal(seenRequests.length, 1);
    assert.deepEqual(seenRequests[0], ["candidate_0"]);
    assert.equal(store.unresolvedWork(cohort, 0, Number.MAX_SAFE_INTEGER), 0);

    const afterMem = readStages();
    assert.ok(afterMem.memory!.assessedAt > beforeMem.memory!.assessedAt);
    const parsedMem = JSON.parse(afterMem.memory!.result) as { path: string; hash: string; usefulness: number }[];
    assert.equal(parsedMem.length, 1);
    assert.equal(parsedMem[0]!.hash, "h1");
    assert.equal(parsedMem[0]!.usefulness, 0.85);
    for (const sibling of ["quality", "feedback", "sentiment", "retrospective"]) {
      assert.equal(afterMem[sibling]!.assessedAt, beforeMem[sibling]!.assessedAt);
    }
  }
});

test("review decisions reject stale or superseded evidence and record exact cohort and evidence revisions", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  options.config = { ...config, responseAudit: { ...config.responseAudit, senderIds: ["owner", "other"] } };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), result = payload(body);
    if (body.questions.underdelivery) result.answers.underdelivery = { type: "noul", noul: 0.99 };
    return Response.json(result);
  });

  await auditResponses(options);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const rawDb = new DatabaseSync(options.storePath); t.after(() => rawDb.close());
  const cohort = responseCohort(options.config.responseAudit);
  const initialTask = store.reviews.list(cohort)[0]!;
  assert.equal(initialTask.evidenceStatus, "current");
  assert.equal(initialTask.cohort, cohort);
  assert.ok(initialTask.inputHash.length > 0);
  assert.ok(initialTask.evidenceHash.length > 0);

  // Explicit revision guards reject mismatched inputHash or evidenceHash without mutating task or decision log.
  assert.throws(
    () => store.reviews.decide(cohort, initialTask.id, "dismissed", "human", "Bad input hash", Date.now(), { expectedInputHash: "wrong-hash" }),
    /input hash mismatch/,
  );
  assert.throws(
    () => store.reviews.decide(cohort, initialTask.id, "dismissed", "human", "Bad evidence hash", Date.now(), { expectedEvidenceHash: "wrong-evidence" }),
    /evidence revision mismatch/,
  );
  assert.equal(store.reviews.list(cohort, initialTask.id)[0]!.status, "pending");
  assert.equal(store.reviews.decisions(initialTask.id, cohort).length, 0);

  // Valid decision with matching revision succeeds and records cohort, input_hash, and evidence_hash.
  const recorded1 = store.reviews.decide(
    cohort,
    initialTask.id,
    "dismissed",
    "human",
    "Verified against v1 evidence",
    10_000,
    { expectedInputHash: initialTask.inputHash, expectedEvidenceHash: initialTask.evidenceHash },
  );
  assert.equal(recorded1.cohort, cohort);
  assert.equal(recorded1.inputHash, initialTask.inputHash);
  assert.equal(recorded1.evidenceHash, initialTask.evidenceHash);
  const dbDecision1 = rawDb.prepare("SELECT cohort, input_hash, evidence_hash, status FROM response_review_decisions WHERE task_id=?").get(initialTask.id)!;
  assert.equal(dbDecision1.cohort, cohort);
  assert.equal(dbDecision1.input_hash, initialTask.inputHash);
  assert.equal(dbDecision1.evidence_hash, initialTask.evidenceHash);
  assert.equal(dbDecision1.status, "dismissed");

  // Feedback changes -> new inputHash & evidenceHash; deciding again appends second provenance-bound record.
  db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=3").run(JSON.stringify({ type: "message", message: user("Updated feedback text.") }));
  await auditResponses(options);
  const refreshedTask = store.reviews.list(cohort, initialTask.id)[0]!;
  assert.equal(refreshedTask.evidenceStatus, "current");
  assert.notEqual(refreshedTask.inputHash, initialTask.inputHash);
  assert.notEqual(refreshedTask.evidenceHash, initialTask.evidenceHash);
  assert.throws(
    () => store.reviews.decide(cohort, initialTask.id, "resolved", "human", "Stale revision", 20_000, { expectedInputHash: initialTask.inputHash }),
    /input hash mismatch/,
  );
  store.reviews.decide(cohort, initialTask.id, "resolved", "human", "Resolved on v2 evidence", 20_000, {
    expectedInputHash: refreshedTask.inputHash,
    expectedEvidenceHash: refreshedTask.evidenceHash,
  });
  const history = store.reviews.decisions(initialTask.id, cohort);
  assert.equal(history.length, 2);
  assert.equal(history[0]!.inputHash, initialTask.inputHash);
  assert.equal(history[0]!.evidenceHash, initialTask.evidenceHash);
  assert.equal(history[1]!.inputHash, refreshedTask.inputHash);
  assert.equal(history[1]!.evidenceHash, refreshedTask.evidenceHash);

  // Superseded evidence (active = -1) after sender rewrite must be rejected.
  for (const seq of [1, 3]) {
    const row = db.prepare("SELECT event_json FROM transcript_events WHERE seq=?").get(seq)!;
    const event = JSON.parse(String(row.event_json));
    event.message.__openclaw.senderId = "other";
    db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=?").run(JSON.stringify(event), seq);
  }
  await auditResponses(options);
  const allTasks = store.reviews.list(cohort);
  const superseded = allTasks.find(x => x.id === initialTask.id)!;
  const replacement = allTasks.find(x => x.id !== initialTask.id)!;
  assert.equal(superseded.evidenceStatus, "superseded");
  assert.equal(replacement.evidenceStatus, "current");
  assert.throws(
    () => store.reviews.decide(cohort, superseded.id, "deferred", "human", "Must fail on superseded", 30_000),
    /superseded evidence/,
  );
  assert.equal(store.reviews.decisions(superseded.id, cohort).length, 2);

  // Replacement task with current evidence can still be decided.
  store.reviews.decide(cohort, replacement.id, "resolved", "human", "Resolved replacement", 35_000);
  assert.equal(store.reviews.decisions(replacement.id, cohort).length, 1);

  // Stale evidence (active = 0) after removing active transcript events must be rejected.
  db.exec("DELETE FROM session_transcript_active_events");
  await auditResponses(options);
  assert.equal(store.reviews.list(cohort, replacement.id)[0]!.evidenceStatus, "stale");
  assert.throws(
    () => store.reviews.decide(cohort, replacement.id, "dismissed", "human", "Must fail on stale", 40_000),
    /stale evidence/,
  );
  assert.equal(store.reviews.decisions(replacement.id, cohort).length, 1);
});

test("report trends group by stratum in linear time and pair exact previous periods across weeks and strata", async t => {
  const { db, options } = await fixture(); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => Response.json(payload(JSON.parse(String(init.body)))));
  const e = responseEpisodes(session, basic(), config.responseAudit).episodes[0]!;
  const params = { apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal };
  const judgment = await judgeResponse(e, params);
  const retrospective = await judgeResponseFollowup(e, params);
  const store = new ResponseAuditStore(options.storePath); t.after(() => store.close());
  const cohort = responseCohort(config.responseAudit);

  const weeks = [Date.UTC(2026, 8, 7), Date.UTC(2026, 8, 14), Date.UTC(2026, 8, 21)];
  const models = ["model-a", "model-b"] as const;
  const episodes: typeof e[] = [];
  for (const model of models) {
    for (const [wIdx, ts] of weeks.entries()) {
      for (let i = 0; i < 20; i++) {
        episodes.push({ ...e, id: `${model}-w${wIdx}-${i}`, inputHash: `h-${model}-${wIdx}-${i}`, timestamp: ts + i });
      }
    }
  }
  store.observe(cohort, "s", episodes);
  for (const ep of episodes) {
    const isModelA = ep.id.startsWith("model-a");
    const wIdx = Number(ep.id.split("-")[2]!.slice(1));
    const quality = structuredClone(judgment.quality);
    const later = structuredClone(retrospective);
    later.judgment!.outcome.choice = "acknowledged_success";
    const score = isModelA ? wIdx + 1 : 3 - wIdx; // model-a: 1 -> 2 -> 3; model-b: 3 -> 2 -> 1
    quality.fulfillment = {
      type: "score",
      score,
      confidence: 0.95,
      probabilities: { "0": 0, "1": score === 1 ? 1 : 0, "2": score === 2 ? 1 : 0, "3": score === 3 ? 1 : 0 },
    };
    store.save(cohort, ep, {
      ...judgment,
      quality,
      retrospective: later,
      references: { sessionId: "s", request: [1], answer: [2], feedback: [3], followup: [4], inputHash: ep.inputHash },
      agentModel: isModelA ? "model-a" : "model-b",
      contextLimited: false,
      memorySearchCalls: 0,
      memory: { status: "not_requested", candidates: [] },
    }, Date.now());
  }

  const report = store.report(cohort, 0);
  // 2 strata * 2 week-over-week transitions * 10 dimensions = 40 trend rows.
  assert.equal(report.trends.length, 40);
  const fulfillmentTrends = report.trends.filter(tr => tr.dimension === "fulfillment");
  assert.deepEqual(
    fulfillmentTrends.map(tr => [tr.agentModel, tr.fromWeek, tr.toWeek, tr.delta, tr.status]),
    [
      ["model-a", "2026-09-14", "2026-09-21", 1, "descriptive_comparison"],
      ["model-b", "2026-09-14", "2026-09-21", -1, "descriptive_comparison"],
      ["model-a", "2026-09-07", "2026-09-14", 1, "descriptive_comparison"],
      ["model-b", "2026-09-07", "2026-09-14", -1, "descriptive_comparison"],
    ],
  );
});

test("memory-responses review CLI requires --evidence-hash and rejects stale evidence hashes after evidence replacement", async t => {
  const root = await mkdtemp(join(tmpdir(), "response-cli-review-"));
  const agentDir = join(root, "agents/main/agent");
  await mkdir(agentDir, { recursive: true });
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
  });

  const db = createAgentDatabase(join(agentDir, "openclaw-agent.sqlite"));
  t.after(() => db.close());
  insertSession(db, { sessionId: "s", chatType: "direct" });
  for (const [i, row] of basic().entries()) {
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("s", row.seq, row.eventJson, row.createdAt);
    db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run("s", i, row.seq, i);
  }

  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const result = payload(body);
    if (body.questions.underdelivery) result.answers.underdelivery = { type: "noul", noul: 0.99 };
    return Response.json(result);
  });

  const commanderPath = createRequire(import.meta.resolve("openclaw/plugin-sdk/session-store-runtime")).resolve("commander");
  const { Command } = await import(pathToFileURL(commanderPath).href) as {
    Command: new () => {
      exitOverride(): unknown;
      configureOutput(opts: { writeOut?: (s: string) => void; writeErr?: (s: string) => void }): unknown;
      parseAsync(argv: string[]): Promise<unknown>;
    };
  };

  const hostConfig = { agents: { entries: { main: { agentDir, workspace: root } } } } as unknown as OpenClawConfig;
  const runCli = async (args: string[]): Promise<unknown> => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut() {}, writeErr() {} });
    const api = {
      config: hostConfig,
      registerCli: (fn: (ctx: { program: unknown; config: OpenClawConfig }) => void) => fn({ program, config: hostConfig }),
      on() {},
    } as unknown as OpenClawPluginApi;
    registerResponseAudit(api, config);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
    try {
      await program.parseAsync(["node", "openclaw", "memory-responses", ...args]);
    } finally {
      console.log = origLog;
    }
    return lines.length > 0 ? JSON.parse(lines.at(-1)!) : undefined;
  };

  const audit1 = await runCli(["audit", "--agent", "main"]) as { status: string };
  assert.equal(audit1.status, "ok");

  const tasks1 = await runCli(["tasks", "--agent", "main"]) as {
    tasks: Array<{ id: string; status: string; inputHash: string; evidenceHash: string; evidenceStatus: string }>;
    capped: boolean;
  };
  assert.equal(tasks1.tasks.length, 1);
  const oldTask = tasks1.tasks[0]!;
  assert.equal(oldTask.evidenceStatus, "current");
  assert.equal(oldTask.status, "pending");
  assert.ok(oldTask.evidenceHash.length > 0);

  // Missing --evidence-hash must be rejected by the CLI before deciding.
  await assert.rejects(
    runCli(["review", "--agent", "main", "--id", oldTask.id, "--status", "dismissed", "--reviewer", "human", "--note", "Missing hash"]),
    /evidence-hash/,
  );

  // Replace evidence under the same task ID (updated feedback -> new inputHash & evidenceHash).
  db.prepare("UPDATE transcript_events SET event_json=? WHERE seq=3")
    .run(JSON.stringify({ type: "message", message: user("Updated feedback after evidence A.") }));
  const audit2 = await runCli(["audit", "--agent", "main"]) as { status: string };
  assert.equal(audit2.status, "ok");

  const tasks2 = await runCli(["tasks", "--agent", "main", "--id", oldTask.id]) as {
    tasks: Array<{ id: string; status: string; inputHash: string; evidenceHash: string; evidenceStatus: string }>;
  };
  assert.equal(tasks2.tasks.length, 1);
  const newTask = tasks2.tasks[0]!;
  assert.equal(newTask.id, oldTask.id);
  assert.equal(newTask.evidenceStatus, "current");
  assert.notEqual(newTask.evidenceHash, oldTask.evidenceHash);
  assert.notEqual(newTask.inputHash, oldTask.inputHash);

  // Submitting a review with the old evidence hash must reject without mutating task state or decision log.
  await assert.rejects(
    runCli([
      "review", "--agent", "main", "--id", oldTask.id, "--evidence-hash", oldTask.evidenceHash,
      "--status", "dismissed", "--reviewer", "human", "--note", "Stale dismissal against evidence A",
    ]),
    /evidence revision mismatch/,
  );

  const storePath = join(root, "agents/main/unblock-memory/unblock-memory.sqlite");
  const cohort = responseCohort(config.responseAudit, config.decisionModel.model, config.decisionModel.endpoint);
  const store = new ResponseAuditStore(storePath);
  t.after(() => store.close());
  assert.equal(store.reviews.list(cohort, oldTask.id)[0]!.status, "pending");
  assert.equal(store.reviews.decisions(oldTask.id, cohort).length, 0);

  // Submitting a review with the new evidence hash succeeds and records the new evidence hash.
  const reviewed = await runCli([
    "review", "--agent", "main", "--id", oldTask.id, "--evidence-hash", newTask.evidenceHash,
    "--status", "dismissed", "--reviewer", "human", "--note", "Verified dismissal against evidence B",
  ]) as Array<{ id: string; status: string; evidenceHash: string }>;
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0]!.id, oldTask.id);
  assert.equal(reviewed[0]!.status, "dismissed");
  assert.equal(reviewed[0]!.evidenceHash, newTask.evidenceHash);

  const decisions = store.reviews.decisions(oldTask.id, cohort);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.status, "dismissed");
  assert.equal(decisions[0]!.reviewerKind, "human");
  assert.equal(decisions[0]!.note, "Verified dismissal against evidence B");
  assert.equal(decisions[0]!.cohort, cohort);
  assert.equal(decisions[0]!.inputHash, newTask.inputHash);
  assert.equal(decisions[0]!.evidenceHash, newTask.evidenceHash);
});
