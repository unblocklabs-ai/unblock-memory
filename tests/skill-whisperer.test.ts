import assert from "node:assert/strict";
import { mkdir, mkdtempDisposable, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig, type UnblockMemoryConfig } from "../src/config.js";
import { DEFAULTS } from "../src/defaults.js";
import { WhispererDiagnostics } from "../src/diagnostics.js";
import { QmdMemoryRuntime } from "../src/runtime.js";
import { openRecallLedger, RecallLedgerWriter } from "../src/recall-ledger.js";
import { openMemoryDatabase } from "../src/memory-database.js";
import { SkillSessionStore } from "../src/skill-session-store.js";
import { registerSkillWhisperer } from "../src/skill-whisperer.js";
import { registerWhispererPrompt } from "../src/whisperer-prompt.js";

type Runtime = Parameters<typeof registerSkillWhisperer>[1];
type DecisionModel = UnblockMemoryConfig["decisionModel"];
type Context = { trigger: string; agentId: string; sessionId: string; sessionKey?: string; runId: string };
type Prompt = (event: { prompt: string; messages: unknown[] }, context: Context) => Promise<{ appendContext: string } | undefined>;
type Read = (event: { toolName: string; params: Record<string, unknown>; error?: string; result?: unknown },
  context: Omit<Context, "trigger"> & { trigger?: string }) => Promise<void>;
type End = (event: { sessionId: string; sessionKey?: string; reason?: string; nextSessionId?: string }, context: Context) => void;

const enabled = { enabled: true, historyMessages: 2, minScore: 0.6, cooldownTurns: 2 };
const active = resolveConfig({ decisionModel: { apiKey: "fake-secret", timeoutMs: 1000 } }).decisionModel;
const local = resolveConfig({ decisionModel: { enabled: false } }).decisionModel;
const ctx = (runId: string, sessionId = "thread", agentId = "main"): Context =>
  ({ trigger: "user", agentId, sessionId, runId });
const prompt = (text = "Deploy this release") => ({ prompt: text, messages: [] as unknown[] });
const hit = (name: string, score = 0.9, description = `Use ${name} for its workflow.`) =>
  ({ name, description, path: `/skills/${name}/SKILL.md`, score });
const read = (path: string) => ({ toolName: "read", params: { file_path: path } });

function harness(runtime: Runtime, decision = active, cfg: OpenClawPluginApi["config"] = {}, config = enabled,
  triggers = resolveConfig({}).whispererTriggers, ledger?: Parameters<typeof registerSkillWhisperer>[5]) {
  const hooks = new Map<string, (...args: never[]) => unknown>();
  const warnings: string[] = [];
  const diagnostics = new WhispererDiagnostics();
  const api = {
    config: cfg,
    logger: { warn(message: string) { warnings.push(message); } },
    on(name: string, handler: (...args: never[]) => unknown) { hooks.set(name, handler); },
  } as unknown as OpenClawPluginApi;
  const skill = registerSkillWhisperer(api, runtime, config, decision, diagnostics, ledger);
  registerWhispererPrompt(api, { skill }, triggers);
  return { hooks, warnings, diagnostics, before: skill as Prompt,
    after: hooks.get("after_tool_call") as Read, end: hooks.get("session_end") as End,
    stop: hooks.get("gateway_stop") as () => void, prompt: hooks.get("before_prompt_build") as Prompt };
}

