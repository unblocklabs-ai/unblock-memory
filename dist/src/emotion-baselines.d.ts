import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
export declare const INSIDE_OUT_EMOTIONS: readonly ["joy", "sadness", "fear", "anger", "disgust", "surprise"];
/** Erased by an operator purge: never retried, linked, aggregated or compared. */
export declare const PURGED_GRADE = "Purged by operator";
type Emotion = typeof INSIDE_OUT_EMOTIONS[number];
type Row = Record<string, SQLOutputValue>;
export declare const hash: (value: unknown) => string;
export declare const tableExists: (db: DatabaseSync, name: string) => boolean;
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
/**
 * One current, content-addressed snapshot per person, rubric, model and completed week.
 * Reads finish before each batch commits, so the shared store is never held for a whole pass.
 * No inference and no changes to raw grades.
 */
export declare function refreshEmotionBaselines(db: DatabaseSync, options: {
    minInteractions: number;
    now?: number;
    recompare?: boolean;
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
 * Changes whenever a refresh input could: grades, links, people, stored results, the current week,
 * grades crossing `now`, or settings. Equal fingerprints mean a refresh would write nothing.
 */
export declare function baselineFingerprint(db: DatabaseSync, options: {
    minInteractions: number;
    now: number;
}): string;
/**
 * Delete one person's baselines and assessment history. With `grades`, also erase their six
 * probabilities and person link, keeping a tombstone so the reply is never sent to Jev again.
 */
export declare function purgeEmotionProfile(db: DatabaseSync, personId: string, options?: {
    grades?: boolean;
}): {
    baselines: number;
    assessments: number;
    grades: number;
};
export {};
