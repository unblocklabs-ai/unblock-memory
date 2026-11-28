import type { SkillCatalogEntry } from "./manager.js";
import { scoreSkillCatalog } from "./decision-ranking.js";
import { type SkillProposalKind, type SkillProposalUpsertResult, type SkillReplayMetrics, type SkillSource } from "./skill-proposals-store.js";
import type { StewardRunner, StewardUsage } from "./steward-runner.js";
import type { WorkStore } from "./work-store.js";
/**
 * Self-writing skills, review-only. One fenced, per-agent pass drafts three proposal kinds into `skill_proposals`
 * (always `pending`); it never writes a live `SKILL.md`:
 *
 * 1. `description_update` — offline description optimizer. Skills with missed activations (opened without a whisper) or poor
 *    precision (whispered, then ignored/hurt) get a candidate description, which must beat the live one on a replay of real
 *    historical prompts through the production `scoreSkillCatalog` before it is even proposed.
 * 2. `pitfall_patch` — grounded `## Pitfalls` additions from `hurt` skill outcomes and their shortfall postmortems.
 * 3. `new_skill` — complete `SKILL.md` drafts mined from procedural, high-signal memory crystals not covered by the catalog.
 */
export declare const SKILLS_WORK_KIND = "steward_skills";
export declare const SKILLS_DEFAULTS: {
    readonly intervalMinutes: 1440;
    /** History window for routing, opens, outcomes and postmortems (`0` = unlimited). */
    readonly lookbackDays: 30;
    readonly enableDescriptionOptimizer: true;
    readonly enablePitfallPatches: true;
    readonly enableNewSkills: true;
    /** Minimum labelled samples (positives + whispered-and-unused) before a skill is considered. */
    readonly minSamplesPerSkill: 5;
    readonly minRecallGainPp: 3;
    readonly maxFalseActivationPp: 1;
    readonly maxCriticalRegressions: 0;
    /**
     * Successfully replayed positives / negatives a candidate needs before the recall / false-activation gates can pass;
     * fewer makes the replay indeterminate instead of vacuously passing (`0` = no minimum).
     */
    readonly minPositivesEvaluated: 1;
    readonly minNegativesEvaluated: 1;
    /** Share (`0..1`) of replay examples whose scorer judgment may fail before the replay is indeterminate (`1` = any). */
    readonly maxReplayFailureRate: 0.25;
    /** Model calls per phase per pass (`0` = unlimited). */
    readonly maxDescriptionsPerRun: 3;
    readonly maxPitfallsPerRun: 3;
    readonly maxNewSkillsPerRun: 2;
    /** Positive + negative prompts replayed per candidate (`0` = unlimited). */
    readonly maxReplayExamples: 40;
    /** Concurrent replay judgments, each one `scoreCatalog` call (`0` = all at once). */
    readonly replayConcurrency: 4;
    /** Per replay judgment (`0` = the decision model's unbounded default). */
    readonly replayTimeoutMs: 0;
    /** Replay activation threshold (`undefined` = production `skillWhisperer.minDecisionUsefulness`). */
    readonly replayMinUsefulness: number;
    /** Hurt outcomes + postmortems a skill needs before a pitfall patch is drafted. */
    readonly minPitfallEvidence: 2;
    /** Evidence items sent per skill (`0` = unlimited). */
    readonly maxEvidencePerSkill: 12;
    /** Characters per evidence item / example prompt (`0` = unlimited). */
    readonly maxEvidenceChars: 1200;
    /** Characters of the live SKILL.md body sent to the model (`0` = unlimited). */
    readonly maxSkillBodyChars: 8000;
    /** Characters of a proposed description (`0` = unlimited). */
    readonly maxDescriptionChars: 0;
    /** Crystal corpora allowed into new-skill mining; opt `sessions`/`extracted` in explicitly. */
    readonly allowedCorpora: readonly ["memory", "knowledge"];
    /** Crystal audiences allowed into new-skill mining (`"*"` = any audience). */
    readonly allowedAudiences: readonly ["workspace"];
    /** Chat types whose historical prompts may be replayed / quoted (`"unknown"` covers rows without one). */
    readonly allowedChatTypes: readonly ["workspace", "channel"];
    /** An STM crystal qualifies with at least this many hits, or this brightness; LTM crystals always qualify. */
    readonly newSkillMinHits: 3;
    readonly newSkillMinBrightness: 0.75;
    /** Token overlap coefficient at which a catalog skill already covers a crystal's theme. */
    readonly coverageMinOverlap: 0.5;
    /** Per model call (`0` = unlimited; the pass signal still aborts). */
    readonly timeoutMs: 0;
};
type ScoreParams = Parameters<typeof scoreSkillCatalog>[0];
/** Production default: `scoreSkillCatalog`. Tests and offline tools inject a seam with the same contract. */
export type SkillCatalogScorer = (params: ScoreParams) => Promise<ReadonlyArray<{
    index: number;
    score: number;
}>>;
export type SkillReplayDecision = {
    apiKey: string;
    endpoint?: string;
    model?: string;
};
export type StewardSkillsPassOptions = {
    agentId: string;
    owner: string;
    workStore: WorkStore;
    runner?: Pick<StewardRunner, "complete">;
    catalog: readonly SkillCatalogEntry[];
    /** Replay scorer; defaults to production `scoreSkillCatalog` (which needs `decision.apiKey`). */
    scoreCatalog?: SkillCatalogScorer;
    decision?: SkillReplayDecision;
    intervalMinutes?: number;
    lookbackDays?: number;
    enableDescriptionOptimizer?: boolean;
    enablePitfallPatches?: boolean;
    enableNewSkills?: boolean;
    minSamplesPerSkill?: number;
    minRecallGainPp?: number;
    maxFalseActivationPp?: number;
    maxCriticalRegressions?: number;
    minPositivesEvaluated?: number;
    minNegativesEvaluated?: number;
    maxReplayFailureRate?: number;
    maxDescriptionsPerRun?: number;
    maxPitfallsPerRun?: number;
    maxNewSkillsPerRun?: number;
    maxReplayExamples?: number;
    replayConcurrency?: number;
    replayTimeoutMs?: number;
    replayMinUsefulness?: number;
    minPitfallEvidence?: number;
    maxEvidencePerSkill?: number;
    maxEvidenceChars?: number;
    maxSkillBodyChars?: number;
    maxDescriptionChars?: number;
    allowedCorpora?: readonly string[];
    allowedAudiences?: readonly string[];
    allowedChatTypes?: readonly string[];
    newSkillMinHits?: number;
    newSkillMinBrightness?: number;
    coverageMinOverlap?: number;
    timeoutMs?: number;
    /**
     * Configured skills sources (root + glob): catalog skills outside them are skipped before any model spend, with the
     * same admission check `skill-apply` enforces. Absent = every catalog skill is considered.
     */
    allowedSkillSources?: readonly SkillSource[];
    /** Operator run: start before the schedule (never steals a live lease). */
    ignoreDueAt?: boolean;
    signal?: AbortSignal;
    leaseMs?: number;
    heartbeatMs?: number;
    now?: () => number;
};
type SkillProposalRejection = {
    kind: SkillProposalKind;
    skillName: string;
    reason: string;
    replayMetrics?: SkillReplayMetrics;
};
type Outcome = {
    status: "ok" | "aborted" | "already_running" | "not_due";
} | {
    status: "failed";
    reason: string;
};
export type StewardSkillsPassResult = Outcome & {
    /** Newly inserted `pending` proposals per kind. */
    descriptionUpdates: number;
    pitfallPatches: number;
    newSkills: number;
    /** Steward model calls actually made (the unit the per-phase caps count). */
    modelCalls: number;
    /** Replay judgments made (baseline + candidate). */
    replayJudgments: number;
    proposals: Array<{
        id: string;
        kind: SkillProposalKind;
        skillName: string;
        action: SkillProposalUpsertResult["action"];
    }>;
    rejected: SkillProposalRejection[];
    /** Isolated failures (`<kind>:<skill>:<code>`) that did not stop the pass. */
    errors: string[];
    nextDueAt?: number;
    usage?: StewardUsage;
};
/** What a replayed prompt is: the exact request the skill router saw, or the run's recall query standing in for it. */
type ReplayBasis = "routed_request" | "query_proxy";
export type ReplayExample = {
    prompt: string;
    label: "positive" | "negative";
    source: string;
    basis?: ReplayBasis;
};
export type ReplayGates = {
    minRecallGainPp: number;
    maxFalseActivationPp: number;
    maxCriticalRegressions: number;
    /** Indeterminate (never a pass) below these successfully evaluated counts, or above this scorer failure share. */
    minPositivesEvaluated: number;
    minNegativesEvaluated: number;
    minSamplesEvaluated: number;
    maxReplayFailureRate: number;
};
export type ReplayOutcome = {
    metrics: SkillReplayMetrics;
    judgments: number;
    failures: number;
};
/**
 * Replay real examples through the production scorer for BOTH descriptions. Each judgment is one isolated single-candidate
 * call (the production scorer judges every skill independently), so a candidate is measured exactly as it would be routed.
 * `concurrency` bounds the individual `scoreCatalog` calls in flight (baseline and candidate count separately), so `1`
 * means strictly one judgment at a time. An example whose baseline or candidate judgment fails is dropped from both sides
 * (and counted in `examplesFailed`).
 */
export declare function replaySkillDescription(params: {
    skillName: string;
    baselineDescription: string;
    candidateDescription: string;
    examples: readonly ReplayExample[];
    scoreCatalog: SkillCatalogScorer;
    decision: SkillReplayDecision;
    timeoutMs: number;
    minUsefulness: number;
    concurrency?: number;
    signal?: AbortSignal;
}): Promise<ReplayOutcome>;
/**
 * `undefined` when every gate passes; otherwise the first failing gate. Too few successfully evaluated positives,
 * negatives or samples, or too many failed judgments, is `indeterminate:*`: a gate can never pass vacuously.
 */
export declare function replayGateFailure(metrics: SkillReplayMetrics, gates: ReplayGates): string | undefined;
export declare function runStewardSkillsPass(options: StewardSkillsPassOptions): Promise<StewardSkillsPassResult>;
export {};
