import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveConfig } from "../src/config.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { INSIDE_OUT_WORK_KIND, INSIDE_OUT_WORK_SCOPE, interruptInsideOut, linkInsideOutPeople, purgeInsideOutPerson, repairInsideOutIdentities, reportInsideOut, reportInsideOutBaselines, runInsideOut } from "../src/inside-out.js";
import { WorkFenceLostError } from "../src/work-store.js";
import { registerInsideOut } from "../src/inside-out-runtime.js";
import { PeopleStore } from "../src/people-store.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

const emotions = ["joy", "sadness", "fear", "anger", "disgust", "surprise"];
const cfg = (insideOut = {}) => resolveConfig({ decisionModel: { apiKey: "fake", timeoutMs: 1000 },
  insideOut: { enabled: true, intervalMinutes: 0, ...insideOut } });
const user = (content: string, senderId = "bek", timestamp?: number) => ({ role: "user", content, timestamp,
  __openclaw: { senderId, senderIdentity: { senderKind: "human" } } });
const assistant = (text: string, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], ...extra });
const event = (id: string, message: unknown, timestamp?: string) => ({ type: "message", id, message, timestamp });

test("Inside Out judges visible replies, not replay metadata, and leaves unsafe inputs unassessed", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-visible-"));
  const databasePath = join(root, "agent.sqlite"), db = createAgentDatabase(databasePath);
  t.after(() => db.close());
  const decorated = (text: string, upstreamUserText: string) => {
    const message = user(text);
    return { ...message, __openclaw: { ...message.__openclaw, upstreamUserText } };
  };
  const literal = "Please explain <conversation_context>this literal tag</conversation_context>.";
  const legacy = 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"sender":{"id":"bek","name":"Bek"}}\n```\n' +
    'PRIVATE_LEGACY_HISTORY\nSystem: [now] Slack DM from Bek\n\nLegacy thanks\n\nContext: ⟦openclaw:ctx⟧\nPRIVATE_CHANNEL_CONTEXT';
  const scenarios = [
    { id: "native", messages: [decorated("Original question", "PRIVATE_PRIOR_REPLAY"), assistant("Visible answer"),
      decorated("Short reply", "<conversation_context>" + "PRIVATE_UPSTREAM ".repeat(7000) +
        "</conversation_context>\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>PRIVATE_SYSTEM_CONTEXT")] },
    { id: "legacy", messages: [assistant("Legacy answer"), decorated(legacy, "PRIVATE_LEGACY_REPLAY")] },
    { id: "oversized", messages: [assistant("Short answer"), decorated("x".repeat(100000), "Incorrect substituted reply")] },
    { id: "ambiguous", messages: [assistant("Before unsafe boundary"),
      user("Conversation info: ⟦openclaw:ctx⟧\n```json\nbroken\n```\nPRIVATE_AMBIGUOUS_CONTEXT"),
      user("No safe preceding assistant"), assistant("After unsafe boundary"), user("Safe follow-up")] },
    { id: "literal", messages: [assistant("Literal answer"), user(literal)] },
  ];
  for (const scenario of scenarios) {
    insertSession(db, { sessionId: scenario.id, chatType: "direct" });
    for (const [i, message] of scenario.messages.entries()) {
      db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run(scenario.id, i + 1,
        JSON.stringify(event(`${scenario.id}-${i}`, message)), (i + 1) * 1000);
      db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run(scenario.id, i, i + 1, i);
    }
  }
  const requests: { target: { text: string }; history: { text: string }[] }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)).state[0]);
    return Response.json({ answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: 0.4 }])) });
  });
  const storePath = join(root, "unblock-memory.sqlite");
  await runInsideOut({ agentId: "main", databasePath, storePath, config: cfg() });
  assert.deepEqual(requests.map(r => r.target.text).sort(), ["Short reply", "Legacy thanks", "Safe follow-up", literal].sort());
  assert.ok(!JSON.stringify(requests).includes("PRIVATE_"), "replay metadata and transport context never reach the decision model");
  assert.deepEqual(requests.find(r => r.target.text === "Short reply")?.history.map(m => m.text),
    ["Original question", "Visible answer"]);
  assert.deepEqual(requests.find(r => r.target.text === "Safe follow-up")?.history.map(m => m.text),
    ["No safe preceding assistant", "After unsafe boundary"]);
  const rows = reportInsideOut(storePath);
  assert.equal(rows.length, 5, "ambiguous replies are not assessed; genuine oversized text remains recorded");
  const oversized = rows.find(r => r.session_id === "oversized");
  assert.equal(oversized?.error, "Target reply and preceding assistant exceed context budget");
  assert.ok(emotions.every(e => oversized?.[e] === null), "oversized inputs receive no fabricated emotion scores");
});

test("People links are stored on new reviews and backfilled on legacy rows without repeating the decision model", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-people-")), sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  const storePath = join(root, "unblock-memory.sqlite");
  const people = new PeopleStore(storePath, { maxOpenTodos: 100, maxBlurbChars: 1000 });
  t.after(() => people.close());
  const first = people.upsertIdentity({ provider: "slack", accountScope: "default", externalId: "U111", displayName: "Bek" }).person.id;
  const other = people.upsertIdentity({ provider: "slack", accountScope: "other", externalId: "U111", displayName: "Other person" }).person.id;
  const reply = (channel: string, accountId: string, senderId = "U111") => ({ ...user("Thanks!", senderId),
    __openclaw: { senderId, senderIdentity: { senderKind: "human", pluginId: channel, accountId } } });
  await writeFile(join(sessionsDir, "s.jsonl"), [{ type: "session", id: "s" }, event("a", assistant("Answer")),
    event("b", reply("slack", "default")), event("c", reply("slack", "other")),
    event("d", reply("telegram", "default")), event("e", reply("slack", "default", "unknown"))]
    .map(e => JSON.stringify(e)).join("\n"));
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: 0.4 }])),
  }));
  const options = { agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir, storePath, config: cfg() };
  await runInsideOut(options);
  const rows = reportInsideOut(storePath);
  assert.equal(rows.find(r => r.message_id === "b")?.person_id, first);
  assert.equal(rows.find(r => r.message_id === "c")?.person_id, other);
  assert.equal(rows.find(r => r.message_id === "d")?.person_id, null, "same user ID in another provider is not the same identity");
  assert.equal(rows.find(r => r.message_id === "e")?.person_id, null);
  assert.equal(fetch.mock.callCount(), 4);

  // Downgrade the genuinely written table to the previous release's shape.
  const db = new DatabaseSync(storePath);
  t.after(() => db.close());
  db.exec("DROP INDEX inside_out_person_time; ALTER TABLE inside_out DROP COLUMN person_id");
  const before = reportInsideOut(storePath).map(row => ({ ...row }));
  assert.deepEqual(reportInsideOut(storePath, { personId: first, personal: true }), [], "legacy unlinked rows remain readable without migration");
  assert.deepEqual(linkInsideOutPeople(storePath), { updated: 2, linked: 2, unlinked: 2 });
  assert.deepEqual(reportInsideOut(storePath).map(({ person_id: _person, ...row }) => row), before,
    "backfill changes only person links, not judgments or their original provenance");
  assert.deepEqual(linkInsideOutPeople(storePath), { updated: 0, linked: 2, unlinked: 2 });
  const telegram = people.upsertIdentity({ provider: "telegram", accountScope: "default", externalId: "U111" }).person.id;
  assert.deepEqual(linkInsideOutPeople(storePath), { updated: 1, linked: 3, unlinked: 1 });
  assert.equal(reportInsideOut(storePath).find(r => r.message_id === "d")?.person_id, telegram);
  db.prepare("UPDATE person_identities SET person_id=? WHERE provider='slack' AND account_scope='other'").run(first);
  db.exec("DELETE FROM person_identities WHERE provider='telegram'");
  assert.deepEqual(linkInsideOutPeople(storePath), { updated: 2, linked: 2, unlinked: 2 });
  assert.equal(reportInsideOut(storePath).find(r => r.message_id === "c")?.person_id, first);
  assert.equal(reportInsideOut(storePath).find(r => r.message_id === "d")?.person_id, null);
  await runInsideOut(options);
  assert.equal(fetch.mock.callCount(), 4, "migration, linking and cached reruns do not repeat inference");
});

test("legacy sender metadata links only unambiguous People identities without guessing owners or account scope", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-legacy-people-")), sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  const storePath = join(root, "unblock-memory.sqlite");
  const people = new PeopleStore(storePath, { maxOpenTodos: 100, maxBlurbChars: 1000 });
  t.after(() => people.close());
  const known = people.upsertIdentity({ provider: "slack", accountScope: "default", externalId: "U111" }).person.id;
  people.upsertIdentity({ provider: "slack", accountScope: "other", externalId: "U111" });
  const unique = people.upsertIdentity({ provider: "slack", accountScope: "default", externalId: "U222" }).person.id;
  const legacy = (senderId: string, extra = {}) => ({ role: "user", content: "Thanks!", sourceChannel: "slack", senderId,
    __openclaw: { senderIsOwner: true }, ...extra });
  await writeFile(join(sessionsDir, "old.jsonl"), [{ type: "session", id: "old" }, event("a", assistant("Answer")),
    event("unique", legacy("U222")), event("ambiguous", legacy("U111")),
    event("wrong-account", legacy("U222", { __openclaw: { senderIdentity: { accountId: "missing" } } })),
    event("modern", legacy("U222", { sourceChannel: "telegram", __openclaw: {
      senderIdentity: { id: "U111", pluginId: "slack", accountId: "default" } } })),
    event("owner", { role: "user", content: "From: Bek (U222)\nThanks!", sourceChannel: "slack", senderName: "Bek",
      __openclaw: { senderIsOwner: true } }), event("other-provider", legacy("U222", { sourceChannel: "telegram" }))]
    .map(e => JSON.stringify(e)).join("\n"));
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: 0.4 }])),
  }));
  const options = { agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir, storePath, config: cfg() };
  await runInsideOut(options);
  const rows = reportInsideOut(storePath);
  assert.equal(rows.find(r => r.message_id === "unique")?.person_id, unique);
  assert.equal(rows.find(r => r.message_id === "unique")?.sender_id, "U222", "explicit legacy ID takes precedence over owner alias");
  assert.equal(rows.find(r => r.message_id === "ambiguous")?.person_id, null);
  assert.equal(rows.find(r => r.message_id === "wrong-account")?.person_id, null, "known account mismatch cannot use the fallback");
  assert.equal(rows.find(r => r.message_id === "modern")?.person_id, known, "modern sender metadata takes precedence");
  assert.equal(rows.find(r => r.message_id === "owner")?.person_id, null, "names and body envelopes do not establish identity");
  assert.equal(rows.find(r => r.message_id === "other-provider")?.person_id, null);
  assert.equal(fetch.mock.callCount(), 6);

  // Recreate the old reader's persisted identity, then repair through the production backfill path.
  const db = new DatabaseSync(storePath);
  t.after(() => db.close());
  db.prepare("UPDATE inside_out SET person_id=NULL,channel='local',sender_id='owner',human_key=? WHERE message_id='unique'")
    .run(JSON.stringify(["local", "session:old", "owner"]));
  const immutable = () => reportInsideOut(storePath).map(({ channel: _channel, sender_id: _sender, human_key: _human, person_id: _person, ...row }) => row);
  const before = immutable(), checkpoints = db.prepare("SELECT * FROM inside_out_checkpoints").all();
  fetch.mock.mockImplementation(async () => { throw new Error("Identity repair must not call the decision model"); });
  assert.deepEqual(await repairInsideOutIdentities(options), { repaired: 1, errors: [] });
  assert.deepEqual(linkInsideOutPeople(storePath), { updated: 1, linked: 2, unlinked: 4 });
  assert.deepEqual(reportInsideOut(storePath).find(r => r.message_id === "unique"), rows.find(r => r.message_id === "unique"));
  assert.deepEqual(immutable(), before, "identity repair preserves every non-identity review field");
  assert.deepEqual(db.prepare("SELECT * FROM inside_out_checkpoints").all(), checkpoints);
  assert.deepEqual(await repairInsideOutIdentities(options), { repaired: 0, errors: [] });
  assert.deepEqual(linkInsideOutPeople(storePath), { updated: 0, linked: 2, unlinked: 4 });
  await runInsideOut(options);
  assert.equal(fetch.mock.callCount(), 6, "repair and unchanged runs never repeat inference");
});

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
    requests.push(JSON.parse(String(init.body)).state[0]);
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
  const root = await realpath(await mkdtemp(join(tmpdir(), "inside-out-sdk-")));
  const state = join(root, "state"), time = Date.UTC(2026, 9, 2, 12, 0, 0, 250);
  const childOptions = { cwd: root, timeout: 45_000, env: {
    ...process.env, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"),
  } };
  const messages = [user("Please help."), assistant("<details><summary>Update</summary>Here you go.</details>"),
    user("Great!", "bek", time + 2000), user("Also this, please.", "bek", time + 3000),
    assistant("Working on it.", { channel: "commentary", stopReason: "toolUse" }),
    assistant("Done.\n\nDone.", { stopReason: "stop" }), user("Please include this too.", "alex", time + 4500),
    user("Thank you.", "bek", time + 8000)];
  // Let the SDK write the current projections, compressed events and archive.
  const script = `
    // Keep SDK retention relative to the fixture, not the date the test is run.
    const appendOnly = process.argv[2] === "append";
    Date.now = () => appendOnly ? ${time + 22_000} : ${time};
    globalThis.fetch = () => { throw new Error("Fixture must stay offline"); };
    const { captureRuntimeConfigAsyncReader } = await import(${JSON.stringify(import.meta.resolve("openclaw/plugin-sdk/runtime-config-snapshot"))});
    await captureRuntimeConfigAsyncReader()();
    const store = await import(${JSON.stringify(import.meta.resolve("openclaw/plugin-sdk/session-store-runtime"))});
    const transcript = await import(${JSON.stringify(import.meta.resolve("openclaw/plugin-sdk/session-transcript-runtime"))});
    const append = async (sessionId, sessionKey, messages, eventPrefix, now) => {
      for (const [i, message] of messages.entries()) {
        const result = await transcript.appendSessionTranscriptMessageByIdentity({
          agentId: "main", sessionId, sessionKey, eventId: eventPrefix + i, now: now + i * 1000, message,
        });
        if (!result?.appended) throw new Error("SDK did not append fixture message");
      }
    };
    if (appendOnly) {
      // Whitespace triggers host compression but does not change the visible text.
      const padding = " ".repeat(100_000);
      const turn = ${JSON.stringify([assistant("New compressed answer."), user("That makes me happy!", "bek", time + 21_000)])};
      for (const message of turn) {
        if (typeof message.content === "string") message.content += padding;
        else message.content[0].text += padding;
      }
      await append("live", "agent:main:discord:direct:bek", turn, "compressed-", ${time + 20_000});
    } else {
      const messages = ${JSON.stringify(messages)};
      for (const [sessionId, channel] of [["live", "discord"], ["archived", "telegram"]]) {
        const sessionKey = "agent:main:" + channel + ":direct:bek";
        await store.upsertSessionEntry({agentId:"main",sessionKey,entry:{sessionId,updatedAt:${time},chatType:"direct",
          delivery:store.normalizeSessionDeliveryState({context:{channel,to:"bek",accountId:"account"}})}});
        await append(sessionId, sessionKey, messages, "m", ${time});
        if (sessionId === "archived") await store.deleteSessionEntry({agentId:"main",sessionKey,archiveTranscript:true});
      }
    }
  `;
  const scriptPath = join(root, "write-fixture.mjs");
  await writeFile(scriptPath, script);
  await promisify(execFile)(process.execPath, [scriptPath], childOptions);
  const options = { agentId: "main", databasePath: join(state, "agents/main/agent/openclaw-agent.sqlite"),
    sessionsDir: join(state, "agents/main/sessions"), storePath: join(root, "unblock-memory.sqlite"),
    config: cfg({ maxInteractions: 3 }) };
  assert.ok(existsSync(options.databasePath));
  type Message = { id: string; text: string; human?: string };
  const requests: { state: [{ history: Message[]; target: Message }]; questions: Record<string, { type: string }> }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)); requests.push(request);
    return Response.json({ model: "liquid/d1.2-ultra-20261116", answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: e === "joy" ? 0.85 : 0.05 }])) });
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
    const [state] = request.state;
    const target = state.target;
    if (target.text === "Please include this too.") {
      assert.equal(state.history.filter(m => m.text.includes("Done.")).length, 0);
      assert.ok(state.history.some(m => m.text === "Working on it."));
      assert.ok(target.human?.includes("alex"));
    }
    if (target.text === "Also this, please.") assert.ok(state.history.some(m => m.text === "Great!"));
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
    Date.now = () => ${time + 14 * 86400_000};
    const { Command } = await import(${JSON.stringify(pathToFileURL(commander).href)});
    const { registerInsideOut } = await import(${JSON.stringify(new URL("../src/inside-out-runtime.ts", import.meta.url).href)});
    const { resolveConfig } = await import(${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)});
    const { PeopleStore } = await import(${JSON.stringify(new URL("../src/people-store.ts", import.meta.url).href)});
    const people = new PeopleStore(${JSON.stringify(join(state, "agents/main/unblock-memory/unblock-memory.sqlite"))}, {maxOpenTodos:100,maxBlurbChars:1000});
    const person = people.upsertIdentity({provider:"telegram",accountScope:"account",externalId:"bek"}).person.id;
    people.upsertIdentity({provider:"discord",accountScope:"account",externalId:"bek"});
    people.close();
    let calls = 0, channel = "telegram";
    globalThis.fetch = async (_url,init) => {
      if (JSON.parse(JSON.parse(init.body).state[0].target.human)[0] !== channel) throw new Error("Wrong session uploaded");
      calls++; return Response.json({answers:Object.fromEntries(
      ${JSON.stringify(emotions)}.map(e => [e,{type:"noul",noul:0.7}]))}); };
    const program = new Command(), output = [], hooks = {};
    console.log = text => output.push(JSON.parse(text));
    registerInsideOut({config:{},registerCli:fn=>fn({program,config:{}}),on:(name,fn)=>hooks[name]=fn,
      logger:{warn:text=>{throw new Error(text)}}}, resolveConfig({insideOut:{enabled:true},decisionModel:{apiKey:"fake"}}));
    await program.parseAsync(["node","openclaw","memory-emotions","run","--session","archived"]);
    await program.parseAsync(["node","openclaw","memory-emotions","report","--session","archived","--sender","bek"]);
    await program.parseAsync(["node","openclaw","memory-emotions","export","--session","archived","--emotion","joy","--min","0.5"]);
    channel = "discord";
    await program.parseAsync(["node","openclaw","memory-emotions","run","--session","live"]);
    await program.parseAsync(["node","openclaw","memory-emotions","baseline-refresh"]);
    await program.parseAsync(["node","openclaw","memory-emotions","baselines","--person",person]);
    await program.parseAsync(["node","openclaw","memory-emotions","export","--person",person,"--deviation-history"]);
    hooks.gateway_start();
    await new Promise(setImmediate);
    await hooks.gateway_stop();
    // A first large historical refresh must leave the Gateway event loop free,
    // and stop must cancel it without leaving the shared store locked.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(join(state, "agents/main/unblock-memory/unblock-memory.sqlite"))});
    const seed = db.prepare("SELECT * FROM inside_out WHERE person_id=? LIMIT 1").get(person);
    const insert = db.prepare("INSERT INTO inside_out (" + Object.keys(seed).join(",") + ") VALUES (" + Object.keys(seed).map(()=>"?").join(",") + ")");
    db.exec("BEGIN");
    for (let i=0;i<2000;i++) {
      const row = {...seed,interaction_id:"bulk-"+i,message_id:"bulk-"+i,
        target_at:${time} - 52*7*86400_000 + Math.floor(i/40)*7*86400_000};
      for (const emotion of ${JSON.stringify(emotions)}) row[emotion]=((i*997)%2000+1)/2001;
      insert.run(...Object.values(row));
    }
    db.exec("COMMIT");
    // Manual inference and disabled decision model still publish local statistics on
    // startup. Advancing one UTC week must produce a new empty-week snapshot.
    Date.now = () => ${time + 21 * 86400_000};
    registerInsideOut({config:{},registerCli:()=>{},on:(name,fn)=>hooks[name]=fn,
      logger:{warn:text=>{throw new Error(text)}}}, resolveConfig({insideOut:{enabled:true,intervalMinutes:0},decisionModel:{enabled:false}}));
    hooks.gateway_start();
    await new Promise(setImmediate);
    if (db.prepare("SELECT count(*) n FROM inside_out_deviations WHERE interaction_id LIKE 'bulk-%'").get().n !== 0)
      throw new Error("Gateway startup synchronously completed historical comparisons before yielding");
    await hooks.gateway_stop();
    db.exec("PRAGMA busy_timeout=0; CREATE TABLE stop_probe(x); DROP TABLE stop_probe;");
    await program.parseAsync(["node","openclaw","memory-emotions","baseline-refresh"]);
    if (db.prepare("SELECT count(*) n FROM inside_out_deviations WHERE interaction_id LIKE 'bulk-%'").get().n !== 2000)
      throw new Error("The next refresh did not complete the cancelled historical pass");
    const sample = JSON.parse(db.prepare("SELECT result_json FROM inside_out_deviations WHERE interaction_id='bulk-1000'").get().result_json);
    const score = db.prepare("SELECT joy FROM inside_out WHERE interaction_id='bulk-1000'").get().joy;
    // Percentiles rank within 0.01-wide bins: same-bin grades are ties.
    const bin = value => Math.round(value*100);
    const population = db.prepare("SELECT joy FROM inside_out WHERE person_id=? AND target_at<?").all(person,sample.baselineEnd).map(r => bin(r.joy));
    const expectedRank = (population.filter(b => b<bin(score)).length+population.filter(b => b===bin(score)).length/2)/population.length;
    if (sample.cumulative.count !== population.length || Math.abs(sample.cumulative.emotions.joy.percentile-expectedRank)>1e-12)
      throw new Error("Large-history percentile did not match the preceding binned population");
    db.close();
    await program.parseAsync(["node","openclaw","memory-emotions","baselines","--person",person,"--limit","1"]);
    process.stdout.write(JSON.stringify({output,calls}));
  `);
  const cli = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), cliPath], childOptions);
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.output[0].reviewed, 4);
  assert.equal(cliResult.output[1].length, 1);
  assert.equal(cliResult.output[2].length, 4);
  assert.equal(cliResult.output[3].reviewed, 4);
  assert.deepEqual(cliResult.output[4], { snapshots: 0, comparisons: 0 });
  assert.ok(cliResult.output[5].some((s: { cumulative: { joy: { count: number } } }) => s.cumulative.joy.count === 3));
  assert.equal(cliResult.output[6].length, 3, "the person filter follows exact PeopleSQL links");
  assert.ok(cliResult.output[6].every((r: { personal_deviation: { history: unknown[] } }) => r.personal_deviation.history.length === 1));
  assert.ok(cliResult.output[7].comparisons >= 1, "the refresh after a cancelled stop completes the remaining work");
  assert.equal(cliResult.output[8][0].week_end - cliResult.output[5][0].week_end, 7 * 86400_000,
    "manual-only startup publishes the next completed week without inference");
  assert.equal(cliResult.output[8][0].weekly.joy.count, 0);
  assert.equal(cliResult.calls, 8, "reports and the cached background pass do not repeat inference");
  const evolved = new DatabaseSync(options.databasePath);
  try {
    // Force a reread; unchanged metadata alone would not prove decoding works.
    evolved.exec("UPDATE transcript_rewrite_watermarks SET generation='compressed-fixture'");
    const reread = await runInsideOut({ ...options, config: cfg() });
    assert.deepEqual("errors" in reread && reread.errors, []);
    assert.deepEqual(reportInsideOut(options.storePath), rows);
    assert.equal(requests.length, 8, "compressed events retain their identities and cached judgments");
    const { seq } = evolved.prepare("SELECT max(seq) seq FROM transcript_events WHERE session_id='live'").get()!;
    await promisify(execFile)(process.execPath, [scriptPath, "append"], childOptions);
    assert.equal(evolved.prepare("SELECT count(*) n FROM transcript_events WHERE session_id='live' AND seq>? AND event_zstd IS NOT NULL")
      .get(seq!)!.n, 2);
    const fresh = await runInsideOut({ ...options, config: cfg() });
    assert.deepEqual("errors" in fresh && fresh.errors, []);
    assert.equal("reviewed" in fresh && fresh.reviewed, 1);
    assert.equal(requests.length, 9);
    assert.equal(requests.at(-1)!.state[0].target.text, "That makes me happy!");
    assert.ok(requests.at(-1)!.state[0].history.some(m => m.text === "New compressed answer."));
    const compressedRows = reportInsideOut(options.storePath);
    assert.equal(compressedRows.length, 9);
    assert.ok(compressedRows.some(row => row.message_id === "compressed-1" && row.joy === 0.85));
    // The marker intentionally names an unavailable archive.
    evolved.prepare(`INSERT INTO session_transcript_cold_archives
      (session_id,generation,archive_name,archive_sha256,event_count,raw_bytes,archive_bytes,last_seq,archived_at,storage)
      VALUES ('live','fixture','missing.jsonl.zst',?,1,0,0,?,?,'file')`).run("0".repeat(64), Number(seq) + 2, time);
    const cold = await runInsideOut({ ...options, config: cfg(), sessionId: "live" });
    assert.ok("errors" in cold && cold.errors.length);
    assert.deepEqual(reportInsideOut(options.storePath), compressedRows);
  } finally { evolved.close(); }
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
    const { state: [state] } = JSON.parse(String(init.body)); requests.push(state);
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
    const { state: [state] } = JSON.parse(String(init.body));
    assert.ok(!JSON.stringify(state).includes("INTERNAL_"), "tool payloads, system text and hidden reasoning never reach the decision model");
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
    const target = JSON.parse(String(init.body)).state[0].target.text;
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
    answers: JSON.parse(String(init.body)).state[0].target.text === "Old failed reply" ? {}
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

