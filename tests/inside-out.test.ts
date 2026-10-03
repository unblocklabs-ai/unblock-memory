import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveConfig } from "../src/config.js";
import { runInsideOut, reportInsideOut } from "../src/inside-out.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

const emotions = ["joy", "sadness", "fear", "anger", "disgust", "surprise"];
const cfg = (insideOut = {}) => resolveConfig({ typesafe: { apiKey: "fake", timeoutMs: 1000 },
  insideOut: { enabled: true, intervalMinutes: 0, ...insideOut } });
const user = (content: string, senderId = "bek", timestamp?: number) => ({ role: "user", content, timestamp,
  __openclaw: { senderId, senderIdentity: { senderKind: "human" } } });
const assistant = (text: string, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], ...extra });
const event = (id: string, message: unknown, timestamp?: string) => ({ type: "message", id, message, timestamp });

test("session-scoped passes skip unchanged payloads and resume bounded appends, including delayed replies", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-incremental-"));
  const databasePath = join(root, "agent.sqlite"), storePath = join(root, "unblock-memory.sqlite");
  const db = createAgentDatabase(databasePath);
  for (const sessionId of ["one", "two"]) insertSession(db, { sessionId, chatType: "direct" });
  const append = (sessionId: string, seq: number, message: unknown) => {
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run(sessionId, seq,
      JSON.stringify(event(`${sessionId}-${seq}`, message)), seq * 1000);
    db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run(sessionId, seq - 1, seq, seq - 1);
  };
  for (const sessionId of ["one", "two"]) {
    append(sessionId, 1, user("Question")); append(sessionId, 2, assistant("Original answer"));
    append(sessionId, 3, user("Initial thanks", "bek", 3000));
  }
  t.after(() => db.close());
  const requests: { history: { text: string }[]; target: { text: string } }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)).state);
    return Response.json({ answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: 0.3 }])) });
  });
  let payloadReads = 0;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    if (/^\s*SELECT/i.test(sql) && sql.includes("event_json")) payloadReads++;
    return prepare.call(this, sql);
  });
  const options = { agentId: "main", databasePath, storePath, config: cfg(), sessionId: "one" };
  await runInsideOut(options);
  assert.equal(requests.length, 1, "single-session inference cannot upload another session");
  assert.equal(reportInsideOut(storePath).length, 1);
  payloadReads = 0;
  const unchanged = await runInsideOut(options);
  assert.equal(payloadReads, 0, "completed unchanged transcripts are not loaded");
  assert.equal("sources" in unchanged && unchanged.sources, 0);
  assert.equal(requests.length, 1);

  append("one", 4, assistant("New progress"));
  append("one", 5, user("Delayed follow-up", "bek", 2500));
  append("one", 6, user("New follow-up", "bek", 6000));
  await runInsideOut({ ...options, config: cfg({ maxInteractions: 1 }) });
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.target.text, "Delayed follow-up");
  assert.ok(requests[1]?.history.some(m => m.text === "Original answer"));
  assert.ok(!requests[1]?.history.some(m => m.text === "New progress"));
  await runInsideOut(options);
  assert.equal(requests.length, 3, "the next pass resumes without repeating the bounded pass");
  assert.equal(requests[2]?.target.text, "New follow-up");
  assert.ok(requests[2]?.history.some(m => m.text === "Initial thanks"));
  payloadReads = 0;
  await runInsideOut(options);
  assert.equal(payloadReads, 0);
  assert.equal(requests.length, 3);

  await runInsideOut({ ...options, sessionId: "two" });
  assert.equal(requests.length, 4);
  assert.equal(reportInsideOut(storePath, { sessionId: "one" }).length, 3);
  assert.equal(reportInsideOut(storePath, { sessionId: "two" }).length, 1);
  payloadReads = 0;
  await runInsideOut({ ...options, sessionId: undefined });
  assert.equal(payloadReads, 0, "an all-session pass also skips completed sources");
  assert.equal(requests.length, 4);
});

