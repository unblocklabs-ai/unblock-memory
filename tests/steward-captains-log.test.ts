import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { Static } from "typebox";
import { CAPTAINS_LOG_KIND, CAPTAINS_LOG_SCHEMA, runCaptainsLogPass,
  type CaptainsLogPassOptions, type CaptainsLogWatermark } from "../src/steward-captains-log.js";
import { resolveStewardConfig } from "../src/steward-config.js";
import { createStewardRunner } from "../src/steward-runner.js";
import { WorkStore } from "../src/work-store.js";
import { compressAgentTranscripts, createAgentDatabase, insertSession } from "./helpers/session-database.js";

const MINUTE = 60_000;
const START = Date.parse("2026-11-27T04:30:00Z"); // 23:30 EST on Nov 26
const INTERVAL = 180 * MINUTE;
type Completion = Static<typeof CAPTAINS_LOG_SCHEMA>;
type Prompt = { existingDailyLog: string; sessions: { ref: string; chatType: string; messages: { role: string; text: string }[] }[] };
const noAppend = { shouldAppend: false, entries: [], skipReason: "Already noted." } satisfies Completion;
const append = { shouldAppend: true, entries: [{ topic: "Release", summary: "Approved the Friday release.", sessionRefs: ["s1"] }] } satisfies Completion;
const config = resolveStewardConfig(undefined);

function provider(respond: (prompt: Prompt) => Completion | Response | Promise<Completion | Response> = () => append,
  credential: () => string | undefined = () => "test-provider-credential") {
  const prompts: Prompt[] = [];
  const runner = createStewardRunner({ config, resolveApiKey: async () => credential(), fetch: async (_url, init) => {
    const request: { input: [{ content: string }] } = JSON.parse(String(init?.body));
    const prompt: Prompt = JSON.parse(request.input[0].content);
    prompts.push(prompt);
    const value = await respond(prompt);
    if (value instanceof Response) return value;
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
  } });
  return { runner, prompts };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "steward-captains-log-"));
  const workspaceDir = join(root, "workspace");
  const memoryDir = join(workspaceDir, "memory");
  const file = join(memoryDir, "2026-11-26.md");
  const databasePath = join(root, "agent.sqlite");
  const store = new WorkStore(join(root, "work.sqlite"));
  let db: DatabaseSync | undefined;
  let time = START;
  mkdirSync(workspaceDir);
  t.after(() => {
    db?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const database = () => (db ??= createAgentDatabase(databasePath));
  const { runner, prompts } = provider();
  const run = (overrides: Partial<CaptainsLogPassOptions> = {}) => runCaptainsLogPass({
    agentId: "main", owner: "test-owner", databasePath, workspaceDir, timezone: "America/New_York",
    workStore: store, runner, now: () => time, ...overrides,
  });
  const item = () => store.get(CAPTAINS_LOG_KIND, "main");
  const artifact = (): CaptainsLogWatermark | null => JSON.parse(item()?.artifactJson ?? "null");
  const seed = (sessionId: string, text: string, chatType: "direct" | "channel" | "group" = "channel", at = START - MINUTE) => {
    insertSession(database(), { sessionId, chatType });
    addEvent(database(), sessionId, 1, at, "user", text);
  };
  return { root, file, memoryDir, databasePath, database, store, run, prompts, item, artifact, seed, advance: (ms: number) => { time += ms; } };
}

function addEvent(db: DatabaseSync, sessionId: string, seq: number, at: number, role: string, text: string, active = true) {
  const event = { type: "message", message: { role, content: [{ type: "text", text }] } };
  db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run(sessionId, seq, JSON.stringify(event), at);
  if (active) db.prepare("INSERT INTO session_transcript_active_events VALUES (?, ?, ?, ?)").run(sessionId, seq - 1, seq, seq - 1);
}

test("missing DB and empty active window re-arm without a model call, file or strike", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.run(), { status: "empty", sessions: 0, nextDueAt: START + INTERVAL });
  assert.equal(existsSync(f.databasePath), false);
  assert.equal(f.item()?.dueAt, START + INTERVAL);
  assert.equal(f.item()?.strikes, 0);

  f.seed("too-old", "Approved Monday's release", "channel", START - 191 * MINUTE);
  f.seed("inactive-only", "Active message is too old", "channel", START - 191 * MINUTE);
  addEvent(f.database(), "inactive-only", 2, START + INTERVAL - MINUTE, "user", "On an abandoned branch", false);
  f.advance(INTERVAL);
  assert.deepEqual(await f.run(), { status: "empty", sessions: 0, nextDueAt: START + 2 * INTERVAL });
  assert.equal(f.prompts.length, 0);
  assert.equal(existsSync(f.memoryDir), false);
  assert.equal(f.item()?.dueAt, START + 2 * INTERVAL);
  assert.equal(f.item()?.strikes, 0);
  assert.equal(f.artifact(), null);
});

