import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "@unblocklabs/qmd";
import { resolveConfig } from "../src/config.js";
import { CurationStore } from "../src/curation.js";
import { auditQualityPage, qualityStructure } from "../src/quality-audit.js";
import { resolveSource } from "../src/sources.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "unblock-quality-"));
  const store = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  const curation = new CurationStore(join(root, "curation.sqlite"));
  const source = resolveSource(root, "memory/**/*.md", "memory");
  mkdirSync(source.root, { recursive: true });
  const db = store.internal.db;
  let count = 0;
  const insert = (text: string, collection = source.collection, path?: string) => {
    const hash = `hash-${++count}`;
    if (!path?.includes("..")) writeFileSync(join(source.root, path ?? `${hash}.md`), text);
    db.prepare("INSERT INTO content(hash, doc, created_at) VALUES (?, ?, 'now')").run(hash, text);
    db.prepare(`INSERT INTO documents(collection, path, title, hash, created_at, modified_at, active)
      VALUES (?, ?, 'Memory', ?, 'now', 'now', 1)`).run(collection, path ?? `${hash}.md`, hash);
    db.prepare(`INSERT INTO content_vectors(hash, seq, pos, chunk_len, model, embedded_at)
      VALUES (?, 0, 0, ?, 'model', 'now')`).run(hash, text.length);
    return hash;
  };
  return { db, curation, source, insert,
    params: { db, curation, sources: [source], apiKey: "fake", timeoutMs: 1000,
      minNoise: 0.9, signal: new AbortController().signal, isActive: () => true },
    close: async () => { curation.close(); await store.close(); },
  };
}

test("quality audit requires explicit known corpus approval", () => {
  assert.deepEqual(resolveConfig({}).qualityAudit, { enabled: false, corpora: [], minNoise: 0.8 });
  assert.deepEqual(resolveConfig({ qualityAudit: { enabled: true, corpora: ["memory", "memory"] } }).qualityAudit.corpora, ["memory"]);
  for (const qualityAudit of [true, [], { enabled: true }, { corpora: ["unknown"] },
    { corpora: ["skills"] }, { corpora: "memory" }, { enabled: "yes" }, { minNoise: NaN },
    { minNoise: -0.1 }, { minNoise: 1.1 }, { extra: true }]) {
    assert.throws(() => resolveConfig({ qualityAudit }), /qualityAudit/);
  }
});

test("structure checks distinguish message envelopes from useful JSON without judging value", () => {
  assert.equal(qualityStructure("  "), "empty");
  assert.equal(qualityStructure('{"role":"user","content":"important"}'), "serialized_message");
  assert.equal(qualityStructure(JSON.stringify('{"role":"user","content":"important"}')), "encoded_message");
  assert.equal(qualityStructure(JSON.stringify('{"retryCount":3}')), "plain_or_structured");
  assert.equal(qualityStructure('{"retryCount":3}'), "plain_or_structured");
  assert.equal(qualityStructure("{broken"), "plain_or_structured");
});

test("double-encoded messages are encoding indicators even when the content is useful", async t => {
  const f = await fixture(); t.after(f.close);
  f.insert(JSON.stringify(JSON.stringify({ role: "user", content: "Deploy only with approval" })));
  f.insert(JSON.stringify({ role: "user", content: "Deploy only with approval" }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: {
    noise_0: { type: "noul", noul: 0.1 }, evidence_0: { type: "noul", noul: 0.95 },
    noise_1: { type: "noul", noul: 0.1 }, evidence_1: { type: "noul", noul: 0.95 },
  } }));
  const result = await auditQualityPage(f.params);
  assert.equal(result.flagged, 1);
  assert.equal(result.groups[0].reason, "possible_double_encoded_message");
  const detail = JSON.parse(result.groups[0].examples[0].detail!);
  assert.equal(detail.indicator, "deterministic_encoding");
  assert.equal(detail.evidence, 0.95);
});

test("bounded pages cache judgments, respect scope and preserve dismissed versions", async t => {
  const f = await fixture(); t.after(f.close);
  f.insert("wrapper with evidence");
  f.insert("wrapper with evidence");
  f.insert("legitimate JSON configuration");
  f.insert("private source", "private");
  f.insert("outside pattern", f.source.collection, "../outside.md");
  let evaluated = 0;
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(JSON.stringify(request).includes("private source"), false);
    assert.equal(JSON.stringify(request).includes("outside pattern"), false);
    evaluated += request.state.chunks.length;
    return Response.json({ answers: Object.fromEntries(request.state.chunks.flatMap((chunk: { text: string }, i: number) => [
      [`noise_${i}`, { type: "noul", noul: chunk.text.includes("wrapper") ? 0.97 : 0.1 }],
      [`evidence_${i}`, { type: "noul", noul: 0.98 }],
    ])) });
  });
  const first = await auditQualityPage({ ...f.params, limit: 2 });
  assert.equal(first.done, false);
  assert.equal(first.flagged, 2);
  assert.equal(first.groups[0].pending, 2);
  assert.equal(evaluated, 1); // identical content evaluated once, occurrences remain separate
  const task = first.groups[0].examples[0];
  assert.equal(JSON.parse(task.detail!).evidence, 0.98);
  f.curation.updateTask({ id: task.id, status: "irrelevant" });
  const second = await auditQualityPage({ ...f.params, after: first.next });
  assert.equal(second.done, true);
  assert.equal(second.flagged, 0);
  assert.equal(second.skippedStale, 1);
  const rescan = await auditQualityPage(f.params);
  assert.equal(evaluated, 2);
  assert.equal(rescan.cached, 3);
  assert.equal(rescan.groups[0].pending, 1);
  assert.equal(f.curation.listTasks({ status: "irrelevant" })[0].id, task.id);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM documents WHERE active = 1").get<{ n: number }>()!.n, 5);
});

