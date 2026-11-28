export function admissionKey(agentId, scope) {
    return JSON.stringify([agentId, scope]);
}
export class WhispererAdmissionTracker {
    #sessions = new Map();
    #maxSessions;
    #maxRuns;
    #sessionKeyScope;
    constructor(options) {
        this.#maxSessions = options.maxSessions;
        this.#maxRuns = options.maxRunsPerSession;
        this.#sessionKeyScope = options.sessionKeyScope ?? false;
    }
    get size() {
        return this.#sessions.size;
    }
    #touch(key, entry) {
        this.#sessions.delete(key);
        this.#sessions.set(key, entry);
    }
    #key(target) {
        return this.#sessionKeyScope ? target.scope : admissionKey(target.agentId, target.scope);
    }
    #forget(key) {
        this.#sessions.get(key)?.controller.abort();
        this.#sessions.delete(key);
    }
    /**
     * Classify a prompt without side effects beyond LRU recency. Call before any early-return input checks,
     * then `admit` only when the prompt should actually run.
     */
    lookup(target) {
        const key = this.#key(target);
        const previous = this.#sessions.get(key);
        if (!previous)
            return { kind: "fresh" };
        if (this.#sessionKeyScope && previous.sessionId !== target.sessionId) {
            this.#forget(key);
            return { kind: "fresh" };
        }
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
        const key = this.#key(target);
        const previous = this.#sessions.get(key);
        previous?.controller.abort();
        if (!previous && this.#sessions.size >= this.#maxSessions) {
            this.#forget(this.#sessions.keys().next().value);
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
            if (!this.#sessionKeyScope && context.agentId && entry.agentId !== context.agentId)
                continue;
            const matchesId = (!this.#sessionKeyScope || Boolean(event.sessionId)) && entry.sessionId === event.sessionId;
            if (matchesId ||
                (entry.sessionKey && (entry.sessionKey === event.sessionKey || entry.sessionKey === context.sessionKey))) {
                this.#forget(key);
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
