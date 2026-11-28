import { DatabaseSync } from "node:sqlite";
/**
 * Strong memories track high *relative* emotion: joy at a launch or birth, grief or stress at a major failure. The score
 * is symmetric over valence, so positive and negative peaks are equally salient.
 */
export type EmotionalSalienceSignal = {
    sessionId: string;
    messageId: string;
    /** Inside Out `intensity` (0..3) when graded; null on legacy rows without the column or value. */
    absoluteIntensity: number | null;
    /**
     * Mid-rank percentile (0..1) of this event against the person's own history, when a baseline exists: the person's
     * prior `intensity` grades (same presence rubric, model and `intensity_rubric`) first, else the hottest emotion's
     * `inside_out_deviations` percentile.
     */
    relativeIntensityPercentile: number | null;
    /** Largest one-sided (upper-tail) per-emotion unusualness, 0..1, from `inside_out_deviations`. */
    maxEmotionUnusualness: number | null;
    /** Inside Out `valence` when graded; null on legacy rows. */
    valence: number | null;
    dominantEmotion: string | null;
    /** 0..1, comparable across new and legacy rows (legacy rows are discounted by `legacyConfidence`). */
    salienceScore: number;
    highSalience: boolean;
    /** Neutral, prompt-safe cue such as `joy/milestone` or `stress/setback`; never a raw number. */
    label: string;
};
export type EmotionalSalienceOptions = {
    /** `highSalience` when `salienceScore >= minSalienceScore`. Default 0.7. */
    minSalienceScore?: number;
    /** `highSalience` whenever absolute intensity (0..3) reaches this, regardless of history. Default 2.2. */
    minAbsoluteIntensity?: number;
    /** Relative spikes only count from this absolute intensity (0..3) up, so a rare-but-trivial blip stays quiet. Default 1.5. */
    minRelativeIntensity?: number;
    /** Weight (0..1) of the relative upper tail against normalized absolute intensity. Default 0.6. */
    relativeWeight?: number;
    /** Multiplier (0..1) applied to legacy NULL-intensity scores, which are less certain. Default 0.85. */
    legacyConfidence?: number;
    /** Two opposite-valence emotions at or above this (0..1) are labelled mixed. Default 0.5. */
    mixedEmotionThreshold?: number;
    /** Prior intensity grades a person needs before relative intensity counts. Default `insideOut.baselineMinInteractions`'s default. */
    baselineMinInteractions?: number;
    /** SQLite busy timeout when opening by path. Default the plugin's main busy timeout. */
    busyTimeoutMs?: number;
    /** Upper bound (epoch ms) on a grade's observation time; set with or without `lookbackDays`. Default unbounded. */
    nowMs?: number;
    /** Only grades observed within this many days before `nowMs` count (`0` = no lower bound). Default unbounded. */
    lookbackDays?: number;
};
type ReaderOnly = "busyTimeoutMs" | "nowMs" | "lookbackDays";
export declare const DEFAULT_EMOTIONAL_SALIENCE_OPTIONS: {
    readonly minSalienceScore: 0.7;
    readonly minAbsoluteIntensity: 2.2;
    readonly minRelativeIntensity: 1.5;
    readonly relativeWeight: 0.6;
    readonly legacyConfidence: 0.85;
    readonly mixedEmotionThreshold: 0.5;
    readonly baselineMinInteractions: number;
};
export type PathSalience = {
    salienceScore: number;
    /** The same `highSalience` gate Captain's Log cues on; Crystals only prioritize these. */
    highSalience: boolean;
    absoluteIntensity: number | null;
    relativePercentile: number | null;
    observedAtMs: number | null;
};
export declare const salienceKey: (sessionId: string, messageId: string) => string;
type Db = DatabaseSync;
export type ResolvedEmotionalSalienceOptions = Required<Omit<EmotionalSalienceOptions, ReaderOnly>>;
/** Merges defaults and validates; throws `RangeError` on a misconfigured threshold or weight. */
export declare function resolveEmotionalSalienceOptions(options?: EmotionalSalienceOptions): ResolvedEmotionalSalienceOptions;
/**
 * Batch-loads salience keyed by {@link salienceKey}. Multiple rubrics for one message keep the strongest. Missing tables,
 * columns, files or not-yet-graded messages simply produce no entry.
 */
export declare function readSessionMessageSalience(dbOrPath: Db | string, sessionIds: readonly string[], options?: EmotionalSalienceOptions): Map<string, EmotionalSalienceSignal>;
/** The single most salient graded message per session, for Crystals and Brightness. */
export declare function readSessionMaxSalience(dbOrPath: Db | string, sessionIds: readonly string[], options?: EmotionalSalienceOptions): Map<string, EmotionalSalienceSignal>;
/**
 * Read-only salience for memory paths: daily notes (`…/YYYY-MM-DD.md` outside a session corpus) take the strongest
 * Captain's Log entry for that day, session projections take the session's strongest graded message. Unknown paths
 * are omitted. With `nowMs` / `lookbackDays`, out-of-window Captain's Log entries and grades never count.
 */
export declare function readPathSalience(dbOrPath: Db | string, agentId: string, paths: readonly string[], options?: EmotionalSalienceOptions): Map<string, PathSalience>;
export {};
