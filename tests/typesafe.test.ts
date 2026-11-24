import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { judgeMemoryPassage, judgeTypeSafeQuality, selectTypeSafeSkill, memoryUsefulnessRequest, MEMORY_JUDGE_VERSION } from "../src/typesafe.js";
import { contextJudgeRequest, judgeTrainingPassage, CONTEXT_JUDGE_VERSION } from "../src/training-judge.js";
import { decisionModelScope, matchesDecisionModel, requestTypeSafe, resolveTypeSafeApiKey } from "../src/typesafe-client.js";

const config = { enabled: true, timeoutMs: 100 };

test("quality judgments keep evidence and noise independent and validate exact answers", async t => {
  const params = { apiKey: "fake", timeoutMs: 100, signal: new AbortController().signal,
    chunks: [{ text: "serialized content", sourceKind: "files" as const }] };
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(init?.redirect, "error");
    assert.match(request.questions.noise_0.instructions.scope, /chunks\[0\]/);
    assert.match(request.questions.evidence_0.instructions.scope, /chunks\[0\]/);
    assert.equal(typeof request.questions.noise_0.criteria.true.definition, "string");
    assert.ok(Array.isArray(request.questions.noise_0.criteria.false.exclusions));
    assert.deepEqual(Object.keys(request.state[0]), ["chunks"]);
    return Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { noise_0: { type: "noul", noul: 0.96 }, evidence_0: { type: "noul", noul: 0.97 } } });
  });
  assert.deepEqual(await judgeTypeSafeQuality(params), [{ noise: 0.96, evidence: 0.97 }]);
  for (const answers of [{}, { noise_0: { type: "noul", noul: 0.95 } },
    { noise_0: { type: "noul", noul: 2 }, evidence_0: { type: "noul", noul: 0.97 } },
    { noise_0: { type: "noul", noul: 0.95 }, evidence_0: { type: "score", noul: 0.97 } }]) {
    fetch.mock.mockImplementation(async () => Response.json({ answers }));
    await assert.rejects(judgeTypeSafeQuality(params), { code: "invalid_response" });
  }
});
const selection = {
  apiKey: "test-secret", timeoutMs: 100,
  currentRequest: "Deploy this project", history: [],
  candidates: [{ name: "none", description: "Deploy software releases." }],
};
const response = (noul: number) => Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { useful: { type: "noul", noul } } });

test("credentials strictly isolate Codex LB, legacy TypeSafe, and custom endpoints without cross-provider fallback", async (t) => {
  const previousTypeSafe = process.env.TYPESAFE_API_KEY;
  const previousCodex = process.env.CODEX_LB_API_KEY;
  process.env.TYPESAFE_API_KEY = "typesafe-env-key";
  delete process.env.CODEX_LB_API_KEY;
  t.after(() => {
    if (previousTypeSafe === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousTypeSafe;
    if (previousCodex === undefined) delete process.env.CODEX_LB_API_KEY;
    else process.env.CODEX_LB_API_KEY = previousCodex;
  });
  const dir = await mkdtemp(join(tmpdir(), "unblock-typesafe-key-"));
  const apiKeyFile = join(dir, "key");
  const legacy = { ...config, endpoint: "https://api.typesafe.ai/v1/systemone" };
  const custom = { ...config, endpoint: "https://other.example/v1/decisions" };
  const loopback = { ...config, endpoint: "http://127.0.0.1:8787/v1/decisions" };

  assert.equal(await resolveTypeSafeApiKey({ ...config, enabled: false, apiKeyFile: dir }), undefined);
  // Default Codex LB endpoint never inherits TYPESAFE_API_KEY.
  assert.equal(await resolveTypeSafeApiKey(config), undefined);
  assert.equal(await resolveTypeSafeApiKey(legacy), "typesafe-env-key");
  process.env.CODEX_LB_API_KEY = "codex-env-key";
  assert.equal(await resolveTypeSafeApiKey(config), "codex-env-key");
  assert.equal(await resolveTypeSafeApiKey(legacy), "typesafe-env-key");
  // Custom origins and loopback HTTP never inherit ambient env keys.
  assert.equal(await resolveTypeSafeApiKey(custom), undefined);
  assert.equal(await resolveTypeSafeApiKey(loopback), undefined);
  assert.equal(await resolveTypeSafeApiKey({ ...config, endpoint: "http://api.typesafe.ai/v1/systemone" }), undefined);
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKey: " explicit-key " }), "explicit-key");
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), undefined);
  await writeFile(apiKeyFile, "plain-key\n", { mode: 0o600 });
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), "plain-key");
  assert.equal(await resolveTypeSafeApiKey({ ...custom, apiKeyFile }), "plain-key");
  // Dotenv files are strictly isolated by provider.
  await writeFile(apiKeyFile, '# legacy key\nexport TYPESAFE_API_KEY="dotenv-key"\nOTHER=value\n');
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), undefined);
  assert.equal(await resolveTypeSafeApiKey({ ...legacy, apiKeyFile }), "dotenv-key");
  await writeFile(apiKeyFile, 'CODEX_LB_API_KEY="codex-dotenv-key"\nTYPESAFE_API_KEY="dotenv-key"\n');
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), "codex-dotenv-key");
  assert.equal(await resolveTypeSafeApiKey({ ...legacy, apiKeyFile }), "dotenv-key");
  assert.equal(await resolveTypeSafeApiKey({ ...custom, apiKeyFile }), "codex-dotenv-key");
  assert.equal(process.env.TYPESAFE_API_KEY, "typesafe-env-key");
  await writeFile(apiKeyFile, "OTHER=value\n");
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), undefined);
  await writeFile(apiKeyFile, "CODEX_LB_API_KEY=\nTYPESAFE_API_KEY=\n");
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), undefined);
  await writeFile(apiKeyFile, "  \n");
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), undefined);
  await assert.rejects(resolveTypeSafeApiKey({ ...config, apiKeyFile: dir }), /credential file could not be read/);
  delete process.env.CODEX_LB_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(await resolveTypeSafeApiKey(config), undefined);
  assert.equal(await resolveTypeSafeApiKey(legacy), undefined);
});

