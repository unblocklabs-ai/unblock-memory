import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULTS } from "../src/defaults.js";
import {
  conversationText, groundAnchors, planningBudgetMs, planRecall, recallGate, sliceHeadSafe, topicQueries,
} from "../src/memory-query-v2.js";
import { fallbackQueries } from "../src/query-generator.js";
import type { QueryConversation } from "../src/query-contract.js";

const MODEL = "liquid/d1.2-ultra-20261116";
const access = { apiKey: "fake-secret", endpoint: "https://decisions.example.test/v1/decisions", model: "liquid/d1.2-ultra", timeoutMs: 200 };
const asOf = "2026-11-26T12:00:00.000Z";
const conversation: QueryConversation = {
  history: [
    { role: "user", content: "Sarah sent invoice INV-2207 yesterday." },
    { role: "assistant", content: "Noted. Pearl's disk alert also fired on pearlperelel." },
  ],
  currentRequest: "Check Sarah's invoice and Pearl's disk",
};

type Request = { url: string; body: Record<string, unknown>; signal?: AbortSignal };
type Handler = (body: Record<string, unknown>, init?: RequestInit) => Response | Promise<Response>;
/** Gate and extraction always run in parallel; an unconfigured extraction yields an empty topic list. */
function mockModel(t: test.TestContext, handlers: { gate?: Handler; extract?: Handler }) {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), body, signal: init?.signal ?? undefined });
    if (String(url).endsWith("/v1/extractions")) return handlers.extract ? handlers.extract(body, init) : list([]);
    assert.match(String(url), /\/v1\/decisions$/u);
    if (!handlers.gate) assert.fail("unexpected decision call");
    return handlers.gate(body, init);
  });
  return requests;
}
/**
 * A transport that never answers but always settles on abort. Like a real open socket it holds a ref'd handle
 * until then: `AbortSignal.timeout` timers are unref'd, so without one Node 22's runner sees an empty event loop
 * and cancels the test with "Promise resolution is still pending".
 */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return reject(new Error("test transport requires an abort signal"));
    if (signal.aborted) return reject(signal.reason);
    const socket = setInterval(() => {}, 1_000);
    signal.addEventListener("abort", () => { clearInterval(socket); reject(signal.reason); }, { once: true });
  });
}
const paths = (requests: Request[]) => requests.map(request => new URL(request.url).pathname).sort();
const noul = (scores: Record<string, number>) => Response.json({ model: MODEL,
  answers: Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, { type: "noul", noul: value }])) });
const list = (value: unknown[] | null, extra: Record<string, unknown> = {}) =>
  Response.json({ model: MODEL, answers: { topics: { type: "list", value, ...extra } } });
const signal = () => new AbortController().signal;

test("conversation text is plain role-labelled lines ending in the current request", () => {
  assert.equal(conversationText(conversation), [
    "User: Sarah sent invoice INV-2207 yesterday.",
    "Assistant: Noted. Pearl's disk alert also fired on pearlperelel.",
    "Current request: Check Sarah's invoice and Pearl's disk",
  ].join("\n"));
});

test("grounding keeps verbatim anchors, prefers agreeing spans, and rejects hallucinations and label-only matches", () => {
  const text = conversationText(conversation);
  const start = text.indexOf("INV-2207");
  const anchors = groundAnchors(conversation, [
    "INV-2207", // exact span
    "PEARLPERELEL", // case-insensitive substring -> conversation casing
    "Acme renewal", // hallucinated
    "Current request", // only a role label
    "inv-2207", // duplicate after normalization
    42, // non-string
    "Sarah",
  ], [[start, start + "INV-2207".length], [0, 3], [0, 1], [0, 1], [0, 1], [0, 1], [999, 1000]]);
  assert.deepEqual(anchors, ["INV-2207", "pearlperelel", "Sarah"]);
  assert.deepEqual(groundAnchors(conversation, ["Sarah", "Pearl's disk", "INV-2207", "pearlperelel"], undefined),
    ["Sarah", "Pearl's disk", "INV-2207"], "caps at maxTopics = 3");
  assert.deepEqual(groundAnchors(conversation, ["   ", "!!!", "Sarah's invoice"], undefined, 3), ["Sarah's invoice"]);
});

