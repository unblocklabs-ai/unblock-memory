import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApiQueryGenerator, QueryApiError } from "../src/query-generator.js";
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
  await assert.rejects(generate(AbortSignal.timeout(30)));
  await assert.rejects(new ApiQueryGenerator({ endpoint: "http://127.0.0.1" }).generate(
    { history: [], currentRequest: "Find Alice" }, AbortSignal.timeout(100)), /credentials/);
});

test("API defaults are off and Studio-bound; loopback override and legacy migration are safe", () => {
  const defaults = resolveConfig(undefined).memoryWhisperer;
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.api.endpoint, "http://192.168.1.191:18087");
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