test("Inside Out validates payload.model without aborting and stores the requested alias for baseline continuity", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-model-")), sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  await writeFile(join(sessionsDir, "s.jsonl"), [
    { type: "session", id: "s" },
    event("a1", assistant("Answer")), event("u1", user("Snapshot reply")),
    event("a2", assistant("Answer 2")), event("u2", user("Bad model reply")),
  ].map(e => JSON.stringify(e)).join("\n"));
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const target = JSON.parse(String(init.body)).state[0].target.text;
    return Response.json({
      model: target === "Bad model reply" ? { unexpected: true } : "liquid/d1.2-ultra-20261116",
      answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: 0.4 }])),
    });
  });
  const storePath = join(root, "unblock-memory.sqlite");
  const result = await runInsideOut({ agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir, storePath, config: cfg() });
  assert.equal("reviewed" in result && result.reviewed, 1);
  assert.equal("failed" in result && result.failed, 1);
  const rows = reportInsideOut(storePath);
  const good = rows.find(r => r.message_id === "u1");
  const bad = rows.find(r => r.message_id === "u2");
  assert.equal(good?.model, "liquid/d1.2-ultra");
  assert.equal(good?.error, null);
  assert.match(String(bad?.error), /unexpected model/);

  // Switching to a different endpoint under the same model alias must not reuse checkpoints or pool rubrics.
  const alt = await runInsideOut({
    agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir, storePath,
    config: resolveConfig({
      decisionModel: { endpoint: "https://alt.example/v1/decisions", model: "liquid/d1.2-ultra", apiKey: "alt-key", timeoutMs: 1000 },
      insideOut: { enabled: true, intervalMinutes: 0, maxInteractions: 100 },
    }),
  });
  assert.equal("reviewed" in alt && alt.reviewed, 1);
  assert.equal("failed" in alt && alt.failed, 1);
  const allRows = reportInsideOut(storePath);
  const u1Rows = allRows.filter(r => r.message_id === "u1");
  assert.equal(u1Rows.length, 2);
  assert.notEqual(u1Rows[0]?.rubric, u1Rows[1]?.rubric);
  assert.ok(u1Rows.every(r => r.model === "liquid/d1.2-ultra"));
});

