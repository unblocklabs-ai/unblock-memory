import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { CorpusMemorySearchResult } from "../src/contracts.js";
import { searchMemory } from "../src/memory-search.js";
import { registerUnblockMemory } from "../src/plugin.js";
import type { QmdMemoryRuntime } from "../src/runtime.js";

const queries = { lex: "rollout", vec: "Who approved rollout?" };
const options = { apiKey: "test", timeoutMs: 10, conversation: { history: [], currentRequest: queries.vec },
  allowRetrievalFallback: true };
const hit = (name: string, overrides: Partial<CorpusMemorySearchResult> = {}): CorpusMemorySearchResult => ({
  path: `qmd://memory/${name}.md`, startLine: 1, endLine: 2, snippet: `Evidence for ${name}`,
  source: "memory", corpus: "memory", score: 0.03278688524590164,
  vectorScore: 0.03278688524590164, textScore: 4.2, ...overrides,
});
const hits = [hit("first"), hit("second", { score: 0.01639344262295082 })];
const manager = { searchCandidates: async () => hits };

for (const failure of ["401", "402", "429", "503", "timeout", "network", "invalid_response"]) {
  test(`explicit search preserves local evidence on total ${failure} judge failure`, async t => {
    t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
      if (/^\d{3}$/.test(failure)) return new Response(null, { status: Number(failure) });
      if (failure === "invalid_response") return Response.json({ wrong: true });
      if (failure === "timeout") {
        await new Promise<void>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
          // Keep the event loop alive while AbortSignal.timeout's unref'ed timer runs.
          setTimeout(() => reject(new Error("late timeout")), 30);
        });
      }
      throw new Error("network unavailable");
    });
    const result = await searchMemory(manager, queries, { ...options, minUsefulness: 1, maxResults: 1 });
    assert.equal(result.rankingMode, "retrieval");
    assert.equal(result.fallbackReason, "all_judgments_failed");
    assert.equal(result.requestsFailed, 2);
    assert.deepEqual(result.results, hits.slice(0, 1));
    // Automatic recall does not opt in to degraded evidence.
    const strict = await searchMemory(manager, queries, { ...options, allowRetrievalFallback: false });
    assert.deepEqual(strict.results, []);
    assert.equal(strict.rankingMode, "typesafe_usefulness");
    assert.equal(strict.fallbackReason, undefined);
  });
}

test("partial success never mixes retrieval scores; valid rejection never triggers fallback", async t => {
  let calls = 0;
  let partial = true;
  t.mock.method(globalThis, "fetch", async () => {
    if (partial && calls++ % 2 === 0) return new Response(null, { status: 402 });
    return Response.json({ model: "jev-1.13.0", answers: { memory_0: { type: "noul", noul: 0.1 } } });
  });
  for (const isPartial of [true, false]) {
    partial = isPartial;
    const result = await searchMemory(manager, queries, options);
    assert.equal(result.requestsSucceeded, isPartial ? 1 : 2);
    assert.equal(result.rankingMode, "typesafe_usefulness");
    assert.equal(result.fallbackReason, undefined);
    assert.deepEqual(result.results, []);
  }
});

