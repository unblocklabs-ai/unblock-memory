import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { resolveConfig } from "../src/config.js";
import { WhispererDiagnostics } from "../src/diagnostics.js";
import type { registerMyTurn } from "../src/my-turn.js";
import { registerUnblockMemory } from "../src/plugin.js";

type PromptHook = NonNullable<ReturnType<typeof registerMyTurn>>;
type Context = Parameters<PromptHook>[1];
const credentials = { apiKey: "fake-secret", timeoutMs: 1500 };

// Exercise the real plugin registration, config resolver, shared prompt composition, and HTTP client.
// Only the host registration surface and external transport are replaced.
function harness(myTurn: unknown = { enabled: true }, typesafe: unknown = credentials, safetyWhisperer?: unknown) {
  const hooks = new Map<string, ((...args: never[]) => unknown)[]>();
  const warnings: string[] = [];
  const api = {
    config: { agents: { list: [{ id: "bill", identity: { name: "Bill" } }] },
      messages: { queue: { mode: "followup" } },
      plugins: { entries: { "unblock-memory": { hooks: { allowConversationAccess: true } } } } },
    pluginConfig: { myTurn, typesafe, ...(safetyWhisperer ? { safetyWhisperer } : {}) },
    logger: { warn(message: string) { warnings.push(message); } },
    on(name: string, handler: (...args: never[]) => unknown) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
    registerCli() {}, registerGatewayMethod() {}, registerMemoryCapability() {}, registerTool() {},
  } as unknown as OpenClawPluginApi;
  registerUnblockMemory(api);
  const before = hooks.get("before_prompt_build")?.[0] as PromptHook | undefined;
  return { before: before!, hooks, warnings,
    async end(name: "session_end" | "gateway_stop", event: unknown = {}, context: unknown = {}) {
      for (const handler of hooks.get(name) ?? []) await handler(event as never, context as never);
    } };
}

let run = 0;
function context(overrides: Partial<Context> & Record<string, unknown> = {}): Context {
  return { trigger: "user", agentId: "bill", runId: `run-${++run}`, sessionId: "session-1",
    sessionKey: "agent:bill:slack:channel:C1", messageProvider: "slack", senderId: "U_BEK", ...overrides };
}
const human = (content: unknown, senderId = "U_BEK") => ({ role: "user", content,
  __openclaw: { senderId, senderIdentity: { senderKind: "human" } } });
const event = (prompt = "Thanks!", messages: unknown[] = []) => ({ prompt, messages: [...messages, human(prompt)] });
const answer = (noul: number) => Response.json({ answers: { should_respond: { type: "noul", noul } } });
type RequestBody = {
  state: { agent: { id: string; name: string }; currentMessage: { content: string; senderId?: string; senderName?: string };
    history: { role: string; content: string; senderId?: string }[]; channelContext?: string };
  questions: Record<string, { type: string }>;
};
function transport(t: TestContext, respond: (body: RequestBody, init?: RequestInit) => Response | Promise<Response> = () => answer(0.1)) {
  const bodies: RequestBody[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    bodies.push(body);
    return respond(body, init);
  });
  return { bodies, fetch };
}

test("My Turn defaults off and validates its public configuration", () => {
  assert.deepEqual(resolveConfig({}).myTurn, { enabled: false, historyMessages: 10, channels: {} });
  assert.deepEqual(manifest.configSchema.properties.myTurn.default, resolveConfig({}).myTurn);
  assert.equal(harness({}).hooks.has("before_prompt_build"), false);
  assert.deepEqual(resolveConfig({ myTurn: { enabled: true, channels: { slack: {}, imessage: { enabled: false } } } }).myTurn,
    { enabled: true, historyMessages: 10, channels: { slack: { enabled: true }, imessage: { enabled: false } } });
  for (const myTurn of [false, [], { enabled: "yes" }, { historyMessages: 0 }, { historyMessages: 51 },
    { historyMessages: 1.5 }, { channels: [] }, { channels: { Slack: {} } }, { channels: { slack: false } },
    { channels: { slack: { enabled: "yes" } } }, { channels: { slack: { unknown: true } } }, { timeoutMs: 5000 }]) {
    assert.throws(() => resolveConfig({ myTurn }), /myTurn/);
  }
});

