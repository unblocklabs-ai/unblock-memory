import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { QmdMemoryRuntime, recoverInterruptedSessionSync } from "../src/runtime.js";

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(5);
  }
}

const active = { cfg: {} as OpenClawConfig, agentId: "main" };
const sessionCorpora = [{
  name: "sessions",
  kind: "sessions",
  chatTypes: ["channel", "group"],
}] as const;

test("classifies only canonical workspace memory as trusted", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "unblock-memory-provenance-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "unblock-memory-provenance-outside-"));
  await mkdir(join(workspaceDir, "memory", "dreaming"), { recursive: true });
  await writeFile(join(workspaceDir, "MEMORY.md"), "root memory\n");
  await writeFile(join(workspaceDir, "notes.md"), "ordinary notes\n");
  await writeFile(join(workspaceDir, "memory", "today.md"), "daily memory\n");
  await writeFile(join(workspaceDir, "memory", "dreaming", "report.md"), "dream\n");
  const outsidePath = join(outsideDir, "outside.md");
  await writeFile(outsidePath, "outside\n");
  await symlink(outsidePath, join(workspaceDir, "memory", "linked.md"));

  const runtime = new QmdMemoryRuntime([]);
  const results = await runtime.classifyWorkspaceMemoryPaths({
    cfg: {} as OpenClawConfig,
    agentId: "main",
    workspaceDir,
    relativePaths: [
      "MEMORY.md",
      "notes.md",
      "memory/today.md",
      "memory/dreaming/report.md",
      "memory/linked.md",
      "missing.md",
    ],
  });

  assert.deepEqual(results, [
    { relativePath: "MEMORY.md", originClass: "agent" },
    { relativePath: "notes.md", originClass: "untrusted" },
    { relativePath: "memory/today.md", originClass: "agent" },
    { relativePath: "memory/dreaming/report.md", originClass: "system" },
    { relativePath: "memory/linked.md", originClass: "untrusted" },
    { relativePath: "missing.md", originClass: "untrusted" },
  ]);
});

test("reports session sync unavailable when sessions are not configured", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-unavailable-"));
  const runtime = new QmdMemoryRuntime([], undefined, stateRoot);
  assert.deepEqual(await runtime.startSessionSync(active), {
    status: "unavailable",
    error: 'memory session sync requires a configured "sessions" corpus',
  });
  assert.deepEqual(await runtime.sessionSyncStatus(active.agentId), { status: "idle" });
});

test("shares running and completed session sync status across runtime instances", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-status-"));
  const runtime = new QmdMemoryRuntime(sessionCorpora, undefined, stateRoot);
  const reloadedRuntime = new QmdMemoryRuntime(sessionCorpora, undefined, stateRoot);
  let releaseManager = () => {};
  const managerGate = new Promise<void>((resolve) => { releaseManager = resolve; });
  let releaseSync = () => {};
  const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
  const result = {
    scanned: 1,
    unchanged: 0,
    updated: 1,
    removed: 0,
    skipped: 0,
    failed: 0,
    embedded: 2,
    lastSuccessfulSyncAt: Date.now(),
  };
  Object.defineProperty(runtime, "getMemorySearchManager", {
    value: async () => {
      await managerGate;
      return {
        manager: {
          async syncSessions(
            force: boolean,
            onPhase: (phase: "projecting" | "indexing") => void,
          ) {
            assert.equal(force, true);
            onPhase("projecting");
            onPhase("indexing");
            await syncGate;
            return result;
          },
        },
      };
    },
  });

  const started = await runtime.startSessionSync(active, true);
  assert.equal(started.status, "started");
  assert.deepEqual(await reloadedRuntime.sessionSyncStatus(active.agentId), {
    status: "running",
    phase: "queued",
    startedAt: started.status === "started" ? started.startedAt : "",
  });
  assert.deepEqual(await reloadedRuntime.startSessionSync(active), {
    status: "already_running",
    startedAt: started.status === "started" ? started.startedAt : "",
  });

  releaseManager();
  await waitFor(async () => {
    const status = await reloadedRuntime.sessionSyncStatus(active.agentId);
    return status.status === "running" && status.phase === "indexing";
  }, "session sync indexing");
  releaseSync();
  await waitFor(
    async () => (await reloadedRuntime.sessionSyncStatus(active.agentId)).status === "completed",
    "session sync completion",
  );
  const completed = await reloadedRuntime.sessionSyncStatus(active.agentId);
  assert.equal(completed.status, "completed");
  if (completed.status === "completed") {
    assert.equal(completed.startedAt, started.status === "started" ? started.startedAt : "");
    assert.match(completed.completedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.deepEqual({
      scanned: completed.scanned,
      unchanged: completed.unchanged,
      updated: completed.updated,
      removed: completed.removed,
      skipped: completed.skipped,
      failed: completed.failed,
      embedded: completed.embedded,
      lastSuccessfulSyncAt: completed.lastSuccessfulSyncAt,
    }, result);
  }
});

