import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore, type QMDStore } from "@unblocklabs/qmd";
import {
  clusterReference,
  ensureMemoryAnalysisSchema,
  markMemoryAnalysisStale,
  readAnalysisSummary,
  readCluster,
  readClusters,
  runAnalysisWorker,
} from "../src/analysis.js";

type AnalysisDatabase = QMDStore["internal"]["db"];

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function insertChunk(db: AnalysisDatabase, hash: string, text: string, active = 1): void {
  db.prepare("INSERT INTO content(hash, doc, created_at) VALUES (?, ?, ?)").run(hash, text, "now");
  db.prepare(`INSERT INTO documents(collection, path, title, hash, created_at, modified_at, active)
    VALUES ('memory', ?, 'Memory', ?, 'now', 'now', ?)`).run(`${hash}.md`, hash, active);
  db.prepare(`INSERT INTO content_vectors(hash, seq, pos, chunk_len, model, embed_fingerprint, total_chunks, embedded_at)
    VALUES (?, 0, 0, ?, 'model', 'fingerprint', 1, 'now')`).run(hash, text.length);
}

function insertRun(db: AnalysisDatabase, id = "run", completedAt = "2026-08-24T10:00:00Z"): void {
  db.prepare(`INSERT INTO memory_analysis_runs
    (id, created_at, completed_at, input_digest, model, embedding_fingerprint, dimensions, params_json, stale_at)
    VALUES (?, ?, ?, 'digest', 'model', 'fingerprint', 768, '{}', NULL)`)
    .run(id, completedAt, completedAt);
}

test("creates only the clean analysis schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-schema-"));
  const store = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  try {
    const db = store.internal.db;
    ensureMemoryAnalysisSchema(db);
    const rows = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'memory_analysis_%'
      ORDER BY name
    `).all<{ name: string }>();
    assert.deepEqual(rows.map((row) => row.name), [
      "memory_analysis_clusters",
      "memory_analysis_memberships",
      "memory_analysis_runs",
    ]);
    const views = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'view' AND name LIKE 'memory_analysis_%'
      ORDER BY name
    `).all<{ name: string }>();
    assert.deepEqual(views.map((row) => row.name), ["memory_analysis_available_memberships"]);
    const runColumns = db.prepare("PRAGMA table_info(memory_analysis_runs)").all<{ name: string }>();
    assert.ok(runColumns.some((column) => column.name === "stale_at"));
    const membershipColumns = db.prepare("PRAGMA table_info(memory_analysis_memberships)").all<{ name: string }>();
    assert.ok(!membershipColumns.some((column) => column.name === "is_noise"));
    const foreignKeys = db.prepare("PRAGMA foreign_key_list(memory_analysis_memberships)")
      .all<{ table: string }>();
    assert.deepEqual([...new Set(foreignKeys.map((key) => key.table))], ["memory_analysis_runs"]);
  } finally {
    await store.close();
  }
});

test("rejects an incomplete latest run for summary, list, and fetch reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-invalid-analysis-"));
  const store = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  try {
    const db = store.internal.db;
    ensureMemoryAnalysisSchema(db);
    insertChunk(db, "hash", "memory");
    insertRun(db);
    db.prepare("INSERT INTO memory_analysis_clusters VALUES ('run', 1, 2, 0.9)").run();
    db.prepare("INSERT INTO memory_analysis_memberships VALUES ('run', 'hash', 0, 1, 0.9, 0.1, 0, 0, 1)").run();

    assert.equal(readAnalysisSummary(db), undefined);
    assert.equal(readClusters(db).status, "not_analyzed");
    assert.equal(readCluster(db, clusterReference("run", 1)).status, "not_analyzed");
  } finally {
    await store.close();
  }
});

