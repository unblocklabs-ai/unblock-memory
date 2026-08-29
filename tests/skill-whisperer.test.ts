import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildSkillWhispererQuery, registerSkillWhisperer } from "../src/skill-whisperer.js";

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
) => Promise<{ prependContext?: string } | void> | { prependContext?: string } | void;

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

function harness(candidates: Array<{ name: string; path: string; score: number }>) {
  const hooks = new Map<string, (...args: never[]) => unknown>();
  const queries: string[] = [];
  const api = {
    config: {},
    logger: { warn() {} },
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
      return candidates;
    },
    resolveSkillPath(_params: unknown, path: string) { return path.startsWith("/skills/") ? path : undefined; },
  };
  registerSkillWhisperer(api, runtime, enabled);
  return {
    queries,
    before: hooks.get("before_prompt_build") as unknown as BeforePromptBuild,
    after: hooks.get("after_tool_call") as unknown as AfterToolCall,
    end: hooks.get("session_end") as unknown as SessionEnd,
  };
}

test("builds a bounded semantic query from only the configured recent conversation", () => {
  assert.equal(buildSkillWhispererQuery("current request", [
    { role: "system", content: "secret system" },
    { role: "user", content: "too old" },
    { role: "assistant", content: [{ type: "text", text: "recent answer" }, { type: "tool_call", text: "ignored" }] },
    { role: "toolResult", content: "ignored result" },
    { role: "user", content: "recent question" },
  ], 2), "assistant: recent answer\n\nuser: recent question\n\nuser: current request");
  assert.equal(buildSkillWhispererQuery("current request", [
    { role: "user", content: "ignored history" },
  ], 0), "user: current request");
});

test("suggests the best skill, emits nothing while it cools down, and is idempotent per run", async () => {
  const skillA = { name: "alpha", path: "/skills/alpha/SKILL.md", score: 0.9 };
  const skillB = { name: "beta", path: "/skills/beta/SKILL.md", score: 0.8 };
  const testHarness = harness([skillA, skillB]);
  const context = (runId: string): HookContext => ({ trigger: "user", runId, agentId: "bill", sessionId: "session" });
  const event = { prompt: "help me deploy", messages: [] };

  assert.match((await testHarness.before(event, context("run-1")))?.prependContext ?? "", /alpha/);
  assert.equal(await testHarness.before(event, context("run-1")), undefined);
  assert.equal(testHarness.queries.length, 1);
  assert.equal(await testHarness.before(event, context("run-2")), undefined);
  assert.equal(await testHarness.before(event, context("run-3")), undefined);
  assert.match((await testHarness.before(event, context("run-4")))?.prependContext ?? "", /alpha/);
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
  ))?.prependContext ?? "", /beta/);

  await testHarness.end({ sessionId: "session" }, context);
  assert.match((await testHarness.before(
    { prompt: "task", messages: [] },
    { ...context, runId: "run-3" },
  ))?.prependContext ?? "", /beta/);
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
  registerSkillWhisperer(api, {
    async searchSkills() { return [{ name: "deploy", path: lexicalPath, score: 0.9 }]; },
    resolveSkillPath(_params, path) {
      return path === lexicalPath || path === canonicalPath ? canonicalPath : undefined;
    },
  }, enabled);
  const before = hooks.get("before_prompt_build") as unknown as BeforePromptBuild;
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
  }, { ...enabled, enabled: false });
  assert.equal(registrations, 0);
});

test("retrieval failures do not block the agent turn", async () => {
  let before: BeforePromptBuild | undefined;
  const api = {
    config: {},
    logger: { warn() {} },
    on(name: string, handler: unknown) {
      if (name === "before_prompt_build") before = handler as BeforePromptBuild;
    },
  } as unknown as OpenClawPluginApi;
  registerSkillWhisperer(api, {
    async searchSkills() { throw new Error("index unavailable"); },
    resolveSkillPath() { return undefined; },
  }, enabled);
  assert.equal(await before?.(
    { prompt: "task", messages: [] },
    { trigger: "user", runId: "run", agentId: "bill", sessionId: "session" },
  ), undefined);
});
