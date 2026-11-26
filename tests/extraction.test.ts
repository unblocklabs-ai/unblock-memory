import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdtempDisposable } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createStore } from "@unblocklabs/qmd";
import { ErrorCodes } from "openclaw/plugin-sdk/gateway-runtime";
import { resolveConfig } from "../src/config.js";
import { DEFAULTS } from "../src/defaults.js";
import { EXTRACTION_INPUT_TARGET, EXTRACTION_VERSION, extractWithDecisionModel, validateExtractedMemories, type ExtractionMessage, type MemoryProposal } from "../src/extraction-model.js";
import { buildCompleteRevision, ExtractionLeaseLostError, extractionPolicyFingerprint, ExtractionStore, type ExtractionSession } from "../src/extraction-store.js";
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
  decisionModel: { apiKey: "test-key" }, extraction: { enabled: true, chatTypes: ["channel"], intervalMinutes: 0 }, ...extra });
const signal = () => new AbortController().signal;
const thresholds = config().extraction;
type ValidationParams = Parameters<typeof validateExtractedMemories>[0];
const acceptAll = async ({ proposals, thresholds }: ValidationParams) => proposals.map(() => ({
  accepted: true, reason: "judged" as const, scores: { supported: 1, useful: 1 }, thresholds,
}));
const validateOne = async ({ proposal, ...params }: Omit<ValidationParams, "proposals"> & { proposal: MemoryProposal }) =>
  (await validateExtractedMemories({ ...params, proposals: [proposal] }))[0]!;
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

test("the worker validates four verbatim d1.2 proposals with one dated transcript and no host LLM", async t => {
  const f = await fixture();
  const cfg = config({ decisionModel: { apiKey: "test-key", endpoint: "https://decisions.example/v1/decisions", model: "liquid/d1.2" } });
  const quotes = ["My favorite color is *red*.", "I drink dark roast coffee.", "I prefer rain to snow.", "I start work at six."];
  const source = quotes.map((quote, i) => ({ ...messages[0]!, id: `m${i + 1}`, timestamp: (i + 1) * 1000,
    text: i === 0 ? `🎨 Note:  ${quote}  ` : quote }));
  const validationRequests: { state: unknown; questions: Record<string, { instructions: unknown }> }[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "liquid/d1.2");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-key");
    if (url.endsWith("/extractions")) {
      assert.equal(body.fields.memories.type, "list");
      assert.equal(body.fields.memories.items, "text");
      const spans = quotes.map((quote, i) => {
        const start = body.state.indexOf(quote);
        const padding = i === 0 ? 2 : 0;
        return [start - padding, start + quote.length + padding];
      });
      return Response.json({ model: body.model, answers: { memories: {
        value: quotes, spans, p_null: 0.03,
      } } });
    }
    assert.equal(url, "https://decisions.example/v1/decisions");
    validationRequests.push(body);
    return Response.json({ answers: Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key,
      (question as { type: string }).type === "choice"
        ? { type: "choice", choice: "supported", confidence: 0.99, probabilities: { supported: 0.99, contradicted: 0, unsupported: 0.01 } }
        : { type: "noul", noul: key === "retain_2" ? 0.1 : 0.99 },
    ])) });
  });
  const result = await runExtraction({ config: cfg, storePath: f.storePath, agentId: "main", agentName: "Bill",
    sessions: () => [session], since: 0, signal: signal(), readPage: async () => page("c1", source) });
  assert.deepEqual(fetch.mock.calls.map(call => call.arguments[0]), ["https://decisions.example/v1/extractions", "https://decisions.example/v1/decisions"]);
  assert.equal(result.accepted, 3);
  assert.equal(result.rejected, 1);
  const { state, questions } = validationRequests[0]!;
  assert.deepEqual(state, [{
    messages: source.map(message => ({ ...message, sourceDate: new Date(message.timestamp).toISOString() })),
    newMessageIds: source.map(message => message.id),
    proposals: quotes.map((quote, i) => ({ text: `Bek: ${quote}`, evidence: [{ messageId: source[i]!.id, quote }] })),
  }]);
  for (const i of quotes.keys()) {
    for (const rubric of ["support", "retain"]) {
      assert.match(JSON.stringify(questions[`${rubric}_${i}`]!.instructions), new RegExp(`proposals\\[${i}\\]`));
    }
  }
  const store = new ExtractionStore(f.storePath);
  try {
    const records = store.records();
    assert.deepEqual(records.map(record => record.text).sort(), [quotes[0], quotes[1], quotes[3]].map(quote => `Bek: ${quote}`).sort());
    assert.deepEqual(records.find(record => record.text === `Bek: ${quotes[0]}`)?.evidence, [{ messageId: "m1", quote: quotes[0] }]);
  } finally { store.close(); }
});

