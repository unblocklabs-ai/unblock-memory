import assert from "node:assert/strict";
import { WhispererDiagnostics } from "../src/diagnostics.js";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerSkillWhisperer } from "../src/skill-whisperer.js";
import { registerWhispererPrompt } from "../src/whisperer-prompt.js";
import type { UnblockMemoryConfig } from "../src/config.js";

const disabledTypeSafe = { enabled: false, timeoutMs: 1500 };
const activeTypeSafe = { enabled: true, apiKey: "fake-secret", timeoutMs: 100 };

function typeSafeResponse(choice: string) {
  return Response.json({ answers: { useful: { type: "noul", noul: choice === "none" ? 0.1 : 0.9 } } });
}

type HookContext = {
  trigger?: string;
  runId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
};

type BeforePromptBuild = (
  event: { prompt: string; messages: unknown[] },
  context: HookContext,
) => Promise<{ appendContext?: string } | void> | { appendContext?: string } | void;

type AfterToolCall = (
  event: { toolName: string; params: Record<string, unknown>; error?: string },
  context: HookContext,
) => Promise<void> | void;

type SessionEnd = (
  event: { sessionId: string; sessionKey?: string },
  context: HookContext,
) => Promise<void> | void;

const enabled = {
  enabled: true,
  historyMessages: 2,
  minScore: 0.6,
  cooldownTurns: 2,
};

function harness(
  candidates: Array<{ name: string; path: string; score: number }>,
  typesafe: UnblockMemoryConfig["typesafe"] = disabledTypeSafe,
  controls: UnblockMemoryConfig["skillWhisperer"] = enabled,
) {
  const hooks = new Map<string, (...args: never[]) => unknown>();
  const queries: string[] = [];
  const minimumScores: number[] = [];
  const warnings: string[] = [];
  const diagnostics = new WhispererDiagnostics();
  const api = {
    config: {},
    logger: { warn(message: string) { warnings.push(message); } },
    on(name: string, handler: (...args: never[]) => unknown) { hooks.set(name, handler); },
  } as unknown as OpenClawPluginApi;
  const runtime = {
    async searchSkills(
      _params: unknown,
      query: string,
      _minScore: number,
      _limit: number,
    ) {
      queries.push(query);
      minimumScores.push(_minScore);
      return candidates.map(candidate => ({ ...candidate, description: `Use ${candidate.name} for its task.` }));
    },
    resolveSkillPath(_params: unknown, path: string) { return path.startsWith("/skills/") ? path : undefined; },
  };
  const before = registerSkillWhisperer(api, runtime, controls, typesafe, diagnostics);
  return {
    api,
    runtime,
    queries,
    minimumScores,
    warnings,
    diagnostics,
    before: before as BeforePromptBuild,
    after: hooks.get("after_tool_call") as unknown as AfterToolCall,
    end: hooks.get("session_end") as unknown as SessionEnd,
    stop: () => hooks.get("gateway_stop")?.(),
    prompt: () => hooks.get("before_prompt_build") as unknown as BeforePromptBuild,
  };
}

test("skill query and Jev use only bounded visible history without reading discarded messages", async t => {
  let expectedHistory = [{ role: "assistant", content: "recent answer" }, { role: "user", content: "recent question" }];
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    assert.deepEqual(JSON.parse(String(init?.body)).state.history, expectedHistory);
    return typeSafeResponse("skill_0");
  });
  let discardedReads = 0;
  const ignored = { role: "user", get content(): string { discardedReads++; return "old excluded request"; } };
  const messages = [
    ignored,
    { role: "system", content: "secret system" },
    { role: "assistant", content: [{ type: "text", text: "recent answer" }, { type: "tool_call", text: "ignored" }] },
    { role: "toolResult", content: "ignored result" },
    { role: "user", content: "recent question" },
    { role: "assistant", content: [{ type: "thinking", text: "private" }] },
  ];
  const candidates = [{ name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.9 }];
  const context = { trigger: "user", runId: "run", agentId: "bill", sessionId: "session" };
  const h = harness(candidates, activeTypeSafe);
  assert.match((await h.before({ prompt: "current request", messages }, context))?.appendContext ?? "", /alpha/);
  assert.deepEqual(h.queries, ["assistant: recent answer\n\nuser: recent question\n\nuser: current request"]);
  assert.equal(discardedReads, 0, "discarded history must not be read");
  expectedHistory = [];
  const noHistory = harness(candidates, activeTypeSafe, { ...enabled, historyMessages: 0 });
  assert.match((await noHistory.before({ prompt: "current request", messages: [ignored] }, context))?.appendContext ?? "", /alpha/);
  assert.deepEqual(noHistory.queries, ["user: current request"]);
  assert.equal(discardedReads, 0, "zero-history turns must not read any history");
});

