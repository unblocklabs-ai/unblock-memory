import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type QMDStore } from "@unblocklabs/qmd";
import { ensureMemoryAnalysisSchema, readCluster, readClusters, type MemoryAnalysisSummary, type MemoryClusterList } from "../src/analysis.js";
import { OutcomeLedgerStore } from "../src/outcome-ledger.js";
import { CRYSTALS_KIND, runCrystalsPass, type CrystalSynthesis, type CrystalsAnalysis, type CrystalsPassOptions } from "../src/steward-crystals.js";
import { resolveStewardConfig } from "../src/steward-config.js";
import { createStewardRunner } from "../src/steward-runner.js";
import { WorkStore } from "../src/work-store.js";

const MINUTE = 60_000;
const INTERVAL = 360 * MINUTE;
const START = Date.parse("2026-11-27T19:00:00Z");
const AT = new Date(START - MINUTE).toISOString();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const config = resolveStewardConfig(undefined);
type Member = NonNullable<Awaited<ReturnType<CrystalsAnalysis["fetchCluster"]>>["members"]>[number];
type Prompt = { members: { handle: string; text: string; eventTime: string | null; sourceModifiedAt: string }[] };
type Cluster = { id: string; members: Member[] };

function member(name: string, patch: Partial<Member> = {}): Member {
  const text = patch.text ?? `Release evidence from ${name}`;
  const path = `memory/${name}.md`;
  return { text, hash: hash(text), seq: 0, contentFingerprint: hash(text), probability: 0.9, outlierScore: 0.1,
    x: 0, y: 0, representativeRank: null, sourceModifiedAt: AT, eventTime: AT, eventTimeBasis: "path",
    eventTimeSource: path, sourcePaths: [path], ...patch };
}

const cluster = (id: string): Cluster => ({ id, members: [member(`${id}-a`), member(`${id}-b`), member(`${id}-c`)] });
const synthesis = (citedHandles: string[], summary = "Release after the smoke test passes."): CrystalSynthesis =>
  ({ shouldCrystallize: true, title: "Release gate", summary, citedHandles });

const notAnalyzed: MemoryClusterList = { status: "not_analyzed", stale: true, staleSince: null, analyzedAt: null, clusters: [], noise: null };

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE memory_schema(component TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT");
  const workStore = new WorkStore(db);
  let now = START;
  let clusters: Cluster[] = [];
  let state: { runId: string; stale: boolean } | undefined = { runId: "run-1", stale: false };
  const events: string[] = [];
  const load = (data: Cluster[], stale = false, runId = "run-1") => { clusters = data; state = { runId, stale }; };
  const analysis: CrystalsAnalysis = {
    async listClusters(limit) {
      events.push(`list:${limit}`);
      if (!state) return notAnalyzed;
      return { status: "ok", ...state, staleSince: null, analyzedAt: AT, noise: null,
        clusters: clusters.slice(0, limit).map(({ id, members }) => ({ clusterId: id,
          size: members.length, availableSize: members.length, meanProbability: 0.9 })) };
    },
    async fetchCluster({ clusterId, memberLimit = 50, offset = 0 }) {
      events.push(`fetch:${clusterId}:${offset}:${memberLimit}`);
      const total = clusters.find(cluster => cluster.id === clusterId)!.members;
      const members = total.slice(offset, offset + memberLimit);
      const nextOffset = offset + members.length;
      return { status: "ok", ...state!, staleSince: null, analyzedAt: AT, members,
        page: { offset, returned: members.length, total: total.length, hasMore: nextOffset < total.length, nextOffset } };
    },
  };
  const prompts: Prompt[] = [];
  let respond: (prompt: Prompt) => CrystalSynthesis | Promise<CrystalSynthesis> = () => synthesis(["m1", "m2", "m3"]);
  const runner = createStewardRunner({ config, resolveApiKey: async () => "fake-provider-credential", fetch: async (_url, init) => {
    const request: { input: [{ content: string }] } = JSON.parse(String(init?.body));
    const prompt: Prompt = JSON.parse(request.input[0].content);
    prompts.push(prompt);
    const value = await respond(prompt);
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
  } });
  const run = (overrides: Partial<CrystalsPassOptions> = {}) => runCrystalsPass({
    agentId: "main", owner: "crystallizer-test", workStore, analysis, runner, now: () => now, ...overrides,
  });
  const item = () => workStore.get(CRYSTALS_KIND, "main");
  const rows = (sql: string) => db.prepare(sql).all().map(row => ({ ...row }));
  const time = () => now;
  const advance = (ms = INTERVAL) => { now += ms; };
  return { db, workStore, analysis, events, prompts, load, run, item, rows, time, advance,
    setResponse: (fn: typeof respond) => { respond = fn; }, clearAnalysis: () => { state = undefined; } };
}

