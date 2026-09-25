import { RetrievalTelemetry } from "./retrieval-telemetry.js";

type Whisperer = "skill" | "memory";
type Outcome = "missing_key" | "typesafe_disabled" | "no_candidates" | "rejected" | "cooldown" |
  "emitted" | "failed" | "timed_out" | "cancelled" | "unavailable" | "payload_limit" | "redundancy_unavailable" |
  "recall_not_needed" | "queries_generated" | "query_fallback" | "judge_candidate_failed";

/** Process-local, content-free and bounded. Agent IDs are keys, never included in snapshots. */
export class WhispererDiagnostics {
  static shared(): WhispererDiagnostics {
    const scope = globalThis as typeof globalThis & { [key: symbol]: unknown };
    const symbol = Symbol.for("unblock-memory.whisperer-diagnostics.v1");
    return (scope[symbol] ??= new WhispererDiagnostics()) as WhispererDiagnostics;
  }
  #agents = new Map<string, { counts: Record<Whisperer, Partial<Record<Outcome, number>>>; telemetry: RetrievalTelemetry }>();

  #entry(agentId: string) {
    let entry = this.#agents.get(agentId);
    if (!entry) {
      if (this.#agents.size >= 100) this.#agents.delete(this.#agents.keys().next().value!);
      entry = { counts: { skill: {}, memory: {} }, telemetry: new RetrievalTelemetry() };
      this.#agents.set(agentId, entry);
    }
    return entry;
  }

  record(agentId: string, whisperer: Whisperer, outcome: Outcome): void {
    const entry = this.#entry(agentId).counts;
    entry[whisperer][outcome] = Math.min(Number.MAX_SAFE_INTEGER, (entry[whisperer][outcome] ?? 0) + 1);
  }

  measureMemory(agentId: string, observation: Parameters<RetrievalTelemetry["record"]>[1]): void {
    this.#entry(agentId).telemetry.record("memoryWhisperer", observation);
  }

  snapshot(agentId: string) {
    const entry = this.#agents.get(agentId);
    return { skill: { ...entry?.counts.skill }, memory: { ...entry?.counts.memory },
      telemetry: entry?.telemetry.snapshot() ?? new RetrievalTelemetry().snapshot(),
      scope: "process lifetime; up to 100 agents" };
  }
}