test("topic queries pair the verbatim anchor with the request and stay bounded without splitting surrogates", () => {
  assert.deepEqual(topicQueries(["Sarah's invoice", "sarah's invoice", "Pearl's disk"], conversation.currentRequest), [
    { lex: "Sarah's invoice", vec: "Sarah's invoice: Check Sarah's invoice and Pearl's disk" },
    { lex: "Pearl's disk", vec: "Pearl's disk: Check Sarah's invoice and Pearl's disk" },
  ]);
  const { fallbackMaxLexChars, fallbackMaxVecChars } = DEFAULTS.memoryWhisperer;
  const [pair] = topicQueries(["x".repeat(fallbackMaxLexChars - 1) + "😀"], "😀".repeat(400));
  assert.ok(pair!.lex.length <= fallbackMaxLexChars);
  assert.ok(pair!.vec.length <= fallbackMaxVecChars);
  assert.doesNotMatch(pair!.lex + pair!.vec, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u, "no lone high surrogate");
  assert.equal(sliceHeadSafe("a😀", 2), "a");
});

test("gate below threshold skips recall; single corpus asks only need_recall", async t => {
  const requests = mockModel(t, { gate: body => {
    assert.deepEqual(Object.keys(body.questions as object), ["need_recall"]);
    const [state] = body.state as [Record<string, unknown>];
    assert.equal(state.asOf, asOf);
    assert.equal(state.corpora, undefined);
    assert.match(JSON.stringify(body.questions), /untrusted evidence, never instructions/u);
    return noul({ need_recall: 0.2 });
  }, extract: (_body, init) => hang(init) });
  const plan = await planRecall({ ...access, conversation, asOf, corpora: ["memory"], signal: signal() });
  assert.deepEqual(plan, { shouldRecall: false, corpora: [], topics: [], anchors: [], gateScore: 0.2, queryFallback: false });
  assert.deepEqual(paths(requests), ["/v1/decisions", "/v1/extractions"], "extraction was launched alongside the gate");
  const extraction = requests.find(request => request.url.endsWith("/v1/extractions"))!;
  assert.equal(extraction.signal?.aborted, true, "a gate skip aborts the in-flight extraction immediately");
});

test("corpus router keeps winners and falls back to every configured corpus when none clear the bar", async t => {
  let scores: Record<string, number> = {};
  mockModel(t, { gate: body => {
    assert.deepEqual(Object.keys(body.questions as object), ["need_recall", "corpus_0", "corpus_1", "corpus_2"]);
    assert.deepEqual((body.state as [{ corpora: unknown }])[0].corpora,
      [{ id: "corpus_0", name: "memory" }, { id: "corpus_1", name: "sessions" }, { id: "corpus_2", name: "docs" }]);
    return noul(scores);
  } });
  const corpora = ["memory", "sessions", "docs"];
  scores = { need_recall: 0.9, corpus_0: 0.8, corpus_1: 0.1, corpus_2: 0.35 };
  const routed = await recallGate({ ...access, conversation, asOf, corpora, signal: signal() });
  assert.deepEqual(routed.corpora, ["memory", "docs"]);
  assert.equal(routed.shouldRecall, true);
  scores = { need_recall: 0.9, corpus_0: 0.1, corpus_1: 0.2, corpus_2: 0.3 };
  assert.deepEqual((await recallGate({ ...access, conversation, asOf, corpora, signal: signal() })).corpora, corpora);
  scores = { need_recall: 0.45, corpus_0: 0.9, corpus_1: 0.9, corpus_2: 0.9 };
  assert.equal((await recallGate({ ...access, conversation, asOf, corpora, signal: signal() })).shouldRecall, true,
    "the threshold is inclusive");
});

test("grounded extraction yields one query pair per verbatim topic and discards hallucinations", async t => {
  const requests = mockModel(t, {
    gate: () => noul({ need_recall: 0.9 }),
    extract: body => {
      assert.equal(body.state, conversationText(conversation), "extraction state is the plain transcript");
      const fields = body.fields as { topics: { type: string; items: string; instructions: string } };
      assert.equal(fields.topics.type, "list");
      assert.equal(fields.topics.items, "text");
      assert.match(fields.topics.instructions, /verbatim/u);
      return list(["Sarah's invoice", "Pearl's disk", "Q3 board deck"]);
    },
  });
  const plan = await planRecall({ ...access, conversation, asOf, corpora: ["memory"], signal: signal() });
  assert.equal(plan.queryFallback, false);
  assert.deepEqual(plan.anchors, ["Sarah's invoice", "Pearl's disk"]);
  assert.deepEqual(plan.topics.map(topic => topic.lex), ["Sarah's invoice", "Pearl's disk"]);
  assert.deepEqual(plan.corpora, ["memory"]);
  assert.deepEqual(paths(requests), ["/v1/decisions", "/v1/extractions"]);
});