test("span mapping keeps a cross-turn exchange and rejects context-only, low confidence and duplicate spans", async t => {
  const question: ExtractionMessage = { id: "q", speaker: "Bill", role: "assistant", text: 'Is your favorite color blue?', timestamp: 1000 };
  const answer: ExtractionMessage = { ...messages[0]!, text: "No, it is red. I also like jazz.", timestamp: 2000 };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.match(url, /\/extractions$/u);
    const { state, model } = JSON.parse(String(init.body));
    const start = state.indexOf(question.text);
    const end = state.indexOf("No, it is red.") + "No, it is red.".length;
    return Response.json({ model, answers: { memories: {
      value: ["resolved exchange", question.text, "I also like jazz.", "duplicate", 42, "  "],
      spans: [[start, end], [start, start + question.text.length], [end + 1, end + 18], [start, end], [start, end], [start, end]],
      confidences: [0.99, 0.99, 0.49, 0.99, 0.99, 0.99],
    } } });
  });
  assert.deepEqual(await extractWithDecisionModel({ messages: [question, answer], newIds: ["m1"], existing: [], apiKey: "test", signal: signal() }), [{
    text: "Bill: Is your favorite color blue? / Bek: No, it is red.", replaces: null,
    evidence: [{ messageId: "q", quote: question.text }, { messageId: "m1", quote: "No, it is red." }],
  }]);
});

test("no-span responses match exact new-message text; empty and null responses yield no proposals", async t => {
  let answer: { value: unknown[] | null; p_null?: number } = { value: [messages[0]!.text, "invented"] };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) =>
    Response.json({ model: JSON.parse(String(init.body)).model, answers: { memories: answer } }));
  const params = { messages: [{ ...messages[0]!, id: "old" }, ...messages], newIds: ["m1"], existing: [], apiKey: "test", signal: signal() };
  assert.deepEqual(await extractWithDecisionModel(params), [{ ...proposal, text: `Bek: ${messages[0]!.text}` }]);
  const later = { ...messages[0]!, id: "later" };
  answer = { value: [later.text, later.text] };
  assert.deepEqual((await extractWithDecisionModel({ ...params, messages: [...params.messages, later], newIds: ["m1", "later"] }))
    .map(p => p.evidence[0]!.messageId), ["m1", "later"]);
  for (answer of [{ value: [] }, { value: null, p_null: 0.97 }, { value: [messages[0]!.text], p_null: 1 }]) {
    assert.deepEqual(await extractWithDecisionModel(params), []);
  }
});

test("missing quotes and context-only citations never reach decision model", async t => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("invalid evidence must not be sent"); });
  for (const p of [{ ...proposal, evidence: [{ messageId: "m1", quote: "blue" }] }, proposal]) {
    const result = await validateOne({ proposal: p, messages, newIds: p === proposal ? [] : ["m1"], existing: [], apiKey: "test", signal: signal(), thresholds });
    assert.equal(result.accepted, false); assert.equal(result.reason, "invalid_evidence");
  }
});

test("support and retention must both meet the gate; malformed responses fail closed", async t => {
  let support = 0.98, useful = 0.98;
  t.mock.method(globalThis, "fetch", async () => Response.json({ answers: { support_0: { type: "choice", choice: "supported", confidence: support, probabilities: { supported: support, unsupported: 1-support, contradicted: 0 } },
    retain_0: { type: "noul", noul: useful } } }));
  const params = { proposal, messages, newIds: ["m1"], apiKey: "test", signal: signal(), thresholds };
  assert.equal((await validateOne(params)).accepted, true);
  useful = 0.89; assert.equal((await validateOne(params)).accepted, false);
  assert.equal((await validateOne({ ...params, thresholds: { ...thresholds, minRetention: 0.85 } })).accepted, true);
  useful = 0.98; support = 0.89; assert.equal((await validateOne(params)).accepted, false);
  support = 0.8;
  assert.equal((await validateOne({ ...params, thresholds: { ...thresholds, minSupport: 0.8 } })).accepted, true);
  assert.equal((await validateOne({ ...params, thresholds: { ...thresholds, minRetention: 0.1 } })).accepted, false);
  useful = NaN; await assert.rejects(validateOne(params), /invalid noul answer/i);
});

test("citations preserve source formatting; separated spans must be separate quotes", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ answers: {
      support_0: { type: "choice", choice: "supported", confidence: 0.99, probabilities: { supported: 0.99, unsupported: 0.01, contradicted: 0 } },
      retain_0: { type: "noul", noul: 0.99 },
    } });
  });
  const source = [{ ...messages[0]!, text: "Classify by *effect*, not verb.\n\nSearch via POST is still a read." }];
  const input = { messages: source, newIds: ["m1"], existing: [], apiKey: "test", signal: signal(), thresholds };
  const fact = { ...proposal, text: "The classifier uses effect, not verb; POST search can be read." };
  for (const quote of ["Classify by effect, not verb.", "Classify by *effect*, not verb. Search via POST is still a read."]) {
    assert.equal((await validateOne({ ...input, proposal: { ...fact, evidence: [{ messageId: "m1", quote }] } })).reason, "invalid_evidence");
  }
  assert.equal(calls, 0);
  assert.equal((await validateOne({ ...input, proposal: { ...fact, evidence: [
    { messageId: "m1", quote: "Classify by *effect*, not verb." },
    { messageId: "m1", quote: "Search via POST is still a read." },
  ] } })).accepted, true);
  assert.equal(calls, 1);
});

