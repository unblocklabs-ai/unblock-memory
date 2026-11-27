import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { type UnblockMemoryConfig } from "./config.js";
import { PeopleStores } from "./people-store.js";
import { type ReviewKind } from "./people-learning-inventory.js";
/** Whether automatic external analysis is approved for People Learning receipts (else receipts record `not_approved`). */
export declare function isPeopleLearningAnalysisApproved(config: UnblockMemoryConfig): boolean;
export type PeopleManifestEnsureResult = {
    kind: ReviewKind;
    runId?: string;
    manifestRevision?: string;
    status: "fresh" | "created" | "disabled" | "error";
    error?: string;
};
/**
 * Self-sufficient Steward publishing: create the immutable nightly/weekly People Learning manifest for the current
 * review window through the same `inventoryPeople` pipeline the cron's `inventory` action uses, but only when no fresh
 * manifest exists. Honors `people.learning` opt-outs exactly like the cron. Never touches cron jobs.
 */
export declare function ensurePeopleLearningManifests(options: {
    cfg: OpenClawConfig;
    config: UnblockMemoryConfig;
    agentId: string;
    stateRoot?: string;
    stores?: PeopleStores;
    kinds?: readonly ReviewKind[];
}): PeopleManifestEnsureResult[];
export type RegisterPeopleLearningOptions = {
    /**
     * When Steward publishes People Learning directly (`steward.peopleShadow.mode: "publish"`), the legacy
     * `unblock-memory:people-learning:*` crons are disabled (history preserved) and never created. Evaluated against the
     * live plugin config on every reconcile so a reload that switches back to `"shadow"` re-enables them.
     */
    stewardOwnsPublishing?: boolean | ((config: UnblockMemoryConfig) => boolean);
};
export declare function registerPeopleLearning(api: OpenClawPluginApi, initial: UnblockMemoryConfig, stores: PeopleStores, options?: RegisterPeopleLearningOptions): void;
/** Operator CLI keeps raw review output private; no main-agent default. */
export declare function registerPeopleLearningCli(api: OpenClawPluginApi, config: UnblockMemoryConfig): void;