test("suggests the best skill, emits nothing while it cools down, and is idempotent per run", async () => {
  const skillA = { name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.9 };
  const skillB = { name: "beta", path: "/skills/beta/SKILL.md", score: 0.8 };
  const testHarness = harness([skillA, skillB]);
  const context = (runId: string): HookContext => ({ trigger: "user", runId, agentId: "bill", sessionId: "session" });
  const event = { prompt: "help me deploy", messages: [] };

  const pending = testHarness.before(event, context("run-1"));
  const pendingRebuild = testHarness.before({ ...event, prompt: "Assembled history\nhelp me deploy" }, context("run-1"));
  const result = await pending;
  assert.deepEqual(result, { appendContext: '<skill>This skill may be relevant: "/skills/alpha/SKILL.md"</skill>' });
  assert.equal(await pendingRebuild, result);
  assert.equal(await testHarness.before(event, context("run-1")), result);
  assert.equal(testHarness.queries.length, 1);
  assert.equal(testHarness.diagnostics.snapshot("bill").skill.emitted, 1);
  assert.equal(await testHarness.before(event, context("run-2")), undefined);
  assert.equal(await testHarness.before(event, context("run-3")), undefined);
  assert.match((await testHarness.before(event, context("run-4")))?.appendContext ?? "", /alpha/);
});

test("does not fall through when the best skill is cooling down", async () => {
  const testHarness = harness([
    { name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.9 },
    { name: "weak", path: "/skills/weak/SKILL.md", score: 0.59 },
  ]);
  const context = (runId: string): HookContext => ({ trigger: "user", runId, agentId: "bill", sessionId: "session" });
  const event = { prompt: "task", messages: [] };
  assert.ok(await testHarness.before(event, context("run-1")));
  assert.equal(await testHarness.before(event, context("run-2")), undefined);
});

test("successful direct reads share the suggestion cooldown and session end clears it", async () => {
  const testHarness = harness([
    { name: "beta", path: "/skills/beta/SKILL.md", score: 0.9 },
    { name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.8 },
  ]);
  const context: HookContext = { trigger: "user", runId: "run-1", agentId: "bill", sessionId: "session" };
  await testHarness.after({
    toolName: "read",
    params: { file_path: "/skills/beta/SKILL.md" },
  }, context);
  assert.equal(await testHarness.before({ prompt: "task", messages: [] }, context), undefined);

  await testHarness.end({ sessionId: "session" }, context);
  await testHarness.after({
    toolName: "read",
    params: { path: "/skills/beta/SKILL.md" },
    error: "read failed",
  }, { ...context, runId: "run-2" });
  assert.match((await testHarness.before(
    { prompt: "task", messages: [] },
    { ...context, runId: "run-2" },
  ))?.appendContext ?? "", /beta/);

  await testHarness.end({ sessionId: "session" }, context);
  assert.match((await testHarness.before(
    { prompt: "task", messages: [] },
    { ...context, runId: "run-3" },
  ))?.appendContext ?? "", /beta/);
});

test("symlinked suggestions and canonical reads share cooldown state", async () => {
  const hooks = new Map<string, (...args: never[]) => unknown>();
  const api = {
    config: {},
    logger: { warn() {} },
    on(name: string, handler: (...args: never[]) => unknown) { hooks.set(name, handler); },
  } as unknown as OpenClawPluginApi;
  const lexicalPath = "/skills-linked/deploy/SKILL.md";
  const canonicalPath = "/skills/deploy/SKILL.md";
  const before = registerSkillWhisperer(api, {
    async searchSkills() { return [{ name: "deploy", description: "Deploy releases.", path: lexicalPath, score: 0.9 }]; },
    resolveSkillPath(_params, path) {
      return path === lexicalPath || path === canonicalPath ? canonicalPath : undefined;
    },
  }, enabled, disabledTypeSafe) as BeforePromptBuild;
  const after = hooks.get("after_tool_call") as unknown as AfterToolCall;
  const context: HookContext = { trigger: "user", runId: "run-1", agentId: "bill", sessionId: "session" };

  await after({ toolName: "read", params: { path: canonicalPath } }, context);
  assert.equal(await before({ prompt: "deploy", messages: [] }, context), undefined);
});

