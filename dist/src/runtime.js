import { join } from "node:path";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveStateDir, } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import { QmdMemoryManager } from "./manager.js";
import { resolveTimezone } from "./session-projector.js";
import { resolveSessionSource, resolveSources } from "./sources.js";
export class QmdMemoryRuntime {
    #corpora;
    #analysisExecutable;
    #managers = new Map();
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
