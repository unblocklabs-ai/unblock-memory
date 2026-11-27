import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { ExpectationsStore, listExpectations, type ExpectationInput } from "../src/expectations-store.js";
import { resolveStewardConfig } from "../src/steward-config.js";
import {
  EXPECTATIONS_KIND, runExpectationsPass, type ExpectationExtraction, type ExpectationSweep, type ExpectationsPassOptions,
} from "../src/steward-expectations.js";
import { createStewardRunner } from "../src/steward-runner.js";
import { WorkStore } from "../src/work-store.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

const MINUTE = 60_000;
const START = Date.parse("2026-11-27T17:00:00Z");
const INTERVAL = 60 * MINUTE;
const config = resolveStewardConfig(undefined);

type Session = { ref: string; chatType: string; channel?: string; messages: { role: string; at: string; text: string }[] };
type ExtractionPrompt = { nowIso: string; audience: string; openExpectations: unknown[]; sessions: Session[] };
type SweepPrompt = { nowIso: string; expectations: { ref: string; kind: string; summary: string }[]; sessions: Session[] };
type Prompt = { kind: "extract"; prompt: ExtractionPrompt } | { kind: "sweep"; prompt: SweepPrompt };
type Responder = {
  extract?: (prompt: ExtractionPrompt) => ExpectationExtraction | Response | Promise<ExpectationExtraction | Response>;
  sweep?: (prompt: SweepPrompt) => ExpectationSweep | Response | Promise<ExpectationSweep | Response>;
};

function provider(responder: Responder) {
  const prompts: Prompt[] = [];
  const systems: string[] = [];
  const runner = createStewardRunner({ config, resolveApiKey: async () => "test-provider-credential", fetch: async (_url, init) => {
    const request: { instructions?: string; input: [{ content: string }] } = JSON.parse(String(init?.body));
    systems.push(request.instructions ?? "");
    const parsed = JSON.parse(request.input[0].content) as Record<string, unknown>;
    let value: unknown;
    if ("expectations" in parsed) {
      prompts.push({ kind: "sweep", prompt: parsed as SweepPrompt });
      value = await (responder.sweep?.(parsed as SweepPrompt) ?? { judgments: [] });
    } else {
      prompts.push({ kind: "extract", prompt: parsed as ExtractionPrompt });
      value = await (responder.extract?.(parsed as ExtractionPrompt) ?? { expectations: [] });
    }
    if (value instanceof Response) return value;
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
  } });
  return { runner, prompts, systems };
}