test("Inside Out uses real OpenClaw storage: follow-ups, queued progress replies, archives, caching and reports", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-sdk-"));
  const state = join(root, "state"), time = Date.UTC(2026, 9, 2, 12, 0, 0, 250);
  const messages = [user("Please help."), assistant("<details><summary>Update</summary>Here you go.</details>"),
    user("Great!", "bek", time + 2000), user("Also this, please.", "bek", time + 3000),
    assistant("Working on it.", { channel: "commentary", stopReason: "toolUse" }),
    assistant("Done.\n\nDone.", { stopReason: "stop" }), user("Please include this too.", "alex", time + 4500),
    user("Thank you.", "bek", time + 8000)];
  // Offline SDK writers create genuine v19 projections and zstd archive blobs in an isolated state dir.
  const script = `
    globalThis.fetch = () => { throw new Error("Fixture must stay offline"); };
    const store = await import(${JSON.stringify(import.meta.resolve("openclaw/plugin-sdk/session-store-runtime"))});
    const transcript = await import(${JSON.stringify(import.meta.resolve("openclaw/plugin-sdk/session-transcript-runtime"))});
    const messages = ${JSON.stringify(messages)};
    for (const [sessionId, channel] of [["live", "discord"], ["archived", "telegram"]]) {
      const sessionKey = "agent:main:" + channel + ":direct:bek";
      await store.upsertSessionEntry({agentId:"main",sessionKey,entry:{sessionId,updatedAt:${time},chatType:"direct",
        delivery:store.normalizeSessionDeliveryState({context:{channel,to:"bek",accountId:"account"}})}});
      for (const [i,message] of messages.entries()) {
        const result = await transcript.appendSessionTranscriptMessageByIdentity({agentId:"main",sessionId,sessionKey,
          eventId:"m"+i,now:${time}+i*1000,message});
        if (!result?.appended) throw new Error("SDK did not append fixture message");
      }
      if (sessionId === "archived") await store.deleteSessionEntry({agentId:"main",sessionKey,archiveTranscript:true});
    }
  `;
  const scriptPath = join(root, "write-fixture.mjs");
  await writeFile(scriptPath, script);
  await promisify(execFile)(process.execPath, [scriptPath], {
    cwd: root, env: { ...process.env, OPENCLAW_STATE_DIR: state }, timeout: 45_000,
  });
  const options = { agentId: "main", databasePath: join(state, "agents/main/agent/openclaw-agent.sqlite"),
    sessionsDir: join(state, "agents/main/sessions"), storePath: join(root, "unblock-memory.sqlite"),
    config: cfg({ maxInteractions: 3 }) };
  assert.ok(existsSync(options.databasePath));
  type Message = { id: string; text: string; human?: string };
  const requests: { state: { history: Message[]; target: Message }; questions: Record<string, { type: string }> }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)); requests.push(request);
    return Response.json({ model: "jev-1.13.0", answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: e === "joy" ? 0.85 : 0.05 }])) });
  });
  const first = await runInsideOut(options);
  assert.equal("reviewed" in first && first.reviewed, 3);
  await runInsideOut({ ...options, config: cfg() });
  const rows = reportInsideOut(options.storePath);
  assert.equal(rows.length, 8);
  assert.equal(requests.length, 8);
  for (const request of requests) {
    assert.deepEqual(Object.keys(request.questions).sort(), [...emotions].sort());
    assert.ok(Object.values(request.questions).every(q => q.type === "noul"));
    const target = request.state.target;
    if (target.text === "Please include this too.") {
      assert.equal(request.state.history.filter(m => m.text.includes("Done.")).length, 0);
      assert.ok(request.state.history.some(m => m.text === "Working on it."));
      assert.ok(target.human?.includes("alex"));
    }
    if (target.text === "Also this, please.") assert.ok(request.state.history.some(m => m.text === "Great!"));
  }
  let payloadReads = 0;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    if (/^\s*SELECT/i.test(sql) && (sql.includes("event_json") || sql.startsWith("SELECT archive_blob,"))) payloadReads++;
    return prepare.call(this, sql);
  });
  const unchanged = await runInsideOut({ ...options, config: cfg() });
  assert.equal("sources" in unchanged && unchanged.sources, 0);
  assert.equal(payloadReads, 0, "unchanged SDK transcripts and compressed archive blobs are never loaded");
  assert.equal(requests.length, 8, "successful interactions are never inferred twice across copies or runs");
  const summaries = reportInsideOut(options.storePath, { summary: true, sender: "bek", bucket: "week" });
  assert.equal(summaries.length, 2);
  assert.ok(summaries.every(s => s.interactions === 3 && s.joy === 0.85));
  assert.equal(reportInsideOut(options.storePath, { emotion: "anger", min: 0.8 }).length, 0);
  assert.equal(reportInsideOut(options.storePath, { sender: "alex" }).length, 2);
  const sourceDb = new DatabaseSync(options.databasePath, { readOnly: true });
  assert.equal(sourceDb.prepare("SELECT encoding FROM session_transcript_archives").get()?.encoding, "zstd");
  sourceDb.close();

  // Exercise actual Commander commands and Gateway startup/stop against that same SDK-written database.
  const commander = createRequire(import.meta.resolve("openclaw/plugin-sdk/session-store-runtime")).resolve("commander");
  const cliPath = join(root, "cli-fixture.mjs");
  await writeFile(cliPath, `
    const { Command } = await import(${JSON.stringify(pathToFileURL(commander).href)});
    const { registerInsideOut } = await import(${JSON.stringify(new URL("../src/inside-out-runtime.ts", import.meta.url).href)});
    const { resolveConfig } = await import(${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)});
    let calls = 0, channel = "telegram";
    globalThis.fetch = async (_url,init) => {
      if (JSON.parse(JSON.parse(init.body).state.target.human)[0] !== channel) throw new Error("Wrong session uploaded");
      calls++; return Response.json({answers:Object.fromEntries(
      ${JSON.stringify(emotions)}.map(e => [e,{type:"noul",noul:0.7}]))}); };
    const program = new Command(), output = [], hooks = {};
    console.log = text => output.push(JSON.parse(text));
    registerInsideOut({config:{},registerCli:fn=>fn({program,config:{}}),on:(name,fn)=>hooks[name]=fn,
      logger:{warn:text=>{throw new Error(text)}}}, resolveConfig({insideOut:{enabled:true},typesafe:{apiKey:"fake"}}));
    await program.parseAsync(["node","openclaw","memory-emotions","run","--session","archived"]);
    await program.parseAsync(["node","openclaw","memory-emotions","report","--session","archived","--sender","bek"]);
    await program.parseAsync(["node","openclaw","memory-emotions","export","--session","archived","--emotion","joy","--min","0.5"]);
    channel = "discord";
    await program.parseAsync(["node","openclaw","memory-emotions","run","--session","live"]);
    hooks.gateway_start();
    await new Promise(setImmediate);
    await hooks.gateway_stop();
    process.stdout.write(JSON.stringify({output,calls}));
  `);
  const cli = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), cliPath], {
    cwd: root, env: { ...process.env, OPENCLAW_STATE_DIR: state }, timeout: 45_000,
  });
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.output[0].reviewed, 4);
  assert.equal(cliResult.output[1].length, 1);
  assert.equal(cliResult.output[2].length, 4);
  assert.equal(cliResult.output[3].reviewed, 4);
  assert.equal(cliResult.calls, 8, "reports and the cached background pass do not repeat inference");
});

