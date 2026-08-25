import { join } from "node:path";
import {
  resolveAgentWorkspaceDir,
  resolveStateDir,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { MemoryPluginRuntimeContract } from "./contracts.js";
import { QmdMemoryManager } from "./manager.js";
import { resolveSource } from "./sources.js";

export class QmdMemoryRuntime implements MemoryPluginRuntimeContract {
  readonly #paths: readonly string[];
  readonly #analysisExecutable?: string;
  readonly #managers = new Map<string, Promise<QmdMemoryManager>>();

  constructor(paths: readonly string[], analysisExecutable?: string) {
    this.#paths = paths;
    this.#analysisExecutable = analysisExecutable;
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

  async #createManager(cfg: OpenClawConfig, agentId: string): Promise<QmdMemoryManager> {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const manager = new QmdMemoryManager({
      workspaceDir,
      dbPath: join(resolveStateDir(), "agents", agentId, "unblock-memory", "index.sqlite"),
      sources: this.#paths.map((source) => resolveSource(workspaceDir, source)),
      analysisExecutable: this.#analysisExecutable,
    });
    await manager.start();
    return manager;
  }
}
