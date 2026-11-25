import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LEGACY_SYSTEMONE_ENDPOINT } from "@unblocklabs/decisions";
import { judgeMemoryPassage, judgeQuality, scoreSkillCatalog, memoryUsefulnessRequest, MEMORY_JUDGE_VERSION } from "../src/decision-ranking.js";
import { contextJudgeRequest, judgeTrainingPassage, CONTEXT_JUDGE_VERSION } from "../src/training-judge.js";
import { decisionModelScope, matchesDecisionModel, requestDecision, resolveDecisionCredential } from "../src/decision-client.js";

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
  assert.deepEqual(await judgeQuality(params), [{ noise: 0.96, evidence: 0.97 }]);
  for (const answers of [{}, { noise_0: { type: "noul", noul: 0.95 } },
    { noise_0: { type: "noul", noul: 2 }, evidence_0: { type: "noul", noul: 0.97 } },
    { noise_0: { type: "noul", noul: 0.95 }, evidence_0: { type: "score", noul: 0.97 } }]) {
    fetch.mock.mockImplementation(async () => Response.json({ answers }));
    await assert.rejects(judgeQuality(params), { code: "invalid_response" });
  }
});
const skillCatalog = {
  apiKey: "test-secret", timeoutMs: 100,
  currentRequest: "Deploy this project",
  history: [{ role: "assistant", content: "The release is ready for staging." }] as const,
  candidates: [{ name: "release", description: "Deploy software releases." }],
};
const skills = (count: number) => Array.from({ length: count }, (_, index) => ({
  name: `skill-${index}`, description: `Workflow ${index}`, path: `/private/skill-${index}/SKILL.md`,
}));
const skillAnswers = (count: number, scores: Record<number, number>) => Object.fromEntries(
  Array.from({ length: count }, (_, index) => [`s_${index}`, { type: "noul", noul: scores[index] ?? 0.1 }]),
);
const skillResponse = (answers: unknown) => Response.json({ model: "liquid/d1.2-ultra-20261116", answers });