test("selection scores one skill, uses default codex decisions endpoint/model with array state, and abstains below threshold", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
    calls++;
    assert.equal(url, "https://codex.unblocklabs.ai/v1/decisions");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, { Authorization: "Bearer test-secret", "Content-Type": "application/json" });
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, "liquid/d1.2-ultra");
    assert.ok(Array.isArray(request.state) && request.state.length === 1);
    assert.equal(request.state[0].currentRequest, "Deploy this project");
    assert.deepEqual(request.state[0].candidate, { name: "none", description: "Deploy software releases." });
    assert.equal(typeof request.questions.useful.instructions.question, "string");
    assert.equal(request.questions.useful.type, "noul");
    return response(calls === 1 ? 0.9 : 0.1);
  });
  assert.equal(await selectTypeSafeSkill(selection), 0);
  assert.equal(await selectTypeSafeSkill(selection), undefined);
  assert.equal(await selectTypeSafeSkill({ ...selection, candidates: [] }), undefined);
  assert.equal(calls, 2);
});

test("legacy TypeSafe systemone endpoint override infers jev-1.13.0, sends bare object state, and validates requested model", async (t) => {
  t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, "jev-1.13.0");
    assert.equal(Array.isArray(request.state), false);
    assert.equal(request.state.candidates[0].excerpt, "Alpha requires approval");
    return Response.json({ model: "jev-1.13.0", answers: { memory_0: { type: "noul", noul: 0.91 } } });
  });
  const req = memoryUsefulnessRequest(memoryJudgment.conversation, memoryJudgment.candidates[0]!, memoryJudgment.asOf);
  const res = await judgeMemoryPassage(req, {
    ...memoryJudgment,
    endpoint: "https://api.typesafe.ai/v1/systemone",
  });
  assert.equal(res.probability, 0.91);
  assert.equal(res.model, "jev-1.13.0");
});

