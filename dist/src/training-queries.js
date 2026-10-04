import { collectTraining } from "./training.js";
import { trainingHash } from "./training-input.js";
import { TRAINING_GATE_THRESHOLD } from "./training-gate.js";
import { resolveTypeSafeApiKey, TypeSafeRequestError } from "./typesafe-client.js";
import { trainingTeacher, trainingTeacherMessage, trainingTeacherPrompt, TRAINING_TEACHER_MODEL, TRAINING_TEACHER_VERSION } from "./training-models.js";
import { historicalTrainingSearch, historicalTrainingSource, HistoricalCorpusUnavailableError, TRAINING_RETRIEVAL_VERSION, TRAINING_SEARCH_OPTIONS } from "./training-retrieval.js";
import { contextJudgeRequest, judgeTrainingPassage, CONTEXT_JUDGE_VERSION } from "./training-judge.js";
const LANES = ["lex", "vec"];
const SELECTION_VERSION = "independent-lanes-top3-mean-v2";
const TARGET_POLICY = "best-per-lane-no-minimum-v1";
export const TRAINING_EVALUATION_CONCURRENCY = 4;
function bounds(options) {
    for (const value of [options.maxExamples, options.maxCalls, options.maxInputBytes, options.concurrency]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
            throw new Error("Training bounds must be positive integers");
    }
}
function teacherRequest(example, lane, feedback) {
    return { version: TRAINING_TEACHER_VERSION, model: TRAINING_TEACHER_MODEL, inputHash: example.inputHash,
        input: JSON.parse(example.inputJson), lane, round: feedback ? 2 : 1,
        ...(feedback ? { feedback: feedback.map(({ query, score }) => ({ query, score })) } : {}) };
}
const summary = () => ({ examples: 0, calls: 0, completed: 0, cached: 0, failed: 0, ambiguous: 0,
    blocked: 0, flagged: 0, inputBytes: 0, budgetLimited: false });
