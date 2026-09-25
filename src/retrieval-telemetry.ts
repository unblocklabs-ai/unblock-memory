type RetrievalOperation = "vector" | "lexical" | "memoryWhisperer";
type RetrievalOutcome = "ok" | "empty" | "failed" | "cancelled" | "timed_out" | "skipped";
const fields = ["elapsedMs", "retrievalMs", "judgeMs", "gateMs", "generationMs", "candidates", "eligible", "results", "contextChars"] as const;
type Field = typeof fields[number];
export type RetrievalObservation = { outcome: RetrievalOutcome; elapsedMs: number } & Partial<Record<Field, number>>;
type Entry = {
  calls: number;
  outcomes: Partial<Record<RetrievalOutcome, number>>;
  totals: Partial<Record<Field, { sum: number; samples: number }>>;
  recent: Partial<Record<Field, number>>[];
};

const recentLimit = 256;
const boundedAdd = (left: number, right: number) => Math.min(Number.MAX_SAFE_INTEGER, left + right);

/** Only fixed operation/outcome names and nonnegative numbers enter this store. */
export class RetrievalTelemetry {
  #entries = new Map<RetrievalOperation, Entry>();

  record(operation: RetrievalOperation, observation: RetrievalObservation): void {
    const entry = this.#entries.get(operation) ?? { calls: 0, outcomes: {}, totals: {}, recent: [] } satisfies Entry;
    this.#entries.set(operation, entry);
    entry.calls = boundedAdd(entry.calls, 1);
    entry.outcomes[observation.outcome] = boundedAdd(entry.outcomes[observation.outcome] ?? 0, 1);
    const sample: Partial<Record<Field, number>> = {};
    for (const field of fields) {
      const value = observation[field];
      if (value === undefined || !Number.isFinite(value) || value < 0) continue;
      sample[field] = value;
      const total = entry.totals[field] ?? { sum: 0, samples: 0 };
      entry.totals[field] = { sum: boundedAdd(total.sum, value), samples: boundedAdd(total.samples, 1) };
    }
    entry.recent.push(sample);
    if (entry.recent.length > recentLimit) entry.recent.shift();
  }

  snapshot() {
    return {
      scope: "Lifetime counters; percentiles cover at most the last 256 calls per operation, including failures. No content or hashes; resets on recreation.",
      operations: Object.fromEntries([...this.#entries].map(([operation, entry]) => [operation, {
        calls: entry.calls,
        outcomes: { ...entry.outcomes },
        measurements: Object.fromEntries(fields.map(field => {
          const values = entry.recent.flatMap(sample => sample[field] === undefined ? [] : [sample[field]!]).sort((a, b) => a - b);
          const percentile = (fraction: number) => values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
          return [field, { total: entry.totals[field]?.sum ?? 0, samples: entry.totals[field]?.samples ?? 0,
            recentSamples: values.length, p50: percentile(0.5), p95: percentile(0.95) }];
        })),
      }])),
    };
  }
}