test("model matching restricts suffixes to dated snapshots or jev-latest, scope isolates custom endpoints, and 503 Retry-After is flagged", async (t) => {
  assert.equal(matchesDecisionModel("liquid/d1.2-ultra", "liquid/d1.2-ultra"), true);
  assert.equal(matchesDecisionModel("liquid/d1.2-ultra-20261116", "liquid/d1.2-ultra"), true);
  assert.equal(matchesDecisionModel("liquid/d1.2-ultra-2026-11-16", "liquid/d1.2-ultra"), true);
  assert.equal(matchesDecisionModel("jev-1.14.0", "jev-latest"), true);
  for (const bad of ["liquid/d1.2-ultra-mini", "liquid/d1.2-ultra-free", "liquid/d1.2-ultra-", "liquid/d1.2-ultra2", "jev-1.13.0", "", 42]) {
    assert.equal(matchesDecisionModel(bad, "liquid/d1.2-ultra"), false, String(bad));
  }
  assert.equal(decisionModelScope("liquid/d1.2-ultra", "https://codex.unblocklabs.ai/v1/decisions"), "liquid/d1.2-ultra");
  assert.equal(decisionModelScope("jev-1.13.0", "https://api.typesafe.ai/v1/systemone"), "jev-1.13.0");
  assert.equal(decisionModelScope("liquid/d1.2-ultra", "https://openrouter.ai/api/alpha/decisions"),
    "liquid/d1.2-ultra@https://openrouter.ai/api/alpha/decisions");
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    new Response("busy", { status: 503, headers: { "Retry-After": "2" } }));
  await assert.rejects(requestTypeSafe({ apiKey: "fake" }, {}, {}), { code: "http_error", status: 503, retryAfter: true });
  await assert.rejects(requestTypeSafe({ apiKey: "fake", endpoint: "https://api.typesafe.ai/v1/systemone" }, {}, {}),
    { code: "http_error", status: 503, retryAfter: false });
  await assert.rejects(requestTypeSafe({ apiKey: "fake", endpoint: "https://custom.example/v1/decisions" }, {}, {}),
    { code: "http_error", status: 503, retryAfter: false });
  fetch.mock.mockImplementation(async () => new Response("busy", { status: 503 }));
  await assert.rejects(requestTypeSafe({ apiKey: "fake" }, {}, {}), { code: "http_error", status: 503, retryAfter: false });
});

test("HTTP and schema errors never expose provider content or retry", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("test-secret", { status: 529 }));
  await assert.rejects(selectTypeSafeSkill(selection), { message: "Decision model HTTP 529", code: "http_error", status: 529 });
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => response(2));
  await assert.rejects(selectTypeSafeSkill(selection), { code: "invalid_response" });
  fetch.mock.mockImplementation(async () => Response.json({ secret: "test-secret" }));
  await assert.rejects(selectTypeSafeSkill(selection), { code: "invalid_response" });
  fetch.mock.mockImplementation(async () => { throw new Error("test-secret network detail"); });
  await assert.rejects(selectTypeSafeSkill(selection), { message: "Decision model request failed", code: "network_error" });
});

test("the request deadline aborts slow fetches", async (t) => {
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => new Promise<Response>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deadline did not abort")), 1000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("secret-bearing transport error"));
    }, { once: true });
  }));
  await assert.rejects(selectTypeSafeSkill({ ...selection, timeoutMs: 20 }), { message: "Decision model request timed out", code: "timeout" });
});

const memoryJudgment = {
  apiKey: "test-secret", timeoutMs: 100, signal: new AbortController().signal,
  conversation: { currentRequest: "Deploy alpha", history: [] }, asOf: "2026-09-28T00:00:00Z",
  candidates: [{ excerpt: "Alpha requires approval", corpus: "knowledge", sourcePath: "qmd://knowledge/alpha.md", dates: [] }],
};
const judgeMemory = (params = memoryJudgment) =>
  judgeMemoryPassage(memoryUsefulnessRequest(params.conversation, params.candidates[0]!, params.asOf), params);

test("memory judgments use Noul probabilities, accept dated Liquid snapshots, and reject mismatched models or invalid answers", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
    assert.equal(url, "https://codex.unblocklabs.ai/v1/decisions");
    assert.equal(init?.redirect, "error");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, "liquid/d1.2-ultra");
    assert.equal(request.questions.memory_0.type, "noul");
    assert.match(JSON.stringify(request.questions.memory_0.instructions), /conversation\.currentRequest/);
    assert.equal(request.state[0].candidates[0].excerpt, "Alpha requires approval");
    return Response.json({
      model: "liquid/d1.2-ultra-20261116",
      usage: { input_tokens: 42, output_tokens: 0, cost: 0.0000018 },
      answers: { memory_0: { type: "noul", noul: 0.97 } },
    });
  });
  const result = await judgeMemory();
  assert.equal(result.probability, 0.97);
  assert.equal(result.model, "liquid/d1.2-ultra-20261116");
  assert.deepEqual(result.usage, { input_tokens: 42, output_tokens: 0 }, "extra provider fields are projected out");
  assert.deepEqual(result.answer, { type: "noul", noul: 0.97 });
  assert.equal(fetch.mock.callCount(), 1);
  for (const badModel of ["jev-1.13.0", "liquid/d1.2-ultra-mini", "liquid/d1.2-ultra-", "liquid/d1.2-ultra2", ""]) {
    fetch.mock.mockImplementation(async () => Response.json({ model: badModel, answers: { memory_0: { type: "noul", noul: 0.9 } } }));
    await assert.rejects(judgeMemory(), /invalid memory judgments/);
  }
  for (const answers of [{}, { unknown: { type: "noul", noul: 0.99 } },
    { memory_0: { type: "score", noul: 0.99 } }, { memory_0: { type: "noul", noul: "0.99" } },
    { memory_0: { type: "noul", noul: 1.1 } }, { memory_0: { type: "noul", noul: -0.1 } },
    { memory_0: { type: "noul", noul: 0.9 }, memory_1: { type: "noul", noul: 0.99 } }]) {
    fetch.mock.mockImplementation(async () => Response.json({ model: "liquid/d1.2-ultra-20261116", answers }));
    await assert.rejects(judgeMemory(), /invalid memory judgments/);
  }
});

