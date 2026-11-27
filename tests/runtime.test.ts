import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { FSWatcher } from "chokidar";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { QmdMemoryManager } from "../src/manager.js";
import { QmdMemoryRuntime } from "../src/runtime.js";
import { MEMORY_DATABASE } from "../src/memory-database.js";
import { SessionSyncState } from "../src/session-sync-state.js";
import { WorkFenceLostError, WorkStore } from "../src/work-store.js";
import { listFiles } from "./helpers/session-index.js";

const SESSION_SYNC_KIND = "session_sync";

function stateDirFor(stateRoot: string): string {
  return join(stateRoot, "agents", "main", "unblock-memory");
}

function withWork<T>(stateDir: string, fn: (work: WorkStore, state: SessionSyncState) => T): T {
  const work = new WorkStore(join(stateDir, MEMORY_DATABASE));
  try { return fn(work, new SessionSyncState(work.db, "main")); } finally { work.close(); }
}

/** Another process's session sync: claimed lease (optionally already expired) plus its running receipt. */
function seedForeignRun(stateDir: string, options: {
  owner: string; startedAt: string; phase: "queued" | "projecting" | "indexing"; expired?: boolean;
}) {
  return withWork(stateDir, (work, state) => {
    work.enqueue({ kind: SESSION_SYNC_KIND, scope: "main", mode: "run" });
    const claim = work.claim({ kind: SESSION_SYNC_KIND, scope: "main", mode: "run", owner: options.owner,
      leaseMs: 60_000, ignoreDueAt: true });
    assert.ok(claim, "seeded claim");
    // A crashed owner: the lease lapsed without any graceful release.
    if (options.expired) work.db.prepare("UPDATE work_items SET lease_until=1 WHERE kind=? AND scope='main'").run(SESSION_SYNC_KIND);
    state.writeReceipt({ status: "running", phase: options.phase, startedAt: options.startedAt, attempt: claim.attempt });
    return claim;
  });
}

function sessionSyncRow(stateDir: string) {
  return withWork(stateDir, work => work.get(SESSION_SYNC_KIND, "main"));
}

const emptyResult = () => ({
  scanned: 0, unchanged: 0, updated: 0, removed: 0, skipped: 0, failed: 0, embedded: 0, lastSuccessfulSyncAt: Date.now(),
});

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
test("marks a legacy running status interrupted after a Gateway restart", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-stale-"));
  const stateDir = stateDirFor(stateRoot);
  const startedAt = "2026-08-26T12:00:00.000Z";
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "session-sync-status.json"), JSON.stringify({
    status: "running",
    phase: "indexing",
    pid: 99_999_999,
    startedAt,
  }));
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });

  const failed = await runtime.sessionSyncStatus(active.agentId);
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") {
    assert.equal(failed.startedAt, startedAt);
    assert.equal(failed.error, "session sync interrupted by Gateway restart");
  }
});

test("imports a legacy completed status receipt with the same public shape", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-legacy-status-"));
  const stateDir = stateDirFor(stateRoot);
  await mkdir(stateDir, { recursive: true });
  const completed = { status: "completed" as const, startedAt: "2026-08-26T12:00:00.000Z",
    completedAt: "2026-08-26T12:01:00.000Z", ...emptyResult() };
  await writeFile(join(stateDir, "session-sync-status.json"), JSON.stringify({ ...completed, pid: 42 }));
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  assert.deepEqual(await runtime.sessionSyncStatus(active.agentId), completed);
});

test("an expired WorkStore lease reports its attempt interrupted once and persists the receipt", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-expired-"));
  const stateDir = stateDirFor(stateRoot);
  const startedAt = "2026-11-24T12:00:00.000Z";
  seedForeignRun(stateDir, { owner: "session-sync:dead:owner", startedAt, phase: "indexing", expired: true });
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  const failed = await runtime.sessionSyncStatus(active.agentId);
  assert.equal(failed.status, "failed");
  if (failed.status !== "failed") return;
  assert.equal(failed.startedAt, startedAt);
  assert.equal(failed.error, "session sync interrupted by Gateway restart");
  assert.deepEqual(await runtime.sessionSyncStatus(active.agentId), failed, "stable across reads");
  assert.deepEqual(withWork(stateDir, (_work, state) => state.readReceipt()), failed);
});