test("cron and heartbeat skills are run-local, while opted-in subagents persist skills", async t => {
  const { whispererTriggers } = resolveConfig({ whispererTriggers: { cron: ["skill"], heartbeat: ["skill"], subagent: ["skill"] } });
  const directory = await mkdtempDisposable(join(tmpdir(), "unblock-skill-triggers-"));
  const dbPath = join(directory.path, "unblock-memory.sqlite");
  const entries = [hit("deploy")];
  let matches = entries;
  const h = harness({ ...catalogRuntime(entries, async () => matches), memoryDatabasePath: () => dbPath },
    local, {}, enabled, whispererTriggers);
  const store = new SkillSessionStore(dbPath);
  t.after(async () => { h.stop(); store.close(); await directory.remove(); });

  for (const trigger of ["cron", "heartbeat"]) {
    matches = entries;
    const first = { ...ctx(`${trigger}-first`, trigger), trigger };
    const result = await h.prompt(prompt(), first);
    assert.match(result?.appendContext ?? "", /<skills>[\s\S]+<skill name="deploy"/);
    assert.deepEqual(await h.prompt(prompt("rebuild"), first), result);
    assert.deepEqual(store.list(trigger), []);
    // The tool hook can omit trigger metadata. It must not pin into the persistent session.
    await h.after(read(entries[0].path), { ...first, trigger: undefined });
    assert.deepEqual(store.list(trigger), []);
    matches = [];
    assert.equal(await h.prompt(prompt("unrelated"), { ...first, runId: `${trigger}-next` }), undefined);
    matches = entries;
    const last = { ...first, runId: `${trigger}-last` };
    assert.deepEqual(await h.prompt(prompt(), last), result);
    h.end({ sessionId: trigger, reason: "compaction", nextSessionId: `${trigger}-successor` }, last);
    assert.deepEqual(store.list(`${trigger}-successor`), []);
  }
  matches = entries;
  const child = { ...ctx("child", "child-session"), sessionKey: "agent:main:subagent:child" };
  assert.match((await h.prompt(prompt(), child))?.appendContext ?? "", /<skills>[\s\S]+<skill name="deploy"/);
  assert.deepEqual(store.list(child.sessionId).map(row => row.name), ["deploy"]);
});

function catalogRuntime(entries: ReturnType<typeof hit>[], searchSkills: Runtime["searchSkills"] = async () => {
  assert.fail("The direct catalog route must not search QMD");
}): Runtime {
  return { async listSkills() { return entries; }, searchSkills,
    resolveSkillPath(_params, path) { return entries.some(entry => entry.path === path) ? path : undefined; } };
}

type DecisionState = { currentRequest: string; history: { role: string; content: string }[];
  skills: { id: string; name: string; description: string }[] };
function decisionState(init?: RequestInit): DecisionState {
  return JSON.parse(String(init?.body)).state[0];
}
function scores(state: DecisionState, score: (name: string) => number = () => 0.9, usage?: { input_tokens: number; output_tokens: number }) {
  return Response.json({ usage, answers: Object.fromEntries(state.skills.map(({ id, name }) => [id, { type: "noul", noul: score(name) }])) });
}

test("direct routing sends bounded visible history and up to 79 skills once per run, then excludes pinned skills", async t => {
  const candidates = Array.from({ length: 79 }, (_, index) => hit(`skill-${index}`));
  const h = harness(catalogRuntime(candidates));
  const requests: DecisionState[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const state = decisionState(init);
    requests.push(state);
    assert.doesNotMatch(String(init?.body), /\/skills\/|private|discarded|"score"/);
    return scores(state, name => requests.length === 1 && ["skill-0", "skill-1"].includes(name) ? 0.9 : 0.1);
  });
  const event = { ...prompt(), messages: [
    { role: "user", get content(): string { return assert.fail("discarded history was accessed"); } },
    { role: "user", content: "previous request" },
    { role: "assistant", content: [{ type: "text", text: "previous answer" }, { type: "thinking", text: "private" }] },
    { role: "toolResult", content: "private" },
    { role: "system", content: "private" },
  ] };
  assert.equal(await h.before(event, { ...ctx("internal"), trigger: "cron" }), undefined);
  const first = h.before(event, ctx("one"));
  const rebuild = h.before(prompt("different assembled prompt"), ctx("one"));
  const result = await first;
  assert.equal(await rebuild, result);
  assert.match(result?.appendContext ?? "", /<skill name="skill-0"[^\n]+\n- <skill name="skill-1"/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(requests[0].skills.length, 79);
  assert.deepEqual(requests[0].history, [
    { role: "user", content: "previous request" }, { role: "assistant", content: "previous answer" },
  ]);
  assert.equal(requests[0].currentRequest, event.prompt);
  const next = await h.prompt({ ...event, prompt: "x".repeat(13_000) }, ctx("two"));
  assert.equal(next?.appendContext, `<unblock_memory>\n${result?.appendContext}\n</unblock_memory>`);
  assert.equal(requests[1].skills.length, 77);
  assert.ok(requests[1].skills.every(({ name }) => name !== "skill-0" && name !== "skill-1"));
  assert.equal(requests[1].currentRequest.length, 12_000);
  assert.deepEqual(requests[1].history, []);
  assert.deepEqual(h.diagnostics.snapshot("main").skill, { emitted: 1, rejected: 1, active_reused: 1 });
});

