import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QmdMemoryManager } from "../src/manager.js";
import { RetrievalTelemetry } from "../src/retrieval-telemetry.js";

test("retrieval telemetry bounds recent samples and computes percentiles", () => {
  const telemetry = new RetrievalTelemetry();
  for (let index = 1; index <= 260; index += 1) {
    telemetry.record("vector", { outcome: "ok", elapsedMs: index, contextChars: index });
  }
  const measurement = telemetry.snapshot().operations.vector.measurements.elapsedMs;
  assert.equal(measurement.samples, 260);
  assert.equal(measurement.recentSamples, 256);
  assert.equal(measurement.p50, 132);
  assert.equal(measurement.p95, 248);
  assert.equal(telemetry.snapshot().operations.vector.calls, 260);
});

test("invalid metric values are ignored without leaking content", () => {
  const telemetry = new RetrievalTelemetry();
  const observation = { outcome: "failed" as const, elapsedMs: 4, retrievalMs: -1,
    judgeMs: Number.NaN, candidates: Number.POSITIVE_INFINITY, contextChars: 3,
    // This value must never be represented by the snapshot, even if a caller casts at runtime.
    query: "private query", path: "/private/path", excerpt: "secret excerpt",
  } as unknown as Parameters<RetrievalTelemetry["record"]>[1];
  telemetry.record("lexical", observation);
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.operations.lexical.calls, 1);
  assert.equal(snapshot.operations.lexical.measurements.retrievalMs.samples, 0);
  assert.equal(JSON.stringify(snapshot).includes("private query"), false);
  assert.equal(JSON.stringify(snapshot).includes("secret excerpt"), false);
});

test("snapshots are detached and operations remain isolated", () => {
  const telemetry = new RetrievalTelemetry();
  telemetry.record("vector", { outcome: "empty", elapsedMs: 2 });
  telemetry.record("memoryWhisperer", { outcome: "ok", elapsedMs: 5, results: 1 });
  const snapshot = telemetry.snapshot();
  snapshot.operations.vector.calls = 900;
  snapshot.operations.vector.outcomes.empty = 900;
  assert.equal(telemetry.snapshot().operations.vector.calls, 1);
  assert.equal(telemetry.snapshot().operations.vector.outcomes.empty, 1);
  assert.equal(telemetry.snapshot().operations.memoryWhisperer.calls, 1);
  assert.equal(telemetry.snapshot().operations.lexical, undefined);
});

test("manager search telemetry is exposed through diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-telemetry-"));
  const manager = new QmdMemoryManager({ dbPath: join(root, "index.sqlite"), workspaceDir: root, sources: [] });
  try {
    assert.deepEqual(await manager.search("empty"), []);
    assert.deepEqual(await manager.search("empty", { lexicalOnly: true }), []);
    const retrieval = (await manager.diagnostics()).retrieval;
    assert.equal(retrieval.operations.vector.outcomes.empty, 1);
    assert.equal(retrieval.operations.lexical.outcomes.empty, 1);
  } finally {
    await manager.close();
  }
});