test("a stale analysis is reclustered under the lease, reread, and throttled by its durable watermark", async t => {
  const f = fixture(t);
  f.load([], true);
  f.analysis.recluster = async signal => {
    assert.ok(signal && !signal.aborted);
    assert.equal(f.item()?.status, "running");
    assert.equal((await f.run({ owner: "competing-tick" })).status, "already_running");
    f.events.push("recluster");
    f.load([cluster("fresh")], false, "new-run");
    return { status: "ok", runId: "new-run", createdAt: AT, completedAt: AT, inputDigest: "qmd-input", model: "embedder",
      embeddingFingerprint: "embedding", dimensions: 3, clusters: 1, members: 3, noise: 0, stale: false, staleSince: null } satisfies MemoryAnalysisSummary;
  };
  const first = await f.run({ maxClusters: 7 });
  assert.equal(first.status, "ok");
  assert.equal(first.reclustered, true);
  assert.equal(first.created, 1);
  assert.deepEqual(f.events, ["list:7", "recluster", "list:7", "fetch:fresh:0:12"]);
  assert.equal(f.item()?.dueAt, START + INTERVAL);
  assert.equal(JSON.parse(f.item()!.artifactJson!).lastReclusterAtMs, START);
  assert.equal((await f.run()).status, "not_due");

  f.clearAnalysis();
  f.advance();
  assert.equal((await f.run()).reclustered, false);
  assert.equal(f.events.filter(event => event === "recluster").length, 1);
  f.advance();
  assert.equal((await f.run()).reclustered, true);
  assert.equal(f.events.filter(event => event === "recluster").length, 2);
});

test("no configured worker is a clean, re-armed pass with no model call or strike", async t => {
  const f = fixture(t);
  f.clearAnalysis();
  assert.equal((await f.run()).status, "ok");
  assert.equal(f.item()?.dueAt, START + INTERVAL);
  assert.equal(f.item()?.lastError, null);
  assert.equal(f.item()?.strikes, 0);
  assert.equal(f.item()?.artifactJson, null);
  f.advance();
  f.analysis.recluster = async () => {
    throw new Error("Memory analysis is unavailable: configure analysis.executable with an absolute worker path");
  };
  assert.equal((await f.run()).status, "ok");
  assert.equal(f.item()?.dueAt, START + 2 * INTERVAL);
  assert.equal(f.item()?.lastError, null);
  assert.equal(f.item()?.strikes, 0);
  assert.equal(f.prompts.length, 0);
});

