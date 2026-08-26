import { join } from "node:path";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveStateDir, } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import { QmdMemoryManager } from "./manager.js";
import { resolveTimezone } from "./session-projector.js";
import { resolveSessionSource, resolveSources } from "./sources.js";
import { classifyWorkspaceMemoryPaths } from "./workspace-path-classifier.js";
export class QmdMemoryRuntime {
    #corpora;
    #analysisExecutable;
    #managers = new Map();
    #sessionSyncStatuses = new Map();
    constructor(corpora, analysisExecutable) {
        this.#corpora = corpora;
        this.#analysisExecutable = analysisExecutable;
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
    startSessionSync(params, force = false) {
        if (!this.#corpora.some((corpus) => corpus.kind === "sessions")) {
            return {
                status: "unavailable",
                error: 'memory session sync requires a configured "sessions" corpus',
            };
        }
        const current = this.sessionSyncStatus(params.agentId);
        if (current.status === "running") {
            return { status: "already_running", startedAt: current.startedAt };
        }
        const startedAt = new Date().toISOString();
        this.#sessionSyncStatuses.set(params.agentId, { status: "running", phase: "queued", startedAt });
        const run = async () => {
            const { manager, error } = await this.getMemorySearchManager(params);
            if (!manager)
                throw new Error(error ?? "memory unavailable");
            return await manager.syncSessions(force, (phase) => {
                this.#sessionSyncStatuses.set(params.agentId, { status: "running", phase, startedAt });
            });
        };
        void run().then((result) => {
            this.#sessionSyncStatuses.set(params.agentId, {
                status: "completed",
                startedAt,
                completedAt: new Date().toISOString(),
                ...result,
            });
        }, (error) => {
            this.#sessionSyncStatuses.set(params.agentId, {
                status: "failed",
                startedAt,
                completedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : String(error),
            });
        });
        return { status: "started", startedAt };
    }
    sessionSyncStatus(agentId) {
        return this.#sessionSyncStatuses.get(agentId) ?? { status: "idle" };
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
        const stateDir = join(resolveStateDir(), "agents", agentId, "unblock-memory");
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
            sources,
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
}
