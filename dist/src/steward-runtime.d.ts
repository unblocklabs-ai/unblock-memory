import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { MemoryAnalysisSummary, MemoryClusterDetail, MemoryClusterList, MemoryClusterSort } from "./analysis.js";
import type { UnblockMemoryConfig } from "./config.js";
import { type DeepThoughtDeps } from "./deep-thought.js";
import { type OutcomeLedgerPassResult } from "./outcome-ledger.js";
import { type CaptainsLogPassResult } from "./steward-captains-log.js";
import type { StewardConfig } from "./steward-config.js";
import { type CrystalsPassResult } from "./steward-crystals.js";
import { type CaptainsLogDecide, type ExpectationsPassResult, type ResolveFromCaptainsLogResult } from "./steward-expectations.js";
import { type PeopleShadowPassResult } from "./steward-people-shadow.js";
import { type OvernightThinkingPassResult } from "./steward-overnight.js";
import type { StewardRunner } from "./steward-runner.js";
import { WorkStore } from "./work-store.js";
/** Process-wide (all agents, all plugin instances) background Steward slot; returns a one-shot release or undefined at capacity. */
export declare function tryAcquireBackgroundSlot(maxActive: number): (() => void) | undefined;
export declare function activeBackgroundStewards(): number;
/** Structural subset of `QmdMemoryManager` the Crystals and Overnight passes use. */
type StewardMemoryManager = {
    listClusters(limit?: number): Promise<MemoryClusterList>;
    fetchCluster(params: {
        clusterId: string;
        topK?: number;
        offset?: number;
        sort?: MemoryClusterSort;
    }): Promise<MemoryClusterDetail>;
    recluster(options?: undefined, signal?: AbortSignal): Promise<MemoryAnalysisSummary>;
    getCollectionGenerations(corpora?: readonly string[]): Promise<Record<string, number>>;
    corpusForCollection(collection: string): string | undefined;
};
/** Memory access for the Crystals and Overnight passes; supplied by the plugin once its QMD runtime exists. */
export type StewardMemoryAccess = {
    getMemorySearchManager(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }): Promise<{
        manager: StewardMemoryManager | null;
        error?: string;
    }>;
    /** Only when `analysis.executable` is configured: lets the Crystals pass recluster stale or missing analysis. */
    analysisExecutable?: boolean;
    /** Headless `deep_thought` dependencies for one agent; undefined (deep_thought disabled) skips Voltaire/pre-answering. */
    deepThought?(agentId: string, cfg: OpenClawConfig): DeepThoughtDeps | undefined;
    /** Close one agent's manager after a CLI `--run`, so its file watchers never keep the CLI process alive. */
    release?(agentId: string): Promise<void>;
};
type StewardRuntimeOptions = {
    config: StewardConfig;
    /** Full plugin config (needed by publish-mode People Learning inventory and Captain's Log). */
    pluginConfig?: UnblockMemoryConfig;
    /**
     * Lazily built on the first background tick; undefined skips model-backed work (the Outcome Ledger and the
     * deterministic Expectations ingestion still run).
     */
    createRunner(): Pick<StewardRunner, "complete"> | undefined;
    /** Test seam; defaults to a dedicated `WorkStore` connection on the agent's memory database. */
    openWorkStore?(dbPath: string): WorkStore;
    dbPathForAgent?(agentId: string): string;
    transcriptDbForAgent?(cfg: OpenClawConfig, agentId: string): string;
    workspaceDirForAgent?(cfg: OpenClawConfig, agentId: string): string;
    listAgents?(cfg: OpenClawConfig): string[];
    shutdownGraceMs?: number;
    /** Test seam for the post-Captain's-Log d1.2 expectation check (defaults to `@unblocklabs/decisions`). */
    captainsLogDecide?: CaptainsLogDecide;
    /** Memory runtime bridge (lazy: the plugin builds its runtime after registering the Steward). Absent = Crystals skip. */
    memory?(): StewardMemoryAccess | undefined;
};
export declare function registerStewardRuntime(api: OpenClawPluginApi, options: StewardRuntimeOptions): {
    owner: string;
    tick: () => Promise<void>;
    stop: () => Promise<void>;
    lastResults: () => Map<string, PeopleShadowPassResult>;
    lastCaptainsLogResults: () => Map<string, CaptainsLogPassResult>;
    lastOutcomeLedgerResults: () => Map<string, OutcomeLedgerPassResult>;
    lastExpectationsResults: () => Map<string, ExpectationsPassResult>;
    lastCaptainsLogResolutions: () => Map<string, ResolveFromCaptainsLogResult>;
    lastCrystalsResults: () => Map<string, CrystalsPassResult>;
    lastOvernightResults: () => Map<string, OvernightThinkingPassResult>;
    enabled: boolean;
};
export {};
