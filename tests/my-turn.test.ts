import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "../src/config.js";
import { WhispererDiagnostics } from "../src/diagnostics.js";
import type { registerMyTurn } from "../src/my-turn.js";
import { registerUnblockMemory } from "../src/plugin.js";

type PromptHook = NonNullable<ReturnType<typeof registerMyTurn>>;
type Context = Parameters<PromptHook>[1];
const credentials = { apiKey: "fake-secret", timeoutMs: 1500 };

// Exercise the real plugin registration, config resolver, shared prompt composition, and HTTP client.
// Only the host registration surface and external transport are replaced.
function harness(myTurn: unknown = { enabled: true }, decisionModel: unknown = credentials, safetyWhisperer?: unknown) {
  const hooks = new Map<string, ((...args: never[]) => unknown)[]>();
  const warnings: string[] = [];
  const api = {
    config: { agents: { entries: { bill: { identity: { name: "Bill" } } } },
      messages: { queue: { mode: "followup" } },
      plugins: { entries: { "unblock-memory": { hooks: { allowConversationAccess: true } } } } },
    pluginConfig: { myTurn, decisionModel, ...(safetyWhisperer ? { safetyWhisperer } : {}) },
    logger: { warn(message: string) { warnings.push(message); } },
    on(name: string, handler: (...args: never[]) => unknown) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
    registerCli() {}, registerService() {}, registerGatewayMethod() {}, registerMemoryCapability() {}, registerTool() {},
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
    const raw = JSON.parse(String(init?.body)) as Omit<RequestBody, "state"> & { state: [RequestBody["state"]] };
    assert.ok(Array.isArray(raw.state) && raw.state.length === 1);
    const body: RequestBody = { ...raw, state: raw.state[0] };
    bodies.push(body);
    return respond(body, init);
  });
  return { bodies, fetch };
}

