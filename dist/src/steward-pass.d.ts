import type { StewardUsage } from "./steward-runner.js";
import { type WorkClaim, type WorkStore } from "./work-store.js";
/**
 * Lease mechanics shared by the fenced Steward passes. Acquisition, publication and each pass's retry/abort precedence
 * stay with the pass.
 */
/**
 * One pass's fence. `signal` aborts on the caller's signal, or once the heartbeat loses (or fails to renew) the lease.
 * One heartbeat at a time: `startHeartbeat` arms it for a (re)acquired claim.
 */
export type StewardFence = {
    readonly signal: AbortSignal;
    startHeartbeat(claim: WorkClaim): void;
    stopHeartbeat(): void;
    /** `error`, or the reason the heartbeat aborted the fence with, is a lost lease. */
    lost(error: unknown): boolean;
};
export declare function createStewardFence(workStore: WorkStore, options: {
    signal?: AbortSignal;
    leaseMs: number;
    heartbeatMs?: number;
    now: () => number;
}): StewardFence;
/** Why `claim()` came back empty: another live lease holds the row, or it is not due yet (and when it is due). */
export declare function claimMissStatus(workStore: WorkStore, key: {
    kind: string;
    scope: string;
}): {
    status: "already_running" | "not_due";
    dueAt: number | undefined;
};
/** Releases a failed or aborted attempt. `false` when its fence was already lost (nothing left to release); other errors throw. */
export declare function releaseFencedClaim(workStore: WorkStore, claim: WorkClaim, options: Parameters<WorkStore["fail"]>[1]): boolean;
/** Sums two completion receipts; a token or cost field appears once either side reported it. */
export declare function mergeCompletionUsage(total: StewardUsage | undefined, next: StewardUsage): StewardUsage;