/** One fenced checkpoint per operation. Storage failures are fatal; provider failures are local. */
async function checkpoint(store, step, result, operation) {
    if (step.result !== undefined) {
        result.cached++;
        return step.result;
    }
    if (step.status !== "pending") {
        result.blocked++;
        return;
    }
    store.renew();
    const attempt = store.startStep(step.stage, step.id, step.request);
    result.calls++;
    let value;
    try {
        value = await operation();
    }
    catch (error) {
        // Historical retrieval is local code. Only an explicitly unavailable corpus
        // is a reviewable data case; do not swallow SQLite, I/O or snapshot-integrity errors.
        if (step.stage === "retrieve" && !(error instanceof HistoricalCorpusUnavailableError))
            throw error;
        const hostCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
            /^LLM_[A-Z_]+$/u.test(error.code) ? error.code : undefined;
        const status = error instanceof HistoricalCorpusUnavailableError || hostCode === "LLM_COMPLETION_NOT_AUTHORIZED" ||
            (error instanceof TypeSafeRequestError && error.code === "http_error" &&
                error.status !== undefined && error.status >= 400 && error.status < 500) ? "failed" : "ambiguous";
        store.finishStep(step.stage, step.id, attempt, { status,
            error: error instanceof TypeSafeRequestError && error.code === "http_error" ?
                `http_${error.status}` : error instanceof HistoricalCorpusUnavailableError ? "historical_corpus_unavailable" :
                hostCode ?? "request_or_response_uncertain" });
        result[status]++;
        return;
    }
    store.finishStep(step.stage, step.id, attempt, { result: value });
    result.completed++;
    return value;
}
function save(store, step, value) {
    const attempt = store.startStep(step.stage, step.id, step.request);
    store.finishStep(step.stage, step.id, attempt, { result: value });
    return value;
}
async function drain(tasks) {
    const settled = await Promise.allSettled(tasks);
    const failure = settled.find(item => item.status === "rejected");
    if (failure)
        throw failure.reason;
    return settled.flatMap(item => item.status === "fulfilled" ? [item.value] : []);
}
export async function generateTrainingQueries(source, store, runtime, options) {
    bounds(options);
    const refreshed = collectTraining(source, store, { existingOnly: true }), result = summary();
    const seen = new Set();
    let teacher;
    const examples = store.queryExamples(options.threshold);
    let next = 0, stopped = false;
    await drain(Array.from({ length: Math.min(options.concurrency ?? 8, examples.length) }, async () => {
        while (!stopped && !result.budgetLimited) {
            const example = examples[next++];
            if (!example)
                return;
            try {
                if (seen.has(example.inputHash))
                    continue;
                seen.add(example.inputHash);
                const steps = LANES.map(lane => ({ lane, step: store.step("generate", teacherRequest(example, lane)) }));
                if (steps.every(({ step }) => step.result)) {
                    result.cached += steps.length;
                    continue;
                }
                if (steps.every(({ step }) => step.result || step.status !== "pending")) {
                    const problems = steps.filter(({ step }) => !step.result).map(({ step }) => step.id);
                    result.blocked += problems.length;
                    result.flagged++;
                    store.flagReview(example, "generation-unresolved", { steps: problems });
                    continue;
                }
                if (options.maxExamples !== undefined && result.examples >= options.maxExamples)
                    return;
                result.examples++;
                const problems = [];
                for (const { lane, step } of steps) {
                    if (step.result) {
                        result.cached++;
                        continue;
                    }
                    if (step.status !== "pending") {
                        result.blocked++;
                        problems.push(step.id);
                        continue;
                    }
                    const input = JSON.parse(example.inputJson);
                    const bytes = Buffer.byteLength(trainingTeacherMessage(input, lane)) + Buffer.byteLength(trainingTeacherPrompt(lane));
                    if (result.inputBytes + bytes > options.maxInputBytes) {
                        result.budgetLimited = true;
                        break;
                    }
                    result.inputBytes += bytes;
                    if (options.dryRun)
                        continue;
                    teacher ??= trainingTeacher(runtime, source.agentId);
                    if (!await checkpoint(store, step, result, () => teacher(input, lane)))
                        problems.push(step.id);
                }
                if (problems.length) {
                    store.flagReview(example, "generation-unresolved", { steps: problems });
                    result.flagged++;
                }
            }
            catch (error) {
                stopped = true;
                throw error;
            }
        }
    }));
    return { refreshed, ...result, threshold: options.threshold ?? TRAINING_GATE_THRESHOLD, model: TRAINING_TEACHER_MODEL };
}
/** Raw top-three average, including values below runtime's injection threshold. */
export function trainingQueryScore(probabilities) {
    const top = probabilities.toSorted((a, b) => b - a).slice(0, 3);
    return top.length ? top.reduce((sum, value) => sum + value, 0) / top.length : 0;
}
export function selectTrainingQueries(queries) {
    const winner = (lane) => {
        const ranked = queries.filter(query => query.lane === lane).toSorted((a, b) => b.score - a.score);
        if (!ranked[0])
            throw new Error(`No resolved ${lane} candidates`);
        return ranked[0].query; // Stable ties preserve round and teacher order.
    };
    return { lex: winner("lex"), vec: winner("vec") };
}
export async function evaluateTrainingQueries(source, store, config, runtime, options, createSearch = historicalTrainingSearch) {
    bounds(options);
    const corpus = config.corpora.find(c => c.kind === "sessions");
    if (!corpus)
        throw new Error("Training retrieval requires a configured sessions corpus");
    const refreshed = collectTraining(source, store, { existingOnly: true });
    const result = { ...summary(), retrievals: 0, evaluated: 0, awaitingTeacher: 0 };
    const concurrency = options.concurrency ?? TRAINING_EVALUATION_CONCURRENCY;
    let historicalSource;
    let key, teacher;
    const apiKey = () => key ??= resolveTypeSafeApiKey(config.typesafe).then(value => {
        if (!value)
            throw new Error("TypeSafe is disabled or its credential is unavailable");
        return value;
    });
    let stopped = false;
    const shouldStop = () => stopped || result.budgetLimited;
    const room = () => {
        if (shouldStop())
            return false;
        if (options.maxCalls !== undefined && result.calls >= options.maxCalls) {
            result.budgetLimited = true;
            return false;
        }
        return true;
    };
    const judgments = new Map();
    const revisions = new Map();
    const reviews = new Map(store.reviews().map(review => [review.sourceId, review]));
    const evaluate = async (example) => {
        const previousReview = reviews.get(example.id);
        if (previousReview && "steps" in previousReview.details) {
            const blocked = previousReview.details.steps.filter(id => {
                const status = store.stepRecordStatus(id);
                return status !== undefined && status !== "pending" && status !== "complete";
            });
            // A known failed example cannot resolve before manual retry. Do not scan its
            // historical corpus or consume the example budget on every invocation.
            if (blocked.length) {
                result.blocked += blocked.length;
                result.flagged++;
                return;
            }
        }
        const initial = LANES.map(lane => ({ lane, step: store.step("generate", teacherRequest(example, lane)) }));
        if (initial.some(({ step }) => !step.result)) {
            const blocked = initial.filter(({ step }) => !step.result && step.status !== "pending");
            if (blocked.length) {
                result.blocked += blocked.length;
                result.flagged++;
                store.flagReview(example, "generation-unresolved", { steps: blocked.map(({ step }) => step.id) });
            }
            else
                result.awaitingTeacher++;
            return;
        }
        if (options.maxExamples !== undefined && result.examples >= options.maxExamples)
            return;
        store.renew();
        let snapshot;
        try {
            snapshot = createSearch === historicalTrainingSearch
                ? await (await (historicalSource ??= historicalTrainingSource(source.stateDir, corpus.chatTypes)))(example.timestamp)
                : await createSearch(source.stateDir, corpus.chatTypes, example.timestamp);
        }
        catch (error) {
            if (!(error instanceof HistoricalCorpusUnavailableError))
                throw error;
            store.flagReview(example, "historical-snapshot-unavailable", { timestamp: example.timestamp });
            result.flagged++;
            return;
        }
        try {
            const evaluation = store.step("evaluate", { version: SELECTION_VERSION, sourceId: example.id, inputHash: example.inputHash,
                timestamp: example.timestamp, teacherIds: initial.map(({ step }) => step.id), corpusHash: snapshot.corpusHash,
                retrievalVersion: TRAINING_RETRIEVAL_VERSION, judgeVersion: CONTEXT_JUDGE_VERSION,
                options: TRAINING_SEARCH_OPTIONS });
            if (evaluation.result) {
                result.cached++;
                store.clearReview(example.id);
                return;
            }
            if (evaluation.status !== "pending") {
                result.blocked++;
                result.flagged++;
                store.flagReview(example, "evaluation-unresolved", { steps: [evaluation.id] });
                return;
            }
            if (shouldStop() || (options.maxExamples !== undefined && result.examples >= options.maxExamples))
                return;
            result.examples++;
            if (options.dryRun)
                return;
            const input = JSON.parse(example.inputJson);
            const problems = new Set();
            const judge = (hit) => {
                const request = contextJudgeRequest(input, snapshot.maxDate, hit);
                const identity = trainingHash([CONTEXT_JUDGE_VERSION, request]);
                let pending = judgments.get(identity);
                if (!pending) {
                    pending = (async () => {
                        const step = store.step("judge", { identity, request });
                        if (step.result) {
                            result.cached++;
                            return { id: step.id, result: step.result };
                        }
                        if (step.status !== "pending") {
                            result.blocked++;
                            return { id: step.id, result: undefined };
                        }
                        const credential = await apiKey();
                        if (!room())
                            return { id: step.id, result: undefined };
                        return { id: step.id, result: await checkpoint(store, step, result, () => judgeTrainingPassage(request, credential)) };
                    })();
                    judgments.set(identity, pending);
                }
                return pending;
            };
            const scoreQueries = async (lane, round, generation, generationId) => await drain(generation.queries.map(async (query) => {
                try {
                    const score = store.step("score", { version: SELECTION_VERSION, lane, round, generationId, query,
                        sourceId: example.id, corpusHash: snapshot.corpusHash, judgeVersion: CONTEXT_JUDGE_VERSION,
                        retrievalVersion: TRAINING_RETRIEVAL_VERSION });
                    if (score.result) {
                        result.cached++;
                        return score.result;
                    }
                    if (score.status !== "pending") {
                        problems.add(score.id);
                        result.blocked++;
                        return;
                    }
                    const retrieval = store.step("retrieve", { version: TRAINING_RETRIEVAL_VERSION, query, lane,
                        sourceId: example.id, maxDate: snapshot.maxDate, corpusHash: snapshot.corpusHash, options: TRAINING_SEARCH_OPTIONS });
                    if (!retrieval.result && retrieval.status === "pending" && !room())
                        return;
                    const retrieved = await checkpoint(store, retrieval, result, async () => ({ query, lane, maxDate: snapshot.maxDate,
                        corpusHash: snapshot.corpusHash, hits: await snapshot.search(query, lane) }));
                    if (!retrieved) {
                        problems.add(retrieval.id);
                        return;
                    }
                    if (!retrieval.result)
                        result.retrievals++;
                    const scored = await drain(retrieved.hits.map(judge));
                    const missing = scored.filter(item => !item.result);
                    if (missing.length) {
                        for (const item of missing) {
                            const record = store.stepRecordStatus(item.id);
                            if (record && record !== "pending")
                                problems.add(item.id);
                        }
                        return;
                    }
                    const probabilities = scored.map(item => item.result.probability);
                    return save(store, score, { query, lane, round, retrievalId: retrieval.id,
                        score: trainingQueryScore(probabilities), maxProbability: Math.max(0, ...probabilities), judgments: scored.map(item => item.id) });
                }
                catch (error) {
                    stopped = true;
                    throw error;
                }
            }));
            const lanes = await drain(initial.map(async ({ lane, step }) => {
                try {
                    const first = await scoreQueries(lane, 1, step.result, step.id);
                    if (first.some(item => !item) || shouldStop())
                        return;
                    const feedback = first.map(item => ({ query: item.query, score: item.score }));
                    // The only feedback sent to Luna is this lane's exact earlier queries and scores.
                    const revision = store.step("generate", teacherRequest(example, lane, feedback));
                    let pending = revisions.get(revision.id);
                    if (!pending) {
                        pending = (async () => {
                            if (!revision.result && revision.status === "pending") {
                                const bytes = Buffer.byteLength(trainingTeacherMessage(input, lane, feedback)) + Buffer.byteLength(trainingTeacherPrompt(lane));
                                if (!room())
                                    return;
                                if (result.inputBytes + bytes > (options.maxInputBytes ?? 3_000_000)) {
                                    result.budgetLimited = true;
                                    return;
                                }
                                result.inputBytes += bytes;
                                teacher ??= trainingTeacher(runtime, source.agentId);
                            }
                            return checkpoint(store, revision, result, () => teacher(input, lane, feedback));
                        })();
                        revisions.set(revision.id, pending);
                    }
                    const revised = await pending;
                    if (!revised) {
                        if (store.stepRecordStatus(revision.id))
                            problems.add(revision.id);
                        return;
                    }
                    const second = await scoreQueries(lane, 2, revised, revision.id);
                    if (second.some(item => !item))
                        return;
                    return { teacherIds: [step.id, revision.id], queries: [...first, ...second].filter((item) => !!item) };
                }
                catch (error) {
                    stopped = true;
                    throw error;
                }
            }));
            if (problems.size) {
                result.flagged++;
                store.flagReview(example, "evaluation-unresolved", { steps: [...problems] });
                return;
            }
            if (lanes.some(lane => !lane))
                return; // Budget pause: completed operations remain reusable.
            const queries = lanes.flatMap(lane => lane.queries);
            const selected = selectTrainingQueries(queries);
            save(store, evaluation, { sourceId: example.id, inputHash: example.inputHash, timestamp: example.timestamp,
                corpusHash: snapshot.corpusHash, corpusReport: snapshot.report, teacherIds: lanes.flatMap(lane => lane.teacherIds), queries, selected, review: [] });
            store.clearReview(example.id);
            result.evaluated++;
        }
        finally {
            await snapshot.close();
        }
    };
    const examples = store.queryExamples(options.threshold);
    let next = 0;
    await drain(Array.from({ length: Math.min(concurrency, examples.length) }, async () => {
        while (!shouldStop() && (options.maxExamples === undefined || result.examples < options.maxExamples)) {
            const example = examples[next++];
            if (!example)
                return;
            try {
                await evaluate(example);
            }
            catch (error) {
                stopped = true;
                throw error;
            }
        }
    }));
    return { refreshed, ...result, concurrency, threshold: options.threshold ?? TRAINING_GATE_THRESHOLD,
        retrievalMethod: "independent-lex10-vec10", callUnit: "teacher completion, retrieval operation or uncached passage judgment" };
}
export function* exportQueryTraining(store, threshold = TRAINING_GATE_THRESHOLD) {
    const active = new Map(store.queryExamples(threshold).map(e => [e.id, e]));
    const unresolved = new Set(store.reviews().map(review => review.sourceId)), exported = new Set();
    for (const evaluation of store.completedEvaluations({ selection: SELECTION_VERSION, retrieval: TRAINING_RETRIEVAL_VERSION, judge: CONTEXT_JUDGE_VERSION })) {
        const source = active.get(evaluation.sourceId);
        if (!source || source.inputHash !== evaluation.inputHash || source.timestamp !== evaluation.timestamp || exported.has(source.id))
            continue;
        exported.add(source.id); // Never fall back to an older accepted corpus after a newer flagged result.
        if (unresolved.has(source.id))
            continue;
        if (!LANES.every(lane => evaluation.teacherIds.includes(store.step("generate", teacherRequest(source, lane)).id)))
            continue;
        // Selection is a local policy over completed scores, not another paid step.
        // This also recovers v2 checkpoints whose old usefulness policy saved null.
        const selected = selectTrainingQueries(evaluation.queries);
        const provenance = [...evaluation.teacherIds, ...evaluation.queries.flatMap(q => [q.retrievalId, ...q.judgments])];
        yield { stage: "query-training", input: JSON.parse(source.inputJson), inputHash: source.inputHash,
            recallProbability: source.recallProbability, threshold, target: selected, targetPolicy: TARGET_POLICY,
            source: store.sourceDetails(source.id), evaluation: { ...evaluation, selected, review: [] }, splitGroup: trainingHash(source.sessionId),
            provenance: [...new Set(provenance)].map(id => store.stepRecord(id)) };
    }
}