test("purging a person during in-flight retry grading cannot resurrect grades or dispatch remaining purged retries", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-purge-race-")), sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  const storePath = join(root, "unblock-memory.sqlite");
  const people = new PeopleStore(storePath, { maxOpenTodos: 100, maxBlurbChars: 1000 });
  t.after(() => people.close());
  const person = people.upsertIdentity({ provider: "slack", accountScope: "default", externalId: "U111", displayName: "Bek" }).person.id;
  const reply = (text: string) => ({
    ...user(text, "U111"),
    __openclaw: { senderId: "U111", senderIdentity: { senderKind: "human", id: "U111", pluginId: "slack", accountId: "default" } },
  });
  await writeFile(join(sessionsDir, "s.jsonl"), [
    { type: "session", id: "s" },
    event("a1", assistant("Answer 1")),
    event("r1", reply("First failed reply")),
    event("a2", assistant("Answer 2")),
    event("r2", reply("Second failed reply")),
  ].map(e => JSON.stringify(e)).join("\n"));

  const options = { agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir, storePath, config: cfg() };
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ answers: {} }));
  const failed = await runInsideOut(options);
  assert.equal("failed" in failed && failed.failed, 2);
  assert.equal(fetchMock.mock.callCount(), 2);

  let retryFetches = 0;
  fetchMock.mock.mockImplementation(async () => {
    retryFetches++;
    // Operator purges this person while retry #1 is in flight.
    if (retryFetches === 1) {
      const purged = purgeInsideOutPerson(storePath, person, { grades: true });
      assert.equal(purged.grades, 2);
    }
    return Response.json({
      model: "liquid/d1.2-ultra-20261116",
      answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul: 0.9 }])),
    });
  });

  const retried = await runInsideOut({ ...options, retry: true });
  assert.equal(retryFetches, 1, "rechecking retry eligibility skips remaining purged rows before calling the decision model");
  assert.equal("reviewed" in retried && retried.reviewed, 0, "fenced tombstone write does not report a revived grade");
  assert.equal("failed" in retried && retried.failed, 0);

  const rows = reportInsideOut(storePath);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.error === "Purged by operator" && row.person_id === null && emotions.every(e => row[e] === null)),
    "in-flight retry result cannot overwrite purge tombstones");
  assert.deepEqual(reportInsideOutBaselines(storePath, { personId: person }), []);

  await runInsideOut({ ...options, retry: true });
  assert.equal(retryFetches, 1, "subsequent retries still never dispatch purged rows");
});

