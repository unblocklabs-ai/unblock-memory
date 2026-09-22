import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { judgeTypeSafeMemories, judgeTypeSafeQuality, resolveTypeSafeApiKey, selectTypeSafeSkill } from "../src/typesafe.js";
import { askTypeSafeReview } from "../src/typesafe-review.js";

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
    assert.deepEqual(Object.keys(request.state), ["chunks"]);
    return Response.json({ answers: { noise_0: { type: "noul", noul: 0.96 }, evidence_0: { type: "noul", noul: 0.97 } } });
  });
  assert.deepEqual(await judgeTypeSafeQuality(params), [{ noise: 0.96, evidence: 0.97 }]);
  for (const answers of [{}, { noise_0: { type: "noul", noul: 0.95 } },
    { noise_0: { type: "noul", noul: 2 }, evidence_0: { type: "noul", noul: 0.97 } },
    { noise_0: { type: "noul", noul: 0.95 }, evidence_0: { type: "score", noul: 0.97 } }]) {
    fetch.mock.mockImplementation(async () => Response.json({ answers }));
    await assert.rejects(judgeTypeSafeQuality(params), /invalid quality/);
  }
});
const selection = {
  apiKey: "test-secret", timeoutMs: 100,
  currentRequest: "Deploy this project", history: [],
  candidates: [{ name: "none", description: "Deploy software releases." }],
};
const response = (choice: string) => Response.json({ answers: { selected: {
  type: "choice", choice, confidence: 0.9, probabilities: { skill_0: 0.9, none: 0.1 },
} } });

test("credentials support environment, explicit key, plaintext and dotenv files without sourcing", async (t) => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "environment-key";
  t.after(() => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  });
  const dir = await mkdtemp(join(tmpdir(), "unblock-typesafe-key-"));
  const apiKeyFile = join(dir, "key");
  assert.equal(await resolveTypeSafeApiKey({ ...config, enabled: false, apiKeyFile: dir }), undefined);
  assert.equal(await resolveTypeSafeApiKey(config), "environment-key");
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKey: " explicit-key " }), "explicit-key");
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), undefined);
  await writeFile(apiKeyFile, "plain-key\n", { mode: 0o600 });
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), "plain-key");
  await writeFile(apiKeyFile, '# key for this provider\nexport TYPESAFE_API_KEY="dotenv-key"\nOTHER=value\n');
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), "dotenv-key");
  assert.equal(process.env.TYPESAFE_API_KEY, "environment-key");
  await writeFile(apiKeyFile, "OTHER=value\n");
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), undefined);
  await writeFile(apiKeyFile, "TYPESAFE_API_KEY=\n");
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), undefined);
  await writeFile(apiKeyFile, "  \n");
  assert.equal(await resolveTypeSafeApiKey({ ...config, apiKeyFile }), undefined);
  await assert.rejects(resolveTypeSafeApiKey({ ...config, apiKeyFile: dir }), /credential file could not be read/);
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(await resolveTypeSafeApiKey(config), undefined);
});

test("selection uses opaque IDs, fixed endpoint, model, no redirects, and explicit none", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, { Authorization: "Bearer test-secret", "Content-Type": "application/json" });
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, "jev-1.13.0");
    assert.equal(request.state.currentRequest, "Deploy this project");
    assert.deepEqual(request.questions.selected.criteria.skill_0, { name: "none", description: "Deploy software releases." });
    assert.equal(typeof request.questions.selected.instructions.question, "string");
    assert.ok(request.questions.selected.criteria.none);
    return response(calls === 1 ? "skill_0" : "none");
  });
  assert.equal(await selectTypeSafeSkill(selection), 0);
  assert.equal(await selectTypeSafeSkill(selection), undefined);
  assert.equal(await selectTypeSafeSkill({ ...selection, candidates: [] }), undefined);
  assert.equal(calls, 2);
});

test("HTTP and schema errors never expose provider content or retry", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("test-secret", { status: 529 }));
  await assert.rejects(selectTypeSafeSkill(selection), { message: "TypeSafe selection request failed (HTTP 529)" });
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => response("invented-path"));
  await assert.rejects(selectTypeSafeSkill(selection), /unknown selection/);
  fetch.mock.mockImplementation(async () => Response.json({ secret: "test-secret" }));
  await assert.rejects(selectTypeSafeSkill(selection), /invalid selection/);
  fetch.mock.mockImplementation(async () => { throw new Error("test-secret network detail"); });
  await assert.rejects(selectTypeSafeSkill(selection), { message: "TypeSafe selection request failed" });
});

