import assert from "node:assert/strict";
import test from "node:test";
import { reviewIndexedClaim } from "../src/evidence-review.js";
import { resolveConfig } from "../src/config.js";
import { reviewFixture } from "./helpers/review-store.js";

function response(choice = "supports", confidence = 0.99) {
  return Response.json({ answers: { relation: { type: "choice", choice, confidence,
    probabilities: { supports: choice === "supports" ? 0.99 : 0.005, contradicts: choice === "contradicts" ? 0.99 : 0.005,
      insufficient_evidence: choice === "insufficient_evidence" ? 0.99 : 0.005 } } } });
}

test("evidence review requires separate explicit corpus approval", () => {
  assert.deepEqual(resolveConfig({}).evidenceReview, { enabled: false, corpora: [] });
  assert.deepEqual(resolveConfig({ evidenceReview: { enabled: true, corpora: ["memory", "memory"] } }).evidenceReview,
    { enabled: true, corpora: ["memory"] });
  for (const value of [true, [], { enabled: true }, { corpora: ["skills"] }, { corpora: ["unknown"] }, { enabled: "yes" }, { minNoise: 0.5 }]) {
    assert.throws(() => resolveConfig({ evidenceReview: value }), /evidenceReview/);
  }
});

test("claim review loads indexed evidence, returns provenance and uncertainty, and never writes", async t => {
  const f = await reviewFixture(); t.after(f.close);
  const note = await f.insert("# Decision\nAva approved Atlas staging on September 18. Production is not approved.");
  const citations = [{ path: note.uri, from: 2, lines: 1 }];
  let choice = "supports", confidence = 0.99;
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.state.evidence, [note.text.split("\n")[1]]);
    assert.match(JSON.stringify(request.questions), /person\/entity, date, scope, negation and certainty/);
    assert.equal(init?.redirect, "error");
    return response(choice, confidence);
  });
  const before = f.db.prepare("SELECT * FROM content").all();
  for (const [claim, verdict] of [
    ["Ava approved Atlas staging on September 18.", "supports"],
    ["Ava approved Atlas production.", "contradicts"],
    ["Ava prefers weekly releases.", "insufficient_evidence"],
  ]) {
    choice = verdict;
    const result = await reviewIndexedClaim({ ...f.params, claim, citations });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") assert.fail();
    assert.equal(result.verdict, verdict);
    assert.equal(result.needsReview, verdict !== "supports");
    assert.equal(result.evidence[0].documentHash, note.hash);
    assert.equal(result.evidence[0].excerptHash.length, 64);
    assert.equal(JSON.stringify(result).includes(note.text.split("\n")[1]), false);
  }
  choice = "supports"; confidence = 0.55;
  assert.equal((await reviewIndexedClaim({ ...f.params, claim: "Ava approved staging", citations })).needsReview, true);
  assert.deepEqual(f.db.prepare("SELECT * FROM content").all(), before);
  assert.equal(f.curation.listTasks().length, 0);
});

test("missing, oversized or unapproved evidence never reaches the provider", async t => {
  const f = await reviewFixture(); t.after(f.close);
  const note = await f.insert("Useful evidence");
  const huge = await f.insert("x".repeat(6001));
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("must not call"); });
  for (const citation of [
    { path: note.uri.replace(f.source.collection, "private"), from: 1, lines: 1 },
    { path: note.uri.replace(note.path, "missing.md"), from: 1, lines: 1 },
    { path: note.uri, from: 99, lines: 1 }, { path: huge.uri, from: 1, lines: 1 },
  ]) assert.equal((await reviewIndexedClaim({ ...f.params, claim: "x", citations: [citation] })).status, "unavailable");
  assert.equal(fetch.mock.callCount(), 0);
});

test("evidence mutation, invalid answers and cancellation cannot verify a claim", async t => {
  const f = await reviewFixture(); t.after(f.close);
  const note = await f.insert("Original evidence");
  const params = { ...f.params, claim: "Original evidence", citations: [{ path: note.uri, from: 1, lines: 1 }] };
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    f.db.prepare("UPDATE documents SET active = 0").run();
    return response();
  });
  assert.equal((await reviewIndexedClaim(params)).status, "unavailable");
  f.db.prepare("UPDATE documents SET active = 1").run();
  fetch.mock.mockImplementation(async () => response("made_up_verdict"));
  await assert.rejects(reviewIndexedClaim(params), /invalid/);
  fetch.mock.mockImplementation(async () => new Response("secret", { status: 500 }));
  await assert.rejects(reviewIndexedClaim(params), /^Error: TypeSafe review unavailable$/);
  await assert.rejects(reviewIndexedClaim({ ...params, signal: AbortSignal.abort() }));
});