test("repeated gateway_start clears prior timers and guards tick/refresh after gateway_stop", async t => {
  const active = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  let cleared = 0;
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  t.after(() => {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  });
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    active.set(id, { fn, ms: Number(ms ?? 0) });
    return { id, unref() { return this; } } as unknown as NodeJS.Timeout;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((handle?: NodeJS.Timeout) => {
    const id = (handle as unknown as { id?: number } | undefined)?.id;
    if (id !== undefined && active.delete(id)) cleared++;
  }) as typeof globalThis.clearInterval;

  const hooks: Record<string, () => void | Promise<void>> = {};
  const warnings: string[] = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Should not call fetch after gateway_stop");
  });
  const api = {
    config: { agents: { list: [] } },
    registrationMode: "full",
    registerCli: () => {},
    on: (name: string, fn: () => void | Promise<void>) => { hooks[name] = fn; },
    logger: { warn: (msg: string) => warnings.push(msg) },
  } as unknown as OpenClawPluginApi;

  registerInsideOut(api, resolveConfig({
    insideOut: { enabled: true, intervalMinutes: 5 },
    decisionModel: { enabled: true, apiKey: "fake" },
  }));

  hooks.gateway_start!();
  assert.equal(active.size, 2, "initial gateway_start arms baseline and review timers");
  assert.equal(cleared, 0);

  hooks.gateway_start!();
  assert.equal(active.size, 2, "second gateway_start replaces prior timers instead of orphaning them");
  assert.equal(cleared, 2);

  hooks.gateway_start!();
  assert.equal(active.size, 2, "third gateway_start still leaves only two active timers");
  assert.equal(cleared, 4);

  const callbacks = [...active.values()].map(entry => entry.fn);
  await hooks.gateway_stop!();
  assert.equal(active.size, 0, "gateway_stop clears all active timers");
  assert.equal(cleared, 6);

  // Invoking stale timer callbacks after abort must be a no-op.
  for (const callback of callbacks) callback();
  await new Promise(setImmediate);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(warnings, []);

  // Restarting after gateway_stop arms a fresh lifecycle cleanly.
  hooks.gateway_start!();
  assert.equal(active.size, 2);
  await hooks.gateway_stop!();
  assert.equal(active.size, 0);
});

