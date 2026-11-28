import type { StewardUsage } from "./steward-runner.js";
import { startWorkHeartbeat, WorkFenceLostError, type WorkClaim, type WorkHeartbeat, type WorkStore } from "./work-store.js";

// Loaded by plain-Node workers and offline tools (`memory-steward overnight`): keep this module free of `openclaw`.

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

export function createStewardFence(workStore: WorkStore, options: {
  signal?: AbortSignal; leaseMs: number; heartbeatMs?: number; now: () => number;
}): StewardFence {
  const fence = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, fence.signal]) : fence.signal;
  let heartbeat: WorkHeartbeat | undefined;
  return {
    signal,
    startHeartbeat(claim) {
      heartbeat = startWorkHeartbeat(workStore, claim, {
        intervalMs: options.heartbeatMs ?? Math.max(1, Math.floor(options.leaseMs / 3)), leaseMs: options.leaseMs, now: options.now,
        onFenceLost: error => fence.abort(error), onError: error => fence.abort(error),
      });
    },
    stopHeartbeat() { heartbeat?.stop(); },
    lost: error => error instanceof WorkFenceLostError || fence.signal.reason instanceof WorkFenceLostError,
  };
}

/** Why `claim()` came back empty: another live lease holds the row, or it is not due yet (and when it is due). */
export function claimMissStatus(workStore: WorkStore, key: { kind: string; scope: string }):
  { status: "already_running" | "not_due"; dueAt: number | undefined } {
  const item = workStore.get(key.kind, key.scope);
  return { status: item?.status === "running" ? "already_running" : "not_due", dueAt: item?.dueAt };
}

/** Releases a failed or aborted attempt. `false` when its fence was already lost (nothing left to release); other errors throw. */
export function releaseFencedClaim(workStore: WorkStore, claim: WorkClaim, options: Parameters<WorkStore["fail"]>[1]): boolean {
  try {
    workStore.fail(claim, options);
    return true;
  } catch (error) {
    if (error instanceof WorkFenceLostError) return false;
    throw error;
  }
}

/** Sums two completion receipts; a token or cost field appears once either side reported it. */
export function mergeCompletionUsage(total: StewardUsage | undefined, next: StewardUsage): StewardUsage {
  if (!total) return { ...next };
  const sum: StewardUsage = { requests: total.requests + next.requests };
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "costUsd"] as const) {
    if (total[key] !== undefined || next[key] !== undefined) sum[key] = (total[key] ?? 0) + (next[key] ?? 0);
  }
  return sum;
}
