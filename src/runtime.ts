import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { MEMORY_DATABASE } from "./memory-database.js";
import { join } from "node:path";
import {
  resolveAgentWorkspaceDir,
  resolveStateDir,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listAgentIds, resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { CorpusConfig } from "./config.js";
import type { ExtractionConfig } from "./extraction-config.js";
import type { MemoryPluginRuntimeContract } from "./contracts.js";
import { QmdMemoryManager, type ManagerSessionConfig } from "./manager.js";
import { resolveTimezone } from "./session-projector.js";
import { unchangedSessionSync, type SessionSyncResult } from "./session-sync.js";
import { resolveConfiguredSkillPath, resolveSessionSource, resolveSources } from "./sources.js";
import { classifyWorkspaceMemoryPaths } from "./workspace-path-classifier.js";
import { agentStateDir, agentTranscriptDatabase } from "./agent-paths.js";

export type SessionSyncStatus =
  | { status: "idle" }
  | { status: "running"; phase: "queued" | "projecting" | "indexing"; startedAt: string }
  | ({ status: "completed"; startedAt: string; completedAt: string } & SessionSyncResult)
  | { status: "failed"; startedAt: string; completedAt: string; error: string };

export type SessionSyncStartResult =
  | { status: "started"; startedAt: string }
  | { status: "already_running"; startedAt: string }
  | { status: "unavailable"; error: string };

type StoredSessionSyncStatus = Exclude<SessionSyncStatus, { status: "idle" }>;
type StoredRunningSessionSync = Extract<StoredSessionSyncStatus, { status: "running" }> & {
  pid: number;
};
type SessionSyncState = StoredRunningSessionSync |
  Exclude<StoredSessionSyncStatus, { status: "running" }>;
type SessionSyncLock = {
  pid: number;
  token: string;
  startedAt: string;
};
type LockReadResult = { exists: false } | { exists: true; lock?: SessionSyncLock };
type LockAcquisition =
  | { acquired: true; lock: SessionSyncLock; lockPath: string }
  | { acquired: false; owner: SessionSyncLock };

const SESSION_SYNC_LOCK_FILE = "session-sync.lock";
const SESSION_SYNC_RECLAIM_LOCK_FILE = "session-sync.lock.reclaim";
const SESSION_SYNC_STATUS_FILE = "session-sync-status.json";
const MAX_LOCK_ATTEMPTS = 4;

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await removeIfPresent(temporary);
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
}

function parseSessionSyncLock(value: unknown): SessionSyncLock | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { pid, token, startedAt } = value as Partial<SessionSyncLock>;
  if (
    typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 ||
    typeof token !== "string" || token.length === 0 ||
    typeof startedAt !== "string" || startedAt.length === 0
  ) {
    return undefined;
  }
  return { pid, token, startedAt };
}

