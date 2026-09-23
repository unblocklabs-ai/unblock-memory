import type { UnblockMemoryConfig } from "./config.js";
import { collectTraining } from "./training.js";
import type { TrainingInput } from "./training-input.js";
import { trainingHash } from "./training-input.js";
import { TRAINING_GATE_THRESHOLD } from "./training-gate.js";
import { resolveTypeSafeApiKey } from "./typesafe.js";
import { trainingTeacher, trainingTeacherMessage, TRAINING_TEACHER_MODEL, TRAINING_TEACHER_PROMPT, TRAINING_TEACHER_VERSION } from "./training-models.js";
import { historicalTrainingSearch, TRAINING_RETRIEVAL_VERSION, TRAINING_SEARCH_OPTIONS } from "./training-retrieval.js";
import type { QueryEvaluation, TrainingStore, TrainingStepResults, TrainingSourceExample } from "./training-store.js";
import { contextJudgeRequest, judgeTrainingPassage, CONTEXT_JUDGE_VERSION } from "./training-judge.js";
import { TypeSafeHttpError } from "./typesafe-transport.js";

type Source = { databasePath: string; agentId: string; stateDir: string };
type Options = { maxExamples?: number; dryRun?: boolean; threshold?: number };
const SELECTION_VERSION = "conversation-utility-top5-sum-v2";
export const TRAINING_EVALUATION_CONCURRENCY = 4;

function bounds(options: Options & { maxCalls?: number; maxInputBytes?: number; concurrency?: number }) {
  for (const value of [options.maxExamples, options.maxCalls, options.maxInputBytes, options.concurrency]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("Training bounds must be positive integers");
  }
}
function teacherRequest(example: TrainingSourceExample) {
  return { version: TRAINING_TEACHER_VERSION, model: TRAINING_TEACHER_MODEL, inputHash: example.inputHash,
    input: JSON.parse(example.inputJson) as TrainingInput };
}
const summary = () => ({ examples: 0, calls: 0, completed: 0, cached: 0, failed: 0, ambiguous: 0,
  blocked: 0, inputBytes: 0, budgetLimited: false });
type Summary = ReturnType<typeof summary>;

/** One fenced checkpoint per paid operation, with no hidden transport retries. */
async function checkpoint<S extends keyof TrainingStepResults>(store: TrainingStore,
  step: ReturnType<TrainingStore["step"]> & { stage: S }, result: Summary, operation: () => Promise<TrainingStepResults[S]>) {
  if (step.result !== undefined) { result.cached++; return step.result as TrainingStepResults[S]; }
  if (step.status !== "pending") { result.blocked++; return; }
  store.renew();
  const attempt = store.startStep(step.stage, step.id, step.request);
  result.calls++;
  let value: TrainingStepResults[S];
  try { value = await operation(); }
  catch (error) {
    const hostCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
      /^LLM_[A-Z_]+$/u.test(error.code) ? error.code : undefined;
    const status = hostCode === "LLM_COMPLETION_NOT_AUTHORIZED" ||
      (error instanceof TypeSafeHttpError && error.status >= 400 && error.status < 500) ? "failed" : "ambiguous";
    store.finishStep(step.stage, step.id, attempt, { status,
      error: error instanceof TypeSafeHttpError ? `http_${error.status}` : hostCode ?? "request_or_response_uncertain" });
    result[status]++;
    return;
  }
  store.finishStep(step.stage, step.id, attempt, { result: value });
  result.completed++;
  return value;
}

export async function generateTrainingQueries(source: Source, store: TrainingStore, runtime: unknown, options: Options & { maxInputBytes: number; concurrency?: number }) {
  bounds(options);
  const refreshed = collectTraining(source, store, { existingOnly: true }), result = summary();
  const seen = new Set<string>();
  let teacher: ReturnType<typeof trainingTeacher> | undefined;
  const examples = store.queryExamples(options.threshold);
  let next = 0, stopped = false;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(options.concurrency ?? 8, examples.length) }, async () => {
    while (!stopped && !result.budgetLimited && !result.failed && !result.ambiguous) {
      const example = examples[next++];
      if (!example) return;
      try {
        if (seen.has(example.inputHash)) continue;
        seen.add(example.inputHash);
        const request = teacherRequest(example), step = store.step("generate", request);
        if (step.result) { result.cached++; continue; }
        if (step.status !== "pending") { result.blocked++; continue; }
        if (options.maxExamples !== undefined && result.examples >= options.maxExamples) return;
        const bytes = Buffer.byteLength(trainingTeacherMessage(request.input)) + Buffer.byteLength(TRAINING_TEACHER_PROMPT);
        if (result.inputBytes + bytes > options.maxInputBytes) { result.budgetLimited = true; return; }
        result.examples++; result.inputBytes += bytes;
        if (options.dryRun) continue;
        teacher ??= trainingTeacher(runtime, source.agentId); // Capability check BEFORE committing a paid attempt.
        if (!await checkpoint(store, step, result, () => teacher!(request.input))) return;
      } catch (error) { stopped = true; throw error; }
    }
  }));
  const failure = workers.find(item => item.status === "rejected");
  if (failure) throw failure.reason;
  return { refreshed, ...result, threshold: options.threshold ?? TRAINING_GATE_THRESHOLD, model: TRAINING_TEACHER_MODEL };
}

