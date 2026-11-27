import type { OpenClawConfig, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { type PeopleLearningConfig } from "./people-learning-config.js";
/**
 * Marks a People Learning cron that was disabled because Steward publishes People Learning directly.
 * The job (and its run history) is preserved so switching Steward back to shadow mode re-enables it.
 */
export declare const STEWARD_MANAGED_MARKER = "[steward-managed]";
export declare const LEARNING_TOOLS: string[];
export type PeopleCron = Pick<NonNullable<ReturnType<NonNullable<OpenClawPluginServiceContext["getCron"]>>>, "list" | "add" | "update">;
export type LearningJob = {
    id: string;
    agentId: string;
    kind: "nightly" | "weekly";
};
export type ReconcilePeopleLearningOptions = {
    /**
     * Steward publishes People Learning directly: never create `unblock-memory:people-learning:*` crons and disable
     * every existing (and exactly matched legacy) one with {@link STEWARD_MANAGED_MARKER}, preserving its history.
     * `false` re-enables previously steward-managed jobs under the normal opt-out rules.
     */
    stewardOwnsPublishing?: boolean;
};
/** Service-owned cron, not bundled-only scheduleSessionTurn.
 * Stable declarations make a lost add response/reload safe. Legacy history stays on disabled originals.
 */
export declare function reconcilePeopleLearning(cron: PeopleCron, cfg: OpenClawConfig, config: PeopleLearningConfig, active?: () => boolean, onRecognize?: (jobs: readonly LearningJob[], fullSnapshot?: boolean) => void, reconcileOptions?: ReconcilePeopleLearningOptions): Promise<LearningJob[]>;
export declare function learningSession(sessionKey: string | undefined, jobs: readonly LearningJob[]): LearningJob | undefined;