async function readSessionSyncLock(lockPath: string): Promise<LockReadResult> {
  try {
    const raw = await readFile(lockPath, "utf8");
    try {
      return { exists: true, lock: parseSessionSyncLock(JSON.parse(raw)) };
    } catch {
      return { exists: true, lock: undefined };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function createExclusiveLockFile(lockPath: string, lock: SessionSyncLock): Promise<boolean> {
  const body = `${JSON.stringify(lock, null, 2)}\n`;
  const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    try {
      await link(temporary, lockPath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV") {
        throw error;
      }
      try {
        await writeFile(lockPath, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await chmod(lockPath, 0o600);
        return true;
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw fallbackError;
      }
    }
  } finally {
    await removeIfPresent(temporary);
  }
}

async function releaseSessionSyncLock(lockPath: string, token: string): Promise<void> {
  const current = await readSessionSyncLock(lockPath);
  if (!current.exists || current.lock?.token !== token) return;
  await removeIfPresent(lockPath);
}

async function tryReclaimStaleLock(
  directory: string,
  lockPath: string,
  stale: SessionSyncLock | undefined,
  replacement?: SessionSyncLock,
): Promise<"acquired" | "reclaimed" | "busy"> {
  const reclaimPath = join(directory, SESSION_SYNC_RECLAIM_LOCK_FILE);
  const reclaimLock: SessionSyncLock = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  let acquiredReclaim = await createExclusiveLockFile(reclaimPath, reclaimLock);
  if (!acquiredReclaim) {
    const existingReclaim = await readSessionSyncLock(reclaimPath);
    if (existingReclaim.exists && (!existingReclaim.lock || !isProcessAlive(existingReclaim.lock.pid))) {
      await removeIfPresent(reclaimPath);
      acquiredReclaim = await createExclusiveLockFile(reclaimPath, reclaimLock);
    }
  }
  if (!acquiredReclaim) return "busy";
  try {
    const current = await readSessionSyncLock(lockPath);
    if (!current.exists) {
      if (replacement && await createExclusiveLockFile(lockPath, replacement)) return "acquired";
      return "reclaimed";
    }
    if (current.lock && isProcessAlive(current.lock.pid)) {
      return "busy";
    }
    if (stale && current.lock && current.lock.token !== stale.token) {
      return "busy";
    }
    await removeIfPresent(lockPath);
    if (replacement && await createExclusiveLockFile(lockPath, replacement)) return "acquired";
    return "reclaimed";
  } finally {
    await releaseSessionSyncLock(reclaimPath, reclaimLock.token).catch(() => undefined);
  }
}

async function acquireSessionSyncLock(
  directory: string,
  startedAt: string,
): Promise<LockAcquisition> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, SESSION_SYNC_LOCK_FILE);
  const candidate: SessionSyncLock = {
    pid: process.pid,
    token: randomUUID(),
    startedAt,
  };
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    if (await createExclusiveLockFile(lockPath, candidate)) {
      return { acquired: true, lock: candidate, lockPath };
    }
    const existing = await readSessionSyncLock(lockPath);
    if (!existing.exists) continue;
    if (existing.lock && isProcessAlive(existing.lock.pid)) {
      return { acquired: false, owner: existing.lock };
    }
    const outcome = await tryReclaimStaleLock(directory, lockPath, existing.lock, candidate);
    if (outcome === "acquired") {
      return { acquired: true, lock: candidate, lockPath };
    }
  }
  const existing = await readSessionSyncLock(lockPath);
  if (existing.exists && existing.lock && isProcessAlive(existing.lock.pid)) {
    return { acquired: false, owner: existing.lock };
  }
  throw new Error(`could not acquire session sync lock in ${directory}`);
}

function runningStatusFromReceipt(
  status: SessionSyncState | undefined,
  startedAt: string,
): Extract<SessionSyncStatus, { status: "running" }> {
  return status?.status === "running" && status.startedAt === startedAt
    ? { status: "running", phase: status.phase, startedAt }
    : { status: "running", phase: "queued", startedAt };
}

export async function recoverInterruptedSessionSync(
  directory: string,
  statusPath: string,
  stale: StoredRunningSessionSync,
): Promise<SessionSyncStatus> {
  const acquired = await acquireSessionSyncLock(directory, stale.startedAt);
  if (!acquired.acquired) {
    const current = await readJson<SessionSyncState>(statusPath);
    return runningStatusFromReceipt(current, acquired.owner.startedAt);
  }
  try {
    const current = await readJson<SessionSyncState>(statusPath);
    if (!current) return { status: "idle" };
    if (current.status !== "running") return current;
    if (current.startedAt !== stale.startedAt) {
      return { status: "running", phase: current.phase, startedAt: current.startedAt };
    }
    const failed = {
      status: "failed" as const,
      startedAt: stale.startedAt,
      completedAt: new Date().toISOString(),
      error: "session sync interrupted by Gateway restart",
    };
    await atomicWriteJson(statusPath, failed);
    return failed;
  } finally {
    await releaseSessionSyncLock(acquired.lockPath, acquired.lock.token).catch(() => undefined);
  }
}

