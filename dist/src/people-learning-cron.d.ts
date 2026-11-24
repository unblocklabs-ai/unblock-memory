import type { OpenClawConfig, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { type PeopleLearningConfig } from "./people-learning-config.js";
export declare const LEARNING_TOOLS: string[];
export type PeopleCron = Pick<NonNullable<ReturnType<NonNullable<OpenClawPluginServiceContext["getCron"]>>>, "list" | "add" | "update">;
export type LearningJob = {
    id: string;
    agentId: string;
    kind: "nightly" | "weekly";
};
/** Service-owned cron, not bundled-only scheduleSessionTurn.
 * Stable declarations make a lost add response/reload safe. Legacy history stays on disabled originals.
 */
export declare function reconcilePeopleLearning(cron: PeopleCron, cfg: OpenClawConfig, config: PeopleLearningConfig, active?: () => boolean, onRecognize?: (jobs: readonly LearningJob[], fullSnapshot?: boolean) => void): Promise<LearningJob[]>;
export declare function learningSession(sessionKey: string | undefined, jobs: readonly LearningJob[]): LearningJob | undefined;
