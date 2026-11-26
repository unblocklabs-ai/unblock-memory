import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULTS } from "../src/defaults.js";
import {
  conversationText, groundAnchors, planRecall, recallGate, sliceHeadSafe, topicQueries,
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

type Request = { url: string; body: Record<string, unknown> };
function mockModel(t: test.TestContext, handlers: {
  gate?: (body: Record<string, unknown>) => Response | Promise<Response>;
  extract?: (body: Record<string, unknown>) => Response | Promise<Response>;
}) {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), body });
    if (String(url).endsWith("/v1/extractions")) {
      if (!handlers.extract) assert.fail("unexpected extraction call");
      return handlers.extract(body);
    }
    assert.match(String(url), /\/v1\/decisions$/u);
    if (!handlers.gate) assert.fail("unexpected decision call");
    return handlers.gate(body);
  });
  return requests;
}
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
  } });
  const plan = await planRecall({ ...access, conversation, asOf, corpora: ["memory"], signal: signal() });
  assert.deepEqual(plan, { shouldRecall: false, corpora: [], topics: [], anchors: [], gateScore: 0.2, queryFallback: false });
  assert.equal(requests.length, 1, "zero extraction calls after a skip");
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
  assert.deepEqual(requests.map(request => new URL(request.url).pathname), ["/v1/decisions", "/v1/extractions"]);
});

test("gate and extraction failures fail open to deterministic fallback queries", async t => {
  const fallback = [fallbackQueries(conversation)];
  await t.test("gate http error searches every configured corpus without extracting", async t => {
    const requests = mockModel(t, { gate: () => new Response("upstream down", { status: 503 }) });
    const plan = await planRecall({ ...access, conversation, asOf, corpora: ["memory", "sessions"], signal: signal() });
    assert.equal(plan.shouldRecall, true);
    assert.equal(plan.queryFallback, true);
    assert.ok(plan.gateFallback);
    assert.deepEqual(plan.corpora, ["memory", "sessions"]);
    assert.deepEqual(plan.topics, fallback);
    assert.equal(requests.length, 1);
  });
  await t.test("gate timeout", async t => {
    mockModel(t, { gate: () => new Promise<Response>(() => {}) });
    const plan = await planRecall({ ...access, timeoutMs: 20, conversation, asOf, corpora: ["memory"], signal: signal() });
    assert.equal(plan.queryFallback, true);
    assert.ok(plan.gateFallback);
  });
  await t.test("extraction timeout", async t => {
    mockModel(t, { gate: () => noul({ need_recall: 0.9 }), extract: () => new Promise<Response>(() => {}) });
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
  mockModel(t, { gate: () => {
    controller.abort();
    return new Promise<Response>(() => {});
  } });
  await assert.rejects(planRecall({ ...access, conversation, asOf, corpora: ["memory"], signal: controller.signal }));
});