test("filters DMs and automation before the provider, including automation outside the window", async t => {
  const f = fixture(t);
  f.seed("public", "Approved the Friday release.");
  addEvent(f.database(), "public", 2, START - MINUTE, "user", "<relevant-memories>INJECTED_PRIVATE_MARKER</relevant-memories>");
  f.seed("private", "PRIVATE_DM_MARKER", "direct");
  f.seed("mislabeled", "MISMATCHED_DM_MARKER", "direct");
  f.database().exec("UPDATE session_windows SET chat_type='channel' WHERE session_id='mislabeled'");
  f.seed("unknown", "UNCLASSIFIED_DM_MARKER");
  f.database().exec("UPDATE session_windows SET chat_type=NULL WHERE session_id='unknown'");
  f.seed("key", "KEY_AUTOMATION_MARKER");
  f.database().exec("UPDATE session_windows SET session_key='agent:main:cron:42' WHERE session_id='key'");
  f.seed("heartbeat", "Check HEARTBEAT.md and follow it", "channel", START - 200 * MINUTE);
  addEvent(f.database(), "heartbeat", 2, START - MINUTE, "assistant", "HEARTBEAT_AUTOMATION_MARKER");
  f.seed("cron", "[cron:daily] CRON_AUTOMATION_MARKER");
  f.seed("recursion", "Log request");
  addEvent(f.database(), "recursion", 2, START - MINUTE, "assistant", "Captain’s Log RECURSION_MARKER");
  f.seed("people", "unblock-memory:people-learning PEOPLE_AUTOMATION_MARKER");
  f.seed("smoke", "deep-thought-smoke SMOKE_AUTOMATION_MARKER");
  f.seed("ping", "Status check?");
  addEvent(f.database(), "ping", 2, START - MINUTE, "assistant", "All systems operational.");
  f.seed("health", "/health");
  addEvent(f.database(), "health", 2, START - MINUTE, "assistant", "OK.");
  f.seed("incident", "Health check?", "group");
  addEvent(f.database(), "incident", 2, START - MINUTE, "assistant", "Rolled back the broken cache config.");
  compressAgentTranscripts(f.database());

  for (const excludeChatTypes of [undefined, ["direct"] as const]) {
    const result = await f.run({ dryRun: true, excludeChatTypes });
    assert.equal(result.sessions, 2);
    const prompt = f.prompts.at(-1)!;
    assert.deepEqual(prompt.sessions.flatMap(s => s.messages.map(m => m.text)),
      ["Rolled back the broken cache config.", "Approved the Friday release."]);
    assert.doesNotMatch(JSON.stringify(prompt), /_MARKER|agent:main/u);
  }
  assert.equal((await f.run({ dryRun: true, excludeChatTypes: [] })).sessions, 4);
  assert.match(JSON.stringify(f.prompts.at(-1)), /PRIVATE_DM_MARKER/u);
  assert.doesNotMatch(JSON.stringify(f.prompts.at(-1)), /UNCLASSIFIED_DM_MARKER/u);
});

