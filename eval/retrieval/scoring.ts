import { defaultContextChars, type EvidenceAlternative, type FrozenDocument, type FrozenRetrievalCase, type RetrievalSplit } from "./cases.js";

export type RetrievalHit = {
  path: string;
  snippet: string;
  startLine: number;
  endLine: number;
  score?: number;
};

export type RetrievalRun = {
  status: "ok" | "error";
  hits: readonly RetrievalHit[];
  latencyMs: number;
  error?: string;
};

export type CaseScore = {
  caseId: string;
  split: RetrievalSplit;
  status: "ok" | "error";
  eligibleHits: number;
  contextChars: number;
  evidenceGroups: number;
  satisfiedGroups: number;
  evidenceGroupRecall: number | null;
  completeCoverage: boolean | null;
  reciprocalRank: number | null;
  citationIntegrityRate: number | null;
  hasForbiddenLabels: boolean;
  forbiddenEvidence: boolean;
  noAnswerEmpty: boolean | null;
  latencyMs: number | null;
  error?: string;
};

export type AggregateScore = {
  cases: number;
  successfulCases: number;
  errors: number;
  answerableCases: number;
  noAnswerCases: number;
  requiredGroups: number;
  satisfiedGroups: number;
  evidenceGroupRecall: number | null;
  completeCoverage: number | null;
  meanReciprocalRank: number | null;
  citationIntegrityRate: number | null;
  forbiddenCases: number;
  forbiddenEvidenceRate: number | null;
  noAnswerEmptyRate: number | null;
  contextChars: { mean: number | null; p50: number | null; p95: number | null };
  latencyMs: { p50: number | null; p95: number | null };
};

export type ScoredArm = {
  cases: readonly CaseScore[];
  aggregate: AggregateScore;
};

function lineRange(body: string, startLine: number, endLine: number): string {
  const lines = body.split("\n");
  return lines.slice(Math.max(0, startLine - 1), Math.max(startLine - 1, endLine)).join("\n");
}

function alternativePresent(hit: RetrievalHit, alternative: EvidenceAlternative, documentsById: ReadonlyMap<string, FrozenDocument>): boolean {
  const document = documentsById.get(alternative.documentId);
  if (!document || hit.path !== document.path) return false;
  return hit.snippet.includes(alternative.quote);
}

function citationIsValid(hit: RetrievalHit, documentsByPath: ReadonlyMap<string, FrozenDocument>): boolean {
  const document = documentsByPath.get(hit.path);
  if (!document || !Number.isInteger(hit.startLine) || !Number.isInteger(hit.endLine) ||
    !hit.snippet || hit.startLine < 1 || hit.endLine < hit.startLine || hit.endLine > document.body.split("\n").length) return false;
  return lineRange(document.body, hit.startLine, hit.endLine).includes(hit.snippet);
}

export function scoreCase(
  item: FrozenRetrievalCase,
  run: RetrievalRun,
  documents: readonly FrozenDocument[],
): CaseScore {
  const documentsById = new Map(documents.map(document => [document.id, document]));
  const documentsByPath = new Map(documents.map(document => [document.path, document]));
  if (run.status === "error") {
    return { caseId: item.id, split: item.split, status: "error", eligibleHits: 0, contextChars: 0,
      evidenceGroups: item.required.length, satisfiedGroups: 0, evidenceGroupRecall: null,
      completeCoverage: null, reciprocalRank: null, citationIntegrityRate: null,
      hasForbiddenLabels: Boolean(item.forbidden?.length), forbiddenEvidence: false,
      noAnswerEmpty: null, latencyMs: run.latencyMs, error: run.error };
  }
  let contextChars = 0;
  const budget = item.maxContextChars ?? defaultContextChars;
  // Greedily retain whole excerpts in rank order; duplicates still spend budget.
  const hits = run.hits.filter(hit => {
    if (contextChars + hit.snippet.length > budget) return false;
    contextChars += hit.snippet.length;
    return true;
  });
  const citedHits = hits.filter(hit => citationIsValid(hit, documentsByPath));
  const satisfied = item.required.filter(group => citedHits.some(hit => group.alternatives.some(alternative =>
    alternativePresent(hit, alternative, documentsById))));
  const firstAnswer = item.required.length === 0 ? undefined : hits.findIndex(hit =>
    citedHits.includes(hit) && item.required.some(group => group.alternatives.some(alternative => alternativePresent(hit, alternative, documentsById))));
  const forbiddenEvidence = (item.forbidden ?? []).some(alternative => hits.some(hit => alternativePresent(hit, alternative, documentsById)));
  return {
    caseId: item.id,
    split: item.split,
    status: "ok",
    eligibleHits: hits.length,
    contextChars,
    evidenceGroups: item.required.length,
    satisfiedGroups: satisfied.length,
    evidenceGroupRecall: item.required.length ? satisfied.length / item.required.length : null,
    completeCoverage: item.required.length ? satisfied.length === item.required.length : null,
    reciprocalRank: item.required.length
      ? (firstAnswer === undefined || firstAnswer < 0 ? 0 : 1 / (firstAnswer + 1))
      : null,
    citationIntegrityRate: hits.length ? citedHits.length / hits.length : null,
    hasForbiddenLabels: Boolean(item.forbidden?.length),
    forbiddenEvidence,
    noAnswerEmpty: item.required.length === 0 ? hits.length === 0 : null,
    latencyMs: run.latencyMs,
  };
}