test("only grounded opaque handles persist; reordered inputs reverify without another model call", async t => {
  const f = fixture(t);
  const secret = "sk-crystal-fixture-secret";
  const sourcePath = "qmd://source-123456789abc/alpha.md";
  const raw = `Use the release checklist. api_key=${secret}`;
  const full = `Header\n${raw}\nFooter`;
  const alpha = member("alpha", { sourcePaths: [sourcePath], eventTimeSource: sourcePath, text: raw,
    hash: hash(full), chunkPos: "Header\n".length, chunkLen: raw.length });
  const beta = member("beta");
  const gamma = member("gamma");
  f.load([{ id: "release", members: [alpha, beta, gamma] }, cluster("hallucinated-only")]);
  f.setResponse(prompt => prompt.members[0]?.text.includes("checklist")
    ? synthesis(["m1", "[m2]", "m99", "m1"])
    : synthesis(["m99", "m0", "memory/beta.md"]));
  const options = { corpusForCollection: (id: string) => id === "source-123456789abc" ? "memory" : undefined };
  const created = await f.run(options);
  assert.equal(created.created, 1);
  assert.deepEqual(f.prompts[0]?.members.map(value => value.handle), ["[m1]", "[m2]", "[m3]"]);
  assert.deepEqual(f.prompts[0]?.members[0], { handle: "[m1]", text: "Use the release checklist. api_key=[redacted]", eventTime: AT, sourceModifiedAt: AT });
  assert.doesNotMatch(JSON.stringify(f.prompts), /sk-crystal|alpha\.md|beta\.md|source-123456789abc/u);
  assert.deepEqual(f.rows("SELECT corpus,source_path,doc_hash,chunk_pos,chunk_len,quote_sha256 FROM memory_crystal_members ORDER BY ordinal"), [
    { corpus: "memory", source_path: sourcePath, doc_hash: alpha.hash, chunk_pos: 7, chunk_len: raw.length, quote_sha256: hash(raw) },
    { corpus: "memory", source_path: "qmd://memory/beta.md", doc_hash: beta.hash, chunk_pos: 0, chunk_len: beta.text.length, quote_sha256: hash(beta.text) },
  ]);
  const [before] = f.rows("SELECT id,tier,input_digest,revision,verified_ms,stale_after_ms FROM memory_crystals");
  assert.equal(before?.input_digest, hash([alpha, beta, gamma].map(m => `${m.hash}:${m.seq}`).sort().join("\n")));
  assert.equal(before?.tier, "stm");
  assert.equal(before?.revision, 1);
  assert.equal(before?.stale_after_ms, START + 20_160 * MINUTE);
  assert.deepEqual(f.rows("SELECT version FROM memory_schema WHERE component='memory_crystals'"), [{ version: 1 }]);

  f.advance();
  f.load([{ id: "release-after-recluster", members: [gamma, alpha, beta] }], false, "run-2");
  assert.equal((await f.run(options)).skippedUnchanged, 1);
  assert.equal(f.prompts.length, 2);
  assert.deepEqual(f.rows("SELECT id,tier,input_digest,revision,verified_ms,stale_after_ms FROM memory_crystals"), [
    { ...before, verified_ms: f.time(), stale_after_ms: f.time() + 20_160 * MINUTE },
  ], "re-verification renews the STM decay clock");
});

test("audience is checked before transport, including mixed aliases and a DM beyond the model sample", async t => {
  const f = fixture(t);
  const tail = cluster("private-tail");
  tail.members[2] = member("dm", { text: "DM_TAIL_SENTINEL", sourcePaths: ["qmd://sessions/direct/dm.md"] });
  const alias = cluster("mixed-alias");
  alias.members[0] = member("alias", { text: "DM_ALIAS_SENTINEL", sourcePaths: ["memory/alias.md", "sessions/direct/alias.md"] });
  const shared = cluster("shared");
  shared.members[1] = member("policy", { eventTimeSource: "qmd://knowledge/policy.md", sourcePaths: ["knowledge/policy.md"] });
  f.load([tail, alias, shared]);
  // Safe default allowedCorpora (memory, knowledge): a session alias anywhere in the cluster disqualifies it.
  const result = await f.run({ maxMembersPerCluster: 2 });
  assert.equal(result.skippedAudience, 2);
  assert.equal(result.created, 1);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0]?.members.length, 2);
  assert.doesNotMatch(JSON.stringify(f.prompts), /DM_.*_SENTINEL/u);
  assert.deepEqual(f.rows("SELECT cluster_id,audience_key,corpora_json FROM memory_crystals"), [
    { cluster_id: "shared", audience_key: "workspace", corpora_json: '["knowledge","memory"]' },
  ]);
});

