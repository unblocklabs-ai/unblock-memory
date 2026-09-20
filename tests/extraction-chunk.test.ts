import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readExtractionPage, type ExtractionPage } from "../src/extraction-source.js";
import { extractionHistory, readExtractionChunk } from "../src/extraction-chunk.js";
import { EXTRACTION_INPUT_LIMIT, EXTRACTION_INPUT_TARGET, extractionMessageTokens, extractionOverhead, type ExtractionMessage } from "../src/extraction-model.js";
import { ExtractionStore, type ExtractionSession } from "../src/extraction-store.js";
import { resolveConfig } from "../src/config.js";
import { runExtraction } from "../src/extraction-worker.js";

const session: ExtractionSession = { sessionId: "s1", sessionKey: "agent:main:slack:channel:test", chatType: "channel", startedAt: 1 };
const message = (id: string, text = id): ExtractionMessage => ({ id, text, speaker: "Bek", role: "user", timestamp: 1000 });
function fixture(pages: ExtractionMessage[][], toolPages = new Set<number>()): typeof readExtractionPage {
  return async (_a, _n, _s, cursor) => {
    const index = cursor ? Number(cursor) : 0;
    return { kind: "page", cursor: String(Math.min(index + 1, pages.length)), hasMore: index + 1 < pages.length,
      entryCount: toolPages.has(index) ? 40 : (pages[index]?.length ?? 0), messages: pages[index] ?? [] };
  };
}
function params(readPage: typeof readExtractionPage, cursor: string | null = null, context: ExtractionMessage[] = []) {
  return { agentId: "main", agentName: "Bill", session, cursor, context, existing: [], signal: AbortSignal.timeout(30_000), readPage };
}

test("reader uses maxMessages and expands oversized SDK entries before filtering tools", async () => {
  const reads: number[] = [];
  const result = await readExtractionPage("main", "Bill", session, null, async input => {
    assert.equal(input.maxMessages, 40); assert.equal("maxEvents" in input, false);
    reads.push(input.maxBytes);
    if (reads.length === 1) return { kind: "page", cursor: "initial", hasMore: true, entries: [], requiredBytes: 2_000_000 };
    return { kind: "page", cursor: "end", hasMore: false, entries: [
      { entryId: "tool", createdAt: "2026-09-01", message: { role: "toolResult", content: "x".repeat(100_000) } },
      { entryId: "human", createdAt: "2026-09-01", message: { role: "user", content: "My favorite color is red." } },
      { entryId: "assistant", createdAt: "2026-09-01", message: { role: "assistant", content: [
        { type: "thinking", thinking: "private" }, { type: "toolCall", name: "exec" }, { type: "text", text: "Understood." },
      ] } },
    ] };
  });
  assert.deepEqual(reads, [1_000_000, 2_000_000]);
  assert.equal(result.kind, "page");
  if (result.kind === "page") assert.deepEqual(result.messages.map(m => m.text), ["My favorite color is red.", "Understood."]);
  await assert.rejects(readExtractionPage("main", "Bill", session, null, async () => ({
    kind: "page", cursor: "initial", hasMore: true, entries: [], requiredBytes: 65 * 1024 * 1024,
  })), /host read capacity/);
});

test("collects a complete small conversation across tool-only SDK pages", async () => {
  const result = await readExtractionChunk(params(fixture([[message("guess", "Blue?")], [], [message("correction", "No, red.")]], new Set([1]))));
  assert.equal(result.kind, "page");
  if (result.kind === "page") {
    assert.deepEqual(result.newIds, ["guess", "correction"]);
    assert.equal(result.cursor, "3"); assert.equal(result.fence, "3");
  }
});