test("credentials ignore obsolete keys and do not send ambient Codex credentials to custom endpoints", async (t) => {
  const previousLegacy = process.env.TYPESAFE_API_KEY;
  const previousCodex = process.env.CODEX_LB_API_KEY;
  process.env.TYPESAFE_API_KEY = "obsolete-env-key";
  delete process.env.CODEX_LB_API_KEY;
  t.after(() => {
    if (previousLegacy === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousLegacy;
    if (previousCodex === undefined) delete process.env.CODEX_LB_API_KEY;
    else process.env.CODEX_LB_API_KEY = previousCodex;
  });
  const dir = await mkdtemp(join(tmpdir(), "unblock-decision-key-"));
  t.after(() => rm(dir, { recursive: true }));
  const apiKeyFile = join(dir, "key");
  const legacy = { ...config, endpoint: LEGACY_SYSTEMONE_ENDPOINT };
  const custom = { ...config, endpoint: "https://other.example/v1/decisions" };
  const loopback = { ...config, endpoint: "http://127.0.0.1:8787/v1/decisions" };

  assert.equal(await resolveDecisionCredential({ ...config, enabled: false, apiKeyFile: dir }), undefined);
  assert.equal(await resolveDecisionCredential(config), undefined);
  assert.equal(await resolveDecisionCredential(legacy), undefined);
  process.env.CODEX_LB_API_KEY = "codex-env-key";
  assert.equal(await resolveDecisionCredential(config), "codex-env-key");
  assert.equal(await resolveDecisionCredential(legacy), undefined);
  // Custom origins and loopback HTTP never inherit ambient env keys.
  assert.equal(await resolveDecisionCredential(custom), undefined);
  assert.equal(await resolveDecisionCredential(loopback), undefined);
  await assert.rejects(resolveDecisionCredential({ ...config, endpoint: "http://other.example/v1/decisions" }),
    { code: "invalid_config" });
  assert.equal(await resolveDecisionCredential({ ...config, apiKey: " explicit-key " }), "explicit-key");
  assert.equal(await resolveDecisionCredential({ ...config, apiKeyFile }), undefined);
  await writeFile(apiKeyFile, "plain-key\n", { mode: 0o600 });
  assert.equal(await resolveDecisionCredential({ ...config, apiKeyFile }), "plain-key");
  assert.equal(await resolveDecisionCredential({ ...custom, apiKeyFile }), "plain-key");
  await writeFile(apiKeyFile, '# legacy key\nexport TYPESAFE_API_KEY="dotenv-key"\nOTHER=value\n');
  assert.equal(await resolveDecisionCredential({ ...config, apiKeyFile }), undefined);
  assert.equal(await resolveDecisionCredential({ ...legacy, apiKeyFile }), undefined);
  await writeFile(apiKeyFile, 'CODEX_LB_API_KEY="codex-dotenv-key"\n');
  assert.equal(await resolveDecisionCredential({ ...config, apiKeyFile }), "codex-dotenv-key");
  assert.equal(await resolveDecisionCredential({ ...custom, apiKeyFile }), "codex-dotenv-key");
  await writeFile(apiKeyFile, "DECISION_MODEL_API_KEY=custom-dotenv-key\n");
  assert.equal(await resolveDecisionCredential({ ...custom, apiKeyFile }), "custom-dotenv-key");
  await writeFile(apiKeyFile, "OTHER=value\n");
  assert.equal(await resolveDecisionCredential({ ...config, apiKeyFile }), undefined);
  await writeFile(apiKeyFile, "CODEX_LB_API_KEY=\n");
  assert.equal(await resolveDecisionCredential({ ...config, apiKeyFile }), undefined);
  await writeFile(apiKeyFile, "  \n");
  assert.equal(await resolveDecisionCredential({ ...config, apiKeyFile }), undefined);
  await assert.rejects(resolveDecisionCredential({ ...config, apiKeyFile: dir }), /credential file could not be read/);
  delete process.env.CODEX_LB_API_KEY;
  assert.equal(await resolveDecisionCredential(config), undefined);
  assert.equal(await resolveDecisionCredential(legacy), undefined);
});

test("79 or 80 skills share one default decision request, with ranked and capped matches", async (t) => {
  const catalog = skills(80);
  const fetch = t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
    assert.equal(url, "https://codex.unblocklabs.ai/v1/decisions");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, { Authorization: "Bearer test-secret", "Content-Type": "application/json" });
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, "liquid/d1.2-ultra");
    const count = request.state[0].skills.length;
    const expected = catalog.slice(0, count).map(({ name, description }, index) => ({ id: `s_${index}`, name, description }));
    assert.deepEqual(request.state, [{ currentRequest: skillCatalog.currentRequest, history: skillCatalog.history, skills: expected }]);
    assert.deepEqual(Object.keys(request.questions), expected.map(skill => skill.id));
    for (const { id } of expected) {
      const question = request.questions[id];
      assert.equal(question.type, "noul");
      assert.ok(JSON.stringify(question.instructions).includes(id));
    }
    const scores = { 0: 0.69, 1: 0.7, 2: 0.79, 20: 0.9, 78: 0.79 };
    return skillResponse(skillAnswers(count, count === 79 ? scores : { ...scores, 40: 0.8, 79: 0.95 }));
  });
  const tied = [{ index: 2, score: 0.79 }, { index: 78, score: 0.79 }];
  assert.deepEqual(await scoreSkillCatalog({ ...skillCatalog, candidates: catalog.slice(0, 79) }),
    [{ index: 20, score: 0.9 }, ...tied, { index: 1, score: 0.7 }]);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await scoreSkillCatalog({ ...skillCatalog, candidates: catalog }),
    [{ index: 79, score: 0.95 }, { index: 20, score: 0.9 }, { index: 40, score: 0.8 }, ...tied]);
  assert.deepEqual(await scoreSkillCatalog({ ...skillCatalog, candidates: [] }), []);
  assert.equal(fetch.mock.callCount(), 2);
});