test("disabled whispering registers no hooks", () => {
  let registrations = 0;
  const api = {
    config: {},
    logger: { warn() {} },
    on() { registrations += 1; },
  } as unknown as OpenClawPluginApi;
  registerSkillWhisperer(api, {
    async searchSkills() { return []; },
    resolveSkillPath() { return undefined; },
  }, { ...enabled, enabled: false }, disabledTypeSafe);
  assert.equal(registrations, 0);
});

test("retrieval failures do not block the agent turn", async () => {
  const api = {
    config: {},
    logger: { warn() {} },
    on() {},
  } as unknown as OpenClawPluginApi;
  const before = registerSkillWhisperer(api, {
    async searchSkills() { throw new Error("index unavailable"); },
    resolveSkillPath() { return undefined; },
  }, enabled, disabledTypeSafe);
  assert.ok(before);
  assert.equal(await before(
    { prompt: "task", messages: [] },
    { trigger: "user", runId: "run", agentId: "bill", sessionId: "session" },
  ), undefined);
});

test("TypeSafe reranks below-threshold candidates and preserves selected-skill cooldown", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(request.questions), ["useful"]);
    assert.ok(["alpha", "beta", "gamma"].includes(request.state.candidate.name));
    assert.equal(JSON.stringify(request).includes("/skills/"), false);
    assert.equal(request.state.currentRequest, "new task");
    assert.deepEqual(request.state.history, [{ role: "user", content: "previous task" }]);
    return typeSafeResponse(request.state.candidate.name === "beta" ? "skill_1" : "none");
  });
  const h = harness([
    { name: "invalid", path: "/not-allowed/SKILL.md", score: 0.95 },
    { name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.4 },
    { name: "beta", path: "/skills/beta/SKILL.md", score: 0.3 },
    { name: "gamma", path: "/skills/gamma/SKILL.md", score: 0.2 },
    { name: "delta", path: "/skills/delta/SKILL.md", score: 0.1 },
  ], activeTypeSafe);
  const context = { trigger: "user", agentId: "main", sessionId: "session", runId: "run-1" };
  const event = { prompt: "new task", messages: [{ role: "system", content: "do not send" },
    { role: "toolResult", content: "do not send" }, { role: "user", content: "previous task" }] };
  const result = await h.before(event, context);
  assert.match(result?.appendContext ?? "", /beta/);
  assert.deepEqual(h.minimumScores, [-1]);
  assert.equal(await h.before(event, context), result);
  assert.equal(fetch.mock.callCount(), 3);
  assert.equal(await h.before(event, { ...context, runId: "run-2" }), undefined);
  assert.equal(h.warnings.length, 0);
});

test("missing key keeps original selection and does not call TypeSafe", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected API call"); });
  const h = harness([{ name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.9 }], {
    enabled: true, timeoutMs: 100, apiKeyFile: "/nonexistent-unblock-typesafe-fixture/key",
  });
  assert.match((await h.before({ prompt: "task", messages: [] }, {
    trigger: "user", agentId: "main", sessionId: "session", runId: "run",
  }))?.appendContext ?? "", /alpha/);
  assert.deepEqual(h.minimumScores, [enabled.minScore]);
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(h.diagnostics.snapshot("main").skill, { missing_key: 1, emitted: 1 });
});

test("none and provider failures do not fall back to a strong vector match or consume cooldown", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => typeSafeResponse("none"));
  const h = harness([{ name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.99 }], activeTypeSafe);
  const event = { prompt: "task", messages: [] };
  const context = { trigger: "user", agentId: "main", sessionId: "session", runId: "none" };
  assert.equal(await h.before(event, context), undefined);
  fetch.mock.mockImplementation(async () => new Response("fake-secret", { status: 401 }));
  assert.equal(await h.before(event, { ...context, runId: "failed" }), undefined);
  assert.equal(h.warnings.length, 2);
  assert.equal(h.warnings[0].includes("fake-secret"), false);
  fetch.mock.mockImplementation(async () => typeSafeResponse("skill_0"));
  assert.match((await h.before(event, { ...context, runId: "succeeded" }))?.appendContext ?? "", /alpha/);
  assert.deepEqual(h.diagnostics.snapshot("main").skill, { rejected: 1, judge_candidate_failed: 1, failed: 1, emitted: 1 });
});

