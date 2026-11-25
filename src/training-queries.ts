import type { ChatType, UnblockMemoryConfig } from "./config.js";
import type { QueryLane, QueryPair } from "./query-contract.js";
import { collectTraining } from "./training.js";
import type { TrainingInput } from "./training-input.js";
import { TRAINING_GATE_THRESHOLD } from "./training-gate.js";
import { classifyDecisionFailure, resolveDecisionCredential } from "./decision-client.js";
import { trainingTeacher, trainingTeacherMessage, trainingTeacherPrompt, TRAINING_TEACHER_MODEL,
  TRAINING_TEACHER_VERSION, type QueryFeedback, type TrainingRound } from "./training-models.js";
import { historicalTrainingSearch, historicalTrainingSource, HistoricalCorpusUnavailableError, TRAINING_RETRIEVAL_VERSION, TRAINING_SEARCH_OPTIONS,
  type HistoricalTrainingSnapshot } from "./training-retrieval.js";
import type { QueryEvaluation, TrainingStore, TrainingStepResults, TrainingSourceExample } from "./training-store.js";
import { contextJudgeRequest, judgeTrainingPassage, CONTEXT_JUDGE_VERSION } from "./training-judge.js";
import { memoryJudgeVersion } from "./decision-ranking.js";
import { jsonHash } from "./json-hash.js";

type Source = { databasePath: string; agentId: string; stateDir: string };
type Options = { maxExamples?: number; dryRun?: boolean; threshold?: number };
const LANES = ["lex", "vec"] as const;
const SELECTION_VERSION = "independent-lanes-top3-mean-v2";
const TARGET_POLICY = "best-per-lane-no-minimum-v1";
export const TRAINING_EVALUATION_CONCURRENCY = 4;

function bounds(options: Options & { maxCalls?: number; maxInputBytes?: number; concurrency?: number }) {
  for (const value of [options.maxExamples, options.maxCalls, options.maxInputBytes, options.concurrency]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("Training bounds must be positive integers");
  }
}
function teacherRequest(example: TrainingSourceExample, lane: QueryLane, feedback?: readonly QueryFeedback[]) {
  return { version: TRAINING_TEACHER_VERSION, model: TRAINING_TEACHER_MODEL, inputHash: example.inputHash,
    input: JSON.parse(example.inputJson) as TrainingInput, lane, round: feedback ? 2 : 1,
    ...(feedback ? { feedback: feedback.map(({ query, score }) => ({ query, score })) } : {}) };
}
const summary = () => ({ examples: 0, calls: 0, completed: 0, cached: 0, failed: 0, ambiguous: 0,
  blocked: 0, flagged: 0, inputBytes: 0, budgetLimited: false });
type Summary = ReturnType<typeof summary>;

/** One fenced checkpoint per operation. Storage failures are fatal; provider failures are local. */
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
    // Historical retrieval is local code. Only an explicitly unavailable corpus
    // is a reviewable data case; do not swallow SQLite, I/O or snapshot-integrity errors.
    if (step.stage === "retrieve" && !(error instanceof HistoricalCorpusUnavailableError)) throw error;
    const hostCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
      /^LLM_[A-Z_]+$/u.test(error.code) ? error.code : undefined;
    const classified = classifyDecisionFailure(error);
    const status = error instanceof HistoricalCorpusUnavailableError || hostCode === "LLM_COMPLETION_NOT_AUTHORIZED"
      ? "failed"
      : classified.status;
    store.finishStep(step.stage, step.id, attempt, {
      status,
      error: error instanceof HistoricalCorpusUnavailableError
        ? "historical_corpus_unavailable"
        : hostCode ?? classified.error,
    });
    result[status]++;
    return;
  }
  store.finishStep(step.stage, step.id, attempt, { result: value });
  result.completed++;
  return value;
}

function save<S extends "score" | "evaluate">(
  store: TrainingStore,
  step: ReturnType<TrainingStore["step"]> & { stage: S },
  value: TrainingStepResults[S],
  clearReview?: Parameters<TrainingStore["saveStep"]>[4],
) {
  store.saveStep(step.stage, step.id, step.request, value, clearReview);
  return value;
}

