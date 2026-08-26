import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveStateDir,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { CorpusConfig } from "./config.js";
import type { MemoryPluginRuntimeContract } from "./contracts.js";
import { QmdMemoryManager } from "./manager.js";
import { resolveTimezone } from "./session-projector.js";
import type { SessionSyncResult } from "./session-sync.js";
import { resolveConfiguredSkillPath, resolveSessionSource, resolveSources } from "./sources.js";
import { classifyWorkspaceMemoryPaths } from "./workspace-path-classifier.js";

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
const activeSessionSyncs = new Map<string, string>();

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
    await rename(temporary, path);
  } finally {
    await removeIfPresent(temporary);
  }
}

export async function recoverInterruptedSessionSync(
  directory: string,
  statusPath: string,
  stale: StoredRunningSessionSync,
): Promise<SessionSyncStatus> {
  activeSessionSyncs.set(directory, stale.startedAt);
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
    if (activeSessionSyncs.get(directory) === stale.startedAt) activeSessionSyncs.delete(directory);
  }
}

export class QmdMemoryRuntime implements MemoryPluginRuntimeContract {
  readonly #corpora: readonly CorpusConfig[];
  readonly #analysisExecutable?: string;
  readonly #keepEmbeddingModelWarm: boolean;
  readonly #stateRoot: string;
  readonly #managers = new Map<string, Promise<QmdMemoryManager>>();

  constructor(
    corpora: readonly CorpusConfig[],
    options: {
      analysisExecutable?: string;
      keepEmbeddingModelWarm?: boolean;
      stateRoot?: string;
    } = {},
  ) {
    this.#corpora = corpora;
    this.#analysisExecutable = options.analysisExecutable;
    this.#keepEmbeddingModelWarm = options.keepEmbeddingModelWarm ?? true;
    this.#stateRoot = options.stateRoot ?? resolveStateDir();
  }

  async getMemorySearchManager(params: { cfg: OpenClawConfig; agentId: string }) {
    let pending = this.#managers.get(params.agentId);
    if (!pending) {
      pending = this.#createManager(params.cfg, params.agentId);
      this.#managers.set(params.agentId, pending);
    }
    try {
      return { manager: await pending };
    } catch (error) {
      this.#managers.delete(params.agentId);
      return { manager: null, error: error instanceof Error ? error.message : String(error) };
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
    const directory = this.#sessionSyncDirectory(params.agentId);
    const statusPath = join(directory, "session-sync-status.json");
    const running = activeSessionSyncs.get(directory);
    if (running) return { status: "already_running", startedAt: running };
    const startedAt = new Date().toISOString();
    activeSessionSyncs.set(directory, startedAt);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await atomicWriteJson(statusPath, {
        status: "running",
        phase: "queued",
        pid: process.pid,
        startedAt,
      });
    } catch (error) {
      if (activeSessionSyncs.get(directory) === startedAt) activeSessionSyncs.delete(directory);
      throw error;
    }
    void (async () => {
      let statusWrites = Promise.resolve();
      const writePhase = (phase: "projecting" | "indexing") => {
        statusWrites = statusWrites.then(() => atomicWriteJson(statusPath, {
          status: "running",
          phase,
          pid: process.pid,
          startedAt,
        }));
      };
      try {
        const { manager, error } = await this.getMemorySearchManager(params);
        if (!manager) throw new Error(error ?? "memory unavailable");
        const result = await manager.syncSessions(force, writePhase);
        await statusWrites;
        await atomicWriteJson(statusPath, {
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
          ...result,
        });
      } catch (error) {
        await statusWrites.catch(() => {});
        try {
          await atomicWriteJson(statusPath, {
            status: "failed",
            startedAt,
            completedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // The next status read converts the persisted running state to interrupted.
        }
      } finally {
        if (activeSessionSyncs.get(directory) === startedAt) activeSessionSyncs.delete(directory);
      }
    })().catch(() => {});
    return { status: "started", startedAt };
  }

  async sessionSyncStatus(agentId: string): Promise<SessionSyncStatus> {
    const directory = this.#sessionSyncDirectory(agentId);
    const statusPath = join(directory, "session-sync-status.json");
    const status = await readJson<SessionSyncState>(statusPath);
    const running = activeSessionSyncs.get(directory);
    if (running) {
      return status?.status === "running" && status.startedAt === running
        ? { status: "running", phase: status.phase, startedAt: running }
        : { status: "running", phase: "queued", startedAt: running };
    }
    if (!status) return { status: "idle" };
    if (status.status !== "running") return status;
    return await recoverInterruptedSessionSync(directory, statusPath, status);
  }

  async closeMemorySearchManager(params: { agentId: string }): Promise<void> {
    const pending = this.#managers.get(params.agentId);
    this.#managers.delete(params.agentId);
    await (await pending)?.close();
  }

  async closeAllMemorySearchManagers(): Promise<void> {
    const managers = [...this.#managers.values()];
    this.#managers.clear();
    await Promise.all(managers.map(async (pending) => (await pending).close()));
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
    const stateDir = join(this.#stateRoot, "agents", agentId, "unblock-memory");
    const fileCorpora = this.#corpora.filter((corpus) => corpus.kind === "files" || corpus.kind === "skills");
    const sessionCorpus = this.#corpora.find((corpus) => corpus.kind === "sessions");
    const sources = resolveSources(workspaceDir, fileCorpora);
    const sessionSource = sessionCorpus
      ? resolveSessionSource(join(stateDir, "sessions"), sessionCorpus.chatTypes)
      : undefined;
    if (sessionSource) sources.push(sessionSource);
    const manager = new QmdMemoryManager({
      workspaceDir,
      dbPath: join(stateDir, "index.sqlite"),
      curationPath: join(stateDir, "curation.sqlite"),
      sources,
      keepModelsWarm: this.#keepEmbeddingModelWarm,
      analysisExecutable: this.#analysisExecutable,
      ...(sessionCorpus && sessionSource ? {
        sessions: {
          agentId,
          agentName: resolveAgentIdentity(cfg, agentId)?.name?.trim() || agentId,
          chatTypes: sessionCorpus.chatTypes,
          collection: sessionSource.collection,
          databasePath: join(resolveAgentDir(cfg, agentId), "openclaw-agent.sqlite"),
          manifestPath: join(stateDir, "sessions-manifest.json"),
          outputDir: sessionSource.root,
          timezone: resolveTimezone(cfg.agents?.defaults?.userTimezone?.trim()),
        },
      } : {}),
    });
    await manager.start();
    return manager;
  }

  #sessionSyncDirectory(agentId: string): string {
    return join(this.#stateRoot, "agents", agentId, "unblock-memory");
  }

}