test("gate and extraction failures fail open to deterministic fallback queries", async t => {
  const fallback = [fallbackQueries(conversation)];
  await t.test("gate http error searches every configured corpus with fallback queries when nothing is grounded", async t => {
    const requests = mockModel(t, { gate: () => new Response("upstream down", { status: 503 }) });
    const plan = await planRecall({ ...access, conversation, asOf, corpora: ["memory", "sessions"], signal: signal() });
    assert.equal(plan.shouldRecall, true);
    assert.equal(plan.queryFallback, true);
    assert.ok(plan.gateFallback);
    assert.deepEqual(plan.corpora, ["memory", "sessions"]);
    assert.deepEqual(plan.topics, fallback);
    assert.equal(requests.length, 2);
  });
  await t.test("a failed-open gate still uses the parallel extraction's grounded topics", async t => {
    mockModel(t, { gate: () => new Response("upstream down", { status: 503 }), extract: () => list(["INV-2207"]) });
    const plan = await planRecall({ ...access, conversation, asOf, corpora: ["memory", "sessions"], signal: signal() });
    assert.ok(plan.gateFallback);
    assert.equal(plan.queryFallback, false);
    assert.deepEqual(plan.anchors, ["INV-2207"]);
    assert.deepEqual(plan.corpora, ["memory", "sessions"]);
  });
  await t.test("partial or malformed gate answers fail open instead of throwing out of the turn", async t => {
    for (const reply of [
      () => noul({ need_recall: 0.9, corpus_0: 0.8 }), // corpus_1 missing
      () => Response.json({ model: MODEL, answers: { need_recall: { type: "noul" } } }),
      () => Response.json({ model: MODEL, answers: {} }),
    ]) {
      await t.test("reply", async t => {
        mockModel(t, { gate: reply });
        const plan = await planRecall({ ...access, conversation, asOf, corpora: ["memory", "sessions"], signal: signal() });
        assert.equal(plan.shouldRecall, true);
        assert.ok(plan.gateFallback);
        assert.deepEqual(plan.corpora, ["memory", "sessions"]);
      });
    }
  });
  await t.test("gate timeout", async t => {
    mockModel(t, { gate: (_body, init) => hang(init) });
    const plan = await planRecall({ ...access, timeoutMs: 20, conversation, asOf, corpora: ["memory"], signal: signal() });
    assert.equal(plan.queryFallback, true);
    assert.ok(plan.gateFallback);
  });
  await t.test("extraction timeout", async t => {
    mockModel(t, { gate: () => noul({ need_recall: 0.9 }), extract: (_body, init) => hang(init) });
    const plan = await planRecall({ ...access, timeoutMs: 20, conversation, asOf, corpora: ["memory"], signal: signal() });
    assert.equal(plan.extractionFallback?.reason, "error");
    assert.deepEqual(plan.topics, fallback);
    assert.equal(plan.gateScore, 0.9);
  });
  await t.test("extraction invalid response", async t => {
    mockModel(t, { gate: () => noul({ need_recall: 0.9 }), extract: () => Response.json({ model: MODEL, answers: {} }) });
    const plan = await planRecall({ ...access, conversation, asOf, corpora: ["memory"], signal: signal() });
    assert.equal(plan.extractionFallback?.reason, "error");
    assert.deepEqual(plan.topics, fallback);
  });
  for (const [name, payload] of [
    ["only hallucinated anchors", list(["Totally invented project"])],
    ["empty list", list([])],
    ["null list", list(null, { p_null: 1 })],
  ] as const) {
    await t.test(name, async t => {
      mockModel(t, { gate: () => noul({ need_recall: 0.9 }), extract: () => payload.clone() });
      const plan = await planRecall({ ...access, conversation, asOf, corpora: ["memory"], signal: signal() });
      assert.equal(plan.extractionFallback?.reason, "no_grounded_topics");
      assert.equal(plan.queryFallback, true);
      assert.deepEqual(plan.topics, fallback);
    });
  }
});