test("appends to the local day without losing flush or human notes and only captures unseen sequences", async t => {
  const f = fixture(t);
  const flush = "# Daily notes\n\n- Pre-compaction flush: retained the rollback procedure.";
  const manual = "\n- Human edit while inference was running.\n";
  mkdirSync(f.memoryDir);
  writeFileSync(f.file, flush);
  f.seed("release", "Approved the Friday release.");
  const { runner, prompts } = provider(() => {
    appendFileSync(f.file, manual);
    f.advance(4 * MINUTE);
    return append;
  });
  const first = await f.run({ runner });
  assert.equal(first.status, "appended");
  assert.equal(first.nextDueAt, START + INTERVAL);
  assert.equal(f.item()?.dueAt, START + INTERVAL);
  assert.equal(prompts[0]?.existingDailyLog, flush);
  const section = "\n\n## Captain's Log (23:30 EST)\n\n- **Release:** Approved the Friday release.\n";
  assert.equal(readFileSync(f.file, "utf8"), flush + manual + section);
  assert.deepEqual(f.artifact()?.sessionMaxSeq, { release: 1 });
  assert.match(f.artifact()?.lastEntryHash ?? "", /^[a-f0-9]{64}$/u);
  assert.equal((await f.run()).status, "not_due");
  f.advance(INTERVAL - 4 * MINUTE);
  addEvent(f.database(), "release", 2, START + INTERVAL - MINUTE, "assistant", "The deployment was verified.");
  const review = provider(() => noAppend);
  const second = await f.run({ runner: review.runner });
  assert.equal(second.status, "no_append");
  assert.deepEqual(review.prompts[0]?.sessions[0]?.messages, [{ role: "assistant", text: "The deployment was verified." }]);
  assert.deepEqual(f.artifact()?.sessionMaxSeq, { release: 2 });
  assert.equal(readFileSync(f.file, "utf8"), flush + manual + section);
});

test("a no-append decision consumes its window and overlapping events are not replayed", async t => {
  const f = fixture(t);
  f.seed("considered", "Already stored in the durable notes.", "channel", START - MINUTE);
  const { runner, prompts } = provider(() => noAppend);
  assert.deepEqual(await f.run({ runner }), { status: "no_append", sessions: 1, skipReason: "Already noted.",
    nextDueAt: START + INTERVAL, usage: { requests: 1 } });
  assert.deepEqual(f.artifact(), { schemaVersion: 1, lastCapturedAtMs: START, sessionMaxSeq: { considered: 1 } });
  f.advance(INTERVAL);
  assert.equal((await f.run({ runner })).status, "empty");
  assert.equal(prompts.length, 1);
  assert.equal(existsSync(f.memoryDir), false);
  assert.equal(f.item()?.strikes, 0);
});

test("dry run gives proposed markdown without creating a path or changing any WorkStore row", async t => {
  const f = fixture(t);
  f.seed("preview", "Approved the Friday release.");
  const preview = await f.run({ dryRun: true });
  assert.equal(preview.status, "preview");
  assert.equal(preview.filePath, f.file);
  assert.match(preview.markdown, /\*\*Release:\*\* Approved the Friday release/u);
  assert.equal(preview.nextDueAt, undefined);
  assert.equal(existsSync(f.memoryDir), false);
  assert.equal(f.item(), undefined);
  assert.equal((await f.run({ runner: provider(() => noAppend).runner })).status, "no_append");
  const before = f.item();
  f.advance(MINUTE);
  addEvent(f.database(), "preview", 2, START + MINUTE, "assistant", "Release notes are ready.");
  assert.equal((await f.run({ dryRun: true })).status, "preview");
  assert.deepEqual(f.item(), before);
  assert.equal(existsSync(f.memoryDir), false);
});

test("redacts transcript, existing notes and generated markdown; configured budgets constrain the prompt", async t => {
  const f = fixture(t);
  mkdirSync(f.memoryDir);
  writeFileSync(f.file, "OLD_PREFIX key=public\napi_key=fixture-note-credential\n");
  f.seed("first", "Bearer fixture-transcript-credential shipped Friday with a long follow-up.", "channel", START - 2 * MINUTE);
  addEvent(f.database(), "first", 2, START - 2 * MINUTE, "assistant", "This continuation must stay unseen under the budget.");
  f.seed("second", "SESSION_LIMIT_MARKER");
  const { runner, prompts } = provider(() => ({ shouldAppend: true, entries: [{ topic: "sk-fixture-output", summary: "password=fixture-output-password" }] }));
  const result = await f.run({ runner, maxSessionsPerRun: 1, maxCharsPerSession: 25, maxExistingLogChars: 20 });
  assert.equal(result.status, "appended");
  assert.match(result.markdown, /\[redacted\]/u);
  assert.doesNotMatch(result.markdown, /fixture-output/u);
  assert.doesNotMatch(readFileSync(f.file, "utf8"), /fixture-output/u);
  assert.equal(prompts[0]?.sessions[0]?.messages[0]?.text, "[redacted] shipped Friday");
  assert.equal(prompts[0]?.sessions.length, 1);
  assert.equal(prompts[0]?.sessions[0]?.messages.length, 1);
  assert.ok(prompts[0]!.existingDailyLog.length <= 20);
  assert.match(prompts[0]!.existingDailyLog, /\[redacted\]/u);
  assert.doesNotMatch(JSON.stringify(prompts), /fixture-(?:note|transcript)-credential|OLD_PREFIX|SESSION_LIMIT_MARKER/u);
  assert.deepEqual(f.artifact()?.sessionMaxSeq, { first: 1 });
});