async function drain<T>(tasks: Promise<T>[]) {
  const settled = await Promise.allSettled(tasks);
  const failure = settled.find(item => item.status === "rejected");
  if (failure) throw failure.reason;
  return settled.flatMap(item => item.status === "fulfilled" ? [item.value] : []);
}

export async function generateTrainingQueries(source: Source, store: TrainingStore, runtime: unknown,
  options: Options & { maxInputBytes: number; concurrency?: number }) {
  bounds(options);
  const refreshed = collectTraining(source, store, { existingOnly: true }), result = summary();
  const seen = new Set<string>();
  let teacher: ReturnType<typeof trainingTeacher> | undefined;
  const examples = store.queryExamples(options.threshold);
  let next = 0, stopped = false;
  await drain(Array.from({ length: Math.min(options.concurrency ?? 8, examples.length) }, async () => {
    while (!stopped && !result.budgetLimited) {
      const example = examples[next++];
      if (!example) return;
      try {
        if (seen.has(example.inputHash)) continue;
        seen.add(example.inputHash);
        const steps = LANES.map(lane => ({ lane, step: store.step("generate", teacherRequest(example, lane)) }));
        if (steps.every(({ step }) => step.result)) { result.cached += steps.length; continue; }
        if (steps.every(({ step }) => step.result || step.status !== "pending")) {
          const problems = steps.filter(({ step }) => !step.result).map(({ step }) => step.id);
          result.blocked += problems.length; result.flagged++;
          store.flagReview(example, "generation-unresolved", { steps: problems });
          continue;
        }
        if (options.maxExamples !== undefined && result.examples >= options.maxExamples) return;
        result.examples++;
        const problems: string[] = [];
        for (const { lane, step } of steps) {
          if (step.result) { result.cached++; continue; }
          if (step.status !== "pending") { result.blocked++; problems.push(step.id); continue; }
          const input = JSON.parse(example.inputJson) as TrainingInput;
          const bytes = Buffer.byteLength(trainingTeacherMessage(input, lane)) + Buffer.byteLength(trainingTeacherPrompt(lane));
          if (result.inputBytes + bytes > options.maxInputBytes) { result.budgetLimited = true; break; }
          result.inputBytes += bytes;
          if (options.dryRun) continue;
          teacher ??= trainingTeacher(runtime, source.agentId);
          if (!await checkpoint(store, step, result, () => teacher!(input, lane))) problems.push(step.id);
        }
        if (problems.length) { store.flagReview(example, "generation-unresolved", { steps: problems }); result.flagged++; }
      } catch (error) { stopped = true; throw error; }
    }
  }));
  return { refreshed, ...result, threshold: options.threshold ?? TRAINING_GATE_THRESHOLD, model: TRAINING_TEACHER_MODEL };
}

/** Raw top-three average, including values below runtime's injection threshold. */
export function trainingQueryScore(probabilities: readonly number[]) {
  const top = probabilities.toSorted((a, b) => b - a).slice(0, 3);
  return top.length ? top.reduce((sum, value) => sum + value, 0) / top.length : 0;
}

export function selectTrainingQueries(queries: readonly QueryEvaluation[]): QueryPair {
  const winner = (lane: QueryLane) => {
    const ranked = queries.filter(query => query.lane === lane).toSorted((a, b) => b.score - a.score);
    if (!ranked[0]) throw new Error(`No resolved ${lane} candidates`);
    return ranked[0].query; // Stable ties preserve round and teacher order.
  };
  return { lex: winner("lex"), vec: winner("vec") };
}

function stepBelongsToJudge(info: ReturnType<TrainingStore["stepScope"]>, judgeVersion: string): boolean {
  if (!info) return false;
  if (info.stage === "evaluate" || info.stage === "score") return info.request.judgeVersion === judgeVersion;
  if (info.stage === "judge") {
    return typeof info.request.identity === "string" &&
      jsonHash([judgeVersion, info.request.request]) === info.request.identity;
  }
  return true;
}

