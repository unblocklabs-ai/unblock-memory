import assert from "node:assert/strict";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import test from "node:test";
import { o200kTokenCount } from "../src/o200k.js";
import { queryConversation } from "../src/query-generator.js";
import { prepareQueryConversation, queryTokenIds, serializeQueryConversation, QUERY_CONTRACT } from "../src/query-contract.js";

test("query budgets use o200k_base and encode special-token spellings as ordinary user text", () => {
  // o200k_base token IDs from the OpenAI cookbook's encoding comparison.
  assert.deepEqual(queryTokenIds("お誕生日おめでとう"), [8930, 9697, 243, 128225, 8930, 17693, 4344, 48669]);
  assert.deepEqual(queryTokenIds("<|endoftext|>"), [27, 91, 419, 1440, 919, 91, 29]);
});

test("bounded o200k encoding matches the reference on ordinary text and stays linear on long unbroken runs", () => {
  const reference = new Tiktoken(o200kBase);
  for (const text of [
    "お誕生日おめでとう", "<|endoftext|>", "",
    "The quick brown fox jumps over the lazy dog. Sarah's invoice INV-2207 is due 2026-11-30.\n\n  Indented  text\t😀",
    "Prose with https://example.com/a/b?c=d and snake_case_identifiers, plus 1234567890 digits. ".repeat(200),
  ]) {
    assert.deepEqual(queryTokenIds(text), reference.encode(text, [], []), JSON.stringify(text.slice(0, 40)));
  }
  const random = Buffer.from(Array.from({ length: 18_000 }, (_, i) => (i * 7919 + 13) % 256)).toString("base64");
  const adversarial = {
    "8 KiB letters": "a".repeat(8 * 1024),
    "20 KiB letters": "Zq".repeat(10 * 1024),
    "24 KiB base64": random.slice(0, 24 * 1024),
    "8 KiB spaces": " ".repeat(8 * 1024),
    "8 KiB CJK": "日本語".repeat(900),
    "20 KiB astral": "😀".repeat(5 * 1024),
    "embedded run": `Before ${"x".repeat(20 * 1024)} after.`,
  };
  for (const [name, text] of Object.entries(adversarial)) {
    const started = performance.now();
    const ids = queryTokenIds(text);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `${name} encoded in ${elapsed.toFixed(1)} ms`);
    assert.ok(ids.length > 0 && ids.length <= Buffer.byteLength(text), `${name} produced ${ids.length} tokens`);
    assert.equal(o200kTokenCount(text), ids.length);
    assert.equal(reference.decode(ids), text, `${name} chunks never split a scalar`);
  }
  // A long run is counted conservatively: never fewer tokens than the exact reference.
  const run = "a".repeat(1000);
  assert.ok(queryTokenIds(run).length >= reference.encode(run, [], []).length);
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
  const original = Tiktoken.prototype.encode;
  let tokenizedBytes = 0;
  const encode = t.mock.method(Tiktoken.prototype, "encode", function (this: Tiktoken, ...args: Parameters<Tiktoken["encode"]>) {
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
  const fits = "a ".repeat(7800);
  assert.equal(prepareQueryConversation([], fits).conversation.currentRequest, fits);
});

test("query preparation excludes mirrors, tools, synthetic turns and compacted history", () => {
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
  assert.deepEqual(queryConversation("Question now", messages), { history: [{ role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" }], currentRequest: "Question now" });
});

test("an oversized historical request does not bridge earlier context", () => {
  const messages = [
    { role: "user", content: "Before boundary" }, { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "a ".repeat(8300) }, { role: "assistant", content: "Answer after oversized request" },
    { role: "user", content: "Now" },
  ];
  assert.deepEqual(queryConversation("Now", messages).history, [{ role: "assistant", content: "Answer after oversized request" }]);
});