test("rejects a symlinked memory directory and a daily file swapped during inference", async t => {
  for (const escape of ["directory", "before-model-file", "during-model-file"] as const) await t.test(escape, async t => {
    const f = fixture(t);
    f.seed("work", "Approved the Friday release.");
    const outside = join(f.root, "outside");
    const target = join(outside, "2026-11-26.md");
    mkdirSync(outside);
    writeFileSync(target, "External file must stay untouched.");
    if (escape === "directory") symlinkSync(outside, f.memoryDir, "dir");
    else mkdirSync(f.memoryDir);
    if (escape === "before-model-file") symlinkSync(target, f.file);
    const { runner, prompts } = provider(() => {
      if (escape === "during-model-file") symlinkSync(target, f.file);
      return append;
    });
    const result = await f.run({ runner });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /symlink/u);
    assert.equal(prompts.length, escape === "during-model-file" ? 1 : 0);
    assert.equal(readFileSync(target, "utf8"), "External file must stay untouched.");
    assert.deepEqual(f.artifact()?.sessionMaxSeq ?? {}, {});
    assert.equal(f.item()?.strikes, 0);
  });
});

test("an abort during model inference releases the lease without an append, watermark or strike", async t => {
  const f = fixture(t);
  f.seed("work", "Approved the Friday release.");
  const controller = new AbortController();
  const { runner, prompts } = provider(() => {
    controller.abort();
    return append;
  });
  assert.equal((await f.run({ signal: controller.signal, runner })).status, "aborted");
  assert.equal(prompts.length, 1);
  assert.equal(f.item()?.owner, null);
  assert.equal(f.item()?.dueAt, START + INTERVAL);
  assert.equal(f.item()?.strikes, 0);
  assert.equal(f.artifact(), null);
  assert.equal(existsSync(f.memoryDir), false);
});

test("missing credentials and a transient provider failure re-arm without consuming events or adding strikes", async t => {
  const f = fixture(t);
  f.seed("work", "Approved the Friday release.");
  const missing = provider(() => append, () => undefined);
  const outage = provider(() => new Response(null, { status: 503, headers: { "retry-after": "60" } }));
  for (const { runner, prompts, reason, calls } of [
    { ...missing, reason: "missing_credentials", calls: 0 }, { ...outage, reason: "transient_provider", calls: 1 },
  ]) {
    const result = await f.run({ runner, timeoutMs: 5000 });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, reason);
    assert.equal(prompts.length, calls);
    assert.equal(f.item()?.owner, null);
    assert.equal(f.item()?.dueAt, result.nextDueAt);
    assert.equal(f.item()?.strikes, 0);
    assert.equal(f.artifact(), null);
    f.advance(INTERVAL);
  }
  assert.equal(existsSync(f.memoryDir), false);
});

test("a superseded attempt cannot append even if the model returns a successful response", async t => {
  const f = fixture(t);
  f.seed("work", "Approved the Friday release.");
  const stale = provider(async () => {
    assert.equal((await f.run({ owner: "second" })).status, "already_running");
    assert.equal(f.store.interruptOwner("test-owner", START), 1);
    assert.equal((await f.run({ owner: "second" })).status, "appended");
    return { shouldAppend: true, entries: [{ topic: "Stale", summary: "Do not append this." }] };
  });
  const result = await f.run({ runner: stale.runner });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "fence_lost");
  assert.equal(f.prompts.length, 1);
  assert.match(readFileSync(f.file, "utf8"), /Approved the Friday release/u);
  assert.doesNotMatch(readFileSync(f.file, "utf8"), /Stale/u);
  assert.deepEqual(f.artifact()?.sessionMaxSeq, { work: 1 });
});