test("shares failed session sync status and allows a retry from a new runtime", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-failure-"));
  const runtime = new QmdMemoryRuntime(sessionCorpora, undefined, stateRoot);
  const reloadedRuntime = new QmdMemoryRuntime(sessionCorpora, undefined, stateRoot);
  let releaseManager = () => {};
  const managerGate = new Promise<void>((resolve) => { releaseManager = resolve; });
  Object.defineProperty(runtime, "getMemorySearchManager", {
    value: async () => {
      await managerGate;
      return {
        manager: {
          async syncSessions(
            _force: boolean,
            onPhase: (phase: "projecting" | "indexing") => void,
          ) {
            onPhase("indexing");
            throw new Error("session index failed");
          },
        },
      };
    },
  });

  assert.equal((await runtime.startSessionSync(active)).status, "started");
  assert.equal((await reloadedRuntime.sessionSyncStatus(active.agentId)).status, "running");
  releaseManager();
  await waitFor(
    async () => (await reloadedRuntime.sessionSyncStatus(active.agentId)).status === "failed",
    "session sync failure",
  );
  const failed = await reloadedRuntime.sessionSyncStatus(active.agentId);
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") assert.equal(failed.error, "session index failed");

  Object.defineProperty(reloadedRuntime, "getMemorySearchManager", {
    value: async () => ({
      manager: {
        async syncSessions() {
          return {
            scanned: 0,
            unchanged: 0,
            updated: 0,
            removed: 0,
            skipped: 0,
            failed: 0,
            embedded: 0,
            lastSuccessfulSyncAt: Date.now(),
          };
        },
      },
    }),
  });
  assert.equal((await reloadedRuntime.startSessionSync(active)).status, "started");
  await waitFor(
    async () => (await runtime.sessionSyncStatus(active.agentId)).status === "completed",
    "retried session sync completion",
  );
});

test("marks persisted running status interrupted after a Gateway restart", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-stale-"));
  const stateDir = join(stateRoot, "agents", active.agentId, "unblock-memory");
  const statusPath = join(stateDir, "session-sync-status.json");
  const startedAt = "2026-08-26T12:00:00.000Z";
  await mkdir(stateDir, { recursive: true });
  await writeFile(statusPath, JSON.stringify({
    status: "running",
    phase: "indexing",
    pid: 99_999_999,
    startedAt,
  }));
  const runtime = new QmdMemoryRuntime(sessionCorpora, undefined, stateRoot);

  const failed = await runtime.sessionSyncStatus(active.agentId);
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") assert.equal(failed.error, "session sync interrupted by Gateway restart");
});

test("restart recovery preserves completion after its first status read", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-recovery-race-"));
  const statusPath = join(root, "session-sync-status.json");
  const startedAt = "2026-08-26T12:00:00.000Z";
  const completed = {
    status: "completed" as const,
    startedAt,
    completedAt: "2026-08-26T12:01:00.000Z",
    scanned: 1,
    unchanged: 0,
    updated: 1,
    removed: 0,
    skipped: 0,
    failed: 0,
    embedded: 1,
    lastSuccessfulSyncAt: Date.now(),
  };
  await writeFile(statusPath, JSON.stringify(completed));

  assert.deepEqual(await recoverInterruptedSessionSync(root, statusPath, {
    status: "running",
    phase: "indexing",
    pid: 99_999_999,
    startedAt,
  }), completed);
});

test("clears the active registry when the initial status write fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-write-failure-"));
  const stateRoot = join(root, "state");
  await writeFile(stateRoot, "not a directory");
  const runtime = new QmdMemoryRuntime(sessionCorpora, undefined, stateRoot);
  await assert.rejects(runtime.startSessionSync(active), /ENOTDIR/);

  await unlink(stateRoot);
  await mkdir(stateRoot);
  Object.defineProperty(runtime, "getMemorySearchManager", {
    value: async () => ({
      manager: {
        async syncSessions() {
          return {
            scanned: 0,
            unchanged: 0,
            updated: 0,
            removed: 0,
            skipped: 0,
            failed: 0,
            embedded: 0,
            lastSuccessfulSyncAt: Date.now(),
          };
        },
      },
    }),
  });
  assert.equal((await runtime.startSessionSync(active)).status, "started");
  await waitFor(
    async () => (await runtime.sessionSyncStatus(active.agentId)).status === "completed",
    "session sync after initial status failure",
  );
});
