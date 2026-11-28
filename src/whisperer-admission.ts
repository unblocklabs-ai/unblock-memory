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

export type AdmissionLookup<TState, TResult> =
  | { kind: "replay"; result: Promise<TResult | undefined> | undefined }
  | { kind: "superseded" }
  | { kind: "fresh"; previous?: AdmissionEntry<TState, TResult> };

type LifecycleApi = Pick<OpenClawPluginApi, "on">;

export type WhispererAdmissionOptions = {
  maxSessions: number;
  maxRunsPerSession: number;
  /** My Turn tracks a session key across runs, resetting it when the host session ID changes. */
  sessionKeyScope?: boolean;
};

export function admissionKey(agentId: string, scope: string): string {
  return JSON.stringify([agentId, scope]);
}

export class WhispererAdmissionTracker<TState, TResult> {
  readonly #sessions = new Map<string, AdmissionEntry<TState, TResult>>();
  readonly #maxSessions: number;
  readonly #maxRuns: number;
  readonly #sessionKeyScope: boolean;

  constructor(options: WhispererAdmissionOptions) {
    this.#maxSessions = options.maxSessions;
    this.#maxRuns = options.maxRunsPerSession;
    this.#sessionKeyScope = options.sessionKeyScope ?? false;
  }

  get size(): number {
    return this.#sessions.size;
  }

  #touch(key: string, entry: AdmissionEntry<TState, TResult>): void {
    this.#sessions.delete(key);
    this.#sessions.set(key, entry);
  }

  #key(target: AdmissionTarget): string {
    return this.#sessionKeyScope ? target.scope : admissionKey(target.agentId, target.scope);
  }

  #forget(key: string): void {
    this.#sessions.get(key)?.controller.abort();
    this.#sessions.delete(key);
  }

  /**
   * Classify a prompt without side effects beyond LRU recency. Call before any early-return input checks,
   * then `admit` only when the prompt should actually run.
   */
  lookup(target: AdmissionTarget & { sessionId?: string }): AdmissionLookup<TState, TResult> {
    const key = this.#key(target);
    const previous = this.#sessions.get(key);
    if (!previous) return { kind: "fresh" };
    if (this.#sessionKeyScope && previous.sessionId !== target.sessionId) {
      this.#forget(key);
      return { kind: "fresh" };
    }
    this.#touch(key, previous);
    if (previous.runId === target.runId) return { kind: "replay", result: previous.result };
    // Ignore delayed prompt rebuilds for already-superseded runs so they never replace the latest run.
    if (previous.seenRuns.has(target.runId)) return { kind: "superseded" };
    return { kind: "fresh", previous };
  }

  /** Supersede any previous run in this session, evict the LRU session when full, and track the new run. */
  admit(target: AdmissionTarget & {
    sessionId?: string;
    sessionKey?: string;
    init: (previous?: TState) => TState;
  }): AdmissionEntry<TState, TResult> {
    const key = this.#key(target);
    const previous = this.#sessions.get(key);
    previous?.controller.abort();
    if (!previous && this.#sessions.size >= this.#maxSessions) {
      this.#forget(this.#sessions.keys().next().value!);
    }
    const seenRuns = previous?.seenRuns ?? new Set<string>();
    seenRuns.add(target.runId);
    if (seenRuns.size > this.#maxRuns) seenRuns.delete(seenRuns.values().next().value!);
    const controller = new AbortController();
    const entry: AdmissionEntry<TState, TResult> = {
      key,
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      runId: target.runId,
      turn: (previous?.turn ?? 0) + 1,
      controller,
      signal: controller.signal,
      seenRuns,
      state: target.init(previous?.state),
    };
    this.#touch(key, entry);
    return entry;
  }

  /** Whether `entry` is still the latest admitted run for its session (not superseded, evicted or ended). */
  isCurrent(entry: AdmissionEntry<TState, TResult>): boolean {
    return this.#sessions.get(entry.key) === entry;
  }

  /**
   * Abort the entry's controller after `timeoutMs` with a `TimeoutError` reason, so `abortedByTimeout`
   * distinguishes the turn deadline from supersession. Returns the disposer.
   */
  deadline(entry: AdmissionEntry<TState, TResult>, timeoutMs: number, message = "Whisperer deadline"): () => void {
    const timer = setTimeout(() => entry.controller.abort(new DOMException(message, "TimeoutError")), timeoutMs);
    return () => clearTimeout(timer);
  }

  /** Abort and forget sessions matching a `session_end` event. */
  endSession(event: { sessionId?: string; sessionKey?: string }, context: { agentId?: string; sessionKey?: string }): void {
    for (const [key, entry] of this.#sessions) {
      if (!this.#sessionKeyScope && context.agentId && entry.agentId !== context.agentId) continue;
      const matchesId = (!this.#sessionKeyScope || Boolean(event.sessionId)) && entry.sessionId === event.sessionId;
      if (matchesId ||
        (entry.sessionKey && (entry.sessionKey === event.sessionKey || entry.sessionKey === context.sessionKey))) {
        this.#forget(key);
      }
    }
  }

  /** Abort and forget every session. */
  stop(): void {
    for (const entry of this.#sessions.values()) entry.controller.abort();
    this.#sessions.clear();
  }

  /** Register `session_end` and `gateway_stop` cleanup on a plugin API. */
  attach(api: LifecycleApi): void {
    api.on("session_end", (event, context) => this.endSession(event, context));
    api.on("gateway_stop", () => this.stop());
  }
}
