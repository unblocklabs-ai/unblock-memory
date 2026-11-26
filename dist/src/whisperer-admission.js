export function admissionKey(agentId, scope) {
    return JSON.stringify([agentId, scope]);
}
export class WhispererAdmissionTracker {
    #sessions = new Map();
    #maxSessions;
    #maxRuns;
    constructor(options) {
        this.#maxSessions = options.maxSessions;
        this.#maxRuns = options.maxRunsPerSession;
    }
    get size() {
        return this.#sessions.size;
    }
    #touch(key, entry) {
        this.#sessions.delete(key);
        this.#sessions.set(key, entry);
    }
    /**
     * Classify a prompt without side effects beyond LRU recency. Call before any early-return input checks,
     * then `admit` only when the prompt should actually run.
     */
    lookup(target) {
        const key = admissionKey(target.agentId, target.scope);
        const previous = this.#sessions.get(key);
        if (!previous)
            return { kind: "fresh" };
        this.#touch(key, previous);
        if (previous.runId === target.runId)
            return { kind: "replay", result: previous.result };
        // Ignore delayed prompt rebuilds for already-superseded runs so they never replace the latest run.
        if (previous.seenRuns.has(target.runId))
            return { kind: "superseded" };
        return { kind: "fresh", previous };
    }
    /** Supersede any previous run in this session, evict the LRU session when full, and track the new run. */
    admit(target) {
        const key = admissionKey(target.agentId, target.scope);
        const previous = this.#sessions.get(key);
        previous?.controller.abort();
        if (!previous && this.#sessions.size >= this.#maxSessions) {
            const oldestKey = this.#sessions.keys().next().value;
            this.#sessions.get(oldestKey)?.controller.abort();
            this.#sessions.delete(oldestKey);
        }
        const seenRuns = previous?.seenRuns ?? new Set();
        seenRuns.add(target.runId);
        if (seenRuns.size > this.#maxRuns)
            seenRuns.delete(seenRuns.values().next().value);
        const controller = new AbortController();
        const entry = {
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
    isCurrent(entry) {
        return this.#sessions.get(entry.key) === entry;
    }
    /**
     * Abort the entry's controller after `timeoutMs` with a `TimeoutError` reason, so `abortedByTimeout`
     * distinguishes the turn deadline from supersession. Returns the disposer.
     */
    deadline(entry, timeoutMs, message = "Whisperer deadline") {
        const timer = setTimeout(() => entry.controller.abort(new DOMException(message, "TimeoutError")), timeoutMs);
        return () => clearTimeout(timer);
    }
    /** Abort and forget sessions matching a `session_end` event. */
    endSession(event, context) {
        for (const [key, entry] of this.#sessions) {
            if (context.agentId && entry.agentId !== context.agentId)
                continue;
            if (entry.sessionId === event.sessionId ||
                (entry.sessionKey && (entry.sessionKey === event.sessionKey || entry.sessionKey === context.sessionKey))) {
                entry.controller.abort();
                this.#sessions.delete(key);
            }
        }
    }
    /** Abort and forget every session. */
    stop() {
        for (const entry of this.#sessions.values())
            entry.controller.abort();
        this.#sessions.clear();
    }
    /** Register `session_end` and `gateway_stop` cleanup on a plugin API. */
    attach(api) {
        api.on("session_end", (event, context) => this.endSession(event, context));
        api.on("gateway_stop", () => this.stop());
    }
}