test("400 skills route directly in five parallel batches with a 3-second request timeout", async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "skill-ledger-"));
  const dbPath = join(directory.path, "memory.sqlite");
  const writer = new RecallLedgerWriter();
  const candidates = Array.from({ length: 400 }, (_, index) => hit(`skill-${index}`));
  const search = t.mock.fn<Runtime["searchSkills"]>(async () => []);
  const h = harness(catalogRuntime(candidates, search), active, {}, enabled, undefined, { writer, dbPathForAgent: () => dbPath });
  const requests: DecisionState[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const timeout = t.mock.method(AbortSignal, "timeout");
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const state = decisionState(init);
    requests.push(state);
    await gate;
    return scores(state, name => name === "skill-399" ? 0.9 : 0.1,
      state.skills[0].name === "skill-0" ? undefined : { input_tokens: 13, output_tokens: 2 });
  });
  const result = h.prompt(prompt(), ctx("large-catalog"));
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(search.mock.callCount(), 0, "the direct route must not search QMD");
    assert.deepEqual(requests.map(({ skills }) => skills.length), [80, 80, 80, 80, 80]);
    assert.deepEqual(requests.flatMap(({ skills }) => skills.map(({ name }) => name)).sort(),
      candidates.map(({ name }) => name).sort());
    assert.deepEqual(timeout.mock.calls.map(({ arguments: [ms] }) => ms), [3000, 3000, 3000, 3000, 3000]);
  } finally {
    release();
    await result;
  }
  assert.match((await result)?.appendContext ?? "", /name="skill-399"/);
  await writer.close();
  const db = openRecallLedger(dbPath);
  try {
    const [route] = db.prepare("SELECT * FROM skill_routing_events").all();
    assert.equal(route.mode, "direct");
    assert.equal(route.surface, "user");
    assert.equal(route.outcome, "emitted");
    assert.ok(Number(route.elapsed_ms) >= 0);
    assert.match(String(route.catalog_revision), /^[0-9a-f]{16}$/);
    assert.equal(route.candidate_count, 400);
    assert.deepEqual(JSON.parse(String(route.scores_json)), candidates.map(({ path, name }, i) =>
      ({ path, name, score: i === 399 ? 0.9 : 0.1 })));
    assert.deepEqual(JSON.parse(String(route.emitted_json)), [candidates[399].path]);
    assert.deepEqual([route.input_tokens, route.output_tokens], [52, 8]);
  } finally { db.close(); h.stop(); }
});