export function quantile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

export function aggregateScores(scores: readonly CaseScore[]): AggregateScore {
  const successful = scores.filter(score => score.status === "ok");
  const answerable = successful.filter(score => score.evidenceGroups > 0);
  const noAnswer = successful.filter(score => score.evidenceGroups === 0);
  const requiredGroups = answerable.reduce((sum, score) => sum + score.evidenceGroups, 0);
  const satisfiedGroups = answerable.reduce((sum, score) => sum + score.satisfiedGroups, 0);
  const complete = answerable.map(score => score.completeCoverage ? 1 : 0);
  const ranks = answerable.map(score => score.reciprocalRank ?? 0);
  const citationValues = successful.flatMap(score => score.citationIntegrityRate === null ? [] : [score.citationIntegrityRate]);
  const forbiddenCases = successful.filter(score => score.hasForbiddenLabels);
  const context = successful.map(score => score.contextChars);
  const latency = successful.flatMap(score => score.latencyMs === null ? [] : [score.latencyMs]);
  return {
    cases: scores.length,
    successfulCases: successful.length,
    errors: scores.length - successful.length,
    answerableCases: answerable.length,
    noAnswerCases: noAnswer.length,
    requiredGroups,
    satisfiedGroups,
    evidenceGroupRecall: requiredGroups ? satisfiedGroups / requiredGroups : null,
    completeCoverage: answerable.length ? complete.reduce<number>((sum, value) => sum + value, 0) / answerable.length : null,
    meanReciprocalRank: answerable.length ? ranks.reduce((sum, value) => sum + value, 0) / answerable.length : null,
    citationIntegrityRate: citationValues.length ? citationValues.reduce((sum, value) => sum + value, 0) / citationValues.length : null,
    forbiddenCases: forbiddenCases.length,
    forbiddenEvidenceRate: forbiddenCases.length ? forbiddenCases.filter(score => score.forbiddenEvidence).length / forbiddenCases.length : null,
    noAnswerEmptyRate: noAnswer.length ? noAnswer.filter(score => score.noAnswerEmpty).length / noAnswer.length : null,
    contextChars: { mean: context.length ? context.reduce((sum, value) => sum + value, 0) / context.length : null,
      p50: quantile(context, 0.5), p95: quantile(context, 0.95) },
    latencyMs: { p50: quantile(latency, 0.5), p95: quantile(latency, 0.95) },
  };
}

export function scoreArm(
  cases: readonly FrozenRetrievalCase[],
  runs: ReadonlyMap<string, RetrievalRun>,
  documents: readonly FrozenDocument[],
): ScoredArm {
  const scores = cases.map(item => scoreCase(item, runs.get(item.id) ?? {
    status: "error", hits: [], latencyMs: 0, error: "missing prediction",
  }, documents));
  return { cases: scores, aggregate: aggregateScores(scores) };
}
