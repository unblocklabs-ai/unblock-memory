import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerResponseAudit } from "../src/response-runtime.js";
import { resolveConfig } from "../src/config.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";
import { ResponseAuditStore } from "../src/response-store.js";
import { DatabaseSync } from "node:sqlite";

test("response audit registers operator CLI even in metadata mode but schedules only with full opt-in", () => {
  for (const mode of ["cli-metadata", undefined] as const) {
    for (const enabled of [false, true]) {
      const hooks: string[] = [];
      let cli = 0;
      const api = { registrationMode: mode, registerCli() { cli++; }, on(name: string) { hooks.push(name); } } as unknown as OpenClawPluginApi;
      registerResponseAudit(api, resolveConfig({ responseAudit: { enabled, senderIds: ["owner"] } }));
      assert.equal(cli, 1);
      assert.deepEqual(hooks, mode !== "cli-metadata" && enabled ? ["gateway_start", "gateway_stop"] : []);
    }
  }
});

test("TypeSafe opt-out and zero interval prevent response scheduling", () => {
  for (const overrides of [{ typesafe: { enabled: false } }, { responseAudit: { enabled: true, senderIds: ["owner"], intervalMinutes: 0 } }]) {
    const api = { registerCli() {}, on() { assert.fail("must not schedule"); } } as unknown as OpenClawPluginApi;
    registerResponseAudit(api, resolveConfig({ responseAudit: { enabled: true, senderIds: ["owner"] }, ...overrides }));
  }
});

test("scheduler waits for its interval, prevents overlap, and cancels in-flight inference on stop", { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "response-runtime-"));
  const agentDir = join(root, "agents/main/agent"); await mkdir(agentDir, { recursive: true });
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previous; });
  const db = createAgentDatabase(join(agentDir, "openclaw-agent.sqlite")); t.after(() => db.close());
  insertSession(db, { sessionId: "s", chatType: "direct" });
  for (const [i, text] of ["Question", "Answer", "Thanks", "Welcome"].entries()) {
    const user = i % 2 === 0;
    const message = { role: user ? "user" : "assistant", content: text, stopReason: "stop",
      ...(user ? { __openclaw: { senderId: "owner", senderIdentity: { senderKind: "human" },
        transport: { channel: "slack", conversationRef: "conversation-s" } } } : {}) };
    db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("s", i, JSON.stringify({ type: "message", message }), Date.now());
    db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run("s", i, i, i);
  }
  const hooks = new Map<string, () => void | Promise<void>>();
  const api = { config: { agents: { list: [{ id: "main", agentDir, workspace: root }] } }, registerCli() {},
    on(name: string, fn: () => void | Promise<void>) { hooks.set(name, fn); }, logger: { warn() {} } } as unknown as OpenClawPluginApi;
  let started!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, "fetch", () => { calls++; started(); return new Promise<Response>(() => {}); });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  registerResponseAudit(api, resolveConfig({ typesafe: { apiKey: "fake" },
    responseAudit: { enabled: true, senderIds: ["owner"], intervalMinutes: 1 } }));
  await hooks.get("gateway_start")!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  t.mock.timers.tick(60_000); await ready;
  t.mock.timers.tick(60_000); await Promise.resolve();
  assert.equal(calls, 1);
  await hooks.get("gateway_stop")!();
  t.mock.timers.tick(600_000); await Promise.resolve();
  assert.equal(calls, 1);
});

test("durable schedule survives reopen, claims once, catches up once and applies cadence changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "response-schedule-"));
  const path = join(root, "audit.sqlite");
  let store = new ResponseAuditStore(path);
  assert.equal(store.claimScheduled(1000, 720_000), false);
  store.close();
  store = new ResponseAuditStore(path);
  try {
    assert.equal(store.claimScheduled(720_999, 720_000), false);
    assert.equal(store.claimScheduled(721_000, 720_000), true);
    const other = new ResponseAuditStore(path);
    try { assert.equal(other.claimScheduled(721_000, 720_000), false); }
    finally { other.close(); }
    assert.equal(store.claimScheduled(10_000_000, 720_000), true);
    assert.equal(store.claimScheduled(10_000_000, 720_000), false);
    // Shortening uses the last attempt, not now + the new interval.
    assert.equal(store.claimScheduled(10_060_000, 60_000), true);
    assert.equal(store.claimScheduled(10_120_000, 720_000), false);
    assert.equal(store.claimScheduled(10_780_000, 720_000), true);
  } finally { store.close(); }
});

