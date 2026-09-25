import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createStore } from "@unblocklabs/qmd";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";
import { collectSearches, type SearchCase } from "../eval/memory-ranking/cases.js";
import { blindCase, fusePassages, retrieve } from "../eval/memory-ranking/ranking.js";
import { analyze, type Label } from "../eval/memory-ranking/analyze.js";

test("extracts actual active root-chat searches with frozen pre-turn context, not tool results or later answers", () => {
  const root = mkdtempSync(join(tmpdir(), "memory-ranking-test-")), path = join(root, "agent.sqlite");
  const db = createAgentDatabase(path);
  try {
    insertSession(db, { sessionId: "s", chatType: "direct" });
    const events = [
      { role: "user", content: "Rico is my colleague." },
      { role: "assistant", content: [{ type: "text", text: "Understood." }] },
      { role: "user", content: "Where does he live?", __openclaw: {
        upstreamUserText: "Injected old whisperer\nConversation info: ⟦openclaw:ctx⟧\nFAKE MEMORY" } },
      { role: "assistant", content: [{ type: "thinking", thinking: "secret reasoning" },
        { type: "toolCall", id: "call1", name: "memory_search", arguments: { query: "Rico location" } }] },
      { role: "toolResult", content: [{ type: "text", text: "ANSWER ALREADY RETURNED" }] },
      { role: "assistant", content: [{ type: "text", text: "INTERMEDIATE ANSWER" },
        { type: "toolCall", id: "call2", name: "memory_search", arguments: { query: "Rico Brussels" } }] },
      { role: "assistant", content: "FUTURE ANSWER" },
    ];
    events.forEach((message, i) => {
      db.prepare("INSERT INTO transcript_events VALUES ('s',?,?,?)").run(i + 1, JSON.stringify({ type: "message", message }), 1000 + i);
      db.prepare("INSERT INTO session_transcript_active_events VALUES ('s',?,?,?)").run(i, i + 1, i);
    });
    db.prepare("INSERT INTO transcript_events VALUES ('s',99,?,999999)").run(JSON.stringify({ type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "memory_search", arguments: { query: "ARCHIVED" } }] } }));
    const cases = collectSearches(path, "main", 2, 5);
    assert.deepEqual(cases.map(c => c.query), ["Rico Brussels", "Rico location"]);
    assert.deepEqual(cases[0]!.conversation, { currentRequest: "Where does he live?", history: [
      { role: "user", content: "Rico is my colleague." }, { role: "assistant", content: "Understood." }] });
    assert.deepEqual(cases[0]!.conversation, cases[1]!.conversation);
    assert.doesNotMatch(JSON.stringify(cases), /secret reasoning|FUTURE|INTERMEDIATE|RETURNED|ARCHIVED|FAKE MEMORY/);
    assert.equal(collectSearches(path, "main", 1, 0)[0]!.conversation!.history.length, 0);
  } finally { db.close(); }
});

