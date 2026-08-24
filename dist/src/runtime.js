import { join } from "node:path";
import { resolveAgentWorkspaceDir, resolveStateDir, } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { QmdMemoryManager } from "./manager.js";
import { resolveSource } from "./sources.js";
export class QmdMemoryRuntime {
    #paths;
    #managers = new Map();
    constructor(paths) {
        this.#paths = paths;
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
        const manager = new QmdMemoryManager({
            workspaceDir,
            dbPath: join(resolveStateDir(), "agents", agentId, "unblock-qmd", "index.sqlite"),
            sources: this.#paths.map((source) => resolveSource(workspaceDir, source)),
        });
        await manager.start();
        return manager;
    }
}