test("memory requests sanitize failures, do not retry, and honor the provider deadline", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("test-secret", { status: 529 }));
  await assert.rejects(judgeMemory(), { message: "Decision model HTTP 529", code: "http_error", status: 529 });
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async (...[_url, init]: Parameters<typeof globalThis.fetch>) => new Promise<Response>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("did not abort")), 1000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("private transport detail"));
    }, { once: true });
  }));
  await assert.rejects(judgeMemory({ ...memoryJudgment, timeoutMs: 20 }), { message: "Decision model request timed out", code: "timeout" });
});

test("shared transport preserves caller errors for HTTP, cancellation and invalid JSON failures", async t => {
  const params = { apiKey: "test-secret", timeoutMs: 100, signal: new AbortController().signal };
  const callers = [
    { request: () => selectTypeSafeSkill(selection), error: "Decision model HTTP 529", status: true },
    { request: () => judgeMemory(), error: "Decision model HTTP 529", status: true },
    { request: () => judgeTypeSafeQuality({ ...params, chunks: [{ text: "fact", sourceKind: "files" }] }),
      error: "Decision model HTTP 529", status: true },
    { request: () => requestTypeSafe(params, {}, {}), error: "Decision model HTTP 529", status: true },
  ];
  const fetch = t.mock.method(globalThis, "fetch");
  for (const caller of callers) {
    for (const cancellationFails of [false, true]) {
      let cancelled = false;
      fetch.mock.mockImplementation(async () => new Response(new ReadableStream({
        cancel() {
          cancelled = true;
          if (cancellationFails) throw new Error("test-secret cancellation detail");
        },
      }), { status: 529 }));
      await assert.rejects(caller.request(), { message: caller.error });
      assert.equal(cancelled, true);
    }
    fetch.mock.mockImplementation(async () => new Response("test-secret invalid JSON"));
    await assert.rejects(caller.request(), { message: "Decision model returned invalid JSON", code: "invalid_response" });
  }
  assert.equal(fetch.mock.callCount(), callers.length * 3);
});

test("caller cancellation preserves quality, memory and review abort errors", async t => {
  const params = { apiKey: "test-secret", timeoutMs: 100, signal: AbortSignal.abort("private reason") };
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    init?.signal?.throwIfAborted();
    throw new Error("caller signal was not propagated");
  });
  await assert.rejects(judgeTypeSafeQuality({ ...params, chunks: [{ text: "fact", sourceKind: "files" }] }),
    { message: "Decision model request cancelled", code: "cancelled" });
  await assert.rejects(judgeMemory({ ...memoryJudgment, signal: params.signal }),
    { message: "Decision model request cancelled", code: "cancelled" });
  assert.equal(fetch.mock.callCount(), 0, "already-aborted requests never reach fetch");
  await assert.rejects(requestTypeSafe(params, {}, {}), { message: "Decision model request cancelled", code: "cancelled" });
  assert.equal(fetch.mock.callCount(), 0, "review must abort before fetch");
});