test("opening a legacy whispered skill preserves its provenance; an independent read is not attributed to routing", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "skill-open-"));
  const dbPath = join(directory.path, "memory.sqlite");
  const db = openMemoryDatabase(dbPath);
  const entries = [hit("routed"), hit("discovered")];
  const now = Date.now();
  try {
    db.exec(`CREATE TABLE skill_whisper_sessions (
      session_scope TEXT NOT NULL, canonical_path TEXT NOT NULL, skill_name TEXT NOT NULL, skill_description TEXT NOT NULL,
      source TEXT NOT NULL, score REAL, added_turn INTEGER NOT NULL, added_at_ms INTEGER NOT NULL,
      last_used_at_ms INTEGER NOT NULL, PRIMARY KEY(session_scope, canonical_path))`);
    db.prepare("INSERT INTO skill_whisper_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "thread", entries[0].path, "routed", "original", "whisperer", 0.9, 1, now, now);
    const writer = new RecallLedgerWriter();
    const runtime = { ...catalogRuntime(entries, async () => []), memoryDatabasePath: () => dbPath };
    const h = harness(runtime, local, {}, enabled, undefined, { writer, dbPathForAgent: () => dbPath });
    try {
      const context = ctx("one");
      await h.prompt(prompt(), context);
      assert.equal(db.prepare("SELECT opened_at_ms FROM skill_whisper_sessions").get()?.opened_at_ms, null);
      await h.after({ toolName: "skills_read", params: { name: "routed" } }, context);
      await h.after(read(entries[1].path), context);
      await h.after(read(entries[1].path), context);
    } finally { h.stop(); await writer.close(); }
    const store = new SkillSessionStore(dbPath);
    try {
      const rows = store.list("thread");
      assert.deepEqual(rows.map(row => [row.name, row.source]), [["routed", "whisperer"], ["discovered", "read"]]);
      assert.ok(rows.every(row => row.openedAtMs !== undefined && row.openedAtMs >= now));
    } finally { store.close(); }
    const opens = db.prepare("SELECT skill_path, tool_name, was_whispered, was_pinned FROM skill_open_events ORDER BY id").all();
    assert.deepEqual(opens.map(row => [row.skill_path, row.tool_name, row.was_whispered, row.was_pinned]), [
      [entries[0].path, "skills_read", 1, 1], [entries[1].path, "read", 0, 0], [entries[1].path, "read", 0, 1],
    ]);
    const route = db.prepare("SELECT mode, input_tokens, output_tokens FROM skill_routing_events").get();
    assert.deepEqual({ ...route }, { mode: "fallback", input_tokens: null, output_tokens: null });
  } finally { db.close(); }
});

test("a routing deadline records completed batches without emitting late suggestions", async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "skill-deadline-"));
  const dbPath = join(directory.path, "memory.sqlite");
  const writer = new RecallLedgerWriter();
  const entries = Array.from({ length: DEFAULTS.skillWhisperer.catalogBatchSize + 1 }, (_, i) => hit(String(i)));
  const h = harness(catalogRuntime(entries), active, {}, enabled, undefined, { writer, dbPathForAgent: () => dbPath });
  let release!: (response: Response) => void;
  const stalled = new Promise<Response>(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const state = decisionState(init);
    return state.skills.length === 1 ? stalled : scores(state, () => 0.8, { input_tokens: 120, output_tokens: 32 });
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = h.prompt(prompt(), ctx("deadline"));
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(DEFAULTS.skillWhisperer.timeoutMs);
    assert.equal(await pending, undefined);
  } finally {
    release(new Response(null, { status: 503 }));
    t.mock.timers.reset();
    h.stop(); await writer.close();
  }
  const db = openRecallLedger(dbPath);
  try {
    const route = db.prepare("SELECT * FROM skill_routing_events").get()!;
    assert.equal(route.outcome, "timed_out");
    assert.deepEqual(JSON.parse(String(route.emitted_json)), []);
    assert.equal(JSON.parse(String(route.scores_json)).length, entries.length - 1);
    assert.deepEqual([route.input_tokens, route.output_tokens], [120, 32]);
  } finally { db.close(); }
});

