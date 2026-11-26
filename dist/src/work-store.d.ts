import { DatabaseSync } from "node:sqlite";
export type WorkMode = "run" | "item";
export type WorkStatus = "pending" | "running" | "staged" | "completed" | "quarantined";
export type WorkClaim = {
    readonly kind: string;
    readonly scope: string;
    readonly mode: WorkMode;
    readonly attempt: number;
    readonly owner: string;
    /** Saved progress from an earlier attempt (resume here instead of re-running inference). */
    readonly stage: string | null;
    readonly artifactJson: string | null;
    readonly inputRevision: string | null;
    readonly recipeHash: string | null;
};
export type WorkItem = {
    kind: string;
    scope: string;
    mode: WorkMode;
    status: WorkStatus;
    attempt: number;
    owner: string | null;
    leaseUntil: number;
    dueAt: number;
    inputRevision: string | null;
    recipeHash: string | null;
    stage: string | null;
    artifactJson: string | null;
    usageJson: string | null;
    strikes: number;
    lastError: string | null;
    updatedAt: number;
    /** The last attempt that saved stage progress (0 = never). */
    progressedAttempt: number;
};
export declare class WorkFenceLostError extends Error {
    readonly kind: string;
    readonly scope: string;
    readonly attempt: number;
    constructor(claim: Pick<WorkClaim, "kind" | "scope" | "attempt">, action: string);
}
/** Transient lock contention: the caller may simply try again later. */
export declare function isSqliteBusy(error: unknown): boolean;
export declare class WorkStore {
    #private;
    readonly db: DatabaseSync;
    /**
     * Pass an already-open `DatabaseSync` to commit domain writes and work transitions on the exact same
     * connection (required for `commitWithDomain` atomicity), or a path to open a dedicated connection.
     */
    constructor(database: string | DatabaseSync, options?: {
        busyTimeoutMs?: number;
    });
    close(): void;
    /**
     * Insert a row, or reset it only when its input revision or recipe changed. Resetting supersedes any
     * in-flight attempt: its fenced writes fail because the row is no longer `running`.
     */
    enqueue(options: {
        kind: string;
        scope: string;
        mode: WorkMode;
        dueAt?: number;
        inputRevision?: string | null;
        recipeHash?: string | null;
        now?: number;
    }): boolean;
    /**
     * Reclaim expired leases, then claim the earliest due `pending`/`staged` row (or the given `scope`).
     * `ignoreDueAt` lets an explicit operator run start before the schedule; it never steals a live lease.
     * `expectedInputRevision`/`expectedRecipeHash` refuse a row whose inputs advanced since the caller read them.
     */
    claim(options: {
        kind: string;
        scope?: string;
        mode?: WorkMode;
        owner: string;
        leaseMs: number;
        now?: number;
        maxStrikes?: number;
        ignoreDueAt?: boolean;
        expectedInputRevision?: string;
        expectedRecipeHash?: string;
    }): WorkClaim | undefined;
    /** Extend a live lease. Fenced by `attempt` only: a clock jump past `lease_until` never fails a healthy renew. */
    renew(claim: WorkClaim, leaseMs: number, now?: number, options?: {
        busyTimeoutMs?: number;
    }): void;
    /** Persist validated progress; a crash after this resumes from the artifact without re-running inference. */
    stageArtifact(claim: WorkClaim, options: {
        stage: string;
        artifactJson: string;
        usageJson?: string | null;
        now?: number;
    }): WorkClaim;
    /** Run a fenced domain write without completing the work row (incremental publication by a live attempt). */
    withFence<T>(claim: WorkClaim, domainFn: (db: DatabaseSync) => T): T;
    /**
     * Verify the fence, run the caller's synchronous domain write, and complete (or re-arm) the work row,
     * all inside one `BEGIN IMMEDIATE` on this connection. A lost fence throws before `domainFn` runs.
     */
    commitWithDomain<T>(claim: WorkClaim, options: {
        nextDueAt?: number;
        preserveDueAt?: boolean;
        usageJson?: string | null;
        keepArtifact?: boolean;
        now?: number;
    }, domainFn: (db: DatabaseSync) => T): T;
    /**
     * Release a failed attempt. `addStrike: false` (default) is graceful/transient: requeue with 0 strikes.
     * `addStrike: true` marks a deterministic bad item; `mode='item'` rows quarantine at `maxStrikes`.
     */
    fail(claim: WorkClaim, options: {
        error: string;
        retryAt?: number;
        preserveDueAt?: boolean;
        addStrike?: boolean;
        maxStrikes?: number;
        usageJson?: string | null;
        now?: number;
    }): WorkStatus;
    /**
     * Synchronous graceful release for `gateway_stop` (no strikes). Rows with a saved artifact become `staged`
     * (resumable), others `pending`. Bumps `attempt`, so the released worker is fenced out at once. Waits at most
     * 200ms for a held write lock, then throws `SQLITE_BUSY` (the lease simply expires instead).
     */
    interruptOwner(owner: string, now?: number): number;
    /** Operator re-drive (including quarantined rows). Never steals a live lease. */
    requeue(kind: string, scope: string, dueAt?: number, now?: number): boolean;
    get(kind: string, scope: string): WorkItem | undefined;
    list(kind?: string): WorkItem[];
}
export type WorkHeartbeat = {
    stop(): void;
};
/**
 * Renew a claim periodically. Transient `SQLITE_BUSY` is a skipped beat; only `WorkFenceLostError`
 * (the row was reclaimed, interrupted, or reset) calls `onFenceLost`, once, and stops the heartbeat.
 */
export declare function startWorkHeartbeat(store: WorkStore, claim: WorkClaim, options: {
    intervalMs: number;
    leaseMs: number;
    onFenceLost: (error: WorkFenceLostError) => void;
    onError?: (error: unknown) => void;
    now?: () => number;
}): WorkHeartbeat;