type EvaluationResult = Summary & { retrievals: number; evaluated: number; awaitingTeacher: number };
type EvaluationContext = {
  source: Source;
  store: TrainingStore;
  config: UnblockMemoryConfig;
  runtime: unknown;
  options: Options & { maxCalls?: number; maxInputBytes?: number; concurrency?: number };
  chatTypes: readonly ChatType[];
  judgeVersion: string;
  evaluationOptions: { endpoint: string; model: string };
  result: EvaluationResult;
  reviewsBySource: ReadonlyMap<string, ReturnType<TrainingStore["reviews"]>>;
  judgments: Map<string, Promise<{ id: string; result: TrainingStepResults["judge"] | undefined }>>;
  revisions: Map<string, Promise<TrainingStepResults["generate"] | undefined>>;
  createSearch?: typeof historicalTrainingSearch;
  historicalSource?: ReturnType<typeof historicalTrainingSource>;
  key?: Promise<string>;
  teacher?: ReturnType<typeof trainingTeacher>;
  stopped: boolean;
};

function isCorpusScopedRetrievalStep(info: ReturnType<TrainingStore["stepScope"]>):
  info is NonNullable<ReturnType<TrainingStore["stepScope"]>> & { request: { corpusHash: string } } {
  return !!info && info.stage === "retrieve" && typeof info.request.corpusHash === "string";
}

/** Admission holds: defer corpus-scoped retrieval failures until the current corpusHash is known. */
function blockedStepsForExample(
  store: TrainingStore,
  reviews: readonly ReturnType<TrainingStore["reviews"]>[number][],
  judgeVersion: string,
  corpusHash?: string,
): string[] {
  return reviews.flatMap(review => {
    if (!("steps" in review.details)) return [];
    if (review.reason === "evaluation-unresolved") {
      if (review.scope && review.scope !== "__legacy__" && review.scope !== judgeVersion) return [];
      return review.details.steps.filter(id => {
        const info = store.stepScope(id);
        if (!info || info.status === "pending" || info.status === "complete" || !stepBelongsToJudge(info, judgeVersion)) return false;
        if (corpusHash === undefined) return !isCorpusScopedRetrievalStep(info);
        return isCorpusScopedRetrievalStep(info) && info.request.corpusHash === corpusHash;
      });
    }
    if (corpusHash !== undefined) return [];
    return review.details.steps.filter(id => {
      const status = store.stepRecordStatus(id);
      return status !== undefined && status !== "pending" && status !== "complete";
    });
  });
}

/** Export holds: any uncleared review row for this judge blocks exporting prior evaluations. */
function reviewBlocksJudge(store: TrainingStore, review: ReturnType<TrainingStore["reviews"]>[number], judgeVersion: string): boolean {
  if (review.reason !== "evaluation-unresolved") return true;
  if (review.scope && review.scope !== "__legacy__") return review.scope === judgeVersion;
  if (!("steps" in review.details)) return true;
  return review.details.steps.some(id => stepBelongsToJudge(store.stepScope(id), judgeVersion));
}

function legacyUnresolvedMatchesJudge(store: TrainingStore, judgeVersion: string) {
  return (details: { steps: string[] } | { lanes: string[]; evaluationId: string } | { timestamp: number }) =>
    "steps" in details && details.steps.length > 0 && details.steps.every(id => stepBelongsToJudge(store.stepScope(id), judgeVersion));
}

function shouldStop(ctx: EvaluationContext) {
  return ctx.stopped || ctx.result.budgetLimited;
}

function hasCallRoom(ctx: EvaluationContext) {
  if (shouldStop(ctx)) return false;
  if (ctx.options.maxCalls !== undefined && ctx.result.calls >= ctx.options.maxCalls) {
    ctx.result.budgetLimited = true;
    return false;
  }
  return true;
}

function resolveApiKey(ctx: EvaluationContext) {
  return ctx.key ??= resolveDecisionCredential(ctx.config.decisionModel).then(value => {
    if (!value) throw new Error("Decision model is disabled or its credential is unavailable");
    return value;
  });
}

function resolveTeacher(ctx: EvaluationContext) {
  return ctx.teacher ??= trainingTeacher(ctx.runtime, ctx.source.agentId);
}