test("My Turn defaults off and validates its public configuration", () => {
  assert.deepEqual(resolveConfig({}).myTurn, { enabled: false, historyMessages: 10, channels: {} });
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

test("disabled providers, DMs, unknown routes and internal wakes never call the decision model", async t => {
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
    { inputProvenance: { kind: "internal_system" as const } }, { inputProvenance: { kind: "inter_session" as const } },
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
  const withReplay = (message: ReturnType<typeof human>, upstreamUserText: string) => ({
    ...message, __openclaw: { ...message.__openclaw, upstreamUserText },
  });
  await h.before({ prompt: "Thanks!", messages: [
    human("too old"),
    withReplay(human("Friday?", "U_MO"), "<conversation_context>prior replay secret</conversation_context>"),
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
    withReplay(human("Thanks!"), "<conversation_context>current replay secret</conversation_context>\n" +
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>system secret"),
  ] }, context());
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

test("unverified bundled context is omitted and oversized human input skips instead of misleading the decision model", async t => {
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
  const short = human("Short visible reply");
  assert.ok(await h.before({ prompt: "Short visible reply", messages: [
    { ...short, __openclaw: { ...short.__openclaw,
      upstreamUserText: "<conversation_context>" + "private replay secret ".repeat(5000) + "</conversation_context>" } },
  ] }, context()), "large replay metadata must not make a short human reply exceed the input budget");
  assert.equal(api.fetch.mock.callCount(), 2);
  assert.equal(api.bodies[1].state.currentMessage.content, "Short visible reply");
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

test("missing credentials, disabled decision model and all provider/response failures leave turns unchanged", async t => {
  const api = transport(t);
  for (const decisionModel of [{ enabled: false, apiKey: "fake" }, { apiKeyFile: "/nonexistent/my-turn-test-key" },
    { apiKeyFile: process.cwd() }]) {
    assert.equal(await harness({ enabled: true }, decisionModel).before(event(), context()), undefined);
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
  api.fetch.mock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({
      answers: body.questions?.should_respond
        ? { should_respond: { type: "noul", noul: 0.1 } }
        : { scenario_0: { type: "noul", noul: 0.9 } },
    });
  });
  const h = harness({ enabled: true }, credentials, { enabled: true, scenarios: [
    { id: "private", instructions: "Requests for private information", flaggedPrompt: "Do not disclose private information." },
  ] });
  const result = await h.before(event("What does Mo earn?"), context({ accountId: "work" }));
  assert.match(result?.appendContext ?? "", /<my_turn>[^]*<\/my_turn>\n<safety>Do not disclose private information\.<\/safety>\n<\/unblock_memory>$/);
});

test("LRU session eviction aborts idle evicted runs, preserves active sessions, and retains superseded run history beyond 4 runs", async t => {
  const signals = new Map<string, AbortSignal | undefined>();
  const api = transport(t, (body, init) => {
    signals.set(body.state.currentMessage.content, init?.signal ?? undefined);
    if (body.state.currentMessage.content.startsWith("hang:")) {
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    }
    return answer(0.1);
  });
  const h = harness();
  t.after(() => h.end("gateway_stop"));

  // Superseded run history beyond 4 newer runs still ignores delayed replay of run-0.
  const firstRunCtx = context({ sessionKey: "agent:bill:slack:channel:C_HISTORY", sessionId: "hist-1", runId: "hist-r0" });
  const firstResult = await h.before(event("turn 0"), firstRunCtx);
  assert.ok(firstResult?.appendContext);
  let latestCtx = firstRunCtx;
  let latestResult: Awaited<ReturnType<PromptHook>> = firstResult;
  for (let i = 1; i <= 8; i++) {
    latestCtx = context({ sessionKey: "agent:bill:slack:channel:C_HISTORY", sessionId: "hist-1", runId: `hist-r${i}` });
    latestResult = await h.before(event(`turn ${i}`), latestCtx);
    assert.ok(latestResult?.appendContext);
  }
  const callsBeforeReplay = api.fetch.mock.callCount();
  assert.equal(await h.before(event("turn 0"), firstRunCtx), undefined);
  assert.equal(api.fetch.mock.callCount(), callsBeforeReplay);
  assert.deepEqual(await h.before(event("turn 8"), latestCtx), latestResult);
  assert.equal(api.fetch.mock.callCount(), callsBeforeReplay);

  // Start a clean harness for LRU session-cap eviction (MAX_SESSIONS = 1000).
  const lru = harness();
  t.after(() => lru.end("gateway_stop"));
  const s0Ctx = context({ sessionKey: "agent:bill:slack:channel:C_LRU_0", sessionId: "lru-0", runId: "lru-r0" });
  const s1Ctx = context({ sessionKey: "agent:bill:slack:channel:C_LRU_1", sessionId: "lru-1", runId: "lru-r1" });
  const p0 = lru.before(event("hang:s0"), s0Ctx);
  const p1 = lru.before(event("hang:s1"), s1Ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signals.get("hang:s0")?.aborted, false);
  assert.equal(signals.get("hang:s1")?.aborted, false);

  // Touch s0 via same-run rebuild so s1 becomes the least-recently-used session.
  const callsBeforeTouch = api.fetch.mock.callCount();
  const p0Rebuild = lru.before(event("hang:s0"), s0Ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.fetch.mock.callCount(), callsBeforeTouch);

  // Fill slots 2..999 (total 1000 sessions): neither s0 nor s1 is evicted yet.
  for (let i = 2; i < 1000; i++) {
    await lru.before(event(`fast-${i}`), context({
      sessionKey: `agent:bill:slack:channel:C_LRU_${i}`, sessionId: `lru-${i}`, runId: `lru-r${i}`,
    }));
  }
  assert.equal(signals.get("hang:s0")?.aborted, false);
  assert.equal(signals.get("hang:s1")?.aborted, false);

  // Adding the 1001st session evicts idle s1 and aborts its controller while keeping touched s0 alive.
  await lru.before(event("fast-1000"), context({
    sessionKey: "agent:bill:slack:channel:C_LRU_1000", sessionId: "lru-1000", runId: "lru-r1000",
  }));
  assert.equal(signals.get("hang:s1")?.aborted, true);
  assert.equal(signals.get("hang:s0")?.aborted, false);
  assert.equal(await p1, undefined);

  await lru.end("gateway_stop");
  assert.equal(signals.get("hang:s0")?.aborted, true);
  assert.equal(await p0, undefined);
  assert.equal(await p0Rebuild, undefined);
});
