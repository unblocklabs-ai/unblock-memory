import assert from "node:assert/strict";
import { WhispererDiagnostics } from "../src/diagnostics.js";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerSkillWhisperer } from "../src/skill-whisperer.js";
import { registerWhispererPrompt } from "../src/whisperer-prompt.js";
import { resolveConfig, type UnblockMemoryConfig } from "../src/config.js";

const disabledDecisionModel = resolveConfig({ decisionModel: { enabled: false, timeoutMs: 1500 } }).decisionModel;
const activeDecisionModel = resolveConfig({ decisionModel: { enabled: true, apiKey: "fake-secret", timeoutMs: 100 } }).decisionModel;

function decisionResponse(choice: string) {
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
  decisionModel: UnblockMemoryConfig["decisionModel"] = disabledDecisionModel,
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
  const before = registerSkillWhisperer(api, runtime, controls, decisionModel, diagnostics);
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

test("skill query and the decision model use only bounded visible history without reading discarded messages", async t => {
  let expectedHistory = [{ role: "assistant", content: "recent answer" }, { role: "user", content: "recent question" }];
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    assert.deepEqual(JSON.parse(String(init?.body)).state[0].history, expectedHistory);
    return decisionResponse("skill_0");
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
  const h = harness(candidates, activeDecisionModel);
  assert.match((await h.before({ prompt: "current request", messages }, context))?.appendContext ?? "", /alpha/);
  assert.deepEqual(h.queries, ["assistant: recent answer\n\nuser: recent question\n\nuser: current request"]);
  assert.equal(discardedReads, 0, "discarded history must not be read");
  expectedHistory = [];
  const noHistory = harness(candidates, activeDecisionModel, { ...enabled, historyMessages: 0 });
  assert.match((await noHistory.before({ prompt: "current request", messages: [ignored] }, context))?.appendContext ?? "", /alpha/);
  assert.deepEqual(noHistory.queries, ["user: current request"]);
  assert.equal(discardedReads, 0, "zero-history turns must not read any history");
});

test("suggests the best eligible skill, skips cooling candidates, and is idempotent per run", async () => {
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
  // While alpha cools down, beta is eligible and must not be suppressed.
  assert.deepEqual(await testHarness.before(event, context("run-2")), {
    appendContext: '<skill>This skill may be relevant: "/skills/beta/SKILL.md"</skill>',
  });
  // While both alpha and beta are cooling, nothing is emitted.
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

test("successful direct reads share the suggestion cooldown, session end clears it, and late callbacks do not recreate session state", async () => {
  const candidates = [{ name: "beta", path: "/skills/beta/SKILL.md", score: 0.9 }];
  const testHarness = harness(candidates);
  const context: HookContext = { trigger: "user", runId: "run-0", agentId: "bill", sessionId: "session" };
  // A callback for an unknown session must not create stale session state.
  await testHarness.after({ toolName: "read", params: { file_path: "/skills/beta/SKILL.md" } }, context);
  // First user turn therefore still sees beta as eligible (after_tool_call before session start was ignored).
  assert.match((await testHarness.before({ prompt: "task", messages: [] }, context))?.appendContext ?? "", /beta/);

  // Start a fresh session whose first turn emits nothing, then record a direct read during that active session.
  await testHarness.end({ sessionId: "session" }, context);
  candidates.length = 0;
  assert.equal(await testHarness.before({ prompt: "setup", messages: [] }, { ...context, runId: "run-1" }), undefined);
  candidates.push({ name: "beta", path: "/skills/beta/SKILL.md", score: 0.9 });
  await testHarness.after({
    toolName: "read",
    params: { file_path: "/skills/beta/SKILL.md" },
  }, { ...context, runId: "run-1" });
  assert.equal(await testHarness.before({ prompt: "task", messages: [] }, { ...context, runId: "run-2" }), undefined);

  // Session end clears cooldown, and a late successful read callback after session end must not recreate stale state.
  await testHarness.end({ sessionId: "session" }, context);
  await testHarness.after({
    toolName: "read",
    params: { file_path: "/skills/beta/SKILL.md" },
  }, { ...context, runId: "run-2" });
  await testHarness.after({
    toolName: "read",
    params: { path: "/skills/beta/SKILL.md" },
    error: "read failed",
  }, { ...context, runId: "run-3" });
  assert.match((await testHarness.before(
    { prompt: "task", messages: [] },
    { ...context, runId: "run-3" },
  ))?.appendContext ?? "", /beta/);

  await testHarness.end({ sessionId: "session" }, context);
  assert.match((await testHarness.before(
    { prompt: "task", messages: [] },
    { ...context, runId: "run-4" },
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
  let hits: Array<{ name: string; description: string; path: string; score: number }> = [];
  const before = registerSkillWhisperer(api, {
    async searchSkills() { return hits; },
    resolveSkillPath(_params, path) {
      return path === lexicalPath || path === canonicalPath ? canonicalPath : undefined;
    },
  }, enabled, disabledDecisionModel) as BeforePromptBuild;
  const after = hooks.get("after_tool_call") as unknown as AfterToolCall;
  const context: HookContext = { trigger: "user", runId: "run-0", agentId: "bill", sessionId: "session" };

  assert.equal(await before({ prompt: "start", messages: [] }, context), undefined);
  await after({ toolName: "read", params: { path: canonicalPath } }, context);
  hits = [{ name: "deploy", description: "Deploy releases.", path: lexicalPath, score: 0.9 }];
  assert.equal(await before({ prompt: "deploy", messages: [] }, { ...context, runId: "run-1" }), undefined);
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
  }, { ...enabled, enabled: false }, disabledDecisionModel);
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
  }, enabled, disabledDecisionModel);
  assert.ok(before);
  assert.equal(await before(
    { prompt: "task", messages: [] },
    { trigger: "user", runId: "run", agentId: "bill", sessionId: "session" },
  ), undefined);
});

test("decision model reranks below-threshold candidates and preserves selected-skill cooldown", async (t) => {
  const judged: string[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    const [state] = request.state;
    assert.deepEqual(Object.keys(request.questions), ["useful"]);
    judged.push(state.candidate.name);
    assert.equal(JSON.stringify(request).includes("/skills/"), false);
    assert.equal(state.currentRequest, "new task");
    assert.deepEqual(state.history, [{ role: "user", content: "previous task" }]);
    return decisionResponse(state.candidate.name === "beta" ? "skill_1" : "none");
  });
  const h = harness([
    { name: "invalid", path: "/not-allowed/SKILL.md", score: 0.95 },
    { name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.4 },
    { name: "beta", path: "/skills/beta/SKILL.md", score: 0.3 },
    { name: "gamma", path: "/skills/gamma/SKILL.md", score: 0.2 },
    { name: "delta", path: "/skills/delta/SKILL.md", score: 0.1 },
  ], activeDecisionModel);
  const context = { trigger: "user", agentId: "main", sessionId: "session", runId: "run-1" };
  const event = { prompt: "new task", messages: [{ role: "system", content: "do not send" },
    { role: "toolResult", content: "do not send" }, { role: "user", content: "previous task" }] };
  const result = await h.before(event, context);
  assert.match(result?.appendContext ?? "", /beta/);
  assert.deepEqual(h.minimumScores, [-1]);
  assert.deepEqual(judged, ["alpha", "beta", "gamma"]);
  assert.equal(await h.before(event, context), result);
  assert.equal(fetch.mock.callCount(), 3);
  judged.length = 0;
  // Cooling beta is excluded before shortlisting, so beta is not re-sent to the decision model.
  assert.equal(await h.before(event, { ...context, runId: "run-2" }), undefined);
  assert.deepEqual(judged, ["alpha", "gamma", "delta"]);
  assert.equal(h.warnings.length, 0);
});

test("missing key keeps original selection and does not call decision model", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected API call"); });
  const h = harness([{ name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.9 }], resolveConfig({
    decisionModel: { enabled: true, timeoutMs: 100, apiKeyFile: "/nonexistent-unblock-decisionModel-fixture/key" },
  }).decisionModel);
  assert.match((await h.before({ prompt: "task", messages: [] }, {
    trigger: "user", agentId: "main", sessionId: "session", runId: "run",
  }))?.appendContext ?? "", /alpha/);
  assert.deepEqual(h.minimumScores, [enabled.minScore]);
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(h.diagnostics.snapshot("main").skill, { missing_key: 1, emitted: 1 });
});