async function openSnapshot(ctx: EvaluationContext, timestamp: number): Promise<HistoricalTrainingSnapshot> {
  // By default one source capture serves the whole run; an injected search owns its own capture.
  if (ctx.createSearch) return ctx.createSearch(ctx.source.stateDir, ctx.chatTypes, timestamp);
  const sourceForCutoff = await (ctx.historicalSource ??= historicalTrainingSource(ctx.source.stateDir, ctx.chatTypes));
  return sourceForCutoff(timestamp);
}

function judgePassageOnce(
  ctx: EvaluationContext,
  input: TrainingInput,
  maxDate: string,
  hit: TrainingStepResults["retrieve"]["hits"][number],
) {
  const request = contextJudgeRequest(input, maxDate, hit, ctx.config.decisionModel.model);
  const identity = jsonHash([ctx.judgeVersion, request]);
  let pending = ctx.judgments.get(identity);
  if (!pending) {
    pending = (async () => {
      const step = ctx.store.step("judge", { identity, request });
      if (step.result) { ctx.result.cached++; return { id: step.id, result: step.result }; }
      if (step.status !== "pending") { ctx.result.blocked++; return { id: step.id, result: undefined }; }
      const credential = await resolveApiKey(ctx);
      if (!hasCallRoom(ctx)) return { id: step.id, result: undefined };
      return { id: step.id, result: await checkpoint(ctx.store, step, ctx.result, () => judgeTrainingPassage(request, credential, ctx.evaluationOptions)) };
    })();
    ctx.judgments.set(identity, pending);
  }
  return pending;
}

async function scoreLaneQueries(
  ctx: EvaluationContext,
  example: TrainingSourceExample,
  input: TrainingInput,
  snapshot: HistoricalTrainingSnapshot,
  lane: QueryLane,
  round: TrainingRound,
  generation: TrainingStepResults["generate"],
  generationId: string,
  problems: Set<string>,
) {
  return drain(generation.queries.map(async query => {
    try {
      const score = ctx.store.step("score", { version: SELECTION_VERSION, lane, round, generationId, query,
        sourceId: example.id, corpusHash: snapshot.corpusHash, judgeVersion: ctx.judgeVersion,
        retrievalVersion: TRAINING_RETRIEVAL_VERSION });
      if (score.result) { ctx.result.cached++; return score.result; }
      if (score.status !== "pending") { problems.add(score.id); ctx.result.blocked++; return; }
      const retrieval = ctx.store.step("retrieve", { version: TRAINING_RETRIEVAL_VERSION, query, lane,
        sourceId: example.id, maxDate: snapshot.maxDate, corpusHash: snapshot.corpusHash, options: TRAINING_SEARCH_OPTIONS });
      if (!retrieval.result && retrieval.status === "pending" && !hasCallRoom(ctx)) return;
      const retrieved = await checkpoint(ctx.store, retrieval, ctx.result, async () => ({ query, lane, maxDate: snapshot.maxDate,
        corpusHash: snapshot.corpusHash, hits: await snapshot.search(query, lane) }));
      if (!retrieved) { problems.add(retrieval.id); return; }
      if (!retrieval.result) ctx.result.retrievals++;
      const scored = await drain(retrieved.hits.map(hit => judgePassageOnce(ctx, input, snapshot.maxDate, hit)));
      const missing = scored.filter(item => !item.result);
      if (missing.length) {
        for (const item of missing) {
          const record = ctx.store.stepRecordStatus(item.id);
          if (record && record !== "pending") problems.add(item.id);
        }
        return;
      }
      const probabilities = scored.map(item => item.result!.probability);
      return save(ctx.store, score, { query, lane, round, retrievalId: retrieval.id,
        score: trainingQueryScore(probabilities), maxProbability: Math.max(0, ...probabilities), judgments: scored.map(item => item.id) });
    } catch (error) { ctx.stopped = true; throw error; }
  }));
}

