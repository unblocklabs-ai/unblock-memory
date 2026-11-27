import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import { type OutcomeLedgerPassResult } from "./outcome-ledger.js";
import { type CaptainsLogPassResult } from "./steward-captains-log.js";
import type { StewardConfig } from "./steward-config.js";
import { type CaptainsLogDecide, type ExpectationsPassResult, type ResolveFromCaptainsLogResult } from "./steward-expectations.js";
import { type PeopleShadowPassResult } from "./steward-people-shadow.js";
import type { StewardRunner } from "./steward-runner.js";
import { WorkStore } from "./work-store.js";
/** Process-wide (all agents, all plugin instances) background Steward slot; returns a one-shot release or undefined at capacity. */
export declare function tryAcquireBackgroundSlot(maxActive: number): (() => void) | undefined;
export declare function activeBackgroundStewards(): number;
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
    enabled: boolean;
};
export {};