test("a changed durable summary keeps the crystal identity and records only newly cited evidence as core", async t => {
  const f = fixture(t);
  const previous = cluster("release");
  f.load([previous]);
  assert.equal((await f.run()).created, 1);
  const [original] = f.rows("SELECT id,created_ms,revision FROM memory_crystals");
  assert.equal(f.rows("SELECT id FROM core_memories").length, 0);

  const newEvidence = member("release-canary", { text: "Canary is mandatory. token=sk-canary-secret" });
  f.load([{ id: "new-analysis-cluster-id", members: [...previous.members.slice(0, 2), newEvidence] }], false, "run-2");
  f.setResponse(() => synthesis(["m1", "m2", "m3", "m99"], "Release after both the smoke test and canary pass."));
  f.advance();
  const result = await f.run();
  assert.equal(result.created, 0);
  assert.equal(result.revised, 1);
  assert.deepEqual(f.rows("SELECT id,created_ms,revision,cluster_id FROM memory_crystals"), [
    { id: original?.id, created_ms: START, revision: 2, cluster_id: "new-analysis-cluster-id" },
  ]);
  assert.deepEqual(f.rows("SELECT source_kind,target_id,corpus,source_path,doc_hash,quote_excerpt,created_ms FROM core_memories"), [
    { source_kind: "crystal_revision", target_id: original?.id, corpus: "memory", source_path: "qmd://memory/release-canary.md",
      doc_hash: newEvidence.hash, quote_excerpt: "Canary is mandatory. token=[redacted]", created_ms: f.time() },
  ]);
  assert.ok(!f.rows("SELECT doc_hash FROM memory_crystal_members").some(row => row.doc_hash === previous.members[2]?.hash));
});

test("disjoint chunks of the same documents produce distinct crystals", async t => {
  const f = fixture(t);
  const indexed = ["a", "b", "c"].map(name => {
    const smoke = `Smoke test for ${name}.`;
    const backup = `Backup restore for ${name}.`;
    const docHash = hash(`${smoke}\n${backup}`);
    return [member(name, { text: smoke, hash: docHash, chunkPos: 0, chunkLen: smoke.length }),
      member(name, { text: backup, hash: docHash, seq: 1, chunkPos: smoke.length + 1, chunkLen: backup.length })] as const;
  });
  f.load([{ id: "smoke", members: indexed.map(pair => pair[0]) }]);
  assert.equal((await f.run()).created, 1);
  f.advance();
  f.load([{ id: "backup", members: indexed.map(pair => pair[1]) }], false, "run-2");
  f.setResponse(() => synthesis(["m1", "m2", "m3"], "Verify restore from backup before the migration."));
  assert.equal((await f.run()).created, 1);
  assert.deepEqual(f.rows("SELECT cluster_id,revision FROM memory_crystals ORDER BY cluster_id"), [
    { cluster_id: "backup", revision: 1 }, { cluster_id: "smoke", revision: 1 },
  ]);
  assert.equal(f.rows("SELECT id FROM core_memories").length, 0);
});