async function reviseLaneOnce(
  ctx: EvaluationContext,
  example: TrainingSourceExample,
  input: TrainingInput,
  lane: QueryLane,
  feedback: readonly QueryFeedback[],
) {
  // The only feedback sent to Luna is this lane's exact earlier queries and scores.
  const revision = ctx.store.step("generate", teacherRequest(example, lane, feedback));
  let pending = ctx.revisions.get(revision.id);
  if (!pending) {
    pending = (async () => {
      if (!revision.result && revision.status === "pending") {
        const bytes = Buffer.byteLength(trainingTeacherMessage(input, lane, feedback)) + Buffer.byteLength(trainingTeacherPrompt(lane));
        if (!hasCallRoom(ctx)) return;
        if (ctx.result.inputBytes + bytes > (ctx.options.maxInputBytes ?? 3_000_000)) { ctx.result.budgetLimited = true; return; }
        ctx.result.inputBytes += bytes;
        resolveTeacher(ctx);
      }
      return checkpoint(ctx.store, revision, ctx.result, () => ctx.teacher!(input, lane, feedback));
    })();
    ctx.revisions.set(revision.id, pending);
  }
  return { id: revision.id, result: await pending };
}

async function evaluateExample(ctx: EvaluationContext, example: TrainingSourceExample) {
  const reviews = ctx.reviewsBySource.get(example.id) ?? [];
  const preBlocked = blockedStepsForExample(ctx.store, reviews, ctx.judgeVersion);
  // A known non-retrieval failure for this judge cannot resolve before manual retry.
  // Do not scan its historical corpus or consume the example budget on every invocation.
  if (preBlocked.length) { ctx.result.blocked += preBlocked.length; ctx.result.flagged++; return; }
  const initial = LANES.map(lane => ({ lane, step: ctx.store.step("generate", teacherRequest(example, lane)) }));
  if (initial.some(({ step }) => !step.result)) {
    const blocked = initial.filter(({ step }) => !step.result && step.status !== "pending");
    if (blocked.length) {
      ctx.result.blocked += blocked.length; ctx.result.flagged++;
      ctx.store.flagReview(example, "generation-unresolved", { steps: blocked.map(({ step }) => step.id) });
    } else ctx.result.awaitingTeacher++;
    return;
  }
  if (ctx.options.maxExamples !== undefined && ctx.result.examples >= ctx.options.maxExamples) return;
  ctx.store.renew();
  let snapshot: HistoricalTrainingSnapshot;
  try { snapshot = await openSnapshot(ctx, example.timestamp); }
  catch (error) {
    if (!(error instanceof HistoricalCorpusUnavailableError)) throw error;
    ctx.store.flagReview(example, "historical-snapshot-unavailable", { timestamp: example.timestamp });
    ctx.result.flagged++;
    return;
  }
  try {
    const retrievalBlocked = blockedStepsForExample(ctx.store, reviews, ctx.judgeVersion, snapshot.corpusHash);
    if (retrievalBlocked.length) { ctx.result.blocked += retrievalBlocked.length; ctx.result.flagged++; return; }
    const evaluation = ctx.store.step("evaluate", { version: SELECTION_VERSION, sourceId: example.id, inputHash: example.inputHash,
      timestamp: example.timestamp, teacherIds: initial.map(({ step }) => step.id), corpusHash: snapshot.corpusHash,
      retrievalVersion: TRAINING_RETRIEVAL_VERSION, judgeVersion: ctx.judgeVersion,
      options: TRAINING_SEARCH_OPTIONS });
    const clearReview = { sourceId: example.id, scope: ctx.judgeVersion,
      matchesLegacyUnresolved: legacyUnresolvedMatchesJudge(ctx.store, ctx.judgeVersion) };
    if (evaluation.result) {
      ctx.result.cached++;
      ctx.store.clearReview(clearReview.sourceId, clearReview.scope, clearReview.matchesLegacyUnresolved);
      return;
    }
    if (evaluation.status !== "pending") {
      ctx.result.blocked++; ctx.result.flagged++;
      ctx.store.flagReview(example, "evaluation-unresolved", { steps: [evaluation.id] }, ctx.judgeVersion);
      return;
    }
    if (shouldStop(ctx) || (ctx.options.maxExamples !== undefined && ctx.result.examples >= ctx.options.maxExamples)) return;
    ctx.result.examples++;
    if (ctx.options.dryRun) return;
    const input = JSON.parse(example.inputJson) as TrainingInput;
    const problems = new Set<string>();
    const lanes = await drain(initial.map(async ({ lane, step }) => {
      try {
        const first = await scoreLaneQueries(ctx, example, input, snapshot, lane, 1, step.result!, step.id, problems);
        if (first.some(item => !item) || shouldStop(ctx)) return;
        const feedback = first.map(item => ({ query: item!.query, score: item!.score }));
        const revision = await reviseLaneOnce(ctx, example, input, lane, feedback);
        if (!revision.result) {
          const revisionStatus = ctx.store.stepRecordStatus(revision.id);
          if (revisionStatus && revisionStatus !== "pending") problems.add(revision.id);
          return;
        }
        const second = await scoreLaneQueries(ctx, example, input, snapshot, lane, 2, revision.result, revision.id, problems);
        if (second.some(item => !item)) return;
        return { teacherIds: [step.id, revision.id], queries: [...first, ...second].filter((item): item is QueryEvaluation => !!item) };
      } catch (error) { ctx.stopped = true; throw error; }
    }));
    if (problems.size) {
      ctx.result.flagged++; ctx.store.flagReview(example, "evaluation-unresolved", { steps: [...problems] }, ctx.judgeVersion); return;
    }
    if (lanes.some(lane => !lane)) return; // Budget pause: completed operations remain reusable.
    const queries = lanes.flatMap(lane => lane!.queries);
    const selected = selectTrainingQueries(queries);
    save(ctx.store, evaluation, { sourceId: example.id, inputHash: example.inputHash, timestamp: example.timestamp,
      corpusHash: snapshot.corpusHash, corpusReport: snapshot.report, teacherIds: lanes.flatMap(lane => lane!.teacherIds), queries, selected, review: [] },
      clearReview);
    ctx.result.evaluated++;
  } finally { await snapshot.close(); }
}

