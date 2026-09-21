import assert from "node:assert/strict";
import test from "node:test";
import { rerankXsearch } from "../src/xsearch.js";
import { xsearchBm25 } from "../src/xsearch-bm25.js";
import { resolveConfig } from "../src/config.js";
import type { CorpusMemorySearchResult } from "../src/contracts.js";
import { reviewFixture } from "./helpers/review-store.js";

function hit(snippet: string, path = snippet): CorpusMemorySearchResult {
  return { snippet, path: `qmd://memory/${path}`, corpus: "memory", source: "memory", startLine: 1, endLine: 1, score: 0.8, vectorScore: 0.8 };
}
const options = { query: "Who approved staging?", apiKey: "test-secret", timeoutMs: 1000,
  signal: new AbortController().signal, maxResults: 10, minScore: 0 };
function judgment(score: number) {
  return Response.json({ answers: { usefulness: { type: "score", score, confidence: 1,
    probabilities: { "0": Number(score === 0), "1": Number(score === 1), "2": Number(score === 2), "3": Number(score === 3) } } } });
}

test("xsearch independently scores deduped excerpts and sorts by usefulness, not retrieval scores", async t => {
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    assert.equal(body.state.query, options.query);
    assert.equal(body.questions.usefulness.type, "score");
    assert.equal(Array.isArray(body.questions.usefulness.criteria), true);
    return judgment(body.state.candidate.excerpt === "direct" ? 3 : 1);
  });
  const ranked = await rerankXsearch({ ...options, maxResults: 1,
    vector: [hit("background"), hit("direct")], lexical: [{ ...hit("direct"), startLine: 4, endLine: 4, textScore: 0.1 }] });
  assert.equal(requests.length, 2);
  assert.equal(ranked.results[0]?.snippet, "direct");
  assert.equal(ranked.results[0]?.score, 1);
  assert.deepEqual(ranked.results[0]?.retrievalMethods, ["vector", "bm25"]);
  assert.equal(ranked.results[0]?.aliases?.[0]?.startLine, 4);
  assert.equal(ranked.candidates.duplicates, 1);
  assert.equal(ranked.results[0]?.vectorScore, 0.8);
  assert.equal(ranked.results[0]?.textScore, 0.1);
});

test("identical excerpts from different sources retain distinct attribution", async t => {
  t.mock.method(globalThis, "fetch", async () => judgment(2));
  const result = await rerankXsearch({ ...options,
    vector: [hit("Mira approved", "atlas.md")], lexical: [hit("Mira approved", "vega.md")] });
  assert.equal(result.candidates.deduplicated, 2);
  assert.equal(result.results.length, 2);
});

test("xsearch sends one evaluation clock and only supplied date bounds, separately from source dates", async t => {
  const asOf = "2026-09-18T12:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(asOf) });
  const startedFrom = "2026-09-01T00:00:00-04:00";
  const startedTo = "2026-09-18T23:59:59-04:00";
  let expected: object;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.state.timeContext, expected);
    assert.equal(body.state.candidate.startedAt, body.state.candidate.corpus === "sessions"
      ? "2026-09-10T09:00:00.000Z" : undefined, "source dates stay distinct and file dates are not fabricated");
    calls++;
    // All candidates share one clock even if the batch spans a clock change.
    t.mock.timers.tick(1000);
    return judgment(1);
  });
  for (const bounds of [{}, { startedFrom }, { startedTo }, { startedFrom, startedTo }]) {
    const clock = new Date().toISOString();
    expected = { asOf: clock,
      ...("startedFrom" in bounds ? { sessionStartedFrom: bounds.startedFrom } : {}),
      ...("startedTo" in bounds ? { sessionStartedTo: bounds.startedTo } : {}) };
    const sessionFilter = { ...bounds, provider: "slack", accountId: "private-account" };
    const result = await rerankXsearch({ ...options, sessionFilter,
      vector: [hit("first"), { ...hit("second"), corpus: "sessions", session: {
        sessionId: "test-session", chatType: "direct", startedAt: Date.parse("2026-09-10T09:00:00Z"),
      } }], lexical: [] });
    assert.equal(result.asOf, clock);
    assert.equal(result.policy, "jev-1.13.0:xsearch-v3");
  }
  assert.equal(calls, 8);
});

test("xsearch keeps distinct passages, applies final minScore, and reports failed or oversized candidates", async t => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const text = JSON.parse(String(init?.body)).state.candidate.excerpt;
    if (text === "failed") throw new Error("secret server diagnostics");
    if (text === "invalid") return Response.json({ answers: { usefulness: { type: "score", score: 3, confidence: 1,
      probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 } } } });
    return judgment(text === "good" ? 3 : 1);
  });
  const ranked = await rerankXsearch({ ...options, minScore: 0.5,
    vector: [hit("good", "same"), hit("weak", "same"), hit("failed"), hit("invalid"), hit("x".repeat(12001))], lexical: [] });
  assert.equal(ranked.status, "partial");
  assert.deepEqual(ranked.results.map(r => r.snippet), ["good"]);
  assert.equal(ranked.candidates.failed, 2);
  assert.equal(ranked.candidates.oversized, 1);
  assert.equal(JSON.stringify(ranked).includes("secret"), false);
});