test("TypeSafe conversation is bounded and pending selections do not survive session end", async (t) => {
  let resolveRequest!: (value: Response) => void;
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  let requestSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.state.currentRequest.length, 12_000);
    assert.deepEqual(request.state.history, []);
    requestSignal = init?.signal;
    requestStarted();
    return new Promise<Response>(resolve => { resolveRequest = resolve; });
  });
  const h = harness([{ name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.9 }], activeTypeSafe);
  const context = { trigger: "user", agentId: "main", sessionId: "session", runId: "pending" };
  const pending = h.before({ prompt: "x".repeat(13_000), messages: [{ role: "user", content: "older" }] }, context);
  await started;
  await h.end({ sessionId: "session" }, context);
  assert.equal(requestSignal?.aborted, true);
  resolveRequest(typeSafeResponse("skill_0"));
  assert.equal(await pending, undefined);
});

test("an entirely cooling shortlist avoids Jev without changing the winning-skill policy", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => typeSafeResponse("skill_0"));
  const h = harness(["alpha", "beta"].map(name => ({ name, path: `/skills/${name}/SKILL.md`, score: 0.9 })), activeTypeSafe);
  const context = { trigger: "user", agentId: "main", sessionId: "session", runId: "run-1" };
  const event = { prompt: "task", messages: [] };
  for (const name of ["alpha", "beta"]) await h.after({ toolName: "read", params: { path: `/skills/${name}/SKILL.md` } }, context);
  assert.equal(await h.before(event, context), undefined);
  assert.equal(fetch.mock.callCount(), 0);
  await h.end({ sessionId: "session" }, context);
  assert.match((await h.before(event, { ...context, runId: "run-2" }))?.appendContext ?? "", /alpha/);
  assert.equal(await h.before(event, { ...context, runId: "run-3" }), undefined);
  assert.equal(fetch.mock.callCount(), 4, "a cooling winner must not fall through to the other candidate");
});

test("late skill retrieval cannot send Jev requests after teardown, shutdown or supersession", async t => {
  for (const action of ["end", "stop", "supersede"]) await t.test(action, async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => typeSafeResponse("skill_0"));
    const h = harness([], activeTypeSafe);
    let finish!: (hits: Awaited<ReturnType<typeof h.runtime.searchSkills>>) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const retrieval = new Promise<Awaited<ReturnType<typeof h.runtime.searchSkills>>>(resolve => { finish = resolve; });
    t.mock.method(h.runtime, "searchSkills", async () => { started(); return retrieval; });
    const event = { prompt: "task", messages: [] };
    const context = { trigger: "user", agentId: "main", sessionId: "session", runId: "old" };
    const old = h.before(event, context);
    await ready;
    let fresh: ReturnType<BeforePromptBuild> = undefined;
    if (action === "end") await h.end({ sessionId: "session" }, context);
    else if (action === "stop") h.stop();
    else fresh = h.before(event, { ...context, runId: "new" });
    finish([{ name: "alpha", description: "Useful skill", path: "/skills/alpha/SKILL.md", score: 0.9 }]);
    assert.equal(await old, undefined);
    if (action === "supersede") assert.ok(await fresh!);
    assert.equal(fetch.mock.callCount(), action === "supersede" ? 1 : 0);
  });
});

test("the total skill deadline releases ready memory and people without late egress", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetch = t.mock.method(globalThis, "fetch", async () => typeSafeResponse("skill_0"));
  const h = harness([], activeTypeSafe);
  let finish!: (hits: Awaited<ReturnType<typeof h.runtime.searchSkills>>) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const retrieval = new Promise<Awaited<ReturnType<typeof h.runtime.searchSkills>>>(resolve => { finish = resolve; });
  t.mock.method(h.runtime, "searchSkills", async () => { started(); return retrieval; });
  registerWhispererPrompt(h.api, {
    skill: h.before as Parameters<typeof registerWhispererPrompt>[1]["skill"],
    memory: () => ({ appendContext: "<memory>ready</memory>" }),
    people: () => ({ appendContext: "<people>ready</people>" }),
  });
  const result: { value: Awaited<ReturnType<BeforePromptBuild>> } = { value: undefined };
  const pending = Promise.resolve(h.prompt()({ prompt: "task", messages: [] }, {
    trigger: "user", agentId: "main", sessionId: "session", runId: "slow",
  })).then(value => { result.value = value; });
  await ready;
  t.mock.timers.tick(3000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.match(result.value?.appendContext ?? "", /<memory>ready<\/memory>\n<people>ready<\/people>/);
  finish([{ name: "alpha", description: "Useful skill", path: "/skills/alpha/SKILL.md", score: 0.9 }]);
  await pending;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(fetch.mock.callCount(), 0);
});