test("failure, cancellation and changed index content cannot produce stale findings", async t => {
  const f = await fixture(); t.after(f.close);
  const hash = f.insert("suspected noise");
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("secret provider text", { status: 529 }));
  const failed = await auditQualityPage(f.params);
  assert.equal(failed.status, "partial");
  assert.equal(failed.next, undefined);
  assert.equal(f.curation.listTasks().length, 0);
  assert.equal(JSON.stringify(failed).includes("secret provider text"), false);
  fetch.mock.mockImplementation(async () => {
    f.db.prepare("UPDATE documents SET active = 0 WHERE hash = ?").run(hash);
    return Response.json({ answers: { noise_0: { type: "noul", noul: 1 }, evidence_0: { type: "noul", noul: 0 } } });
  });
  assert.equal((await auditQualityPage(f.params)).skippedStale, 1);
  assert.equal(f.curation.listTasks().length, 0);
  f.db.prepare("UPDATE documents SET active = 1 WHERE hash = ?").run(hash);
  const controller = new AbortController();
  fetch.mock.mockImplementation(async () => {
    controller.abort();
    return Response.json({ answers: { noise_0: { type: "noul", noul: 1 }, evidence_0: { type: "noul", noul: 0 } } });
  });
  assert.equal((await auditQualityPage({ ...f.params, signal: controller.signal })).status, "partial");
  assert.equal(f.curation.listTasks().length, 0);
});

test("oversized chunks are reported, never silently truncated; empty content needs no API call", async t => {
  const f = await fixture(); t.after(f.close);
  f.insert("x".repeat(6001));
  f.insert("   ");
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected"); });
  const result = await auditQualityPage(f.params);
  assert.equal(result.done, true);
  assert.equal(result.skippedOversized, 1);
  assert.equal(result.flagged, 1);
  assert.equal(result.groups[0].reason, "empty_content");
  assert.equal(fetch.mock.callCount(), 0);
});

test("partial pages resume after completed work and a changed fingerprint gets a new review", async t => {
  const f = await fixture(); t.after(f.close);
  for (let i = 0; i < 5; i++) f.insert(`noise ${i}`);
  let calls = 0;
  const fetch = t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof globalThis.fetch>) => {
    if (++calls === 2) return new Response("failure", { status: 529 });
    const request = JSON.parse(String(init?.body));
    return Response.json({ answers: Object.fromEntries(Object.keys(request.questions)
      .map(key => [key, { type: "noul", noul: key.startsWith("noise") ? 0.98 : 0.05 }])) });
  });
  const first = await auditQualityPage(f.params);
  assert.equal(first.status, "partial");
  assert.equal(first.scanned, 4);
  assert.equal(first.next?.documentId, 4);
  assert.equal(f.curation.listTasks({ limit: 10 }).length, 4);
  assert.equal((await auditQualityPage({ ...f.params, after: first.next })).done, true);
  assert.equal(f.curation.listTasks({ limit: 10 }).length, 5);
  const task = f.curation.listTasks({ limit: 10 }).find(item => item.path === "hash-1.md")!;
  f.curation.updateTask({ id: task.id, status: "irrelevant" });
  f.db.prepare("UPDATE documents SET active = 0 WHERE hash = 'hash-1'").run();
  f.insert("changed noise", f.source.collection, "changed.md");
  await auditQualityPage(f.params);
  assert.equal(fetch.mock.callCount(), 4);
  assert.equal(f.curation.listTasks({ limit: 10 }).length, 5);
});

test("an inbox write failure never advances past unfinished work", async t => {
  const f = await fixture(); t.after(f.close);
  f.insert("noise one"); f.insert("noise two");
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: {
    noise_0: { type: "noul", noul: 1 }, evidence_0: { type: "noul", noul: 0 },
    noise_1: { type: "noul", noul: 1 }, evidence_1: { type: "noul", noul: 0 },
  } }));
  const original = f.curation.addTask.bind(f.curation);
  let calls = 0;
  t.mock.method(f.curation, "addTask", (candidate: Parameters<CurationStore["addTask"]>[0]) => {
    if (++calls === 2) throw new Error("inbox unavailable");
    return original(candidate);
  });
  const first = await auditQualityPage(f.params);
  assert.equal(first.status, "partial");
  assert.equal(first.next?.documentId, 1);
  const resumed = await auditQualityPage({ ...f.params, after: first.next });
  assert.equal(resumed.done, true);
  assert.equal(f.curation.listTasks().length, 2);
});
