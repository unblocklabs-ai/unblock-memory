import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "@unblocklabs/qmd";
import { ApiQueryGenerator, compactJudgeConversation, fallbackQueries, QueryApiError } from "../src/query-generator.js";
import { resolveConfig } from "../src/config.js";

test("query API uses authenticated HTTP, validates pairs and IDs, rejects redirects/errors, and cancels", async t => {
  const root = await mkdtemp(join(tmpdir(), "unblock-query-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const apiKeyFile = join(root, "token");
  await writeFile(apiKeyFile, "private-test-token\n", { mode: 0o600 });
  let mode = "ok", calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, "/generate");
    assert.equal(req.headers.authorization, "Bearer private-test-token");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const { id, conversation } = JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(conversation, { history: [], currentRequest: "Find Alice" });
    if (mode === "wait") return;
    if (mode === "mid-body") { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"response":'); return; }
    if (mode === "redirect") { res.writeHead(307, { Location: "/secret-target" }); res.end(); return; }
    if (mode === "busy") { res.writeHead(503); res.end("private failure text"); return; }
    if (mode === "oversized") { res.end("x".repeat(20_000)); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ response: { id: mode === "wrong-id" ? "wrong" : id,
      text: mode === "ok" || mode === "wrong-id" ? '{"lex":" Alice ","vec":"Alice project status"}' : mode } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const generator = new ApiQueryGenerator({ endpoint: `http://127.0.0.1:${address.port}`, apiKeyFile });
  const generate = (signal = AbortSignal.timeout(1000)) => generator.generate({ history: [], currentRequest: "Find Alice" }, signal);
  assert.deepEqual(await generate(), { lex: "Alice", vec: "Alice project status" });
  for (mode of ["wrong-id", "oversized", "redirect", "busy", '{"queries":["Alice"]}', '{"lex":',
    '{"lex":"Alice"}', '{"lex":"Alice","vec":" "}', '{"lex":42,"vec":"Alice"}',
    '{"lex":"Alice","vec":"Alice","extra":true}']) {
    await assert.rejects(generate(), (error: unknown) => {
      assert.ok(error instanceof QueryApiError);
      assert.doesNotMatch(error.message, /private|Alice|secret-target/);
      if (mode === "busy") assert.equal(error.status, 503);
      return true;
    });
  }
  const previous = calls;
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(generate(cancelled.signal));
  assert.equal(calls, previous);
  mode = "wait";
  await assert.rejects(generate(AbortSignal.timeout(30)), (error: unknown) =>
    error instanceof QueryApiError && error.code === "timeout");
  mode = "mid-body";
  await assert.rejects(generate(AbortSignal.timeout(30)), (error: unknown) =>
    error instanceof QueryApiError && error.code === "timeout");
  const expired = AbortSignal.timeout(1);
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(generate(expired), (error: unknown) =>
    error instanceof QueryApiError && error.code === "timeout");
  await assert.rejects(new ApiQueryGenerator({ endpoint: "http://127.0.0.1" }).generate(
    { history: [], currentRequest: "Find Alice" }, AbortSignal.timeout(100)), /credentials/);
});

test("fallbackQueries extracts clean lex/vec queries and handles terse, stopword, blob, emoji, and long requests", async () => {
  const cold = fallbackQueries({ history: [], currentRequest: "Whats the best way to make you an MCP connector?" });
  assert.equal(cold.lex, "best way MCP connector");
  assert.equal(cold.vec, "Whats the best way to make you an MCP connector?");

  const terse = fallbackQueries({
    history: [
      { role: "user", content: "Check Monday's Casey deck on MCP relay" },
      { role: "assistant", content: "Sure, looking into it." },
    ],
    currentRequest: "follow up on that",
  });
  assert.match(terse.lex, /\bfollow\b/);
  assert.match(terse.lex, /\bMonday\b/);
  assert.match(terse.lex, /\bCasey\b/);
  assert.doesNotMatch(terse.lex, /\bSure\b/);
  assert.match(terse.vec, /Casey deck/);
  assert.match(terse.vec, /follow up on that/);

  const stopwords = fallbackQueries({ history: [], currentRequest: "what do you think?" });
  assert.ok(stopwords.lex.length > 0);
  assert.equal(stopwords.vec, "what do you think?");

  const punctuation = fallbackQueries({ history: [], currentRequest: "???" });
  assert.equal(punctuation.lex, "???");
  assert.equal(punctuation.vec, "???");

  const long = fallbackQueries({ history: [], currentRequest: "token ".repeat(200) });
  assert.ok(long.vec.length <= 450);
  assert.ok(long.lex.length <= 256);
  assert.ok(long.lex.split(" ").length <= 12);

  // Unbroken 15k-char tokens in currentRequest or history stay well below QMD's 12,000-char limit.
  const blobRequest = fallbackQueries({ history: [], currentRequest: "a".repeat(15_000) });
  assert.ok(blobRequest.lex.length > 0 && blobRequest.lex.length <= 256);
  assert.ok(blobRequest.vec.length > 0 && blobRequest.vec.length <= 450);
  const blobHistory = fallbackQueries({
    history: [{ role: "user", content: "a".repeat(15_000) }],
    currentRequest: "explain that",
  });
  assert.equal(blobHistory.lex, "explain");
  assert.ok(blobHistory.vec.length <= 450);
  const qmd = await createStore({ dbPath: ":memory:", config: { collections: {} } });
  try {
    assert.deepEqual(await qmd.discoverCandidates({ query: blobRequest.lex, lane: "lex", limit: 10 }), []);
    assert.deepEqual(await qmd.discoverCandidates({ query: blobHistory.lex, lane: "lex", limit: 10 }), []);
  } finally { await qmd.close(); }

  // Surrogate-pair emoji never get split across slice boundaries.
  const isWellFormed = (value: string) => !/(?:^|[^\ud800-\udbff])[\udc00-\udfff]|[\ud800-\udbff](?:$|[^\udc00-\udfff])/.test(value);
  const emojiVec = fallbackQueries({ history: [], currentRequest: `A${"🚀".repeat(300)}` });
  assert.equal(isWellFormed(emojiVec.vec), true);
  assert.ok(emojiVec.vec.length <= 450);
  const emojiLex = fallbackQueries({ history: [], currentRequest: `!${"🚀".repeat(200)}` });
  assert.equal(isWellFormed(emojiLex.lex), true);
  assert.ok(emojiLex.lex.length <= 256);
  const emojiHistory = fallbackQueries({
    history: [{ role: "user", content: `H${"🚀".repeat(300)}` }],
    currentRequest: "ok?",
  });
  assert.equal(isWellFormed(emojiHistory.vec), true);
  assert.throws(() => fallbackQueries({ history: [], currentRequest: "   " }), /Missing or unparseable/);
});

test("compactJudgeConversation caps history to two messages, 1500 total chars, and preserves valid UTF-16 surrogates", () => {
  const isWellFormed = (value: string) => !/(?:^|[^\ud800-\udbff])[\udc00-\udfff]|[\ud800-\udbff](?:$|[^\udc00-\udfff])/.test(value);
  const short = compactJudgeConversation({
    history: [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ],
    currentRequest: "now",
  });
  assert.deepEqual(short, {
    history: [{ role: "assistant", content: "second" }, { role: "user", content: "third" }],
    currentRequest: "now",
  });

  const hugeHistory = compactJudgeConversation({
    history: [{ role: "assistant", content: `START ${"a".repeat(3000)} END` }],
    currentRequest: "what about that?",
  });
  assert.equal(hugeHistory.history.length, 1);
  assert.match(hugeHistory.history[0]!.content, /^START/);
  assert.match(hugeHistory.history[0]!.content, /END$/);
  assert.ok(hugeHistory.currentRequest.length + hugeHistory.history[0]!.content.length <= 1_500);

  const hugeRequest = compactJudgeConversation({
    history: [{ role: "user", content: "ignored because budget full" }],
    currentRequest: `OPEN ${"x".repeat(4000)} QUESTION?`,
  });
  assert.deepEqual(hugeRequest.history, []);
  assert.ok(hugeRequest.currentRequest.length <= 1_500);
  assert.match(hugeRequest.currentRequest, /^OPEN/);
  assert.match(hugeRequest.currentRequest, /QUESTION\?$/);

  const emojiHistory = compactJudgeConversation({
    history: [{ role: "user", content: "🚀".repeat(100) }],
    currentRequest: "x".repeat(1419),
  });
  assert.equal(isWellFormed(emojiHistory.history[0]!.content), true);
  assert.ok(emojiHistory.currentRequest.length + emojiHistory.history[0]!.content.length <= 1_500);

  const emojiRequest = compactJudgeConversation({
    history: [],
    currentRequest: `A${"🚀".repeat(800)}`,
  });
  assert.equal(isWellFormed(emojiRequest.currentRequest), true);
  assert.ok(emojiRequest.currentRequest.length <= 1_500);
});

test("API defaults to no endpoint; loopback override and legacy migration are safe", () => {
  const defaults = resolveConfig(undefined).memoryWhisperer;
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.api.endpoint, "");
  const local = resolveConfig({ memoryWhisperer: { api: { endpoint: "http://127.0.0.1:18087/", apiKeyFile: "/token" },
    mlx: { pythonPath: "/old/python", modelPath: "/old/model" } } }).memoryWhisperer;
  assert.deepEqual(local.api, { endpoint: "http://127.0.0.1:18087", apiKeyFile: "/token" });
  assert.equal("mlx" in local, false);
  for (const api of [null, [], "bad", { endpoint: "file:///model" }, { endpoint: "http://user:secret@host" },
    { endpoint: "http://host?token=secret" }, { endpoint: "http://host#fragment" }, { endpoint: 12 },
    { apiKeyFile: "relative" }, { unknown: true }]) {
    assert.throws(() => resolveConfig({ memoryWhisperer: { api } }), /memoryWhisperer.api/);
  }
});