test("client distinguishes timeout, first caller cancellation, and body-read failure", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) =>
    new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("abort not delivered")), 1000);
      init?.signal?.addEventListener("abort", () => { clearTimeout(keepAlive); reject(new Error("private")); }, { once: true });
    }));
  await assert.rejects(requestTypeSafe({ apiKey: "private", signal: AbortSignal.timeout(10) }, {}, {}),
    { code: "timeout", message: "Decision model request timed out" });
  const controller = new AbortController();
  const cancelled = requestTypeSafe({ apiKey: "private", signal: controller.signal, timeoutMs: 20 }, {}, {});
  await new Promise(resolve => setImmediate(resolve));
  controller.abort("private reason");
  await assert.rejects(cancelled, { code: "cancelled", message: "Decision model request cancelled" });
  assert.equal(fetch.mock.callCount(), 2);
  fetch.mock.mockImplementation(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("private body detail")); },
  })));
  await assert.rejects(requestTypeSafe({ apiKey: "private" }, {}, {}),
    { code: "network_error", message: "Decision model request failed" });
});

test("quality helper isolates requests and keeps scores aligned despite reversed completion", { timeout: 2000 }, async t => {
  const pending: { body: { state: [{ chunks: { text: string }[] }] };
    resolve: (response: Response) => void }[] = [];
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => new Promise<Response>(resolve => {
    pending.push({ body: JSON.parse(String(init?.body)), resolve });
  }));
  const quality = judgeTypeSafeQuality({ apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal,
    chunks: [{ text: "first", sourceKind: "files" }, { text: "second", sourceKind: "sessions" }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2, "both requests start before either completes");
  assert.deepEqual(pending.map(p => p.body.state[0].chunks.map(c => c.text)), [["first"], ["second"]]);
  pending[1].resolve(Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { noise_0: { type: "noul", noul: 0.8 }, evidence_0: { type: "noul", noul: 0.7 } } }));
  pending[0].resolve(Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { noise_0: { type: "noul", noul: 0.1 }, evidence_0: { type: "noul", noul: 0.9 } } }));
  assert.deepEqual(await quality, [{ noise: 0.1, evidence: 0.9 }, { noise: 0.8, evidence: 0.7 }]);
});

test("skill reranking isolates candidates, preserves successes, and breaks ties in retrieval order", async t => {
  let mode = "partial";
  const failures: number[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    const [state] = request.state;
    assert.deepEqual(Object.keys(state).sort(), ["candidate", "currentRequest", "history"]);
    assert.deepEqual(Object.keys(request.questions), ["useful"]);
    if (state.candidate.name === "bad" && mode === "partial") return new Response("secret", { status: 403 });
    return response(mode === "none" ? 0.69 : 0.8);
  });
  const params = { ...selection, candidates: ["bad", "good", "tie"].map(name => ({ name, description: "test" })),
    onCandidateFailure: (i: number) => { failures.push(i); } };
  assert.equal(await selectTypeSafeSkill(params), 1);
  assert.deepEqual(failures, [0]);
  mode = "ties";
  assert.equal(await selectTypeSafeSkill(params), 0);
  mode = "none";
  assert.equal(await selectTypeSafeSkill(params), undefined);
  assert.equal(fetch.mock.callCount(), 9);
});

test("offline and runtime use exactly the same blind request and retain raw probabilities and usage", async t => {
  const candidate = memoryJudgment.candidates[0]!;
  const hit = { path: candidate.sourcePath, text: candidate.excerpt, corpus: candidate.corpus, dates: [],
    position: 17, startLine: 1, endLine: 1, score: 0.99, methods: ["bm25"], query: "forbidden generated query" };
  const offline = contextJudgeRequest(memoryJudgment.conversation, memoryJudgment.asOf, hit);
  const runtime = memoryUsefulnessRequest(memoryJudgment.conversation, candidate, memoryJudgment.asOf);
  assert.deepEqual(offline, runtime);
  assert.equal(CONTEXT_JUDGE_VERSION, MEMORY_JUDGE_VERSION);
  assert.doesNotMatch(JSON.stringify(offline), /forbidden|position|methods|bm25|"score"/);
  const requests: unknown[] = [];
  const usage = { input_tokens: 117, output_tokens: 0 };
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ model: "liquid/d1.2-ultra-20261116", usage, answers: { memory_0: { type: "noul", noul: 0.831 } } });
  });
  assert.equal((await judgeMemory()).probability, 0.831);
  assert.deepEqual(await judgeTrainingPassage(offline, "key"), {
    probability: 0.831, answer: { type: "noul", noul: 0.831 }, model: "liquid/d1.2-ultra-20261116", usage,
  });
  assert.deepEqual(requests, [
    { ...runtime, state: [runtime.state] },
    { ...offline, state: [offline.state] },
  ]);
});