const workRow = (storePath: string) => {
  if (!existsSync(storePath)) return undefined;
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='work_items'").get()) return undefined;
    return db.prepare("SELECT * FROM work_items WHERE kind=? AND scope=?").get(INSIDE_OUT_WORK_KIND, INSIDE_OUT_WORK_SCOPE);
  } finally { db.close(); }
};
async function eventually(predicate: () => unknown, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const graded = (noul: number) => Response.json({ answers: Object.fromEntries(emotions.map(e => [e, { type: "noul", noul }])) });
async function oneReplySessions(sessionsDir: string) {
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, "s.jsonl"), [
    { type: "session", id: "s" }, event("a1", assistant("Answer")), event("r1", user("Thanks, that helps")),
  ].map(e => JSON.stringify(e)).join("\n"));
}

test("hot replacement: two passes on one store contend through the fenced lease, so only one grades", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-lease-")), sessionsDir = join(root, "sessions");
  await oneReplySessions(sessionsDir);
  const options = { agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir,
    storePath: join(root, "unblock-memory.sqlite"), config: cfg() };
  let release!: (response: Response) => void, started!: () => void;
  const inflight = new Promise<Response>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const fetchMock = t.mock.method(globalThis, "fetch", () => { started(); return inflight; });

  const old = runInsideOut({ ...options, owner: "gateway-old" });
  await ready;
  assert.equal(workRow(options.storePath)?.status, "running");
  // A second instance (hot-replaced plugin, second gateway) sharing the DB sees the live lease, not a process-local Set.
  assert.deepEqual(await runInsideOut({ ...options, owner: "gateway-new" }), { status: "skipped", reason: "already_running" });
  await assert.rejects(runInsideOut({ ...options, owner: "cli", manual: true }), /already running/,
    "an explicit CLI pass rejects cleanly while another process holds the lease");
  release(graded(0.7));
  const result = await old;
  assert.equal("reviewed" in result && result.reviewed, 1);
  assert.equal(fetchMock.mock.callCount(), 1, "at most one active pass graded");
  const row = workRow(options.storePath)!;
  assert.equal(row.status, "pending"); assert.equal(row.attempt, 1); assert.equal(row.owner, null); assert.equal(row.strikes, 0);
  assert.equal(reportInsideOut(options.storePath).length, 1);
});