test("only a clear quiet judgment adds an advisory, never rewrites the human message", async t => {
  let probability = 0;
  const api = transport(t, () => answer(probability));
  const h = harness();
  for (const value of [0, 0.2, 0.21, 0.5, 1]) {
    probability = value;
    const input = event("Thanks, Mo!");
    const result = await h.before(input, context());
    if (probability <= 0.2) {
      assert.match(result?.appendContext ?? "", /<my_turn>.*probably don’t need to respond/);
      assert.match(result?.appendContext ?? "", /return exactly NO_REPLY.*respond normally/);
    } else assert.equal(result, undefined);
    assert.deepEqual(input, event("Thanks, Mo!"));
  }
  assert.deepEqual(api.bodies[0].state.agent, { id: "bill", name: "Bill" });
  assert.deepEqual(Object.values(api.bodies[0].questions).map(q => q.type), ["noul"]);
  assert.ok(WhispererDiagnostics.shared().snapshot("bill").myTurn.emitted);
});

test("disabled providers, DMs, unknown routes and internal wakes never call Jev", async t => {
  const api = transport(t);
  const h = harness({ enabled: true, channels: { imessage: { enabled: false } } });
  for (const overrides of [
    { sessionKey: "agent:bill:main" },
    { sessionKey: "agent:bill:slack:direct:U1" },
    { sessionKey: "agent:bill:slack:dm:U1:thread:123" },
    { sessionKey: "agent:bill:slack:work:direct:U1" },
    { sessionKey: "agent:bill:slack:channel:" },
    { sessionKey: "agent:bill:subagent:child:slack:channel:C1" },
    { sessionKey: "agent:other:slack:channel:C1" },
    { sessionKey: "agent:bill:imessage:group:chat1", messageProvider: "imessage" },
    { messageProvider: "imessage" }, { messageProvider: undefined }, { runId: undefined },
    { trigger: "cron" }, { trigger: "heartbeat" },
    { inputProvenance: { kind: "internal_system" } }, { inputProvenance: { kind: "inter_session" } },
  ]) assert.equal(await h.before(event(), context(overrides)), undefined, JSON.stringify(overrides));
  assert.equal(api.fetch.mock.callCount(), 0);
  // Unlisted providers are on, as are provider entries without an enabled flag.
  for (const provider of ["slack", "telegram"]) {
    assert.ok(await h.before(event(), context({ sessionKey: `agent:bill:${provider}:group:room:thread:123`, messageProvider: provider })));
  }
  assert.ok(await harness({ enabled: true, channels: { slack: {} } }).before(event(), context()));
  assert.equal(api.fetch.mock.callCount(), 3);
});