test("excludes inactive QMD documents from cluster members and availability", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-inactive-analysis-"));
  const store = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  try {
    const db = store.internal.db;
    ensureMemoryAnalysisSchema(db);
    for (const [hash, active] of [
      ["active", 1],
      ["inactive", 0],
      ["active-noise", 1],
      ["inactive-noise", 0],
    ] as const) {
      insertChunk(db, hash, `${hash} context`, active);
    }
    insertRun(db);
    db.prepare("INSERT INTO memory_analysis_clusters VALUES ('run', 4, 2, 0.8)").run();
    const insertMembership = db.prepare(`INSERT INTO memory_analysis_memberships
      VALUES ('run', ?, 0, ?, ?, ?, 1.0, 2.0, ?)`);
    insertMembership.run("active", 4, 0.99, 0.01, 1);
    insertMembership.run("inactive", 4, 0.5, 0.5, 2);
    insertMembership.run("active-noise", -1, 0, 0.4, null);
    insertMembership.run("inactive-noise", -1, 0, 0.9, null);

    const listed = readClusters(db);
    assert.equal(listed.clusters[0]?.size, 2);
    assert.equal(listed.clusters[0]?.availableSize, 1);
    assert.equal(listed.clusters[0]?.preview?.hash, "active");
    assert.equal(listed.noise?.size, 2);
    assert.equal(listed.noise?.availableSize, 1);

    const cluster = readCluster(db, listed.clusters[0]!.clusterId);
    assert.deepEqual(cluster.members?.map((member) => member.hash), ["active"]);
    const noise = readCluster(db, listed.noise!.clusterId);
    assert.deepEqual(noise.members?.map((member) => member.hash), ["active-noise"]);
  } finally {
    await store.close();
  }
});

test("lists short cluster references and fetches representative and noise members in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-read-analysis-"));
  const store = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  try {
    const db = store.internal.db;
    ensureMemoryAnalysisSchema(db);
    for (const hash of ["rank-two", "rank-one", "unranked", "noise-low", "noise-high"]) {
      insertChunk(db, hash, `${hash} context `.repeat(300));
    }
    insertRun(db);
    db.prepare("INSERT INTO memory_analysis_clusters VALUES ('run', 4, 3, 0.8)").run();
    const insertMembership = db.prepare(`INSERT INTO memory_analysis_memberships
      VALUES ('run', ?, 0, ?, ?, ?, 1.0, 2.0, ?)`);
    insertMembership.run("rank-two", 4, 0.99, 0.01, 2);
    insertMembership.run("rank-one", 4, 0.5, 0.5, 1);
    insertMembership.run("unranked", 4, 0.9, 0.1, null);
    insertMembership.run("noise-low", -1, 0, 0.4, null);
    insertMembership.run("noise-high", -1, 0, 0.9, null);

    assert.equal(readAnalysisSummary(db)?.members, 5);
    const listed = readClusters(db);
    assert.equal(listed.status, "ok");
    assert.equal(listed.stale, false);
    assert.equal(listed.analyzedAt, "2026-08-24T10:00:00Z");
    assert.match(listed.clusters[0]?.clusterId ?? "", /^[0-9a-f]{10}$/);
    assert.equal(listed.clusters[0]?.preview?.hash, "rank-one");
    assert.equal(listed.clusters[0]?.availableSize, 3);
    assert.match(listed.noise?.clusterId ?? "", /^[0-9a-f]{10}$/);

    const cluster = readCluster(db, listed.clusters[0]!.clusterId, 20);
    assert.deepEqual(cluster.members?.map((member) => member.hash), ["rank-one", "rank-two", "unranked"]);
    assert.ok(cluster.members?.every((member) => Buffer.byteLength(member.text) <= 2_000));
    assert.ok((cluster.members?.reduce((sum, member) => sum + Buffer.byteLength(member.text), 0) ?? 0) <= 12_000);

    const noise = readCluster(db, listed.noise!.clusterId, 20);
    assert.deepEqual(noise.members?.map((member) => member.hash), ["noise-high", "noise-low"]);
  } finally {
    await store.close();
  }
});

