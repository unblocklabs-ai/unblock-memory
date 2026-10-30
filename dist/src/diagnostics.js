import { RetrievalTelemetry } from "./retrieval-telemetry.js";
/** Process-local, content-free and bounded. Agent IDs are keys, never included in snapshots. */
export class WhispererDiagnostics {
    static shared() {
        const scope = globalThis;
        // Bump the version whenever the shape changes so an older loaded copy is never reused.
        const symbol = Symbol.for("unblock-memory.whisperer-diagnostics.v2");
        return (scope[symbol] ??= new WhispererDiagnostics());
    }
    #agents = new Map();
    #entry(agentId) {
        let entry = this.#agents.get(agentId);
        if (!entry) {
            if (this.#agents.size >= 100)
                this.#agents.delete(this.#agents.keys().next().value);
            entry = { counts: { skill: {}, memory: {}, safety: {} }, safetyScenarios: new Map(), telemetry: new RetrievalTelemetry() };
            this.#agents.set(agentId, entry);
        }
        return entry;
    }
    record(agentId, whisperer, outcome) {
        const entry = this.#entry(agentId).counts;
        entry[whisperer][outcome] = Math.min(Number.MAX_SAFE_INTEGER, (entry[whisperer][outcome] ?? 0) + 1);
    }
    /** Scenario IDs are operator configuration, not conversation content. */
    recordSafetyMatch(agentId, scenarioId) {
        const matches = this.#entry(agentId).safetyScenarios;
        if (!matches.has(scenarioId) && matches.size >= 20)
            return;
        matches.set(scenarioId, Math.min(Number.MAX_SAFE_INTEGER, (matches.get(scenarioId) ?? 0) + 1));
    }
    measureMemory(agentId, observation) {
        this.#entry(agentId).telemetry.record("memoryWhisperer", observation);
    }
    measureSearch(agentId, observation) {
        this.#entry(agentId).telemetry.record("memorySearch", observation);
    }
    snapshot(agentId) {
        const entry = this.#agents.get(agentId);
        return { skill: { ...entry?.counts.skill }, memory: { ...entry?.counts.memory },
            safety: { ...entry?.counts.safety, matchedScenarios: Object.fromEntries(entry?.safetyScenarios ?? []) },
            telemetry: entry?.telemetry.snapshot() ?? new RetrievalTelemetry().snapshot(),
            scope: "process lifetime; up to 100 agents" };
    }
}