test("legacy files keep whole messages, unknown identities, broad formatting, branches and bounded context", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-files-")), sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  const events: { type: string; id?: string; parentId?: string | null; targetId?: string; message?: unknown }[] = [
    { type: "session", id: "old" }, event("a", assistant("x".repeat(3000))),
    event("b", user("Old request.")), event("c", assistant("Done.\n\nDone.")), event("d", { role: "user", content: "Thanks!" }),
    { ...event("wrong", user("Abandoned branch")), parentId: "c" },
    { ...event("e", user("Another follow-up")), parentId: "d" }, { type: "leaf", targetId: "e" }];
  events[1] = { ...events[1], parentId: null };
  for (let i = 2; i < 5; i++) events[i] = { ...events[i], parentId: events[i - 1]!.id };
  await writeFile(join(sessionsDir, "old.jsonl.reset.test.zst"), zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join("\n"))));
  const requests: { history: { text: string }[]; target: { text: string } }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const { state } = JSON.parse(String(init.body)); requests.push(state);
    return Response.json({ answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: 0.1 }])) });
  });
  const options = { agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir,
    storePath: join(root, "unblock-memory.sqlite"), config: cfg({ maxContextTokens: 256 }) };
  await runInsideOut(options);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(s => ![...s.history, s.target].some(m => m.text === "Abandoned branch" || m.text.includes("xxx"))));
  assert.ok(requests[0]!.history.some(m => m.text === "Done.\n\nDone."));
  const rows = reportInsideOut(options.storePath);
  assert.equal(rows.length, 3, "oversized essential pairs are recorded as errors, not truncated or uploaded");
  assert.ok(rows.some(r => String(r.human_key).includes("session:old")));
  assert.ok(rows.some(r => r.context_trimmed === 1));
  const unchanged = await runInsideOut(options);
  assert.equal("sources" in unchanged && unchanged.sources, 0);
  assert.equal(requests.length, 2, "unchanged compressed files are skipped, including cooled-down errors");
  events.pop();
  events.push({ ...event("f", user("Latest follow-up")), parentId: "e" }, { type: "leaf", targetId: "f" });
  await writeFile(join(sessionsDir, "old.jsonl.reset.test.zst"), zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join("\n"))));
  await runInsideOut(options);
  assert.equal(requests.length, 3, "changed files review only previously unseen replies");
  assert.equal(requests[2]?.target.text, "Latest follow-up");
});