test("real BM25 plus vector union retains raw method scores, uses actual QMD RRF, and exports blinded evidence", async t => {
  const qmd = await createStore({ dbPath: ":memory:", config: { collections: { memory: { path: "/tmp", pattern: "*.md" } } } });
  try {
    const bodies = ["Rico lives in Brussels.", "Rico is an engineer."];
    bodies.forEach((body, i) => {
      qmd.internal.insertContent(`hash${i}`, body, "2026-01-01");
      qmd.internal.insertDocument("memory", `${i}.md`, "Rico", `hash${i}`, "2026-01-01", "2026-01-01");
    });
    t.mock.method(qmd, "searchVector", async (...[_query, options]: Parameters<typeof qmd.searchVector>) => {
      assert.deepEqual(options, { limit: 10, collection: ["memory"] });
      return bodies.map((body, i) => ({ filepath: `qmd://memory/${i}.md`, body, chunkPos: 0, chunkLen: body.length,
        score: 0.9 - i / 10 }));
    });
    const item: SearchCase = { id: "c", sessionId: "s", sessionKey: "s", chatType: "direct", eventSeq: 4,
      callId: "t", query: "Rico Brussels", searchedAt: "2026-09-24T00:00:00Z", userEventSeq: 3,
      conversation: { currentRequest: "Where does Rico live?", history: [] } };
    const result = await retrieve(qmd, item, new Map([["memory", "memory"]]));
    assert.equal(result.hits.length, 2);
    const first = result.hits.find(h => h.source.endsWith("/0.md"))!;
    assert.equal(first.vector_score, 0.9); assert.equal(first.vector_rank, 1);
    assert.ok(first.bm25_score! < 0); assert.equal(first.bm25_rank, 1);
    assert.equal(first.rrf_score, 2 / 61 + 0.05); assert.equal(first.rrf_rank, 1);
    const blind = blindCase(item, result.hits);
    assert.equal(blind.passages.length, 2);
    assert.ok(blind.passages.every(h => Object.keys(h).every(k => ["id", "source", "lines", "body", "messageTimestamp"].includes(k))));
    assert.equal("query" in blind, false);
    const labels: Label[] = result.hits.map(h => ({ caseId: "c", hitId: h.id, grade: h === first ? 3 : 0, reason: "fixture", uncertain: false }));
    const scored = { ...item, hits: result.hits.map(h => ({ ...h, typesafe_score: h === first ? 0.9 : 0.1, typesafe_status: "complete" })) };
    const summary = analyze([scored], labels);
    assert.equal(summary.allCandidates.perQuery.typesafe!.ndcgAt2, 1);
    assert.equal(summary.allCandidates.perQuery.rrf!.ndcgAt2, 1);
    const tied = { ...scored, hits: scored.hits.map((h, i) => ({ ...h, id: i ? "a" : "z",
      typesafe_score: 0.8, rrf_score: 0.05, rrf_rank: i + 1 })) };
    const tiedSummary = analyze([tied], tied.hits.map(h => ({ caseId: "c", hitId: h.id,
      grade: 2, reason: "tie fixture", uncertain: false })));
    assert.deepEqual(tiedSummary.allCandidates.cases[0]!.scores.rrf!.topHitIds, ["z", "a"]);
    assert.deepEqual(tiedSummary.allCandidates.cases[0]!.scores.typesafe!.topHitIds, ["z", "a"]);
    assert.throws(() => analyze([scored], labels.slice(1)), /Incomplete/);
    assert.throws(() => analyze([scored], [...labels, labels[0]!]), /duplicate/);
    const api = await import(new URL("./store.js", import.meta.resolve("@unblocklabs/qmd")).href);
    const fused = fusePassages([0, 1].map(i => ({ file: "qmd://same/file", body: "unused", bestChunk: `passage ${i}`,
      bestChunkPos: i, score: 1, explain: { methods: ["vector"] }, vector: { score: 0.9, rank: i + 1 } })), api.reciprocalRankFusion);
    assert.equal(fused.size, 2, "RRF must not collapse distinct passages just because they share a source");
    const dated = await retrieve(qmd, { ...item, userTimestamp: "2026-09-24T00:00:00.500Z" },
      new Map([["memory", "sessions"]]), new Map(bodies.map((body, i) => [`${i}.md`, {
        projectionHash: i ? "mismatched-index-revision" : createHash("sha256").update(body).digest("hex"),
        messages: [{ type: "assistant" as const, name: "Bill", timestamp: "2026-09-24 00:00:00 UTC",
          start: 0, bodyStart: 0, end: body.length }],
      }])));
    assert.equal(dated.hits.find(h => h.source.endsWith("/0.md"))!.temporal, "at_or_after_request",
      "exact projection spans and the entire cutoff second take precedence over Markdown parsing");
    const mismatched = dated.hits.find(h => h.source.endsWith("/1.md"))!;
    assert.equal(mismatched.temporal, "undated_or_unverified");
    assert.equal(mismatched.messageTimestamp, undefined);
  } finally { await qmd.close(); }
});
