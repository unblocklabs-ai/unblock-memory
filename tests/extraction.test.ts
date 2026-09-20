import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createStore } from "@unblocklabs/qmd";
import { resolveConfig } from "../src/config.js";
import { extractWithLuna, validateExtractedMemory, type ExtractionMessage, type MemoryProposal } from "../src/extraction-model.js";
import { ExtractionStore, type ExtractionSession } from "../src/extraction-store.js";
import { runExtraction } from "../src/extraction-worker.js";
import type { ExtractionPage } from "../src/extraction-source.js";
import { EXTRACTED_COLLECTION, extractedPath, syncExtractedIndex } from "../src/extraction-index.js";
import { QmdMemoryManager } from "../src/manager.js";
import { resolveSource } from "../src/sources.js";

const session: ExtractionSession = { sessionId: "s1", sessionKey: "agent:main:slack:channel:test", chatType: "channel", startedAt: 1 };
const messages: ExtractionMessage[] = [{ id: "m1", speaker: "Bek", role: "user", text: "My favorite color is red.", timestamp: 1000 }];
const proposal: MemoryProposal = { text: "Bek's favorite color is red.", replaces: null, evidence: [{ messageId: "m1", quote: messages[0]!.text }] };
const config = (extra: object = {}) => resolveConfig({
  corpora: [{ name: "memory", kind: "files", paths: ["memory/**/*.md"] }, { name: "sessions", kind: "sessions", chatTypes: ["channel"] }],
  typesafe: { apiKey: "test-key" }, extraction: { enabled: true, chatTypes: ["channel"], intervalMinutes: 0 }, ...extra });
const signal = () => new AbortController().signal;
const thresholds = config().extraction;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "extracted-memory-test-"));
  return { dir, storePath: join(dir, "unblock-memory.sqlite") };
}
function page(cursor: string, entries = messages): ExtractionPage {
  return { kind: "page", cursor, messages: entries, hasMore: false, entryCount: entries.length };
}

test("extraction defaults off; approval must be a configured session subset", () => {
  assert.equal(resolveConfig(undefined).extraction.enabled, false);
  assert.equal(config().extraction.publish, false);
  assert.throws(() => config({ extraction: { enabled: true } }), /explicit/);
  assert.throws(() => config({ extraction: { enabled: true, chatTypes: ["direct"] } }), /subset/);
  assert.throws(() => config({ extraction: { maxBatches: 100 } }), /maxBatches/);
  assert.equal(thresholds.minSupport, 0.9);
  for (const key of ["minSupport", "minRetention", "minReplacement"]) {
    for (const value of [-0.1, 1.1, NaN, "0.9"]) assert.throws(() => config({ extraction: { [key]: value } }), new RegExp(key));
  }
});

test("Luna invocation requires isolated model identity and strict JSON; no model fallback", async () => {
  let called = 0;
  const runtime = { llm: { async complete(input: { model: string; execution: { mode: string }; messages: unknown[] }) {
    called++; assert.equal(input.model, "openai/gpt-5.6-luna"); assert.equal(input.execution.mode, "isolated-agent-runtime");
    assert.equal(input.messages.length, 1);
    return { text: JSON.stringify({ memories: [proposal] }), model: "gpt-5.6-luna", execution: input.execution };
  } } };
  assert.deepEqual(await extractWithLuna(runtime, "main", messages, ["m1"], [], signal()), [proposal]);
  assert.equal(called, 1);
  await assert.rejects(extractWithLuna({}, "main", messages, [], [], signal()), /runtime/);
  await assert.rejects(extractWithLuna({ llm: { complete: async () => ({ text: "{}", model: "gpt-6-astra", execution: { mode: "direct-provider" } }) } }, "main", messages, [], [], signal()), /isolated Luna/);
});

test("missing quotes, unknown replacement ids and context-only citations never reach TypeSafe", async t => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("invalid evidence must not be sent"); });
  for (const p of [{ ...proposal, evidence: [{ messageId: "m1", quote: "blue" }] }, { ...proposal, replaces: "unknown" }, proposal]) {
    const result = await validateExtractedMemory({ proposal: p, messages, newIds: p === proposal ? [] : ["m1"], existing: [], apiKey: "test", signal: signal(), thresholds });
    assert.equal(result.accepted, false); assert.equal(result.reason, "invalid_evidence");
  }
});