test("large conversations resume inside SDK pages, preserving all messages with bounded overlap", async () => {
  const source = Array.from({ length: 8 }, (_, i) => message(String(i), " project".repeat(11_000)));
  const readPage = fixture([source]);
  const seen: string[] = []; let cursor: string | null = null, context: ExtractionMessage[] = [], chunks = 0;
  for (;;) {
    const result = await readExtractionChunk(params(readPage, cursor, context));
    assert.equal(result.kind, "page"); if (result.kind !== "page" || !result.newIds.length) break;
    assert.ok(extractionOverhead([]) + result.messages.reduce((n,m) => n + extractionMessageTokens(m), 0) <= EXTRACTION_INPUT_LIMIT);
    if (chunks) { assert.ok(result.messages[0]!.sourceMessageId); assert.ok(!result.newIds.includes(result.messages[0]!.id)); }
    seen.push(...result.newIds); cursor = result.cursor; context = extractionHistory(result.messages, 6); chunks++;
  }
  assert.ok(chunks > 1); assert.deepEqual(seen, source.map(m => m.id));
});

test("single oversized Unicode message splits losslessly and resumes through serialized checkpoints", async () => {
  const original = message("giant", " red🦊".repeat(25_000));
  const readPage = fixture([[original]]);
  let cursor: string | null = null, context: ExtractionMessage[] = [];
  const pieces: ExtractionMessage[] = [];
  for (let i = 0; i < 10; i++) {
    const result = await readExtractionChunk(params(readPage, cursor, context));
    assert.equal(result.kind, "page"); if (result.kind !== "page" || !result.newIds.length) break;
    pieces.push(...result.messages.filter(m => result.newIds.includes(m.id)));
    assert.ok(extractionOverhead([]) + result.messages.reduce((n,m) => n + extractionMessageTokens(m), 0) <= EXTRACTION_INPUT_LIMIT);
    cursor = JSON.parse(JSON.stringify(result.cursor)); context = extractionHistory(result.messages, 6);
  }
  assert.ok(pieces.length > 1); assert.equal(pieces.map(m => m.text).join(""), original.text);
  for (const piece of pieces) { assert.equal(piece.sourceMessageId, "giant"); assert.equal(Buffer.from(piece.text).toString(), piece.text); }
});

test("source rewrites discard a chunk collected across pages and partial bookmarks", async () => {
  const reset = { kind: "reset", cursor: "new-generation" } as const;
  const result = await readExtractionChunk(params(async (_a,_n,_s,cursor): Promise<ExtractionPage> => cursor
    ? reset : { kind: "page", cursor: "1", hasMore: true, entryCount: 1, messages: [message("one")] }));
  assert.deepEqual(result, reset);
  const big = fixture([[message("one", " project".repeat(EXTRACTION_INPUT_TARGET)), message("two")]]);
  const chunk = await readExtractionChunk(params(big)); assert.equal(chunk.kind, "page");
  if (chunk.kind !== "page") return;
  assert.ok(chunk.cursor.startsWith("unblock-extraction:"));
  assert.deepEqual(await readExtractionChunk(params(async () => reset, chunk.cursor)), reset);
  const resumed = await readExtractionChunk(params(async (a,n,s,c) => {
    const page = await big(a,n,s,c);
    // Rewrite races with a reread from null, but keeps the pending message unchanged.
    return page.kind === "page" && c === null ? { ...page, cursor: "new-generation-end" } : page;
  }, chunk.cursor));
  assert.equal(resumed.kind, "page");
  if (resumed.kind === "page") assert.equal(resumed.fence, chunk.fence);
});

test("partial-page append is safe, changed pending content is not silently consumed", async () => {
  const original = [message("one", " project".repeat(EXTRACTION_INPUT_TARGET)), message("two")];
  const first = await readExtractionChunk(params(fixture([original])));
  assert.equal(first.kind, "page"); if (first.kind !== "page") return;
  const appended = await readExtractionChunk(params(fixture([[...original, message("three")]]), first.cursor));
  assert.equal(appended.kind, "page");
  if (appended.kind === "page") assert.deepEqual(appended.newIds, ["two", "three"]);
  await assert.rejects(readExtractionChunk(params(fixture([[original[0]!, message("two", "rewritten")]]), first.cursor)), /source changed/);
});