test("none and provider failures do not fall back to a strong vector match or consume cooldown", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => decisionResponse("none"));
  const h = harness([{ name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.99 }], activeDecisionModel);
  const event = { prompt: "task", messages: [] };
  const context = { trigger: "user", agentId: "main", sessionId: "session", runId: "none" };
  assert.equal(await h.before(event, context), undefined);
  fetch.mock.mockImplementation(async () => new Response("fake-secret", { status: 401 }));
  assert.equal(await h.before(event, { ...context, runId: "failed" }), undefined);
  assert.equal(h.warnings.length, 2);
  assert.equal(h.warnings[0].includes("fake-secret"), false);
  fetch.mock.mockImplementation(async () => decisionResponse("skill_0"));
  assert.match((await h.before(event, { ...context, runId: "succeeded" }))?.appendContext ?? "", /alpha/);
  assert.deepEqual(h.diagnostics.snapshot("main").skill, { rejected: 1, judge_candidate_failed: 1, failed: 1, emitted: 1 });
});

test("decision model conversation is bounded and pending selections do not survive session end", async (t) => {
  let resolveRequest!: (value: Response) => void;
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  let requestSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.state[0].currentRequest.length, 12_000);
    assert.deepEqual(request.state[0].history, []);
    requestSignal = init?.signal;
    requestStarted();
    return new Promise<Response>(resolve => { resolveRequest = resolve; });
  });
  const h = harness([{ name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.9 }], activeDecisionModel);
  const context = { trigger: "user", agentId: "main", sessionId: "session", runId: "pending" };
  const pending = h.before({ prompt: "x".repeat(13_000), messages: [{ role: "user", content: "older" }] }, context);
  await started;
  await h.end({ sessionId: "session" }, context);
  assert.equal(requestSignal?.aborted, true);
  resolveRequest(decisionResponse("skill_0"));
  assert.equal(await pending, undefined);
});