export function selectTrainingQueries(queries: QueryEvaluation[]) {
  // Stable ties preserve teacher order; neither low scores nor overlapping hits reject a query.
  return queries.toSorted((a, b) => b.score - a.score).slice(0, 3).map(q => q.query);
}

export async function evaluateTrainingQueries(source: Source, store: TrainingStore, config: UnblockMemoryConfig, options: Options & { maxCalls?: number; concurrency?: number; excludeJudgments?: string[] },
  createSearch = historicalTrainingSearch) {
  bounds(options);
  if (options.excludeJudgments?.some(id => !/^[a-f0-9]{64}$/u.test(id))) throw new Error("Invalid excluded judgment hash");
  const corpus = config.corpora.find(c => c.kind === "sessions");
  if (!corpus) throw new Error("Training retrieval requires a configured sessions corpus");
  const refreshed = collectTraining(source, store, { existingOnly: true });
  const result = { ...summary(), retrievals: 0, evaluated: 0, awaitingTeacher: 0 };
  const concurrency = options.concurrency ?? TRAINING_EVALUATION_CONCURRENCY;
  let key: Promise<string> | undefined;
  const apiKey = () => key ??= resolveTypeSafeApiKey(config.typesafe).then(value => {
    if (!value) throw new Error("TypeSafe is disabled or its credential is unavailable");
    return value;
  });
  let stopped = false;
  const shouldStop = () => stopped || result.budgetLimited || result.failed > 0 || result.ambiguous > 0 || result.blocked > 0;
  const judgments = new Map<string, Promise<{ id: string; result: TrainingStepResults["judge"] | undefined }>>();
  const evaluate = async (example: TrainingSourceExample) => {
    const teacher = store.step("generate", teacherRequest(example));
    if (!teacher.result) { result.awaitingTeacher++; return; }
    if (options.maxExamples !== undefined && result.examples >= options.maxExamples) return;
    store.renew();
    const snapshot = await createSearch(source.stateDir, corpus.chatTypes, example.timestamp);
    try {
      const evaluation = store.step("evaluate", { version: SELECTION_VERSION, sourceId: example.id, inputHash: example.inputHash,
        timestamp: example.timestamp, teacherId: teacher.id, corpusHash: snapshot.corpusHash,
        retrievalVersion: TRAINING_RETRIEVAL_VERSION, judgeVersion: CONTEXT_JUDGE_VERSION,
        exclusions: options.excludeJudgments?.toSorted() ?? [], options: TRAINING_SEARCH_OPTIONS });
      if (evaluation.result) { result.cached++; return; }
      if (evaluation.status !== "pending") { result.blocked++; return; }
      // Snapshot creation is async: reserve the shared example budget only after it settles.
      if (shouldStop() || (options.maxExamples !== undefined && result.examples >= options.maxExamples)) return;
      result.examples++;
      if (options.dryRun) return;
      const input = JSON.parse(example.inputJson) as TrainingInput;
      const judge = (hit: TrainingStepResults["retrieve"]["hits"][number]) => {
        const request = contextJudgeRequest(input, snapshot.maxDate, hit);
        // Same identity as the experiment: duplicate query memberships share one judgment.
        const identity = trainingHash([CONTEXT_JUDGE_VERSION, example.inputHash, hit.position, request]);
        let pending = judgments.get(identity);
        if (!pending) {
          pending = (async () => {
            const excluded = options.excludeJudgments?.includes(identity) || store.judgmentExcluded(identity);
            const step = store.step("judge", { identity, request, excluded });
            if (step.result) { result.cached++; return { id: step.id, result: step.result }; }
            if (excluded) {
              const attempt = store.startStep("judge", step.id, step.request);
              const value = { excluded: true, reason: "operator-exclusion" } as const;
              store.finishStep("judge", step.id, attempt, { result: value });
              return { id: step.id, result: value };
            }
            const credential = await apiKey();
            if (shouldStop()) return { id: step.id, result: undefined };
            if (options.maxCalls !== undefined && result.calls >= options.maxCalls) {
              result.budgetLimited = true; return { id: step.id, result: undefined };
            }
            return { id: step.id, result: await checkpoint(store, step, result, () => judgeTrainingPassage(request, credential)) };
          })();
          judgments.set(identity, pending);
        }
        return pending;
      };
      // Keep teacher order, and drain every in-flight operation before closing its snapshot.
      const settled = await Promise.allSettled(teacher.result.queries.map(async (query) => {
        try {
          if (shouldStop()) return;
          const retrieval = store.step("retrieve", { version: TRAINING_RETRIEVAL_VERSION, query,
            sourceId: example.id, maxDate: snapshot.maxDate, corpusHash: snapshot.corpusHash, options: TRAINING_SEARCH_OPTIONS });
          if (shouldStop()) return;
          // No await between this check and checkpoint's synchronous reservation of result.calls.
          if (!retrieval.result && options.maxCalls !== undefined && result.calls >= options.maxCalls) {
            result.budgetLimited = true; return;
          }
          const retrieved = await checkpoint(store, retrieval, result, async () => ({ query, maxDate: snapshot.maxDate,
            corpusHash: snapshot.corpusHash, hits: await snapshot.search(query) }));
          if (!retrieved) return;
          if (!retrieval.result) result.retrievals++;
          const settledHits = await Promise.allSettled(retrieved.hits.map(judge));
          const failure = settledHits.find(item => item.status === "rejected");
          if (failure) throw failure.reason;
          const scored = settledHits.flatMap(item => item.status === "fulfilled" ? [item.value] : []);
          if (scored.some(item => !item.result)) return;
          const scores = scored.flatMap(item => item.result && "score" in item.result ? [item.result.score] : []);
          return { query, retrievalId: retrieval.id, score: scores.sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0),
            judgments: scored.map(item => ({ id: item.id, excluded: !!item.result && "excluded" in item.result })) };
        } catch (error) { stopped = true; throw error; }
      }));
      const failure = settled.find(item => item.status === "rejected");
      if (failure) throw failure.reason;
      const queries = settled.flatMap(item => item.status === "fulfilled" && item.value ? [item.value] : []);
      if (queries.length !== 10) return; // Resume only unfinished queries; never repeat completed calls.
      const selected = selectTrainingQueries(queries);
      const attempt = store.startStep("evaluate", evaluation.id, evaluation.request);
      store.finishStep("evaluate", evaluation.id, attempt, { result: { sourceId: example.id, inputHash: example.inputHash,
        timestamp: example.timestamp, corpusHash: snapshot.corpusHash, corpusReport: snapshot.report, teacherId: teacher.id, queries, selected } });
      result.evaluated++;
    } finally { await snapshot.close(); }
  };
  const examples = store.queryExamples(options.threshold);
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, examples.length) }, async () => {
    while (!shouldStop() && (options.maxExamples === undefined || result.examples < options.maxExamples)) {
      const example = examples[next++];
      if (!example) return;
      try { await evaluate(example); }
      catch (error) { stopped = true; throw error; }
    }
  }));
  const failure = workers.find(item => item.status === "rejected");
  if (failure) throw failure.reason; // All workers/snapshots have drained, including on storage failures.
  return { refreshed, ...result, concurrency, threshold: options.threshold ?? TRAINING_GATE_THRESHOLD,
    retrievalMethod: "vector10-bm25-10", callUnit: "retrieval operation or uncached passage judgment" };
}