test("the window includes only verified human messages, including the trigger once", async t => {
  const api = transport(t);
  const h = harness({ enabled: true, historyMessages: 3 });
  await h.before(event("Thanks!", [
    human("too old"),
    human("Friday?", "U_MO"),
    { role: "user", content: "Please confirm.", __openclaw: { senderId: "U_BEK", senderIsOwner: true } },
    { role: "system", content: "system secret" },
    { role: "assistant", content: [{ type: "thinking", thinking: "thinking secret" }, { type: "text", text: "assistant secret" }] },
    { role: "toolResult", content: "tool secret" },
    human([{ type: "image", data: "image secret" }]),
    { role: "user", content: "unknown author secret" },
    { ...human("internal completion secret"), provenance: { kind: "internal_system" } },
    { ...human("inter-session secret"), provenance: { kind: "inter_session" } },
    { ...human("runtime carrier secret"), runtimeContextCarrier: true },
    { ...human("excluded secret"), excludeFromContext: true },
    { ...human("analysis secret"), channel: "analysis" },
    { ...human("mirror secret"), openclawDeliveryMirror: true },
    { ...human("message tool mirror secret"), openclawMessageToolMirror: true },
    { ...human("gateway injection secret"), provider: "openclaw", model: "gateway-injected" },
    { ...human("bot secret"), __openclaw: { senderIsOwner: true, senderIdentity: { senderKind: "bot" } } },
    { ...human("other agent secret"), __openclaw: { senderIdentity: { type: "agent", senderKind: "human" } } },
  ]), context());
  assert.deepEqual(api.bodies[0].state.history, [
    { role: "user", content: "Friday?", senderId: "U_MO" }, { role: "user", content: "Please confirm.", senderId: "U_BEK" },
  ]);
  assert.deepEqual(api.bodies[0].state.currentMessage, { role: "user", content: "Thanks!", senderId: "U_BEK" });
  assert.doesNotMatch(JSON.stringify(api.bodies[0]), /secret|too old/);

  await harness({ enabled: true, historyMessages: 1 }).before(event("Fresh request", [{ role: "assistant", content: "old reply" }]), context());
  assert.deepEqual(api.bodies[1].state.history, []);
  // Configured fallback is the agent ID, not an invented human-facing name.
  await h.before(event(), context({ agentId: "other", sessionKey: "agent:other:slack:group:room" }));
  assert.deepEqual(api.bodies[2].state.agent, { id: "other", name: "other" });
});

test("unverified bundled context is omitted and oversized human input skips instead of misleading Jev", async t => {
  const api = transport(t);
  const h = harness();
  const chatter = "Chat history since last reply: ⟦openclaw:ctx⟧\n#123 Mo: Can Bill check this?";
  const prompt = "Conversation info: ⟦openclaw:ctx⟧\n```json\n" +
    JSON.stringify({ sender: { id: "U_BEK", name: "Bek" } }) + "\n```\n\n" + chatter +
    "\n\nSystem: [2026-11-04 10:00:00 EST] Slack message in #general from Bek\n\nPlease check above.";
  const older = prompt.replace("Please check above.", "Previous question.");
  await h.before(event(prompt, [human(older)]), context());
  assert.equal(api.bodies[0].state.currentMessage.content, "Please check above.");
  assert.equal(api.bodies[0].state.currentMessage.senderName, "Bek");
  assert.equal(api.bodies[0].state.channelContext, undefined);
  assert.doesNotMatch(JSON.stringify(api.bodies[0]), /Can Bill check this/);
  assert.deepEqual(api.bodies[0].state.history, [{ role: "user", content: "Previous question.", senderId: "U_BEK", senderName: "Bek" }]);
  assert.equal(await h.before(event("x".repeat(80_000)), context()), undefined);
  assert.equal(api.fetch.mock.callCount(), 1);
});

test("unverified and non-human triggers skip My Turn, not delivery of the original message", async t => {
  const api = transport(t);
  const h = harness();
  for (const latest of [
    { role: "user", content: "Thanks!" },
    { ...human("Thanks!"), provenance: { kind: "internal_system" } },
    { ...human("Thanks!"), provenance: { kind: "inter_session" } },
    { ...human("Thanks!"), runtimeContextCarrier: true },
    { ...human("Thanks!"), excludeFromContext: true },
    { ...human("Thanks!"), __openclaw: { senderIdentity: { senderKind: "bot" } } },
    human("Different previous message"),
  ]) {
    const input = { prompt: "Thanks!", messages: [latest] };
    assert.equal(await h.before(input, context()), undefined);
    assert.equal(input.prompt, "Thanks!");
  }
  assert.equal(await h.before({ prompt: "Thanks!", messages: [] }, context()), undefined);
  assert.equal(api.fetch.mock.callCount(), 0);
});