test("Gateway restart catches up safely without credentials; absent, empty and unreadable keys never fetch", { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "response-no-key-"));
  const previous = process.env.OPENCLAW_STATE_DIR, previousKey = process.env.TYPESAFE_API_KEY;
  process.env.OPENCLAW_STATE_DIR = root;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previous;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey;
  });
  const empty = join(root, "empty.env"); await writeFile(empty, "# no credentials\n");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected inference"); });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  const interval = 12 * 60 * 60_000;
  for (const [index, apiKeyFile] of [undefined, join(root, "missing.env"), empty, root].entries()) {
    const id = `agent${index}`;
    const path = join(root, "agents", id, "unblock-memory/unblock-memory.sqlite");
    const hooks = new Map<string, () => void | Promise<void>>();
    let warnings = 0;
    let warned!: () => void;
    const warning = new Promise<void>(resolve => { warned = resolve; });
    const api = { config: { agents: { list: [{ id, workspace: root }] } }, registerCli() {},
      on(name: string, fn: () => void | Promise<void>) { hooks.set(name, fn); },
      logger: { warn() { warnings++; warned(); } } } as unknown as OpenClawPluginApi;
    registerResponseAudit(api, resolveConfig({ typesafe: { apiKeyFile },
      responseAudit: { enabled: true, senderIds: ["owner"], intervalMinutes: 720 } }));
    await hooks.get("gateway_start")!();
    await hooks.get("gateway_stop")!();
    const db = new DatabaseSync(path);
    try {
      const due = Number(db.prepare("SELECT next_due FROM response_schedule").get()!.next_due);
      t.mock.timers.tick(interval - 60_000);
      await hooks.get("gateway_start")!();
      await hooks.get("gateway_stop")!();
      assert.equal(Number(db.prepare("SELECT next_due FROM response_schedule").get()!.next_due), due);
      assert.equal(warnings, 0);
      // A long downtime still yields only one attempt; no source DB is needed without a key.
      t.mock.timers.tick(interval * 3);
      await hooks.get("gateway_start")!();
      await warning;
      assert.equal(warnings, 1);
      assert.equal(Number(db.prepare("SELECT next_due FROM response_schedule").get()!.next_due), Date.now() + interval);
      assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM response_results").get()!.n), 0);
      assert.equal(calls, 0);
      await hooks.get("gateway_stop")!();
      await hooks.get("gateway_start")!();
      await hooks.get("gateway_stop")!();
      assert.equal(warnings, 1);
    } finally { db.close(); await hooks.get("gateway_stop")!(); }
  }
});

test("an unwritable audit store cannot fail Gateway start/stop or starve other agents", async t => {
  const root = await mkdtemp(join(tmpdir(), "response-schedule-error-"));
  await mkdir(join(root, "agents/broken"), { recursive: true });
  await writeFile(join(root, "agents/broken/unblock-memory"), "not a directory");
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previous; });
  const hooks = new Map<string, () => void | Promise<void>>();
  let warnings = 0;
  const api = { config: { agents: { list: [{ id: "broken" }, { id: "healthy" }] } }, registerCli() {},
    on(name: string, fn: () => void | Promise<void>) { hooks.set(name, fn); },
    logger: { warn() { warnings++; } } } as unknown as OpenClawPluginApi;
  registerResponseAudit(api, resolveConfig({ responseAudit: { enabled: true, senderIds: ["owner"] } }));
  await hooks.get("gateway_start")!();
  await hooks.get("gateway_stop")!();
  assert.equal(warnings, 1);
  const db = new DatabaseSync(join(root, "agents/healthy/unblock-memory/unblock-memory.sqlite"));
  try { assert.equal(db.prepare("SELECT COUNT(*) n FROM response_schedule").get()!.n, 1); }
  finally { db.close(); }
});