test("all three validation dimensions must meet the gate; malformed responses fail closed", async t => {
  let support = 0.98, useful = 0.98, replacement = 0.98;
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: { supported: { type: "choice", choice: "supported", probabilities: { supported: support, unsupported: 1-support, contradicted: 0 } },
    ...Object.fromEntries(Object.entries({ useful, replacement }).map(([k,noul]) => [k,{ type: "noul", noul }])) } }));
  const params = { proposal: { ...proposal, replaces: "prior" }, messages, newIds: ["m1"], existing: [{ id: "prior", text: "Bek likes blue." }], apiKey: "test", signal: signal(), thresholds };
  assert.equal((await validateExtractedMemory(params)).accepted, true);
  useful = 0.89; assert.equal((await validateExtractedMemory(params)).accepted, false);
  assert.equal((await validateExtractedMemory({ ...params, thresholds: { ...thresholds, minRetention: 0.85 } })).accepted, true);
  useful = 0.98; support = 0.89; assert.equal((await validateExtractedMemory(params)).accepted, false);
  support = 0.98; replacement = 0.5; assert.equal((await validateExtractedMemory(params)).accepted, false);
  assert.equal((await validateExtractedMemory({ ...params, thresholds: { ...thresholds, minReplacement: 0.5 } })).accepted, true);
  support = 0.8;
  assert.equal((await validateExtractedMemory({ ...params, thresholds: { ...thresholds, minSupport: 0.8, minReplacement: 0.5 } })).accepted, true);
  assert.equal((await validateExtractedMemory({ ...params, thresholds: { ...thresholds, minRetention: 0.1 } })).accepted, false);
  replacement = NaN; await assert.rejects(validateExtractedMemory(params), /Invalid extraction validation/);
});

test("citations preserve source formatting; separated spans must be separate quotes", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ answers: {
      supported: { type: "choice", choice: "supported", probabilities: { supported: 0.99, unsupported: 0.01, contradicted: 0 } },
      useful: { type: "noul", noul: 0.99 },
    } });
  });
  const source = [{ ...messages[0]!, text: "Classify by *effect*, not verb.\n\nSearch via POST is still a read." }];
  const input = { messages: source, newIds: ["m1"], existing: [], apiKey: "test", signal: signal(), thresholds };
  const fact = { ...proposal, text: "The classifier uses effect, not verb; POST search can be read." };
  for (const quote of ["Classify by effect, not verb.", "Classify by *effect*, not verb. Search via POST is still a read."]) {
    assert.equal((await validateExtractedMemory({ ...input, proposal: { ...fact, evidence: [{ messageId: "m1", quote }] } })).reason, "invalid_evidence");
  }
  assert.equal(calls, 0);
  assert.equal((await validateExtractedMemory({ ...input, proposal: { ...fact, evidence: [
    { messageId: "m1", quote: "Classify by *effect*, not verb." },
    { messageId: "m1", quote: "Search via POST is still a read." },
  ] } })).accepted, true);
  assert.equal(calls, 1);
});

