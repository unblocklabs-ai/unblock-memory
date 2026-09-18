import assert from "node:assert/strict";
import test from "node:test";
import { qualityTaskPresence, qualityTriage } from "../src/quality-triage.js";
import { chunkFingerprint } from "../src/curation.js";
import { reviewFixture } from "./helpers/review-store.js";
import { WhispererDiagnostics } from "../src/diagnostics.js";

test("triage prioritizes evidence-preserving repairs, keeps ambiguity and does not require a new judge", async t => {
  assert.equal(qualityTriage(0.99, 0.99), "preserve_evidence_repair");
  assert.equal(qualityTriage(0.99, 0.01), "inspect_scaffolding");
  assert.equal(qualityTriage(0.99, 0.5), "context_review");
  assert.equal(qualityTriage(0.1, 0.99), "context_review");
  assert.equal(qualityTriage(0.1, 0.99, true), "preserve_evidence_repair");
  const f = await reviewFixture(); t.after(f.close);
  const note = await f.insert("valuable evidence buried in a wrapper");
  const base = { type: "quality_review" as const, corpus: "memory", collection: f.source.collection, path: note.path, reason: "possible_ingestion_noise" };
  const low = f.curation.addTask({ ...base, contentFingerprint: "old", detail: JSON.stringify({ noise: 0.99, evidence: 0.01 }) });
  const high = f.curation.addTask({ ...base, contentFingerprint: chunkFingerprint(note.text), detail: JSON.stringify({ noise: 0.99, evidence: 0.99 }) });
  assert.equal(f.curation.listTasks()[0].id, high.id);
  assert.equal(qualityTaskPresence(f.db, high), "present_in_index");
  assert.equal(qualityTaskPresence(f.db, low), "not_present_in_index");
  f.db.prepare("UPDATE content_vectors SET chunk_len = 4").run();
  assert.equal(qualityTaskPresence(f.db, high), "not_present_in_index");
  assert.equal(f.curation.listTasks().every(task => task.status === "pending"), true);
  f.curation.updateTask({ id: high.id, status: "irrelevant" });
  assert.equal(f.curation.listTasks({ status: "irrelevant" })[0].id, high.id);
});

test("diagnostic snapshots are isolated, bounded and detached from live counters", () => {
  const diagnostics = new WhispererDiagnostics();
  diagnostics.record("first", "skill", "missing_key");
  const copy = diagnostics.snapshot("first");
  copy.skill.missing_key = 900;
  assert.equal(diagnostics.snapshot("first").skill.missing_key, 1);
  assert.deepEqual(diagnostics.snapshot("other").skill, {});
  for (let i = 0; i < 100; i++) diagnostics.record(`agent-${i}`, "memory", "emitted");
  assert.deepEqual(diagnostics.snapshot("first").skill, {});
  assert.equal(diagnostics.snapshot("agent-99").memory.emitted, 1);
});

test("presence reads one document per listing, retains UTF-16 offsets and does not cache across listings", async t => {
  const f = await reviewFixture(); t.after(f.close);
  const chunks = Array.from({ length: 200 }, (_, i) => `🚀 ${i} ${"x".repeat(990)}\n`);
  const note = await f.insert(chunks.join(""));
  f.db.prepare("DELETE FROM content_vectors WHERE hash = ?").run(note.hash);
  const insert = f.db.prepare("INSERT INTO content_vectors(hash, seq, pos, chunk_len, model, embedded_at) VALUES (?, ?, ?, ?, 'model', 'now')");
  let pos = 0;
  chunks.forEach((text, seq) => { insert.run(note.hash, seq, pos, text.length); pos += text.length; });
  const base = { type: "quality_review" as const, corpus: "memory", collection: f.source.collection, path: note.path, reason: "possible_ingestion_noise" };
  const first = f.curation.addTask({ ...base, contentFingerprint: chunkFingerprint(chunks[0]) });
  const last = f.curation.addTask({ ...base, contentFingerprint: chunkFingerprint(chunks[199]) });
  const prepare = f.db.prepare.bind(f.db);
  let documentReads = 0, offsetReads = 0;
  t.mock.method(f.db, "prepare", (sql: string) => {
    if (sql.includes("c.doc")) {
      documentReads++;
      assert.doesNotMatch(sql, /content_vectors/, "must not repeat document text per chunk");
    } else if (sql.includes("content_vectors")) offsetReads++;
    return prepare(sql);
  });
  const cache = new Map<string, Set<string>>();
  assert.equal(qualityTaskPresence(f.db, first, cache), "present_in_index");
  assert.equal(qualityTaskPresence(f.db, last, cache), "present_in_index");
  assert.equal(documentReads, 1);
  assert.equal(offsetReads, 1);
  f.db.prepare("DELETE FROM content_vectors WHERE hash = ? AND seq = 199").run(note.hash);
  assert.equal(qualityTaskPresence(f.db, last), "not_present_in_index");
  assert.equal(documentReads, 2);
});
