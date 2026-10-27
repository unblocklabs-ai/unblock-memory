import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QmdMemoryManager } from "../src/manager.js";
import { RetrievalTelemetry } from "../src/retrieval-telemetry.js";
import { WhispererDiagnostics } from "../src/diagnostics.js";

test("hot upgrades replace v1 shared telemetry and retain degraded measurements", () => {
  const scope = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const legacy = Symbol.for("unblock-memory.whisperer-diagnostics.v1");
  const previous = scope[legacy];
  const stale = { measureSearch() { throw new Error("legacy telemetry reused"); } };
  scope[legacy] = stale;
  try {
    const diagnostics = WhispererDiagnostics.shared();
    assert.notEqual(diagnostics, stale);
    diagnostics.measureSearch("hot-upgrade-test", { outcome: "degraded", elapsedMs: 1,
      fallbackAllJudgmentsFailed: 1, requestsFailed: 2 });
    const op = diagnostics.snapshot("hot-upgrade-test").telemetry.operations.memorySearch;
    assert.equal(op.outcomes.degraded, 1);
    assert.equal(op.measurements.fallbackAllJudgmentsFailed.total, 1);
    assert.equal(op.measurements.requestsFailed.total, 2);
  } finally {
    if (previous === undefined) delete scope[legacy]; else scope[legacy] = previous;
  }
});

test("retrieval telemetry bounds recent samples and computes percentiles", () => {
  const telemetry = new RetrievalTelemetry();
  for (let index = 1; index <= 260; index += 1) {
    telemetry.record("vector", { outcome: "ok", elapsedMs: index, contextChars: index, queueWaitMs: 260 - index });
  }
  const measurement = telemetry.snapshot().operations.vector.measurements.elapsedMs;
  assert.equal(measurement.samples, 260);
  assert.equal(measurement.recentSamples, 256);
  assert.equal(measurement.p50, 132);
  assert.equal(measurement.p95, 248);
  assert.equal(telemetry.snapshot().operations.vector.calls, 260);
  assert.deepEqual(telemetry.snapshot().operations.vector.slowestRecent.map(sample =>
    [sample.elapsedMs, sample.queueWaitMs, sample.outcome]),
  [[260, 0, "ok"], [259, 1, "ok"], [258, 2, "ok"], [257, 3, "ok"], [256, 4, "ok"]]);
  // Old outliers must leave with their original samples, not persist forever.
  for (let index = 0; index < 256; index++) telemetry.record("vector", { outcome: "empty", elapsedMs: 1 });
  assert.ok(telemetry.snapshot().operations.vector.slowestRecent.every(sample => sample.elapsedMs === 1));
});

test("invalid metric values are ignored without leaking content", () => {
  const telemetry = new RetrievalTelemetry();
  const observation = { outcome: "failed" as const, elapsedMs: 4, retrievalMs: -1,
    judgeMs: Number.NaN, candidates: Number.POSITIVE_INFINITY, contextChars: 3,
    // This value must never be represented by the snapshot, even if a caller casts at runtime.
    query: "private query", path: "/private/path", excerpt: "secret excerpt",
  } as unknown as Parameters<RetrievalTelemetry["record"]>[1];
  telemetry.record("vector", observation);
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.operations.vector.calls, 1);
  assert.equal(snapshot.operations.vector.measurements.retrievalMs.samples, 0);
  assert.equal(JSON.stringify(snapshot).includes("private query"), false);
  assert.equal(JSON.stringify(snapshot).includes("secret excerpt"), false);
  assert.equal(JSON.stringify(snapshot).includes("/private/path"), false);
  assert.deepEqual(snapshot.operations.vector.slowestRecent, [{ outcome: "failed", elapsedMs: 4, contextChars: 3 }]);
});

test("snapshots are detached and operations remain isolated", () => {
  const telemetry = new RetrievalTelemetry();
  telemetry.record("vector", { outcome: "empty", elapsedMs: 2 });
  telemetry.record("memoryWhisperer", { outcome: "ok", elapsedMs: 5, results: 1 });
  const snapshot = telemetry.snapshot();
  snapshot.operations.vector.calls = 900;
  snapshot.operations.vector.outcomes.empty = 900;
  snapshot.operations.vector.slowestRecent[0]!.elapsedMs = 900;
  assert.equal(telemetry.snapshot().operations.vector.calls, 1);
  assert.equal(telemetry.snapshot().operations.vector.outcomes.empty, 1);
  assert.equal(telemetry.snapshot().operations.vector.slowestRecent[0]!.elapsedMs, 2);
  assert.equal(telemetry.snapshot().operations.memoryWhisperer.calls, 1);
});

test("manager search telemetry is exposed through diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-telemetry-"));
  const manager = new QmdMemoryManager({ dbPath: join(root, "index.sqlite"), workspaceDir: root, sources: [] });
  try {
    assert.deepEqual(await manager.search("empty"), []);
    const retrieval = (await manager.diagnostics()).retrieval;
    assert.equal(retrieval.operations.vector.outcomes.empty, 1);
  } finally {
    await manager.close();
  }
});
