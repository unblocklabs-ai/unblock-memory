import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
/**
 * Shared per-session turn admission for prompt-time whisperers.
 *
 * One tracked entry per (agentId, session scope). A prompt rebuild for the same run replays the cached
 * result, a delayed rebuild for an already-superseded run is ignored, and admitting a new run aborts the
 * previous run's controller. Sessions are evicted least-recently-used, and `session_end` / `gateway_stop`
 * abort and forget matching entries.
 */
export type AdmissionTarget = {
    agentId: string;
    /** `sessionId || sessionKey`: the identity two prompts must share to be the same conversation. */
    scope: string;
    runId: string;
};
export type AdmissionEntry<TState, TResult> = {
    readonly key: string;
    readonly agentId: string;
    readonly sessionId?: string;
    readonly sessionKey?: string;
    readonly runId: string;
    /** 1-based count of admitted runs in this session. */
    readonly turn: number;
    readonly controller: AbortController;
    readonly signal: AbortSignal;
    /** Bounded history of admitted run IDs, carried across turns. */
    readonly seenRuns: Set<string>;
    /** Whisperer-specific session data, carried across turns by `init`. */
    readonly state: TState;
    /** The in-flight or settled result replayed to same-run prompt rebuilds. */
    result?: Promise<TResult | undefined>;
};
export type AdmissionLookup<TState, TResult> = {
    kind: "replay";
    result: Promise<TResult | undefined> | undefined;
} | {
    kind: "superseded";
} | {
    kind: "fresh";
    previous?: AdmissionEntry<TState, TResult>;
};
type LifecycleApi = Pick<OpenClawPluginApi, "on">;
export type WhispererAdmissionOptions = {
    maxSessions: number;
    maxRunsPerSession: number;
};
export declare function admissionKey(agentId: string, scope: string): string;
export declare class WhispererAdmissionTracker<TState, TResult> {
    #private;
    constructor(options: WhispererAdmissionOptions);
    get size(): number;
    /**
     * Classify a prompt without side effects beyond LRU recency. Call before any early-return input checks,
     * then `admit` only when the prompt should actually run.
     */
    lookup(target: AdmissionTarget): AdmissionLookup<TState, TResult>;
    /** Supersede any previous run in this session, evict the LRU session when full, and track the new run. */
    admit(target: AdmissionTarget & {
        sessionId?: string;
        sessionKey?: string;
        init: (previous?: TState) => TState;
    }): AdmissionEntry<TState, TResult>;
    /** Whether `entry` is still the latest admitted run for its session (not superseded, evicted or ended). */
    isCurrent(entry: AdmissionEntry<TState, TResult>): boolean;
    /**
     * Abort the entry's controller after `timeoutMs` with a `TimeoutError` reason, so `abortedByTimeout`
     * distinguishes the turn deadline from supersession. Returns the disposer.
     */
    deadline(entry: AdmissionEntry<TState, TResult>, timeoutMs: number, message?: string): () => void;
    /** Abort and forget sessions matching a `session_end` event. */
    endSession(event: {
        sessionId?: string;
        sessionKey?: string;
    }, context: {
        agentId?: string;
        sessionKey?: string;
    }): void;
    /** Abort and forget every session. */
    stop(): void;
    /** Register `session_end` and `gateway_stop` cleanup on a plugin API. */
    attach(api: LifecycleApi): void;
}
export {};
