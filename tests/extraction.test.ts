import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createStore } from "@unblocklabs/qmd";
import { resolveConfig } from "../src/config.js";
import { extractWithLuna, validateExtractedMemory, type ExtractionMessage, type MemoryProposal } from "../src/extraction-model.js";
import { ExtractionLeaseLostError, ExtractionStore, type ExtractionSession } from "../src/extraction-store.js";
import { runExtraction } from "../src/extraction-worker.js";
import { readExtractionPage, type ExtractionPage } from "../src/extraction-source.js";
import { registerExtraction } from "../src/extraction-runtime.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { EXTRACTED_COLLECTION, extractedPath, syncExtractedIndex } from "../src/extraction-index.js";
import { QmdMemoryManager } from "../src/manager.js";
import { resolveSource } from "../src/sources.js";
import { extractionSessions } from "../src/extraction-source.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

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
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: { supported: { type: "choice", choice: "supported", confidence: support, probabilities: { supported: support, unsupported: 1-support, contradicted: 0 } },
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
  replacement = NaN; await assert.rejects(validateExtractedMemory(params), /invalid noul answer/i);
});

test("citations preserve source formatting; separated spans must be separate quotes", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ answers: {
      supported: { type: "choice", choice: "supported", confidence: 0.99, probabilities: { supported: 0.99, unsupported: 0.01, contradicted: 0 } },
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
    store.checkpoint(session, owner);
    const commit = { session, expected: null, cursor: "c1", context: messages, accepted: [{ proposal, observedAt: 1000, judgment: {} }], owner, version: "test" };
    store.commit(commit); const original = store.records()[0]!;
    assert.throws(() => store.commit(commit), /checkpoint/);
    store.commit({ ...commit, expected: "c1", cursor: "c2" }); assert.equal(store.records().length, 1);
    const replacement = { ...proposal, text: "Bek's favorite color is green.", replaces: original.id };
    assert.throws(() => store.commit({ ...commit, expected: "c2", cursor: "c3", accepted: [{ proposal: replacement, observedAt: 900, judgment: {} }] }), /stale/);
    assert.equal(store.checkpoint(session, owner).cursor, "c2");
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
  const check = new ExtractionStore(f.storePath); assert.equal(check.readCheckpoint(session.sessionId)?.cursor, null); check.close();
  fail = false;
  assert.equal((await runExtraction(opts)).accepted, 1);
  const repeated = await runExtraction(opts); assert.equal(repeated.unchanged, 1); assert.equal(calls, 2);
  const nextMessage = { ...messages[0]!, id: "m2", timestamp: 2000, text: "I live in Brooklyn." };
  const next = await runExtraction({ ...opts,
    readPage: async (_id, _name, _s, cursor) => cursor === "c2" ? page("c2", []) : page("c2", [nextMessage]),
    extract: async () => { calls++; return [{ text: "Bek lives in Brooklyn.", replaces: null, evidence: [{ messageId: "m2", quote: nextMessage.text }] }]; },
  });
  assert.equal(next.accepted, 1); assert.equal(calls, 3);
  const store = new ExtractionStore(f.storePath); assert.equal(store.records().length, 2); assert.equal(store.readCheckpoint(session.sessionId)?.cursor, "c2"); store.close();
});

