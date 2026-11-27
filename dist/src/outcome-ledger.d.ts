import { DatabaseSync } from "node:sqlite";
import { type WorkStore } from "./work-store.js";
export declare const OUTCOME_LEDGER_KIND = "outcome_ledger";
export declare class OutcomeLedgerStore {
    #private;
    readonly db: DatabaseSync;
    constructor(database: string | DatabaseSync, options?: {
        busyTimeoutMs?: number;
    });
    close(): void;
}
export type OutcomeSubjectKind = "memory_hit" | "skill" | "person_whisper";
type Verdict = "helped" | "ignored" | "hurt";
export type OutcomeLedgerPassOptions = {
    agentId: string;
    owner: string;
    /** Must open this agent's durable memory database (People/Audit/Inside Out are agent-local). */
    workStore: WorkStore;
    intervalMinutes?: number;
    lookbackMs?: number;
    maxRowsPerPass?: number;
    matchWindowMs?: number;
    retentionDays?: number;
    leaseMs?: number;
    heartbeatMs?: number;
    baselineMinInteractions?: number;
    /** Fallback tag for sources without a recipe column. Use only on homogeneous telemetry. */
    recipeHash?: string;
    /** When supplied, only consider episodes from the configured Response Audit cohort. */
    responseCohort?: string;
    signal?: AbortSignal;
    now?: () => number;
};
export type OutcomeLedgerPassResult = {
    status: "ok";
    measured: number;
    pruned: number;
    lastMeasuredAtMs: number;
    nextDueAt: number;
} | {
    status: "already_running" | "not_due" | "aborted";
} | {
    status: "failed";
    reason: string;
};
/** No model call. Read first, then atomically publish outcomes, retention and the sweep cursor under the lease fence. */
export declare function runOutcomeLedgerPass(options: OutcomeLedgerPassOptions): Promise<OutcomeLedgerPassResult>;
type VerdictCounts = Record<Verdict, number>;
type Metrics = {
    totalOutcomes: number;
    byVerdict: VerdictCounts;
    bySubjectKind: Record<OutcomeSubjectKind, number>;
    whisperUsedRate: number | null;
    skillOpenRate: number | null;
    shortfallsPer100Turns: number | null;
};
/** Range is [sinceMs, untilMs) on exposure time, so re-evaluation doesn't move an outcome between buckets. */
export declare function summarizeOutcomeMetrics(dbOrStore: DatabaseSync | OutcomeLedgerStore, options: {
    agentId: string;
    sinceMs?: number;
    untilMs?: number;
    recipeHash?: string;
}): Metrics & {
    byRecipe: Record<string, Metrics>;
};
/** Net score is the signed count of helpful minus harmful outcomes; ignored is neutral. */
export declare function getSubjectOutcomeStats(dbOrStore: DatabaseSync | OutcomeLedgerStore, options: {
    agentId: string;
    subjectKind: OutcomeSubjectKind;
    subjectId: string;
    sinceMs?: number;
}): VerdictCounts & {
    netScore: number;
};
export {};
