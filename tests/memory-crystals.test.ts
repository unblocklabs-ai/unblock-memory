import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  ensureMemoryCrystalsSchema, findMatchingCrystalsReadOnly, listCoreMemories, MEMORY_CRYSTALS_COMPONENT, MemoryCrystalsStore,
  recordCrystalHits, recordCrystalHitsAtPath, summarizeCrystals, type CrystalMemberInput, type UpsertCrystalInput,
} from "../src/memory-crystals.js";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const HOUR = 3_600_000;
const AUDIENCE = "channel:slack:T1:c-acme";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "memory-crystals-"));
  const path = join(root, "unblock-memory.sqlite");
  const store = new MemoryCrystalsStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, db: store.db };
}

const memberOf = (doc: string, overrides: Partial<CrystalMemberInput> = {}): CrystalMemberInput => ({
  corpus: "memory", sourcePath: `memory/${doc}.md`, docHash: `hash-${doc}`, chunkPos: 0, chunkLen: 120,
  quoteSha256: sha(`quote ${doc}`), observedMs: NOW - HOUR, ...overrides,
});

const base = (overrides: Partial<UpsertCrystalInput> = {}): UpsertCrystalInput => ({
  id: "crystal-acme-launch", agentId: "main", title: "Acme launch plan",
  summary: "Acme launch slipped to March because the Shopify inventory sync is blocked on rate limits.",
  audienceKey: AUDIENCE, corpora: ["memory"], members: [memberOf("2026-11-20"), memberOf("2026-11-21")],
  inputDigest: "digest-1", brightness: 0.6, staleAfterMs: NOW + 24 * HOUR, nowMs: NOW, ...overrides,
});