test("completed source revisions skip delta reads, while appends, resets and broader backfills remain discoverable", async t => {
  const f = await fixture(), sourcePath = join(f.dir, "agent.sqlite"), db = createAgentDatabase(sourcePath);
  t.after(() => db.close());
  insertSession(db, { sessionId: "s1", chatType: "channel", message: { type: "message", message: { role: "user", content: messages[0]!.text } } });
  db.exec("ALTER TABLE session_windows ADD COLUMN updated_at INTEGER; ALTER TABLE session_windows ADD COLUMN transcript_updated_at INTEGER");
  let reads = 0, extractions = 0;
  const opts = { config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {}, signal: signal(), since: 1000,
    sessions: () => extractionSessions(sourcePath, "main", ["channel"]),
    readPage: async (_agent: string, _name: string, _session: ExtractionSession, cursor: string | null): Promise<ExtractionPage> => {
      reads++;
      const generation = String(db.prepare("SELECT generation FROM transcript_rewrite_watermarks").get()!.generation);
      if (cursor && !cursor.startsWith(generation + ":")) return { kind: "reset", cursor: generation + ":0" };
      const tail = Number(db.prepare("SELECT MAX(seq) tail FROM transcript_events").get()!.tail);
      const at = cursor ? Number(cursor.split(":").at(-1)) : 0;
      return { kind: "page", cursor: generation + ":" + tail, hasMore: false, entryCount: tail - at,
        messages: at < tail ? [{ ...messages[0]!, id: "m" + tail, timestamp: tail * 1000 }] : [] };
    }, extract: async () => { extractions++; return []; } };
  await runExtraction(opts);
  const afterFirst = reads;
  assert.equal(extractions, 1);
  await runExtraction(opts);
  assert.equal(reads, afterFirst, "an exhausted unchanged revision must not reopen its delta");
  db.prepare("INSERT INTO transcript_events VALUES('s1',2,?,4000)").run(JSON.stringify({ type: "message", message: { role: "user", content: "New message" } }));
  await runExtraction(opts);
  assert.equal(extractions, 2, "appends change the watermark and are processed");
  db.prepare("UPDATE transcript_rewrite_watermarks SET generation='rewritten'").run();
  await runExtraction(opts);
  await runExtraction(opts);
  assert.equal(extractions, 3, "a source reset must resume rather than mark the new branch complete");
  await runExtraction({ ...opts, since: 0 });
  assert.equal(extractions, 4, "broader explicit backfill invalidates the completed revision");
});

test("rewrite during inference withdraws old evidence and discards the stale completion", async () => {
  const f = await fixture();
  const result = await runExtraction({ config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {}, sessions: () => [session], since: 0, signal: signal(),
    readPage: async (_id, _name, _s, cursor) => cursor === "c1" ? { kind: "reset", cursor: "new-generation" } : page("c1"),
    extract: async () => [proposal], validate: async () => ({ accepted: true, reason: "judged", scores: { supported: 1, useful: 1, replacement: 1 }, thresholds: resolveConfig(undefined).extraction }) });
  assert.equal(result.accepted, 0);
  const store = new ExtractionStore(f.storePath); assert.deepEqual(store.records(), []); assert.equal(store.readCheckpoint(session.sessionId)?.cursor, "new-generation"); store.close();
});

test("single-session run does not withdraw another eligible session's memories", async () => {
  const f = await fixture(), store = new ExtractionStore(f.storePath), other = { ...session, sessionId: "s2" };
  const owner = store.claim(false, 0)!; store.checkpoint(other, owner);
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
  const store = new ExtractionStore(f.storePath); assert.equal(store.readCheckpoint(session.sessionId)?.since, 0); store.close();
});

test("QMD projection and authoritative reads reject withdrawn versions without a Markdown file", async t => {
  const f = await fixture(), store = new ExtractionStore(f.storePath), owner = store.claim(false, 0)!;
  store.checkpoint(session, owner);
  store.commit({ session, expected: null, cursor: "c1", context: messages, accepted: [{ proposal, observedAt: 1000, judgment: {} }], owner, version: "test" });
  const qmd = await createStore({ dbPath: join(f.dir, "index.sqlite"), config: { collections: { [EXTRACTED_COLLECTION]: { path: f.dir, pattern: ".no-files" } } } });
  const manager = new QmdMemoryManager({ dbPath: qmd.dbPath, curationPath: f.storePath, workspaceDir: f.dir,
    sources: [resolveSource(f.dir, "memory", "memory")], extraction: { ...config().extraction, publish: true }, storeFactory: async () => qmd });
  try {
    await syncExtractedIndex({ internal: qmd.internal, embed: async () => ({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }) }, store.records());
    const hash = createHash("sha256").update(proposal.text).digest("hex");
    const model = qmd.internal.llm!.embedModelName;
    qmd.internal.ensureVecTable(2);
    qmd.internal.insertEmbedding(hash, 0, 0, new Float32Array([1, 0]), model, "now", 1, undefined, proposal.text.length);
    t.mock.method(qmd.internal.llm!, "embed", async () => ({ embedding: [1, 0], model }));
    const path = `qmd://${EXTRACTED_COLLECTION}/${extractedPath(store.records()[0]!)}`;
    assert.equal((await manager.readFile({ relPath: path })).status, "ok");
    const hits = await manager.search("red", { corpora: ["extracted"] });
    assert.equal(hits.length, 1); assert.equal(hits[0]!.snippet, proposal.text);
    assert.deepEqual(await manager.search("red", { corpora: ["extracted"], sessionFilter: { chatType: "direct" } }), []);
    store.reset(session.sessionId, null, owner);
    assert.equal((await manager.readFile({ relPath: path })).status, "not_found");
    assert.deepEqual(await manager.search("red", { corpora: ["extracted"] }), []);
    await assert.rejects(syncExtractedIndex({ internal: qmd.internal,
      embed: async () => ({ docsProcessed: 1, chunksEmbedded: 0, errors: 1, durationMs: 0 }) }, []), /failed to embed/);
  } finally { store.close(); await manager.close(); }
});