test("oversized and no-key catalogs use the right QMD fallback and filter pinned, invalid and weak hits", async t => {
  const candidates = Array.from({ length: DEFAULTS.skillWhisperer.maxDirectCatalogSkills + 1 }, (_, index) => hit(`skill-${index}`));
  const searches: { query: string; minScore: number; names: string[] }[] = [];
  const runtime = catalogRuntime(candidates, async (_params, query, minScore) => {
    const matches = [hit("not-configured"), candidates[0], hit("skill-1", 0.2), candidates[2]];
    searches.push({ query, minScore, names: matches.map(({ name }) => name) });
    return matches;
  });
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const state = decisionState(init);
    assert.deepEqual(state.skills.map(({ name }) => name), ["skill-0", "skill-1", "skill-2"]);
    return scores(state, name => name === "skill-1" ? 0.95 : 0.1);
  });
  const major = harness(runtime);
  assert.match((await major.before(prompt(), ctx("one")))?.appendContext ?? "", /name="skill-1"/);
  const noKey = harness(runtime, resolveConfig({
    decisionModel: { endpoint: "https://custom.example/v1/decisions" },
  }).decisionModel);
  const first = await noKey.before(prompt(), ctx("one"));
  assert.match(first?.appendContext ?? "", /name="skill-0".*\n- <skill name="skill-2"/);
  assert.doesNotMatch(first?.appendContext ?? "", /skill-1|not-configured/);
  assert.deepEqual(await noKey.before(prompt(), ctx("two")), first);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(searches.map(({ minScore }) => minScore), [-1, enabled.minScore, enabled.minScore]);
  assert.deepEqual(searches.map(({ query }) => query), Array(3).fill("user: Deploy this release"));
  assert.equal(noKey.diagnostics.snapshot("main").skill.missing_key, 2);
});

test("active skills survive provider errors/timeouts but never supersession or session teardown", async t => {
  const entries = [hit("pinned"), hit("new")];
  const h = harness(catalogRuntime(entries));
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) =>
    scores(decisionState(init), name => name === "pinned" ? 0.9 : 0.1));
  const first = await h.before(prompt(), ctx("pin"));
  assert.match(first?.appendContext ?? "", /name="pinned"/);
  fetch.mock.mockImplementation(async () => new Response("private provider error", { status: 503 }));
  assert.deepEqual(await h.before(prompt(), ctx("fail")), first);
  assert.equal(await h.before(prompt(), ctx("fail-empty", "different-thread")), undefined);
  assert.ok(h.warnings.every(message => !message.includes("private provider error")));

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let timeoutStarted!: (signal: AbortSignal | null | undefined) => void;
  const timeoutWaiting = new Promise<AbortSignal | null | undefined>(resolve => { timeoutStarted = resolve; });
  fetch.mock.mockImplementation(async (...[_url, init]: Parameters<typeof globalThis.fetch>) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    timeoutStarted(init?.signal);
  }));
  const timedOut = h.before(prompt(), ctx("timeout"));
  const timeoutSignal = await timeoutWaiting;
  t.mock.timers.tick(2999);
  assert.equal(timeoutSignal?.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(timeoutSignal?.reason?.name, "TimeoutError");
  assert.deepEqual(await timedOut, first);
  t.mock.timers.reset();

  for (const cancellation of ["supersede", "end", "stop"] as const) {
    let release!: () => void;
    let started!: (signal: AbortSignal | null | undefined) => void;
    const waiting = new Promise<AbortSignal | null | undefined>(resolve => { started = resolve; });
    fetch.mock.mockImplementation(async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
      started(init?.signal);
      return new Promise<Response>(resolve => { release = () => resolve(scores(decisionState(init))); });
    });
    const run = ctx(cancellation);
    const pending = h.before(prompt(), run);
    const signal = await waiting;
    if (cancellation === "supersede") {
      fetch.mock.mockImplementation(async (...[_url, init]: Parameters<typeof globalThis.fetch>) => scores(decisionState(init), () => 0.1));
      assert.deepEqual(await h.before(prompt(), ctx("newer")), first);
      assert.equal(await h.before(prompt(), run), undefined);
    } else if (cancellation === "end") h.end({ sessionId: run.sessionId }, run);
    else h.stop();
    assert.equal(signal?.aborted, true);
    release();
    assert.equal(await pending, undefined);
  }
  const diagnostic = h.diagnostics.snapshot("main").skill;
  assert.equal(diagnostic.cancelled, 3);
  assert.equal(diagnostic.timed_out, 1);
  assert.equal(diagnostic.failed, 2);
  assert.equal(diagnostic.active_reused, 3);
});

