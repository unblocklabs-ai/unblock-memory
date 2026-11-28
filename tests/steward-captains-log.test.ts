import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { Static } from "typebox";
import { CAPTAINS_LOG_KIND, CAPTAINS_LOG_SCHEMA, listCaptainsLogEntries, listOpenBlockers, resolveCaptainsLogBlocker, runCaptainsLogPass,
  type CaptainsLogPassOptions, type CaptainsLogWatermark } from "../src/steward-captains-log.js";
import { resolveStewardConfig } from "../src/steward-config.js";
import { createStewardRunner } from "../src/steward-runner.js";
import { WorkStore } from "../src/work-store.js";
import { jsonHash } from "../src/json-hash.js";
import { compressAgentTranscripts, createAgentDatabase, insertSession } from "./helpers/session-database.js";

const MINUTE = 60_000;
const START = Date.parse("2026-11-27T04:30:00Z"); // 23:30 EST on Nov 26
const INTERVAL = 180 * MINUTE;
type Completion = Static<typeof CAPTAINS_LOG_SCHEMA>;
type Prompt = { existingDailyLog: string; sessions: { ref: string; chatType: string; channel?: string; messages: { role: string; text: string }[] }[] };
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

test("human heartbeat discussion remains eligible after a synthetic wake", async t => {
  const f = fixture(t);
  const human = "We restored heartbeat alerts for /api/accounts.";
  f.seed("mixed", "[OpenClaw heartbeat poll]");
  addEvent(f.database(), "mixed", 2, START - MINUTE, "assistant", "Automation receipt.");
  addEvent(f.database(), "mixed", 3, START - MINUTE, "user", "Continue the OpenClaw runtime event.");
  addEvent(f.database(), "mixed", 4, START - MINUTE, "user", human);
  const result = await f.run({ dryRun: true });
  assert.equal(result.sessions, 1);
  assert.deepEqual(f.prompts[0]?.sessions.flatMap(session => session.messages.map(message => message.text)), [human]);
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
  assert.equal(f.store.db.prepare("SELECT name FROM sqlite_schema WHERE name='captains_log_entries'").get(), undefined);
  assert.equal(f.store.db.prepare("SELECT version FROM memory_schema WHERE component='captains_log'").get(), undefined);
  assert.equal((await f.run({ runner: provider(() => noAppend).runner })).status, "no_append");
  const before = f.item();
  f.advance(MINUTE);
  addEvent(f.database(), "preview", 2, START + MINUTE, "assistant", "Release notes are ready.");
  assert.equal((await f.run({ dryRun: true })).status, "preview");
  assert.deepEqual(f.item(), before);
  assert.deepEqual(listCaptainsLogEntries(f.store.db, { agentId: "main" }), []);
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
  const [entry] = listCaptainsLogEntries(f.store.db, { agentId: "main" });
  assert.equal(entry?.topic, "[redacted]");
  assert.equal(entry?.summary, "password=[redacted]");
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
  assert.deepEqual(listCaptainsLogEntries(f.store.db, { agentId: "main" }).map(entry => entry.topic), ["Release"]);
});