test("a pass that lost its lease cannot publish a late errored grade over the reclaimer's successful grade", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-fence-")), sessionsDir = join(root, "sessions");
  await oneReplySessions(sessionsDir);
  const options = { agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir,
    storePath: join(root, "unblock-memory.sqlite"), config: cfg() };
  let release!: (response: Response) => void, started!: () => void;
  const inflight = new Promise<Response>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    if (++calls === 1) { started(); return inflight; }
    return Promise.resolve(graded(0.8));
  });
  // The old pass stalls mid-inference without renewing (event-loop stall, suspended VM) until its lease expires.
  const old = runInsideOut({ ...options, owner: "stalled", leaseMs: 40, heartbeatMs: 60_000 });
  await ready;
  await new Promise(resolve => setTimeout(resolve, 80));
  const fresh = await runInsideOut({ ...options, owner: "replacement", manual: true });
  assert.equal("reviewed" in fresh && fresh.reviewed, 1);
  assert.equal(workRow(options.storePath)?.attempt, 2);
  release(Response.json({ answers: {} })); // late errored result from the stalled pass
  await assert.rejects(old, (error: Error) => error instanceof WorkFenceLostError);
  const rows = reportInsideOut(options.storePath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.error, null); assert.equal(rows[0]?.joy, 0.8);
  const row = workRow(options.storePath)!;
  assert.equal(row.status, "pending"); assert.equal(row.strikes, 0, "the reclaimer's commit clears the expiry strike");
});