export async function evaluateTrainingQueries(source: Source, store: TrainingStore, config: UnblockMemoryConfig, runtime: unknown,
  options: Options & { maxCalls?: number; maxInputBytes?: number; concurrency?: number }, createSearch?: typeof historicalTrainingSearch) {
  bounds(options);
  const corpus = config.corpora.find(c => c.kind === "sessions");
  if (!corpus) throw new Error("Training retrieval requires a configured sessions corpus");
  const refreshed = collectTraining(source, store, { existingOnly: true });
  const concurrency = options.concurrency ?? TRAINING_EVALUATION_CONCURRENCY;
  const reviewsBySource = new Map<string, ReturnType<TrainingStore["reviews"]>>();
  for (const review of store.reviews()) {
    const list = reviewsBySource.get(review.sourceId);
    if (list) list.push(review); else reviewsBySource.set(review.sourceId, [review]);
  }
  const ctx: EvaluationContext = {
    source, store, config, runtime, options, chatTypes: corpus.chatTypes,
    judgeVersion: memoryJudgeVersion(config.decisionModel.model, config.decisionModel.endpoint),
    evaluationOptions: { endpoint: config.decisionModel.endpoint, model: config.decisionModel.model },
    result: { ...summary(), retrievals: 0, evaluated: 0, awaitingTeacher: 0 },
    reviewsBySource, judgments: new Map(), revisions: new Map(), createSearch, stopped: false,
  };
  const examples = store.queryExamples(options.threshold);
  let next = 0;
  await drain(Array.from({ length: Math.min(concurrency, examples.length) }, async () => {
    while (!shouldStop(ctx) && (options.maxExamples === undefined || ctx.result.examples < options.maxExamples)) {
      const example = examples[next++];
      if (!example) return;
      try { await evaluateExample(ctx, example); } catch (error) { ctx.stopped = true; throw error; }
    }
  }));
  return { refreshed, ...ctx.result, concurrency, threshold: options.threshold ?? TRAINING_GATE_THRESHOLD,
    retrievalMethod: "independent-lex10-vec10", callUnit: "teacher completion, retrieval operation or uncached passage judgment" };
}