test("fallback retains scoping arguments, corpus defense, dedup, complete passage limits and cancellation", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call provider without key"); });
  const sessionFilter = { chatType: "channel" as const };
  const requestContext = { sessionKey: "test" };
  let observed: unknown;
  const candidates = { searchCandidates: async (_queries: unknown, params: unknown) => {
    observed = params;
    return [hits[0]!, hits[0]!, hit("too-long", { snippet: "x".repeat(1201) }),
      hit("other-corpus", { corpus: "private" }), hits[1]!];
  } };
  const result = await searchMemory(candidates, queries, { ...options, apiKey: undefined, corpora: ["memory"],
    sessionFilter, requestContext, minUsefulness: 1, maxResults: 2 });
  assert.deepEqual(result.results, hits);
  assert.equal(result.eligible, 2);
  assert.equal(result.requestsFailed, 0);
  assert.equal(result.fallbackReason, "key_unavailable");
  assert.deepEqual((observed as { sessionFilter: unknown }).sessionFilter, sessionFilter);
  assert.deepEqual((observed as { requestContext: unknown }).requestContext, requestContext);
  assert.deepEqual(await searchMemory(manager, queries, { ...options, apiKey: undefined, allowRetrievalFallback: false })
    .then(result => result.results), []);
  await assert.rejects(searchMemory(manager, queries, { ...options, apiKey: undefined, signal: AbortSignal.abort() }), { name: "AbortError" });
  const controller = new AbortController();
  await assert.rejects(searchMemory({ searchCandidates: async () => { controller.abort(); return hits; } }, queries,
    { ...options, apiKey: undefined, signal: controller.signal }), { name: "AbortError" });
});

test("caller cancellation while judging never becomes degraded success", async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => { controller.abort(); throw new Error("cancelled"); });
  await assert.rejects(searchMemory(manager, queries, { ...options, signal: controller.signal }), { name: "AbortError" });
});

for (const credential of ["missing", "disabled", "unreadable"] as const) {
  test(`public tool returns explicitly labeled retrieval evidence with ${credential} credential`, async t => {
    let providerCalls = 0;
    t.mock.method(globalThis, "fetch", async () => { providerCalls++; throw new Error("must not call provider"); });
    const previous = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    t.after(() => { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; });
    type Tool = { execute(id: string, params: unknown): Promise<{ details: Record<string, unknown> }> };
    let factory: ((ctx: OpenClawPluginToolContext) => Tool) | undefined;
    registerUnblockMemory({
      pluginConfig: { typesafe: credential === "disabled" ? { enabled: false, apiKey: "ignored" }
        : credential === "unreadable" ? { apiKeyFile: "/dev/null/not-a-file" } : {} },
      registerCli() {}, registerGatewayMethod() {},
      registerMemoryCapability({ runtime }: { runtime: QmdMemoryRuntime }) {
        Object.defineProperty(runtime, "getMemorySearchManager", { value: async () => ({ manager }) });
      },
      registerTool(candidate: typeof factory, params: { names: string[] }) {
        if (params.names.includes("memory_search")) factory = candidate;
      },
    } as unknown as OpenClawPluginApi);
    const result = await factory!({ agentId: `fallback-${credential}`, config: {} } as OpenClawPluginToolContext)
      .execute("search", { bm25Query: queries.lex, vectorQuery: queries.vec, minUsefulness: 1 });
    assert.equal(result.details.rankingMode, "retrieval");
    assert.equal(result.details.scoreMeaning, "retrieval_rank");
    assert.equal(result.details.minUsefulnessApplied, false);
    assert.equal(result.details.fallbackReason, "key_unavailable");
    assert.equal(result.details.error, undefined);
    assert.match(String(result.details.warning), /memory_get/);
    const results = result.details.results as CorpusMemorySearchResult[];
    assert.equal(results[0]!.path, hits[0]!.path);
    assert.equal(results[0]!.score, hits[0]!.score, "retrieval precision is retained, not rounded into zero");
    assert.equal(results[0]!.vectorScore, undefined, "raw lane scores are not mislabeled vector similarities");
    assert.equal(results[0]!.textScore, undefined);
    assert.equal(providerCalls, 0, "missing, disabled or unreadable keys never reach the provider");
  });
}

test("no eligible evidence with available ranking is empty, not a failed-judge fallback", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected"); });
  const result = await searchMemory({ searchCandidates: async () => [] }, queries, options);
  assert.deepEqual(result.results, []);
  assert.equal(result.rankingMode, "typesafe_usefulness");
  assert.equal(result.fallbackReason, undefined);
  assert.equal(calls, 0);
});