test("extracted facts survive manager startup and ordinary file sync", async () => {
  const f = await fixture(), store = new ExtractionStore(f.storePath), owner = store.claim(false, 0)!;
  const dbPath = join(f.dir, "index.sqlite");
  store.checkpoint(session, owner);
  store.commit({ session, expected: null, cursor: "c1", context: [], accepted: [{ proposal, observedAt: 1000, judgment: {} }], owner, version: "test" });
  const qmd = await createStore({ dbPath, config: { collections: { [EXTRACTED_COLLECTION]: { path: f.dir, pattern: ".no-extracted-files", includeByDefault: false } } } });
  await syncExtractedIndex({ internal: qmd.internal, embed: async () => ({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }) }, store.records());
  // Avoid downloading a model: this regression is about document lifecycle, not embeddings.
  qmd.internal.db.prepare("INSERT OR REPLACE INTO store_config(key,value) VALUES('embedding_chunk_strategy','semantic')").run();
  await qmd.close();
  const manager = new QmdMemoryManager({ dbPath, curationPath: f.storePath, workspaceDir: f.dir,
    sources: [resolveSource(f.dir, "memory", "memory")], extraction: { ...config().extraction, publish: true } });
  try {
    await manager.start();
    const path = `qmd://${EXTRACTED_COLLECTION}/${extractedPath(store.records()[0]!)}`;
    assert.equal((await manager.readFile({ relPath: path })).status, "ok");
    // No new files: sync must not treat DB-projected facts as missing Markdown.
    await manager.sync();
    const indexed = await createStore({ dbPath });
    try { assert.equal(indexed.internal.getActiveDocumentPaths(EXTRACTED_COLLECTION).length, 1); }
    finally { await indexed.close(); }
  } finally { await manager.close(); store.close(); }
});

test("lost-lease fencing rejects checkpoint, error, and empty-page completion writes", async () => {
  const f = await fixture(), store = new ExtractionStore(f.storePath);
  try {
    const owner1 = store.claim(false, 0)!;
    store.checkpoint(session, owner1);
    store.error(session.sessionId, "prior_error", owner1);
    // Expire owner1's lease and let owner2 take ownership.
    store.db.prepare("UPDATE extraction_worker SET lease_until=0 WHERE id=1").run();
    const owner2 = store.claim(false, 0)!;
    assert.ok(owner2 && owner2 !== owner1);

    assert.throws(() => store.checkpoint({ ...session, sessionKey: "mutated" }, owner1, 0), ExtractionLeaseLostError);
    assert.throws(() => store.error(session.sessionId, "stale_error", owner1), ExtractionLeaseLostError);
    assert.throws(() => store.completeEmpty({ sessionId: session.sessionId, expected: null, owner: owner1, completeRevision: "rev-1" }), ExtractionLeaseLostError);

    // None of owner1's fenced writes mutated the session row.
    const state = store.readCheckpoint(session.sessionId)!;
    assert.equal(state.error, "prior_error");
    assert.equal(state.completeRevision, null);
    assert.notEqual(state.since, 0);

    // Worker-level: if lease is lost during inference/read, runExtraction fails with lease loss and does not clobber error.
    store.release(owner2);
  } finally { store.close(); }

  let stoleLease = false;
  await assert.rejects(runExtraction({
    config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {},
    sessions: () => [session], since: 0, signal: signal(),
    readPage: async () => {
      if (!stoleLease) {
        stoleLease = true;
        const thief = new ExtractionStore(f.storePath);
        try {
          thief.db.prepare("UPDATE extraction_worker SET lease_until=0 WHERE id=1").run();
          assert.ok(thief.claim(false, 0));
        } finally { thief.close(); }
      }
      return page("c1", []);
    },
  }), ExtractionLeaseLostError);

  const verify = new ExtractionStore(f.storePath);
  try {
    assert.equal(verify.readCheckpoint(session.sessionId)?.error, "prior_error");
  } finally { verify.close(); }
});

