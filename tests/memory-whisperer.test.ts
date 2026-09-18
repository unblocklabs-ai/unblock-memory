import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "../src/config.js";
import type { CorpusMemorySearchResult, CorpusSearchOptions } from "../src/contracts.js";
import { registerMemoryWhisperer } from "../src/memory-whisperer.js";
import { expandSessionSearchHit } from "../src/manager.js";
import { memoryConversation } from "../src/whisperer-context.js";

const config = { ...resolveConfig(undefined).memoryWhisperer, enabled: true, corpora: ["memory", "sessions"], cooldownTurns: 2 };
const typesafe = { enabled: true, apiKey: "fake-secret", timeoutMs: 100 };
const context = { trigger: "user", agentId: "bill", sessionId: "current", sessionKey: "key", runId: "run-1" };
const event = { prompt: "Deploy this", messages: [{ role: "user", content: "Use project alpha" }] };
type Context = Partial<typeof context>;
type Before = (event: { prompt: string; messages: unknown[] }, context: Context) => Promise<{ prependContext: string } | void>;
type End = (event: { sessionId: string; sessionKey?: string }, context: Context) => void;

function hit(excerpt: string, overrides: Partial<CorpusMemorySearchResult> = {}): CorpusMemorySearchResult {
  return { path: `qmd://memory/${excerpt}.md`, startLine: 1, endLine: 3, score: 0.2,
    snippet: excerpt, source: "memory", corpus: "memory", citation: "memory/note.md#L1-L3", ...overrides };
}

function response(...probabilities: number[]) {
  return Response.json({ answers: Object.fromEntries(probabilities.map((noul, i) => [`memory_${i}`, { type: "noul", noul }])) });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(
  hits: CorpusMemorySearchResult[] = [hit("Deploy only after approval")],
  options: { config?: Partial<typeof config>; typesafe?: ReturnType<typeof resolveConfig>["typesafe"];
    search?: () => Promise<CorpusMemorySearchResult[]> } = {},
) {
  const hooks = new Map<string, (...args: never[]) => unknown>();
  const warnings: string[] = [];
  const searches: { query: string; options?: CorpusSearchOptions }[] = [];
  let lookups = 0;
  const api = { config: {}, logger: { warn: (message: string) => warnings.push(message) },
    on: (name: string, handler: (...args: never[]) => unknown) => hooks.set(name, handler),
  } as unknown as OpenClawPluginApi;
  registerMemoryWhisperer(api, {
    async getMemorySearchManager() {
      lookups++;
      return { manager: { async search(query, searchOptions) {
        searches.push({ query, options: searchOptions });
        return options.search ? options.search() : hits;
      } } };
    },
  }, { ...config, ...options.config }, options.typesafe ?? typesafe);
  return { hooks, warnings, searches, lookups: () => lookups,
    before: hooks.get("before_prompt_build") as unknown as Before,
    end: hooks.get("session_end") as unknown as End,
    stop: hooks.get("gateway_stop") as unknown as () => void,
  };
}

test("memory whisperer requires explicit, known non-skill corpora and bounded controls", () => {
  assert.deepEqual(resolveConfig(undefined).memoryWhisperer, {
    enabled: false, corpora: [], historyMessages: 5, minUsefulness: 0.9, maxHints: 2, cooldownTurns: 10, timeoutMs: 3000,
  });
  assert.deepEqual(resolveConfig({ memoryWhisperer: { enabled: true, corpora: ["memory", "memory"], historyMessages: 0 } })
    .memoryWhisperer.corpora, ["memory"]);
  for (const value of [false, [], { enabled: true }, { corpora: ["all"] }, { corpora: ["unknown"] },
    { corpora: ["skills"] }, { corpora: "memory" }, { enabled: 1 }, { extra: true },
    { historyMessages: 51 }, { historyMessages: -1 }, { historyMessages: "5" }, { historyMessages: 0.5 },
    { minUsefulness: NaN }, { minUsefulness: 1.1 }, { minUsefulness: -0.1 }, { maxHints: 0 }, { maxHints: 3 },
    { cooldownTurns: -1 }, { cooldownTurns: 1001 }, { cooldownTurns: "2" }, { timeoutMs: 0 }, { timeoutMs: 10001 }]) {
    assert.throws(() => resolveConfig({ memoryWhisperer: value }), /memoryWhisperer/);
  }
});

test("judging uses more history than retrieval, excludes hidden content, and marks truncation", () => {
  const conversation = memoryConversation("now", [
    { role: "system", content: "secret" }, { role: "toolResult", content: "secret" },
    { role: "assistant", content: [{ type: "thinking", text: "secret" }, { type: "text", text: "visible" }] },
    { role: "user", content: "now" },
  ]);
  assert.deepEqual(conversation, { currentRequest: "now", history: [{ role: "assistant", content: "visible" }], truncated: false });
  const bounded = memoryConversation("now", [{ role: "user", content: "x".repeat(20_000) }]);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.currentRequest.length + bounded.history[0].content.length, 16_000);
  assert.deepEqual(memoryConversation("x".repeat(20_000), []), { currentRequest: "x".repeat(16_000), history: [], truncated: true });
});