test("real runtime persists routed and directly read skills across compaction and restart, then prunes and deletes", async t => {
  const directory = await mkdtempDisposable(join(tmpdir(), "unblock-skill-sessions-"));
  const root = await realpath(directory.path);
  const target = join(root, "external", "alpha", "SKILL.md");
  const alias = join(root, "skills", "alpha", "SKILL.md");
  const beta = join(root, "skills", "beta", "SKILL.md");
  const shadow = join(root, "external", "shadow", "SKILL.md");
  const shadowAlias = join(root, "skills", "shadow", "SKILL.md");
  for (const file of [target, beta, shadow]) await mkdir(dirname(file), { recursive: true });
  await writeFile(target, "---\nname: alpha\ndescription: >-\n  First line\n  second line\n---\n");
  await writeFile(beta, "---\nname: beta\ndescription: original winner\n---\n");
  await writeFile(shadow, "---\nname: beta\ndescription: direct-read frontmatter\n---\n");
  await symlink(dirname(target), dirname(alias));
  await symlink(dirname(shadow), dirname(shadowAlias));

  const cfg = { agents: { defaults: { workspace: root } } };
  const stateRoot = join(root, "state");
  const registrations: { runtime: QmdMemoryRuntime; h: ReturnType<typeof harness> }[] = [];
  t.after(async () => {
    for (const { runtime, h } of registrations) { h.stop(); await runtime.close(); }
    await directory.remove();
  });
  const register = () => {
    const runtime = new QmdMemoryRuntime([
      { name: "skills", kind: "skills", paths: [join(root, "skills", "**", "SKILL.md")] },
      { name: "notes", kind: "files", paths: [join(root, "notes")] },
    ], { stateRoot });
    const h = harness(runtime, active, cfg);
    registrations.push({ runtime, h });
    return { runtime, h };
  };
  const { runtime, h } = register();
  const dbPath = runtime.memoryDatabasePath("main");
  const rows = (scope: string) => {
    const store = new SkillSessionStore(dbPath);
    try { return store.list(scope); }
    finally { store.close(); }
  };
  const expired = new SkillSessionStore(dbPath);
  try {
    expired.upsert("abandoned", [{ canonicalPath: target, name: "alpha", description: "old", source: "read",
      addedTurn: 0, addedAtMs: 1, lastUsedAtMs: 1 }]);
  } finally { expired.close(); }
  let shouldRoute = true;
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => scores(decisionState(init), name =>
    shouldRoute && name === "alpha" ? 0.9 : 0.1));
  const before = await h.before(prompt(), ctx("one"));
  assert.match(before?.appendContext ?? "", /First line second line/);
  assert.ok(before?.appendContext?.includes(target));
  assert.deepEqual(rows("abandoned"), []);
  assert.equal(existsSync(join(dirname(dbPath), "index.sqlite")), false);
  shouldRoute = false;
  await h.after({ ...read(beta), result: { isError: true } }, ctx("one"));
  await h.after(read(shadowAlias), ctx("one"));
  const withRead = await h.before(prompt(), ctx("two"));
  assert.ok(withRead?.appendContext.startsWith(before?.appendContext.replace("</skills>", "") ?? "missing"));
  assert.match(withRead?.appendContext ?? "", /direct-read frontmatter/);
  assert.deepEqual(rows("thread").map(({ canonicalPath, source, addedTurn }) => ({ canonicalPath, source, addedTurn })), [
    { canonicalPath: target, source: "whisperer", addedTurn: 1 },
    { canonicalPath: shadow, source: "read", addedTurn: 1 },
  ]);
  h.end({ sessionId: "thread", reason: "compaction" }, ctx("two"));
  assert.equal(await h.before(prompt(), ctx("two")), undefined);
  assert.deepEqual(await h.before(prompt(), ctx("same-id-compaction")), withRead);
  h.end({ sessionId: "thread", reason: "compaction", nextSessionId: "compacted" }, ctx("same-id-compaction"));
  assert.deepEqual(rows("thread"), []);
  assert.deepEqual(await h.before(prompt(), ctx("three", "compacted")), withRead);

  h.end({ sessionId: "compacted", reason: "restart" }, ctx("three", "compacted"));
  h.stop();
  await runtime.close();
  const restart = register();
  assert.deepEqual(await restart.h.before(prompt(), ctx("fresh", "compacted")), withRead);
  restart.h.stop();
  await restart.runtime.close();
  await unlink(target);
  await writeFile(shadow, "---\nname: beta-read\ndescription: refreshed metadata\n---\n");

  const final = register();
  const pruned = await final.h.before(prompt(), ctx("prune", "compacted"));
  assert.match(pruned?.appendContext ?? "", /name="beta-read"[^\n]+refreshed metadata/);
  assert.deepEqual(rows("compacted").map(({ canonicalPath }) => canonicalPath), [shadow]);
  final.h.end({ sessionId: "compacted", reason: "reset" }, ctx("prune", "compacted"));
  await final.h.after(read(shadowAlias), ctx("prune", "compacted"));
  assert.deepEqual(rows("compacted"), []);
  assert.equal(await final.h.before(prompt(), ctx("after-end", "compacted")), undefined);
});

