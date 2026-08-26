import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveStateDir, } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import { QmdMemoryManager } from "./manager.js";
import { resolveTimezone } from "./session-projector.js";
import { resolveSessionSource, resolveSources } from "./sources.js";
import { classifyWorkspaceMemoryPaths } from "./workspace-path-classifier.js";
const activeSessionSyncs = new Map();
async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function removeIfPresent(path) {
    try {
        await unlink(path);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
async function atomicWriteJson(path, value) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, path);
    }
    finally {
        await removeIfPresent(temporary);
    }
}
export async function recoverInterruptedSessionSync(directory, statusPath, stale) {
    activeSessionSyncs.set(directory, stale.startedAt);
    try {
        const current = await readJson(statusPath);
        if (!current)
            return { status: "idle" };
        if (current.status !== "running")
            return current;
        if (current.startedAt !== stale.startedAt) {
            return { status: "running", phase: current.phase, startedAt: current.startedAt };
        }
        const failed = {
            status: "failed",
            startedAt: stale.startedAt,
            completedAt: new Date().toISOString(),
            error: "session sync interrupted by Gateway restart",
        };
        await atomicWriteJson(statusPath, failed);
        return failed;
    }
    finally {
        if (activeSessionSyncs.get(directory) === stale.startedAt)
            activeSessionSyncs.delete(directory);
    }
}
export class QmdMemoryRuntime {
    #corpora;
    #analysisExecutable;
    #keepEmbeddingModelWarm;
    #stateRoot;
    #managers = new Map();
    constructor(corpora, options = {}) {
        this.#corpora = corpora;
        this.#analysisExecutable = options.analysisExecutable;
        this.#keepEmbeddingModelWarm = options.keepEmbeddingModelWarm ?? true;
        this.#stateRoot = options.stateRoot ?? resolveStateDir();
    }
    async getMemorySearchManager(params) {
        let pending = this.#managers.get(params.agentId);
        if (!pending) {
            pending = this.#createManager(params.cfg, params.agentId);
            this.#managers.set(params.agentId, pending);
        }
        try {
            return { manager: await pending };
        }
        catch (error) {
            this.#managers.delete(params.agentId);
            return { manager: null, error: error instanceof Error ? error.message : String(error) };
        }
    }
    resolveMemoryBackendConfig() {
        return { backend: "builtin" };
    }
    classifyWorkspaceMemoryPaths = classifyWorkspaceMemoryPaths;
    async startSessionSync(params, force = false) {
        if (!this.#corpora.some((corpus) => corpus.kind === "sessions")) {
            return {
                status: "unavailable",
                error: 'memory session sync requires a configured "sessions" corpus',
            };
        }
        const directory = this.#sessionSyncDirectory(params.agentId);
        const statusPath = join(directory, "session-sync-status.json");
        const running = activeSessionSyncs.get(directory);
        if (running)
            return { status: "already_running", startedAt: running };
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
        }
        catch (error) {
            if (activeSessionSyncs.get(directory) === startedAt)
                activeSessionSyncs.delete(directory);
            throw error;
        }
        void (async () => {
            let statusWrites = Promise.resolve();
            const writePhase = (phase) => {
                statusWrites = statusWrites.then(() => atomicWriteJson(statusPath, {
                    status: "running",
                    phase,
                    pid: process.pid,
                    startedAt,
                }));
            };
            try {
                const { manager, error } = await this.getMemorySearchManager(params);
                if (!manager)
                    throw new Error(error ?? "memory unavailable");
                const result = await manager.syncSessions(force, writePhase);
                await statusWrites;
                await atomicWriteJson(statusPath, {
                    status: "completed",
                    startedAt,
                    completedAt: new Date().toISOString(),
                    ...result,
                });
            }
            catch (error) {
                await statusWrites.catch(() => { });
                try {
                    await atomicWriteJson(statusPath, {
                        status: "failed",
                        startedAt,
                        completedAt: new Date().toISOString(),
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
                catch {
                    // The next status read converts the persisted running state to interrupted.
                }
            }
            finally {
                if (activeSessionSyncs.get(directory) === startedAt)
                    activeSessionSyncs.delete(directory);
            }
        })().catch(() => { });
        return { status: "started", startedAt };
    }
    async sessionSyncStatus(agentId) {
        const directory = this.#sessionSyncDirectory(agentId);
        const statusPath = join(directory, "session-sync-status.json");
        const status = await readJson(statusPath);
        const running = activeSessionSyncs.get(directory);
        if (running) {
            return status?.status === "running" && status.startedAt === running
                ? { status: "running", phase: status.phase, startedAt: running }
                : { status: "running", phase: "queued", startedAt: running };
        }
        if (!status)
            return { status: "idle" };
        if (status.status !== "running")
            return status;
        return await recoverInterruptedSessionSync(directory, statusPath, status);
    }
    async closeMemorySearchManager(params) {
        const pending = this.#managers.get(params.agentId);
        this.#managers.delete(params.agentId);
        await (await pending)?.close();
    }
    async closeAllMemorySearchManagers() {
        const managers = [...this.#managers.values()];
        this.#managers.clear();
        await Promise.all(managers.map(async (pending) => (await pending).close()));
    }
    async #createManager(cfg, agentId) {
        const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
        const stateDir = join(this.#stateRoot, "agents", agentId, "unblock-memory");
        const fileCorpora = this.#corpora.filter((corpus) => corpus.kind === "files");
        const sessionCorpus = this.#corpora.find((corpus) => corpus.kind === "sessions");
        const sources = resolveSources(workspaceDir, fileCorpora);
        const sessionSource = sessionCorpus
            ? resolveSessionSource(join(stateDir, "sessions"), sessionCorpus.chatTypes)
            : undefined;
        if (sessionSource)
            sources.push(sessionSource);
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
    #sessionSyncDirectory(agentId) {
        return join(this.#stateRoot, "agents", agentId, "unblock-memory");
    }
}