test("xsearch bounds concurrency and cancellation never yields late results", async t => {
  const controller = new AbortController(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 6) controller.abort(new Error("cancelled"));
    return new Promise<Response>(() => {});
  });
  await assert.rejects(rerankXsearch({ ...options, signal: controller.signal,
    vector: Array.from({ length: 15 }, (_, i) => hit(String(i))), lexical: [] }), /cancelled/);
  assert.equal(calls, 6);
});

test("BM25 scopes before limiting, excludes inactive and unrelated corpora, and selects intact stored spans", async t => {
  const f = await reviewFixture(); t.after(f.close);
  const denied = await f.insert("staging staging staging approved");
  const allowed = await f.insert("unrelated opening\nMira approved staging\nother context");
  await f.insert("staging staging", "skills");
  const inactive = await f.insert("staging staging staging staging");
  f.db.prepare("UPDATE documents SET active=0 WHERE hash=?").run(inactive.hash);
  f.db.prepare("UPDATE content_vectors SET pos=18, chunk_len=21 WHERE hash=?").run(allowed.hash);
  const results = xsearchBm25(f.db, "Who approved staging?", [f.source.collection], 1, { [f.source.collection]: [allowed.path] });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.file, allowed.uri);
  assert.equal(results[0]?.bestChunk, "Mira approved staging");
  assert.equal(results[0]?.chunkPos, 18);
  assert.deepEqual(xsearchBm25(f.db, "staging", [f.source.collection], 10, { [f.source.collection]: [] }), []);
  assert.ok(xsearchBm25(f.db, '"staging" OR NOT (approved*)', [f.source.collection], 10).every(r => r.file !== inactive.uri));
  assert.ok(xsearchBm25(f.db, "staging", [f.source.collection], 10).some(r => r.file === denied.uri));
  assert.deepEqual(xsearchBm25(f.db, "!?", [f.source.collection], 10), []);
});

test("BM25 selects complete stored spans using FTS matches and original source offsets", async t => {
  const f = await reviewFixture(); t.after(f.close);
  for (const [query, opening, matched] of [
    ["running", "Unrelated oranges.\n\n", "The athlete runs every morning."],
    ["cafe", "中文前言\t\n\nUnrelated oranges.\n", "Meet at the café tomorrow."],
  ]) {
    const note = await f.insert(opening + matched);
    f.db.prepare("UPDATE content_vectors SET chunk_len=? WHERE hash=?").run(opening.length, note.hash);
    f.db.prepare(`INSERT INTO content_vectors(hash, seq, pos, chunk_len, model, embedded_at)
      VALUES (?, 1, ?, ?, 'model', 'now')`).run(note.hash, opening.length, matched.length);
    const [result] = xsearchBm25(f.db, query, [f.source.collection], 1);
    assert.equal(result?.file, note.uri);
    assert.equal(result?.bestChunk, matched);
    assert.equal(result?.chunkPos, opening.length);
    assert.equal(result?.chunkLen, matched.length);
  }
  const titleOnly = await f.insert("First stored chunk.\nSecond stored chunk.");
  f.db.prepare("UPDATE documents SET title='zebras' WHERE hash=?").run(titleOnly.hash);
  f.db.prepare("UPDATE content_vectors SET chunk_len=19 WHERE hash=?").run(titleOnly.hash);
  f.db.prepare(`INSERT INTO content_vectors(hash, seq, pos, chunk_len, model, embedded_at)
    VALUES (?, 1, 20, 20, 'model', 'now')`).run(titleOnly.hash);
  assert.equal(xsearchBm25(f.db, "zebras", [f.source.collection], 1)[0]?.bestChunk, "First stored chunk.");
  f.db.prepare("DELETE FROM content_vectors WHERE hash=?").run(titleOnly.hash);
  assert.deepEqual(xsearchBm25(f.db, "zebras", [f.source.collection], 1), []);
});

test("xsearch config requires explicit known non-skill corpus approval", () => {
  assert.deepEqual(resolveConfig({}).xsearch, { enabled: false, corpora: [], timeoutMs: 10000 });
  assert.throws(() => resolveConfig({ xsearch: { enabled: true } }), /xsearch.*explicit corpora/);
  assert.throws(() => resolveConfig({ xsearch: { enabled: true, corpora: ["skills"] } }), /xsearch.corpora/);
  assert.throws(() => resolveConfig({ xsearch: { enabled: true, corpora: ["memory"], timeoutMs: 30001 } }), /xsearch.timeoutMs/);
  assert.equal(resolveConfig({ xsearch: { enabled: true, corpora: ["memory"] } }).xsearch.enabled, true);
});