test("empty analysis still promotes independently by helped outcomes and hit count, and retires stale STM", async t => {
  const f = fixture(t);
  f.load([cluster("helped"), cluster("hits"), cluster("stale"), cluster("no-expiry")]);
  assert.equal((await f.run({ stmStaleAfterMinutes: 1 })).created, 4);
  f.db.exec(`UPDATE memory_crystals SET hit_count=5 WHERE cluster_id='hits';
    UPDATE memory_crystals SET hit_count=3 WHERE cluster_id='stale';
    UPDATE memory_crystals SET stale_after_ms=NULL WHERE cluster_id='no-expiry';`);
  new OutcomeLedgerStore(f.db);
  const outcome = f.db.prepare(`INSERT INTO memory_outcomes
    (id,agent_id,subject_kind,subject_id,verdict,confidence,evidence_turn_id,signals_json,measured_at)
    VALUES (?,?,?,?,?,0.9,?,'{}',?)`);
  for (const [id, agent, kind, path, verdict] of [
    ["h1", "main", "memory_hit", "qmd://memory/helped-a.md", "helped"],
    ["h2", "main", "memory_hit", "qmd://memory/helped-b.md", "helped"],
    ["h3", "main", "memory_hit", "qmd://memory/helped-b.md", "helped"],
    ["x1", "other-agent", "memory_hit", "qmd://memory/stale-a.md", "helped"],
    ["x2", "main", "skill", "qmd://memory/stale-a.md", "helped"],
    ["x3", "main", "memory_hit", "qmd://memory/stale-a.md", "ignored"],
  ] as const) outcome.run(id, agent, kind, path, verdict, id, START);
  f.advance();
  f.clearAnalysis();
  const pass = await f.run({ runner: undefined });
  assert.equal(pass.status, "ok");
  assert.equal(pass.promoted, 2);
  assert.equal(pass.retired, 1);
  assert.equal(f.prompts.length, 4);
  assert.deepEqual(f.rows("SELECT cluster_id,tier,status,stale_after_ms FROM memory_crystals ORDER BY cluster_id"), [
    { cluster_id: "helped", tier: "ltm", status: "active", stale_after_ms: null },
    { cluster_id: "hits", tier: "ltm", status: "active", stale_after_ms: null },
    { cluster_id: "no-expiry", tier: "stm", status: "active", stale_after_ms: null },
    { cluster_id: "stale", tier: "stm", status: "retired", stale_after_ms: START + MINUTE },
  ]);
  f.advance();
  f.load([cluster("stale")]);
  assert.equal((await f.run()).created, 0, "unchanged retired evidence cannot immediately start a new STM");
  assert.equal(f.prompts.length, 4);
});

test("a superseded lease publishes neither late synthesis nor scheduled decay", async t => {
  const f = fixture(t);
  f.load([cluster("stale")]);
  assert.equal((await f.run({ stmStaleAfterMinutes: 1 })).created, 1);
  f.advance();
  f.load([cluster("late-model-response")]);
  f.setResponse(() => {
    assert.equal(f.workStore.interruptOwner("crystallizer-test", f.time()), 1);
    return synthesis(["m1"], "A superseded worker must not publish this.");
  });
  const result = await f.run();
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "fence_lost");
  assert.equal(result.created, 0);
  assert.equal(result.retired, 0);
  assert.deepEqual(f.rows("SELECT cluster_id,status FROM memory_crystals"), [{ cluster_id: "stale", status: "active" }]);
  assert.equal(f.rows("SELECT crystal_id FROM memory_crystal_members").length, 3);
  assert.equal(f.rows("SELECT id FROM core_memories").length, 0);
  assert.equal(f.item()?.status, "pending");
  assert.equal(f.item()?.artifactJson, null);
  assert.equal(f.item()?.strikes, 0);
});

/* ───────────── v0.21.0 regressions ───────────── */

type QmdDb = QMDStore["internal"]["db"];

