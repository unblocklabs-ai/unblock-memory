import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { resolveStewardConfig, resolveStewardCredential } from "../src/steward-config.js";
import { createStewardRunner, stripOptionalNulls, toStrictJsonSchema, type StewardRunRequest } from "../src/steward-runner.js";
import { DEEP_THOUGHT_RESULT_SCHEMA } from "../src/deep-thought.js";
import { PEOPLE_SHADOW_PROPOSAL_SCHEMA } from "../src/steward-people-shadow.js";

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
  assert.deepEqual(config, {
    enabled: true, model: "gpt-6.2-sol", reasoning: "medium", endpoint: "https://codex.unblocklabs.ai/v1/responses",
    maxActiveBackground: 1,
    deepThought: {
      enabled: true, maxTurns: 0, maxToolCalls: 0, maxConcurrent: 0, timeoutMs: 0, syncWaitMs: 65_000, jobRetentionMs: 1_800_000,
      wrapUpReserveMs: 20_000, maxToolResultChars: 0, maxInputTokens: 0, searchRanking: "retrieval", searchMinUsefulness: 0,
      defaultSearchResults: 10, maxSnippetChars: 0, maxQuoteChars: 0, maxPeopleMatches: 0,
    },
    peopleShadow: {
      enabled: true, mode: "publish", intervalMinutes: 60, maxItemsPerRun: 0, timeoutMs: 0,
      minConfidence: "medium", maxHandles: 0, maxExcerptChars: 0, maxExportBytes: 0,
      maxNewClaimsPerPerson: 0, maxInteractionHandles: 0, includeResponseAudit: true,
    },
    captainsLog: {
      enabled: true, intervalMinutes: 180, lookbackMinutes: 190, maxSessionsPerRun: 0,
      maxCharsPerSession: 0, maxExistingLogChars: 0, timeoutMs: 0, excludeChatTypes: ["direct"],
      includeEmotionalSalience: true, minSalienceScore: 0.7, minAbsoluteIntensity: 2.2, minRelativeIntensity: 1.5,
    },
    outcomeLedger: {
      enabled: true, intervalMinutes: 60, lookbackMs: 604_800_000, maxRowsPerPass: 0, matchWindowMs: 1_800_000, retentionDays: 0,
    },
    expectations: {
      enabled: true, intervalMinutes: 60, lookbackMinutes: 70, dueLeadMinutes: 60, sweepAfterMinutes: 1440, maxSessionsPerRun: 0,
      maxCharsPerSession: 0, maxSweepItems: 0, timeoutMs: 0, excludeChatTypes: ["direct"], workspaceSweepChatTypes: ["channel"],
      extract: true, sweep: true, blockerAutoExpireMinutes: 4320,
      captainsLogDecisionResolve: true, captainsLogResolveChatTypes: ["workspace", "channel"],
      captainsLogResolveMinConfidence: 0.85, captainsLogResolveTimeoutMs: 15_000,
    },
    crystals: {
      enabled: true, intervalMinutes: 360, reclusterMinIntervalMinutes: 720, autoRecluster: true, minClusterSize: 3,
      maxClustersPerRun: 0, maxMembersPerCluster: 12, stmStaleAfterMinutes: 20_160, ltmPromoteMinHelped: 3, ltmPromoteMinHits: 5,
      allowedCorpora: ["memory", "knowledge"], timeoutMs: 0, prioritizeEmotionalSalience: true,
    },
    overnight: {
      enabled: true, intervalMinutes: 720, voltaireEnabled: true, postmortemsEnabled: true, preAnswerEnabled: true, lookbackDays: 30,
      minRecurrence: 2, lookaheadMinutes: 720, maxVoltairePerRun: 5, maxPostmortemsPerRun: 5, maxPreAnswersPerRun: 3,
      minConfidence: "medium", recallChatTypes: ["channel", "group"], saveDerivedObservations: true, writeDailyLogNotes: true,
      dailyLogChatTypes: ["workspace", "channel"], dailyLogCorpora: ["memory", "knowledge"], timeoutMs: 0,
    },
  });
  const overridden = resolveStewardConfig({
    reasoning: "off", endpoint: "http://localhost:123/v1/responses/",
    deepThought: { maxTurns: 40, timeoutMs: 600_000, syncWaitMs: 0, jobRetentionMs: 60_000, reasoning: "low", searchRanking: "decision", searchMinUsefulness: 0.4 },
    peopleShadow: { mode: "shadow", minConfidence: "high", maxItemsPerRun: 5 },
    captainsLog: { intervalMinutes: 60, lookbackMinutes: 70, excludeChatTypes: ["direct", "group"],
      includeEmotionalSalience: false, minSalienceScore: 0.5, minAbsoluteIntensity: 3, minRelativeIntensity: 0 },
  });
  assert.equal(overridden.endpoint, "http://localhost:123/v1/responses");
  assert.equal(overridden.deepThought.maxTurns, 40);
  assert.equal(overridden.deepThought.timeoutMs, 600_000);
  assert.equal(overridden.deepThought.syncWaitMs, 0);
  assert.equal(overridden.deepThought.reasoning, "low");
  assert.equal(overridden.deepThought.searchRanking, "decision");
  assert.equal(overridden.deepThought.searchMinUsefulness, 0.4);
  assert.equal(overridden.peopleShadow.mode, "shadow");
  assert.equal(overridden.peopleShadow.minConfidence, "high");
  assert.deepEqual(overridden.captainsLog.excludeChatTypes, ["direct", "group"]);
  assert.deepEqual([overridden.captainsLog.includeEmotionalSalience, overridden.captainsLog.minSalienceScore,
    overridden.captainsLog.minAbsoluteIntensity, overridden.captainsLog.minRelativeIntensity], [false, 0.5, 3, 0]);
  for (const bad of [null, [], { extra: false }, { deepThought: { extra: 0 } }, { peopleShadow: { other: true } },
    { captainsLog: { extra: true } }, { enabled: null }, { peopleShadow: { enabled: 1 } }, { deepThought: [] }, { model: " " }, { reasoning: "adaptive" },
    { apiKey: "bad key" }, { apiKeyFile: 2 }, { apiKeyFile: "relative/secret.env" }, { apiKeyFile: "./secret.env" }, { maxActiveBackground: 0 },
    { deepThought: { maxTurns: -1 } }, { deepThought: { maxToolCalls: -1 } }, { deepThought: { maxConcurrent: 1.5 } },
    { deepThought: { timeoutMs: -1 } }, { deepThought: { syncWaitMs: -1 } }, { deepThought: { jobRetentionMs: -1 } },
    { deepThought: { wrapUpReserveMs: -1 } }, { deepThought: { reasoning: "adaptive" } }, { deepThought: { maxToolResultChars: -1 } },
    { deepThought: { maxInputTokens: -1 } }, { deepThought: { searchRanking: "other" } }, { deepThought: { searchMinUsefulness: 1.1 } },
    { deepThought: { defaultSearchResults: 0 } }, { deepThought: { maxSnippetChars: -1 } }, { deepThought: { maxQuoteChars: -1 } },
    { deepThought: { maxPeopleMatches: -1 } }, { peopleShadow: { mode: "auto" } }, { peopleShadow: { minConfidence: "sure" } },
    { peopleShadow: { intervalMinutes: 0 } }, { peopleShadow: { maxItemsPerRun: -1 } }, { peopleShadow: { timeoutMs: -1 } },
    { peopleShadow: { maxHandles: -1 } }, { peopleShadow: { maxExcerptChars: -1 } }, { peopleShadow: { maxExportBytes: -1 } },
    { captainsLog: { intervalMinutes: 0 } }, { captainsLog: { lookbackMinutes: 0 } }, { captainsLog: { maxSessionsPerRun: -1 } },
    { captainsLog: { maxCharsPerSession: -1 } }, { captainsLog: { maxExistingLogChars: -1 } }, { captainsLog: { timeoutMs: -1 } },
    { captainsLog: { excludeChatTypes: ["thread"] } }, { captainsLog: { includeEmotionalSalience: "yes" } },
    { captainsLog: { minSalienceScore: 1.1 } }, { captainsLog: { minSalienceScore: -0.1 } },
    { captainsLog: { minAbsoluteIntensity: 3.1 } }, { captainsLog: { minRelativeIntensity: -1 } }]) {
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
  const runner = createStewardRunner({ ...deps, useHostLlm: true, resolveApiKey: () => { throw new Error("direct auth not allowed"); },
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
    const result = await createStewardRunner({ ...deps, useHostLlm: true, hostLlmComplete }).complete({ ...complete, maxRetries: 9 });
    assert.ok(!result.ok);
    assert.equal(result.code, code);
    assert.equal(result.retryable, retryable);
    assert.equal(result.usage.requests, requests);
    assert.equal("costUsd" in result.usage, false);
    if (code === "provider_error") assert.equal(result.usage.outputTokens, 2);
  }
  const result = await createStewardRunner({ ...deps, useHostLlm: true, hostLlmComplete: async () => ({
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
  // submit_result is not a budgeted tool call: five research calls.
  assert.deepEqual(result, { ok: true, status: "complete", summary: "found", data: { answer: "found" }, model: "served", turns: 3, toolCalls: 5,
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
    [401, "unauthorized", "auth_denied"], [403, "forbidden", "auth_denied"], [429, "rate_limit", "transient_provider"]] as const) {
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
  // Exhausting maxTurns/maxToolCalls buys exactly one submit-only wrap-up turn (here the model still does not submit).
  for (const [overrides, responses, requests, count] of [
    [{ maxTurns: 1 }, [collected(read), collected(message("still thinking"))], 2, 1],
    [{ maxToolCalls: 1 }, [collected(read, { ...read, call_id: "read2" }), collected(message("no"))], 2, 0],
    [{ maxInputTokens: 5 }, [collected(read)], 0, 0],
    [{ maxInputTokens: 1000 }, [collected(read)], 1, 1],
  ] as const) {
    const { runner, sent } = scripted(...responses);
    executions = 0;
    const result = await runner.run({ ...req, ...overrides, tools });
    assert.ok(!result.ok && result.code === "budget_exhausted");
    assert.equal(result.usage.requests, requests);
    assert.equal(sent.length, requests);
    assert.equal(executions, count);
  }
  // An overrunning batch is answered (never executed) so the wrap-up input stays a valid call/output transcript.
  const { runner, sent } = scripted(collected(read, { ...read, call_id: "read2" }), collected(message("no")));
  await runner.run({ ...req, maxToolCalls: 1, tools });
  assert.deepEqual(sent[1]!.input.filter(i => i.type === "function_call_output").map(i => [i.call_id, i.output]),
    [["read1", "Error: tool call budget exhausted; not executed."], ["read2", "Error: tool call budget exhausted; not executed."]]);
});

test("budget exhaustion runs one forced submit-only wrap-up turn that keeps the research", async () => {
  const tools = [{ name: "read", description: "read", parameters: schema, execute: async () => "evidence" }];
  for (const overrides of [{ maxTurns: 2 }, { maxToolCalls: 2 }]) {
    const { runner, sent } = scripted(collected(call("read", "r1", { answer: "a" })), collected(call("read", "r2", { answer: "b" })),
      collected(call("submit_result", "wrap", { answer: "best effort", status: "incomplete" })));
    const result = await runner.run({ ...req, ...overrides, tools });
    assert.ok(result.ok, JSON.stringify(overrides));
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.data, { answer: "best effort" });
    assert.equal(result.turns, 3);
    assert.equal(result.toolCalls, 2);
    const wrap = sent[2]!;
    assert.deepEqual(wrap.tools.map(t => t.name), ["submit_result"], "only submit_result is offered");
    assert.deepEqual(wrap.tool_choice, { type: "function", name: "submit_result" });
    assert.match(String(wrap.input.at(-1)?.content), /budget is exhausted/u);
    assert.equal(wrap.input.filter(i => i.type === "function_call_output").length, 2, "gathered evidence is replayed");
  }
});

test("submit_result never counts against maxToolCalls", async () => {
  const { runner, sent } = scripted(collected(call("submit_result", "bad", { answer: 1, status: "complete" })),
    collected(call("submit_result", "good", { answer: "fixed", status: "complete" })));
  const result = await runner.run({ ...req, maxToolCalls: 1 });
  assert.ok(result.ok);
  assert.equal(result.toolCalls, 0);
  assert.equal(sent.length, 2);
});

test("maxInputTokens bounds each request, not the cumulative sum, and retries are never double-charged", async () => {
  const tools = [{ name: "read", description: "read", parameters: schema, execute: async () => "short" }];
  const turns = Array.from({ length: 5 }, (_, i) => collected(call("read", `r${i}`, { answer: "x" })));
  const { runner, sent } = scripted(...turns, collected(submit));
  const perRequest = 2_000;
  const result = await runner.run({ ...req, maxTurns: 8, maxInputTokens: perRequest, tools });
  assert.ok(result.ok, "six requests whose sum exceeds the per-request budget still succeed");
  assert.equal(sent.length, 6);
  // A body just under the limit survives two transient retries of the same request.
  const body = JSON.stringify({ model: config.model, instructions: prompt.systemPrompt, stream: false, store: false,
    reasoning: { effort: "medium" }, input: [{ role: "user", content: prompt.userPrompt }] });
  assert.ok(body.length < perRequest);
  const retried = scripted(Response.json({}, { status: 503, headers: { "Retry-After": "0" } }),
    Response.json({}, { status: 429, headers: { "Retry-After": "0" } }), collected(submit));
  const ok = await retried.runner.run({ ...req, maxInputTokens: 400 });
  assert.ok(ok.ok, "retries resend the same body without spending a second budget");
  assert.equal(ok.usage.requests, 3);
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

test("strict wire schemas: closed objects, every key required, optional keys nullable, validation keywords stripped", () => {
  const isStrict = (node: unknown, path = "$"): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const n = node as Record<string, unknown>;
    for (const key of ["maxLength", "minLength", "pattern", "minimum", "maximum", "minItems", "maxItems", "format",
      "exclusiveMinimum", "exclusiveMaximum"]) assert.equal(key in n, false, `${path} keeps ${key}`);
    assert.ok("type" in n || Array.isArray(n.anyOf), `${path} has a type`);
    if (n.type === "object" || n.properties) {
      assert.equal(n.additionalProperties, false, `${path} is closed`);
      assert.deepEqual([...(n.required as string[])].sort(), Object.keys(n.properties as object).sort(), `${path} requires every key`);
      for (const [k, v] of Object.entries(n.properties as object)) isStrict(v, `${path}.${k}`);
    }
    if (n.items) isStrict(n.items, `${path}[]`);
    for (const branch of (n.anyOf as unknown[] | undefined) ?? []) isStrict(branch, `${path}|`);
  };
  const deep = toStrictJsonSchema(DEEP_THOUGHT_RESULT_SCHEMA);
  const shadow = toStrictJsonSchema(PEOPLE_SHADOW_PROPOSAL_SCHEMA);
  isStrict(deep); isStrict(shadow);
  const citation = (deep.properties as any).citations.items;
  assert.deepEqual(citation.properties.lines, { type: ["string", "null"] }, "optional primitive becomes nullable");
  assert.deepEqual(citation.properties.source, { type: "string" }, "required keys stay non-null; pattern/maxLength stripped");
  assert.deepEqual((deep.properties as any).openQuestions.anyOf[1], { type: "null" }, "optional array becomes anyOf null");
  assert.deepEqual((shadow.properties as any).disposition, { type: "string", enum: ["revalidated", "corrected", "retired", "unresolved"] },
    "bare enums gain a type");
  // The original schemas keep their local validation keywords.
  assert.equal((DEEP_THOUGHT_RESULT_SCHEMA.properties.citations.items.properties.source as { pattern?: string }).pattern, "\\S");
  // Decoding drops the forced nulls on optional keys only.
  const decoded = stripOptionalNulls({ answer: "a", confidence: "low", openQuestions: null,
    citations: [{ source: "s", quote: "q", lines: null, date: "2026" }] }, DEEP_THOUGHT_RESULT_SCHEMA);
  assert.deepEqual(decoded, { answer: "a", confidence: "low", citations: [{ source: "s", quote: "q", date: "2026" }] });
  assert.deepEqual(stripOptionalNulls({ answer: null }, schema), { answer: null }, "a required null is kept (and fails validation)");
  const nullable = { type: "object", properties: { note: { anyOf: [{ type: "string" }, { type: "null" }] } } };
  assert.deepEqual(stripOptionalNulls({ note: null }, nullable), { note: null }, "an original that accepts null keeps it");
});

test("strict schemas reach the wire for complete(), submit_result and tools; nulls on optional keys decode and validate", async () => {
  const optional = { type: "object", properties: { answer: { type: "string", maxLength: 50 }, note: { type: "string" } },
    required: ["answer"], additionalProperties: false };
  const { runner, sent } = scripted(collected(message('{"answer":"yes","note":null}')),
    collected(call("read", "r", { answer: "q", note: null })), collected(call("submit_result", "s", { answer: "done", note: null, status: "complete" })));
  const completed = await runner.complete({ ...prompt, schema: optional });
  assert.ok(completed.ok);
  assert.deepEqual(completed.data, { answer: "yes" });
  assert.deepEqual((sent[0]!.text as any).format.schema, { type: "object", additionalProperties: false, required: ["answer", "note"],
    properties: { answer: { type: "string" }, note: { type: ["string", "null"] } } });
  const received: unknown[] = [];
  const result = await runner.run({ ...req, submitSchema: optional, tools: [{ name: "read", description: "read", parameters: optional,
    execute: async args => { received.push(args); return "ok"; } }] });
  assert.ok(result.ok);
  assert.deepEqual(result.data, { answer: "done" });
  assert.deepEqual(received, [{ answer: "q" }], "tools receive decoded arguments");
  for (const tool of sent[1]!.tools as unknown as Array<{ name: string; strict: boolean; parameters: { required: string[]; additionalProperties: boolean } }>) {
    assert.equal(tool.strict, true, tool.name);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.ok(tool.parameters.required.includes("note"));
  }
});

test("complete() defaults to the direct Responses path even when a host runtime exists; host denial is auth_denied", async () => {
  let hostCalls = 0;
  const host: Host = async () => { hostCalls++; return hostReply('{"answer":"host"}'); };
  const sent: unknown[] = [];
  const direct = await createStewardRunner({ ...deps, hostLlmComplete: host, fetch: async (_url, init) => {
    sent.push(JSON.parse(String(init?.body))); return collected(message('{"answer":"direct"}'));
  } }).complete(complete);
  assert.ok(direct.ok);
  assert.equal(direct.backend, "responses_api");
  assert.equal(hostCalls, 0);
  assert.equal(sent.length, 1);
  for (const denial of [Object.assign(new Error("denied"), { code: "LLM_COMPLETION_NOT_AUTHORIZED" }),
    new Error("LLM_COMPLETION_NOT_AUTHORIZED: plugin model override not allowed")]) {
    const denied = await createStewardRunner({ ...deps, useHostLlm: true, hostLlmComplete: async () => { throw denial; } }).complete(complete);
    assert.ok(!denied.ok);
    assert.equal(denied.code, "auth_denied");
    assert.equal(denied.retryable, false);
  }
});

test("complete() retries transient 408/429/5xx and connection resets, never 400/401/403 or context overflow", async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const { runner, sent } = scripted(Response.json({}, { status, headers: { "Retry-After": "0" } }), collected(message('{"answer":"ok"}')));
    const result = await runner.complete(complete);
    assert.ok(result.ok, `HTTP ${status} retried`);
    assert.equal(result.usage.requests, 2);
    assert.equal(sent.length, 2);
  }
  let resets = 0;
  const reset = await createStewardRunner({ ...deps, fetch: async () => {
    if (resets++ < 2) throw new TypeError("ECONNRESET");
    return collected(message('{"answer":"ok"}'));
  } }).complete(complete);
  assert.ok(reset.ok);
  assert.equal(reset.usage.requests, 3);
  const exhausted = scripted(...Array.from({ length: 3 }, () => Response.json({}, { status: 502, headers: { "Retry-After": "0" } })));
  const gaveUp = await exhausted.runner.complete(complete);
  assert.ok(!gaveUp.ok && gaveUp.code === "transient_provider" && gaveUp.retryable);
  assert.equal(exhausted.sent.length, 3, "retries are bounded");
  for (const [status, code] of [[400, "bad"], [401, "x"], [403, "x"], [500, "context_length_exceeded"]] as const) {
    const { runner, sent } = scripted(Response.json({ error: { code } }, { status }));
    const result = await runner.complete(complete);
    assert.ok(!result.ok);
    assert.equal(sent.length, 1, `HTTP ${status} ${code} is not retried`);
  }
});

test("outbound user prompts are redacted for complete() and run()", async () => {
  const secretPrompt = { ...prompt, userPrompt: `Use ${token} or Bearer abc.def and sk-live-123 xoxb-1-2 please` };
  const { runner, sent } = scripted(collected(message('{"answer":"ok"}')), collected(submit));
  await runner.complete({ ...secretPrompt, schema });
  await runner.run({ ...req, ...secretPrompt });
  for (const wire of sent) {
    const text = JSON.stringify(wire.input[0]);
    assert.doesNotMatch(text, /private-test-credential|abc\.def|sk-live|xoxb-/u);
    assert.match(text, /\[redacted\]/u);
  }
});

test("parallel tool fan-out runs concurrently in one turn and preserves call order", async () => {
  let inFlight = 0, peak = 0;
  let releaseBoth!: () => void;
  const bothStarted = new Promise<void>(resolve => { releaseBoth = resolve; });
  const tools = [{
    name: "probe",
    description: "probe",
    parameters: schema,
    execute: async (args: Record<string, unknown>) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (inFlight === 2) releaseBoth();
      await bothStarted;
      inFlight -= 1;
      return `res:${args.answer}`;
    },
  }];
  const { runner, sent } = scripted(
    collected(call("probe", "c1", { answer: "first" }), call("probe", "c2", { answer: "second" })),
    collected(submit),
  );
  const result = await runner.run({ ...req, maxTurns: 0, maxToolCalls: 0, wallTimeoutMs: 0, maxInputTokens: 0, maxToolResultChars: 0, tools });
  assert.ok(result.ok);
  assert.equal(peak, 2, "both tool calls ran concurrently");
  const outputs = sent[1]!.input.filter(i => i.type === "function_call_output");
  assert.deepEqual(outputs.map(i => [i.call_id, i.output]), [["c1", "res:first"], ["c2", "res:second"]]);
});

test("wrapUpReserveMs forces submit_result before a finite wall timeout discards gathered research", async () => {
  const tools = [{
    name: "slow_read",
    description: "slow read",
    parameters: schema,
    execute: async () => {
      await new Promise(resolve => setTimeout(resolve, 35));
      return "important evidence";
    },
  }];
  const { runner, sent } = scripted(
    collected(call("slow_read", "s1", { answer: "q" })),
    collected(call("submit_result", "wrap", { answer: "preserved before deadline", status: "incomplete" })),
  );
  const result = await runner.run({ ...req, wallTimeoutMs: 250, wrapUpReserveMs: 225, tools });
  assert.ok(result.ok, "soft deadline reserve triggers wrap-up instead of throwing away work");
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.data, { answer: "preserved before deadline" });
  assert.deepEqual(sent[1]!.tools.map(t => t.name), ["submit_result"]);
  assert.deepEqual(sent[1]!.tool_choice, { type: "function", name: "submit_result" });
});
