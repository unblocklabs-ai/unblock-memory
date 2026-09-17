import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { judgeTypeSafeMemories, resolveTypeSafeApiKey, selectTypeSafeSkill } from "../src/typesafe.js";

const config = { enabled: true, timeoutMs: 100 };
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
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, "jev-1.13.0");
    assert.equal(request.state.currentRequest, "Deploy this project");
    assert.equal(request.questions.selected.criteria.skill_0, "none: Deploy software releases.");
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
