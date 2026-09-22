import assert from "node:assert/strict";
import test from "node:test";
import { syntheticCases, syntheticDocuments, validateDataset } from "../eval/retrieval/cases.js";
import { runArm } from "../eval/retrieval/lab.js";
import { aggregateScores, scoreCase, type RetrievalRun } from "../eval/retrieval/scoring.js";

test("synthetic retrieval labels are frozen and every quote is source-backed", () => {
  assert.doesNotThrow(() => validateDataset());
  assert.equal(new Set(syntheticCases.map(item => item.id)).size, syntheticCases.length);
});

test("scoring is duplicate-safe and measures complete multi-hop coverage", () => {
  const item = syntheticCases.find(candidate => candidate.id === "sync-plan")!;
  const cadence = "memory/operations/sync-cadence.md";
  const owner = "memory/operations/sync-owner.md";
  const run: RetrievalRun = { status: "ok", latencyMs: 12, hits: [
    { path: cadence, snippet: "The nightly memory sync runs at 03:00 America/New_York.", startLine: 3, endLine: 3 },
    { path: cadence, snippet: "The nightly memory sync runs at 03:00 America/New_York.", startLine: 3, endLine: 3 },
    { path: owner, snippet: "Bek owns the nightly memory sync runbook and reviews its failures.", startLine: 3, endLine: 3 },
  ] };
  const score = scoreCase(item, run, syntheticDocuments);
  assert.equal(score.satisfiedGroups, 2);
  assert.equal(score.evidenceGroupRecall, 1);
  assert.equal(score.completeCoverage, true);
  assert.equal(score.reciprocalRank, 1);
});

test("fixed budgets skip oversized evidence rather than slicing it", () => {
  const item = syntheticCases.find(candidate => candidate.id === "backend-choice")!;
  const run: RetrievalRun = { status: "ok", latencyMs: 1, hits: [
    { path: "memory/decisions/search-backend.md", snippet: `${"x".repeat(500)}\nwe chose SQLite plus QMD for the first memory search backend`, startLine: 1, endLine: 5 },
  ] };
  const score = scoreCase({ ...item, maxContextChars: 100 }, run, syntheticDocuments);
  assert.equal(score.eligibleHits, 0);
  assert.equal(score.evidenceGroupRecall, 0);
  assert.equal(score.contextChars, 0);
});

test("errors stay out of quality denominators", () => {
  const error = scoreCase(syntheticCases[0]!, { status: "error", hits: [], latencyMs: 7, error: "index failed" }, syntheticDocuments);
  const success = scoreCase(syntheticCases[1]!, { status: "ok", hits: [], latencyMs: 9 }, syntheticDocuments);
  const aggregate = aggregateScores([error, success]);
  assert.equal(aggregate.errors, 1);
  assert.equal(aggregate.successfulCases, 1);
  assert.equal(aggregate.answerableCases, 1);
  assert.equal(aggregate.evidenceGroupRecall, 0);
  assert.equal(aggregate.latencyMs.p50, 9);
});

test("the cumulative budget skips a non-fitting excerpt and still admits a later whole excerpt", () => {
  const item = syntheticCases.find(candidate => candidate.id === "sync-plan")!;
  const cadence = { path: "memory/operations/sync-cadence.md", snippet: "The nightly memory sync runs at 03:00 America/New_York.", startLine: 3, endLine: 3 };
  const owner = { path: "memory/operations/sync-owner.md", snippet: "Bek owns the nightly memory sync runbook and reviews its failures.", startLine: 3, endLine: 3 };
  const heading = { path: owner.path, snippet: "# Sync owner", startLine: 1, endLine: 1 };
  const run: RetrievalRun = { status: "ok", latencyMs: 1, hits: [cadence, owner, heading] };
  const budget = cadence.snippet.length + heading.snippet.length;
  const score = scoreCase({ ...item, maxContextChars: budget }, run, syntheticDocuments);
  assert.equal(score.eligibleHits, 2);
  assert.equal(score.contextChars, budget);
  assert.equal(score.evidenceGroupRecall, 0.5);
  assert.equal(score.completeCoverage, false);
  // The saved raw predictions remain untouched for later rescoring.
  assert.equal(run.hits.length, 3);
});

test("evidence requires the exact collection-qualified source and a valid citation", () => {
  const item = syntheticCases[0]!;
  const source = syntheticDocuments[0]!;
  const document = { ...source, path: "qmd://approved/decisions/search-backend.md" };
  const hit = { path: document.path, snippet: document.body, startLine: 1, endLine: 5 };
  const run: RetrievalRun = { status: "ok", latencyMs: 1, hits: [hit] };
  assert.equal(scoreCase(item, run, [document]).completeCoverage, true);
  for (const invalid of [
    { ...hit, path: "qmd://other/decisions/search-backend.md" },
    { ...hit, path: "qmd://approved/prefix/decisions/search-backend.md" },
    { ...hit, startLine: 2 },
    { ...hit, endLine: 500 },
  ]) {
    const score = scoreCase(item, { ...run, hits: [invalid] }, [document]);
    assert.equal(score.evidenceGroupRecall, 0);
    assert.equal(score.citationIntegrityRate, 0);
  }
});

test("the shared runner scores supplied documents, retains first-trial errors and excludes failed timings", async () => {
  const document = { id: "custom", path: "qmd://test/a.md", body: "unique evidence" };
  const cases = ["first", "second"].map(id => ({ ...syntheticCases[0]!, id,
    required: [{ id: "evidence", alternatives: [{ documentId: document.id, quote: document.body }] }] }));
  let calls = 0;
  const report = await runArm("test", async () => {
    calls += 1;
    if (calls === 2 || calls === 5) throw new Error("trial failed");
    return [{ path: document.path, snippet: document.body, startLine: 1, endLine: 1 }];
  }, cases, [document], 2);
  assert.equal(calls, 5); // One warmup and four full retrievals.
  assert.equal(report.failedTrials, 2);
  assert.equal(report.successfulLatenciesMs.length, 2);
  assert.equal(report.runs.first!.status, "error");
  assert.equal(report.runs.second!.status, "ok");
  assert.equal(report.scored.aggregate.errors, 1);
  assert.equal(report.scored.aggregate.completeCoverage, 1);
});

test("setup and warmup failures are unavailable arms, not successful no-answer results", async () => {
  for (const setupError of ["index_setup_failed", undefined]) {
    let calls = 0;
    const report = await runArm("test", async () => { calls += 1; throw new Error("unavailable"); },
      syntheticCases, syntheticDocuments, 2, setupError);
    assert.equal(calls, setupError ? 0 : 1);
    assert.equal(report.trials, 0);
    assert.equal(report.setupError, setupError ?? "warmup_failed");
    assert.equal(report.scored.aggregate.errors, syntheticCases.length);
    assert.equal(report.scored.aggregate.noAnswerEmptyRate, null);
    assert.deepEqual(report.successfulLatenciesMs, []);
  }
});