test("an errored write never overwrites a successful grade even without a lease (e.g. a 0.16 writer)", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-overwrite-")), sessionsDir = join(root, "sessions");
  await oneReplySessions(sessionsDir);
  const options = { agentId: "main", databasePath: join(root, "absent.sqlite"), sessionsDir,
    storePath: join(root, "unblock-memory.sqlite"), config: cfg() };
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ answers: {} }));
  const failed = await runInsideOut(options);
  assert.equal("failed" in failed && failed.failed, 1);
  fetchMock.mock.mockImplementation(async () => {
    // An unfenced concurrent writer lands a successful grade while this retry is mid-inference.
    const other = new DatabaseSync(options.storePath);
    try {
      other.prepare(`UPDATE inside_out SET error=NULL,${emotions.map(e => `${e}=0.6`).join(",")}`).run();
    } finally { other.close(); }
    return Response.json({ answers: {} });
  });
  const retried = await runInsideOut({ ...options, retry: true, manual: true });
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal("failed" in retried && retried.failed, 0, "the errored write was rejected");
  const [row] = reportInsideOut(options.storePath);
  assert.equal(row?.error, null); assert.equal(row?.joy, 0.6);
});

function gatewayHarness(root: string) {
  const agentDir = join(root, "agents/main/agent");
  const hostConfig = { agents: { entries: { main: { agentDir, workspace: root } } } };
  const storePath = join(root, "agents/main/unblock-memory/unblock-memory.sqlite");
  const instance = () => {
    const hooks: Record<string, () => void | Promise<void>> = {};
    const warnings: string[] = [];
    const api = {
      config: hostConfig, registrationMode: "full", registerCli: () => {},
      on: (name: string, fn: () => void | Promise<void>) => { hooks[name] = fn; },
      logger: { warn: (msg: string) => warnings.push(msg) },
    } as unknown as OpenClawPluginApi;
    registerInsideOut(api, resolveConfig({ insideOut: { enabled: true, intervalMinutes: 5 },
      decisionModel: { enabled: true, apiKey: "fake", timeoutMs: 10_000 } }));
    return { start: () => hooks.gateway_start!(), stop: () => hooks.gateway_stop!(), warnings };
  };
  return { agentDir, storePath, sessionsDir: join(root, "agents/main/sessions"), instance };
}