test("one batched judge ranks useful hits, enforces threshold, deduplicates and injects original sources", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.state.conversation.history.length, 3);
    assert.equal(request.state.candidates.length, 3);
    assert.equal(JSON.stringify(request).includes("qmd://"), false);
    assert.equal(Object.keys(request.questions).length, 3);
    assert.match(request.questions.memory_1.instructions.question, /candidates\[1\]/);
    return response(0.9, 0.99, 0.89);
  });
  const h = harness([hit("first"), hit("first"), hit("overlap", { path: "qmd://memory/first.md", startLine: 2 }), hit("second"), hit("third")],
    { config: { historyMessages: 1 } });
  const result = await h.before({ prompt: "now", messages: [
    { role: "user", content: "old" }, { role: "assistant", content: "answer" }, { role: "user", content: "recent" },
  ] }, context);
  assert.ok(result);
  const hint = result.prependContext;
  assert.match(hint, /untrusted source data/);
  const entries = JSON.parse(hint.slice(hint.indexOf("\n") + 1));
  assert.deepEqual(entries.map((entry: { excerpt: string }) => entry.excerpt), ["second", "first"]);
  assert.equal(entries[0].path, "qmd://memory/second.md");
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(h.searches[0].query, "user: recent\n\nuser: now");
  assert.equal(h.searches[0].options?.minScore, -1);
  assert.equal(h.searches[0].options?.maxResults, 8);
  assert.equal(h.searches[0].options?.maxSnippetChars, 1200);
  assert.deepEqual(h.searches[0].options?.sessionFilter, { sessionId: "current" });
});

test("unapproved corpora and other sessions never reach TypeSafe; absent session identity excludes sessions", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.state.candidates.map((item: { excerpt: string }) => item.excerpt), ["safe", "current session"]);
    return response(0.1, 0.99);
  });
  const session = { sessionId: "current", chatType: "channel" as const, startedAt: 1000 };
  const h = harness([hit("private", { corpus: "private" }), hit("safe"),
    hit("other session", { corpus: "sessions", session: { ...session, sessionId: "other" } }),
    hit("unknown session", { corpus: "sessions" }), hit("current session", { corpus: "sessions", session })]);
  assert.match((await h.before(event, context))?.prependContext ?? "", /current session/);
  const missing = harness([], { config: { corpora: ["sessions"] } });
  assert.equal(await missing.before(event, { ...context, sessionId: undefined }), undefined);
  assert.equal(missing.lookups(), 0);
  const files = harness([hit("unsafe session", { corpus: "sessions", session })]);
  assert.equal(await files.before(event, { ...context, sessionId: undefined }), undefined);
  assert.deepEqual(files.searches[0].options?.corpora, ["memory"]);
  assert.equal(fetch.mock.callCount(), 1);
});

