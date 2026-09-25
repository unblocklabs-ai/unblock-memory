import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MlxQueryGenerator } from "../src/mlx-query.js";

test("query worker keeps usable strings and drops only exact duplicates", async t => {
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

  const first = "Alice mushrooms project information and current status";
  const second = "Alice mushrooms project project overview and current status";
  for (const [queries, expected] of [
    [[first, second, first], [first, second]],
    [[first, first, first], [first]],
    [[first], [first]],
    [[" Alice ", "Alice", "alice", "", null, 42], ["Alice", "alice"]],
    [["a", "b", "c", "d"], ["a", "b", "c", "d"]],
  ]) {
    assert.deepEqual(await generate(JSON.stringify({ queries })), expected);
  }
  for (const output of ['{"queries":', '{"queries":[null," "]}', '{"queries":"Alice"}']) {
    await assert.rejects(generate(output), /No usable generated queries/);
  }
});
