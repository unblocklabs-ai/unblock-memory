import assert from "node:assert/strict";
import test from "node:test";
import { reviewClusterIngestion } from "../src/cluster-review.js";
import { reviewFixture } from "./helpers/review-store.js";
import type { reviewClusterDefects } from "../src/typesafe-review.js";

function answer(defect: Awaited<ReturnType<typeof reviewClusterDefects>>[number]["defect"], confidence = 0.99) {
  return { type: "choice", choice: defect, confidence,
    probabilities: { wrapper: 0.97, encoding: 0.01, boilerplate: 0.01, none_or_uncertain: 0.01 } };
}

test("cluster review samples center and edge, excludes unapproved members and preserves useful minorities", async t => {
  const f = await reviewFixture(); t.after(f.close);
  const notes = [];
  for (let i = 0; i < 10; i++) notes.push(await f.insert(i === 9 ? "Useful decision" : `Wrapper ${i}`, i === 8 ? "private" : f.source.collection));
  const clusterId = f.cluster(notes.map(note => note.hash));
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.state.excerpts.length, 5); // 3 center + 3 edge, one unapproved
    assert.equal(request.state.excerpts.includes("Wrapper 8"), false);
    assert.ok(request.state.excerpts.includes("Useful decision"));
    return Response.json({ answers: Object.fromEntries(request.state.excerpts.map((text: string, i: number) => [
      `member_${i}`, answer(text === "Useful decision" ? "none_or_uncertain" : "wrapper", text === "Wrapper 7" ? 0.4 : 0.99),
    ])) });
  });
  const result = await reviewClusterIngestion({ ...f.params, clusterId });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") assert.fail();
  assert.equal(result.sampled, 5);
  assert.equal(result.clusterSize, 10);
  assert.equal(result.recurring[0].examples.length, 3);
  assert.equal(result.members.filter(member => !member.flagged).length, 2);
  assert.equal(f.curation.listTasks().length, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM documents WHERE active = 1").get<{ n: number }>()!.n, 10);
});

test("stale clusters and changed evidence cannot produce actionable review results", async t => {
  const f = await reviewFixture(); t.after(f.close);
  const note = await f.insert("Wrapper");
  const clusterId = f.cluster([note.hash]);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    f.db.prepare("UPDATE memory_analysis_runs SET stale_at = 'now'").run();
    return Response.json({ answers: { member_0: answer("wrapper") } });
  });
  const params = { ...f.params, clusterId };
  assert.equal((await reviewClusterIngestion(params)).status, "unavailable");
  assert.equal((await reviewClusterIngestion(params)).status, "unavailable");
  assert.equal(fetch.mock.callCount(), 1);
  f.db.prepare("UPDATE memory_analysis_runs SET stale_at = NULL").run();
  fetch.mock.mockImplementation(async () => {
    f.db.prepare("UPDATE content_vectors SET chunk_len = 2").run();
    return Response.json({ answers: { member_0: answer("wrapper") } });
  });
  assert.equal((await reviewClusterIngestion(params)).status, "unavailable");
});

test("oversized members are skipped whole; malformed/provider failures do not become cluster labels", async t => {
  const f = await reviewFixture(); t.after(f.close);
  const huge = await f.insert("x".repeat(2001));
  const clusterId = f.cluster([huge.hash]);
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ answers: {} }));
  assert.equal((await reviewClusterIngestion({ ...f.params, clusterId })).status, "unavailable");
  assert.equal(fetch.mock.callCount(), 0);
  f.db.prepare("UPDATE content_vectors SET chunk_len = 100").run();
  await assert.rejects(reviewClusterIngestion({ ...f.params, clusterId }), /invalid/);
  fetch.mock.mockImplementation(async () => new Response("private provider body", { status: 500 }));
  await assert.rejects(reviewClusterIngestion({ ...f.params, clusterId }), /^Error: TypeSafe review unavailable$/);
});