test("retains stale memberships when QMD content disappears and reports availableSize", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-stale-read-"));
  const store = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  try {
    const db = store.internal.db;
    ensureMemoryAnalysisSchema(db);
    insertChunk(db, "kept", "kept memory");
    insertChunk(db, "deleted", "deleted memory");
    insertRun(db);
    db.prepare("INSERT INTO memory_analysis_clusters VALUES ('run', 1, 2, 0.9)").run();
    db.prepare(`INSERT INTO memory_analysis_memberships VALUES
      ('run', 'kept', 0, 1, 0.9, 0.1, 0, 0, 1),
      ('run', 'deleted', 0, 1, 0.8, 0.2, 0, 0, 2)`).run();

    markMemoryAnalysisStale(db);
    const staleAt = db.prepare("SELECT stale_at FROM memory_analysis_runs WHERE id = 'run'")
      .get<{ stale_at: string }>()?.stale_at;
    assert.ok(staleAt);
    markMemoryAnalysisStale(db);
    assert.equal(db.prepare("SELECT stale_at FROM memory_analysis_runs WHERE id = 'run'")
      .get<{ stale_at: string }>()?.stale_at, staleAt);

    db.prepare("DELETE FROM content_vectors WHERE hash = 'deleted'").run();
    const listed = readClusters(db);
    assert.equal(listed.stale, true);
    assert.equal(listed.staleSince, staleAt);
    assert.match(listed.hint ?? "", /memory_recluster/);
    assert.equal(listed.clusters[0]?.size, 2);
    assert.equal(listed.clusters[0]?.availableSize, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_analysis_memberships")
      .get<{ count: number }>()?.count, 2);

    const detail = readCluster(db, listed.clusters[0]!.clusterId, 20);
    assert.equal(detail.cluster?.availableSize, 1);
    assert.deepEqual(detail.members?.map((member) => member.hash), ["kept"]);
  } finally {
    await store.close();
  }
});

test("cluster references are deterministic within a run and rejected after a new run", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-cluster-reference-"));
  const store = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  try {
    const db = store.internal.db;
    ensureMemoryAnalysisSchema(db);
    insertChunk(db, "hash", "memory");
    insertRun(db, "run-one", "2026-08-24T10:00:00Z");
    db.prepare("INSERT INTO memory_analysis_clusters VALUES ('run-one', 7, 1, 0.9)").run();
    db.prepare("INSERT INTO memory_analysis_memberships VALUES ('run-one', 'hash', 0, 7, 0.9, 0.1, 0, 0, 1)").run();
    const oldReference = readClusters(db).clusters[0]!.clusterId;
    assert.equal(oldReference, clusterReference("run-one", 7));

    insertRun(db, "run-two", "2026-08-24T11:00:00Z");
    db.prepare("INSERT INTO memory_analysis_clusters VALUES ('run-two', 7, 1, 0.9)").run();
    db.prepare("INSERT INTO memory_analysis_memberships VALUES ('run-two', 'hash', 0, 7, 0.9, 0.1, 0, 0, 1)").run();
    const newReference = readClusters(db).clusters[0]!.clusterId;
    assert.notEqual(newReference, oldReference);
    const oldFetch = readCluster(db, oldReference);
    assert.equal(oldFetch.status, "not_found");
    assert.match(oldFetch.hint ?? "", /memory_list_clusters/);
  } finally {
    await store.close();
  }
});

test("spawns the configured executable with fixed database and optional config arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-worker-"));
  const executable = join(root, "worker with spaces");
  const capture = join(root, "args.txt");
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture}'\n`);
  await chmod(executable, 0o700);
  await runAnalysisWorker({ executable, dbPath: "/tmp/index path.sqlite" });
  assert.equal(await readFile(capture, "utf8"), "--db\n/tmp/index path.sqlite\n");

  const options = {
    space: { method: "none" as const, nComponents: 20 },
    hdbscan: { minClusterSize: 12, clusterSelectionMethod: "leaf" as const },
    seed: 7,
  };
  await runAnalysisWorker({ executable, dbPath: "/tmp/index path.sqlite", options });
  assert.equal(
    await readFile(capture, "utf8"),
    `--db\n/tmp/index path.sqlite\n--config-json\n${JSON.stringify(options)}\n`,
  );
});

test("aborting reclustering terminates the worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-worker-abort-"));
  const executable = join(root, "worker");
  const ready = join(root, "ready.txt");
  const stopped = join(root, "stopped.txt");
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(stopped)}, "stopped");
  setTimeout(() => process.exit(0), 50);
});
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1_000);
`);
  await chmod(executable, 0o700);
  const controller = new AbortController();
  const listenerCount = getEventListeners(controller.signal, "abort").length;
  const pending = runAnalysisWorker({ executable, dbPath: join(root, "index.sqlite"), signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, listenerCount + 1);
  await waitForFile(ready);
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  assert.equal(await readFile(stopped, "utf8"), "stopped");
  assert.equal(getEventListeners(controller.signal, "abort").length, listenerCount);
});