test("the request deadline aborts slow fetches", async (t) => {
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => new Promise<Response>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deadline did not abort")), 1000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("secret-bearing transport error"));
    }, { once: true });
  }));
  await assert.rejects(selectTypeSafeSkill({ ...selection, timeoutMs: 20 }), { message: "TypeSafe selection timed out" });
});

const memoryJudgment = {
  apiKey: "test-secret", timeoutMs: 100, signal: new AbortController().signal,
  conversation: { currentRequest: "Deploy alpha", history: [], truncated: false },
  candidates: [{ excerpt: "Alpha requires approval", corpus: "knowledge" }],
};

test("memory judgments use Noul probabilities and reject missing, extra, mistyped and out-of-range answers", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.redirect, "error");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, "jev-1.13.0");
    assert.equal(request.questions.memory_0.type, "noul");
    assert.equal(typeof request.questions.memory_0.instructions.question, "string");
    assert.equal(typeof request.questions.memory_0.criteria.true.definition, "string");
    assert.equal(request.state.candidates[0].excerpt, "Alpha requires approval");
    return Response.json({ answers: { memory_0: { type: "noul", noul: 0.97 } } });
  });
  assert.deepEqual(await judgeTypeSafeMemories(memoryJudgment), [0.97]);
  assert.deepEqual(await judgeTypeSafeMemories({ ...memoryJudgment, candidates: [] }), []);
  assert.equal(fetch.mock.callCount(), 1);
  for (const answers of [{}, { unknown: { type: "noul", noul: 0.99 } },
    { memory_0: { type: "score", noul: 0.99 } }, { memory_0: { type: "noul", noul: "0.99" } },
    { memory_0: { type: "noul", noul: 1.1 } }, { memory_0: { type: "noul", noul: -0.1 } },
    { memory_0: { type: "noul", noul: 0.9 }, memory_1: { type: "noul", noul: 0.99 } }]) {
    fetch.mock.mockImplementation(async () => Response.json({ answers }));
    await assert.rejects(judgeTypeSafeMemories(memoryJudgment), /invalid memory judgments/);
  }
});

test("memory requests sanitize failures, do not retry, and honor the provider deadline", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("test-secret", { status: 529 }));
  await assert.rejects(judgeTypeSafeMemories(memoryJudgment), { message: "TypeSafe memory request failed (HTTP 529)" });
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async (...[_url, init]: Parameters<typeof globalThis.fetch>) => new Promise<Response>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("did not abort")), 1000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("private transport detail"));
    }, { once: true });
  }));
  await assert.rejects(judgeTypeSafeMemories({ ...memoryJudgment, timeoutMs: 20 }), { message: "TypeSafe memory judgment aborted" });
});

test("shared transport preserves caller errors for HTTP, cancellation and invalid JSON failures", async t => {
  const params = { apiKey: "test-secret", timeoutMs: 100, signal: new AbortController().signal };
  const callers = [
    { request: () => selectTypeSafeSkill(selection), error: "TypeSafe selection request failed", status: true },
    { request: () => judgeTypeSafeMemories(memoryJudgment), error: "TypeSafe memory request failed", status: true },
    { request: () => judgeTypeSafeQuality({ ...params, chunks: [{ text: "fact", sourceKind: "files" }] }),
      error: "TypeSafe quality request failed", status: false },
    { request: () => askTypeSafeReview(params, {}, {}), error: "TypeSafe review unavailable", status: false },
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
      await assert.rejects(caller.request(), { message: caller.error + (caller.status ? " (HTTP 529)" : "") });
      assert.equal(cancelled, true);
    }
    fetch.mock.mockImplementation(async () => new Response("test-secret invalid JSON"));
    await assert.rejects(caller.request(), { message: caller.error });
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
    { message: "TypeSafe quality audit aborted" });
  await assert.rejects(judgeTypeSafeMemories({ ...memoryJudgment, signal: params.signal }),
    { message: "TypeSafe memory judgment aborted" });
  assert.equal(fetch.mock.callCount(), 2);
  await assert.rejects(askTypeSafeReview(params, {}, {}), { message: "TypeSafe review aborted" });
  assert.equal(fetch.mock.callCount(), 2, "review must abort before fetch");
});
