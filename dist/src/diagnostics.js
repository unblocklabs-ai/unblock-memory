import { RetrievalTelemetry } from "./retrieval-telemetry.js";
/** Process-local, content-free and bounded. Agent IDs are keys, never included in snapshots. */
export class WhispererDiagnostics {
    #agents = new Map();
    #entry(agentId) {
        let entry = this.#agents.get(agentId);
        if (!entry) {
            if (this.#agents.size >= 100)
                this.#agents.delete(this.#agents.keys().next().value);
            entry = { counts: { skill: {}, memory: {} }, telemetry: new RetrievalTelemetry() };
            this.#agents.set(agentId, entry);
        }
        return entry;
    }
    record(agentId, whisperer, outcome) {
        const entry = this.#entry(agentId).counts;
        entry[whisperer][outcome] = Math.min(Number.MAX_SAFE_INTEGER, (entry[whisperer][outcome] ?? 0) + 1);
    }
    measureMemory(agentId, observation) {
        this.#entry(agentId).telemetry.record("memoryWhisperer", observation);
    }
    snapshot(agentId) {
        const entry = this.#agents.get(agentId);
        return { skill: { ...entry?.counts.skill }, memory: { ...entry?.counts.memory },
            telemetry: entry?.telemetry.snapshot() ?? new RetrievalTelemetry().snapshot(),
            scope: "process lifetime; up to 100 agents" };
    }
}