export function* exportQueryTraining(store: TrainingStore, threshold = TRAINING_GATE_THRESHOLD) {
  const active = new Map(store.queryExamples(threshold).map(e => [e.id, e]));
  const exported = new Set<string>();
  for (const evaluation of store.completedEvaluations({ selection: SELECTION_VERSION, retrieval: TRAINING_RETRIEVAL_VERSION })) {
    const source = active.get(evaluation.sourceId);
    if (!source || source.inputHash !== evaluation.inputHash || source.timestamp !== evaluation.timestamp || exported.has(source.id)) continue;
    if (store.step("generate", teacherRequest(source)).id !== evaluation.teacherId) continue;
    exported.add(source.id); // Only the newest corpus evaluation per source.
    const provenance = [evaluation.teacherId, ...evaluation.queries.flatMap(q => [q.retrievalId, ...q.judgments?.map(j => j.id) ?? []])];
    yield { stage: "query-training", input: JSON.parse(source.inputJson) as TrainingInput, inputHash: source.inputHash,
      recallProbability: source.recallProbability, threshold,
      target: evaluation.selected, source: store.sourceDetails(source.id), evaluation,
      splitGroup: trainingHash(source.sessionId), // Also keep identical inputHash groups together across sessions/nodes.
      provenance: [...new Set(provenance)].map(id => store.stepRecord(id)) };
  }
}
