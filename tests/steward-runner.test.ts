import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { resolveStewardConfig, resolveStewardCredential } from "../src/steward-config.js";
import { createStewardRunner, type StewardRunRequest } from "../src/steward-runner.js";

const config = resolveStewardConfig(undefined);
const token = "private-test-credential";
const deps = { config, resolveApiKey: async () => token };
type Deps = Parameters<typeof createStewardRunner>[0];
type Host = NonNullable<Deps["hostLlmComplete"]>;
const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const prompt = { purpose: "memory.test", systemPrompt: "Summarize.", userPrompt: "What changed?" };
const req: StewardRunRequest<{ answer: string }> = { ...prompt, tools: [], submitSchema: schema, maxTurns: 6,
  maxToolCalls: 10, wallTimeoutMs: 10_000 };
const complete = { ...prompt, schema };
const call = (name: string, call_id: string, args: unknown) => ({ type: "function_call", call_id, name, arguments: JSON.stringify(args) });
const submit = call("submit_result", "final", { answer: "found", status: "complete" });
const message = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const collected = (...output: unknown[]) => Response.json({ status: "completed", output });
const hostReply = (text: string): Awaited<ReturnType<Host>> => ({ text, provider: "openai", model: "selected",
  responseModel: "served", stopReason: "stop", agentId: "agent", usage: {},
  execution: { mode: "direct-provider", owner: { kind: "provider", id: "openai" } }, audit: { caller: { kind: "plugin" } } });

type Wire = { input: Array<Record<string, unknown>>; instructions: string; tools: Array<{ name: string; parameters: typeof schema }>;
  stream: boolean; store: boolean; reasoning?: { effort: string }; include?: string[]; text?: unknown; tool_choice?: unknown };
function scripted(...responses: Response[]) {
  const sent: Wire[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    const reply = responses.shift();
    if (!reply) throw new Error("Unexpected extra request");
    return reply;
  };
  return { runner: createStewardRunner({ ...deps, fetch }), sent };
}

test("config defaults, nested overrides and strict boundaries", () => {
  assert.deepEqual(config, { enabled: false, model: "gpt-6.2-sol", reasoning: "medium", endpoint: "https://codex.unblocklabs.ai/v1/responses",
    maxActiveBackground: 1, deepThought: { enabled: false, maxTurns: 6, maxToolCalls: 16, maxConcurrent: 2, timeoutMs: 60000,
      maxToolResultChars: 8000, maxInputTokens: 48000 }, peopleShadow: { enabled: false, intervalMinutes: 60, maxItemsPerRun: 10, timeoutMs: 45000 } });
  const overridden = resolveStewardConfig({ reasoning: "off", endpoint: "http://localhost:123/v1/responses/", deepThought: { maxTurns: 12 } });
  assert.equal(overridden.endpoint, "http://localhost:123/v1/responses");
  assert.equal(overridden.deepThought.maxTurns, 12);
  assert.equal(overridden.deepThought.maxConcurrent, 2);
  for (const bad of [null, [], { extra: false }, { deepThought: { extra: 0 } }, { peopleShadow: { other: true } },
    { enabled: null }, { peopleShadow: { enabled: 1 } }, { deepThought: [] }, { model: " " }, { reasoning: "adaptive" },
    { apiKey: "bad key" }, { apiKeyFile: 2 }, { maxActiveBackground: 5 }, { deepThought: { maxTurns: 0 } },
    { deepThought: { maxToolCalls: 33 } }, { deepThought: { maxConcurrent: 1.5 } }, { deepThought: { timeoutMs: 4999 } },
    { deepThought: { maxToolResultChars: 32001 } }, { deepThought: { maxInputTokens: 1999 } },
    { peopleShadow: { intervalMinutes: 1441 } }, { peopleShadow: { maxItemsPerRun: 0 } }, { peopleShadow: { timeoutMs: 180001 } }]) {
    assert.throws(() => resolveStewardConfig(bad));
  }
  for (const endpoint of ["not a URL", "file:///private", "https://u:p@x.test", "https://x.test/?", "https://x.test/#fragment",
    "http://remote.example/v1/responses"]) {
    assert.throws(() => resolveStewardConfig({ endpoint }), /endpoint/);
  }
});

test("credential overrides never inherit a decision key across origins or after a missing explicit file", async () => {
  const c = resolveStewardConfig({ enabled: true });
  const decision = { enabled: true, endpoint: "https://codex.unblocklabs.ai/v1/decisions", apiKey: "decision-key", model: "d", timeoutMs: 1000 };
  assert.equal(await resolveStewardCredential(c, decision), "decision-key");
  assert.equal(await resolveStewardCredential({ ...c, endpoint: "https://other.test/v1/responses" }, decision), undefined);
  assert.equal(await resolveStewardCredential({ ...c, apiKey: "explicit" }, decision), "explicit");
  assert.equal(await resolveStewardCredential({ ...c, apiKeyFile: "/nonexistent/b2-test-secret" }, decision), undefined);
});