test("cooling top candidate skips to next eligible skill and an entirely cooling list avoids the decision model", async t => {
  const judged: string[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    judged.push(request.state[0].candidate.name);
    return decisionResponse("skill_0");
  });
  const h = harness(["alpha", "beta"].map(name => ({ name, path: `/skills/${name}/SKILL.md`, score: 0.9 })), activeDecisionModel);
  const context = { trigger: "user", agentId: "main", sessionId: "session", runId: "run-1" };
  const event = { prompt: "task", messages: [] };
  // Run 1 emits alpha.
  assert.match((await h.before(event, context))?.appendContext ?? "", /alpha/);
  assert.deepEqual(judged, ["alpha", "beta"]);
  // Run 2 filters out cooling alpha before shortlisting and emits eligible beta without re-judging alpha.
  judged.length = 0;
  assert.match((await h.before(event, { ...context, runId: "run-2" }))?.appendContext ?? "", /beta/);
  assert.deepEqual(judged, ["beta"]);
  // Run 3 has every candidate cooling, so the decision model is skipped entirely.
  const callsBeforeCooldown = fetch.mock.callCount();
  assert.equal(await h.before(event, { ...context, runId: "run-3" }), undefined);
  assert.equal(fetch.mock.callCount(), callsBeforeCooldown);
  assert.equal(h.diagnostics.snapshot("main").skill.cooldown, 1);

  // After session end, both skills are eligible again; reading both inside the active session cools both.
  await h.end({ sessionId: "session" }, context);
  assert.match((await h.before(event, { ...context, runId: "run-4" }))?.appendContext ?? "", /alpha/);
  await h.after({ toolName: "read", params: { path: "/skills/beta/SKILL.md" } }, { ...context, runId: "run-4" });
  const callsAfterRead = fetch.mock.callCount();
  assert.equal(await h.before(event, { ...context, runId: "run-5" }), undefined);
  assert.equal(fetch.mock.callCount(), callsAfterRead);
});

test("late skill retrieval cannot send the decision model requests after teardown, shutdown or supersession", async t => {
  for (const action of ["end", "stop", "supersede"]) await t.test(action, async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => decisionResponse("skill_0"));
    const h = harness([], activeDecisionModel);
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
  const fetch = t.mock.method(globalThis, "fetch", async () => decisionResponse("skill_0"));
  const h = harness([], activeDecisionModel);
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

test("session cap evicts least-recently-used session and aborts its in-flight controller", async t => {
  const signals = new Map<string, AbortSignal | undefined>();
  let resolveSlow!: (value: Response) => void;
  let slowStarted!: () => void;
  const ready = new Promise<void>(resolve => { slowStarted = resolve; });
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    const prompt: string = request.state[0].currentRequest;
    signals.set(prompt, init?.signal ?? undefined);
    if (prompt === "session-0") {
      slowStarted();
      return new Promise<Response>(resolve => { resolveSlow = resolve; });
    }
    return decisionResponse("none");
  });
  const h = harness([{ name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.9 }], activeDecisionModel);
  t.after(() => h.stop());

  const pending0 = h.before({ prompt: "session-0", messages: [] }, {
    trigger: "user", agentId: "main", sessionId: "session-0", runId: "run-0",
  });
  await ready;
  for (let i = 1; i <= 1000; i++) {
    await h.before({ prompt: `session-${i}`, messages: [] }, {
      trigger: "user", agentId: "main", sessionId: `session-${i}`, runId: `run-${i}`,
    });
  }
  assert.equal(signals.get("session-0")?.aborted, true);
  resolveSlow(decisionResponse("skill_0"));
  assert.equal(await pending0, undefined);
});