test("opt-in, tool/automation filtering and failed-request retries through the persisted runner", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-retry-"));
  const databasePath = join(root, "agent.sqlite"), db = createAgentDatabase(databasePath);
  insertSession(db, { sessionId: "s", chatType: "direct" });
  const messages = [user("Q"), assistant("Progress", { channel: "commentary", content: [
      { type: "text", text: "Progress<think>INTERNAL_REASONING</think>" },
      { type: "thinking", thinking: "INTERNAL_THINKING" },
      { type: "toolCall", id: "call", name: "exec", arguments: { command: "INTERNAL_TOOL_CALL" } },
      { type: "tool_result", content: [{ type: "text", text: "INTERNAL_NESTED_RESULT" }] },
    ] }),
    { role: "toolResult", content: [{ type: "text", text: "INTERNAL_TOOL_RESULT" }] },
    { role: "tool", content: "INTERNAL_TOOL_ROLE" },
    { role: "system", content: "INTERNAL_SYSTEM" },
    { role: "assistant", content: [{ type: "toolCall", name: "exec", arguments: { command: "INTERNAL_TOOL_ONLY" } }] },
    { ...user("Fast reply"), provenance: { kind: "external_user" } },
    { ...user("Internal reply"), provenance: { kind: "internal_system" } },
    { ...user("Agent relay"), provenance: { kind: "inter_session" } },
    { ...user("Bot reply"), __openclaw: { senderIdentity: { senderKind: "bot" } } },
    user("[cron:abc] Scheduled task"), assistant("Automation output"), user("Human reply")];
  messages.forEach((message, i) => {
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("s", i + 1, JSON.stringify(event(`m${i}`, message)), 1000 + i);
    db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run("s", i, i + 1, i);
  });
  db.close();
  const options = { agentId: "main", databasePath, storePath: join(root, "unblock-memory.sqlite"), config: cfg() };
  const mock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const { state } = JSON.parse(String(init.body));
    assert.ok(!JSON.stringify(state).includes("INTERNAL_"), "tool payloads, system text and hidden reasoning never reach Jev");
    if (state.target.text === "Fast reply") assert.ok(state.history.some((m: { text: string }) => m.text === "Progress"));
    return Response.json({ answers: {} });
  });
  assert.deepEqual(await runInsideOut({ ...options, config: resolveConfig({}) }), { status: "disabled" });
  assert.ok(!existsSync(options.storePath));
  const failed = await runInsideOut(options);
  assert.equal("failed" in failed && failed.failed, 2);
  assert.ok(reportInsideOut(options.storePath).every(r => r.joy === null && typeof r.error === "string"));
  const cooling = await runInsideOut(options);
  assert.equal("sources" in cooling && cooling.sources, 0, "unchanged failed sources also skip payloads during cooldown");
  assert.equal(mock.mock.callCount(), 2, "failed jobs cool down so they do not starve backfill");
  mock.mock.mockImplementation(async () => Response.json({ answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: 0.4 }])) }));
  await runInsideOut({ ...options, retry: true });
  assert.ok(reportInsideOut(options.storePath).every(r => r.error === null && r.joy === 0.4));
  assert.equal(reportInsideOut(options.storePath, { summary: true })[0]?.interactions, 2);

  const writer = new DatabaseSync(databasePath);
  writer.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("s", 99, JSON.stringify(event("later", user("Later follow-up"))), 99000);
  writer.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run("s", 99, 99, 99);
  writer.close();
  mock.mock.mockImplementation(async () => Response.json({ answers: {} }));
  await runInsideOut(options);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 3600_001);
  mock.mock.mockImplementation(async () => Response.json({ answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: 0.4 }])) }));
  const retried = await runInsideOut(options);
  assert.equal("reviewed" in retried && retried.reviewed, 1, "due failures retry even when the source has not changed");
  assert.ok(reportInsideOut(options.storePath).every(r => r.error === null));
});