test("TypeSafe failure cannot commit earlier accepted facts or advance a collected chunk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extraction-validation-retry-")), storePath = join(dir, "memory.sqlite");
  const config = resolveConfig({ typesafe: { apiKey: "test" }, corpora: [
    { name: "memory", kind: "files", paths: ["memory/**/*.md"] }, { name: "sessions", kind: "sessions", chatTypes: ["channel"] },
  ], extraction: { enabled: true, chatTypes: ["channel"], intervalMinutes: 0 } });
  let fail = true;
  const opts = { config, storePath, runtime: {}, agentId: "main", agentName: "Bill", sessions: () => [session], since: 0,
    signal: AbortSignal.timeout(30_000), readPage: fixture([[message("one")], [message("two")]]),
    extract: async (_r: unknown, _a: string, messages: ExtractionMessage[]) => messages.map(m => ({
      text: m.text, replaces: null, evidence: [{ messageId: m.id, quote: m.text }],
    })),
    validate: async ({ proposal }: { proposal: { text: string } }) => {
      if (fail && proposal.text === "two") throw new Error("API unavailable");
      return { accepted: true, reason: "judged" as const, scores: { supported: 1, useful: 1, replacement: 1 }, thresholds: resolveConfig(undefined).extraction };
    },
  };
  assert.equal((await runExtraction(opts)).failed, 1);
  const store = new ExtractionStore(storePath);
  try { assert.equal(store.checkpoint(session).cursor, null); assert.deepEqual(store.records(), []); }
  finally { store.close(); }
  fail = false; assert.equal((await runExtraction(opts)).accepted, 2);
});

test("worker retries whole chunks, isolates sessions, maps split citations, and makes zero unchanged calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extraction-chunks-")), storePath = join(dir, "memory.sqlite");
  const config = resolveConfig({ typesafe: { apiKey: "test" }, corpora: [
    { name: "memory", kind: "files", paths: ["memory/**/*.md"] },
    { name: "sessions", kind: "sessions", chatTypes: ["channel"] },
  ], extraction: { enabled: true, chatTypes: ["channel"], intervalMinutes: 0 } });
  const other = { ...session, sessionId: "s2" };
  const source = fixture([[message("original", " red".repeat(55_000))]]);
  let fail = true, calls = 0;
  const opts = { config, storePath, agentId: "main", agentName: "Bill", runtime: {}, since: 0,
    sessions: () => [session, other], signal: AbortSignal.timeout(60_000),
    readPage: (async (a,n,s,c) => s.sessionId === "s1" ? source(a,n,s,c) : fixture([[message("other")]])(a,n,s,c)) as typeof readExtractionPage,
    extract: async (_r: unknown, _a: string, messages: ExtractionMessage[], ids: string[]) => {
      calls++; if (fail) throw new Error("inference failed");
      assert.ok(!messages.some(m => m.id === "other") || messages.length === 1);
      const m = messages.find(m => ids.includes(m.id))!;
      return [{ text: m.id === "other" ? "Other fact." : "Bek likes red.", replaces: null, evidence: [{ messageId: m.id, quote: m.text.slice(0, 4) }] }];
    },
    validate: async () => ({ accepted: true, reason: "judged" as const, scores: { supported: 1, useful: 1, replacement: 1 }, thresholds: resolveConfig(undefined).extraction }),
  };
  assert.equal((await runExtraction(opts)).failed, 2);
  const failed = new ExtractionStore(storePath); assert.equal(failed.checkpoint(session).cursor, null); failed.close();
  fail = false;
  for (let i = 0; i < 4; i++) { const r = await runExtraction(opts); assert.equal(r.failed, 0); if (!r.processed) break; }
  const before = calls; assert.equal((await runExtraction(opts)).unchanged, 2); assert.equal(calls, before);
  const store = new ExtractionStore(storePath);
  try { assert.equal(store.records().length, 2); assert.equal(store.records("s1")[0]!.evidence[0]!.messageId, "original"); }
  finally { store.close(); }
});
