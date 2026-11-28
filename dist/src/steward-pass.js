import { startWorkHeartbeat, WorkFenceLostError } from "./work-store.js";
export function createStewardFence(workStore, options) {
    const fence = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, fence.signal]) : fence.signal;
    let heartbeat;
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
export function claimMissStatus(workStore, key) {
    const item = workStore.get(key.kind, key.scope);
    return { status: item?.status === "running" ? "already_running" : "not_due", dueAt: item?.dueAt };
}
/** Releases a failed or aborted attempt. `false` when its fence was already lost (nothing left to release); other errors throw. */
export function releaseFencedClaim(workStore, claim, options) {
    try {
        workStore.fail(claim, options);
        return true;
    }
    catch (error) {
        if (error instanceof WorkFenceLostError)
            return false;
        throw error;
    }
}
/** Sums two completion receipts; a token or cost field appears once either side reported it. */
export function mergeCompletionUsage(total, next) {
    if (!total)
        return { ...next };
    const sum = { requests: total.requests + next.requests };
    for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "costUsd"]) {
        if (total[key] !== undefined || next[key] !== undefined)
            sum[key] = (total[key] ?? 0) + (next[key] ?? 0);
    }
    return sum;
}