test("commit deduplicates retries and is fenced by checkpoint and lease", async () => {
  const f = await fixture(), store = new ExtractionStore(f.storePath);
  try {
    const owner = store.claim(false, 0)!; assert.ok(owner); assert.equal(store.claim(false, 0), undefined);
    store.checkpoint(session, owner);
    const commit = { session, expected: null, cursor: "c1", context: messages, accepted: [{ proposal, observedAt: 1000, judgment: {} }], owner, version: "test" };
    assert.equal(store.commit(commit), 1);
    assert.throws(() => store.commit(commit), /checkpoint/);
    assert.equal(store.commit({ ...commit, expected: "c1", cursor: "c2" }), 0);
    store.reset(session.sessionId, "reset", owner); assert.deepEqual(store.records(), []);
    store.release(owner); assert.throws(() => store.renew(owner), /lease/);
    assert.equal(store.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { store.close(); }
});

test("legacy and new digests deduplicate the same evidence, not the same text", async () => {
  await using root = await mkdtempDisposable(join(tmpdir(), "extraction-legacy-digest-"));
  const store = new ExtractionStore(join(root.path, "memory.sqlite"));
  try {
    const owner = store.claim(false, 0)!;
    store.checkpoint(session, owner);
    const evidence = [{ messageId: "question", quote: "Coffee?" }, { messageId: "reply", quote: "Dark roast." }];
    const text = "Bek drinks dark roast";
    const legacyDigest = createHash("sha256").update(text.toLowerCase()).digest("hex");
    store.db.prepare("INSERT INTO extracted_memories VALUES('legacy',2,?,?,?,?,1000,'active','{}','v1',1000)")
      .run(session.sessionId, text, legacyDigest, JSON.stringify(evidence));
    const commit = (expected: string | null, cursor: string, cites: MemoryProposal["evidence"]) =>
      store.commit({ session, owner, version: "test", context: [], expected, cursor,
        accepted: [{ proposal: { text, replaces: null, evidence: cites }, observedAt: 2000, judgment: {} }] });
    assert.equal(commit(null, "1", [...evidence].reverse()), 0, "upgrade replay preserves the legacy occurrence");
    const other = [evidence[0]!, { messageId: "reply", quote: "I prefer dark roast." }];
    assert.equal(commit("1", "2", other), 1, "a distinct quote on the same message is a new occurrence");
    assert.equal(commit("2", "3", [{ ...other[1]!, quote: " I prefer   dark roast. " }, other[0]!]), 0);
    assert.deepEqual(store.records().map(r => [r.revision, r.evidence]), [[2, evidence], [1, other]]);
  } finally { store.close(); }
});

test("missing decision model key and disabled extraction do not open storage or call models", async () => {
  const f = await fixture();
  for (const cfg of [config({ decisionModel: { apiKeyFile: join(f.dir, "absent") } }), resolveConfig(undefined)]) {
    const result = await runExtraction({ config: cfg, storePath: f.storePath, agentId: "main", agentName: "Bill",
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
  const opts = { config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", sessions: () => [session], since: 0, signal: signal(),
    readPage: async (_id: string, _name: string, _s: ExtractionSession, cursor: string | null) => cursor === "c1" ? page("c1", []) : page("c1"),
    extract: async () => { calls++; if (fail) throw new Error("private source must never leak into status"); return [proposal]; },
    validate: acceptAll };
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
  const opts = { config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", signal: signal(), since: 1000,
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
  const result = await runExtraction({ config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", sessions: () => [session], since: 0, signal: signal(),
    readPage: async (_id, _name, _s, cursor) => cursor === "c1" ? { kind: "reset", cursor: "new-generation" } : page("c1"),
    extract: async () => [proposal], validate: acceptAll });
  assert.equal(result.accepted, 0);
  const store = new ExtractionStore(f.storePath); assert.deepEqual(store.records(), []); assert.equal(store.readCheckpoint(session.sessionId)?.cursor, "new-generation"); store.close();
});

test("single-session run does not withdraw another eligible session's memories", async () => {
  const f = await fixture(), store = new ExtractionStore(f.storePath), other = { ...session, sessionId: "s2" };
  const owner = store.claim(false, 0)!; store.checkpoint(other, owner);
  store.commit({ session: other, expected: null, cursor: "c1", context: [], accepted: [{ proposal, observedAt: 1000, judgment: {} }], owner, version: "test" });
  store.release(owner); store.close();
  await runExtraction({ config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill",
    sessions: () => [session, other], sessionId: "s1", since: 0, signal: signal(), readPage: async () => page("c1", []) });
  const reopened = new ExtractionStore(f.storePath); assert.equal(reopened.records("s2").length, 1); reopened.close();
});

test("scheduled run resumes an approved historical backfill rather than skipping unfinished history", async () => {
  const f = await fixture(); let calls = 0;
  const opts = { config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", sessions: () => [session], signal: signal(),
    readPage: async (_id: string, _name: string, _s: ExtractionSession, cursor: string | null) =>
      cursor === null ? page("c1", [{ ...messages[0]!, id: "context", text: "Hello" }]) : cursor === "c1" ? page("c2") : page("c2", []),
    extract: async ({ newIds }: { newIds: string[] }) => { calls++; return newIds.includes("m1") ? [proposal] : []; },
    validate: acceptAll };
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

test("an extracted fact cursor resumes its active revision but cannot read withdrawn text", async () => {
  await using root = await mkdtempDisposable(join(tmpdir(), "extracted-memory-read-"));
  const storePath = join(root.path, "unblock-memory.sqlite");
  const store = new ExtractionStore(storePath);
  const manager = new QmdMemoryManager({ dbPath: join(root.path, "index.sqlite"),
    curationPath: storePath, workspaceDir: root.path,
    sources: [resolveSource(root.path, "memory", "memory")], extraction: { ...config().extraction, publish: true } });
  try {
    const owner = store.claim(false, 0)!;
    const text = "🌈".repeat(DEFAULTS.memoryWhisperer.memoryGetMaxChars);
    store.checkpoint(session, owner);
    store.commit({ session, expected: null, cursor: "c1", context: messages,
      accepted: [{ proposal: { ...proposal, text }, observedAt: 1000, judgment: {} }], owner, version: "test" });
    const relPath = `qmd://${EXTRACTED_COLLECTION}/${extractedPath(store.records()[0]!)}`;
    const first = await manager.readFile({ relPath });
    assert.equal(first.status, "ok");
    assert.ok(first.nextCursor);
    const cursor = first.nextCursor;
    const tail = await manager.readFile({ relPath, cursor, lines: 1 });
    assert.equal(tail.status, "ok");
    assert.equal(first.text.slice(0, first.contentChars) + tail.text.slice(0, tail.contentChars), text);
    assert.equal(tail.nextFrom, 2, "after the long text, continue at the observed date");
    store.reset(session.sessionId, null, owner);
    const withdrawn = await manager.readFile({ relPath, cursor });
    assert.equal(withdrawn.status, "stale_cursor");
    assert.equal(withdrawn.text, "");
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
    config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill",
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
    config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill",
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
    config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill",
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
    config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill",
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
    config: config(extraCfg), storePath: f.storePath, agentId: "main", agentName: "Bill",
    sessions: () => [s], since: 0, signal: signal(), version,
    readPage: async (_id: string, _name: string, _s: ExtractionSession, cursor: string | null) => {
      reads++;
      return cursor === "c1" ? page("c1", []) : page("c1", [messages[0]!, m2]);
    },
    extract: async () => { extractions++; return [proposal, p2]; },
    validate: async ({ proposals, thresholds: t }: ValidationParams) => proposals.map(prop => ({
      accepted: prop.text === proposal.text || t.minSupport <= 0.85,
      reason: "judged" as const,
      scores: { supported: prop.text === proposal.text ? 0.99 : 0.85, useful: 0.99 },
      thresholds: config(extraCfg).extraction,
    })),
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

test("later corrections and restatements append dated observations without replacement calls", async t => {
  const f = await fixture();
  const quotes = ["I love Adidas.", "I only wear Yeezys now.", "I love Adidas."];
  let turn = 0;
  const calls: string[][] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const { model, state, questions } = JSON.parse(String(init.body));
    if (url.endsWith("/extractions")) {
      calls.push(["extract"]);
      const quote = quotes[turn]!, start = state.lastIndexOf(quote);
      return Response.json({ model, answers: { memories: { value: [quote], spans: [[start, start + quote.length]] } } });
    }
    calls.push(Object.keys(questions).sort());
    return Response.json({ answers: {
      support_0: { type: "choice", choice: "supported", confidence: 1, probabilities: { supported: 1, unsupported: 0, contradicted: 0 } },
      retain_0: { type: "noul", noul: 1 },
    } });
  });
  const opts = { config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill", sessions: () => [session], since: 0, signal: signal() };
  for (; turn < quotes.length; turn++) {
    const id = String(turn + 1);
    const result = await runExtraction({ ...opts, readPage: async (_a, _n, _s, cursor) =>
      page(id, cursor === id ? [] : [{ ...messages[0]!, id, text: quotes[turn]!, timestamp: (turn + 1) * 1000 }]) });
    assert.equal(result.accepted, 1, `observation ${id} must be stored`);
  }
  assert.deepEqual(calls, quotes.flatMap(() => [["extract"], ["retain_0", "support_0"]]));
  const store = new ExtractionStore(f.storePath);
  try {
    const active = store.records(session.sessionId);
    assert.deepEqual(active.map(r => [r.text, r.observedAt, r.evidence]), quotes.map((quote, i) =>
      [`Bek: ${quote}`, (i + 1) * 1000, [{ messageId: String(i + 1), quote }]]));
    assert.equal(new Set(active.map(r => r.id)).size, 3);
    assert.ok(active.every(r => r.revision === 1));
  } finally { store.close(); }
});

test("extraction-runtime gateway_stop aborts and drains in-flight RPC runs before resolving", async () => {
  const hooks = new Map<string, () => void | Promise<void>>();
  let rpcHandler: ((req: { params: unknown; respond: (ok: boolean, data?: unknown, err?: unknown) => void }) => Promise<void>) | undefined;
  const api = {
    config: { agents: { entries: { main: { workspace: tmpdir() } } } },
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

test("policy change and unversioned legacy partial cursors rewind before processing or certifying completion", async () => {
  const f = await fixture();
  const s = { ...session, sourceRevision: '["g1",2]' };
  const m1: ExtractionMessage = { id: "m1", speaker: "Bek", role: "user", text: "I prefer dark roast coffee.", timestamp: 1000 };
  const pad: ExtractionMessage = { id: "pad", speaker: "Bek", role: "user", text: " project".repeat(EXTRACTION_INPUT_TARGET), timestamp: 1500 };
  const m2: ExtractionMessage = { id: "m2", speaker: "Bek", role: "user", text: "I live in Brooklyn.", timestamp: 2000 };
  const p1: MemoryProposal = { text: "Bek prefers dark roast coffee.", replaces: null, evidence: [{ messageId: "m1", quote: m1.text }] };
  const p2: MemoryProposal = { text: "Bek lives in Brooklyn.", replaces: null, evidence: [{ messageId: "m2", quote: m2.text }] };

  const observedCursors: (string | null)[] = [];
  const makeOpts = (extraCfg: object = {}, version = "lasting-facts-v11") => ({
    config: config(extraCfg), storePath: f.storePath, agentId: "main", agentName: "Bill",
    sessions: () => [s], since: 0, signal: signal(), version,
    readPage: async (_id: string, _name: string, _s: ExtractionSession, cursor: string | null): Promise<ExtractionPage> => {
      observedCursors.push(cursor);
      if (cursor === null) return { kind: "page", cursor: "c1", hasMore: true, entryCount: 2, messages: [m1, pad] };
      if (cursor === "c1") return { kind: "page", cursor: "c2", hasMore: false, entryCount: 1, messages: [m2] };
      return { kind: "page", cursor: "c2", hasMore: false, entryCount: 0, messages: [] };
    },
    extract: async ({ newIds }: { newIds: string[] }) =>
      newIds.includes("m1") ? [p1] : newIds.includes("m2") ? [p2] : [],
    validate: async ({ proposals, thresholds: t }: ValidationParams) => proposals.map(prop => ({
      accepted: prop.text === p2.text || t.minSupport <= 0.85,
      reason: "judged" as const,
      scores: { supported: prop.text === p2.text ? 0.99 : 0.85, useful: 0.99 },
      thresholds: config(extraCfg).extraction,
    })),
  });

  // Policy A (minSupport=0.9, maxBatches=1) commits partial cursor c1 (complete_revision remains NULL) and rejects p1.
  const cfgA = { extraction: { enabled: true, chatTypes: ["channel"], intervalMinutes: 0, maxBatches: 1, minSupport: 0.9 } };
  const cfgB = { extraction: { enabled: true, chatTypes: ["channel"], intervalMinutes: 0, maxBatches: 1, minSupport: 0.8 } };
  const fpA = extractionPolicyFingerprint({ version: "lasting-facts-v11", ...config(cfgA).extraction, extractorModel: config(cfgA).decisionModel.model, validatorModel: config(cfgA).decisionModel.model });
  const fpB = extractionPolicyFingerprint({ version: "lasting-facts-v11", ...config(cfgB).extraction, extractorModel: config(cfgB).decisionModel.model, validatorModel: config(cfgB).decisionModel.model });

  const r1 = await runExtraction(makeOpts(cfgA));
  assert.equal(r1.status, "completed");
  assert.equal(r1.accepted, 0);
  assert.equal(r1.rejected, 1);
  let store = new ExtractionStore(f.storePath);
  try {
    const cp = store.readCheckpoint(s.sessionId)!;
    assert.equal(cp.cursor, "c1");
    assert.equal(cp.completeRevision, null);
    assert.equal(cp.policyFingerprint, fpA);
    // Store-level fencing refuses to advance or certify a Policy A cursor under Policy B.
    const owner = store.claim(false, 0)!;
    try {
      assert.throws(() => store.commit({
        session: s, expected: "c1", cursor: "c2", context: [m2], accepted: [], owner,
        version: "lasting-facts-v11", completeRevision: buildCompleteRevision(s.sourceRevision, fpB), policyFingerprint: fpB,
      }), /checkpoint/);
      assert.throws(() => store.completeEmpty({
        sessionId: s.sessionId, expected: "c1", owner,
        completeRevision: buildCompleteRevision(s.sourceRevision, fpB), policyFingerprint: fpB,
      }), /checkpoint/);
    } finally { store.release(owner); }
  } finally { store.close(); }

  // Policy B runs next: must rewind to cursor=null and reprocess page 1 (accepting p1) instead of resuming c1.
  const r2 = await runExtraction(makeOpts(cfgB));
  assert.equal(r2.status, "completed");
  assert.equal(r2.accepted, 1);
  assert.deepEqual(observedCursors, [null, "c1", "c1", null, "c1"],
    "Policy B verifies Policy A's partial cursor against the source, then rewinds instead of resuming it");
  store = new ExtractionStore(f.storePath);
  try {
    const cp = store.readCheckpoint(s.sessionId)!;
    assert.equal(cp.cursor, "c1");
    assert.equal(cp.completeRevision, null);
    assert.equal(cp.policyFingerprint, fpB);
    assert.deepEqual(store.records(s.sessionId).map(r => r.text), [p1.text]);
  } finally { store.close(); }

  // Second Policy B run resumes c1 cleanly, extracts p2, and certifies complete_revision under Policy B.
  const r3 = await runExtraction(makeOpts(cfgB));
  assert.equal(r3.status, "completed");
  assert.equal(r3.accepted, 1);
  store = new ExtractionStore(f.storePath);
  try {
    const cp = store.readCheckpoint(s.sessionId)!;
    assert.equal(cp.cursor, "c2");
    assert.equal(cp.completeRevision, buildCompleteRevision(s.sourceRevision, fpB));
    assert.equal(cp.policyFingerprint, fpB);
    assert.deepEqual(store.records(s.sessionId).map(r => r.text), [p1.text, p2.text]);
  } finally { store.close(); }

  // Third Policy B run skips without reopening delta.
  const readsBeforeSkip = observedCursors.length;
  const r4 = await runExtraction(makeOpts(cfgB));
  assert.equal(r4.unchanged, 1);
  assert.equal(observedCursors.length, readsBeforeSkip);

  // Legacy pre-migration database with an unversioned partial cursor (no policy_fingerprint column) migrates and rewinds.
  const legacy = await fixture();
  const raw = new DatabaseSync(legacy.storePath);
  try {
    raw.exec(`
      CREATE TABLE memory_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      INSERT INTO memory_schema VALUES ('storage', 1), ('extraction', 1);
      CREATE TABLE extraction_worker (
        id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        next_run INTEGER NOT NULL DEFAULT 0, live_since INTEGER NOT NULL
      ) STRICT;
      INSERT INTO extraction_worker(id, live_since) VALUES (1, 0);
      CREATE TABLE extraction_sessions (
        session_id TEXT PRIMARY KEY, metadata TEXT NOT NULL CHECK(json_valid(metadata)), cursor TEXT,
        extract_since INTEGER NOT NULL,
        context TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(context)), updated_at INTEGER NOT NULL,
        error TEXT, complete_revision TEXT
      ) STRICT;
      CREATE TABLE extracted_memories (
        id TEXT NOT NULL, revision INTEGER NOT NULL, session_id TEXT NOT NULL REFERENCES extraction_sessions(session_id),
        text TEXT NOT NULL, digest TEXT NOT NULL, evidence TEXT NOT NULL CHECK(json_valid(evidence)),
        observed_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','superseded','withdrawn')),
        judgment TEXT NOT NULL CHECK(json_valid(judgment)), prompt_version TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(id,revision)
      ) STRICT;
      CREATE UNIQUE INDEX extracted_current ON extracted_memories(id) WHERE status='active';
      CREATE UNIQUE INDEX extracted_duplicate ON extracted_memories(session_id,digest) WHERE status='active';
    `);
    raw.prepare("INSERT INTO extraction_sessions(session_id,metadata,cursor,extract_since,context,updated_at,error,complete_revision) VALUES(?,?,?,?,?,?,NULL,NULL)")
      .run(s.sessionId, JSON.stringify(s), "c1", 0, JSON.stringify([m1]), Date.now());
  } finally { raw.close(); }

  const legacyCursors: (string | null)[] = [];
  const legacyRun = await runExtraction({
    ...makeOpts(cfgB),
    storePath: legacy.storePath,
    readPage: async (_id, _name, _s, cursor) => {
      legacyCursors.push(cursor);
      if (cursor === null) return { kind: "page", cursor: "c1", hasMore: true, entryCount: 2, messages: [m1, pad] };
      if (cursor === "c1") return { kind: "page", cursor: "c2", hasMore: false, entryCount: 1, messages: [m2] };
      return { kind: "page", cursor: "c2", hasMore: false, entryCount: 0, messages: [] };
    },
  });
  assert.equal(legacyRun.status, "completed");
  assert.equal(legacyRun.accepted, 1);
  assert.deepEqual(legacyCursors.slice(0, 2), ["c1", null],
    "unversioned legacy partial cursor is verified against the source, then rewinds to null");
  const legacyStore = new ExtractionStore(legacy.storePath);
  try {
    const cp = legacyStore.readCheckpoint(s.sessionId)!;
    assert.equal(cp.cursor, "c1");
    assert.equal(cp.policyFingerprint, fpB);
    assert.deepEqual(legacyStore.records(s.sessionId).map(r => r.text), [p1.text]);
  } finally { legacyStore.close(); }
});

test("extraction-runtime gateway_stop then gateway_start with extraction disabled returns disabled on RPC", async () => {
  const hooks = new Map<string, () => void | Promise<void>>();
  let rpcHandler: ((req: { params: unknown; respond: (ok: boolean, data?: unknown, err?: { code?: string; message?: string }) => void }) => Promise<void>) | undefined;
  const api = {
    config: { agents: { entries: { main: { workspace: tmpdir() } } } },
    logger: { warn() {} },
    registerCli() {},
    on(name: string, fn: () => void | Promise<void>) { hooks.set(name, fn); },
    registerGatewayMethod(name: string, fn: typeof rpcHandler) { if (name === "unblock-memory.extract") rpcHandler = fn; },
  } as unknown as OpenClawPluginApi;

  const disabledConfig = resolveConfig(undefined);
  assert.equal(disabledConfig.extraction.enabled, false);
  let scheduledRuns = 0;
  registerExtraction(api, disabledConfig, undefined, {
    runExtraction: async ({ config: runCfg, scheduled }) => {
      if (scheduled) scheduledRuns++;
      return { status: runCfg.extraction.enabled ? ("completed" as const) : ("disabled" as const) } as Awaited<ReturnType<typeof runExtraction>>;
    },
  });

  assert.ok(rpcHandler);
  assert.ok(hooks.has("gateway_stop"));
  assert.ok(hooks.has("gateway_start"), "gateway_start must be registered even when extraction is disabled");

  const invoke = async () => {
    let reply: { ok: boolean; data?: unknown; err?: { code?: string; message?: string } } | undefined;
    await rpcHandler!({ params: { agentId: "main" }, respond: (ok, data, err) => { reply = { ok, data, err }; } });
    return reply!;
  };

  assert.deepEqual(await invoke(), { ok: true, data: { status: "disabled" }, err: undefined });

  await hooks.get("gateway_stop")!();
  const whileStopped = await invoke();
  assert.equal(whileStopped.ok, false);
  assert.equal(whileStopped.err?.code, ErrorCodes.UNAVAILABLE);

  await hooks.get("gateway_start")!();
  assert.equal(scheduledRuns, 0, "gateway_start must not trigger scheduled ticks when extraction is disabled");
  assert.deepEqual(await invoke(), { ok: true, data: { status: "disabled" }, err: undefined });
});

test("upgrading a v0.15.x node is forward-only: same policy fingerprint, no cursor rewind, no resurrected rows", async () => {
  const f = await fixture();
  const cfg = config();
  assert.equal(EXTRACTION_VERSION, DEFAULTS.extraction.version, "the prompt version is unchanged");
  // The exact v0.15.3 fingerprint recipe, computed independently of extractionPolicyFingerprint.
  const legacy = createHash("sha256").update(JSON.stringify({
    version: DEFAULTS.extraction.version, historyMessages: cfg.extraction.historyMessages,
    minSupport: cfg.extraction.minSupport, minRetention: cfg.extraction.minRetention,
    minReplacement: cfg.extraction.minReplacement,
    extractorModel: cfg.decisionModel.model ?? null, validatorModel: cfg.decisionModel.model ?? null,
  })).digest("hex");
  assert.equal(extractionPolicyFingerprint({ version: EXTRACTION_VERSION, ...cfg.extraction,
    extractorModel: cfg.decisionModel.model, validatorModel: cfg.decisionModel.model }), legacy);
  // Seed a v0.15.x checkpoint: an advanced cursor, one active fact and one superseded revision.
  const store = new ExtractionStore(f.storePath), owner = store.claim(false, 0)!;
  store.checkpoint(session, owner, 0, legacy);
  store.commit({ session, expected: null, cursor: "c1", context: [], accepted: [{ proposal, observedAt: 1000, judgment: {} }],
    owner, version: DEFAULTS.extraction.version, policyFingerprint: legacy });
  store.db.prepare(`INSERT INTO extracted_memories VALUES('old',1,'s1','Bek liked blue.','d','[]',500,'superseded','{}','v11',1)`).run();
  store.release(owner); store.close();
  const cursors: (string | null)[] = [];
  const next = { ...messages[0]!, id: "m2", timestamp: 2000, text: "I live in Brooklyn." };
  const result = await runExtraction({ config: cfg, storePath: f.storePath, agentId: "main", agentName: "Bill", sessions: () => [session],
    signal: signal(), validate: acceptAll,
    readPage: async (_id, _name, _s, cursor) => { cursors.push(cursor); return cursor === "c2" ? page("c2", []) : page("c2", [next]); },
    extract: async () => [{ text: "Bek lives in Brooklyn.", replaces: null, evidence: [{ messageId: "m2", quote: next.text }] }] });
  assert.equal(result.accepted, 1);
  assert.equal(cursors[0], "c1", "resumes the stored cursor");
  assert.ok(!cursors.includes(null), "never replays history from the start");
  const reopened = new ExtractionStore(f.storePath);
  try {
    assert.equal(reopened.readCheckpoint("s1")?.policyFingerprint, legacy);
    assert.deepEqual(reopened.records("s1").map(r => r.text), [proposal.text, "Bek lives in Brooklyn."]);
    assert.equal(reopened.db.prepare("SELECT status FROM extracted_memories WHERE id='old'").get()?.status, "superseded");
  } finally { reopened.close(); }
});

test("an intentional rewind verifies the stored cursor first, so a rewritten source withdraws stale observations", async t => {
  for (const [name, rewind] of [
    ["broader backfill", { since: 0, config: config() }],
    ["policy change", { since: undefined, config: config({ extraction: { enabled: true, chatTypes: ["channel"], intervalMinutes: 0, minSupport: 0.8 } }) }],
  ] as const) {
    await t.test(name, async () => {
      const f = await fixture();
      const store = new ExtractionStore(f.storePath), owner = store.claim(false, 0)!;
      store.checkpoint(session, owner, 5000);
      store.commit({ session, expected: null, cursor: "g1:1", context: [], accepted: [{ proposal, observedAt: 1000, judgment: {} }], owner, version: "test" });
      store.release(owner); store.close();
      const cursors: (string | null)[] = [];
      const fresh = { ...messages[0]!, id: "n1", timestamp: 6000, text: "I moved to Queens." };
      const result = await runExtraction({ config: rewind.config, storePath: f.storePath, agentId: "main", agentName: "Bill",
        sessions: () => [session], since: rewind.since, signal: signal(), validate: acceptAll,
        readPage: async (_id, _name, _s, cursor) => {
          cursors.push(cursor);
          // The session was rewritten: the old generation's cursor no longer exists.
          if (cursor?.startsWith("g1:")) return { kind: "reset", cursor: "g2:0" };
          return page("g2:1", [fresh]);
        },
        extract: async () => [{ text: "Bek moved to Queens.", replaces: null, evidence: [{ messageId: "n1", quote: fresh.text }] }] });
      assert.equal(result.status, "completed");
      assert.deepEqual(cursors.slice(0, 2), ["g1:1", null], "verifies the old cursor before replaying from the start");
      const reopened = new ExtractionStore(f.storePath);
      try {
        assert.deepEqual(reopened.records("s1").map(r => r.text), ["Bek moved to Queens."], "deleted-source observations are withdrawn");
        assert.equal(reopened.db.prepare("SELECT status FROM extracted_memories WHERE text=?").get(proposal.text)?.status, "withdrawn");
      } finally { reopened.close(); }
    });
  }
  await t.test("an unavailable source keeps the cursor for the next verification", async () => {
    const f = await fixture();
    const store = new ExtractionStore(f.storePath), owner = store.claim(false, 0)!;
    store.checkpoint(session, owner, 5000);
    store.commit({ session, expected: null, cursor: "g1:1", context: [], accepted: [{ proposal, observedAt: 1000, judgment: {} }], owner, version: "test" });
    store.release(owner); store.close();
    const result = await runExtraction({ config: config(), storePath: f.storePath, agentId: "main", agentName: "Bill",
      sessions: () => [session], since: 0, signal: signal(), readPage: async () => ({ kind: "unavailable" }) });
    assert.equal(result.status === "completed" && result.failed, 1);
    const reopened = new ExtractionStore(f.storePath);
    try {
      assert.equal(reopened.readCheckpoint("s1")?.cursor, "g1:1");
      assert.equal(reopened.readCheckpoint("s1")?.since, 5000);
      assert.equal(reopened.records("s1").length, 1);
    } finally { reopened.close(); }
  });
});

test("a repeated no-span quote never rebinds to an unrelated speaker", async t => {
  const text = "The launch moved to Friday.";
  const bek: ExtractionMessage = { id: "bek", speaker: "Bek", role: "user", text, timestamp: 1000 };
  const rico: ExtractionMessage = { id: "rico", speaker: "Rico", role: "user", text, timestamp: 2000 };
  const bekAgain: ExtractionMessage = { ...bek, id: "bek-again", timestamp: 3000 };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) =>
    Response.json({ model: JSON.parse(String(init.body)).model, answers: { memories: { value: [text, text, text] } } }));
  const proposals = await extractWithDecisionModel({ messages: [bek, rico, bekAgain], newIds: ["bek", "rico", "bek-again"],
    apiKey: "test", signal: signal() });
  assert.deepEqual(proposals.map(p => [p.text, p.evidence[0]!.messageId]), [[`Bek: ${text}`, "bek"], [`Bek: ${text}`, "bek-again"]]);
  const single = await extractWithDecisionModel({ messages: [bek, rico], newIds: ["bek", "rico"], apiKey: "test", signal: signal() });
  assert.deepEqual(single.map(p => p.evidence[0]!.messageId), ["bek"], "the repeat is dropped, not given to Rico");
});