test("host complete corrects invalid JSON once and accounts for both SDK completions", async () => {
  const calls: Parameters<Host>[0][] = [];
  const runner = createStewardRunner({ ...deps, resolveApiKey: () => { throw new Error("direct auth not allowed"); },
    hostLlmComplete: async input => { calls.push(input); return { ...hostReply(calls.length === 1 ? '{"answer":7}' : '{"answer":"ok"}'),
      usage: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 3 } }; } });
  const result = await runner.complete(complete);
  assert.deepEqual(result, { ok: true, backend: "host_llm", data: { answer: "ok" }, model: "served",
    usage: { requests: 2, inputTokens: 16, outputTokens: 4, cachedInputTokens: 6 } });
  assert.equal(calls[0]?.purpose, prompt.purpose);
  assert.deepEqual(calls[0]?.messages, [{ role: "user", content: prompt.userPrompt }]);
  assert.equal(calls[0]?.systemPrompt, prompt.systemPrompt);
  assert.equal(calls[0]?.reasoning, "medium");
  assert.ok(calls[0] && "responseFormat" in calls[0] && calls[0].responseFormat === schema);
  assert.notEqual(calls[1]?.messages[0]?.content, prompt.userPrompt);
});

test("host lifecycle, stopReason error, and persistent schema errors never escape as successful results", async () => {
  const cases: Array<[Host, string, boolean, number]> = [
    [async () => { throw Object.assign(new Error("retired"), { code: "LLM_RUNTIME_LIFECYCLE" }); }, "lifecycle_reload", true, 1],
    [async () => ({ ...hostReply('{"answer":"looks valid"}'), stopReason: "error", usage: { outputTokens: 2 } }), "provider_error", false, 1],
    [async () => hostReply("null"), "invalid_output", false, 2],
  ];
  for (const [hostLlmComplete, code, retryable, requests] of cases) {
    const result = await createStewardRunner({ ...deps, hostLlmComplete }).complete({ ...complete, maxRetries: 9 });
    assert.ok(!result.ok);
    assert.equal(result.code, code);
    assert.equal(result.retryable, retryable);
    assert.equal(result.usage.requests, requests);
    assert.equal("costUsd" in result.usage, false);
    if (code === "provider_error") assert.equal(result.usage.outputTokens, 2);
  }
  const result = await createStewardRunner({ ...deps, hostLlmComplete: async () => ({
    ...hostReply('{"answer":"yes"}'), usage: { costUsd: 0.03 },
  }) }).complete(complete);
  assert.ok(result.ok);
  assert.deepEqual(result.usage, { requests: 1, costUsd: 0.03 });
});

test("direct complete uses strict Responses JSON and corrects invalid structured text", async () => {
  const { runner, sent } = scripted(collected(message("not JSON")), collected(message('{"answer":"yes"}')));
  const result = await runner.complete({ ...complete, reasoning: "off" });
  assert.ok(result.ok);
  assert.equal(result.backend, "responses_api");
  assert.deepEqual(result.data, { answer: "yes" });
  assert.deepEqual(result.usage, { requests: 2 });
  assert.deepEqual(sent[0]?.text, { format: { type: "json_schema", name: "steward_output", schema, strict: true } });
  assert.equal(sent[0]?.reasoning, undefined);
  assert.equal(sent[0]?.stream, false);
  assert.equal(sent[0]?.store, false);
});

