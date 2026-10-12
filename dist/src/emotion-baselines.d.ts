import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
export declare const INSIDE_OUT_EMOTIONS: readonly ["joy", "sadness", "fear", "anger", "disgust", "surprise"];
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
/** Immutable, content-addressed revisions; no inference and no modifications to raw grades. */
export declare function refreshEmotionBaselines(db: DatabaseSync, options: {
    minInteractions: number;
    now?: number;
    recompare?: boolean;
}): {
    snapshots: number;
    comparisons: number;
};
export declare function personalDeviation(db: DatabaseSync, row: Row, history?: boolean): PersonalDeviation | {
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
    is_current: number;
    weekly: Summary;
    cumulative: Summary;
}[];
export {};