test("interrupting a dead attempt never clobbers a receipt that superseded it", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-recovery-race-"));
  const completed = { status: "completed" as const, startedAt: "2026-08-26T12:00:00.000Z",
    completedAt: "2026-08-26T12:01:00.000Z", ...emptyResult() };
  withWork(root, (_work, state) => {
    state.writeReceipt({ status: "running", phase: "indexing", startedAt: completed.startedAt, attempt: 1 });
    // The owner completed between a reader's first look and its recovery write.
    state.writeReceipt(completed);
    assert.deepEqual(state.interruptReceipt(1, new Date().toISOString()), completed);
    // A newer live attempt is not the dead one either.
    state.writeReceipt({ status: "running", phase: "queued", startedAt: "later", attempt: 2 });
    assert.equal(state.interruptReceipt(1, new Date().toISOString())?.status, "running");
  });
});

test("a crashed later attempt is recovered with that attempt's start time", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-second-crash-"));
  const stateDir = stateDirFor(stateRoot);
  seedForeignRun(stateDir, { owner: "first", startedAt: "2026-11-24T12:00:00.000Z", phase: "projecting", expired: true });
  // A second process reclaimed the expired lease, then crashed too.
  const secondStartedAt = "2026-11-24T12:05:00.000Z";
  const second = seedForeignRun(stateDir, { owner: "second", startedAt: secondStartedAt, phase: "indexing", expired: true });
  assert.equal(second.attempt, 2);
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  const recovered = await runtime.sessionSyncStatus(active.agentId);
  assert.equal(recovered.status, "failed");
  if (recovered.status === "failed") {
    assert.equal(recovered.startedAt, secondStartedAt);
    assert.equal(recovered.error, "session sync interrupted by Gateway restart");
  }
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
    value: async () => ({ manager: { async syncSessions() { return emptyResult(); } } }),
  });
  assert.equal((await runtime.startSessionSync(active)).status, "started");
  await waitFor(
    async () => (await runtime.sessionSyncStatus(active.agentId)).status === "completed",
    "session sync after initial status failure",
  );
});

test("a live WorkStore lease blocks duplicates across processes; a crashed owner's lease is reclaimed", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-xproc-lease-"));
  const stateDir = stateDirFor(stateRoot);
  const startedAt = "2026-11-24T12:00:00.000Z";
  seedForeignRun(stateDir, { owner: "session-sync:other-process", startedAt, phase: "indexing" });

  const processB = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  t.after(() => processB.close());
  assert.deepEqual(await processB.sessionSyncStatus(active.agentId), { status: "running", phase: "indexing", startedAt });
  assert.deepEqual(await processB.startSessionSync(active), { status: "already_running", startedAt });
  assert.equal(sessionSyncRow(stateDir)?.owner, "session-sync:other-process", "a live lease is never stolen");

  // Process A crashes: its lease lapses without a graceful release.
  withWork(stateDir, work => work.db.prepare("UPDATE work_items SET lease_until=1 WHERE kind=?").run(SESSION_SYNC_KIND));
  const recovered = await processB.sessionSyncStatus(active.agentId);
  assert.equal(recovered.status, "failed");
  if (recovered.status === "failed") assert.equal(recovered.error, "session sync interrupted by Gateway restart");

  let rowDuringRun: ReturnType<typeof sessionSyncRow>;
  Object.defineProperty(processB, "getMemorySearchManager", {
    value: async () => ({
      manager: {
        async syncSessions() {
          rowDuringRun = sessionSyncRow(stateDir);
          return emptyResult();
        },
      },
    }),
  });
  assert.equal((await processB.startSessionSync(active)).status, "started");
  await waitFor(
    async () => (await processB.sessionSyncStatus(active.agentId)).status === "completed",
    "reclaimed session sync completion",
  );
  assert.equal(rowDuringRun?.status, "running");
  assert.match(rowDuringRun?.owner ?? "", new RegExp(`^session-sync:${process.pid}:`));
  assert.ok((rowDuringRun?.leaseUntil ?? 0) > Date.now());
  const settled = sessionSyncRow(stateDir);
  assert.deepEqual({ status: settled?.status, owner: settled?.owner, strikes: settled?.strikes, mode: settled?.mode },
    { status: "pending", owner: null, strikes: 0, mode: "run" });
  assert.equal(lstatSync(join(stateDir, "session-sync.lock.sqlite"), { throwIfNoEntry: false }), undefined);
});