/** A real QMD index with a real analysis run, read back through the native `readClusters` / `readCluster` seam. */
async function realAnalysis(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "crystals-real-analysis-"));
  const store = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  const db: QmdDb = store.internal.db;
  ensureMemoryAnalysisSchema(db);
  db.prepare(`INSERT INTO memory_analysis_runs (id,created_at,completed_at,input_digest,model,embedding_fingerprint,dimensions,params_json,stale_at)
    VALUES ('run-real','2026-11-27T18:00:00Z','2026-11-27T18:00:00Z','digest','model','fingerprint',768,'{}',NULL)`).run();
  let clusterId = 0;
  /** Each document has TWO indexed chunks; only the second (pos > 0) joins the cluster. */
  const addCluster = (names: readonly string[], aliases: (name: string) => Array<{ collection: string; path: string; modifiedAt: string }>) => {
    clusterId += 1;
    db.prepare("INSERT INTO memory_analysis_clusters (run_id,cluster_id,size,mean_probability) VALUES ('run-real',?,?,0.9)").run(clusterId, names.length);
    return names.map((name, index) => {
      const header = `# ${name}\nUnrelated preamble for ${name}.\n`;
      const chunk = `Deploys for ${name} require the green smoke test before release.`;
      const doc = `${header}${chunk}`;
      const docHash = hash(doc);
      db.prepare("INSERT INTO content(hash,doc,created_at) VALUES (?,?,?)").run(docHash, doc, AT);
      for (const alias of aliases(name)) {
        db.prepare(`INSERT INTO documents(collection,path,title,hash,created_at,modified_at,active) VALUES (?,?,?,?,?,?,1)`)
          .run(alias.collection, alias.path, name, docHash, AT, alias.modifiedAt);
      }
      const vector = db.prepare(`INSERT INTO content_vectors(hash,seq,pos,chunk_len,model,embed_fingerprint,total_chunks,embedded_at)
        VALUES (?,?,?,?,'model','fingerprint',2,?)`);
      vector.run(docHash, 0, 0, header.length, AT);
      vector.run(docHash, 1, header.length, chunk.length, AT);
      db.prepare(`INSERT INTO memory_analysis_memberships (run_id,hash,seq,cluster_id,probability,outlier_score,x,y,representative_rank)
        VALUES ('run-real',?,1,?,0.9,0.1,0,0,?)`).run(docHash, clusterId, index + 1);
      return { docHash, chunk, pos: header.length };
    });
  };
  const analysis: CrystalsAnalysis = {
    async listClusters(limit) { return readClusters(db, limit); },
    async fetchCluster({ clusterId: id, memberLimit, sort, offset }) { return readCluster(db, id, memberLimit, offset, sort); },
  };
  return { db, analysis, addCluster };
}

test("real readCluster output (multi-chunk documents) crystallizes into a cited STM crystal at the indexed span", async t => {
  const f = fixture(t);
  const real = await realAnalysis(t);
  const members = real.addCluster(["alpha", "beta", "gamma"], name => [{ collection: "memory", path: `notes/${name}.md`, modifiedAt: AT }]);
  const fetched = await real.analysis.fetchCluster({ clusterId: (await real.analysis.listClusters(50)).clusters[0]!.clusterId });
  assert.deepEqual(fetched.members?.map(member => [member.chunkPos, member.chunkLen, member.sourceCollections]),
    members.map(member => [member.pos, member.chunk.length, ["memory"]]), "the native seam returns locators and exhaustive collections");
  const result = await f.run({ analysis: real.analysis, corpusForCollection: id => id === "memory" ? "memory" : undefined });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.created, 1);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(f.prompts[0]?.members.map(member => member.text), members.map(member => member.chunk));
  assert.deepEqual(f.rows("SELECT tier,status,audience_key,corpora_json FROM memory_crystals"),
    [{ tier: "stm", status: "active", audience_key: "workspace", corpora_json: '["memory"]' }]);
  assert.deepEqual(f.rows("SELECT corpus,source_path,doc_hash,chunk_pos,chunk_len,quote_sha256 FROM memory_crystal_members ORDER BY ordinal"),
    ["alpha", "beta", "gamma"].map((name, index) => ({ corpus: "memory", source_path: `qmd://memory/notes/${name}.md`,
      doc_hash: members[index]!.docHash, chunk_pos: members[index]!.pos, chunk_len: members[index]!.chunk.length,
      quote_sha256: hash(members[index]!.chunk) })));
});