test("plain Node loads the store without OpenClaw and registers memory_crystals v1 with the shared contract", () => {
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { registerHooks } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "openclaw" || specifier.startsWith("openclaw/") || specifier.startsWith("@openclaw/")) {
        throw new Error("Unexpected host SDK import");
      }
      return nextResolve(specifier, context);
    } });
    const { MemoryCrystalsStore, findMatchingCrystalsReadOnly } = await import(${JSON.stringify(new URL("../src/memory-crystals.ts", import.meta.url).href)});
    const db = new DatabaseSync(":memory:");
    new MemoryCrystalsStore(db).close();
    findMatchingCrystalsReadOnly(db, { agentId: "main", queryText: "x y", audienceKeys: ["a"], allowedCorpora: ["memory"] });
    db.close();
  `]);
  const db = new DatabaseSync(":memory:");
  try {
    const store = new MemoryCrystalsStore(db);
    new MemoryCrystalsStore(db).close(); // Idempotent on a borrowed connection.
    ensureMemoryCrystalsSchema(db);
    store.close();
    assert.equal(db.isOpen, true, "borrowed connections stay open");
    assert.equal(db.prepare("SELECT version FROM memory_schema WHERE component=?").get(MEMORY_CRYSTALS_COMPONENT)?.version, 1);
    for (const table of ["memory_crystals", "memory_crystal_members", "core_memories"]) {
      assert.equal(db.prepare("SELECT strict FROM pragma_table_list WHERE name=?").get(table)?.strict, 1, `${table} is STRICT`);
    }
    const indexes = db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_%' ORDER BY name").all().map(row => row.name);
    assert.deepEqual(indexes, ["idx_core_memories_agent_source", "idx_core_memories_agent_time", "idx_memory_crystals_agent_audience",
      "idx_memory_crystals_agent_digest", "idx_memory_crystals_agent_status_tier"]);
    assert.deepEqual(db.prepare("PRAGMA table_info(memory_crystals)").all().map(row => row.name), ["id", "agent_id", "tier", "revision",
      "title", "summary", "audience_key", "corpora_json", "status", "cluster_id", "input_digest", "recipe_hash", "brightness", "hit_count",
      "created_ms", "verified_ms", "stale_after_ms"]);
    assert.deepEqual(db.prepare("PRAGMA table_info(memory_crystal_members)").all().map(row => row.name), ["crystal_id", "ordinal", "corpus",
      "source_path", "doc_hash", "chunk_pos", "chunk_len", "quote_sha256", "observed_ms"]);
    assert.deepEqual(db.prepare("PRAGMA table_info(core_memories)").all().map(row => row.name), ["id", "agent_id", "source_kind", "target_id",
      "corpus", "source_path", "doc_hash", "quote_excerpt", "reason", "created_ms"]);
    assert.throws(() => db.exec(`INSERT INTO memory_crystals (id, agent_id, tier, title, summary, audience_key, corpora_json, status,
      input_digest, created_ms, verified_ms) VALUES ('x','main','mtm','t','s','a','[]','active','d',0,0)`), /CHECK constraint/);
    assert.throws(() => db.exec(`INSERT INTO core_memories VALUES ('x','main','vibes','t','c','p',NULL,'q','r',0)`), /CHECK constraint/);
    db.exec("UPDATE memory_schema SET version=2 WHERE component='memory_crystals'");
    assert.throws(() => new MemoryCrystalsStore(db), /Unsupported memory_crystals schema version/);
  } finally { db.close(); }
});

test("create → verify (no revision bump) → revise bumps revision and retroactively anchors core memories", t => {
  const { store } = fixture(t);
  const created = store.upsertCrystal(base());
  assert.equal(created.action, "created");
  assert.equal(created.crystal.revision, 1);
  assert.equal(created.crystal.tier, "stm");
  assert.equal(created.crystal.members?.length, 2);
  assert.deepEqual(created.crystal.members?.map(item => item.ordinal), [0, 1]);
  assert.deepEqual(created.coreMemoriesAdded, []);

  const verified = store.upsertCrystal(base({ brightness: 0.8, nowMs: NOW + HOUR, title: "ignored on verify" }));
  assert.equal(verified.action, "verified");
  assert.equal(verified.crystal.revision, 1);
  assert.equal(verified.crystal.brightness, 0.8);
  assert.equal(verified.crystal.verifiedMs, NOW + HOUR);
  assert.equal(verified.crystal.title, "Acme launch plan", "an unchanged digest never rewrites content");

  const refreshed = store.upsertCrystal(base({ inputDigest: "digest-1b", members: [memberOf("2026-11-20"), memberOf("2026-11-22")],
    nowMs: NOW + 2 * HOUR }));
  assert.equal(refreshed.action, "refreshed", "new evidence that does not change the crystal is not a core memory");
  assert.equal(refreshed.crystal.revision, 1);
  assert.deepEqual(refreshed.coreMemoriesAdded, []);

  const revised = store.upsertCrystal(base({
    inputDigest: "digest-2", nowMs: NOW + 3 * HOUR,
    summary: "Acme launch moved to April: Shopify granted a rate-limit increase but legal review is now the blocker.",
    members: [memberOf("2026-11-20"), memberOf("2026-11-22"), memberOf("2026-11-25", { quoteExcerpt: "Legal flagged the Acme terms" })],
  }));
  assert.equal(revised.action, "revised");
  assert.equal(revised.crystal.revision, 2);
  assert.match(revised.crystal.summary, /April/);
  assert.equal(revised.crystal.members?.length, 3);
  assert.equal(revised.coreMemoriesAdded.length, 1, "only the doc new to this revision is a core memory");
  const [core] = revised.coreMemoriesAdded;
  assert.equal(core?.sourceKind, "crystal_revision");
  assert.equal(core?.targetId, "crystal-acme-launch");
  assert.equal(core?.sourcePath, "memory/2026-11-25.md");
  assert.equal(core?.docHash, "hash-2026-11-25");
  assert.equal(core?.quoteExcerpt, "Legal flagged the Acme terms");
  assert.match(core?.reason ?? "", /revised to r2/);
  assert.equal(core?.createdMs, NOW + 3 * HOUR);

  // Retrying the same revision content is a verify, and re-recording the anchor is deduped.
  assert.equal(store.upsertCrystal(base({ inputDigest: "digest-2", summary: revised.crystal.summary,
    members: [memberOf("2026-11-25")] })).action, "verified");
  const again = store.recordCoreMemory({ agentId: "main", sourceKind: "crystal_revision", targetId: "crystal-acme-launch", corpus: "memory",
    sourcePath: "memory/2026-11-25.md", docHash: "hash-2026-11-25", quoteExcerpt: "dup", reason: "retry" });
  assert.equal(again.recorded, false);
  assert.equal(again.coreMemory.id, core?.id);
  assert.equal(store.listCoreMemories({ agentId: "main" }).length, 1);

  // Caller-specified triggering evidence overrides the computed set.
  const explicit = store.upsertCrystal(base({
    inputDigest: "digest-3", title: "Acme launch plan (legal)", nowMs: NOW + 4 * HOUR,
    members: [memberOf("2026-11-25"), memberOf("2026-11-26")],
    triggeringMembers: [{ corpus: "memory", sourcePath: "memory/2026-11-25.md", docHash: "hash-2026-11-25-v2", quoteExcerpt: "Legal signed off" }],
    revisionReason: "Legal blocker cleared",
  }));
  assert.equal(explicit.action, "revised");
  assert.equal(explicit.crystal.revision, 3);
  assert.deepEqual(explicit.coreMemoriesAdded.map(item => [item.docHash, item.reason]), [["hash-2026-11-25-v2", "Legal blocker cleared"]]);
  assert.equal(store.listCoreMemories({ agentId: "main", limit: 1 })[0]?.docHash, "hash-2026-11-25-v2", "newest first");
  assert.equal(store.listCoreMemories({ agentId: "main", limit: 0 }).length, 2, "limit 0 = unlimited");
  assert.equal(store.listCoreMemories({ agentId: "main", sourceKind: "voltaire_shift" }).length, 0);
});

test("upsert validation, agent isolation and audience immutability", t => {
  const { store } = fixture(t);
  assert.throws(() => store.upsertCrystal(base({ id: " " })), /id must be a non-empty string/);
  assert.throws(() => store.upsertCrystal(base({ members: [] })), /at least one member/);
  assert.throws(() => store.upsertCrystal(base({ members: [memberOf("a", { quoteSha256: "nothex" })] })), /quoteSha256/);
  assert.throws(() => store.upsertCrystal(base({ members: [memberOf("a", { chunkLen: 0 })] })), /chunkLen/);
  assert.throws(() => store.upsertCrystal(base({ corpora: [] })), /corpora/);
  assert.throws(() => store.upsertCrystal(base({ summary: "  " })), /summary/);
  assert.throws(() => store.upsertCrystal(base({ brightness: 1.5 })), /brightness/);

  store.upsertCrystal(base({ members: [memberOf("a", { corpus: "sessions" })] }));
  assert.deepEqual(store.getCrystal("crystal-acme-launch", "main")?.corpora, ["memory", "sessions"], "member corpora always join the ACL set");

  const widened = store.upsertCrystal(base({ audienceKey: "workspace", inputDigest: "digest-2", summary: "Widened summary about Acme launch." }));
  assert.equal(widened.action, "revised");
  assert.equal(widened.audienceLocked, true);
  assert.equal(widened.crystal.audienceKey, AUDIENCE, "an existing crystal's audience is never widened");
  assert.equal(store.listCrystals({ agentId: "main", audienceKey: "workspace" }).length, 0);

  assert.throws(() => store.upsertCrystal(base({ agentId: "other" })), /belongs to another agent/);
  assert.equal(store.getCrystal("crystal-acme-launch", "other"), undefined);
});

test("LTM promotion, retirement, brightness and list filters", t => {
  const { store } = fixture(t);
  store.upsertCrystal(base());
  store.upsertCrystal(base({ id: "crystal-b", brightness: 0.9 }));
  assert.equal(store.promoteCrystalToLtm("crystal-acme-launch", "other", NOW), false);
  assert.equal(store.promoteCrystalToLtm("crystal-acme-launch", "main", NOW + HOUR), true);
  assert.equal(store.promoteCrystalToLtm("crystal-acme-launch", "main", NOW + HOUR), false, "already ltm");
  const ltm = store.getCrystal("crystal-acme-launch", "main")!;
  assert.equal(ltm.tier, "ltm");
  assert.equal(ltm.staleAfterMs, null);
  // An LTM crystal never regains a stale deadline through upsert.
  assert.equal(store.upsertCrystal(base({ staleAfterMs: NOW + HOUR })).crystal.staleAfterMs, null);

  assert.equal(store.updateCrystalBrightness("crystal-b", "main", 0.2, NOW), true);
  assert.throws(() => store.updateCrystalBrightness("crystal-b", "main", -1, NOW), /brightness/);
  assert.deepEqual(store.listCrystals({ agentId: "main" }).map(item => item.id), ["crystal-acme-launch", "crystal-b"], "brightest first");
  assert.deepEqual(store.listCrystals({ agentId: "main", tier: "stm" }).map(item => item.id), ["crystal-b"]);
  assert.equal(store.listCrystals({ agentId: "main", limit: 1 }).length, 1);
  assert.throws(() => store.listCrystals({ agentId: "main", limit: -1 }), /limit/);

  assert.equal(store.retireCrystal("crystal-b", "main", NOW), true);
  assert.equal(store.retireCrystal("crystal-b", "main", NOW), false);
  assert.deepEqual(store.listCrystals({ agentId: "main", status: "active" }).map(item => item.id), ["crystal-acme-launch"]);
  const ignored = store.upsertCrystal(base({ id: "crystal-b", inputDigest: "digest-9", summary: "resurrected" }));
  assert.equal(ignored.action, "ignored_retired");
  assert.equal(ignored.crystal.status, "retired");
  assert.notEqual(ignored.crystal.summary, "resurrected");

  const summary = store.summarize("main");
  assert.deepEqual({ total: summary.total, byTier: summary.byTier, byStatus: summary.byStatus, activeByTier: summary.activeByTier },
    { total: 2, byTier: { stm: 1, ltm: 1 }, byStatus: { active: 1, retired: 1 }, activeByTier: { stm: 0, ltm: 1 } });
  assert.equal(summary.coreMemoriesCount, 0);
});

test("secrets are redacted from title, summary, quote excerpts and reasons before writing", t => {
  const { store, db } = fixture(t);
  const result = store.upsertCrystal(base({
    title: "Deploy notes token=abc123secret",
    summary: "Use sk-livekey1234567890 and post to https://hooks.slack.com/services/T000/B000/XXXX for Acme deploys.",
  }));
  const revised = store.upsertCrystal(base({
    inputDigest: "digest-2", summary: "Rotated: api_key: hunter2 for Acme deploys.",
    members: [memberOf("new", { quoteExcerpt: "Bearer eyJhbGciOiJIUzI1NiJ9.payload" })],
    revisionReason: "password=letmein rotated",
  }));
  const dump = JSON.stringify(db.prepare("SELECT * FROM memory_crystals").all()) + JSON.stringify(db.prepare("SELECT * FROM core_memories").all());
  for (const secret of ["abc123secret", "sk-livekey", "hooks.slack.com", "hunter2", "eyJhbGci", "letmein"]) {
    assert.equal(dump.includes(secret), false, `${secret} must never be persisted`);
  }
  assert.match(result.crystal.title, /\[redacted\]/);
  assert.match(revised.coreMemoriesAdded[0]?.quoteExcerpt ?? "", /\[redacted\]/);
});

test("findMatchingCrystalsReadOnly: missing DB returns [] without creating a file", t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "memory-crystals-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "nope.sqlite");
  const query = { agentId: "main", queryText: "Acme launch shopify", audienceKeys: [AUDIENCE], allowedCorpora: ["memory"] };
  assert.deepEqual(findMatchingCrystalsReadOnly(path, query), []);
  assert.equal(summarizeCrystals(path, "main").total, 0);
  assert.equal(existsSync(path), false, "a read-only probe never creates the database");
  // A database without the tables is not migrated either.
  const bare = join(root, "bare.sqlite");
  new DatabaseSync(bare).close();
  assert.deepEqual(findMatchingCrystalsReadOnly(bare, query), []);
  const probe = new DatabaseSync(bare);
  try { assert.equal(probe.prepare("SELECT COUNT(*) AS n FROM sqlite_schema").get()?.n, 0); } finally { probe.close(); }
  // A corrupt file fails closed on the hot path instead of throwing into the turn.
  const corrupt = join(root, "corrupt.sqlite");
  writeFileSync(corrupt, "definitely not sqlite");
  assert.deepEqual(findMatchingCrystalsReadOnly(corrupt, query), []);
  // Caller bugs in tuning params still throw.
  assert.throws(() => findMatchingCrystalsReadOnly(path, { ...query, maxResults: -1 }), /maxResults/);
});

test("findMatchingCrystalsReadOnly enforces exact agent, audienceKeys, corpora subset and staleness", t => {
  const { store, path } = fixture(t);
  const summary = "Acme launch slipped because the Shopify inventory sync is blocked on rate limits.";
  store.upsertCrystal(base({ id: "ok", summary }));
  store.upsertCrystal(base({ id: "dm", summary, audienceKey: "direct:slack:T1:U9" }));
  store.upsertCrystal(base({ id: "wide-corpora", summary, corpora: ["memory", "sessions"] }));
  store.upsertCrystal(base({ id: "stale", summary, staleAfterMs: NOW - 1 }));
  store.upsertCrystal(base({ id: "retired", summary }));
  store.retireCrystal("retired", "main", NOW);
  store.upsertCrystal(base({ id: "other-agent", agentId: "other", summary }));
  store.close();

  const query = { agentId: "main", queryText: "what's the status of the Acme Shopify sync?", audienceKeys: [AUDIENCE],
    allowedCorpora: ["memory"], nowMs: NOW };
  assert.deepEqual(findMatchingCrystalsReadOnly(path, query).map(match => match.crystal.id), ["ok"]);
  assert.deepEqual(findMatchingCrystalsReadOnly(path, { ...query, allowedCorpora: ["memory", "sessions"] }).map(match => match.crystal.id).sort(),
    ["ok", "wide-corpora"]);
  assert.deepEqual(findMatchingCrystalsReadOnly(path, { ...query, audienceKeys: [AUDIENCE, "direct:slack:T1:U9"] })
    .map(match => match.crystal.id).sort(), ["dm", "ok"]);
  assert.deepEqual(findMatchingCrystalsReadOnly(path, { ...query, audienceKeys: [] }), []);
  assert.deepEqual(findMatchingCrystalsReadOnly(path, { ...query, allowedCorpora: [] }), []);
  assert.deepEqual(findMatchingCrystalsReadOnly(path, { ...query, allowedCorpora: ["sessions"] }), []);
  assert.deepEqual(findMatchingCrystalsReadOnly(path, { ...query, nowMs: NOW - 10 }).map(match => match.crystal.id).sort(), ["ok", "stale"],
    "staleness is evaluated against nowMs");
  assert.deepEqual(findMatchingCrystalsReadOnly(path, { ...query, agentId: "other" }).map(match => match.crystal.id), ["other-agent"]);
  assert.deepEqual(findMatchingCrystalsReadOnly(path, { ...query, queryText: "Shopify" }), [], "one shared token is never enough");
  assert.deepEqual(findMatchingCrystalsReadOnly(path, { ...query, queryText: "tell me about the weather today please" }), []);
});

test("findMatchingCrystalsReadOnly ranks by match × brightness with an LTM tie-break, and maxResults 0 is unlimited", t => {
  const { store, db } = fixture(t);
  const summary = "Acme launch slipped because the Shopify inventory sync is blocked on rate limits.";
  store.upsertCrystal(base({ id: "dim", summary, brightness: 0.1 }));
  store.upsertCrystal(base({ id: "bright", summary, brightness: 0.9 }));
  store.upsertCrystal(base({ id: "stm-twin", summary, brightness: 0.5 }));
  store.upsertCrystal(base({ id: "ltm-twin", summary, brightness: 0.5 }));
  store.promoteCrystalToLtm("ltm-twin", "main", NOW);
  for (let index = 0; index < 5; index++) store.upsertCrystal(base({ id: `extra-${index}`, summary, brightness: 0.3 }));

  const query = { agentId: "main", queryText: "Acme Shopify inventory sync blocked", audienceKeys: [AUDIENCE], allowedCorpora: ["memory"],
    nowMs: NOW };
  const all = findMatchingCrystalsReadOnly(db, { ...query, maxResults: 0 });
  assert.equal(all.length, 9, "maxResults 0 = unlimited");
  assert.deepEqual(all.slice(0, 3).map(match => match.crystal.id), ["bright", "ltm-twin", "stm-twin"]);
  assert.equal(all.at(-1)?.crystal.id, "dim");
  const top = all[0]!;
  assert.equal(top.matchScore, 1);
  assert.equal(top.sharedTokens, 5);
  assert.ok(Math.abs(top.score - (0.7 + 0.3 * 0.9)) < 1e-9);
  assert.equal(top.crystal.members, undefined, "members are opt-in on the hot path");
  assert.equal(findMatchingCrystalsReadOnly(db, { ...query, maxResults: 2 }).length, 2);
  assert.equal(findMatchingCrystalsReadOnly(db, { ...query, maxResults: 1, includeMembers: true })[0]?.crystal.members?.length, 2);
  assert.equal(findMatchingCrystalsReadOnly(db, query).length, 9, "omitted maxResults = unlimited");
  assert.deepEqual(findMatchingCrystalsReadOnly(db, { ...query, ltmRankBoost: 0 }).slice(1, 3).map(match => match.crystal.id),
    ["ltm-twin", "stm-twin"], "equal scores still prefer ltm");
  assert.equal(findMatchingCrystalsReadOnly(db, { ...query, minTokenOverlap: 1, queryText: "Acme Shopify unrelated words galore" }).length, 0);
  assert.throws(() => findMatchingCrystalsReadOnly(db, { ...query, minTokenOverlap: 2 }), /minTokenOverlap/);

  assert.equal(store.recordCrystalHits(["bright", "bright", "missing"], "main"), 1);
  assert.equal(store.getCrystal("bright", "main")?.hitCount, 1);
  assert.equal(listCoreMemories(db, { agentId: "main" }).length, 0);
});

test("recordCrystalHits is zero-stall: a busy ledger drops the hit immediately and a borrowed busy_timeout is restored", t => {
  const { path, store } = fixture(t);
  store.upsertCrystal(base({ id: "hot", audienceKey: "workspace" }));
  const locker = new DatabaseSync(path);
  const borrowed = new DatabaseSync(path);
  t.after(() => { try { locker.exec("ROLLBACK"); } catch {} locker.close(); borrowed.close(); });
  borrowed.exec("PRAGMA busy_timeout = 5000");
  locker.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  assert.throws(() => recordCrystalHitsAtPath(path, ["hot"], "main"), /locked|busy/iu);
  assert.throws(() => recordCrystalHits(borrowed, ["hot"], "main"), /locked|busy/iu);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `a busy ledger must never stall the Gateway event loop (took ${elapsed.toFixed(0)}ms)`);
  assert.equal(Number(borrowed.prepare("PRAGMA busy_timeout").get()?.timeout), 5000, "the borrowed connection keeps its own timeout");
  locker.exec("ROLLBACK");
  assert.equal(recordCrystalHitsAtPath(path, ["hot"], "main"), 1);
  assert.equal(store.getCrystal("hot", "main")?.hitCount, 1);
});