test("concurrent contenders reclaiming an expired WorkStore lease admit strictly one owner", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-lease-race-"));
  const stateDir = stateDirFor(stateRoot);
  seedForeignRun(stateDir, { owner: "session-sync:dead", startedAt: "2026-11-24T12:00:00.000Z", phase: "indexing", expired: true });

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
            return { scanned: 1, unchanged: 0, updated: 1, removed: 0, skipped: 0, failed: 0, embedded: 0,
              lastSuccessfulSyncAt: Date.now() };
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
      while ((await runtime.sessionSyncStatus("main")).status === "running") await new Promise(r => setTimeout(r, 5));
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
  const activeLease = sessionSyncRow(stateDir);
  assert.equal(activeLease?.status, "running");
  assert.match(activeLease?.owner ?? "", new RegExp(`^session-sync:${winners[0]!.pid}:`));

  contenderA.child.stdin.write("RELEASE\n");
  contenderB.child.stdin.write("RELEASE\n");
  const [exitA, exitB] = await Promise.all([
    once(contenderA.child, "exit"),
    once(contenderB.child, "exit"),
  ]);
  assert.equal(exitA[0], 0, contenderA.getStderr());
  assert.equal(exitB[0], 0, contenderB.getStderr());

  assert.equal(sessionSyncRow(stateDir)?.owner, null);
  const observer = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  t.after(() => observer.close());
  assert.equal((await observer.sessionSyncStatus(active.agentId)).status, "completed");
});

test("gateway_stop releases the session-sync lease at once with 0 strikes and fences the drained run", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-drain-"));
  const stateDir = stateDirFor(stateRoot);
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  const events: string[] = [];
  let releaseSync!: () => void;
  const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
  let syncStarted!: () => void;
  const syncEntered = new Promise<void>((resolve) => { syncStarted = resolve; });
  let persistError: unknown;
  let signalAborted: boolean | undefined;

  const originalCreate = QmdMemoryManager.prototype.start;
  const originalSync = QmdMemoryManager.prototype.syncSessions;
  const originalClose = QmdMemoryManager.prototype.close;
  QmdMemoryManager.prototype.start = async () => {};
  QmdMemoryManager.prototype.syncSessions = async (_force, _onPhase, options) => {
    events.push("sync:start");
    syncStarted();
    await syncGate;
    signalAborted = options?.signal?.aborted;
    try { options?.persist?.({ version: 1, sessions: {} }); } catch (error) { persistError = error; }
    events.push("sync:end");
    return emptyResult();
  };
  QmdMemoryManager.prototype.close = async () => {
    events.push("manager:close");
  };
  try {
    const started = await runtime.startSessionSync(active, true);
    assert.equal(started.status, "started");
    await syncEntered;
    assert.equal(sessionSyncRow(stateDir)?.status, "running");

    let closeDone = false;
    const closing = runtime.close().then(() => { closeDone = true; });
    // Released synchronously inside close(), before the in-flight run drains: no strike, no lease.
    const released = sessionSyncRow(stateDir);
    assert.deepEqual({ status: released?.status, owner: released?.owner, leaseUntil: released?.leaseUntil, strikes: released?.strikes },
      { status: "pending", owner: null, leaseUntil: 0, strikes: 0 });
    await delay(20);
    assert.equal(closeDone, false, "runtime.close() still drains the owned session sync");
    assert.deepEqual(events, ["sync:start"]);

    releaseSync();
    await closing;
    assert.deepEqual(events, ["sync:start", "sync:end", "manager:close"]);
    assert.equal(signalAborted, true);
    assert.ok(persistError instanceof WorkFenceLostError, "a released attempt can never publish its manifest");
    const status = await runtime.sessionSyncStatus(active.agentId);
    assert.equal(status.status, "failed");
    if (status.status === "failed") assert.equal(status.error, "session sync interrupted by Gateway restart");
    assert.equal(withWork(stateDir, (_work, state) => state.revision()), 0);

    assert.deepEqual(await runtime.getMemorySearchManager(active), { manager: null, error: "memory runtime is closing" });
    assert.deepEqual(await runtime.startSessionSync(active), { status: "unavailable", error: "memory runtime is closing" });
  } finally {
    QmdMemoryManager.prototype.start = originalCreate;
    QmdMemoryManager.prototype.syncSessions = originalSync;
    QmdMemoryManager.prototype.close = originalClose;
  }

  // A restarted Gateway picks the released row straight back up (no lease expiry wait).
  const restarted = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  Object.defineProperty(restarted, "getMemorySearchManager", {
    value: async () => ({ manager: { async syncSessions() { return emptyResult(); } } }),
  });
  try {
    assert.equal((await restarted.startSessionSync(active)).status, "started");
    await waitFor(async () => (await restarted.sessionSyncStatus(active.agentId)).status === "completed", "restart sync");
  } finally { await restarted.close(); }
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

test("a fenced-out attempt (lease taken over) never publishes and the next sync recovers without restart", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-fence-lost-"));
  const stateDir = stateDirFor(stateRoot);
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  t.after(() => runtime.close());
  let releaseSync!: () => void;
  const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
  let persistError: unknown;
  let runs = 0;
  Object.defineProperty(runtime, "getMemorySearchManager", {
    value: async () => ({
      manager: {
        async syncSessions(_force: boolean, _onPhase: unknown, options: { persist(manifest: unknown): void }) {
          runs += 1;
          if (runs === 1) {
            await syncGate;
            try { options.persist({ version: 1, sessions: {} }); } catch (error) { persistError = error; throw error; }
          } else {
            options.persist({ version: 1, sessions: {}, generation: 0 });
          }
          return emptyResult();
        },
      },
    }),
  });

  assert.equal((await runtime.startSessionSync(active, true)).status, "started");
  await waitFor(() => runs === 1, "first run entered");
  // Another process interrupts and supersedes this attempt (bumps the fencing attempt).
  const owner = sessionSyncRow(stateDir)!.owner!;
  withWork(stateDir, work => work.interruptOwner(owner));
  releaseSync();
  await waitFor(async () => (await runtime.sessionSyncStatus(active.agentId)).status === "failed", "fenced run");
  assert.ok(persistError instanceof WorkFenceLostError);
  assert.equal(withWork(stateDir, (_work, state) => state.revision()), 0, "no manifest from the fenced attempt");

  assert.equal((await runtime.startSessionSync(active, true)).status, "started");
  await waitFor(async () => (await runtime.sessionSyncStatus(active.agentId)).status === "completed", "recovered run");
  assert.equal(withWork(stateDir, (_work, state) => state.revision()), 1);
});