export class QmdMemoryRuntime implements MemoryPluginRuntimeContract {
  readonly #corpora: readonly CorpusConfig[];
  readonly #extraction?: ExtractionConfig;
  readonly #analysisExecutable?: string;
  readonly #keepEmbeddingModelWarm: boolean;
  readonly #stateRoot: string;
  readonly #managers = new Map<string, Promise<QmdMemoryManager>>();
  readonly #closingManagers = new Map<string, Promise<void>>();
  readonly #activeSessionSyncs = new Map<string, Promise<void>>();
  #sessionSyncTimer?: NodeJS.Timeout;

  startSessionSyncSchedule(cfg: OpenClawConfig, onError: (error: unknown) => void): void {
    this.stopSessionSyncSchedule();
    const sessions = this.#corpora.find((corpus) => corpus.kind === "sessions");
    if (!sessions?.syncIntervalMinutes) return;
    this.#sessionSyncTimer = setInterval(() => {
      for (const agentId of listAgentIds(cfg)) {
        void this.startSessionSync({ cfg, agentId }).catch(onError);
      }
    }, sessions.syncIntervalMinutes * 60_000);
    this.#sessionSyncTimer.unref();
  }

  stopSessionSyncSchedule(): void {
    if (this.#sessionSyncTimer) clearInterval(this.#sessionSyncTimer);
    this.#sessionSyncTimer = undefined;
  }

  constructor(
    corpora: readonly CorpusConfig[],
    options: {
      analysisExecutable?: string;
      keepEmbeddingModelWarm?: boolean;
      stateRoot?: string;
      extraction?: ExtractionConfig;
    } = {},
  ) {
    this.#corpora = corpora;
    this.#extraction = options.extraction;
    this.#analysisExecutable = options.analysisExecutable;
    this.#keepEmbeddingModelWarm = options.keepEmbeddingModelWarm ?? true;
    this.#stateRoot = options.stateRoot ?? resolveStateDir();
  }

  async getMemorySearchManager(params: { cfg: OpenClawConfig; agentId: string }) {
    while (true) {
      const closing = this.#closingManagers.get(params.agentId);
      if (closing) {
        await closing.catch(() => undefined);
        continue;
      }
      let pending = this.#managers.get(params.agentId);
      if (!pending) {
        pending = this.#createManager(params.cfg, params.agentId);
        this.#managers.set(params.agentId, pending);
      }
      try {
        return { manager: await pending };
      } catch (error) {
        if (this.#managers.get(params.agentId) === pending) this.#managers.delete(params.agentId);
        return { manager: null, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  resolveMemoryBackendConfig() {
    return { backend: "builtin" as const };
  }

  classifyWorkspaceMemoryPaths: NonNullable<
    MemoryPluginRuntimeContract["classifyWorkspaceMemoryPaths"]
  > = classifyWorkspaceMemoryPaths;

  async startSessionSync(
    params: { cfg: OpenClawConfig; agentId: string },
    force = false,
  ): Promise<SessionSyncStartResult> {
    if (!this.#corpora.some((corpus) => corpus.kind === "sessions")) {
      return {
        status: "unavailable",
        error: 'memory session sync requires a configured "sessions" corpus',
      };
    }
    const directory = this.#stateDir(params.agentId);
    const statusPath = join(directory, SESSION_SYNC_STATUS_FILE);
    const startedAt = new Date().toISOString();
    const acquired = await acquireSessionSyncLock(directory, startedAt);
    if (!acquired.acquired) {
      return { status: "already_running", startedAt: acquired.owner.startedAt };
    }
    try {
      await atomicWriteJson(statusPath, {
        status: "running",
        phase: "queued",
        pid: process.pid,
        startedAt,
      });
    } catch (error) {
      await releaseSessionSyncLock(acquired.lockPath, acquired.lock.token).catch(() => undefined);
      throw error;
    }
    const run = this.#runSessionSync(params, force, {
      directory,
      statusPath,
      lockPath: acquired.lockPath,
      token: acquired.lock.token,
      startedAt,
    });
    this.#activeSessionSyncs.set(directory, run);
    void run.finally(() => {
      if (this.#activeSessionSyncs.get(directory) === run) {
        this.#activeSessionSyncs.delete(directory);
      }
    });
    return { status: "started", startedAt };
  }

  async #runSessionSync(
    params: { cfg: OpenClawConfig; agentId: string },
    force: boolean,
    run: {
      directory: string;
      statusPath: string;
      lockPath: string;
      token: string;
      startedAt: string;
    },
  ): Promise<void> {
    let statusWrites = Promise.resolve();
    const writePhase = (phase: "projecting" | "indexing") => {
      statusWrites = statusWrites.then(() => atomicWriteJson(run.statusPath, {
        status: "running",
        phase,
        pid: process.pid,
        startedAt: run.startedAt,
      }));
    };
    try {
      const sessions = this.#sessionConfig(params.cfg, params.agentId);
      let result = !force && sessions
        ? await unchangedSessionSync(sessions, join(run.directory, "index.sqlite"))
        : undefined;
      if (!result) {
        const { manager, error } = await this.getMemorySearchManager(params);
        if (!manager) throw new Error(error ?? "memory unavailable");
        result = await manager.syncSessions(force, writePhase);
      }
      await statusWrites;
      await atomicWriteJson(run.statusPath, {
        status: "completed",
        startedAt: run.startedAt,
        completedAt: new Date().toISOString(),
        ...result,
      });
    } catch (error) {
      await statusWrites.catch(() => {});
      try {
        await atomicWriteJson(run.statusPath, {
          status: "failed",
          startedAt: run.startedAt,
          completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // The next status read converts the persisted running state to interrupted.
      }
    } finally {
      await releaseSessionSyncLock(run.lockPath, run.token).catch(() => undefined);
    }
  }

  async sessionSyncStatus(agentId: string): Promise<SessionSyncStatus> {
    const directory = this.#stateDir(agentId);
    const lockPath = join(directory, SESSION_SYNC_LOCK_FILE);
    const statusPath = join(directory, SESSION_SYNC_STATUS_FILE);
    const lockState = await readSessionSyncLock(lockPath);
    if (lockState.exists && lockState.lock && isProcessAlive(lockState.lock.pid)) {
      const status = await readJson<SessionSyncState>(statusPath);
      return runningStatusFromReceipt(status, lockState.lock.startedAt);
    }
    const status = await readJson<SessionSyncState>(statusPath);
    if (status?.status === "running") {
      return await recoverInterruptedSessionSync(directory, statusPath, status);
    }
    if (lockState.exists) {
      await tryReclaimStaleLock(directory, lockPath, lockState.lock);
      const refreshedLock = await readSessionSyncLock(lockPath);
      if (refreshedLock.exists && refreshedLock.lock && isProcessAlive(refreshedLock.lock.pid)) {
        const refreshedStatus = await readJson<SessionSyncState>(statusPath);
        return runningStatusFromReceipt(refreshedStatus, refreshedLock.lock.startedAt);
      }
      const refreshedStatus = await readJson<SessionSyncState>(statusPath);
      if (refreshedStatus?.status === "running") {
        return await recoverInterruptedSessionSync(directory, statusPath, refreshedStatus);
      }
      return refreshedStatus ?? { status: "idle" };
    }
    return status ?? { status: "idle" };
  }

  async #drainSessionSyncs(): Promise<void> {
    while (this.#activeSessionSyncs.size > 0) {
      await Promise.allSettled([...this.#activeSessionSyncs.values()]);
    }
  }

  async closeMemorySearchManager(params: { agentId: string }): Promise<void> {
    const { agentId } = params;
    const activeSync = this.#activeSessionSyncs.get(this.#stateDir(agentId));
    if (activeSync) await activeSync.catch(() => undefined);
    const previousClose = this.#closingManagers.get(agentId);
    const pending = this.#managers.get(agentId);
    this.#managers.delete(agentId);
    if (!previousClose && !pending) return;

    const closing = (async () => {
      let closeError: unknown;
      if (previousClose) {
        try {
          await previousClose;
        } catch (error) {
          closeError = error;
        }
      }
      if (pending) {
        let manager: QmdMemoryManager | undefined;
        try {
          manager = await pending;
        } catch {
          // Failed startup already cleaned up its own manager inside #createManager.
        }
        if (manager) {
          try {
            await manager.close();
          } catch (error) {
            closeError ??= error;
          }
        }
      }
      if (closeError !== undefined) throw closeError;
    })();

    this.#closingManagers.set(agentId, closing);
    try {
      await closing;
    } finally {
      if (this.#closingManagers.get(agentId) === closing) {
        this.#closingManagers.delete(agentId);
      }
    }
  }

  async closeAllMemorySearchManagers(): Promise<void> {
    this.stopSessionSyncSchedule();
    await this.#drainSessionSyncs();
    const agentIds = new Set([...this.#managers.keys(), ...this.#closingManagers.keys()]);
    await Promise.all([...agentIds].map((agentId) => this.closeMemorySearchManager({ agentId })));
  }

  async close(): Promise<void> {
    await this.closeAllMemorySearchManagers();
  }

  async searchSkills(
    params: { cfg: OpenClawConfig; agentId: string },
    query: string,
    minScore: number,
    limit: number,
  ) {
    const { manager, error } = await this.getMemorySearchManager(params);
    if (!manager) throw new Error(error ?? "memory unavailable");
    return manager.searchSkills(query, minScore, limit);
  }

  resolveSkillPath(params: { cfg: OpenClawConfig; agentId: string }, path: string): string | undefined {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const skillCorpora = this.#corpora.filter((corpus) => corpus.kind === "skills");
    return resolveConfiguredSkillPath(workspaceDir, path, resolveSources(workspaceDir, skillCorpora));
  }

  async #createManager(cfg: OpenClawConfig, agentId: string): Promise<QmdMemoryManager> {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const stateDir = this.#stateDir(agentId);
    const fileCorpora = this.#corpora.filter((corpus) => corpus.kind === "files" || corpus.kind === "skills");
    const sessions = this.#sessionConfig(cfg, agentId);
    const sources = resolveSources(workspaceDir, fileCorpora);
    const sessionSource = sessions
      ? resolveSessionSource(sessions.outputDir, sessions.chatTypes)
      : undefined;
    if (sessionSource) sources.push(sessionSource);
    const manager = new QmdMemoryManager({
      workspaceDir,
      dbPath: join(stateDir, "index.sqlite"),
      curationPath: join(stateDir, MEMORY_DATABASE),
      extraction: this.#extraction,
      sources,
      keepModelsWarm: this.#keepEmbeddingModelWarm,
      analysisExecutable: this.#analysisExecutable,
      sessions,
    });
    try {
      await manager.start();
    } catch (error) {
      // The manager is not in the runtime's resolved cache yet, so we own cleanup.
      await manager.close().catch(() => undefined);
      throw error;
    }
    return manager;
  }

  #sessionConfig(cfg: OpenClawConfig, agentId: string): ManagerSessionConfig | undefined {
    const corpus = this.#corpora.find(corpus => corpus.kind === "sessions");
    if (!corpus) return;
    const stateDir = this.#stateDir(agentId);
    const source = resolveSessionSource(join(stateDir, "sessions"), corpus.chatTypes);
    return {
      agentId, agentName: resolveAgentIdentity(cfg, agentId)?.name?.trim() || agentId,
      chatTypes: corpus.chatTypes, maxExpandedTokens: corpus.maxExpandedTokens,
      collection: source.collection, outputDir: source.root,
      databasePath: agentTranscriptDatabase(cfg, agentId),
      manifestPath: join(stateDir, "sessions-manifest.json"),
      timezone: resolveTimezone(cfg.agents?.defaults?.userTimezone?.trim()),
    };
  }

  #stateDir(agentId: string): string {
    return agentStateDir(agentId, this.#stateRoot);
  }

}