test("recovers an appended section after the watermark transaction rolled back, even across local midnight", async t => {
  for (const legacy of [false, true]) await t.test(legacy ? "legacy receipt" : "structured receipt", async t => {
    const f = fixture(t);
    const db = f.store.db;
    f.seed("work", "Approved the Friday release.");
    failFinalWatermark(db);
    const first = await f.run();
    assert.equal(first.status, "failed");
    assert.match(first.reason, /synthetic post-append failure/u);
    assert.deepEqual(f.artifact()?.sessionMaxSeq, {});
    assert.deepEqual(listCaptainsLogEntries(db, { agentId: "main" }), []);
    const published = readFileSync(f.file, "utf8");
    assert.match(published, /Approved the Friday release/u);
    db.exec("DROP TRIGGER fail_final_watermark");
    if (legacy) db.exec("UPDATE work_items SET artifact_json=json_remove(artifact_json, '$.pendingAppend.entries')");
    const pendingJson = f.item()?.artifactJson;
    assert.ok(pendingJson);
    f.advance(INTERVAL);
    assert.equal((await f.run({ dryRun: true })).status, "empty");
    assert.equal(f.item()?.artifactJson, pendingJson);
    assert.deepEqual(listCaptainsLogEntries(db, { agentId: "main" }), []);
    assert.equal((await f.run()).status, "empty");
    assert.equal(f.prompts.length, 1);
    assert.equal(readFileSync(f.file, "utf8"), published);
    assert.equal(existsSync(join(f.memoryDir, "2026-11-27.md")), false);
    assert.deepEqual(f.artifact()?.sessionMaxSeq, { work: 1 });
    assert.equal(f.artifact()?.lastCapturedAtMs, START);
    assert.equal(f.item()?.strikes, 0);
    const rows = listCaptainsLogEntries(db, { agentId: "main" });
    if (legacy) {
      assert.deepEqual(rows, []);
    } else {
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.sectionHash, f.artifact()?.lastEntryHash);
      assert.equal(rows[0]?.day, "2026-11-26");
      assert.equal(rows[0]?.capturedAtMs, START);
      assert.deepEqual(rows[0]?.sessionRefs, ["work"]);
      // Replaying the same already-committed receipt must not produce a second row or change its ID.
      db.prepare("UPDATE work_items SET stage='pending_append', artifact_json=? WHERE kind=? AND scope=?")
        .run(pendingJson, CAPTAINS_LOG_KIND, "main");
      f.advance(INTERVAL);
      assert.equal((await f.run()).status, "empty");
      assert.deepEqual(listCaptainsLogEntries(db, { agentId: "main" }), rows);
    }
  });
});

function failFinalWatermark(db: DatabaseSync, afterMs = 0): void {
  db.exec(`CREATE TRIGGER fail_final_watermark BEFORE UPDATE OF stage ON work_items
    WHEN NEW.stage = 'watermark' AND json_extract(NEW.artifact_json, '$.lastCapturedAtMs') > ${afterMs}
    BEGIN SELECT RAISE(ABORT, 'synthetic post-append failure'); END`);
}