function fixture(t: TestContext, responder: Responder = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "steward-expectations-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const workStore = new WorkStore(join(root, "memory.sqlite"));
  let agentDb: DatabaseSync | undefined;
  let time = START;
  t.after(() => { agentDb?.close(); workStore.close(); rmSync(root, { recursive: true, force: true }); });
  const database = () => (agentDb ??= createAgentDatabase(databasePath));
  const { runner, prompts, systems } = provider(responder);
  const run = (overrides: Partial<ExpectationsPassOptions> = {}) => runExpectationsPass({
    agentId: "main", owner: "test-owner", workStore, runner, databasePath, timezone: "America/New_York", now: () => time, ...overrides,
  });
  const seed = (sessionId: string, text: string, chatType: "direct" | "channel" | "group" = "channel", at = START - MINUTE, seq = 1) => {
    if (seq === 1) insertSession(database(), { sessionId, chatType });
    const event = { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
    database().prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run(sessionId, seq, JSON.stringify(event), at);
    database().prepare("INSERT INTO session_transcript_active_events VALUES (?, ?, ?, ?)").run(sessionId, seq - 1, seq, seq - 1);
  };
  const store = new ExpectationsStore(workStore.db);
  const expect = (overrides: Partial<ExpectationInput>) => store.upsertExpectation({
    agentId: "main", dedupKey: "manual:x", kind: "commitment", sourceKind: "manual", sourceRef: "operator", audienceKey: "workspace",
    chatType: "workspace", summary: "Ship the Acme invoice fix", expectedState: "Acme invoices render correctly", nowMs: START - 2 * 24 * 60 * MINUTE,
    ...overrides,
  }).expectation;
  const rows = () => listExpectations(workStore.db, { agentId: "main" });
  const item = () => workStore.get(EXPECTATIONS_KIND, "main");
  const promptText = () => JSON.stringify(prompts);
  return { root, databasePath, workStore, database, run, seed, expect, rows, item, prompts, systems, promptText,
    advance: (ms: number) => { time += ms; } };
}

function addCaptainsLogBlocker(db: DatabaseSync, id: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS captains_log_entries (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, day TEXT NOT NULL, captured_at_ms INTEGER NOT NULL, section_hash TEXT NOT NULL,
    ordinal INTEGER NOT NULL, topic TEXT NOT NULL, summary TEXT NOT NULL, blocked INTEGER NOT NULL CHECK(blocked IN (0, 1)),
    resolved_at_ms INTEGER, resolution_note TEXT, channels_json TEXT NOT NULL CHECK(json_valid(channels_json)),
    session_refs_json TEXT NOT NULL CHECK(json_valid(session_refs_json))) STRICT;
    CREATE TABLE IF NOT EXISTS people_todos (
    id TEXT PRIMARY KEY, deduplication_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, context_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'overflow')),
    occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0), first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    resolved_at TEXT, resolution_note TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, status TEXT NOT NULL, injection_enabled INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO people VALUES ('person-1', 'active', 1);`);
  db.prepare("INSERT INTO captains_log_entries VALUES (?, 'main', '2026-11-27', ?, 'h', 0, 'Shopify quota', 'Acme sync blocked', 1, NULL, NULL, ?, '[]')")
    .run(id, START - MINUTE, JSON.stringify(["#acme-ops"]));
  db.prepare("INSERT INTO people_todos VALUES ('todo-1', 'k1', 'missing_dossier', ?, 'open', 1, 'x', 'x', NULL, NULL)")
    .run(JSON.stringify({ personId: "person-1" }));
}

test("deterministic-only pass runs with no runner, no model cost, and survives a model outage", async t => {
  const f = fixture(t, { extract: () => new Response("boom", { status: 400 }) });
  addCaptainsLogBlocker(f.workStore.db, "blocker-1");
  const result = await f.run({ runner: undefined });
  assert.equal(result.status, "deterministic_only");
  assert.equal(result.nextDueAt, START + INTERVAL);
  assert.equal(result.deterministic?.captainsLog.upserted, 1);
  assert.equal(result.deterministic?.peopleTodos.upserted, 1);
  assert.deepEqual(f.rows().map(row => row.dedupKey).sort(), ["captains_log_topic:shopify quota", "people_todo:todo-1"]);
  assert.equal(f.prompts.length, 0);
  assert.equal((await f.run({ runner: undefined })).status, "not_due");

  f.workStore.db.exec("UPDATE captains_log_entries SET resolved_at_ms=1, resolution_note='Quota raised'");
  f.seed("public", "We will ship the Acme fix today.");
  f.advance(INTERVAL);
  const failed = await f.run();
  assert.equal(failed.status, "failed");
  assert.equal(failed.deterministic?.captainsLog.resolved, 1, "deterministic writes commit before the model call");
  assert.equal(f.rows().find(row => row.dedupKey === "captains_log_topic:shopify quota")?.status, "kept");
  assert.equal(f.item()?.strikes, 0);
  assert.equal(f.item()?.artifactJson, null, "the session watermark does not move on failure");

  f.advance(INTERVAL);
  assert.equal((await f.run({ databasePath: undefined })).status, "deterministic_only", "a runner without a database is deterministic-only");
});

test("extracts grounded commitments and predictions, dropping hallucinated refs, and never re-reads seen messages", async t => {
  // One call per conversation audience: answer from whichever conversation this call carries.
  const f = fixture(t, { extract: prompt => ({ expectations: JSON.stringify(prompt.sessions).includes("Priya") ? [
    { kind: "commitment", summary: "Priya ships the Acme invoice fix", expectedState: "Acme invoices render correctly",
      dueAt: "2026-11-28T17:00:00Z", subjectLabel: "Priya", keywords: ["invoice", "acme"], sessionRefs: ["s1", "s99"] },
    { kind: "commitment", summary: "Invented promise", expectedState: "Nothing", sessionRefs: ["s99"] },
    { kind: "blocker", summary: "Unreferenced blocker", expectedState: "Nothing", sessionRefs: [] },
  ] : [
    { kind: "prediction", summary: "Black Friday traffic doubles for Sakara", expectedState: "Sakara sessions >= 2x baseline",
      dueAt: "not a date", sessionRefs: ["s1"] },
  ] }) });
  f.seed("public", "Priya: I'll ship the Acme invoice fix by tomorrow noon. api_key=sk-live-SECRET", "channel", START - 2 * MINUTE);
  f.seed("group-chat", "Expect Sakara traffic to double on Black Friday.", "group");
  f.seed("private", "PRIVATE_DM_MARKER I promise to call you", "direct");

  const result = await f.run();
  assert.equal(result.status, "completed");
  assert.equal(result.sessions, 2);
  assert.equal(result.extracted, 2);
  assert.ok(!f.promptText().includes("PRIVATE_DM_MARKER"), "DMs are excluded by default");
  assert.ok(!f.promptText().includes("sk-live-SECRET"), "secrets are redacted before the model");
  const [commitment, prediction] = [f.rows().find(row => row.kind === "commitment")!, f.rows().find(row => row.kind === "prediction")!];
  assert.equal(f.rows().length, 2, "ungrounded items are dropped");
  assert.equal(commitment.sourceKind, "session_steward");
  assert.equal(commitment.audienceKey, "channel:slack:workspace:native-public", "each conversation is its own audience");
  assert.equal(commitment.chatType, "channel");
  assert.equal(commitment.channel, "label-public");
  assert.equal(commitment.sourceRef, "public");
  assert.equal(commitment.dueAtMs, Date.parse("2026-11-28T17:00:00Z"));
  assert.equal(commitment.subjectLabel, "Priya");
  assert.deepEqual(commitment.evidence, { source: "session_steward", sessionRefs: ["public"], extractedAtMs: START });
  assert.deepEqual(commitment.triggerSpec, { channels: ["label-public", "native-public"], keywords: ["invoice", "acme"],
    dueLeadMs: 60 * MINUTE });
  assert.equal(prediction.chatType, "group");
  assert.equal(prediction.audienceKey, "group:slack:workspace:native-group-chat", "a group is never pooled into workspace");
  assert.equal(prediction.dueAtMs, null);
  assert.deepEqual(JSON.parse(f.item()!.artifactJson!).sessionMaxSeq, { public: 1, "group-chat": 1 });

  f.advance(INTERVAL);
  const replay = await f.run();
  assert.equal(replay.status, "empty", "the watermark prevents re-reading");
  assert.equal(f.prompts.length, 2, "one extraction call per conversation audience");
  assert.ok(f.prompts.every(p => p.kind === "extract" && p.prompt.sessions.length === 1));
  f.seed("public", "Follow-up: still on track for the Acme fix.", "channel", START + INTERVAL - MINUTE, 2);
  f.advance(INTERVAL);
  assert.equal((await f.run()).status, "completed");
  const second = f.prompts.at(-1);
  assert.equal(second?.kind, "extract");
  assert.deepEqual(second?.kind === "extract" && second.prompt.sessions.map(s => s.messages.map(m => m.text)),
    [["Follow-up: still on track for the Acme fix."]]);
  assert.equal(second?.kind === "extract" && second.prompt.openExpectations.length, 1, "only this audience's open expectations are offered");
});

test("due sweep resolves kept (0.1) and broken (0.9), maps prediction verdicts and leaves young items alone", async t => {
  const f = fixture(t, { sweep: prompt => ({ judgments: [
    { ref: "e1", verdict: "kept", surpriseScore: 0.1, resolutionNote: "Fix shipped and confirmed in #acme.", sessionRefs: ["s1"] },
    { ref: "e2", verdict: "broken", surpriseScore: 0.9, resolutionNote: "Deadline missed; vendor never replied.", sessionRefs: ["s1", "s42"] },
    { ref: "e3", verdict: "kept", surpriseScore: 0.3, resolutionNote: "Traffic doubled as predicted.", sessionRefs: ["s1"] },
    { ref: "e1", verdict: "broken", surpriseScore: 1, resolutionNote: "Duplicate judgment ignored", sessionRefs: ["s1"] },
    { ref: "e9", verdict: "broken", surpriseScore: 1, resolutionNote: "Hallucinated item", sessionRefs: ["s1"] },
    ...(prompt.expectations.length > 3 ? [{ ref: "e4", verdict: "broken" as const, surpriseScore: 0.5, resolutionNote: "No evidence", sessionRefs: ["s7"] }] : []),
  ] }) });
  const overdue = f.expect({ dedupKey: "overdue", dueAtMs: START - 10 * MINUTE });
  const dueSoon = f.expect({ dedupKey: "due-soon", summary: "Vendor sends the contract", dueAtMs: START + 30 * MINUTE, nowMs: START - 5 * MINUTE });
  const aging = f.expect({ dedupKey: "aging", kind: "prediction", summary: "Traffic doubles" });
  const ungrounded = f.expect({ dedupKey: "ungrounded", summary: "Ungrounded verdict", nowMs: START - 2 * 24 * 60 * MINUTE + 1 });
  const young = f.expect({ dedupKey: "young", summary: "Fresh, far-future item", dueAtMs: START + 7 * 24 * 60 * MINUTE, nowMs: START - MINUTE });
  f.seed("public", "Shipped the Acme invoice fix; vendor still silent on the contract.");

  const result = await f.run();
  assert.equal(result.status, "completed");
  assert.equal(result.swept, 4);
  assert.equal(result.resolved, 3);
  const sweep = f.prompts.find(p => p.kind === "sweep");
  assert.deepEqual(sweep?.kind === "sweep" && sweep.prompt.expectations.map(e => e.summary),
    [overdue.summary, dueSoon.summary, aging.summary, ungrounded.summary]);
  const byId = new Map(f.rows().map(row => [row.id, row]));
  assert.equal(byId.get(overdue.id)?.status, "kept");
  assert.equal(byId.get(overdue.id)?.surpriseScore, 0.1);
  assert.deepEqual(byId.get(overdue.id)?.resolutionEvidence, { source: "steward_sweep", sessionRefs: ["public"] });
  assert.equal(byId.get(dueSoon.id)?.status, "broken");
  assert.equal(byId.get(dueSoon.id)?.surpriseScore, 0.9);
  assert.equal(byId.get(dueSoon.id)?.resolutionNote, "Deadline missed; vendor never replied.");
  assert.equal(byId.get(aging.id)?.status, "right", "predictions resolve right/wrong");
  assert.equal(byId.get(ungrounded.id)?.status, "open", "verdicts without grounded refs are ignored");
  assert.equal(byId.get(young.id)?.status, "open");

  f.advance(INTERVAL);
  const quiet = await f.run();
  assert.equal(quiet.status, "empty", "no fresh evidence → no sweep call");
  assert.equal(f.prompts.filter(p => p.kind === "sweep").length, 1);
});

test("DM privacy boundary: workspace sweeps never see DMs and each DM stays in its own audience", async t => {
  const f = fixture(t, {
    extract: prompt => ({ expectations: [{ kind: "commitment", summary: `Follow up (${prompt.audience})`, expectedState: "Done",
      sessionRefs: ["s1"] }] }),
    sweep: () => ({ judgments: [] }),
  });
  f.seed("public", "PUBLIC_MARKER we will launch Monday.");
  f.seed("dm-a", "DM_A_MARKER I'll send you the deck.", "direct");
  f.seed("dm-b", "DM_B_MARKER call me tomorrow.", "direct");
  f.seed("dm-anon", "DM_ANON_MARKER no identity", "direct");
  f.database().exec("UPDATE conversations SET peer_id=NULL WHERE conversation_id='conversation-dm-anon'");
  f.expect({ dedupKey: "workspace-aging", summary: "Workspace item" });
  f.expect({ dedupKey: "dm-a-aging", summary: "DM A item", audienceKey: "direct:slack:workspace:peer-dm-a", chatType: "direct" });

  // Default: DMs excluded entirely, so the DM expectation is never swept against anything.
  await f.run();
  assert.ok(!/DM_[AB]_MARKER|DM_ANON_MARKER|DM A item/u.test(f.promptText()));
  assert.ok(f.promptText().includes("PUBLIC_MARKER"));

  // Opted in: every audience gets its own extraction and sweep call.
  f.prompts.length = 0;
  f.workStore.db.exec("DELETE FROM work_items");
  const result = await f.run({ excludeChatTypes: [] });
  assert.equal(result.status, "completed");
  assert.equal(result.sessions, 3, "a DM without sender identity is skipped, never pooled");
  assert.ok(!f.promptText().includes("DM_ANON_MARKER"));
  for (const { kind, prompt } of f.prompts) {
    const text = JSON.stringify(prompt);
    const audiences = [/PUBLIC_MARKER|Workspace item/u.test(text), /DM_A_MARKER|DM A item/u.test(text), /DM_B_MARKER/u.test(text)];
    assert.equal(audiences.filter(Boolean).length, 1, `${kind} prompt mixes audiences: ${text}`);
  }
  assert.equal(f.prompts.filter(p => p.kind === "extract").length, 3);
  const sweeps = f.prompts.filter(p => p.kind === "sweep");
  assert.equal(sweeps.length, 2, "dm-b has evidence but no candidates");
  const dmRows = f.rows().filter(row => row.sourceKind === "session_steward" && row.chatType === "direct");
  assert.deepEqual(dmRows.map(row => row.audienceKey).sort(), ["direct:slack:workspace:peer-dm-a", "direct:slack:workspace:peer-dm-b"]);
  for (const row of dmRows) {
    assert.equal(row.channel, null);
    assert.deepEqual(row.triggerSpec.senderIds, [row.audienceKey.split(":")[3]]);
  }
  const channel = f.rows().find(row => row.sourceKind === "session_steward" && row.audienceKey === "channel:slack:workspace:native-public");
  assert.equal(channel?.summary, "Follow up (channel)");
});

test("a lost fence during inference never writes extracted rows, resolutions or the watermark", async t => {
  let store: WorkStore | undefined;
  const f = fixture(t, {
    extract: () => {
      store!.interruptOwner("test-owner", START);
      return { expectations: [{ kind: "commitment", summary: "Should never persist", expectedState: "x", sessionRefs: ["s1"] }] };
    },
    sweep: () => ({ judgments: [{ ref: "e1", verdict: "kept", surpriseScore: 0, resolutionNote: "x", sessionRefs: ["s1"] }] }),
  });
  store = f.workStore;
  const aging = f.expect({ dedupKey: "aging" });
  addCaptainsLogBlocker(f.workStore.db, "blocker-1");
  f.seed("public", "We will ship it.");
  const result = await f.run({ heartbeatMs: 1 });
  assert.deepEqual([result.status, result.status === "failed" && result.reason], ["failed", "fence_lost"]);
  assert.equal(result.extracted, 0);
  assert.equal(result.resolved, 0);
  assert.ok(!f.rows().some(row => row.sourceKind === "session_steward"));
  assert.equal(f.rows().find(row => row.id === aging.id)?.status, "open");
  assert.ok(f.rows().some(row => row.dedupKey === "captains_log_topic:shopify quota"), "the fenced deterministic step had already committed");
  assert.equal(f.item()?.artifactJson, null);
  assert.equal(f.item()?.status, "pending");
});

test("zero means unlimited for sessions, characters and sweep items; explicit caps still apply", async t => {
  const f = fixture(t, { sweep: () => ({ judgments: [] }) });
  const long = "Commitment detail. ".repeat(2_000);
  for (let i = 0; i < 30; i++) f.seed(`session-${String(i).padStart(2, "0")}`, `${i}: ${long}`);
  for (let i = 0; i < 25; i++) f.expect({ dedupKey: `aging-${i}`, summary: `Aging item ${i}` });

  await f.run({ maxSessionsPerRun: 0, maxCharsPerSession: 0, maxSweepItems: 0, timeoutMs: 0 });
  const extracts = f.prompts.flatMap(p => p.kind === "extract" ? p.prompt.sessions : []);
  assert.equal(extracts.length, 30);
  assert.ok(extracts.every(s => s.messages[0]!.text.length > long.length - 10));
  const sweep = f.prompts.find(p => p.kind === "sweep");
  assert.equal(sweep?.kind === "sweep" && sweep.prompt.expectations.length, 25);

  f.prompts.length = 0;
  f.workStore.db.exec("DELETE FROM work_items");
  await f.run({ maxSessionsPerRun: 2, maxCharsPerSession: 100, maxSweepItems: 3 });
  const capped = f.prompts.flatMap(p => p.kind === "extract" ? p.prompt.sessions : []);
  assert.equal(capped.length, 2);
  assert.ok(capped.every(s => s.messages[0]!.text.length <= 100));
  const cappedSweep = f.prompts.find(p => p.kind === "sweep");
  assert.equal(cappedSweep?.kind === "sweep" && cappedSweep.prompt.expectations.length, 3);

  await assert.rejects(() => f.run({ maxSweepItems: -1 }), /maxSweepItems/);
  await assert.rejects(() => f.run({ intervalMinutes: 0 }), /intervalMinutes/);
});

test("a maxSessionsPerRun-capped pass never skips the unread sessions, even after the lookback has moved on", async t => {
  const f = fixture(t, { extract: () => ({ expectations: [] }) });
  for (const id of ["a", "b", "c"]) f.seed(`capped-${id}`, `Session ${id}: we will ship the ${id} fix.`, "channel", START - 10 * MINUTE);
  const seen: string[] = [];
  const read = () => seen.push(...f.prompts.splice(0).flatMap(p => p.kind === "extract" ? p.prompt.sessions.map(s => s.messages[0]!.text) : []));
  for (let pass = 0; pass < 3; pass++) {
    const result = await f.run({ maxSessionsPerRun: 1 });
    assert.equal(result.sessions, 1);
    read();
    f.advance(3 * INTERVAL); // Far past lookbackMinutes (70): only the held watermark keeps the old window.
  }
  assert.deepEqual(seen.sort(), ["Session a: we will ship the a fix.", "Session b: we will ship the b fix.", "Session c: we will ship the c fix."]);
  assert.equal((await f.run({ maxSessionsPerRun: 1 })).status, "empty");
  assert.ok(JSON.parse(f.item()!.artifactJson!).lastCapturedAtMs > START, "a drained window finally advances the watermark");
});

test("the sweep sees an early completion recorded before the item became due, after extraction consumed it", async t => {
  const f = fixture(t, { sweep: prompt => ({ judgments: JSON.stringify(prompt.sessions).includes("Shipped the Acme invoice fix")
    ? [{ ref: "e1", verdict: "kept", surpriseScore: 0, resolutionNote: "Shipped early.", sessionRefs: ["s1"] }] : [] }) });
  const item = f.expect({ dedupKey: "early", dueAtMs: START + 3 * INTERVAL, nowMs: START - 10 * MINUTE });
  f.seed("public", "Shipped the Acme invoice fix already.", "channel", START - 5 * MINUTE);
  const first = await f.run();
  assert.equal(first.swept, 0, "not yet due, not aging");
  assert.equal(JSON.parse(f.item()!.artifactJson!).sessionMaxSeq.public, 1, "extraction consumed the message");

  f.advance(2 * INTERVAL + 30 * MINUTE); // Now within dueLeadMinutes of its deadline.
  const second = await f.run();
  assert.equal(second.swept, 1);
  assert.equal(f.rows().find(row => row.id === item.id)?.status, "kept");
  const sweep = f.prompts.find(p => p.kind === "sweep");
  assert.equal(sweep?.kind === "sweep" && sweep.prompt.sessions[0]!.messages[0]!.at, new Date(START - 5 * MINUTE).toISOString());

  // Once swept, the next pass only reads evidence recorded after that sweep.
  const other = f.expect({ dedupKey: "still-open", summary: "Still open", dueAtMs: START + 3 * INTERVAL, nowMs: START - 10 * MINUTE });
  f.advance(INTERVAL);
  await f.run();
  const last = f.prompts.filter(p => p.kind === "sweep").at(-1);
  assert.ok(last?.kind === "sweep" && last.prompt.expectations.some(e => e.summary === other.summary));
  f.advance(INTERVAL);
  const quiet = await f.run();
  assert.equal(quiet.status, "empty", "no evidence since the last sweep → no sweep call");
});

test("a clock-only expired verdict needs an actually passed deadline; undated or future items stay open", async t => {
  const f = fixture(t, { sweep: () => ({ judgments: ["e1", "e2", "e3"].map(ref =>
    ({ ref, verdict: "expired" as const, surpriseScore: 0.2, resolutionNote: "No longer relevant.", sessionRefs: [] })) }) });
  const past = f.expect({ dedupKey: "past", summary: "Past deadline", dueAtMs: START - 10 * MINUTE });
  const soon = f.expect({ dedupKey: "soon", summary: "Due soon", dueAtMs: START + 30 * MINUTE });
  const undated = f.expect({ dedupKey: "undated", summary: "Undated aging item" });
  f.seed("public", "Unrelated chatter about lunch plans.");
  const result = await f.run();
  assert.equal(result.swept, 3);
  const byId = new Map(f.rows().map(row => [row.id, row.status]));
  assert.equal(byId.get(past.id), "expired");
  assert.equal(byId.get(soon.id), "open");
  assert.equal(byId.get(undated.id), "open");
});

test("extraction messages carry ISO timestamps so relative deadlines anchor to when they were said", async t => {
  const said = START - 26 * INTERVAL; // Yesterday, caught up from the watermark after downtime.
  const f = fixture(t);
  f.seed("public", "I'll send the Acme contract tomorrow. Webhook: https://hooks.slack.com/services/T0AAA/B0BBB/xyzSECRET123", "channel", said);
  await f.run({ lookbackMinutes: 30 * 60 });
  const extract = f.prompts.find(p => p.kind === "extract");
  assert.equal(extract?.kind === "extract" && extract.prompt.sessions[0]!.messages[0]!.at, new Date(said).toISOString());
  assert.match(f.systems[0] ?? "", /anchor relative deadlines[^.]*"at" timestamp of the message/u);
  assert.ok(!f.promptText().includes("xyzSECRET123"), "Slack incoming webhook URLs are redacted");
  assert.ok(!f.promptText().includes("hooks.slack.com"));
});

test("a swept Captain's Log blocker writes back to its ledger entries; group evidence never reaches workspace items", async t => {
  const f = fixture(t, { sweep: prompt => ({ judgments: prompt.expectations.filter(e => e.summary.includes("Shopify")).map(e =>
    ({ ref: e.ref, verdict: "kept" as const, surpriseScore: 0.1, resolutionNote: "Shopify raised the Acme quota.", sessionRefs: ["s1"] })) }) });
  addCaptainsLogBlocker(f.workStore.db, "blocker-1");
  f.workStore.db.prepare(`INSERT INTO captains_log_entries VALUES ('blocker-2', 'main', '2026-11-27', ?, 'h2', 0, 'Shopify quota!',
    'Still blocked', 1, NULL, NULL, '[]', '[]')`).run(START);
  assert.equal((await f.run({ runner: undefined })).status, "deterministic_only");
  assert.equal(f.rows().filter(row => row.sourceKind === "captains_log").length, 1, "recurring captures share one row");

  f.seed("public", "Shopify raised the Acme quota; sync is running again.", "channel", START + 10 * MINUTE);
  f.seed("mpdm", "GROUP_SECRET_MARKER quota chatter", "group", START + 10 * MINUTE);
  f.advance(INTERVAL);
  const result = await f.run({ sweepAfterMinutes: 0, extract: false });
  assert.equal(result.resolved, 1);
  const sweep = f.prompts.find(p => p.kind === "sweep");
  assert.ok(sweep && !JSON.stringify(sweep.prompt).includes("GROUP_SECRET_MARKER"), "workspace items see channel evidence only");
  assert.equal(f.rows().find(row => row.sourceKind === "captains_log")?.status, "kept");
  const entries = f.workStore.db.prepare("SELECT id, resolved_at_ms, resolution_note FROM captains_log_entries ORDER BY id").all();
  assert.deepEqual(entries.map(entry => [entry.id, entry.resolved_at_ms !== null, entry.resolution_note]), [
    ["blocker-1", true, "Shopify raised the Acme quota."], ["blocker-2", true, "Shopify raised the Acme quota."],
  ]);
  f.advance(INTERVAL);
  await f.run({ runner: undefined });
  assert.equal(f.rows().find(row => row.sourceKind === "captains_log")?.status, "kept", "the next sync does not re-mirror it");
});

test("maxSweepItems counts only items with new evidence; evidence-less items are marked checked, not re-scanned", async t => {
  const f = fixture(t, { sweep: () => ({ judgments: [] }) });
  // Sorted first (overdue) but in an excluded DM audience: it can never have evidence this pass.
  const dm = f.expect({ dedupKey: "dm", summary: "DM item", dueAtMs: START - 30 * MINUTE, audienceKey: "direct:slack:workspace:peer-x",
    chatType: "direct" });
  const workspace = f.expect({ dedupKey: "ws", summary: "Workspace item" });
  f.seed("public", "Progress on the workspace item.");
  const result = await f.run({ maxSweepItems: 1 });
  assert.equal(result.swept, 1);
  const sweep = f.prompts.find(p => p.kind === "sweep");
  assert.deepEqual(sweep?.kind === "sweep" && sweep.prompt.expectations.map(e => e.summary), [workspace.summary]);
  const marks = JSON.parse(f.item()!.artifactJson!).sweptAtMs as Record<string, number>;
  assert.deepEqual(marks, { [dm.id]: START, [workspace.id]: START }, "both were looked at: neither re-scans its history");

  f.advance(INTERVAL);
  assert.equal((await f.run({ maxSweepItems: 1 })).status, "empty");
  assert.equal(JSON.parse(f.item()!.artifactJson!).sweptAtMs[dm.id], START + INTERVAL, "an empty pass still records the check");
});