test("three-turn HTTP run replays ordered reasoning, pairs exact call IDs and sanitizes tool results", async t => {
  const reason = { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] };
  const first = [reason, call("read", "id-B", { answer: "first" }), message("one more"), call("absent", "id-A", {})];
  const second = [call("read", "id-D", { answer: 123 }), { ...call("read", "id-E", {}), arguments: "{" }, call("read", "id-C", { answer: "second" })];
  const received: Wire[] = [], auth: unknown[] = [], urls: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    auth.push(request.headers.authorization);
    urls.push(`${request.method} ${request.url}`);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "completed", model: "served", output: [first, second, [submit]][received.length - 1],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const invoked: unknown[] = [], events: boolean[] = [];
  const runner = createStewardRunner({ ...deps, config: { ...config, endpoint: `http://127.0.0.1:${address.port}/v1/responses` } });
  const result = await runner.run({ ...req, maxToolResultChars: 100, tools: [{ name: "read", description: "Read", parameters: schema,
    execute: async args => { invoked.push(args.answer); return "Bearer ab.cd sk-test-123 xoxb-test ghp_test AKIA1234567890123456 " + token + "😀".repeat(100); } }],
    onToolCall: event => events.push(event.ok) });
  assert.deepEqual(result, { ok: true, status: "complete", summary: "found", data: { answer: "found" }, model: "served", turns: 3, toolCalls: 6,
    usage: { requests: 3, inputTokens: 30, outputTokens: 15, cachedInputTokens: 6, reasoningTokens: 3 } });
  assert.deepEqual(invoked, ["first", "second"]);
  assert.deepEqual(events, [true, false, false, false, true, true]);
  assert.deepEqual(auth, Array(3).fill(`Bearer ${token}`));
  assert.deepEqual(urls, Array(3).fill("POST /v1/responses"));
  for (const wire of received) {
    assert.equal(wire.store, false);
    assert.equal(wire.stream, false);
    assert.deepEqual(wire.reasoning, { effort: "medium" });
    assert.deepEqual(wire.include, ["reasoning.encrypted_content"]);
  }
  const finalInput = received[2]!.input;
  assert.deepEqual(finalInput.slice(0, 1 + first.length), [{ role: "user", content: prompt.userPrompt }, ...first]);
  assert.deepEqual(finalInput.slice(1 + first.length + 2, 1 + first.length + 2 + second.length), second);
  const outputs = finalInput.filter(i => i.type === "function_call_output");
  assert.deepEqual(outputs.map(i => i.call_id), ["id-B", "id-A", "id-D", "id-E", "id-C"]);
  assert.match(String(outputs[1]?.output), /unknown tool/i);
  assert.match(String(outputs[2]?.output), /invalid tool arguments/i);
  assert.match(String(outputs[3]?.output), /invalid tool arguments/i);
  const sanitized = String(outputs[0]?.output);
  assert.ok(sanitized.length <= 100 && !/[\uD800-\uDBFF]$/u.test(sanitized));
  assert.doesNotMatch(sanitized, /ab\.cd|sk-test|xoxb-|ghp_|AKIA|private-test/);
  assert.ok(sanitized.includes("😀"));
});

test("one bounded correction for a missing or schema-invalid submission", async () => {
  for (const first of [message("finished"), call("submit_result", "invalid", { answer: 1, status: "complete" })]) {
    const { runner, sent } = scripted(collected(first), collected(call("submit_result", "fixed", { answer: "ask", status: "needs_decision" })));
    const result = await runner.run(req);
    assert.ok(result.ok);
    assert.equal(result.status, "needs_decision");
    assert.equal(result.turns, 2);
    assert.deepEqual(sent[1]?.tool_choice, { type: "function", name: "submit_result" });
    if (first.type === "function_call") assert.ok(sent[1]?.input.some(i => i.type === "function_call_output" && i.call_id === "invalid"));
  }
  const { runner, sent } = scripted(collected(message("not yet")), collected(message("done")));
  const failed = await runner.run(req);
  assert.ok(!failed.ok && failed.code === "invalid_output");
  assert.equal(sent.length, 2);
});

test("ambiguous calls, refusals, incomplete responses and reserved status cannot dispatch tools or publish data", async () => {
  let executions = 0;
  const tools = [{ name: "read", description: "read", parameters: schema, execute: async () => ++executions }];
  for (const response of [collected(submit, { ...submit, call_id: "other" }), collected(call("read", "x", {}), submit),
    collected(call("read", "same", { answer: "x" }), call("read", "same", { answer: "y" })),
    collected({ type: "message", content: [{ type: "refusal", refusal: "no" }] }, submit),
    Response.json({ status: "incomplete", output: [submit] })]) {
    const result = await scripted(response).runner.run({ ...req, tools });
    assert.ok(!result.ok && result.code === "invalid_output");
    assert.equal(result.usage.requests, 1);
  }
  const { runner, sent } = scripted();
  const result = await runner.run({ ...req, submitSchema: { ...schema, properties: { status: {} } } });
  assert.ok(!result.ok && result.code === "invalid_output");
  assert.equal(sent.length, 0);
  assert.equal(executions, 0);
});

test("429 and interrupted streams retry the same turn with failed requests included in usage", async () => {
  const { runner, sent } = scripted(Response.json({ error: { code: "rate_limit" } }, { status: 429, headers: { "Retry-After": "0" } }),
    Response.json({ status: "failed", error: { code: "stream_incomplete" }, usage: { output_tokens: 3 } }),
    Response.json({ output: [submit], usage: { input_tokens: 7, output_tokens: 1, cost_usd: 0.1 } }));
  const result = await runner.run({ ...req, maxTurns: 1 });
  assert.ok(result.ok);
  assert.equal(result.turns, 1);
  assert.deepEqual(result.usage, { requests: 3, inputTokens: 7, outputTokens: 4 });
  assert.deepEqual(sent, [sent[0], sent[0], sent[0]]);
});