test("a restricted 6th alias hidden behind five display-capped memory aliases is still caught by sourceCollections", async t => {
  const f = fixture(t);
  const real = await realAnalysis(t);
  real.addCluster(["leaky", "plain-b", "plain-c"], name => name !== "leaky"
    ? [{ collection: "memory", path: `notes/${name}.md`, modifiedAt: AT }]
    : [...["a", "b", "c", "d", "e"].map(letter => ({ collection: "memory", path: `copies/${letter}.md`, modifiedAt: AT })),
      { collection: "vault", path: "board/secret.md", modifiedAt: "2020-01-01T00:00:00.000Z" }]);
  const detail = await real.analysis.fetchCluster({ clusterId: (await real.analysis.listClusters(50)).clusters[0]!.clusterId });
  const leaky = detail.members!.find(member => member.sourceCollections?.includes("vault"))!;
  assert.equal(leaky.sourcePaths.length, 5, "the display list is capped");
  assert.ok(leaky.sourcePaths.every(path => path.startsWith("qmd://memory/")), "the restricted alias is invisible in sourcePaths");
  const result = await f.run({ analysis: real.analysis,
    corpusForCollection: id => ({ memory: "memory", vault: "board-private" } as Record<string, string>)[id] });
  assert.equal(result.status, "ok");
  assert.ok(result.skippedAudience >= 1);
  assert.equal(result.created, 0);
  assert.equal(f.prompts.length, 0, "nothing from the cluster reached the model");
});

test("one cluster's model failure is isolated: other crystals commit and promotion/decay still run", async t => {
  const f = fixture(t);
  f.load([cluster("expiring")]);
  assert.equal((await f.run({ stmStaleAfterMinutes: 1 })).created, 1);
  f.advance();
  f.load([cluster("good"), cluster("bad"), cluster("also-good")]);
  f.setResponse(prompt => prompt.members[0]?.text.includes("bad-a")
    ? ({ shouldCrystallize: "yes" } as unknown as CrystalSynthesis) : synthesis(["m1", "m2"]));
  const result = await f.run({ stmStaleAfterMinutes: 1 });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.created, 2);
  assert.equal(result.retired, 1, "decay still ran");
  assert.equal(result.synthesized, 3);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /^bad:(?:invalid_output|transient_provider)$/u, "the failing cluster is named with its code");
  assert.deepEqual(f.rows("SELECT cluster_id,status FROM memory_crystals ORDER BY cluster_id"), [
    { cluster_id: "also-good", status: "active" }, { cluster_id: "expiring", status: "retired" }, { cluster_id: "good", status: "active" },
  ]);
  assert.equal(f.item()?.status, "pending");
  assert.equal(f.item()?.strikes, 0);
});

test("missing credentials stop further model calls but still re-verify, promote and decay", async t => {
  const f = fixture(t);
  f.load([cluster("kept"), cluster("expiring")]);
  assert.equal((await f.run({ stmStaleAfterMinutes: 10 })).created, 2);
  f.db.exec("UPDATE memory_crystals SET stale_after_ms=0 WHERE cluster_id='expiring'");
  f.advance();
  let calls = 0;
  const runner: CrystalsPassOptions["runner"] = { async complete() {
    calls += 1;
    return { ok: false, code: "missing_credentials", error: "no key", retryable: false, usage: { requests: 0 } };
  } };
  f.load([cluster("kept"), cluster("new-a"), cluster("new-b")]);
  const result = await f.run({ runner, stmStaleAfterMinutes: 10 });
  assert.equal(result.status, "ok");
  assert.equal(calls, 1, "no further model calls after a credential fault");
  assert.deepEqual(result.errors, ["new-a:missing_credentials"]);
  assert.equal(result.skippedUnchanged, 1);
  assert.equal(result.retired, 1);
});