test("a second post-append crash cannot overwrite an already-published section's recovery data", async t => {
  const f = fixture(t);
  const db = f.store.db;
  f.seed("release", "Approved the Friday release.");
  failFinalWatermark(db);
  assert.equal((await f.run()).status, "failed");
  db.exec("DROP TRIGGER fail_final_watermark");

  f.advance(INTERVAL);
  f.seed("rollback", "Rolled back the cache config.", "channel", START + INTERVAL - MINUTE);
  failFinalWatermark(db, START);
  const { runner } = provider(() => ({ shouldAppend: true, entries: [{ topic: "Rollback", summary: "Rolled back the cache config." }] }));
  const second = await f.run({ runner });
  assert.equal(second.status, "failed");
  assert.match(second.reason, /synthetic post-append failure/u);
  assert.deepEqual(f.artifact()?.sessionMaxSeq, { release: 1 });
  assert.deepEqual(listCaptainsLogEntries(db, { agentId: "main" }).map(row => row.topic), ["Release"]);

  db.exec("DROP TRIGGER fail_final_watermark");
  f.advance(INTERVAL);
  assert.equal((await f.run()).status, "empty");
  assert.deepEqual(listCaptainsLogEntries(db, { agentId: "main" }).map(row => row.topic), ["Rollback", "Release"]);
  assert.deepEqual(f.artifact()?.sessionMaxSeq, { release: 1, rollback: 1 });
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

test("appends ordered, queryable entries with sanitized channel context and resolvable blockers", async t => {
  const f = fixture(t);
  const db = f.store.db;
  f.seed("slack-named", "Policy requires approval for saved ads.", "channel", START - 4 * MINUTE);
  f.database().exec("UPDATE conversations SET label='slack:unblock-labs-#fga-unblocklabs' WHERE conversation_id='conversation-slack-named'");
  f.seed("slack-opaque", "Cleared disk caches.", "channel", START - 3 * MINUTE);
  f.database().exec("UPDATE conversations SET label='slack:g-c0ahzfcas1k' WHERE conversation_id='conversation-slack-opaque'");
  f.seed("loggie-group", "Weekly sync decisions.", "group", START - 2 * MINUTE);
  f.database().exec("UPDATE conversations SET label='loggie:g-unblock-labs-weekly-standup' WHERE conversation_id='conversation-loggie-group'");
  f.seed("dm-private", "Private check-in.", "direct", START - MINUTE);
  f.database().exec("UPDATE conversations SET label='DM with Alice #secret-channel' WHERE conversation_id='conversation-dm-private'");
  f.seed("credential-label", "Recovered the queue.", "channel", START - 30_000);
  f.database().exec("UPDATE conversations SET label='slack:password=fixture-label-secret' WHERE conversation_id='conversation-credential-label'");

  const { runner, prompts } = provider(() => ({
    shouldAppend: true,
    entries: [
      { topic: "Blastoise RAM upgrade", summary: "Host reports 235.5 GiB usable RAM." },
      { topic: "Loggie monthly quota", summary: "Exhausted 350,000-request cap; automations halted.", blocked: true,
        sessionRefs: ["s1", "s1", "s2", "s3", "s4", "s5", "s99", "s01", "slack-named"] },
      { topic: "Mobile Shop menu", summary: "Published CSS scroll fix.", blocked: false },
      { topic: "[BLOCKED]: Email-agent sign-in", summary: "Daily sign-in failed with unrecognised-signin.", blocked: true },
    ],
  }));

  const result = await f.run({ excludeChatTypes: [], runner });
  assert.equal(result.status, "appended");
  assert.deepEqual(prompts[0]?.sessions.map(s => ({ chatType: s.chatType, channel: s.channel })), [
    { chatType: "channel", channel: "#fga-unblocklabs" },
    { chatType: "channel", channel: undefined },
    { chatType: "group", channel: "unblock-labs-weekly-standup" },
    { chatType: "direct", channel: undefined },
    { chatType: "channel", channel: undefined },
  ]);
  const lines = readFileSync(f.file, "utf8").trim().split("\n").filter(l => l.startsWith("- "));
  assert.deepEqual(lines, [
    "- **[BLOCKED] Loggie monthly quota:** Exhausted 350,000-request cap; automations halted.",
    "- **[BLOCKED] Email-agent sign-in:** Daily sign-in failed with unrecognised-signin.",
    "- **Blastoise RAM upgrade:** Host reports 235.5 GiB usable RAM.",
    "- **Mobile Shop menu:** Published CSS scroll fix.",
  ]);
  assert.equal(db.prepare("SELECT version FROM memory_schema WHERE component='captains_log'").get()?.version, 1);
  const rows = listCaptainsLogEntries(db, { agentId: "main", day: "2026-11-26", sinceMs: START, limit: 0 });
  assert.deepEqual(rows.map(({ sectionHash, ordinal, topic, blocked }) => ({ sectionHash, ordinal, topic, blocked })), [
    { sectionHash: f.artifact()?.lastEntryHash, ordinal: 0, topic: "Loggie monthly quota", blocked: true },
    { sectionHash: f.artifact()?.lastEntryHash, ordinal: 1, topic: "Email-agent sign-in", blocked: true },
    { sectionHash: f.artifact()?.lastEntryHash, ordinal: 2, topic: "Blastoise RAM upgrade", blocked: false },
    { sectionHash: f.artifact()?.lastEntryHash, ordinal: 3, topic: "Mobile Shop menu", blocked: false },
  ]);
  const [quota, signIn, upgrade] = rows;
  assert.ok(quota && signIn && upgrade);
  assert.deepEqual(quota.sessionRefs, ["slack-named", "slack-opaque", "loggie-group", "dm-private", "credential-label"]);
  assert.deepEqual(quota.channels, ["#fga-unblocklabs", "unblock-labs-weekly-standup"]);
  assert.deepEqual(signIn.channels, []);
  assert.deepEqual(signIn.sessionRefs, []);
  assert.deepEqual(listCaptainsLogEntries(db, { agentId: "main", sinceMs: START + 1 }), []);
  assert.deepEqual(listCaptainsLogEntries(db, { agentId: "main", day: "2026-11-27" }), []);

  assert.deepEqual(listOpenBlockers(db, "main"), [quota, signIn]);
  assert.deepEqual(listOpenBlockers(db, "main", 1), [quota]);
  assert.deepEqual(listOpenBlockers(db, "other"), []);
  assert.equal(resolveCaptainsLogBlocker(db, { agentId: "other", id: quota.id }), false);
  assert.equal(resolveCaptainsLogBlocker(db, { agentId: "main", id: upgrade.id }), false);
  const resolvedAtMs = START + MINUTE;
  assert.equal(resolveCaptainsLogBlocker(db, { agentId: "main", id: quota.id, resolvedAtMs, note: "Raised the quota." }), true);
  assert.equal(resolveCaptainsLogBlocker(db, { agentId: "main", id: quota.id, note: "Overwrite attempt." }), false);
  assert.deepEqual(listOpenBlockers(db, "main"), [signIn]);
  assert.deepEqual(listCaptainsLogEntries(db, { agentId: "main", blockedOnly: true }),
    [{ ...quota, resolvedAtMs, resolutionNote: "Raised the quota." }, signIn]);
});

test("0.19 ledgers gain native_channels_json in place; native ids are recorded but never rendered or prompted", async t => {
  const f = fixture(t);
  f.store.db.exec(`CREATE TABLE IF NOT EXISTS memory_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO memory_schema VALUES ('captains_log', 1);
    CREATE TABLE captains_log_entries (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, day TEXT NOT NULL, captured_at_ms INTEGER NOT NULL, section_hash TEXT NOT NULL,
      ordinal INTEGER NOT NULL, topic TEXT NOT NULL, summary TEXT NOT NULL, blocked INTEGER NOT NULL CHECK(blocked IN (0, 1)),
      resolved_at_ms INTEGER, resolution_note TEXT, channels_json TEXT NOT NULL CHECK(json_valid(channels_json)),
      session_refs_json TEXT NOT NULL CHECK(json_valid(session_refs_json))) STRICT;
    INSERT INTO captains_log_entries VALUES ('old', 'main', '2026-11-25', 1, 'h', 0, 'Old', 'Old entry', 0, NULL, NULL, '[]', '[]');`);
  f.seed("public", "Approved the Friday release. Alerts: https://hooks.slack.com/services/T0AAA/B0BBB/hookSECRET42");
  const result = await f.run();
  assert.equal(result.status, "appended");
  const entries = listCaptainsLogEntries(f.store.db, { agentId: "main" });
  assert.deepEqual(entries.map(entry => [entry.id === "old" ? "old" : "new", entry.nativeChannels]),
    [["new", ["native-public"]], ["old", []]], "the upgrade keeps old rows and records native ids on new ones");
  assert.ok(result.status === "appended" && !result.markdown.includes("native-public"));
  assert.ok(!JSON.stringify(f.prompts).includes("native-public"), "native ids never reach the model");
  assert.ok(!JSON.stringify(f.prompts).includes("hookSECRET42"), "Slack incoming webhook URLs are redacted");
});

// ---- Emotion-driven salience (Inside Out grades live in the work database) ----

type SalientPrompt = { sessions: { ref: string; chatType: string; messages: { role: string; text: string; ref?: string; salience?: string }[] }[] };
const asSalient = (prompt: Prompt | undefined) => prompt as unknown as SalientPrompt;

function addMessageEvent(db: DatabaseSync, sessionId: string, seq: number, at: number, role: string, text: string, id: string) {
  const event = { type: "message", id, message: { role, content: [{ type: "text", text }] } };
  db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run(sessionId, seq, JSON.stringify(event), at);
  db.prepare("INSERT INTO session_transcript_active_events VALUES (?, ?, ?, ?)").run(sessionId, seq - 1, seq, seq - 1);
}

function seedMessage(f: ReturnType<typeof fixture>, sessionId: string, id: string, text: string,
  chatType: "direct" | "channel" | "group" = "channel", at = START - MINUTE) {
  insertSession(f.database(), { sessionId, chatType });
  addMessageEvent(f.database(), sessionId, 1, at, "user", text, id);
}

function insideOutGrades(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS inside_out (
    interaction_id TEXT NOT NULL, rubric TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
    assistant_id TEXT NOT NULL, human_key TEXT NOT NULL, sender_id TEXT NOT NULL, channel TEXT NOT NULL, source TEXT NOT NULL,
    target_at INTEGER, reviewed_at INTEGER NOT NULL, model TEXT NOT NULL, context_trimmed INTEGER NOT NULL,
    joy REAL, sadness REAL, fear REAL, anger REAL, disgust REAL, surprise REAL, error TEXT, person_id TEXT,
    intensity REAL, valence REAL, PRIMARY KEY(interaction_id,rubric)) STRICT`);
  return (sessionId: string, messageId: string, emotions: Partial<Record<"joy" | "sadness" | "fear", number>>, intensity: number, valence: number) =>
    db.prepare(`INSERT INTO inside_out (interaction_id,rubric,session_id,message_id,assistant_id,human_key,sender_id,channel,source,
        target_at,reviewed_at,model,context_trimmed,joy,sadness,fear,anger,disgust,surprise,error,intensity,valence)
      VALUES (?, 'v1', ?, ?, 'a', 'h', 's', 'slack', 'src', ?, ?, 'm', 0, ?, ?, ?, 0, 0, 0, NULL, ?, ?)`)
      .run(`${sessionId}:${messageId}`, sessionId, messageId, START - MINUTE, START - 30_000,
        emotions.joy ?? 0, emotions.sadness ?? 0, emotions.fear ?? 0, intensity, valence);
}

/** Raw emotion numbers, grade vocabulary or opaque handles in Markdown would leak private analytics. */
const NO_EMOTION_LEAK = /salience|intensity|valence|milestone|setback|bittersweet|joy|stress|\bm\d+\b|\b0\.\d+|\b[123]\.\d+/iu;

test("high-salience joy and failure are cued, persisted privately and ranked right behind blockers", async t => {
  const f = fixture(t);
  seedMessage(f, "launch", "msg-joy", "We closed the Series A today!", "channel", START - 4 * MINUTE);
  seedMessage(f, "outage", "msg-fail", "The client migration failed and we lost a day of orders.", "channel", START - 3 * MINUTE);
  seedMessage(f, "routine", "msg-routine", "Updated the README badges.", "channel", START - 2 * MINUTE);
  seedMessage(f, "quota", "msg-quota", "The Loggie quota is exhausted.", "channel", START - MINUTE);
  const grade = insideOutGrades(f.store.db);
  grade("launch", "msg-joy", { joy: 0.95 }, 2.6, 0.9);
  grade("outage", "msg-fail", { fear: 0.9, sadness: 0.4 }, 2.4, -0.8);
  grade("routine", "msg-routine", { joy: 0.1 }, 0.2, 0.1);
  // `quota` has no grade yet: a late Inside Out pass must not hold it back.
  const { runner, prompts } = provider(prompt => {
    const ref = (text: string) => asSalient(prompt).sessions.flatMap(s => s.messages).find(m => m.text.includes(text))?.ref;
    return { shouldAppend: true, entries: [
      { topic: "README", summary: "Refreshed the README badges.", sessionRefs: ["s3"] },
      { topic: "Client migration", summary: "The client migration failed and a day of orders was lost.", sessionRefs: ["s2"] },
      { topic: "Series A", summary: "Closed the Series A round.", messageRefs: [ref("Series A")!, "m99", "s1"] },
      { topic: "Loggie quota", summary: "Quota exhausted; automations halted.", blocked: true, sessionRefs: ["s4"] },
    ] };
  });
  const result = await f.run({ runner });
  assert.equal(result.status, "appended");

  assert.deepEqual(asSalient(prompts[0]).sessions.map(s => s.messages), [
    [{ role: "user", text: "We closed the Series A today!", ref: "m1", salience: "high — joy/milestone" }],
    [{ role: "user", text: "The client migration failed and we lost a day of orders.", ref: "m2", salience: "high — stress/setback" }],
    [{ role: "user", text: "Updated the README badges." }],
    [{ role: "user", text: "The Loggie quota is exhausted." }],
  ], "only high-salience human messages carry a handle and a neutral cue, never a number");
  assert.doesNotMatch(JSON.stringify(prompts[0]), /2\.6|0\.95|0\.9\b|-0\.8/u);

  const markdown = readFileSync(f.file, "utf8");
  assert.deepEqual(markdown.trim().split("\n").filter(line => line.startsWith("- ")), [
    "- **[BLOCKED] Loggie quota:** Quota exhausted; automations halted.",
    "- **Series A:** Closed the Series A round.",
    "- **Client migration:** The client migration failed and a day of orders was lost.",
    "- **README:** Refreshed the README badges.",
  ]);
  assert.doesNotMatch(markdown, NO_EMOTION_LEAK);

  const rows = listCaptainsLogEntries(f.store.db, { agentId: "main" });
  assert.deepEqual(rows.map(row => row.topic), ["Loggie quota", "Series A", "Client migration", "README"]);
  const [quota, series, migration, readme] = rows;
  assert.ok(quota && series && migration && readme);
  assert.ok(Math.abs(series.salienceScore! - 2.6 / 3) < 1e-9);
  assert.equal(series.emotionalIntensity, 2.6);
  assert.deepEqual(series.sessionRefs, ["launch"], "a cited message handle also cites its session");
  assert.equal(migration.emotionalIntensity, 2.4);
  assert.equal(quota.salienceScore, undefined);
  assert.equal(readme.salienceScore, undefined, "a routine grade never bumps an entry");
  const signals = (topic: string) => JSON.parse(String(f.store.db.prepare(
    "SELECT salience_signals_json j FROM captains_log_entries WHERE topic=?").get(topic)?.j ?? "null"));
  assert.equal(signals("Series A").grounding, "message");
  assert.deepEqual(signals("Series A").signals.map((s: { ref: string; messageId: string }) => [s.ref, s.messageId]), [["m1", "msg-joy"]]);
  assert.equal(signals("Client migration").grounding, "session");
  assert.equal(signals("Client migration").label, "stress/setback");
  assert.equal(signals("README"), null);
  assert.ok(result.status === "appended" && result.entries[1]?.topic === "Series A" && result.entries[1].salienceScore! > 0.8);

  // A later routine capture still lists behind the earlier high-salience entries, blockers stay first.
  f.advance(INTERVAL);
  seedMessage(f, "later", "msg-later", "Renamed the staging bucket.", "channel", START + INTERVAL - MINUTE);
  const later = provider(() => ({ shouldAppend: true, entries: [{ topic: "Staging bucket", summary: "Renamed it.", sessionRefs: ["s1"] }] }));
  assert.equal((await f.run({ runner: later.runner })).status, "appended");
  assert.deepEqual(listCaptainsLogEntries(f.store.db, { agentId: "main" }).map(row => row.topic),
    ["Loggie quota", "Series A", "Client migration", "Staging bucket", "README"]);
});

test("missing, malformed or late Inside Out grades never block capture; salience can be switched off or tuned", async t => {
  const f = fixture(t);
  seedMessage(f, "work", "msg-1", "We shipped the launch!");
  const plain = [{ role: "user", text: "We shipped the launch!" }];
  // No inside_out table at all.
  const missing = provider(() => append);
  assert.equal((await f.run({ dryRun: true, runner: missing.runner })).status, "preview");
  assert.deepEqual(missing.prompts[0]!.sessions[0]!.messages, plain);
  // A malformed table (no message_id) is ignored rather than failing the pass.
  f.store.db.exec("CREATE TABLE inside_out (session_id TEXT, joy REAL)");
  const malformed = provider(() => append);
  assert.equal((await f.run({ dryRun: true, runner: malformed.runner })).status, "preview");
  assert.deepEqual(malformed.prompts[0]!.sessions[0]!.messages, plain);
  f.store.db.exec("DROP TABLE inside_out");
  const grade = insideOutGrades(f.store.db);
  grade("work", "msg-1", { joy: 0.95 }, 2.5, 0.9);
  const off = provider(() => append);
  assert.equal((await f.run({ dryRun: true, runner: off.runner, includeEmotionalSalience: false })).status, "preview");
  assert.deepEqual(off.prompts[0]!.sessions[0]!.messages, plain, "includeEmotionalSalience: false sends no cue");
  const strict = provider(() => append);
  assert.equal((await f.run({ dryRun: true, runner: strict.runner, minSalienceScore: 0.99, minAbsoluteIntensity: 3 })).status, "preview");
  assert.deepEqual(strict.prompts[0]!.sessions[0]!.messages, plain, "thresholds are configurable");
  const tuned = provider(() => append);
  assert.equal((await f.run({ dryRun: true, runner: tuned.runner, minAbsoluteIntensity: 2.5, salience: { minSalienceScore: 0.99 } })).status, "preview");
  assert.equal(asSalient(tuned.prompts[0]).sessions[0]!.messages[0]!.salience, "high — joy/milestone");
  await assert.rejects(f.run({ runner: tuned.runner, minSalienceScore: 2 }), RangeError, "misconfiguration fails loudly");
  assert.equal(f.item()?.strikes ?? 0, 0);
});

test("with excludeChatTypes: [] high-emotion personal milestones from DMs and groups reach the log (no hardcoded exclusion)", async t => {
  const f = fixture(t);
  seedMessage(f, "dm", "msg-birth", "Our daughter was born this morning!", "direct", START - 2 * MINUTE);
  seedMessage(f, "family", "msg-loss", "Grandpa passed away last night.", "group", START - MINUTE);
  const grade = insideOutGrades(f.store.db);
  grade("dm", "msg-birth", { joy: 0.98 }, 2.9, 0.95);
  grade("family", "msg-loss", { sadness: 0.95 }, 2.7, -0.9);
  const respond = (prompt: Prompt): Completion => ({ shouldAppend: true, entries: asSalient(prompt).sessions.flatMap(session =>
    session.messages.filter(m => m.ref).map(m => ({ topic: m.text.includes("born") ? "New baby" : "Family loss",
      summary: m.text.includes("born") ? "Daughter born this morning." : "Grandfather passed away.", messageRefs: [m.ref!] }))) });

  const defaults = provider(respond);
  assert.equal((await f.run({ dryRun: true, runner: defaults.runner })).status, "preview");
  assert.deepEqual(defaults.prompts[0]!.sessions.map(s => s.chatType), ["group"], "the safe default still excludes DMs");

  const { runner, prompts } = provider(respond);
  const result = await f.run({ runner, excludeChatTypes: [] });
  assert.equal(result.status, "appended");
  assert.deepEqual(asSalient(prompts[0]).sessions.map(s => [s.chatType, s.messages[0]?.salience]),
    [["direct", "high — joy/milestone"], ["group", "high — sadness/setback"]]);
  const rows = listCaptainsLogEntries(f.store.db, { agentId: "main" });
  assert.deepEqual(rows.map(row => [row.topic, row.emotionalIntensity]), [["New baby", 2.9], ["Family loss", 2.7]]);
  assert.deepEqual(rows[0]!.channels, [], "a DM never contributes a channel label");
  assert.doesNotMatch(readFileSync(f.file, "utf8"), NO_EMOTION_LEAK);
});

test("pending receipts carry grounded salience so crash recovery persists it", async t => {
  const f = fixture(t);
  const db = f.store.db;
  seedMessage(f, "win", "msg-win", "We won the Sakara contract!");
  insideOutGrades(db)("win", "msg-win", { joy: 0.9 }, 2.4, 0.8);
  failFinalWatermark(db);
  const runner = provider(prompt => ({ shouldAppend: true, entries: [{ topic: "Sakara contract", summary: "Won the Sakara contract.",
    messageRefs: [asSalient(prompt).sessions[0]!.messages[0]!.ref!] }] })).runner;
  assert.equal((await f.run({ runner })).status, "failed");
  const receipt = JSON.parse(f.item()!.artifactJson!).pendingAppend.entries[0];
  assert.equal(receipt.emotionalIntensity, 2.4);
  assert.equal(receipt.salienceSignals.signals[0].messageId, "msg-win");
  assert.doesNotMatch(readFileSync(f.file, "utf8"), NO_EMOTION_LEAK);
  db.exec("DROP TRIGGER fail_final_watermark");
  f.advance(INTERVAL);
  assert.equal((await f.run({ runner })).status, "empty");
  const [row] = listCaptainsLogEntries(db, { agentId: "main" });
  assert.equal(row?.topic, "Sakara contract");
  assert.equal(row?.emotionalIntensity, 2.4);
  assert.ok(Math.abs(row!.salienceScore! - 0.8) < 1e-9);
});

/** Like `provider`, but also records the system prompt (the Responses API `instructions`). */
function instructedProvider(respond: (prompt: Prompt) => Completion) {
  const instructions: string[] = [], prompts: Prompt[] = [];
  const runner = createStewardRunner({ config, resolveApiKey: async () => "test-provider-credential", fetch: async (_url, init) => {
    const request: { instructions: string; input: [{ content: string }] } = JSON.parse(String(init?.body));
    instructions.push(request.instructions);
    const prompt: Prompt = JSON.parse(request.input[0].content);
    prompts.push(prompt);
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(respond(prompt)) }] }] });
  } });
  return { runner, instructions, prompts };
}

test("personal-salience guidance needs an explicit DM opt-in, and the CLI result never carries raw grade payloads", async t => {
  const f = fixture(t);
  seedMessage(f, "family", "msg-loss", "Grandpa passed away last night.", "group", START - MINUTE);
  insideOutGrades(f.store.db)("family", "msg-loss", { sadness: 0.95 }, 2.7, -0.9);
  const respond = (prompt: Prompt): Completion => ({ shouldAppend: true, entries: [{ topic: "Family loss",
    summary: "Grandfather passed away.", messageRefs: [asSalient(prompt).sessions[0]!.messages[0]!.ref!] }] });
  const defaults = instructedProvider(respond);
  assert.equal((await f.run({ dryRun: true, runner: defaults.runner, excludeChatTypes: ["direct"] })).status, "preview");
  assert.equal(asSalient(defaults.prompts[0]).sessions[0]!.messages[0]!.salience, "high — sadness/setback", "the group message is still cued");
  assert.doesNotMatch(defaults.instructions[0]!, /operator opted private sessions in/u, "default group sessions never get personal guidance");

  const optedIn = instructedProvider(respond);
  const result = await f.run({ runner: optedIn.runner, excludeChatTypes: [] });
  assert.match(optedIn.instructions[0]!, /operator opted private sessions in/u);
  assert.equal(result.status, "appended");
  assert.ok(result.status === "appended");
  const [entry] = result.entries;
  assert.equal(entry!.topic, "Family loss");
  assert.equal(entry!.emotionalIntensity, 2.7);
  assert.equal("salienceSignals" in entry!, false, "grade payloads stay in the private ledger");
  assert.doesNotMatch(JSON.stringify(result), /msg-loss|sadness\/setback|"signals"/u);
  const stored = JSON.parse(String(f.store.db.prepare("SELECT salience_signals_json j FROM captains_log_entries").get()!.j));
  assert.equal(stored.signals[0].messageId, "msg-loss", "…where they are still recorded");
});

test("a session-only citation inherits salience only from a session with exactly one human message", async t => {
  const f = fixture(t);
  insertSession(f.database(), { sessionId: "mixed", chatType: "channel" });
  addMessageEvent(f.database(), "mixed", 1, START - 3 * MINUTE, "user", "My father passed away last night.", "msg-grief");
  addMessageEvent(f.database(), "mixed", 2, START - 2 * MINUTE, "user", "Also, I updated the README badges.", "msg-readme");
  seedMessage(f, "solo", "msg-solo", "We closed the Series A today!", "channel", START - MINUTE);
  const grade = insideOutGrades(f.store.db);
  grade("mixed", "msg-grief", { sadness: 0.97 }, 3, -0.95);
  grade("solo", "msg-solo", { joy: 0.95 }, 2.6, 0.9);
  const { runner } = provider(() => ({ shouldAppend: true, entries: [
    { topic: "README", summary: "Refreshed the README badges.", sessionRefs: ["s1"] },
    { topic: "Series A", summary: "Closed the Series A round.", sessionRefs: ["s2"] },
  ] }));
  assert.equal((await f.run({ runner })).status, "appended");
  const rows = listCaptainsLogEntries(f.store.db, { agentId: "main" });
  const byTopic = Object.fromEntries(rows.map(row => [row.topic, row]));
  assert.equal(byTopic.README!.salienceScore, undefined, "a README update never inherits a grief message sharing its session");
  assert.ok(Math.abs(byTopic["Series A"]!.salienceScore! - 2.6 / 3) < 1e-9, "a single-message session still grounds");
});

test("ID-less transcript events join Inside Out grades by the same identity Inside Out stores", async t => {
  const f = fixture(t);
  insertSession(f.database(), { sessionId: "idless", chatType: "channel" });
  const at = START - MINUTE;
  const eventJson = JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "We won the Sakara contract!" }] } });
  f.database().prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run("idless", 1, eventJson, at);
  f.database().prepare("INSERT INTO session_transcript_active_events VALUES (?, ?, ?, ?)").run("idless", 0, 1, 0);
  // Inside Out's live reader sequences and timestamps the parsed event before hashing it.
  const graded = { ...JSON.parse(eventJson), seq: 1, timestamp: new Date(at).toISOString() };
  insideOutGrades(f.store.db)("idless", jsonHash(graded), { joy: 0.9 }, 2.5, 0.8);
  assert.notEqual(jsonHash(graded), jsonHash(JSON.parse(eventJson)));
  const { runner, prompts } = provider(() => noAppend);
  assert.equal((await f.run({ dryRun: true, runner })).status, "no_append");
  assert.equal(asSalient(prompts[0]).sessions[0]!.messages[0]!.salience, "high — joy/milestone");
});