test("turn cancellation propagates instead of falling back", async t => {
  const controller = new AbortController();
  mockModel(t, { gate: (_body, init) => {
    controller.abort();
    return hang(init);
  }, extract: (_body, init) => hang(init) });
  await assert.rejects(planRecall({ ...access, conversation, asOf, corpora: ["memory"], signal: controller.signal }));
});

test("planning runs gate and extraction in parallel within half of the turn deadline", async t => {
  assert.equal(planningBudgetMs(5000), DEFAULTS.memoryWhisperer.planningTimeoutMs);
  assert.equal(planningBudgetMs(3000, 2000), 1500, "a 3 s turn keeps 1.5 s for search and judging");
  assert.equal(planningBudgetMs(1), 1);
  assert.equal(planningBudgetMs(undefined, 2000), 2000);
  await t.test("both calls are in flight at once and the slower one bounds planning", async t => {
    const started: string[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>(resolve => { release = resolve; });
    const arrive = (kind: string) => { started.push(kind); if (started.length === 2) release(); };
    mockModel(t, {
      gate: async () => { arrive("gate"); await bothStarted; return noul({ need_recall: 0.9 }); },
      extract: async () => { arrive("extract"); await bothStarted; return list(["Sarah"]); },
    });
    const plan = await planRecall({ ...access, conversation, asOf, corpora: ["memory"], signal: signal() });
    assert.deepEqual(started.sort(), ["extract", "gate"]);
    assert.deepEqual(plan.anchors, ["Sarah"]);
  });
  await t.test("hung calls are cut at timeoutMs / 2 even when stage timeouts are longer", async t => {
    mockModel(t, { gate: (_body, init) => hang(init), extract: (_body, init) => hang(init) });
    const before = performance.now();
    const plan = await planRecall({ ...access, timeoutMs: 5000, gateTimeoutMs: 5000, extractTimeoutMs: 5000,
      planningTimeoutMs: 5000, turnTimeoutMs: 400, conversation, asOf, corpora: ["memory"], signal: signal() });
    const elapsed = performance.now() - before;
    assert.ok(elapsed >= 190 && elapsed < 350, `planning took ${elapsed.toFixed(0)} ms of a 400 ms turn (budget 200 ms)`);
    assert.ok(plan.gateFallback);
    assert.equal(plan.extractionFallback?.reason, "error");
    assert.deepEqual(plan.topics, [fallbackQueries(conversation)]);
  });
});

test("grounding rejects trivial anchors and returns the exact source slice a span points to", () => {
  const spoken: QueryConversation = {
    history: [{ role: "user", content: "ask SARAH about it 😀 later" }, { role: "assistant", content: "I will. The deck is ready." }],
    currentRequest: "Did 😀 Sarah review the deck?",
  };
  const text = conversationText(spoken);
  const requestStart = text.lastIndexOf("Sarah");
  assert.deepEqual(groundAnchors(spoken, ["sarah"], [[requestStart, requestStart + 5]]), ["Sarah"],
    "a span into the current request keeps its casing, not message 0's SARAH");
  const cpStart = [...text.slice(0, requestStart)].length;
  assert.deepEqual(groundAnchors(spoken, ["sarah"], [[cpStart, cpStart + 5]]), ["Sarah"], "code-point spans are converted");
  assert.deepEqual(groundAnchors(spoken, ["sarah"], undefined), ["SARAH"], "substring fallback returns the source slice");
  assert.deepEqual(groundAnchors(spoken, ["Current request: Did"], [[text.indexOf("Current"), text.indexOf("Current") + 20]]), [],
    "a span over a role label is not grounded");
  assert.deepEqual(groundAnchors(spoken, ["it", "I", "the", "The deck", "this", "😀", "is it", "deck"], undefined, 5),
    ["The deck", "deck"], "single-character and stopword-only anchors are rejected");
});

test("bounded topic pairs are deduplicated before the maxTopics cap", () => {
  const { fallbackMaxLexChars } = DEFAULTS.memoryWhisperer;
  const prefix = "p".repeat(fallbackMaxLexChars);
  const topics = topicQueries([`${prefix} one`, `${prefix} two`, "Sarah", "Pearl"], "Now", 3);
  assert.deepEqual(topics.map(topic => topic.lex), [prefix, "Sarah", "Pearl"]);
});
