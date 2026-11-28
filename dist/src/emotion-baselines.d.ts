import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
export declare const INSIDE_OUT_EMOTIONS: readonly ["joy", "sadness", "fear", "anger", "disgust", "surprise"];
/** Erased by an operator purge: never retried, linked, aggregated or compared. */
export declare const PURGED_GRADE = "Purged by operator";
type Emotion = typeof INSIDE_OUT_EMOTIONS[number];
type Row = Record<string, SQLOutputValue>;
type Statistics = {
    count: number;
    mean: number | null;
    min: number | null;
    p10: number | null;
    median: number | null;
    p90: number | null;
    max: number | null;
    distribution: [number, number][];
};
type Summary = Record<Emotion, Statistics>;
type Deviation = {
    delta: number;
    percentile: number;
    unusualness: number;
};
type Comparison = {
    status: "ok" | "insufficient_history";
    count: number;
    emotions: Record<Emotion, Deviation> | null;
};
type PersonalDeviation = {
    version: string;
    status: "ok" | "insufficient_history" | "unlinked_person" | "missing_time" | "future_time" | "grade_failed";
    personId: string | null;
    baselineId: string | null;
    baselineEnd: number | null;
    assessedAt: number;
    minInteractions: number;
    cumulative: Comparison | null;
    weekly: Comparison | null;
};
/** Identity of one grade's inputs; an `inside_out_deviations` row describes a grade only while signatures match. */
export declare function gradeSignature(row: Row): string;
/**
 * One current, content-addressed snapshot per person, rubric, model and completed week.
 * Reads finish before each batch commits, so the shared store is never held for a whole pass.
 * No inference and no changes to raw grades.
 */
export declare function refreshEmotionBaselines(db: DatabaseSync, options: {
    minInteractions: number;
    now?: number;
    recompare?: boolean;
    expectedGenerations?: ReadonlyMap<string, number>;
}): {
    snapshots: number;
    comparisons: number;
};
/** Prepared once per export, not per row. */
export declare function deviationReader(db: DatabaseSync): (row: Row, history?: boolean) => PersonalDeviation | {
    status: string;
} | {
    history: {
        currentGrade: boolean;
        version: string;
        status: "ok" | "insufficient_history" | "unlinked_person" | "missing_time" | "future_time" | "grade_failed";
        personId: string | null;
        baselineId: string | null;
        baselineEnd: number | null;
        assessedAt: number;
        minInteractions: number;
        cumulative: Comparison | null;
        weekly: Comparison | null;
    }[];
    version: string;
    status: "ok" | "insufficient_history" | "unlinked_person" | "missing_time" | "future_time" | "grade_failed";
    personId: string | null;
    baselineId: string | null;
    baselineEnd: number | null;
    assessedAt: number;
    minInteractions: number;
    cumulative: Comparison | null;
    weekly: Comparison | null;
} | {
    history: {
        currentGrade: boolean;
        version: string;
        status: "ok" | "insufficient_history" | "unlinked_person" | "missing_time" | "future_time" | "grade_failed";
        personId: string | null;
        baselineId: string | null;
        baselineEnd: number | null;
        assessedAt: number;
        minInteractions: number;
        cumulative: Comparison | null;
        weekly: Comparison | null;
    }[];
    status: "not_compared";
};
/**
 * Weekly snapshots, newest first; cumulative statistics are prefix sums of each population's stored weeks.
 * `since` keeps weeks whose last day is on or after that UTC date (`week_end` is the exclusive next Monday).
 */
export declare function emotionBaselineHistory(db: DatabaseSync, options?: {
    personId?: string;
    since?: number;
    limit?: number;
}): {
    id: string;
    person_id: string;
    rubric: string;
    model: string;
    version: string;
    week_start: number;
    week_end: number;
    computed_at: number;
    weekly: Summary;
    cumulative: Summary;
}[];
/**
 * Snapshot of refresh inputs only (settings, current week, People tables, grades, and purge generations).
 * Captures input fingerprint and per-person purge generations in one read snapshot so purges committing
 * after the pre-pass snapshot are fenced out before refreshEmotionBaselines runs.
 */
export declare function baselineInputSnapshot(db: DatabaseSync, options: {
    minInteractions: number;
    now: number;
}): {
    inputFingerprint: string;
    personGenerations: Map<string, number>;
};
/**
 * Computes input fingerprint, full fingerprint, and purge generations inside one consistent SQLite
 * read snapshot so pre-pass fencing and post-pass certification never mix pre- and post-commit state.
 */
export declare function baselineFingerprints(db: DatabaseSync, options: {
    minInteractions: number;
    now: number;
}): {
    inputFingerprint: string;
    fullFingerprint: string;
    personGenerations: Map<string, number>;
};
/**
 * Changes whenever a refresh input could: grades, links, people, purge generations, stored results,
 * the current week, grades crossing `now`, or settings. Equal fingerprints mean a refresh would write nothing.
 */
export declare function baselineFingerprint(db: DatabaseSync, options: {
    minInteractions: number;
    now: number;
}): string;
/**
 * Delete one person's baselines and assessment history. With `grades`, also erase their six
 * probabilities and person link, keeping a tombstone so the reply is never sent to the decision model again, and scrub
 * the emotion values other ledgers derived from those grades: Captain's Log salience grounded on a purged message
 * (the log text stays) and Inside Out signals on Outcome Ledger rows in a purged session (verdicts stay).
 */