test("XML escapes fields, truncates descriptions, and respects both per-turn and session caps without reordering", async t => {
  t.mock.method(Date, "now", () => 10_000_000);
  const entries = [hit('zz &"<>', 0.95, `A & B < C > D ${"word ".repeat(100)}`),
    ...Array.from({ length: 16 }, (_, i) => hit(`a${i.toString().padStart(2, "0")}`, 0.9, "&".repeat(300)))];
  const searches: number[] = [];
  const runtime = catalogRuntime(entries, async (_params, _query, minScore) => {
    searches.push(minScore);
    if (searches.length === 1) return entries.slice(0, 1);
    return entries.slice((searches.length - 2) * 5 + 1, (searches.length - 1) * 5 + 1);
  });
  const h = harness(runtime, local);
  const first = (await h.before(prompt(), ctx("1")))?.appendContext ?? "";
  assert.match(first, /name="zz &amp;&quot;&lt;&gt;" path="\/skills\/zz &amp;&quot;&lt;&gt;\/SKILL.md">A &amp; B &lt; C &gt; D .+…<\/skill>/);
  const description = />(A .+)…<\/skill>/.exec(first)?.[1] ?? "";
  assert.ok(description.replace(/&(?:amp|lt|gt);/g, "x").length < DEFAULTS.skillWhisperer.maxDescriptionChars);
  const second = (await h.before(prompt(), ctx("2")))?.appendContext ?? "";
  assert.ok(second.startsWith(first.replace("</skills>", "")));
  assert.ok(second.length <= DEFAULTS.skillWhisperer.maxInjectedChars);
  assert.ok(second.endsWith("</skill>\n</skills>"));
  await h.before(prompt(), ctx("3"));
  await h.before(prompt(), ctx("4"));
  assert.deepEqual(await h.before(prompt(), ctx("5")), { appendContext: second });
  assert.equal(searches.length, 4, "A full active list does not trigger discovery");
});