export async function currentTrainingCorpusHashes(
  source: Source,
  store: TrainingStore,
  config: UnblockMemoryConfig,
  threshold = TRAINING_GATE_THRESHOLD,
  createSearch?: typeof historicalTrainingSearch,
): Promise<Map<string, string>> {
  const corpus = config.corpora.find(c => c.kind === "sessions");
  if (!corpus) throw new Error("Training retrieval requires a configured sessions corpus");
  const examples = store.queryExamples(threshold);
  const hashes = new Map<string, string>();
  if (!examples.length) return hashes;
  const sourceForCutoff = createSearch ? undefined : await historicalTrainingSource(source.stateDir, corpus.chatTypes);
  for (const example of examples) {
    store.renew();
    const snapshot = createSearch
      ? await createSearch(source.stateDir, corpus.chatTypes, example.timestamp)
      : await sourceForCutoff!(example.timestamp);
    try {
      const proven = snapshot.proven ?? (snapshot.report.sessions === 0 || snapshot.report.chunks > 0);
      if (proven) hashes.set(example.id, snapshot.corpusHash);
    } finally {
      await snapshot.close();
    }
  }
  return hashes;
}

function hasMatchingRetrievalProof(
  store: TrainingStore,
  source: TrainingSourceExample,
  evaluation: TrainingStepResults["evaluate"],
  expectedCorpusHash?: string,
): boolean {
  if (!evaluation.corpusHash) return false;
  if (expectedCorpusHash !== undefined && evaluation.corpusHash !== expectedCorpusHash) return false;
  if (!evaluation.queries.length) return false;
  for (const query of evaluation.queries) {
    const info = store.stepScope(query.retrievalId);
    if (!info || info.stage !== "retrieve" || info.status !== "complete") return false;
    if (info.request.sourceId !== source.id || info.request.corpusHash !== evaluation.corpusHash) return false;
    if (info.request.lane !== query.lane || info.request.query !== query.query) return false;
  }
  return true;
}

export function* exportQueryTraining(
  store: TrainingStore,
  threshold = TRAINING_GATE_THRESHOLD,
  judgeVersion = CONTEXT_JUDGE_VERSION,
  options?: { corpusHashes?: ReadonlyMap<string, string> },
) {
  const active = new Map(store.queryExamples(threshold).map(e => [e.id, e]));
  const unresolved = new Set(store.reviews().filter(review => reviewBlocksJudge(store, review, judgeVersion)).map(review => review.sourceId));
  const exported = new Set<string>();
  for (const evaluation of store.completedEvaluations({ selection: SELECTION_VERSION, retrieval: TRAINING_RETRIEVAL_VERSION, judge: judgeVersion })) {
    const source = active.get(evaluation.sourceId);
    if (!source || source.inputHash !== evaluation.inputHash || source.timestamp !== evaluation.timestamp || exported.has(source.id)) continue;
    if (unresolved.has(source.id)) { exported.add(source.id); continue; }
    let expectedCorpusHash: string | undefined;
    if (options?.corpusHashes !== undefined) {
      expectedCorpusHash = options.corpusHashes.get(source.id);
      if (!expectedCorpusHash) { exported.add(source.id); continue; }
      if (evaluation.corpusHash !== expectedCorpusHash) continue;
    }
    exported.add(source.id); // Never fall back to an older accepted corpus after a newer flagged result.
    if (!hasMatchingRetrievalProof(store, source, evaluation, expectedCorpusHash)) continue;
    if (!LANES.every(lane => evaluation.teacherIds.includes(store.step("generate", teacherRequest(source, lane)).id))) continue;
    // Selection is a local policy over completed scores, not another paid step.
    // This also recovers v2 checkpoints whose old usefulness policy saved null.
    const selected = selectTrainingQueries(evaluation.queries);
    const provenance = [...evaluation.teacherIds, ...evaluation.queries.flatMap(q => [q.retrievalId, ...q.judgments])];
    yield { stage: "query-training", input: JSON.parse(source.inputJson) as TrainingInput, inputHash: source.inputHash,
      recallProbability: source.recallProbability, ...(source.recallModel ? { recallModel: source.recallModel } : {}),
      recallRequestedModel: store.requestedModel,
      threshold, target: selected, targetPolicy: TARGET_POLICY,
      source: store.sourceDetails(source.id), evaluation: { ...evaluation, selected, review: [] }, splitGroup: jsonHash(source.sessionId),
      provenance: [...new Set(provenance)].map(id => store.stepRecord(id)) };
  }
}