export declare function purgeEmotionProfile(db: DatabaseSync, personId: string, options?: {
    grades?: boolean;
}): {
    baselines: number;
    assessments: number;
    grades: number;
    captainsLogEntries: number;
    outcomes: number;
};
declare const INTENSITY_VERSION = "intensity-upper-tail-v1";
export type RelativeIntensity = {
    version: typeof INTENSITY_VERSION;
    status: "ok" | "insufficient_history" | "unknown_intensity" | "unlinked_person" | "missing_time" | "grade_failed";
    /** The grade's own 0..3 expected intensity; never replaced by the relative view. NULL = not graded for intensity. */
    absoluteIntensity: number | null;
    /** Prior non-null intensity grades for the same person, presence rubric, model and intensity rubric. */
    count: number;
    minInteractions: number;
    intensityMean: number | null;
    /** Midrank share of prior grades at or below this one: 1 means more intense than anything seen before. */
    intensityPercentile: number | null;
    /** One-sided upper tail: `max(0, intensity - intensityMean)`. Calm-for-them is 0, never negative. */
    intensitySpike: number | null;
};
/**
 * One-sided upper-tail intensity relative to the person's own earlier grades. Prepared once per export.
 * A stoic person's rare 2 lands near the top of their distribution even though it is only "clear" in absolute terms.
 */
export declare function intensityReader(db: DatabaseSync, options?: {
    minInteractions?: number;
}): (row: Row) => RelativeIntensity;
export type IntensityProfile = {
    personId: string;
    intensityRubric: string;
    count: number;
    mean: number;
    median: number;
    p90: number;
    max: number;
    firstAt: number;
    lastAt: number;
};
/** Per-person absolute intensity distribution (0..3), from grades that carry one. Old NULL rows are excluded, not zero. */
export declare function intensityProfiles(db: DatabaseSync, options?: {
    personId?: string;
    now?: number;
}): IntensityProfile[];
export declare const SENTIMENT_DRIFT_METRICS: readonly ["valence", "anger", "agent_frustration", "agent_dissatisfaction"];
export type SentimentDriftMetric = typeof SENTIMENT_DRIFT_METRICS[number];
export type SentimentDriftOptions = {
    now?: number;
    personId?: string;
    /** Restrict Inside Out grades to one presence rubric (default: all, so long horizons survive endpoint changes). */
    rubric?: string;
    /** Recent window length in weeks ending at `now`. */
    recentWeeks?: number;
    /** How many of the person's earliest stable weeks form the anchored baseline. */
    anchorWeeks?: number;
    /** A calendar week counts toward the anchor only with at least this many samples. */
    minWeeklySamples?: number;
    minAnchorSamples?: number;
    minRecentSamples?: number;
    /** Restrict Response Audit evidence to one cohort; default uses each episode's latest assessment in any cohort. */
    responseCohort?: string;
    /** Minimum Response Audit confidence for a dissatisfaction score to count (0 accepts every score). */
    minResponseConfidence?: number;
    /** Worsening of the recent mean versus the anchor that flags drift; `null` disables a metric's drift flag. */
    driftThresholds?: Partial<Record<SentimentDriftMetric, number | null>>;
    /** Absolute recent level that flags a sustained problem even without drift; `null` disables it. */
    levelThresholds?: Partial<Record<SentimentDriftMetric, number | null>>;
};
export type SentimentDriftReport = {
    personId: string;
    metric: SentimentDriftMetric;
    direction: "lower_is_worse" | "higher_is_worse";
    /** Sample-weighted mean of the earliest stable weeks, all ending before the recent window starts. */
    anchoredMean: number | null;
    anchorStart: number | null;
    anchorEnd: number | null;
    anchorSamples: number;
    recentMean: number | null;
    recentStart: number;
    recentSamples: number;
    /** recentMean - anchoredMean, signed in the metric's own units. */
    absoluteDelta: number | null;
    /** absoluteDelta oriented so positive is always worse. */
    worsening: number | null;
    /** The recent absolute level itself (same as recentMean), never normalized against the person. */
    recentAbsoluteLevel: number | null;
    /** Latest observed week minus the one before: what a rolling comparison sees. Shown to expose masking. */
    rollingWeeklyDelta: number | null;
    weeksObserved: number;
    flagged: boolean;
    reason: string;
};
/**
 * Long-horizon drift per person and metric. The anchor is the person's earliest stable weeks, so a slow
 * week-over-week creep that a rolling baseline would absorb still shows as distance from where they started.
 * Read-only; derived on demand from grades and audit results, so nothing person-scoped is persisted here.
 */
export declare function detectSentimentDrift(db: DatabaseSync, options?: SentimentDriftOptions): SentimentDriftReport[];
/** Compact view for `memory-emotions baselines`: flagged entries plus counts. */
export declare function summarizeSentimentDrift(reports: readonly SentimentDriftReport[]): {
    people: number;
    evaluated: number;
    flagged: SentimentDriftReport[];
};
export {};