test("the original route no longer implicitly requests its historical model", async (t) => {
  t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
    assert.equal(url, LEGACY_SYSTEMONE_ENDPOINT);
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, "liquid/d1.2-ultra");
    assert.equal(Array.isArray(request.state), false);
    assert.equal(request.state.candidates[0].excerpt, "Alpha requires approval");
    return Response.json({ model: "liquid/d1.2-ultra", answers: { memory_0: { type: "noul", noul: 0.91 } } });
  });
  const req = memoryUsefulnessRequest(memoryJudgment.conversation, memoryJudgment.candidates[0]!, memoryJudgment.asOf);
  const res = await judgeMemoryPassage(req, {
    ...memoryJudgment,
    endpoint: LEGACY_SYSTEMONE_ENDPOINT,
  });
  assert.equal(res.probability, 0.91);
  assert.equal(res.model, "liquid/d1.2-ultra");
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
  assert.equal(decisionModelScope("jev-1.13.0", LEGACY_SYSTEMONE_ENDPOINT), "jev-1.13.0");
  assert.equal(decisionModelScope("liquid/d1.2-ultra", "https://openrouter.ai/api/alpha/decisions"),
    "liquid/d1.2-ultra@https://openrouter.ai/api/alpha/decisions");
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    new Response("busy", { status: 503, headers: { "Retry-After": "2" } }));
  await assert.rejects(requestDecision({ apiKey: "fake" }, {}, {}), { code: "http_error", status: 503, retryAfter: true });
  await assert.rejects(requestDecision({ apiKey: "fake", endpoint: "https://custom.example/v1/decisions" }, {}, {}),
    { code: "http_error", status: 503, retryAfter: false });
  fetch.mock.mockImplementation(async () => new Response("busy", { status: 503 }));
  await assert.rejects(requestDecision({ apiKey: "fake" }, {}, {}), { code: "http_error", status: 503, retryAfter: false });
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
    { request: () => scoreSkillCatalog(skillCatalog), error: "Decision model HTTP 529", status: true },
    { request: () => judgeMemory(), error: "Decision model HTTP 529", status: true },
    { request: () => judgeQuality({ ...params, chunks: [{ text: "fact", sourceKind: "files" }] }),
      error: "Decision model HTTP 529", status: true },
    { request: () => requestDecision(params, {}, {}), error: "Decision model HTTP 529", status: true },
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
  await assert.rejects(judgeQuality({ ...params, chunks: [{ text: "fact", sourceKind: "files" }] }),
    { message: "Decision model request cancelled", code: "cancelled" });
  await assert.rejects(judgeMemory({ ...memoryJudgment, signal: params.signal }),
    { message: "Decision model request cancelled", code: "cancelled" });
  assert.equal(fetch.mock.callCount(), 0, "already-aborted requests never reach fetch");
  await assert.rejects(requestDecision(params, {}, {}), { message: "Decision model request cancelled", code: "cancelled" });
  assert.equal(fetch.mock.callCount(), 0, "review must abort before fetch");
});

test("client distinguishes timeout and caller cancellation from transport and body-read failures", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) =>
    new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("abort not delivered")), 1000);
      init?.signal?.addEventListener("abort", () => { clearTimeout(keepAlive); reject(new Error("private")); }, { once: true });
    }));
  await assert.rejects(requestDecision({ apiKey: "private", signal: AbortSignal.timeout(10) }, {}, {}),
    { code: "timeout", message: "Decision model request timed out" });
  const controller = new AbortController();
  const cancelled = requestDecision({ apiKey: "private", signal: controller.signal, timeoutMs: 20 }, {}, {});
  await new Promise(resolve => setImmediate(resolve));
  controller.abort("private reason");
  await assert.rejects(cancelled, { code: "cancelled", message: "Decision model request cancelled" });
  assert.equal(fetch.mock.callCount(), 2);
  fetch.mock.mockImplementation(async () => { throw new Error("private transport detail"); });
  await assert.rejects(requestDecision({ apiKey: "private" }, {}, {}),
    { code: "network_error", message: "Decision model request failed" });
  fetch.mock.mockImplementation(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("private body detail")); },
  })));
  await assert.rejects(requestDecision({ apiKey: "private" }, {}, {}),
    { code: "network_error", message: "Decision model request failed" });
});