test("disabled features and missing credentials cause no retrieval or provider calls", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected"); });
  assert.equal(harness([], { config: { enabled: false } }).hooks.size, 0);
  assert.equal(harness([], { typesafe: { ...typesafe, enabled: false } }).hooks.size, 0);
  const h = harness(undefined, { typesafe: { enabled: true, timeoutMs: 100, apiKeyFile: "/nonexistent-memory-whisperer/key" } });
  assert.equal(await h.before(event, context), undefined);
  assert.equal(h.lookups(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test("only user turns run; cooldown is per agent/session, duplicate runs do nothing, teardown resets", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => response(0.99));
  const h = harness();
  assert.equal(await h.before(event, { ...context, trigger: "heartbeat" }), undefined);
  assert.equal(await h.before(event, { ...context, agentId: undefined }), undefined);
  assert.ok(await h.before(event, context));
  assert.equal(await h.before(event, context), undefined);
  assert.equal(await h.before(event, { ...context, runId: "run-2" }), undefined);
  assert.equal(await h.before(event, { ...context, runId: "run-3" }), undefined);
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(await h.before(event, { ...context, runId: "run-4" }));
  assert.ok(await h.before(event, { ...context, agentId: "other" }));
  h.end({ sessionId: "current" }, context);
  assert.ok(await h.before(event, { ...context, runId: "run-5" }));
  h.stop();
});

test("no useful hits and errors do not fall back or consume cooldown; logs never contain source text", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => response(0.3));
  const h = harness();
  assert.equal(await h.before(event, context), undefined);
  fetch.mock.mockImplementation(async () => new Response("fake-secret", { status: 529 }));
  assert.equal(await h.before(event, { ...context, runId: "error" }), undefined);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings.join().includes("fake-secret"), false);
  fetch.mock.mockImplementation(async () => response(0.99));
  assert.ok(await h.before(event, { ...context, runId: "recovered" }));
  const failed = harness([], { search: async () => { throw new Error("private memory"); } });
  assert.equal(await failed.before(event, context), undefined);
  assert.equal(failed.warnings.join().includes("private memory"), false);
});

test("retrieval deadline returns promptly and late hits cannot trigger TypeSafe", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => response(0.99));
  const pending = deferred<CorpusMemorySearchResult[]>();
  const h = harness([], { config: { timeoutMs: 20 }, search: () => pending.promise });
  assert.equal(await h.before(event, context), undefined);
  assert.equal(h.searches[0].options?.signal?.aborted, true);
  pending.resolve([hit("too late")]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetch.mock.callCount(), 0);
});

test("pending judgments cannot survive session teardown, shutdown, or superseding turns", async t => {
  for (const action of ["end", "stop", "supersede"] as const) {
    const started = deferred<void>();
    const pending = deferred<Response>();
    const fetch = t.mock.method(globalThis, "fetch", async () => { started.resolve(); return pending.promise; });
    const h = harness();
    const first = h.before(event, context);
    await started.promise;
    if (action === "end") h.end({ sessionId: "current" }, context);
    else if (action === "stop") h.stop();
    else {
      fetch.mock.mockImplementation(async () => response(0.1));
      assert.equal(await h.before(event, { ...context, runId: "newer" }), undefined);
    }
    assert.equal(await first, undefined);
    pending.resolve(response(0.99));
    await new Promise(resolve => setImmediate(resolve));
    fetch.mock.restore();
  }
});

test("candidate count and payload are bounded; oversized results are skipped, not sliced", async t => {
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.state.candidates.length, 8);
    assert.ok(request.state.candidates.every((candidate: { excerpt: string }) => candidate.excerpt.length <= 1200));
    return response(...Array.from({ length: 8 }, () => 0.99));
  });
  const h = harness([hit("oversized ".repeat(180)), ...Array.from({ length: 12 }, (_, i) =>
    hit(`${i} ${"x".repeat(1190)}`, { path: `qmd://memory/${i}.md` }))]);
  const result = await h.before(event, context);
  assert.ok(result);
  assert.ok(result.prependContext.length < 5400);
  assert.doesNotMatch(result.prependContext, /oversized/);
  assert.match(result.prependContext, /"excerptTruncated":false/);
});

test("late matched evidence reaches both the judge and hint intact", async t => {
  const fact = "Deployment requires approval from the project owner.";
  const body = "## User — User — 2026-09-17 10:00:00 UTC\n\n" +
    "Background discussion. ".repeat(80) +
    "\n\n## Assistant — Agent — 2026-09-17 10:01:00 UTC\n\n" + fact;
  const vectorHit = { body, bestChunk: fact, chunkPos: body.indexOf(fact), chunkLen: fact.length };
  const selected = await expandSessionSearchHit(vectorHit, 2000, async () => 400, 1200);
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.state.candidates[0].excerpt, selected.text);
    assert.ok(request.state.candidates[0].excerpt.includes(fact));
    return response(0.99);
  });
  const h = harness([hit(selected.text, { path: "qmd://sessions/current.md", corpus: "sessions",
    session: { sessionId: "current", chatType: "channel", startedAt: 1000 } })]);
  const result = await h.before(event, context);
  assert.ok(result);
  const entries = JSON.parse(result.prependContext.slice(result.prependContext.indexOf("\n") + 1));
  assert.equal(entries[0].excerpt, selected.text);
  assert.ok(entries[0].excerpt.includes(fact));
});