test("re-verifying an unchanged STM crystal renews stale_after_ms so it never retires on the pass that verified it", async t => {
  const f = fixture(t);
  f.load([cluster("healthy")]);
  assert.equal((await f.run({ stmStaleAfterMinutes: 10 })).created, 1);
  f.advance(); // 6h later: far past the 10-minute STM window.
  const result = await f.run({ stmStaleAfterMinutes: 10 });
  assert.equal(result.skippedUnchanged, 1);
  assert.equal(result.retired, 0);
  assert.deepEqual(f.rows("SELECT status,verified_ms,stale_after_ms FROM memory_crystals"),
    [{ status: "active", verified_ms: f.time(), stale_after_ms: f.time() + 10 * MINUTE }]);
  f.advance();
  assert.equal((await f.run({ stmStaleAfterMinutes: 0 })).skippedUnchanged, 1);
  assert.deepEqual(f.rows("SELECT stale_after_ms FROM memory_crystals"), [{ stale_after_ms: null }], "0 = never stale");
});

test("maxClustersPerRun counts synthesis attempts only, never unchanged or private clusters", async t => {
  const f = fixture(t);
  f.load([cluster("known")]);
  assert.equal((await f.run()).created, 1);
  f.advance();
  const restricted = cluster("restricted");
  restricted.members[0] = member("dm", { sourcePaths: ["qmd://sessions/direct/dm.md"] });
  f.load([cluster("known"), restricted, cluster("fresh-1"), cluster("fresh-2")]);
  const result = await f.run({ maxClustersPerRun: 1 });
  assert.equal(result.skippedUnchanged, 1);
  assert.equal(result.skippedAudience, 1);
  assert.equal(result.synthesized, 1);
  assert.equal(result.created, 1, "the budget reaches the first cluster that actually needs synthesis");
  assert.equal(f.prompts.length, 2);
  assert.deepEqual(f.rows("SELECT cluster_id FROM memory_crystals ORDER BY cluster_id"), [{ cluster_id: "fresh-1" }, { cluster_id: "known" }]);
});

test("allowedCorpora is the source of truth: explicitly listing sessions opts session evidence in (unresolved source ids never)", async t => {
  const f = fixture(t);
  const personal = cluster("personal-ea");
  personal.members[0] = member("dm", { text: "Victoria prefers morning flights.", sourcePaths: ["qmd://sessions/direct/dm.md"],
    eventTimeSource: "qmd://sessions/direct/dm.md", eventTimeBasis: "session" });
  personal.members[1] = member("chat", { text: "Victoria books aisle seats.", sourcePaths: ["qmd://source-aaaaaaaaaaaa/chat.md"],
    eventTimeSource: "qmd://source-aaaaaaaaaaaa/chat.md", sourceCollections: ["source-aaaaaaaaaaaa"] });
  const opaque = cluster("opaque");
  opaque.members[0] = member("unresolved", { sourcePaths: ["qmd://source-bbbbbbbbbbbb/x.md"], eventTimeSource: "qmd://source-bbbbbbbbbbbb/x.md" });
  f.load([personal, opaque]);
  const resolve = (id: string) => id === "source-aaaaaaaaaaaa" ? "sessions" : undefined;

  const safe = await f.run({ corpusForCollection: resolve });
  assert.equal(safe.skippedAudience, 2, "the default allowedCorpora keeps sessions out");
  assert.equal(safe.created, 0);
  assert.equal(f.prompts.length, 0);

  f.advance();
  const optedIn = await f.run({ corpusForCollection: resolve, allowedCorpora: ["memory", "knowledge", "sessions"] });
  assert.equal(optedIn.created, 1, "an explicitly allowed sessions corpus is honored");
  assert.equal(optedIn.skippedAudience, 1, "an unresolved native source id is still never trusted");
  assert.match(JSON.stringify(f.prompts), /morning flights/u);
  assert.deepEqual(f.rows("SELECT cluster_id,corpora_json FROM memory_crystals"),
    [{ cluster_id: "personal-ea", corpora_json: '["memory","sessions"]' }]);
});
