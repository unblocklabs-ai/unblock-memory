type Whisperer = "skill" | "memory";
type Outcome = "missing_key" | "typesafe_disabled" | "no_candidates" | "rejected" | "cooldown" |
  "emitted" | "failed" | "timed_out" | "cancelled" | "unavailable" | "payload_limit" | "redundancy_unavailable";

/** Process-local, content-free and bounded. Agent IDs are keys, never included in snapshots. */
export class WhispererDiagnostics {
  #agents = new Map<string, Record<Whisperer, Partial<Record<Outcome, number>>>>();

  record(agentId: string, whisperer: Whisperer, outcome: Outcome): void {
    let entry = this.#agents.get(agentId);
    if (!entry) {
      if (this.#agents.size >= 100) this.#agents.delete(this.#agents.keys().next().value!);
      entry = { skill: {}, memory: {} };
      this.#agents.set(agentId, entry);
    }
    entry[whisperer][outcome] = Math.min(Number.MAX_SAFE_INTEGER, (entry[whisperer][outcome] ?? 0) + 1);
  }

  snapshot(agentId: string) {
    const entry = this.#agents.get(agentId);
    return { skill: { ...entry?.skill }, memory: { ...entry?.memory }, scope: "process lifetime; up to 100 agents" };
  }
}
