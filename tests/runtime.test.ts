import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { QmdMemoryRuntime } from "../src/runtime.js";

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
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

test("reports session sync unavailable when sessions are not configured", () => {
  const runtime = new QmdMemoryRuntime([]);
  assert.deepEqual(runtime.startSessionSync(active), {
    status: "unavailable",
    error: 'memory session sync requires a configured "sessions" corpus',
  });
  assert.deepEqual(runtime.sessionSyncStatus(active.agentId), { status: "idle" });
});

test("owns the background session sync lifecycle before manager initialization", async () => {
  const runtime = new QmdMemoryRuntime(sessionCorpora);
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

  const started = runtime.startSessionSync(active, true);
  assert.equal(started.status, "started");
  assert.deepEqual(runtime.sessionSyncStatus(active.agentId), {
    status: "running",
    phase: "queued",
    startedAt: started.status === "started" ? started.startedAt : "",
  });
  assert.deepEqual(runtime.startSessionSync(active), {
    status: "already_running",
    startedAt: started.status === "started" ? started.startedAt : "",
  });

  releaseManager();
  await waitFor(() => {
    const status = runtime.sessionSyncStatus(active.agentId);
    return status.status === "running" && status.phase === "indexing";
  }, "session sync indexing");
  releaseSync();
  await waitFor(
    () => runtime.sessionSyncStatus(active.agentId).status === "completed",
    "session sync completion",
  );
  const completed = runtime.sessionSyncStatus(active.agentId);
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

test("records manager initialization errors as failed session syncs", async () => {
  const runtime = new QmdMemoryRuntime(sessionCorpora);
  let releaseManager = () => {};
  const managerGate = new Promise<void>((resolve) => { releaseManager = resolve; });
  Object.defineProperty(runtime, "getMemorySearchManager", {
    value: async () => {
      await managerGate;
      return { manager: null, error: "manager init failed" };
    },
  });

  assert.equal(runtime.startSessionSync(active).status, "started");
  assert.equal(runtime.sessionSyncStatus(active.agentId).status, "running");
  releaseManager();
  await waitFor(
    () => runtime.sessionSyncStatus(active.agentId).status === "failed",
    "session sync failure",
  );
  const failed = runtime.sessionSyncStatus(active.agentId);
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") assert.equal(failed.error, "manager init failed");
});