test("empty-page completion clears a prior session error and updates complete_revision", async () => {
  const f = await fixture();
  const s = { ...session, sourceRevision: '["g1",1]' };
  // First run fails with source_unavailable, setting session error.
  const first = await runExtraction({
    config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {},
    sessions: () => [s], since: 0, signal: signal(),
    readPage: async () => ({ kind: "unavailable" }),
  });
  assert.equal(first.status, "completed");
  assert.equal(first.failed, 1);
  let store = new ExtractionStore(f.storePath);
  try {
    assert.equal(store.readCheckpoint(s.sessionId)?.error, "source_unavailable");
  } finally { store.close(); }

  // Second run returns an empty exhausted page; error must be cleared and complete_revision recorded.
  let reads = 0;
  const second = await runExtraction({
    config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {},
    sessions: () => [s], since: 0, signal: signal(),
    readPage: async () => { reads++; return page("c1", []); },
  });
  assert.equal(second.status, "completed");
  assert.equal(second.unchanged, 1);
  assert.equal(reads, 1);
  store = new ExtractionStore(f.storePath);
  try {
    const state = store.readCheckpoint(s.sessionId)!;
    assert.equal(state.error, null);
    assert.ok(state.completeRevision);
  } finally { store.close(); }

  // Third run with same sourceRevision and policy skips without calling readPage.
  const third = await runExtraction({
    config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {},
    sessions: () => [s], since: 0, signal: signal(),
    readPage: async () => { reads++; return page("c1", []); },
  });
  assert.equal(third.unchanged, 1);
  assert.equal(reads, 1);
});

test("policy and prompt version changes invalidate complete_revision and re-scan cleanly", async () => {
  const f = await fixture();
  const s = { ...session, sourceRevision: '["g1",1]' };
  const m2: ExtractionMessage = { id: "m2", speaker: "Bek", role: "user", text: "I prefer dark roast coffee.", timestamp: 2000 };
  const p2: MemoryProposal = { text: "Bek prefers dark roast coffee.", replaces: null, evidence: [{ messageId: "m2", quote: m2.text }] };
  let reads = 0, extractions = 0;

  const makeOpts = (extraCfg: object = {}, version?: string) => ({
    config: config(extraCfg), storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {},
    sessions: () => [s], since: 0, signal: signal(), version,
    readPage: async (_id: string, _name: string, _s: ExtractionSession, cursor: string | null) => {
      reads++;
      return cursor === "c1" ? page("c1", []) : page("c1", [messages[0]!, m2]);
    },
    extract: async () => { extractions++; return [proposal, p2]; },
    validate: async ({ proposal: prop, thresholds: t }: { proposal: MemoryProposal; thresholds: { minSupport: number } }) => ({
      accepted: prop.text === proposal.text || t.minSupport <= 0.85,
      reason: "judged" as const,
      scores: { supported: prop.text === proposal.text ? 0.99 : 0.85, useful: 0.99, replacement: 1 },
      thresholds: config(extraCfg).extraction,
    }),
  });

  // Initial scan under default minSupport=0.9 accepts only proposal 1.
  const r1 = await runExtraction(makeOpts({}, "lasting-facts-v11"));
  assert.equal(r1.accepted, 1);
  assert.equal(extractions, 1);
  const readsAfter1 = reads;

  // Same policy & prompt version skips cleanly without reading delta.
  const r2 = await runExtraction(makeOpts({}, "lasting-facts-v11"));
  assert.equal(r2.unchanged, 1);
  assert.equal(reads, readsAfter1);

  // Lowering minSupport policy invalidates complete_revision, rewinds cursor, preserves existing fact, and extracts p2.
  const r3 = await runExtraction(makeOpts({ extraction: { enabled: true, chatTypes: ["channel"], intervalMinutes: 0, minSupport: 0.8 } }, "lasting-facts-v11"));
  assert.equal(r3.accepted, 1);
  assert.equal(extractions, 2);
  let store = new ExtractionStore(f.storePath);
  try { assert.equal(store.records().length, 2); } finally { store.close(); }

  // Changing prompt version invalidates complete_revision and triggers a clean re-scan.
  const r4 = await runExtraction(makeOpts({ extraction: { enabled: true, chatTypes: ["channel"], intervalMinutes: 0, minSupport: 0.8 } }, "lasting-facts-v12"));
  assert.equal(r4.processed, 1);
  assert.equal(extractions, 3);
  const readsAfter4 = reads;

  // Repeating under v12 skips again.
  const r5 = await runExtraction(makeOpts({ extraction: { enabled: true, chatTypes: ["channel"], intervalMinutes: 0, minSupport: 0.8 } }, "lasting-facts-v12"));
  assert.equal(r5.unchanged, 1);
  assert.equal(reads, readsAfter4);

  // Legacy plain-string complete_revision (pre-policy binding) also invalidates and re-scans cleanly.
  store = new ExtractionStore(f.storePath);
  try {
    store.db.prepare("UPDATE extraction_sessions SET complete_revision=? WHERE session_id=?").run('["g1",1]', s.sessionId);
  } finally { store.close(); }
  const r6 = await runExtraction(makeOpts({ extraction: { enabled: true, chatTypes: ["channel"], intervalMinutes: 0, minSupport: 0.8 } }, "lasting-facts-v12"));
  assert.equal(r6.processed, 1);
  assert.equal(extractions, 4);
});