test("commit is atomic, deduplicated, versioned and fenced by checkpoint and lease", async () => {
  const f = await fixture(), store = new ExtractionStore(f.storePath);
  try {
    const owner = store.claim(false, 0)!; assert.ok(owner); assert.equal(store.claim(false, 0), undefined);
    store.checkpoint(session);
    const commit = { session, expected: null, cursor: "c1", context: messages, accepted: [{ proposal, observedAt: 1000, judgment: {} }], owner, version: "test" };
    store.commit(commit); const original = store.records()[0]!;
    assert.throws(() => store.commit(commit), /checkpoint/);
    store.commit({ ...commit, expected: "c1", cursor: "c2" }); assert.equal(store.records().length, 1);
    const replacement = { ...proposal, text: "Bek's favorite color is green.", replaces: original.id };
    assert.throws(() => store.commit({ ...commit, expected: "c2", cursor: "c3", accepted: [{ proposal: replacement, observedAt: 900, judgment: {} }] }), /stale/);
    assert.equal(store.checkpoint(session).cursor, "c2");
    store.commit({ ...commit, expected: "c2", cursor: "c3", accepted: [{ proposal: replacement, observedAt: 2000, judgment: {} }] });
    assert.equal(store.records()[0]!.revision, 2);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM extracted_memories").get()!.n, 2);
    store.reset(session.sessionId, "reset", owner); assert.deepEqual(store.records(), []);
    store.release(owner); assert.throws(() => store.renew(owner), /lease/);
    assert.equal(store.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { store.close(); }
});

test("missing TypeSafe key and disabled extraction do not open storage or call models", async () => {
  const f = await fixture();
  for (const cfg of [config({ typesafe: { apiKeyFile: join(f.dir, "absent") } }), resolveConfig(undefined)]) {
    const result = await runExtraction({ config: cfg, storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {},
      sessions: () => { assert.fail("must not scan source"); }, signal: signal() });
    assert.ok(["unavailable", "disabled"].includes(result.status)); assert.equal(existsSync(f.storePath), false);
  }
});

test("scheduled cadence survives reopening the store, while manual runs remain possible", async () => {
  const f = await fixture(), first = new ExtractionStore(f.storePath);
  const owner = first.claim(true, 3_600_000)!; assert.ok(owner); first.release(owner); first.close();
  const reopened = new ExtractionStore(f.storePath);
  try {
    assert.equal(reopened.claim(true, 3_600_000), undefined);
    const manual = reopened.claim(false, 3_600_000)!; assert.ok(manual); reopened.release(manual);
  } finally { reopened.close(); }
});

test("incremental worker skips unchanged pages, retries failures and never loses its cursor", async () => {
  const f = await fixture(); let calls = 0, fail = true;
  const opts = { config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {}, sessions: () => [session], since: 0, signal: signal(),
    readPage: async (_id: string, _name: string, _s: ExtractionSession, cursor: string | null) => cursor === "c1" ? page("c1", []) : page("c1"),
    extract: async () => { calls++; if (fail) throw new Error("private source must never leak into status"); return [proposal]; },
    validate: async () => ({ accepted: true, reason: "judged" as const, scores: { supported: 1, useful: 1, replacement: 1 }, thresholds: resolveConfig(undefined).extraction }) };
  assert.equal((await runExtraction(opts)).status, "completed");
  const check = new ExtractionStore(f.storePath); assert.equal(check.checkpoint(session).cursor, null); check.close();
  fail = false;
  assert.equal((await runExtraction(opts)).accepted, 1);
  const repeated = await runExtraction(opts); assert.equal(repeated.unchanged, 1); assert.equal(calls, 2);
  const nextMessage = { ...messages[0]!, id: "m2", timestamp: 2000, text: "I live in Brooklyn." };
  const next = await runExtraction({ ...opts,
    readPage: async (_id, _name, _s, cursor) => cursor === "c2" ? page("c2", []) : page("c2", [nextMessage]),
    extract: async () => { calls++; return [{ text: "Bek lives in Brooklyn.", replaces: null, evidence: [{ messageId: "m2", quote: nextMessage.text }] }]; },
  });
  assert.equal(next.accepted, 1); assert.equal(calls, 3);
  const store = new ExtractionStore(f.storePath); assert.equal(store.records().length, 2); assert.equal(store.checkpoint(session).cursor, "c2"); store.close();
});

test("rewrite during inference withdraws old evidence and discards the stale completion", async () => {
  const f = await fixture();
  const result = await runExtraction({ config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {}, sessions: () => [session], since: 0, signal: signal(),
    readPage: async (_id, _name, _s, cursor) => cursor === "c1" ? { kind: "reset", cursor: "new-generation" } : page("c1"),
    extract: async () => [proposal], validate: async () => ({ accepted: true, reason: "judged", scores: { supported: 1, useful: 1, replacement: 1 }, thresholds: resolveConfig(undefined).extraction }) });
  assert.equal(result.accepted, 0);
  const store = new ExtractionStore(f.storePath); assert.deepEqual(store.records(), []); assert.equal(store.checkpoint(session).cursor, "new-generation"); store.close();
});

test("single-session run does not withdraw another eligible session's memories", async () => {
  const f = await fixture(), store = new ExtractionStore(f.storePath), other = { ...session, sessionId: "s2" };
  const owner = store.claim(false, 0)!; store.checkpoint(other);
  store.commit({ session: other, expected: null, cursor: "c1", context: [], accepted: [{ proposal, observedAt: 1000, judgment: {} }], owner, version: "test" });
  store.release(owner); store.close();
  await runExtraction({ config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {},
    sessions: () => [session, other], sessionId: "s1", since: 0, signal: signal(), readPage: async () => page("c1", []) });
  const reopened = new ExtractionStore(f.storePath); assert.equal(reopened.records("s2").length, 1); reopened.close();
});

test("scheduled run resumes an approved historical backfill rather than skipping unfinished history", async () => {
  const f = await fixture(); let calls = 0;
  const opts = { config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {}, sessions: () => [session], signal: signal(),
    readPage: async (_id: string, _name: string, _s: ExtractionSession, cursor: string | null) =>
      cursor === null ? page("c1", [{ ...messages[0]!, id: "context", text: "Hello" }]) : cursor === "c1" ? page("c2") : page("c2", []),
    extract: async (_r: unknown, _a: string, _m: ExtractionMessage[], newIds: string[]) => { calls++; return newIds.includes("m1") ? [proposal] : []; },
    validate: async () => ({ accepted: true, reason: "judged" as const, scores: { supported: 1, useful: 1, replacement: 1 }, thresholds: resolveConfig(undefined).extraction }) };
  await runExtraction({ ...opts, since: 0 });
  const next = await runExtraction({ ...opts, scheduled: true });
  assert.equal(next.accepted, 1); assert.equal(calls, 2);
  const store = new ExtractionStore(f.storePath); assert.equal(store.checkpoint(session).since, 0); store.close();
});

test("QMD projection and authoritative reads reject withdrawn versions without a Markdown file", async () => {
  const f = await fixture(), store = new ExtractionStore(f.storePath), owner = store.claim(false, 0)!;
  store.checkpoint(session);
  store.commit({ session, expected: null, cursor: "c1", context: messages, accepted: [{ proposal, observedAt: 1000, judgment: {} }], owner, version: "test" });
  const qmd = await createStore({ dbPath: join(f.dir, "index.sqlite"), config: { collections: { [EXTRACTED_COLLECTION]: { path: f.dir, pattern: ".no-files" } } } });
  const manager = new QmdMemoryManager({ dbPath: qmd.dbPath, curationPath: f.storePath, workspaceDir: f.dir,
    sources: [resolveSource(f.dir, "memory", "memory")], extraction: { ...config().extraction, publish: true }, storeFactory: async () => qmd });
  try {
    await syncExtractedIndex({ internal: qmd.internal, embed: async () => ({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }) }, store.records());
    const path = `qmd://${EXTRACTED_COLLECTION}/${extractedPath(store.records()[0]!)}`;
    assert.equal((await manager.readFile({ relPath: path })).status, "ok");
    const hits = await manager.search("red", { lexicalOnly: true, corpora: ["extracted"] });
    assert.equal(hits.length, 1); assert.equal(hits[0]!.snippet, proposal.text);
    assert.deepEqual(await manager.search("red", { lexicalOnly: true, corpora: ["extracted"], sessionFilter: { chatType: "direct" } }), []);
    store.reset(session.sessionId, null, owner);
    assert.equal((await manager.readFile({ relPath: path })).status, "not_found");
    assert.deepEqual(await manager.search("red", { lexicalOnly: true, corpora: ["extracted"] }), []);
    await assert.rejects(syncExtractedIndex({ internal: qmd.internal,
      embed: async () => ({ docsProcessed: 1, chunksEmbedded: 0, errors: 1, durationMs: 0 }) }, []), /failed to embed/);
  } finally { store.close(); await manager.close(); }
});

test("extracted facts survive manager startup and ordinary file sync", async () => {
  const f = await fixture(), store = new ExtractionStore(f.storePath), owner = store.claim(false, 0)!;
  const dbPath = join(f.dir, "index.sqlite");
  store.checkpoint(session);
  store.commit({ session, expected: null, cursor: "c1", context: [], accepted: [{ proposal, observedAt: 1000, judgment: {} }], owner, version: "test" });
  const qmd = await createStore({ dbPath, config: { collections: { [EXTRACTED_COLLECTION]: { path: f.dir, pattern: ".no-extracted-files", includeByDefault: false } } } });
  await syncExtractedIndex({ internal: qmd.internal, embed: async () => ({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }) }, store.records());
  // Avoid downloading a model: this regression is about document lifecycle, not embeddings.
  qmd.internal.db.prepare("INSERT OR REPLACE INTO store_config(key,value) VALUES('embedding_chunk_strategy','semantic')").run();
  await qmd.close();
  const manager = new QmdMemoryManager({ dbPath, curationPath: f.storePath, workspaceDir: f.dir,
    sources: [resolveSource(f.dir, "memory", "memory")], extraction: { ...config().extraction, publish: true } });
  try {
    assert.equal((await manager.search("red", { lexicalOnly: true, corpora: ["extracted"] })).length, 1);
    // No new files: sync must not treat DB-projected facts as missing Markdown.
    await manager.sync();
    assert.equal((await manager.search("red", { lexicalOnly: true, corpora: ["extracted"] })).length, 1);
  } finally { await manager.close(); store.close(); }
});