test("quality helper isolates requests and keeps scores aligned despite reversed completion", { timeout: 2000 }, async t => {
  const pending: { body: { state: [{ chunks: { text: string }[] }] };
    resolve: (response: Response) => void }[] = [];
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => new Promise<Response>(resolve => {
    pending.push({ body: JSON.parse(String(init?.body)), resolve });
  }));
  const quality = judgeQuality({ apiKey: "fake", timeoutMs: 1000, signal: new AbortController().signal,
    chunks: [{ text: "first", sourceKind: "files" }, { text: "second", sourceKind: "sessions" }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2, "both requests start before either completes");
  assert.deepEqual(pending.map(p => p.body.state[0].chunks.map(c => c.text)), [["first"], ["second"]]);
  pending[1].resolve(Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { noise_0: { type: "noul", noul: 0.8 }, evidence_0: { type: "noul", noul: 0.7 } } }));
  pending[0].resolve(Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { noise_0: { type: "noul", noul: 0.1 }, evidence_0: { type: "noul", noul: 0.9 } } }));
  assert.deepEqual(await quality, [{ noise: 0.1, evidence: 0.9 }, { noise: 0.8, evidence: 0.7 }]);
});

test("oversized batches start together and map reversed replies by trusted index", async t => {
  function responseGate() {
    let release!: (response: Response) => void;
    const promise = new Promise<Response>(resolve => { release = resolve; });
    return { promise, resolve: release };
  }
  const full = responseGate();
  const tail = responseGate();
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const [state] = JSON.parse(String(init?.body)).state;
    if (state.skills[0].name === "skill-0") {
      assert.equal(state.skills.length, 80);
      assert.equal(state.skills[79].name, "skill-79");
      return full.promise;
    }
    assert.deepEqual(state.skills.map(({ id, name }: { id: string; name: string }) => [id, name]),
      [["s_0", "skill-80"], ["s_1", "skill-81"]]);
    return tail.promise;
  });
  const result = scoreSkillCatalog({
    ...skillCatalog, candidates: skills(82), timeoutMs: 1000, minUsefulness: 0.8, maxMatches: 2,
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetch.mock.callCount(), 2, "both requests start before either completes");
    tail.resolve(skillResponse({
      s_1: { type: "noul", noul: 0.8 },
      s_0: { type: "noul", noul: 0.95, name: "skill-0", path: "/invented/SKILL.md" },
    }));
    await new Promise(resolve => setImmediate(resolve));
    full.resolve(skillResponse(skillAnswers(80, { 0: 0.79, 79: 0.8 })));
    assert.deepEqual(await result, [{ index: 80, score: 0.95 }, { index: 79, score: 0.8 }]);
  } finally {
    full.resolve(skillResponse({}));
    tail.resolve(skillResponse({}));
    await result.catch(() => {});
  }
});

test("a failed catalog batch preserves other matches; all failures surface the first error without retrying", async t => {
  let failAll = false;
  const failures: { batch: number; error: unknown }[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const [{ skills }] = JSON.parse(String(init?.body)).state;
    if (skills[0].name === "skill-0") return new Response("private provider detail", { status: 403 });
    if (failAll) return new Response("private provider detail", { status: 529 });
    return skillResponse(skillAnswers(1, { 0: 0.9 }));
  });
  const params = {
    ...skillCatalog, candidates: skills(3), batchSize: 2,
    onBatchFailure: (batch: number, error: unknown) => { failures.push({ batch, error }); },
  };
  assert.deepEqual(await scoreSkillCatalog(params), [{ index: 2, score: 0.9 }]);
  assert.deepEqual(failures.map(f => f.batch), [0]);
  assert.match(String(failures[0].error), /Decision model HTTP 403/);
  failAll = true;
  await assert.rejects(scoreSkillCatalog(params), { message: "Decision model HTTP 403", code: "http_error", status: 403 });
  assert.equal(fetch.mock.callCount(), 4);
});

test("catalog responses cannot substitute answer keys or malformed probabilities", async t => {
  const fetch = t.mock.method(globalThis, "fetch");
  const yes = { type: "noul", noul: 0.93 };
  const params = { ...skillCatalog, candidates: skills(2) };
  for (const answers of [
    undefined,
    { s_0: yes },
    { s_0: yes, "skill-1": yes },
    { s_0: yes, s_1: yes, s_2: yes },
    { s_0: yes, s_1: { type: "score", noul: 0.93 } },
    { s_0: yes, s_1: { type: "noul", noul: 2 } },
  ]) {
    fetch.mock.mockImplementation(async () => skillResponse(answers));
    await assert.rejects(scoreSkillCatalog(params), { code: "invalid_response" });
  }
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
