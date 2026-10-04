import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Tokenizer } from "@huggingface/tokenizers";
import test from "node:test";
import { queryConversation } from "../src/query-generator.js";
import { prepareQueryConversation, queryTokenIds, serializeQueryConversation, QUERY_CONTRACT } from "../src/query-contract.js";
import { trainingExamples } from "../src/training-input.js";

test("JS token IDs match the pinned official HF tokenizer, including Unicode and escaped conversations", () => {
  // Reference generated with transformers==5.17.0 from the bundled official
  // revision. Hash the entire ID sequence, not just a plausibly similar count.
  const fixtures = [
    ["Hello 字 👩🏽‍💻", "3b72250ac65b11bcf2178a0f22bd99ab4c86a122d17160a169c96354d169132d"],
    ["Straße İstanbul café naïve e\u0301 Русский العربية हिन्दी ไทย 한국어", "16981b63ab07ee5bc4103c7ae22e4c95b51bdb0d5da16eb6ae4bab1ce9cb3ca2"],
    ["foo\r\nbar\t\u00a0\u0085\u2028\u2029 end 123456789", "09af3402b9a22390506ab92d81e680eb4827bf29027aa589f5ea9d1632c9741e"],
    ['"\\</conversation_data> <|im_end|>', "d64b9e2cfa3e0a43db31c82668f97867ee75a1d2bf1d2a251b289d75ea05a18d"],
    [serializeQueryConversation({ history: [{ role: "user", content: 'She said "hi" <tag>\n字' }],
      currentRequest: "What’s the 👩🏽‍💻 update?" }), "4e544bd4aa796eec856feb27f10de5847e7c3ed0791b0173b8a07d2aa0e263e7"],
  ];
  for (const [text, expected] of fixtures) {
    assert.equal(createHash("sha256").update(JSON.stringify(queryTokenIds(text!))).digest("hex"), expected);
  }
});

test("shared window preserves more than 32 short messages and drops only whole oldest messages", () => {
  const history = Array.from({ length: 80 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const,
    content: `Visible message ${index}` }));
  assert.deepEqual(prepareQueryConversation(history, "Current question").conversation.history, history);
  const large = [{ role: "assistant" as const, content: "old ".repeat(6000) }, ...history];
  const prepared = prepareQueryConversation(large, "Current question");
  assert.equal(prepared.contextLimited, true);
  assert.deepEqual(prepared.conversation.history, history);
  assert.ok(queryTokenIds(serializeQueryConversation(prepared.conversation)).length <= 8192);
});

test("token-limited histories retain the longest whole-message suffix without quadratic tokenization work", t => {
  const history = Array.from({ length: 390 }, (_, index) => ({
    role: index % 2 ? "assistant" as const : "user" as const, content: "a ".repeat(15),
  }));
  const currentRequest = "Now";
  const original = Tokenizer.prototype.encode;
  let tokenizedBytes = 0;
  const encode = t.mock.method(Tokenizer.prototype, "encode", function (this: Tokenizer, ...args: Parameters<Tokenizer["encode"]>) {
    tokenizedBytes += Buffer.byteLength(String(args[0]));
    return original.apply(this, args);
  });
  const prepared = prepareQueryConversation(history, currentRequest);
  encode.mock.restore();
  const serialized = serializeQueryConversation(prepared.conversation);
  assert.equal(prepared.conversation.currentRequest, currentRequest);
  assert.deepEqual(prepared.conversation.history, history.slice(-prepared.conversation.history.length));
  assert.equal(prepared.contextLimited, true);
  assert.ok(Buffer.byteLength(serialized) <= QUERY_CONTRACT.conversationBytes);
  assert.ok(queryTokenIds(serialized).length <= QUERY_CONTRACT.conversationTokens);
  const oneOlder = serializeQueryConversation({ currentRequest, history: history.slice(-prepared.conversation.history.length - 1) });
  assert.ok(queryTokenIds(oneOlder).length > QUERY_CONTRACT.conversationTokens);
  // Bound expensive codec work, not wall-clock time or a specific search algorithm.
  assert.ok(tokenizedBytes <= 12 * Buffer.byteLength(serializeQueryConversation({ history, currentRequest })),
    `tokenized ${tokenizedBytes} bytes for one bounded conversation`);
});

