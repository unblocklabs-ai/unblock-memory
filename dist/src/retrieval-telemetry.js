import { timingFields } from "./retrieval-timing.js";
const fields = ["elapsedMs", "retrievalMs", "judgeMs", "gateMs", "generationMs", ...timingFields,
    "metadataReloads", "vectorScanAttempts", "candidates", "eligible", "results", "contextChars",
    "requestsSucceeded", "requestsFailed", "fallbackKeyUnavailable", "fallbackAllJudgmentsFailed"];
const recentLimit = 256;
const outcomes = ["ok", "partial", "empty", "failed", "cancelled", "timed_out", "skipped", "degraded"];
const boundedAdd = (left, right) => Math.min(Number.MAX_SAFE_INTEGER, left + right);
/** Only fixed operation/outcome names and nonnegative numbers enter this store. */
export class RetrievalTelemetry {
    #entries = new Map();
    record(operation, observation) {
        if (!["vector", "memoryWhisperer", "memorySearch"].includes(operation) || !outcomes.includes(observation.outcome))
            return;
        const entry = this.#entries.get(operation) ?? { calls: 0, outcomes: {}, totals: {}, recent: [] };
        this.#entries.set(operation, entry);
        entry.calls = boundedAdd(entry.calls, 1);
        entry.outcomes[observation.outcome] = boundedAdd(entry.outcomes[observation.outcome] ?? 0, 1);
        const sample = { outcome: observation.outcome };
        for (const field of fields) {
            const value = observation[field];
            if (value === undefined || !Number.isFinite(value) || value < 0)
                continue;
            sample[field] = value;
            const total = entry.totals[field] ?? { sum: 0, samples: 0 };
            entry.totals[field] = { sum: boundedAdd(total.sum, value), samples: boundedAdd(total.samples, 1) };
        }
        entry.recent.push(sample);
        if (entry.recent.length > recentLimit)
            entry.recent.shift();
    }
    snapshot() {
        return {
            scope: "Lifetime counters; percentiles cover at most the last 256 calls per operation, including failures. No content or hashes; resets on recreation.",
            operations: Object.fromEntries([...this.#entries].map(([operation, entry]) => [operation, {
                    calls: entry.calls,
                    outcomes: { ...entry.outcomes },
                    slowestRecent: entry.recent.filter(sample => sample.elapsedMs !== undefined)
                        .toSorted((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 5).map(sample => ({ ...sample })),
                    measurements: Object.fromEntries(fields.map(field => {
                        const values = entry.recent.flatMap(sample => sample[field] === undefined ? [] : [sample[field]]).sort((a, b) => a - b);
                        const percentile = (fraction) => values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
                        return [field, { total: entry.totals[field]?.sum ?? 0, samples: entry.totals[field]?.samples ?? 0,
                                recentSamples: values.length, p50: percentile(0.5), p95: percentile(0.95) }];
                    })),
                }])),
        };
    }
}