test("bounded passes discover new replies before retries and leave oversized failures for explicit retry", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-forward-"));
  const databasePath = join(root, "agent.sqlite"), db = createAgentDatabase(databasePath);
  for (const sessionId of ["one", "two"]) insertSession(db, { sessionId, chatType: "direct" });
  const append = (sessionId: string, seq: number, message: unknown) => {
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run(sessionId, seq,
      JSON.stringify(event(`${sessionId}-${seq}`, message)), seq * 1000);
    db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run(sessionId, seq - 1, seq, seq - 1);
  };
  t.after(() => db.close());
  append("one", 1, assistant("Answer"));
  const longReply = "x".repeat(75000);
  append("one", 2, user(longReply));
  append("one", 3, user("Temporary failure"));
  append("two", 1, assistant("Other answer"));
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const targets: string[] = [];
  let unavailable = true;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const target = JSON.parse(String(init.body)).state.target.text;
    targets.push(target);
    return Response.json({ answers: unavailable ? {} : Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: 0.4 }])) });
  });
  const options = { agentId: "main", databasePath, storePath: join(root, "unblock-memory.sqlite"),
    config: cfg({ maxInteractions: 2, maxContextTokens: 256 }) };
  const first = await runInsideOut(options);
  assert.equal("failed" in first && first.failed, 2);
  const oversizedAt = reportInsideOut(options.storePath).find(r => r.message_id === "one-2")?.reviewed_at;
  now += 86400_000;
  unavailable = false;
  targets.length = 0;
  append("one", 4, user("New reply"));
  append("two", 2, user("Other new reply"));
  const next = await runInsideOut(options);
  assert.equal("reviewed" in next && next.reviewed, 2);
  assert.deepEqual(targets, ["New reply", "Other new reply"], "new work across sessions wins over old failures");
  targets.length = 0;
  now += 86400_000;
  await runInsideOut(options);
  assert.deepEqual(targets, ["Temporary failure"], "remaining capacity retries transient failures only");
  assert.equal(reportInsideOut(options.storePath).find(r => r.message_id === "one-2")?.reviewed_at, oversizedAt);
  const unchanged = await runInsideOut(options);
  assert.equal("sources" in unchanged && unchanged.sources, 0, "permanent budget failures do not trigger transcript reads");
  targets.length = 0;
  await runInsideOut({ ...options, retry: true, config: cfg() });
  assert.deepEqual(targets, [longReply], "the default budget retries long replies whole without repeating successes");
  assert.ok(reportInsideOut(options.storePath).every(r => r.error === null), "explicit retry can reconsider budget failures");
});