test("skills_read pins skills by exact name (case-insensitive) and ignores unknown or errored calls", async t => {
  const entries = [hit("fleet-ssh", 0.9, "SSH into fleet nodes."), hit("block-kit", 0.9, "Format Slack Block Kit.")];
  const h = harness(catalogRuntime(entries));
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) =>
    scores(decisionState(init), () => 0.1));
  await h.after({ toolName: "skills_read", params: { name: "FLEET-SSH" } }, ctx("one"));
  await h.after({ toolName: "skills_read", params: { name: "block-kit" }, result: { isError: true } }, ctx("one"));
  await h.after({ toolName: "skills_read", params: { name: "nonexistent" } }, ctx("one"));
  const result = await h.before(prompt(), ctx("two"));
  assert.match(result?.appendContext ?? "", /name="fleet-ssh" path="\/skills\/fleet-ssh\/SKILL\.md">SSH into fleet nodes\.<\/skill>/);
  assert.doesNotMatch(result?.appendContext ?? "", /block-kit|nonexistent/);
});

test("disabled Skill Whisperer registers no hooks", () => {
  assert.equal(harness(catalogRuntime([]), local, {}, { ...enabled, enabled: false }).hooks.size, 0);
});

test("opened_at_ms is monotonic: an earlier or missing open time never rewinds the recorded first-open watermark", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "skill-opened-"));
  const store = new SkillSessionStore(join(directory.path, "memory.sqlite"));
  try {
    const entry = { canonicalPath: "/skills/a/SKILL.md", name: "a", description: "A", source: "read" as const,
      addedTurn: 1, addedAtMs: 100, lastUsedAtMs: 100 };
    store.upsert("s", [{ ...entry, openedAtMs: 500 }]);
    store.upsert("s", [{ ...entry, lastUsedAtMs: 600, openedAtMs: 300 }]);
    assert.equal(store.list("s")[0]?.openedAtMs, 500, "a late-arriving earlier open does not rewind");
    store.upsert("s", [{ ...entry, lastUsedAtMs: 700 }]);
    assert.equal(store.list("s")[0]?.openedAtMs, 500, "an upsert without an open keeps the existing value");
    store.upsert("s", [{ ...entry, lastUsedAtMs: 800, openedAtMs: 900 }]);
    assert.equal(store.list("s")[0]?.openedAtMs, 900);
  } finally { store.close(); }
});

test("wasWhispered is recorded only for whispered skills that were actually rendered, not overflow admissions", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "skill-overflow-"));
  const dbPath = join(directory.path, "memory.sqlite");
  // Five admissions whose escaped descriptions (~1,200 chars each) cannot all fit maxInjectedChars.
  const entries = Array.from({ length: 5 }, (_, i) => hit(`s${i}`, 0.9, "&".repeat(300)));
  const writer = new RecallLedgerWriter();
  const runtime = { ...catalogRuntime(entries, async () => entries), memoryDatabasePath: () => dbPath };
  const h = harness(runtime, local, {}, enabled, undefined, { writer, dbPathForAgent: () => dbPath });
  let rendered: string[] = [];
  try {
    const context = ctx("one");
    const block = (await h.prompt(prompt(), context))?.appendContext ?? "";
    rendered = [...block.matchAll(/path="([^"]+)"/g)].map(match => match[1]!);
    assert.ok(rendered.length > 0 && rendered.length < entries.length, `some admissions overflow (${rendered.length} rendered)`);
    for (const entry of entries) await h.after(read(entry.path), context);
  } finally { h.stop(); await writer.close(); }
  const store = new SkillSessionStore(dbPath);
  try {
    assert.equal(store.list("thread").filter(row => row.source === "whisperer").length, entries.length, "all five were admitted");
  } finally { store.close(); }
  const db = openRecallLedger(dbPath);
  try {
    const opens = db.prepare("SELECT skill_path, was_whispered, was_pinned FROM skill_open_events ORDER BY id").all();
    assert.deepEqual(opens.map(row => [row.skill_path, row.was_whispered, row.was_pinned]),
      entries.map(entry => [entry.path, rendered.includes(entry.path) ? 1 : 0, 1]));
  } finally { db.close(); }
});
