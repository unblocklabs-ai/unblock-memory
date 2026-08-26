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
import { resolveSessionSource, resolveSources } from "./sources.js";

export class QmdMemoryRuntime implements MemoryPluginRuntimeContract {
  readonly #corpora: readonly CorpusConfig[];
  readonly #analysisExecutable?: string;
  readonly #managers = new Map<string, Promise<QmdMemoryManager>>();

  constructor(corpora: readonly CorpusConfig[], analysisExecutable?: string) {
    this.#corpora = corpora;
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
    const stateDir = join(resolveStateDir(), "agents", agentId, "unblock-memory");
    const fileCorpora = this.#corpora.filter((corpus) => corpus.kind === "files");
    const sessionCorpus = this.#corpora.find((corpus) => corpus.kind === "sessions");
    const sources = resolveSources(workspaceDir, fileCorpora);
    const sessionSource = sessionCorpus
      ? resolveSessionSource(join(stateDir, "sessions"), sessionCorpus.chatTypes)
      : undefined;
    if (sessionSource) sources.push(sessionSource);
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