test("an unavailable failed copy does not reset the live transcript checkpoint", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-siblings-")), sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  const databasePath = join(root, "agent.sqlite"), db = createAgentDatabase(databasePath);
  insertSession(db, { sessionId: "s", chatType: "direct" });
  const append = (seq: number, message: unknown) => {
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("s", seq, JSON.stringify(event(`live-${seq}`, message)), seq * 1000);
    db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run("s", seq - 1, seq, seq - 1);
  };
  t.after(() => db.close());
  append(1, assistant("Live answer")); append(2, user("Thanks"));
  const oldPath = join(sessionsDir, "s.jsonl.reset.old");
  await writeFile(oldPath, [{ type: "session", id: "s" }, event("old-a", assistant("Old answer")),
    event("old-b", user("Old failed reply"))].map(e => JSON.stringify(e)).join("\n"));
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => Response.json({
    answers: JSON.parse(String(init.body)).state.target.text === "Old failed reply" ? {}
      : Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: 0.4 }])),
  }));
  const options = { agentId: "main", databasePath, sessionsDir, storePath: join(root, "unblock-memory.sqlite"),
    config: cfg({ maxContextTokens: 256 }) };
  await runInsideOut(options);
  await rename(oldPath, `${oldPath}.tmp`);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 86400_000);
  append(3, user("Latest reply"));
  await runInsideOut(options);
  const unchanged = await runInsideOut(options);
  assert.equal("sources" in unchanged && unchanged.sources, 0, "failure in a missing copy cannot reopen a healthy source");
  assert.equal(reportInsideOut(options.storePath).filter(r => r.error === null).length, 2);
});

test("single-session file passes ignore unrelated corruption and preserve legacy header identities", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-file-scope-")), sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  const events = [{ type: "session", id: "selected" }, event("a", assistant("Answer")), event("b", user("Thanks"))];
  await writeFile(join(sessionsDir, "selected.jsonl"), events.map(e => JSON.stringify(e)).join("\n"));
  await writeFile(join(sessionsDir, "legacy-name.jsonl"), [{ type: "session", id: "selected" },
    event("c", assistant("Another answer")), event("d", user("Legacy thanks"))].map(e => JSON.stringify(e)).join("\n"));
  await writeFile(join(sessionsDir, "legacy-compressed.jsonl.zst"), zstdCompressSync(Buffer.from([
    { type: "session", id: "selected" }, event("e", assistant("Archived answer")), event("f", user("Archive thanks")),
  ].map(e => JSON.stringify(e)).join("\n"))));
  await writeFile(join(sessionsDir, "unrelated.jsonl"), "invalid JSON");
  await writeFile(join(sessionsDir, "unrelated-compressed.jsonl.zst"), Buffer.from("invalid zstd"));
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: 0.4 }])) }));
  const options = { agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir,
    storePath: join(root, "unblock-memory.sqlite"), config: cfg(), sessionId: "selected" };
  const first = await runInsideOut(options);
  assert.deepEqual("errors" in first && first.errors, [], "an unrelated malformed file cannot fail the canary");
  assert.equal("reviewed" in first && first.reviewed, 3);
  const unchanged = await runInsideOut(options);
  assert.deepEqual("errors" in unchanged && unchanged.errors, []);
  assert.equal("sources" in unchanged && unchanged.sources, 0);
  assert.equal(mock.mock.callCount(), 3);
});