test("recovers an appended section after the watermark transaction rolled back, even across local midnight", async t => {
  const f = fixture(t);
  f.seed("work", "Approved the Friday release.");
  f.store.db.exec(`CREATE TRIGGER fail_final_watermark BEFORE UPDATE OF stage ON work_items
    WHEN NEW.stage = 'watermark' BEGIN SELECT RAISE(ABORT, 'synthetic post-append failure'); END`);
  const first = await f.run();
  assert.equal(first.status, "failed");
  assert.match(first.reason, /synthetic post-append failure/u);
  assert.deepEqual(f.artifact()?.sessionMaxSeq, {});
  const published = readFileSync(f.file, "utf8");
  assert.match(published, /Approved the Friday release/u);
  f.store.db.exec("DROP TRIGGER fail_final_watermark");
  f.advance(INTERVAL);
  assert.equal((await f.run()).status, "empty");
  assert.equal(f.prompts.length, 1);
  assert.equal(readFileSync(f.file, "utf8"), published);
  assert.equal(existsSync(join(f.memoryDir, "2026-11-27.md")), false);
  assert.deepEqual(f.artifact()?.sessionMaxSeq, { work: 1 });
  assert.equal(f.artifact()?.lastCapturedAtMs, START);
  assert.equal(f.item()?.strikes, 0);
});

function addRawMessage(db: DatabaseSync, sessionId: string, seq: number, at: number, message: Record<string, unknown>) {
  db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run(sessionId, seq, JSON.stringify({ type: "message", message }), at);
  db.prepare("INSERT INTO session_transcript_active_events VALUES (?, ?, ?, ?)").run(sessionId, seq - 1, seq, seq - 1);
}

test("only host-visible assistant content reaches Steward: display content wins, [] and analysis stay hidden", async t => {
  const f = fixture(t);
  f.seed("visible", "Did the release ship?");
  addRawMessage(f.database(), "visible", 2, START - MINUTE, { role: "assistant",
    content: [{ type: "text", text: "RAW_UNDISPLAYED_MARKER" }],
    openclawDisplayContent: [{ type: "text", text: "Shipped the release to production." }] });
  addRawMessage(f.database(), "visible", 3, START - MINUTE, { role: "assistant", channel: "analysis",
    content: [{ type: "text", text: "ANALYSIS_THOUGHT_MARKER" }] });
  addRawMessage(f.database(), "visible", 4, START - MINUTE, { role: "assistant",
    content: [{ type: "text", text: "SUPPRESSED_REPLY_MARKER" }], openclawDisplayContent: [] });
  const result = await f.run({ dryRun: true });
  assert.equal(result.sessions, 1);
  const prompt = f.prompts.at(-1)!;
  assert.deepEqual(prompt.sessions[0]!.messages, [
    { role: "user", text: "Did the release ship?" },
    { role: "assistant", text: "Shipped the release to production." },
  ]);
  assert.doesNotMatch(JSON.stringify(prompt), /_MARKER/u);
});

test("a failed pass retries within 15 minutes and later catches up from the watermark instead of dropping activity", async t => {
  const f = fixture(t);
  f.seed("early", "Approved the Friday release.");
  assert.equal((await f.run()).status, "appended");
  assert.equal(f.artifact()?.lastCapturedAtMs, START);
  // Activity right after the capture; then the next pass fails transiently.
  f.seed("late", "Rolled back the broken cache config.", "channel", START + 10 * MINUTE);
  f.advance(INTERVAL);
  const outage = provider(() => new Response(null, { status: 503, headers: { "retry-after": "60" } }));
  const failed = await f.run({ runner: outage.runner, timeoutMs: 5000 });
  assert.equal(failed.status, "failed");
  assert.equal(failed.nextDueAt, START + INTERVAL + 15 * MINUTE, "a transient failure retries soon, not a full interval later");
  assert.equal(f.item()?.dueAt, failed.nextDueAt);
  assert.equal(f.item()?.strikes, 0);
  // Gateway downtime pushes the next pass far past the lookback: the window still starts at the last capture.
  f.advance(INTERVAL + 60 * MINUTE);
  const caught = provider(() => append);
  const result = await f.run({ runner: caught.runner });
  assert.equal(result.status, "appended");
  assert.equal(result.sessions, 1);
  assert.deepEqual(caught.prompts[0]!.sessions[0]!.messages, [{ role: "user", text: "Rolled back the broken cache config." }]);
  assert.deepEqual(f.artifact()?.sessionMaxSeq, { early: 1, late: 1 });
});