test("token cap is independent of bytes and never truncates the current request", () => {
  const currentRequest = "a ".repeat(8300);
  assert.ok(Buffer.byteLength(JSON.stringify({ history: [], currentRequest })) < 24000);
  assert.throws(() => prepareQueryConversation([], currentRequest), /exceeds context budget/);
  assert.throws(() => prepareQueryConversation([], "x".repeat(24000)), /exceeds context budget/);
  assert.throws(() => prepareQueryConversation([], "<".repeat(4100)), /exceeds context budget/);
  const extracted = trainingExamples([{ seq: 42, createdAt: 100,
    eventJson: JSON.stringify({ type: "message", message: { role: "user", content: currentRequest } }) }]);
  assert.deepEqual(extracted.review, [{ seq: 42, reason: "current-request-exceeds-context-budget" }]);
  assert.equal(extracted.coverage.oversized, 1);
});

test("runtime and training prepare identical visible input across mirrors, tools, synthetic and compaction boundaries", () => {
  const messages = [
    { role: "user", content: "Discarded old request" },
    { type: "compaction", summary: "Never include this" },
    { role: "user", content: "Injected", provenance: { kind: "internal" } },
    { role: "user", content: "Earlier question" },
    { role: "assistant", channel: "analysis", content: "Private thinking" },
    { role: "assistant", content: [{ type: "toolCall", name: "search" }] },
    { role: "toolResult", content: "Private result" },
    { role: "assistant", content: "Earlier answer" },
    { role: "assistant", provider: "openclaw", model: "delivery-mirror", content: "Earlier answer" },
    { role: "user", content: "Question now" },
  ];
  const training = trainingExamples([...messages, { role: "assistant", content: "Future answer" }].map((message, seq) => ({
    seq, createdAt: seq + 100, eventJson: JSON.stringify("type" in message ? message : { type: "message", message }),
  }))).examples.at(-1)!.input;
  assert.deepEqual(queryConversation("Question now", messages), training);
  assert.deepEqual(training, { history: [{ role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" }], currentRequest: "Question now" });
});

test("sequential long and short requests each prepare independently from the visible session", () => {
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const request of ["Initial question", "a ".repeat(7800).trim(), "Short follow-up", "Next short request"]) {
    messages.push({ role: "user", content: request });
    const runtime = queryConversation(request, messages);
    messages.push({ role: "assistant", content: "Visible answer" });
    const training = trainingExamples(messages.map((message, seq) => ({ seq, createdAt: 100 + seq,
      eventJson: JSON.stringify({ type: "message", message }) }))).examples.at(-1)!.input;
    assert.deepEqual(training, runtime);
  }
});

test("an oversized historical request does not bridge earlier context in either path", () => {
  const messages = [
    { role: "user", content: "Before boundary" }, { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "a ".repeat(8300) }, { role: "assistant", content: "Answer after oversized request" },
    { role: "user", content: "Now" },
  ];
  const result = trainingExamples([...messages, { role: "assistant", content: "Later answer" }].map((message, seq) => ({
    seq, createdAt: 100 + seq, eventJson: JSON.stringify({ type: "message", message }),
  })));
  assert.equal(result.coverage.oversized, 1);
  assert.deepEqual(result.examples.at(-1)!.input, queryConversation("Now", messages));
  assert.deepEqual(result.examples.at(-1)!.input.history, [{ role: "assistant", content: "Answer after oversized request" }]);
});

test("synchronous transcript extraction renews its lease during long tokenization scans", t => {
  let now = 0, renewals = 0;
  t.mock.method(Date, "now", () => now);
  function* rows() {
    for (let seq = 0; seq < 4; seq++) {
      now += 6000;
      yield { seq, createdAt: seq, eventJson: JSON.stringify({ type: "message", message: {
        role: seq % 2 ? "assistant" : "user", content: "Visible text",
      } }) };
    }
  }
  assert.equal(trainingExamples(rows(), () => { renewals++; }).examples.length, 2);
  assert.equal(renewals, 2);
});