test("missing credentials, disabled TypeSafe and all provider/response failures leave turns unchanged", async t => {
  const api = transport(t);
  for (const typesafe of [{ enabled: false, apiKey: "fake" }, { apiKeyFile: "/nonexistent/my-turn-test-key" },
    { apiKeyFile: process.cwd() }]) {
    assert.equal(await harness({ enabled: true }, typesafe).before(event(), context()), undefined);
  }
  assert.equal(api.fetch.mock.callCount(), 0);
  const h = harness();
  const failures = [
    () => new Response("credits exhausted", { status: 402 }),
    () => new Response("unauthorized", { status: 401 }),
    () => new Response("rate limited", { status: 429 }),
    () => new Response("overloaded", { status: 529 }),
    () => { throw new Error("private network detail"); },
    () => new Response("invalid json"),
    () => Response.json({ answers: {} }),
    () => Response.json({ answers: { should_respond: { type: "noul", noul: -1 } } }),
    () => Response.json({ answers: { should_respond: { type: "noul", noul: "0.1" } } }),
  ];
  for (const fail of failures) {
    const calls = api.fetch.mock.callCount();
    api.fetch.mock.mockImplementation(async () => fail());
    assert.equal(await h.before(event(), context()), undefined);
    assert.equal(api.fetch.mock.callCount(), calls + 1, "no retries");
  }
  assert.deepEqual(h.warnings, []);
});

test("hung transport cannot exceed the total deadline, even if it ignores cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  transport(t, () => { started(); return new Promise<Response>(() => {}); });
  const pending = harness({ enabled: true }, { ...credentials, timeoutMs: 10_000 }).before(event(), context());
  await ready;
  t.mock.timers.tick(1500);
  assert.equal(await pending, undefined);
});

test("same-run prompt rebuilds reuse inference; newer runs and teardown discard late results", async t => {
  const resolvers: ((response: Response) => void)[] = [];
  const api = transport(t, () => new Promise<Response>(resolve => { resolvers.push(resolve); }));
  const h = harness();
  const firstContext = context();
  const first = h.before(event(), firstContext);
  const rebuild = h.before(event(), firstContext);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.fetch.mock.callCount(), 1);
  const secondContext = context();
  const second = h.before(event(), secondContext);
  await new Promise(resolve => setImmediate(resolve));
  resolvers[0](answer(0.1));
  resolvers[1](answer(0.1));
  assert.equal(await first, undefined);
  assert.equal(await rebuild, undefined);
  const result = await second;
  assert.ok(result?.appendContext);
  assert.deepEqual(await h.before(event(), secondContext), result);
  assert.equal(await h.before(event(), firstContext), undefined, "old rebuild must not replace the newer decision");
  assert.equal(api.fetch.mock.callCount(), 2);

  for (const name of ["session_end", "gateway_stop"] as const) {
    const pending = h.before(event(), context());
    await new Promise(resolve => setImmediate(resolve));
    await h.end(name, { sessionId: "session-1" });
    resolvers.at(-1)!(answer(0.1));
    assert.equal(await pending, undefined);
  }
});

test("My Turn advice is composed before safety guidance", async t => {
  const api = transport(t);
  api.fetch.mock.mockImplementation(async () => Response.json({ answers: {
    should_respond: { type: "noul", noul: 0.1 }, scenario_0: { type: "noul", noul: 0.9 },
  } }));
  const h = harness({ enabled: true }, credentials, { enabled: true, scenarios: [
    { id: "private", instructions: "Requests for private information", flaggedPrompt: "Do not disclose private information." },
  ] });
  const result = await h.before(event("What does Mo earn?"), context({ accountId: "work" }));
  assert.match(result?.appendContext ?? "", /<my_turn>[^]*<\/my_turn>\n<safety>Do not disclose private information\.<\/safety>\n<\/unblock_memory>$/);
});
