import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { mkdir, mkdtemp, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { FSWatcher } from "chokidar";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { QmdMemoryManager } from "../src/manager.js";
import { QmdMemoryRuntime, recoverInterruptedSessionSync } from "../src/runtime.js";

function seedSessionSyncLease(
  lockPath: string,
  lease: { pid: number; token: string; startedAt: string },
): void {
  const db = new DatabaseSync(lockPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_sync_lease (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        pid INTEGER NOT NULL,
        token TEXT NOT NULL,
        started_at TEXT NOT NULL
      )
    `);
    db.prepare(
      "INSERT OR REPLACE INTO session_sync_lease (id, pid, token, started_at) VALUES (1, ?, ?, ?)",
    ).run(lease.pid, lease.token, lease.startedAt);
  } finally {
    db.close();
  }
}

function readSessionSyncLeaseRows(
  lockPath: string,
): Array<{ id: number; pid: number; token: string; started_at: string }> {
  const db = new DatabaseSync(lockPath, { readOnly: true });
  try {
    return db.prepare("SELECT id, pid, token, started_at FROM session_sync_lease").all() as Array<{
      id: number;
      pid: number;
      token: string;
      started_at: string;
    }>;
  } finally {
    db.close();
  }
}

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
  maxExpandedTokens: 500,
  syncIntervalMinutes: 15,
}] as const;

test("closes failed startup attempts before retrying and preserves the startup error", async t => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-startup-"));
  const runtime = new QmdMemoryRuntime([
    { name: "memory", kind: "files", paths: ["memory/**/*.md"] },
  ], { stateRoot: root });
  const params = { cfg: { agents: { defaults: { workspace: root } } }, agentId: "main" };
  const originalClose = QmdMemoryManager.prototype.close;
  const watcherClose = t.mock.method(FSWatcher.prototype, "close");
  const closed: QmdMemoryManager[] = [];
  let attempts = 0;
  t.mock.method(QmdMemoryManager.prototype, "sync", async () => {
    if (++attempts <= 2) throw new Error("initial sync failed");
  });
  t.mock.method(QmdMemoryManager.prototype, "close", async function (this: QmdMemoryManager) {
    closed.push(this);
    await originalClose.call(this);
    if (closed.length === 1) throw new Error("cleanup failed too");
  });
  t.after(() => runtime.closeAllMemorySearchManagers());

  for (let attempt = 1; attempt <= 2; attempt++) {
    assert.deepEqual(await runtime.getMemorySearchManager(params), { manager: null, error: "initial sync failed" });
    assert.equal(closed.length, attempt);
    assert.equal(watcherClose.mock.callCount(), attempt);
  }
  const { manager } = await runtime.getMemorySearchManager(params);
  assert.ok(manager);
  assert.equal((await runtime.getMemorySearchManager(params)).manager, manager);
  await runtime.closeAllMemorySearchManagers();
  assert.equal(new Set(closed).size, 3);
  assert.equal(closed.length, 3);
  assert.equal(watcherClose.mock.callCount(), 3);
});

test("a failed old startup does not evict its replacement after close", async t => {
  let failStartup!: (error: Error) => void;
  const startup = new Promise<void>((_, reject) => { failStartup = reject; });
  let attempts = 0;
  t.mock.method(QmdMemoryManager.prototype, "start", async () => {
    if (++attempts === 1) await startup;
  });
  t.mock.method(QmdMemoryManager.prototype, "close", async () => {});
  const runtime = new QmdMemoryRuntime([]);
  t.after(() => runtime.closeAllMemorySearchManagers());

  const oldLookup = runtime.getMemorySearchManager(active);
  const oldClose = runtime.closeMemorySearchManager(active).catch(() => undefined);
  const replacementLookup = runtime.getMemorySearchManager(active);
  await Promise.resolve();
  assert.equal(attempts, 1, "replacement must wait for the closing fence before starting");
  failStartup(new Error("old startup failed"));
  assert.deepEqual(await oldLookup, { manager: null, error: "old startup failed" });
  await oldClose;
  const replacement = await replacementLookup;
  assert.ok(replacement.manager);
  assert.equal((await runtime.getMemorySearchManager(active)).manager, replacement.manager);
});

test("schedules configured agents after the interval, retries failures, and stops cleanly", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const runtime = new QmdMemoryRuntime(sessionCorpora);
  const calls: string[] = [];
  const errors: unknown[] = [];
  t.mock.method(runtime, "startSessionSync", async ({ agentId }: { agentId: string }) => {
    calls.push(agentId);
    if (agentId === "first") throw new Error("cannot start");
    return { status: "already_running", startedAt: "now" };
  });
  const cfg = { agents: { entries: { first: {}, second: {} } } };
  runtime.startSessionSyncSchedule(cfg, (error) => errors.push(error));
  runtime.startSessionSyncSchedule(cfg, (error) => errors.push(error));
  t.mock.timers.tick(15 * 60_000 - 1);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(errors.length, 1);
  t.mock.timers.tick(15 * 60_000);
  await Promise.resolve();
  assert.equal(calls.length, 4);
  runtime.stopSessionSyncSchedule();
  t.mock.timers.tick(15 * 60_000);
  assert.equal(calls.length, 4);
});

test("does not schedule absent or manual-only sessions", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const corpora of [[], [{ ...sessionCorpora[0], syncIntervalMinutes: 0 }]]) {
    const runtime = new QmdMemoryRuntime(corpora);
    const start = t.mock.method(runtime, "startSessionSync");
    runtime.startSessionSyncSchedule({}, (error) => assert.fail(String(error)));
    t.mock.timers.tick(24 * 60 * 60_000);
    assert.equal(start.mock.callCount(), 0);
  }
});

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
  const missingWorkspace = { cfg: {}, agentId: "main", workspaceDir: join(workspaceDir, "missing") };
  assert.deepEqual(await runtime.classifyWorkspaceMemoryPaths({ ...missingWorkspace, relativePaths: [] }), []);
  assert.deepEqual(await runtime.classifyWorkspaceMemoryPaths({
    ...missingWorkspace, relativePaths: ["MEMORY.md", "notes.md"],
  }), [
    { relativePath: "MEMORY.md", originClass: "untrusted" },
    { relativePath: "notes.md", originClass: "untrusted" },
  ]);
});

test("reports session sync unavailable when sessions are not configured", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-unavailable-"));
  const runtime = new QmdMemoryRuntime([], { stateRoot });
  assert.deepEqual(await runtime.startSessionSync(active), {
    status: "unavailable",
    error: 'memory session sync requires a configured "sessions" corpus',
  });
  assert.deepEqual(await runtime.sessionSyncStatus(active.agentId), { status: "idle" });
});

test("shares running and completed session sync status across runtime instances", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-status-"));
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  const reloadedRuntime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
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
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  const reloadedRuntime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
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
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });

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
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
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

test("cross-process SQLite lease protects a live sync from clobbering or duplication and reclaims dead-PID leases", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-xproc-lock-"));
  const stateDir = join(stateRoot, "agents", active.agentId, "unblock-memory");
  const lockPath = join(stateDir, "session-sync.lock.sqlite");
  const statusPath = join(stateDir, "session-sync-status.json");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10_000)"], { stdio: "ignore" });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  assert.ok(child.pid);

  const startedAt = "2026-11-24T12:00:00.000Z";
  seedSessionSyncLease(lockPath, {
    pid: child.pid,
    token: "process-a-token",
    startedAt,
  });
  const runningReceipt = {
    status: "running" as const,
    phase: "indexing" as const,
    pid: child.pid,
    startedAt,
  };
  await writeFile(statusPath, JSON.stringify(runningReceipt), { mode: 0o600 });

  const processB = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  t.after(() => processB.close());

  assert.deepEqual(await processB.sessionSyncStatus(active.agentId), {
    status: "running",
    phase: "indexing",
    startedAt,
  });
  assert.deepEqual(await processB.startSessionSync(active), {
    status: "already_running",
    startedAt,
  });
  assert.deepEqual(await recoverInterruptedSessionSync(stateDir, statusPath, runningReceipt), {
    status: "running",
    phase: "indexing",
    startedAt,
  });
  assert.equal(JSON.parse(await readFile(statusPath, "utf8")).status, "running");

  // EPERM from process.kill(pid, 0) must also be treated as alive.
  const killMock = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid === 424_242 && signal === 0) {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }
    return true;
  });
  seedSessionSyncLease(lockPath, {
    pid: 424_242,
    token: "eperm-owner",
    startedAt,
  });
  assert.deepEqual(await processB.startSessionSync(active), {
    status: "already_running",
    startedAt,
  });
  killMock.mock.restore();

  // Restore the real child lease, kill the child, and confirm dead-PID reclamation.
  seedSessionSyncLease(lockPath, {
    pid: child.pid,
    token: "process-a-token",
    startedAt,
  });
  child.kill("SIGKILL");
  await once(child, "exit");

  const recovered = await processB.sessionSyncStatus(active.agentId);
  assert.equal(recovered.status, "failed");
  if (recovered.status === "failed") {
    assert.equal(recovered.error, "session sync interrupted by Gateway restart");
  }
  assert.deepEqual(readSessionSyncLeaseRows(lockPath), []);

  let lockModeDuringRun: number | undefined;
  let leasePidDuringRun: number | undefined;
  Object.defineProperty(processB, "getMemorySearchManager", {
    value: async () => ({
      manager: {
        async syncSessions() {
          lockModeDuringRun = (await stat(lockPath)).mode & 0o777;
          const rows = readSessionSyncLeaseRows(lockPath);
          leasePidDuringRun = rows[0]?.pid;
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

  const restarted = await processB.startSessionSync(active);
  assert.equal(restarted.status, "started");
  await waitFor(
    async () => (await processB.sessionSyncStatus(active.agentId)).status === "completed",
    "reclaimed session sync completion",
  );
  assert.equal(lockModeDuringRun, 0o600);
  assert.equal(leasePidDuringRun, process.pid);
  assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
  assert.deepEqual(readSessionSyncLeaseRows(lockPath), []);
});

test("concurrent contenders recovering from a dead-PID SQLite lease admit strictly one owner", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-lease-race-"));
  const stateDir = join(stateRoot, "agents", active.agentId, "unblock-memory");
  const lockPath = join(stateDir, "session-sync.lock.sqlite");
  const statusPath = join(stateDir, "session-sync-status.json");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const deadChild = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.ok(deadChild.pid);
  await once(deadChild, "exit");

  const staleStartedAt = "2026-11-24T12:00:00.000Z";
  seedSessionSyncLease(lockPath, {
    pid: deadChild.pid,
    token: "stale-dead-owner",
    startedAt: staleStartedAt,
  });
  await writeFile(statusPath, JSON.stringify({
    status: "running",
    phase: "indexing",
    pid: deadChild.pid,
    startedAt: staleStartedAt,
  }), { mode: 0o600 });

  const runtimeModuleUrl = new URL("../src/runtime.ts", import.meta.url).href;
  const contenderScript = `
    import { createInterface } from "node:readline";
    import { QmdMemoryRuntime } from ${JSON.stringify(runtimeModuleUrl)};
    const runtime = new QmdMemoryRuntime([{
      name: "sessions",
      kind: "sessions",
      chatTypes: ["channel", "group"],
      maxExpandedTokens: 500,
      syncIntervalMinutes: 15,
    }], { stateRoot: ${JSON.stringify(stateRoot)} });
    let releaseSync;
    const syncGate = new Promise((resolve) => { releaseSync = resolve; });
    Object.defineProperty(runtime, "getMemorySearchManager", {
      value: async () => ({
        manager: {
          async syncSessions() {
            await syncGate;
            return {
              scanned: 1,
              unchanged: 0,
              updated: 1,
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
    const rl = createInterface({ input: process.stdin });
    let go;
    const goGate = new Promise((resolve) => { go = resolve; });
    rl.on("line", (line) => {
      if (line === "GO") go();
      if (line === "RELEASE") releaseSync();
    });
    process.stdout.write("READY\\n");
    await goGate;
    const result = await runtime.startSessionSync({ cfg: {}, agentId: "main" }, true);
    process.stdout.write(JSON.stringify({ pid: process.pid, result }) + "\\n");
    if (result.status === "started") {
      await syncGate;
      await runtime.close();
    }
    rl.close();
  `;

  const spawnContender = () => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", contenderScript], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TSX_DISABLE_CACHE: "1" },
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    let buffer = "";
    const lines: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else lines.push(line);
      }
    });
    const nextLine = (): Promise<string> => {
      const buffered = lines.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise((resolve, reject) => {
        const onExit = (code: number | null) => {
          reject(new Error(`contender exited early (code=${code}): ${stderr}`));
        };
        child.once("exit", onExit);
        waiters.push((line) => {
          child.off("exit", onExit);
          resolve(line);
        });
      });
    };
    return { child, nextLine, getStderr: () => stderr };
  };

  const contenderA = spawnContender();
  const contenderB = spawnContender();
  assert.deepEqual(await Promise.all([contenderA.nextLine(), contenderB.nextLine()]), ["READY", "READY"]);

  contenderA.child.stdin.write("GO\n");
  contenderB.child.stdin.write("GO\n");

  const outcomes = (await Promise.all([contenderA.nextLine(), contenderB.nextLine()])).map(
    (line) => JSON.parse(line) as { pid: number; result: { status: string; startedAt?: string } },
  );
  const winners = outcomes.filter((outcome) => outcome.result.status === "started");
  const losers = outcomes.filter((outcome) => outcome.result.status === "already_running");
  assert.equal(winners.length, 1, `expected strictly 1 started contender, got ${JSON.stringify(outcomes)}`);
  assert.equal(losers.length, 1, `expected strictly 1 already_running contender, got ${JSON.stringify(outcomes)}`);
  assert.equal(losers[0]!.result.startedAt, winners[0]!.result.startedAt);

  const activeLease = readSessionSyncLeaseRows(lockPath);
  assert.equal(activeLease.length, 1);
  assert.equal(activeLease[0]!.pid, winners[0]!.pid);
  assert.equal((await stat(lockPath)).mode & 0o777, 0o600);

  contenderA.child.stdin.write("RELEASE\n");
  contenderB.child.stdin.write("RELEASE\n");
  const [exitA, exitB] = await Promise.all([
    once(contenderA.child, "exit"),
    once(contenderB.child, "exit"),
  ]);
  assert.equal(exitA[0], 0, contenderA.getStderr());
  assert.equal(exitB[0], 0, contenderB.getStderr());

  assert.deepEqual(readSessionSyncLeaseRows(lockPath), []);
  const observer = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  t.after(() => observer.close());
  assert.equal((await observer.sessionSyncStatus(active.agentId)).status, "completed");
});

test("recoverInterruptedSessionSync immediately recovers a crashed second running receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-second-crash-"));
  const statusPath = join(root, "session-sync-status.json");
  const firstStartedAt = "2026-11-24T12:00:00.000Z";
  const secondStartedAt = "2026-11-24T12:05:00.000Z";
  await writeFile(statusPath, JSON.stringify({
    status: "running",
    phase: "indexing",
    pid: 99_999_998,
    startedAt: secondStartedAt,
  }), { mode: 0o600 });

  const recovered = await recoverInterruptedSessionSync(root, statusPath, {
    status: "running",
    phase: "projecting",
    pid: 99_999_999,
    startedAt: firstStartedAt,
  });
  assert.equal(recovered.status, "failed");
  if (recovered.status === "failed") {
    assert.equal(recovered.startedAt, secondStartedAt);
    assert.equal(recovered.error, "session sync interrupted by Gateway restart");
  }
  const persisted = JSON.parse(await readFile(statusPath, "utf8")) as { status: string; startedAt: string };
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.startedAt, secondStartedAt);
  assert.deepEqual(readSessionSyncLeaseRows(join(root, "session-sync.lock.sqlite")), []);
});

test("runtime.close fences an in-flight startSessionSync mid-startup and prevents manager creation after close", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-close-fence-"));
  const stateDir = join(stateRoot, "agents", active.agentId, "unblock-memory");
  const lockPath = join(stateDir, "session-sync.lock.sqlite");
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });

  let managerStarts = 0;
  t.mock.method(QmdMemoryManager.prototype, "start", async () => {
    managerStarts += 1;
  });
  t.mock.method(QmdMemoryManager.prototype, "close", async () => {});

  let writeEntered!: () => void;
  const queuedWriteStarted = new Promise<void>((resolve) => { writeEntered = resolve; });
  let releaseWrite!: () => void;
  const queuedWriteGate = new Promise<void>((resolve) => { releaseWrite = resolve; });

  const originalWriteFile = fs.writeFile.bind(fs);
  let pausedOnce = false;
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    const [target] = args;
    if (!pausedOnce && typeof target === "string" && target.includes("session-sync-status.json")) {
      pausedOnce = true;
      writeEntered();
      await queuedWriteGate;
    }
    return originalWriteFile(...args);
  });

  const startPromise = runtime.startSessionSync(active, true);
  await queuedWriteStarted;
  // Lock is already held by the in-flight startSessionSync before #activeSessionSyncs registration.
  assert.equal(readSessionSyncLeaseRows(lockPath).length, 1);

  let closeDone = false;
  const closePromise = runtime.close().then(() => { closeDone = true; });
  await delay(20);
  assert.equal(closeDone, false, "runtime.close() must wait for in-flight startSessionSync");

  releaseWrite();
  const [startResult] = await Promise.all([startPromise, closePromise]);
  assert.equal(closeDone, true);
  assert.deepEqual(startResult, {
    status: "unavailable",
    error: "memory runtime is closing",
  });
  assert.equal(managerStarts, 0, "no QmdMemoryManager may spawn during or after close");
  assert.deepEqual(readSessionSyncLeaseRows(lockPath), []);

  assert.deepEqual(await runtime.getMemorySearchManager(active), {
    manager: null,
    error: "memory runtime is closing",
  });
  assert.deepEqual(await runtime.startSessionSync(active), {
    status: "unavailable",
    error: "memory runtime is closing",
  });
  assert.equal(managerStarts, 0);
});

test("runtime.close drains owned active session syncs before closing managers", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-drain-"));
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  const events: string[] = [];
  let releaseSync!: () => void;
  const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
  let syncStarted!: () => void;
  const syncEntered = new Promise<void>((resolve) => { syncStarted = resolve; });

  const originalCreate = QmdMemoryManager.prototype.start;
  const originalSync = QmdMemoryManager.prototype.syncSessions;
  const originalClose = QmdMemoryManager.prototype.close;
  QmdMemoryManager.prototype.start = async () => {};
  QmdMemoryManager.prototype.syncSessions = async () => {
    events.push("sync:start");
    syncStarted();
    await syncGate;
    events.push("sync:end");
    return {
      scanned: 1,
      unchanged: 1,
      updated: 0,
      removed: 0,
      skipped: 0,
      failed: 0,
      embedded: 0,
      lastSuccessfulSyncAt: Date.now(),
    };
  };
  QmdMemoryManager.prototype.close = async () => {
    events.push("manager:close");
  };
  try {
    const started = await runtime.startSessionSync(active, true);
    assert.equal(started.status, "started");
    await syncEntered;

    let closeDone = false;
    const closing = runtime.close().then(() => { closeDone = true; });
    await delay(20);
    assert.equal(closeDone, false, "runtime.close() must drain owned active session sync");
    assert.deepEqual(events, ["sync:start"]);

    releaseSync();
    await closing;
    assert.deepEqual(events, ["sync:start", "sync:end", "manager:close"]);
    assert.equal((await runtime.sessionSyncStatus(active.agentId)).status, "completed");
  } finally {
    QmdMemoryManager.prototype.start = originalCreate;
    QmdMemoryManager.prototype.syncSessions = originalSync;
    QmdMemoryManager.prototype.close = originalClose;
  }
});

test("concurrent closeMemorySearchManager and getMemorySearchManager serialize cleanly", async (t) => {
  const events: string[] = [];
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  let closeStarted!: () => void;
  const closeEntered = new Promise<void>((resolve) => { closeStarted = resolve; });
  let instanceCount = 0;

  t.mock.method(QmdMemoryManager.prototype, "start", async () => {
    events.push(`start:${++instanceCount}`);
  });
  t.mock.method(QmdMemoryManager.prototype, "close", async () => {
    const id = instanceCount;
    events.push(`close:start:${id}`);
    if (id === 1) {
      closeStarted();
      await closeGate;
    }
    events.push(`close:end:${id}`);
  });

  const runtime = new QmdMemoryRuntime([]);
  t.after(() => runtime.closeAllMemorySearchManagers());

  const first = await runtime.getMemorySearchManager(active);
  assert.ok(first.manager);
  const closing = runtime.closeMemorySearchManager(active);
  await closeEntered;

  const replacementLookup = runtime.getMemorySearchManager(active);
  await delay(20);
  assert.deepEqual(events, ["start:1", "close:start:1"]);

  releaseClose();
  await closing;
  const second = await replacementLookup;
  assert.ok(second.manager);
  assert.notEqual(second.manager, first.manager);
  assert.deepEqual(events, ["start:1", "close:start:1", "close:end:1", "start:2"]);
  assert.equal((await runtime.getMemorySearchManager(active)).manager, second.manager);
});
