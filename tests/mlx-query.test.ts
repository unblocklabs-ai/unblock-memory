import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MlxQueryGenerator } from "../src/mlx-query.js";

test("query worker accepts only a complete v2 lex/vec pair and never salvages v1 output", async t => {
  const root = await mkdtemp(join(tmpdir(), "unblock-mlx-queries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = join(root, "worker.mjs");
  await writeFile(worker, `#!${process.execPath}
import { createInterface } from "node:readline";
console.log(JSON.stringify({ ready: true }));
for await (const line of createInterface({ input: process.stdin })) {
  const { id, conversation } = JSON.parse(line);
  if (conversation) console.log(JSON.stringify({ id, text: conversation.currentRequest, finish: "length" }));
}
`, { mode: 0o700 });
  const generator = new MlxQueryGenerator({ pythonPath: worker, modelPath: root });
  t.after(() => generator.close());
  const signal = AbortSignal.timeout(5000);
  const generate = (currentRequest: string) => generator.generate({ history: [], currentRequest }, signal);

  assert.deepEqual(await generate('{"lex":" Alice mushrooms ","vec":"Alice project current status"}'),
    { lex: "Alice mushrooms", vec: "Alice project current status" });
  // Identical wording is valid: the two fields still route to different backends.
  assert.deepEqual(await generate('{"lex":"Alice","vec":"Alice"}'), { lex: "Alice", vec: "Alice" });
  for (const output of ['{"queries":["Alice"]}', '{"lex":', '{"lex":"Alice"}',
    '{"lex":"Alice","vec":" "}', '{"lex":42,"vec":"Alice"}', '{"lex":"Alice","vec":"Alice","extra":true}']) {
    await assert.rejects(generate(output), /Invalid generated lex\/vec query pair/);
  }
});
