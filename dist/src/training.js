import { TypeSafeRequestError, resolveTypeSafeApiKey } from "./typesafe-client.js";
import { TrainingTranscriptReader } from "./training-input.js";
import { judgeTrainingInput, TRAINING_GATE_QUESTIONS } from "./training-gate.js";
/** A full active-branch rescan is cheap/local; only changed exact inputs need inference. */
export function collectTraining(source, store, options = {}) {
    const since = options.since ?? 0, until = options.until ?? Number.MAX_SAFE_INTEGER;
    const reader = new TrainingTranscriptReader(source.databasePath, source.agentId);
    const result = { sessions: 0, excludedSessions: 0, oversizedSessions: 0, eligible: 0,
        users: 0, filtered: 0, oversized: 0, unanswered: 0, added: 0, changed: 0, unchanged: 0, retired: 0 };
    try {
        const sessions = new Set(options.existingOnly ? store?.sessions() : [...reader.sessions(), ...store?.sessions() ?? []]);
        for (const id of sessions) {
            store?.renew();
            const extracted = reader.read(id);
            result.sessions++;
            if (extracted && "oversized" in extracted) {
                result.oversizedSessions++;
                store?.unavailable(id);
                continue;
            }
            if (!extracted)
                result.excludedSessions++;
            else {
                for (const key of ["users", "filtered", "oversized", "unanswered"])
                    result[key] += extracted.coverage[key];
                result.eligible += extracted.examples.filter(e => e.timestamp >= since && e.timestamp < until).length;
            }
            const counts = store?.syncSession(id, extracted?.examples ?? [], since, until, options.existingOnly ?? false);
            if (counts)
                for (const key of ["added", "changed", "unchanged", "retired"])
                    result[key] += counts[key];
        }
        return result;
    }
    finally {
        reader.close();
    }
}
/** Parallel, bounded paid work. Negative results are just as cacheable as positives. */
export async function runTraining(source, store, config, options) {
    if ((options.maxExamples !== undefined && (!Number.isSafeInteger(options.maxExamples) || options.maxExamples < 1)) ||
        !Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes < 1)
        throw new Error("Invalid training run bounds");
    const refreshed = collectTraining(source, store, { existingOnly: true });
    const concurrency = options.concurrency ?? 256;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
        throw new Error("Invalid training concurrency");
    const jobs = store.pending(options.maxExamples);
    const result = { refreshed, pendingSelected: jobs.length, calls: 0, completed: 0, failed: 0, ambiguous: 0,
        inputBytes: 0, inputTokens: 0, outputTokens: 0, budgetLimited: false };
    // Resolve only when there is work. Reruns with no pending inputs need no credentials.
    const key = jobs.length && !options.dryRun ? await resolveTypeSafeApiKey(config.typesafe) : undefined;
    if (jobs.length && !options.dryRun && !key)
        throw new Error("TypeSafe is disabled or its credential is unavailable");
    let next = 0, stopped = false;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
        while (!stopped && !result.budgetLimited && !result.failed && !result.ambiguous) {
            const job = jobs[next++];
            if (!job)
                return;
            try {
                const input = JSON.parse(job.inputJson);
                const bytes = Buffer.byteLength(JSON.stringify({ state: input, questions: TRAINING_GATE_QUESTIONS }));
                if (result.inputBytes + bytes > options.maxInputBytes) {
                    result.budgetLimited = true;
                    return;
                }
                result.inputBytes += bytes;
                if (options.dryRun)
                    continue;
                store.renew();
                const attempt = store.start(job.id); // Commit BEFORE the request can leave this process.
                result.calls++;
                let judgment;
                try {
                    // Offline labeling has its own deadline, not Whisperer's latency-sensitive timeout.
                    judgment = await judgeTrainingInput(input, key, AbortSignal.timeout(30_000));
                }
                catch (error) {
                    const definite = error instanceof TypeSafeRequestError && error.code === "http_error" &&
                        error.status !== undefined && error.status >= 400 && error.status < 500;
                    const status = definite ? "failed" : "ambiguous";
                    store.finish(job.id, attempt, { status, error: error instanceof TypeSafeRequestError && error.code === "http_error" ?
                            `http_${error.status}` : "request_or_response_uncertain" });
                    result[status]++;
                    // Stop on the first failure rather than spending the rest of the budget during an outage.
                    return;
                }
                // Storage failures must not be misclassified as provider failures/retried.
                store.finish(job.id, attempt, judgment);
                result.completed++;
                result.inputTokens += judgment.usage.input_tokens;
                result.outputTokens += judgment.usage.output_tokens;
            }
            catch (error) {
                stopped = true;
                throw error;
            }
        }
    }));
    const failure = workers.find(item => item.status === "rejected");
    if (failure)
        throw failure.reason;
    return result;
}