test("scheduled gateway passes respect due_at: restarts and replacements inside the interval do not re-run", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-gateway-due-"));
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previous; });
  const harness = gatewayHarness(root);
  await oneReplySessions(harness.sessionsDir);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => graded(0.5));

  const first = harness.instance();
  first.start();
  await eventually(() => workRow(harness.storePath)?.status === "pending" && Number(workRow(harness.storePath)?.due_at) > Date.now());
  await first.stop();
  assert.equal(fetchMock.mock.callCount(), 1);
  const due = Number(workRow(harness.storePath)?.due_at);
  assert.ok(due > Date.now() + 4 * 60_000, "re-armed one interval out");

  // Append a reply so a re-run would be observable as another inference.
  await writeFile(join(harness.sessionsDir, "s.jsonl"), [
    { type: "session", id: "s" }, event("a1", assistant("Answer")), event("r1", user("Thanks, that helps")),
    event("a2", assistant("More")), event("r2", user("Great")),
  ].map(e => JSON.stringify(e)).join("\n"));
  first.start(); // same instance restarted
  const replacement = harness.instance(); // hot-replaced plugin instance on the same store
  replacement.start();
  await first.stop(); await replacement.stop();
  assert.equal(fetchMock.mock.callCount(), 1, "no pass re-ran inside intervalMinutes");
  assert.equal(Number(workRow(harness.storePath)?.due_at), due);
  assert.equal(workRow(harness.storePath)?.attempt, 1);
  assert.deepEqual([...first.warnings, ...replacement.warnings], []);
});

test("gateway_stop releases the lease synchronously: graceful stops add no strikes and the next start resumes", async t => {
  const root = await mkdtemp(join(tmpdir(), "inside-out-gateway-stop-"));
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previous; });
  const harness = gatewayHarness(root);
  await oneReplySessions(harness.sessionsDir);
  let started = 0;
  t.mock.method(globalThis, "fetch", (_url: unknown, init: RequestInit) => {
    started++;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  });
  const gateway = harness.instance();
  for (let i = 1; i <= 3; i++) {
    gateway.start();
    await eventually(() => started === i);
    assert.equal(workRow(harness.storePath)?.status, "running");
    await gateway.stop();
    const row = workRow(harness.storePath)!;
    assert.equal(row.status, "pending", `stop ${i} released the lease`);
    assert.equal(row.owner, null); assert.equal(row.lease_until, 0);
    assert.equal(row.strikes, 0, `graceful stop ${i} adds no strikes`);
    assert.equal(row.attempt, i);
    assert.equal(row.due_at, 0, "an interrupted pass stays due so the next start resumes it");
  }
  assert.deepEqual(reportInsideOut(harness.storePath), [], "aborted inference never writes a grade");
  assert.deepEqual(gateway.warnings, []);
});

test("interruptInsideOut is a synchronous no-op for owners without an active pass", () => {
  assert.equal(interruptInsideOut("nobody"), 0);
});