test("a connection reset after a tool call resends its output without re-executing the tool", async () => {
  const bodies: string[] = [];
  let executions = 0;
  const runner = createStewardRunner({ ...deps, fetch: async (_url, init) => {
    assert.equal(init?.redirect, "error");
    bodies.push(String(init?.body));
    if (bodies.length === 1) return collected(call("read", "read-once", {}));
    if (bodies.length === 2) throw new TypeError("connection reset");
    return collected(submit);
  } });
  const result = await runner.run({ ...req, tools: [{ name: "read", description: "read", parameters: { type: "object" },
    execute: async () => ++executions }] });
  assert.ok(result.ok);
  assert.deepEqual(result.usage, { requests: 3 });
  assert.equal(result.turns, 2);
  assert.equal(executions, 1);
  assert.equal(bodies[1], bodies[2]);
});

test("provider limits, permanent HTTP failures and Retry-After beyond the deadline are not retried", async () => {
  for (const [status, code, expected] of [[503, "context_length_exceeded", "context_overflow"], [400, "stream_incomplete", "provider_error"],
    [401, "unauthorized", "provider_error"], [403, "forbidden", "provider_error"], [429, "rate_limit", "transient_provider"]] as const) {
    const { runner, sent } = scripted(Response.json({ error: { code, message: token } }, { status, headers: { "Retry-After": "300" } }));
    const result = await runner.run(req);
    assert.ok(!result.ok);
    assert.equal(result.code, expected);
    assert.equal(result.retryable, expected === "transient_provider");
    assert.ok(!result.error.includes(token));
    assert.equal(sent.length, 1);
  }
});

test("hard budgets stop before the next dispatch or a partial batch of tool executions", async () => {
  const read = call("read", "read1", { answer: "x" });
  let executions = 0;
  const tools = [{ name: "read", description: "read", parameters: schema, execute: async () => {
    executions++; return "long tool output ".repeat(1000);
  } }];
  for (const [overrides, response, requests, count] of [
    [{ maxTurns: 1 }, collected(read), 1, 1],
    [{ maxToolCalls: 1 }, collected(read, { ...read, call_id: "read2" }), 1, 0],
    [{ maxInputTokens: 5 }, collected(read), 0, 0],
    [{ maxInputTokens: 1000 }, collected(read), 1, 1],
  ] as const) {
    const { runner, sent } = scripted(response);
    executions = 0;
    const result = await runner.run({ ...req, ...overrides, tools });
    assert.ok(!result.ok && result.code === "budget_exhausted");
    assert.equal(result.usage.requests, requests);
    assert.equal(sent.length, requests);
    assert.equal(executions, count);
  }
});

test("wall timeout bounds stalled credentials; caller abort interrupts an uncooperative tool", async () => {
  const stalled = createStewardRunner({ ...deps, resolveApiKey: () => new Promise(() => {}) });
  const timeout = await stalled.run({ ...req, wallTimeoutMs: 20 });
  assert.ok(!timeout.ok && timeout.code === "timeout");
  assert.equal(timeout.usage.requests, 0);
  const missing = await createStewardRunner({ ...deps, resolveApiKey: async () => undefined }).run(req);
  assert.ok(!missing.ok && missing.code === "missing_credentials");
  assert.equal(missing.usage.requests, 0);
  const controller = new AbortController();
  const { runner, sent } = scripted(collected(call("wait", "wait1", {})));
  let toolSignal: AbortSignal | undefined;
  const stopped = await runner.run({ ...req, signal: controller.signal, tools: [{ name: "wait", description: "wait", parameters: {},
    execute: (_args, signal) => { toolSignal = signal; controller.abort(); return new Promise(() => {}); } }] });
  assert.ok(!stopped.ok && stopped.code === "aborted");
  assert.equal(toolSignal?.aborted, true);
  assert.equal(stopped.toolCalls, 1);
  assert.equal(sent.length, 1);
  const preAborted = await runner.run({ ...req, signal: controller.signal });
  assert.ok(!preAborted.ok && preAborted.code === "aborted" && preAborted.usage.requests === 0);
});

test("a chunked oversized response is cancelled, not parsed or retried", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { cancelled = true; } });
  const { runner, sent } = scripted(new Response(body));
  const result = await runner.run(req);
  assert.ok(!result.ok && result.code === "invalid_output");
  assert.equal(cancelled, true);
  assert.equal(sent.length, 1);
});