test("retires legacy Markdown, manifest, lock and status sidecars after the first SQLite-backed sync", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-legacy-retire-"));
  const stateDir = stateDirFor(stateRoot);
  await mkdir(join(stateDir, "sessions", "slack", "channel"), { recursive: true });
  await writeFile(join(stateDir, "sessions", "slack", "channel", "old.md"), "# Transcript\n\nplaintext\n");
  await writeFile(join(stateDir, "sessions-manifest.json"), JSON.stringify({ version: 1, sessions: {} }));
  await writeFile(join(stateDir, "session-sync-status.json"), JSON.stringify({ status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", ...emptyResult() }));
  await writeFile(join(stateDir, "session-sync.lock"), JSON.stringify({ pid: 1, token: "t", startedAt: "x" }));
  const legacyLock = new DatabaseSync(join(stateDir, "session-sync.lock.sqlite"));
  legacyLock.exec("CREATE TABLE session_sync_lease (id INTEGER PRIMARY KEY, pid INTEGER, token TEXT, started_at TEXT)");
  legacyLock.close();

  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  t.after(() => runtime.close());
  assert.equal((await runtime.sessionSyncStatus(active.agentId)).status, "completed", "legacy receipt visible before upgrade");
  Object.defineProperty(runtime, "getMemorySearchManager", {
    value: async () => ({
      manager: {
        async syncSessions(_force: boolean, _onPhase: unknown, options: { persist(manifest: unknown): void }) {
          options.persist({ version: 1, sessions: {}, generation: 0 });
          return emptyResult();
        },
      },
    }),
  });
  assert.equal((await runtime.startSessionSync(active, true)).status, "started");
  await waitFor(async () => (await runtime.sessionSyncStatus(active.agentId)).status === "completed", "upgrade sync");
  assert.deepEqual(listFiles(stateDir).filter(file => !file.startsWith(MEMORY_DATABASE)), []);
});

test("prepareReload fences admissions, drains managers/syncs with error reporting, and resumes only if retained", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-runtime-prepare-reload-"));
  const runtime = new QmdMemoryRuntime(sessionCorpora, { stateRoot });
  t.after(() => runtime.close());

  let starts = 0;
  let closes = 0;
  let failNextClose = false;
  t.mock.method(QmdMemoryManager.prototype, "start", async () => {
    starts += 1;
  });
  t.mock.method(QmdMemoryManager.prototype, "close", async () => {
    closes += 1;
    if (failNextClose) {
      failNextClose = false;
      throw new Error("manager close boom");
    }
  });

  const initial = await runtime.getMemorySearchManager(active);
  assert.ok(initial.manager);
  assert.equal(starts, 1);

  // Non-retiring reload (unrelated embedding providers) does not disturb QMD managers.
  const unrelated = runtime.prepareReload({ retireRuntime: false, retiringEmbeddingProviders: [] });
  assert.equal((await runtime.getMemorySearchManager(active)).manager, initial.manager);
  assert.deepEqual(await unrelated.drain(), { errors: [] });
  unrelated.resume();
  assert.equal(closes, 0);

  // Retiring reload synchronously fences manager and session sync admissions.
  failNextClose = true;
  const reload = runtime.prepareReload({ retireRuntime: true, retiringEmbeddingProviders: [] });
  assert.deepEqual(await runtime.getMemorySearchManager(active), {
    manager: null,
    error: "memory runtime is reloading",
  });
  assert.deepEqual(await runtime.startSessionSync(active, true), {
    status: "unavailable",
    error: "memory runtime is reloading",
  });
  assert.equal(starts, 1);

  const drained = await reload.drain();
  assert.equal(closes, 1);
  assert.ok(drained && drained.errors.length === 1);
  assert.match(String(drained.errors[0]), /manager close boom/);

  // Resuming a retained runtime reopens admission cleanly and creates a fresh manager.
  reload.resume();
  reload.resume(); // Idempotent.
  const resumed = await runtime.getMemorySearchManager(active);
  assert.ok(resumed.manager);
  assert.notEqual(resumed.manager, initial.manager);
  assert.equal(starts, 2);

  // Permanent close() prevents a later resume() from reopening admission.
  const secondReload = runtime.prepareReload({ retireRuntime: true, retiringEmbeddingProviders: [] });
  await runtime.close();
  secondReload.resume();
  assert.deepEqual(await runtime.getMemorySearchManager(active), {
    manager: null,
    error: "memory runtime is closing",
  });
  assert.deepEqual(await runtime.startSessionSync(active), {
    status: "unavailable",
    error: "memory runtime is closing",
  });
});

test("closeAllMemorySearchManagers fences concurrent getMemorySearchManager attempts while draining", async (t) => {
  const events: string[] = [];
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  let closeStarted!: () => void;
  const closeEntered = new Promise<void>((resolve) => { closeStarted = resolve; });
  let starts = 0;

  t.mock.method(QmdMemoryManager.prototype, "start", async () => {
    events.push(`start:${++starts}`);
  });
  t.mock.method(QmdMemoryManager.prototype, "close", async () => {
    events.push("close:start");
    closeStarted();
    await closeGate;
    events.push("close:end");
  });

  const runtime = new QmdMemoryRuntime([]);
  t.after(() => runtime.close());

  const first = await runtime.getMemorySearchManager(active);
  assert.ok(first.manager);

  const closeAllPromise = runtime.closeAllMemorySearchManagers();
  await closeEntered;

  // Concurrent manager acquisitions (same agent and different agent) are fenced out while draining.
  assert.deepEqual(await runtime.getMemorySearchManager(active), {
    manager: null,
    error: "memory runtime is closing",
  });
  assert.deepEqual(await runtime.getMemorySearchManager({ cfg: {} as OpenClawConfig, agentId: "other" }), {
    manager: null,
    error: "memory runtime is closing",
  });
  assert.equal(starts, 1, "no new manager may be opened during closeAllMemorySearchManagers");

  releaseClose();
  await closeAllPromise;
  assert.deepEqual(events, ["start:1", "close:start", "close:end"]);

  // Because close() was not called, admission reopens after closeAllMemorySearchManagers finishes.
  const reopened = await runtime.getMemorySearchManager(active);
  assert.ok(reopened.manager);
  assert.notEqual(reopened.manager, first.manager);
  assert.equal(starts, 2);
});