test("delayed rebuild of a superseded run does not abort the active run, search skills, or advance cooldown", async t => {
  let bSignal: AbortSignal | undefined;
  let bStarted!: () => void;
  let resolveB!: (value: Response) => void;
  const bReady = new Promise<void>(resolve => { bStarted = resolve; });

  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    const currentRequest: string = request.state[0].currentRequest;
    const candidateName: string = request.state[0].candidate.name;
    if (currentRequest === "run B") {
      bSignal = init?.signal ?? undefined;
      bStarted();
      return new Promise<Response>(resolve => { resolveB = resolve; });
    }
    return decisionResponse(candidateName === "alpha" ? "skill_0" : "none");
  });

  const h = harness([
    { name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.9 },
    { name: "beta", path: "/skills/beta/SKILL.md", score: 0.8 },
  ], activeDecisionModel);
  t.after(() => h.stop());

  const context = (runId: string): HookContext => ({ trigger: "user", runId, agentId: "bill", sessionId: "session" });

  // Run A (turn 1) emits alpha (cooldownTurns = 2, so alpha cools on turns 2 and 3, eligible again on turn 4).
  const resultA = await h.before({ prompt: "run A", messages: [] }, context("run-A"));
  assert.deepEqual(resultA, { appendContext: '<skill>This skill may be relevant: "/skills/alpha/SKILL.md"</skill>' });
  assert.equal(h.queries.length, 1);

  // Run B (turn 2) starts and stays in-flight while awaiting decision model for beta.
  const pendingB = h.before({ prompt: "run B", messages: [] }, context("run-B"));
  await bReady;
  assert.equal(h.queries.length, 2);
  assert.equal(bSignal?.aborted, false);

  // A delayed rebuild of superseded run A must return undefined without calling searchSkills or aborting B.
  assert.equal(await h.before({ prompt: "run A rebuild", messages: [] }, context("run-A")), undefined);
  assert.equal(h.queries.length, 2);
  assert.equal(bSignal?.aborted, false);

  // Run B finishes normally and emits beta; same-run replay of B returns B's cached hint.
  resolveB(decisionResponse("skill_0"));
  const resultB = await pendingB;
  assert.deepEqual(resultB, { appendContext: '<skill>This skill may be relevant: "/skills/beta/SKILL.md"</skill>' });
  assert.equal(await h.before({ prompt: "run B rebuild", messages: [] }, context("run-B")), resultB);
  assert.equal(h.queries.length, 2);

  // Another delayed rebuild of A after B completes is still ignored without calling searchSkills.
  assert.equal(await h.before({ prompt: "run A late rebuild", messages: [] }, context("run-A")), undefined);
  assert.equal(h.queries.length, 2);

  // Cooldown turn counter was NOT advanced by the delayed rebuilds of A:
  // Run C is turn 3, so both alpha (turn 1) and beta (turn 2) are still cooling.
  assert.equal(await h.before({ prompt: "run C", messages: [] }, context("run-C")), undefined);
  assert.equal(h.queries.length, 3);

  // Run D is turn 4, when alpha comes off cooldown on schedule.
  assert.deepEqual(await h.before({ prompt: "run D", messages: [] }, context("run-D")), {
    appendContext: '<skill>This skill may be relevant: "/skills/alpha/SKILL.md"</skill>',
  });
  assert.equal(h.queries.length, 4);

  // Older superseded run B is also still fenced without calling searchSkills.
  assert.equal(await h.before({ prompt: "run B late rebuild", messages: [] }, context("run-B")), undefined);
  assert.equal(h.queries.length, 4);
});