test("multiple accepted proposals targeting the same predecessor pick one deterministic winner and reject store-level conflicts", async () => {
  const f = await fixture();
  // Seed initial memory revision 1.
  const store = new ExtractionStore(f.storePath);
  let priorId = "";
  try {
    const owner = store.claim(false, 0)!;
    store.checkpoint(session, owner, 0);
    store.commit({
      session, expected: null, cursor: "c1", context: messages,
      accepted: [{ proposal, observedAt: 1000, judgment: {} }], owner, version: "test",
    });
    priorId = store.records(session.sessionId)[0]!.id;

    // Direct store.commit must refuse two conflicting replacements for the same predecessor in one batch.
    const dupA: MemoryProposal = { text: "Bek's favorite color is green.", replaces: priorId, evidence: [{ messageId: "m2", quote: "green" }] };
    const dupB: MemoryProposal = { text: "Bek's favorite color is blue.", replaces: priorId, evidence: [{ messageId: "m3", quote: "blue" }] };
    assert.throws(() => store.commit({
      session, expected: "c1", cursor: "c2", context: messages,
      accepted: [
        { proposal: dupA, observedAt: 2000, judgment: {} },
        { proposal: dupB, observedAt: 3000, judgment: {} },
      ],
      owner, version: "test",
    }), /Conflicting memory replacement/);
    assert.equal(store.records(session.sessionId)[0]!.revision, 1);
    store.release(owner);
  } finally { store.close(); }

  // Worker batch with 2 accepted replacements targeting priorId picks the latest observedAt deterministically,
  // creating a single revision 2 (no intermediate revision 2 -> 3) and rejecting the competing proposal.
  const m2: ExtractionMessage = { id: "m2", speaker: "Bek", role: "user", text: "Actually I like green now.", timestamp: 2000 };
  const m3: ExtractionMessage = { id: "m3", speaker: "Bek", role: "user", text: "Wait no, make it yellow.", timestamp: 3000 };
  const repEarly: MemoryProposal = { text: "Bek's favorite color is green.", replaces: priorId, evidence: [{ messageId: "m2", quote: m2.text }] };
  const repLate: MemoryProposal = { text: "Bek's favorite color is yellow.", replaces: priorId, evidence: [{ messageId: "m3", quote: m3.text }] };
  const result = await runExtraction({
    config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", runtime: {},
    sessions: () => [session], since: 0, signal: signal(),
    readPage: async (_id, _name, _s, cursor) => cursor === "c2" ? page("c2", []) : page("c2", [m2, m3]),
    extract: async () => [repEarly, repLate],
    validate: async () => ({
      accepted: true, reason: "judged" as const,
      scores: { supported: 0.99, useful: 0.99, replacement: 0.99 },
      thresholds: config().extraction,
    }),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 1);

  const check = new ExtractionStore(f.storePath);
  try {
    const active = check.records(session.sessionId);
    assert.equal(active.length, 1);
    assert.equal(active[0]!.id, priorId);
    assert.equal(active[0]!.revision, 2);
    assert.equal(active[0]!.text, "Bek's favorite color is yellow.");
    assert.equal(check.db.prepare("SELECT count(*) AS n FROM extracted_memories WHERE id=?").get(priorId)!.n, 2);
  } finally { check.close(); }
});

test("extraction-runtime gateway_stop aborts and drains in-flight RPC runs before resolving", async () => {
  const hooks = new Map<string, () => void | Promise<void>>();
  let rpcHandler: ((req: { params: unknown; respond: (ok: boolean, data?: unknown, err?: unknown) => void }) => Promise<void>) | undefined;
  const api = {
    config: { agents: { entries: { main: { workspace: tmpdir() } } } },
    runtime: {},
    logger: { warn() {} },
    registerCli() {},
    on(name: string, fn: () => void | Promise<void>) { hooks.set(name, fn); },
    registerGatewayMethod(name: string, fn: typeof rpcHandler) { if (name === "unblock-memory.extract") rpcHandler = fn; },
  } as unknown as OpenClawPluginApi;

  let runStarted!: () => void;
  const started = new Promise<void>(resolve => { runStarted = resolve; });
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  let observedAbort = false;
  let cleanedUp = false;
  let launchCount = 0;

  registerExtraction(api, config(), undefined, {
    runExtraction: async ({ signal: runSignal }) => {
      launchCount++;
      runStarted();
      await new Promise<void>(resolve => {
        if (runSignal.aborted) { observedAbort = true; resolve(); return; }
        runSignal.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true });
      });
      await cleanupGate;
      cleanedUp = true;
      throw runSignal.reason ?? new Error("aborted");
    },
  });

  assert.ok(rpcHandler);
  assert.ok(hooks.has("gateway_stop"));

  const responses: { ok: boolean; data?: unknown }[] = [];
  const rpcPromise = rpcHandler!({
    params: { agentId: "main" },
    respond: (ok, data) => { responses.push({ ok, data }); },
  });
  await started;

  let stopResolved = false;
  const stopPromise = Promise.resolve(hooks.get("gateway_stop")!()).then(() => { stopResolved = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(observedAbort, true, "gateway_stop must abort in-flight RPC signal");
  assert.equal(stopResolved, false, "gateway_stop must wait until in-flight RPC drains");

  // New RPCs launched while stopped are rejected immediately without starting work.
  await rpcHandler!({ params: { agentId: "main" }, respond: (ok, data) => { responses.push({ ok, data }); } });
  assert.equal(launchCount, 1);
  assert.equal(responses[0]!.ok, false);

  releaseCleanup();
  await stopPromise;
  await rpcPromise;
  assert.equal(cleanedUp, true);
  assert.equal(stopResolved, true);
  assert.equal(responses.length, 2);
  assert.equal(responses[1]!.ok, false);
});

test("readExtractionPage propagates cancellation before and during host page reads", async () => {
  const preAborted = new AbortController();
  preAborted.abort(new Error("already cancelled"));
  let readCalls = 0;
  await assert.rejects(
    readExtractionPage("main", "Bill", session, null, async () => { readCalls++; return { kind: "missing" }; }, preAborted.signal),
    /already cancelled/,
  );
  assert.equal(readCalls, 0);

  const midAbort = new AbortController();
  const pending = readExtractionPage("main", "Bill", session, null, async () => {
    readCalls++;
    return new Promise(() => {});
  }, midAbort.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(readCalls, 1);
  midAbort.abort(new Error("lease aborted"));
  await assert.rejects(pending, /lease aborted/);
});
