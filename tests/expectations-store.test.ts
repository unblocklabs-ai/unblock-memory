import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  conversationAudienceKey, directAudienceKey, EXPECTATIONS_COMPONENT, ExpectationsStore, getExpectation, isAdministrativePeopleTodo,
  listExpectations, normalizeBlockerTopic, redactSecrets, summarizeExpectations, syncDeterministicExpectations,
  withReadOnlyExpectations, type ExpectationInput,
} from "../src/expectations-store.js";
import { listCaptainsLogEntries, resolveCaptainsLogBlocker } from "../src/steward-captains-log.js";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const MINUTE = 60_000;

// Exact production DDL (steward-captains-log.ts / people-store.ts) so ingestion runs against the real shapes.
const CAPTAINS_LOG_DDL = `CREATE TABLE IF NOT EXISTS captains_log_entries (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, day TEXT NOT NULL, captured_at_ms INTEGER NOT NULL, section_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL, topic TEXT NOT NULL, summary TEXT NOT NULL, blocked INTEGER NOT NULL CHECK(blocked IN (0, 1)),
  resolved_at_ms INTEGER, resolution_note TEXT, channels_json TEXT NOT NULL CHECK(json_valid(channels_json)),
  session_refs_json TEXT NOT NULL CHECK(json_valid(session_refs_json))) STRICT;`;
const PEOPLE_TODOS_DDL = `CREATE TABLE IF NOT EXISTS people_todos (
  id TEXT PRIMARY KEY, deduplication_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, context_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'overflow')),
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0), first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  resolved_at TEXT, resolution_note TEXT) STRICT;`;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "expectations-store-"));
  const path = join(root, "unblock-memory.sqlite");
  const store = new ExpectationsStore(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, db: store.db };
}

const base = (overrides: Partial<ExpectationInput> = {}): ExpectationInput => ({
  agentId: "main", dedupKey: "manual:release", kind: "commitment", sourceKind: "manual", sourceRef: "operator",
  audienceKey: "workspace", chatType: "workspace", summary: "Ship the Acme release", expectedState: "Acme release is live",
  dueAtMs: NOW + 60 * MINUTE, nowMs: NOW, ...overrides,
});

function addBlocker(db: DatabaseSync, id: string, options: { agentId?: string; blocked?: 0 | 1; channels?: unknown; topic?: string } = {}) {
  db.prepare(`INSERT INTO captains_log_entries VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)`)
    .run(id, options.agentId ?? "main", "2026-11-27", NOW - MINUTE, "hash", 0, options.topic ?? "Shopify API quota",
      "Acme sync is blocked on the Shopify rate limit", options.blocked ?? 1, JSON.stringify(options.channels ?? ["#acme-ops", "#eng"]),
      JSON.stringify(["session-1"]));
}

function addTodo(db: DatabaseSync, id: string, context: string, status = "open", kind = "missing_dossier") {
  db.prepare(`INSERT INTO people_todos VALUES (?,?,?,?,?,1,?,?,NULL,NULL)`)
    .run(id, `key-${id}`, kind, context, status, "2026-11-27T11:00:00.000Z", "2026-11-27T11:00:00.000Z");
}

// The production `people` columns the gate reads (people-store.ts).
const PEOPLE_DDL = `CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, display_name TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unavailable', 'archived')),
  injection_enabled INTEGER NOT NULL DEFAULT 1 CHECK (injection_enabled IN (0, 1))) STRICT;`;
function addPerson(db: DatabaseSync, id: string, status = "active", injection = 1) {
  db.exec(PEOPLE_DDL);
  db.prepare("INSERT OR REPLACE INTO people VALUES (?,?,?,?)").run(id, id, status, injection);
}

test("plain Node loads the store without OpenClaw and registers schema v1 with the shared contract", () => {
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { registerHooks } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "openclaw" || specifier.startsWith("openclaw/") || specifier.startsWith("@openclaw/")) {
        throw new Error("Unexpected host SDK import");
      }
      return nextResolve(specifier, context);
    } });
    const { ExpectationsStore } = await import(${JSON.stringify(new URL("../src/expectations-store.ts", import.meta.url).href)});
    const db = new DatabaseSync(":memory:");
    new ExpectationsStore(db).close();
    db.close();
  `]);
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ExpectationsStore(db);
    new ExpectationsStore(db).close(); // Idempotent re-open on a borrowed connection.
    store.close();
    assert.equal(db.isOpen, true, "borrowed connections stay open");
    assert.equal(db.prepare("SELECT version FROM memory_schema WHERE component=?").get(EXPECTATIONS_COMPONENT)?.version, 1);
    assert.equal(db.prepare("SELECT strict FROM pragma_table_list WHERE name='expectations'").get()?.strict, 1);
    const indexes = db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='expectations' AND name LIKE 'idx_%' ORDER BY name")
      .all().map(row => row.name);
    assert.deepEqual(indexes, ["idx_expectations_agent_audience", "idx_expectations_agent_channel", "idx_expectations_agent_person",
      "idx_expectations_agent_status_due"]);
    const columns = db.prepare("PRAGMA table_info(expectations)").all().map(row => row.name);
    assert.deepEqual(columns, ["id", "agent_id", "dedup_key", "kind", "source_kind", "source_ref", "audience_key", "chat_type",
      "subject_person_id", "subject_label", "channel", "summary", "expected_state", "due_at_ms", "trigger_spec_json", "evidence_json",
      "status", "surprise_score", "resolution_note", "resolution_evidence_json", "created_at_ms", "updated_at_ms", "resolved_at_ms"]);
    assert.throws(() => db.exec(`INSERT INTO expectations VALUES ('x','main','k','commitment','manual','r','workspace','workspace',
      NULL,NULL,NULL,'s','e',NULL,'{}','{}','open',1.5,NULL,NULL,0,0,NULL)`), /CHECK constraint/);
    assert.throws(() => db.exec(`INSERT INTO expectations VALUES ('x','main','k','wish','manual','r','workspace','workspace',
      NULL,NULL,NULL,'s','e',NULL,'{}','{}','open',NULL,NULL,NULL,0,0,NULL)`), /CHECK constraint/);
    db.exec("UPDATE memory_schema SET version=2 WHERE component='expectations'");
    assert.throws(() => new ExpectationsStore(db), /Unsupported expectations schema version/);
  } finally { db.close(); }
});

test("upsert is idempotent by (agent, dedup_key), preserves resolutions and only reopens explicitly", t => {
  const { store } = fixture(t);
  const first = store.upsertExpectation(base({ triggerSpec: { channels: ["#acme", "#acme", " "], keywords: ["release"], dueLeadMs: 5 } }));
  assert.equal(first.action, "inserted");
  assert.equal(first.expectation.status, "open");
  assert.deepEqual(first.expectation.triggerSpec, { channels: ["#acme"], keywords: ["release"], dueLeadMs: 5 });
  assert.equal(store.upsertExpectation(base({ triggerSpec: { channels: ["#acme"], keywords: ["release"], dueLeadMs: 5 }, nowMs: NOW + 1 })).action, "unchanged");
  assert.equal(store.getExpectation(first.expectation.id, "main")?.updatedAtMs, NOW, "no-op upserts do not churn updated_at");

  // Identity columns are fixed by the first write: a later upsert cannot widen the audience.
  const updated = store.upsertExpectation(base({ summary: "Ship the Acme release (v2)", audienceKey: "direct:acct:u1", chatType: "direct",
    dueAtMs: NOW + 120 * MINUTE, nowMs: NOW + 2 }));
  assert.equal(updated.action, "updated");
  assert.equal(updated.expectation.id, first.expectation.id);
  assert.equal(updated.expectation.audienceKey, "workspace");
  assert.equal(updated.expectation.dueAtMs, NOW + 120 * MINUTE);
  assert.equal(store.upsertExpectation(base({ agentId: "other" })).action, "inserted", "agents are isolated");

  assert.equal(store.resolveExpectation({ id: first.expectation.id, agentId: "other", status: "kept" }), false);
  assert.equal(store.resolveExpectation({ id: first.expectation.id, agentId: "main", status: "kept", surpriseScore: 0.1,
    resolutionNote: "Shipped. token=abc123", resolutionEvidence: { sessionRefs: ["s"] }, resolvedAtMs: NOW + 3 }), true);
  assert.equal(store.resolveExpectation({ id: first.expectation.id, agentId: "main", status: "broken" }), false, "resolves once");
  assert.throws(() => store.resolveExpectation({ id: first.expectation.id, agentId: "main", status: "kept", surpriseScore: 2 }), /0\.\.1/);
  const resolved = store.getExpectation(first.expectation.id, "main")!;
  assert.equal(resolved.status, "kept");
  assert.equal(resolved.surpriseScore, 0.1);
  assert.equal(resolved.resolutionNote, "Shipped. token=[redacted]");
  assert.deepEqual(resolved.resolutionEvidence, { sessionRefs: ["s"] });

  const replay = store.upsertExpectation(base({ summary: "Ship the Acme release (v3)", nowMs: NOW + 4 }));
  assert.equal(replay.action, "updated");
  assert.equal(replay.expectation.status, "kept", "re-upsert preserves the resolution");
  const reopened = store.upsertExpectation(base({ summary: "Ship the Acme release (v3)", reopen: true, nowMs: NOW + 5 }));
  assert.equal(reopened.action, "reopened");
  assert.equal(reopened.expectation.status, "open");
  assert.equal(reopened.expectation.surpriseScore, null);
  assert.equal(reopened.expectation.resolvedAtMs, null);

  assert.throws(() => store.upsertExpectation(base({ dedupKey: "bad", chatType: "direct" })), /direct/);
  assert.throws(() => store.upsertExpectation(base({ dedupKey: "bad", kind: "wish" as never })), /kind/);
  assert.throws(() => store.upsertExpectation(base({ dedupKey: "bad", summary: " " })), /summary/);
});

test("list filters, unlimited default limit and summary statistics", t => {
  const { store, db } = fixture(t);
  for (let i = 0; i < 120; i++) store.upsertExpectation(base({ dedupKey: `bulk:${i}`, dueAtMs: null, kind: "prediction", nowMs: NOW + i }));
  store.upsertExpectation(base({ dedupKey: "due", dueAtMs: NOW - MINUTE, channel: "#acme", subjectPersonId: "p1" }));
  store.upsertExpectation(base({ dedupKey: "dm", audienceKey: directAudienceKey("Slack", "acct", "u1")!, chatType: "direct" }));
  assert.equal(store.listExpectations({ agentId: "main" }).length, 122, "omitted limit is unlimited");
  assert.equal(store.listExpectations({ agentId: "main", limit: 0 }).length, 122, "limit 0 is unlimited");
  assert.equal(store.listExpectations({ agentId: "main", limit: 5 }).length, 5);
  assert.throws(() => store.listExpectations({ agentId: "main", limit: -1 }), /limit/);
  assert.equal(store.listExpectations({ agentId: "main" })[0]?.dedupKey, "due", "due-first ordering");
  assert.deepEqual(store.listExpectations({ agentId: "main", channel: "#acme" }).map(e => e.dedupKey), ["due"]);
  assert.deepEqual(store.listExpectations({ agentId: "main", personId: "p1" }).map(e => e.dedupKey), ["due"]);
  assert.deepEqual(store.listExpectations({ agentId: "main", dueBeforeMs: NOW }).map(e => e.dedupKey), ["due"]);
  assert.deepEqual(store.listExpectations({ agentId: "main", audienceKeys: ["direct:slack:acct:u1"] }).map(e => e.dedupKey), ["dm"]);
  assert.equal(store.listExpectations({ agentId: "main", audienceKeys: [] }).length, 0);
  assert.equal(store.listExpectations({ agentId: "main", kind: ["commitment"] }).length, 2);

  const bulk = store.listExpectations({ agentId: "main", kind: "prediction", limit: 2 });
  store.resolveExpectation({ id: bulk[0]!.id, agentId: "main", status: "right", surpriseScore: 0.2 });
  store.resolveExpectation({ id: bulk[1]!.id, agentId: "main", status: "wrong", surpriseScore: 0.8 });
  const summary = summarizeExpectations(store, "main", NOW);
  assert.equal(summary.total, 122);
  assert.equal(summary.byStatus.open, 120);
  assert.equal(summary.byStatus.right, 1);
  assert.equal(summary.byKind.prediction, 120);
  assert.equal(summary.overdue, 1);
  assert.equal(summary.resolvedWithSurprise, 2);
  assert.ok(Math.abs(summary.averageSurprise! - 0.5) < 1e-9);
  assert.deepEqual(summarizeExpectations(db, "nobody", NOW).averageSurprise, null);
});

test("read helpers tolerate a missing table, a missing file and a read-only connection", t => {
  const { root, path, store } = fixture(t);
  const bare = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(listExpectations(bare, { agentId: "main" }), []);
    assert.equal(getExpectation(bare, "x", "main"), undefined);
    assert.equal(summarizeExpectations(bare, "main").total, 0);
    assert.equal(ExpectationsStore.list(bare, { agentId: "main" }).length, 0);
  } finally { bare.close(); }
  assert.equal(withReadOnlyExpectations(join(root, "missing.sqlite"), "fallback", () => "opened"), "fallback");
  store.upsertExpectation(base());
  const rows = ExpectationsStore.readOnly(path, [], db => {
    assert.throws(() => db.exec("DELETE FROM expectations"), /readonly|read-only/i);
    return ExpectationsStore.list(db, { agentId: "main", status: "open" });
  });
  assert.equal(rows.length, 1);
});

test("audience keys are provider-scoped, conversation-scoped and fail closed", () => {
  assert.equal(directAudienceKey("Slack", "T1", "U1"), "direct:slack:T1:U1");
  assert.notEqual(directAudienceKey("slack", "T1", "U1"), directAudienceKey("discord", "T1", "U1"), "same ids on another provider never collide");
  for (const [provider, account, sender] of [[undefined, "T1", "U1"], ["slack", " ", "U1"], ["slack", "T1", ""]]) {
    assert.equal(directAudienceKey(provider, account, sender), undefined);
  }
  assert.equal(conversationAudienceKey("group", "Slack", "T1", "C0AHZFCAS1K:thread:171"), "group:slack:T1:c0ahzfcas1k");
  assert.equal(conversationAudienceKey("channel", "slack", "T1", "COPS"), "channel:slack:T1:cops");
  assert.equal(conversationAudienceKey("group", "slack", undefined, "G1"), undefined);
  assert.equal(conversationAudienceKey("group", "slack", "T1", null), undefined);
});

test("upserts never pair the workspace audience with a conversation chat type", t => {
  const { store } = fixture(t);
  assert.throws(() => store.upsertExpectation(base({ dedupKey: "pooled", chatType: "group" })), /workspace/);
  assert.throws(() => store.upsertExpectation(base({ dedupKey: "mislabelled", audienceKey: "group:slack:T1:g1" })), /workspace/);
  assert.equal(store.upsertExpectation(base({ dedupKey: "group", chatType: "group", audienceKey: "group:slack:T1:g1" })).action, "inserted");
});

test("Slack incoming webhook URLs are redacted with the other secrets", () => {
  const text = "Alerts go to https://hooks.slack.com/services/T0AAA111/B0BBB222/abcDEF123ghi_jk-l now";
  assert.equal(redactSecrets(text), "Alerts go to [redacted] now");
});

test("redactSecrets is linear on long hyphen-/dot-joined runs and still redacts keyed credentials and URL userinfo", () => {
  for (const input of ["a-".repeat(50_000), "a.".repeat(50_000), "token-".repeat(20_000), "api-key-".repeat(15_000), `https://${"a.".repeat(50_000)}`]) {
    redactSecrets(input); // warm-up
    const started = performance.now();
    assert.equal(redactSecrets(input), input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 20, `${input.slice(0, 8)}… took ${elapsed.toFixed(1)}ms`);
  }
  assert.equal(redactSecrets('my_api_key = "abc" via https://user:pass@db.example.test/x, x-secret-header: q; db_password_v2=1'),
    'my_api_key = [redacted] via https://[redacted]@db.example.test/x, x-secret-header: [redacted]; db_password_v2=[redacted]');
  assert.equal(redactSecrets(`${"a-".repeat(40)}token=hunter2`), `${"a-".repeat(40)}token=[redacted]`, "any identifier prefix is kept");
});

test("deterministic ingestion collapses recurring Captain's Log blockers by topic through their lifecycle", t => {
  const { db } = fixture(t);
  assert.deepEqual(syncDeterministicExpectations(db, "main", NOW), {
    captainsLog: { upserted: 0, resolved: 0, expired: 0, skipped: true },
    peopleTodos: { upserted: 0, resolved: 0, reopened: 0, suppressed: 0, skipped: true }, retired: 0,
  }, "missing optional tables are skipped");
  db.exec(CAPTAINS_LOG_DDL); // The 0.19 ledger shape, without native_channels_json: sync must tolerate it.
  addBlocker(db, "b1");
  addBlocker(db, "b2", { channels: "not-an-array", topic: "Klaviyo access" });
  addBlocker(db, "b3", { blocked: 0 });
  addBlocker(db, "b4", { agentId: "other" });

  let sync = syncDeterministicExpectations(db, "main", NOW);
  assert.deepEqual(sync.captainsLog, { upserted: 2, resolved: 0, expired: 0, skipped: false });
  const [first] = listExpectations(db, { agentId: "main", sourceKind: "captains_log", channel: "#acme-ops" });
  assert.ok(first);
  assert.equal(first.dedupKey, "captains_log_topic:shopify api quota");
  assert.equal(first.kind, "blocker");
  assert.equal(first.audienceKey, "workspace");
  assert.equal(first.chatType, "workspace");
  assert.equal(first.summary, "Shopify API quota");
  assert.equal(first.expectedState, "Acme sync is blocked on the Shopify rate limit");
  assert.deepEqual(first.triggerSpec, { channels: ["#acme-ops", "#eng"] });
  const second = listExpectations(db, { agentId: "main" }).find(e => e.dedupKey === "captains_log_topic:klaviyo access")!;
  assert.equal(second.channel, null, "malformed channels JSON never crashes");
  assert.deepEqual(second.triggerSpec, {});
  assert.equal(syncDeterministicExpectations(db, "main", NOW + 1).captainsLog.upserted, 0, "replays are idempotent");

  // A recurring 3-hourly capture of the same topic (different case/punctuation) collapses into the one row.
  db.prepare(`INSERT INTO captains_log_entries VALUES (?,?,?,?,?,?,?,?,1,NULL,NULL,?,?)`)
    .run("b5", "main", "2026-11-27", NOW + 180 * MINUTE, "hash2", 0, "[BLOCKED] shopify API quota!", "Still rate limited at 3pm",
      JSON.stringify(["#acme-ops"]), JSON.stringify(["session-2"]));
  sync = syncDeterministicExpectations(db, "main", NOW + 181 * MINUTE);
  assert.equal(sync.captainsLog.upserted, 1);
  assert.equal(listExpectations(db, { agentId: "main", sourceKind: "captains_log" }).length, 2, "one row per topic");
  const merged = getExpectation(db, first.id, "main")!;
  assert.equal(merged.expectedState, "Still rate limited at 3pm", "the latest capture refreshes the row");
  assert.equal(merged.sourceRef, "b5");
  assert.equal(merged.updatedAtMs, NOW + 181 * MINUTE);
  assert.deepEqual((merged.evidence as { entryIds: string[] }).entryIds, ["b1", "b5"]);
  assert.deepEqual((merged.evidence as { sessionRefs: string[] }).sessionRefs, ["session-1", "session-2"]);

  // Every linked entry must resolve before the topic row does.
  assert.equal(resolveCaptainsLogBlocker(db, { id: "b1", agentId: "main", resolvedAtMs: NOW + 190 * MINUTE, note: "Quota raised" }), true);
  assert.equal(syncDeterministicExpectations(db, "main", NOW + 191 * MINUTE).captainsLog.resolved, 0);
  assert.equal(resolveCaptainsLogBlocker(db, { id: "b5", agentId: "main", resolvedAtMs: NOW + 200 * MINUTE, note: "Quota raised to 4k" }), true);
  sync = syncDeterministicExpectations(db, "main", NOW + 201 * MINUTE);
  assert.equal(sync.captainsLog.resolved, 1);
  const resolved = getExpectation(db, first.id, "main")!;
  assert.equal(resolved.status, "kept");
  assert.equal(resolved.surpriseScore, 0);
  assert.equal(resolved.resolutionNote, "Quota raised to 4k");
  assert.equal(resolved.resolvedAtMs, NOW + 200 * MINUTE);

  // The same topic captured again after its resolution is the blocker resurfacing: the row reopens.
  db.prepare(`INSERT INTO captains_log_entries VALUES (?,?,?,?,?,?,?,?,1,NULL,NULL,'[]','[]')`)
    .run("b6", "main", "2026-11-28", NOW + 300 * MINUTE, "hash3", 0, "Shopify API quota", "Rate limited again");
  syncDeterministicExpectations(db, "main", NOW + 301 * MINUTE);
  assert.equal(getExpectation(db, first.id, "main")?.status, "open");

  resolveCaptainsLogBlocker(db, { id: "b2", agentId: "main", resolvedAtMs: NOW + 30 });
  syncDeterministicExpectations(db, "main", NOW + 302 * MINUTE);
  assert.equal(getExpectation(db, second.id, "main")?.resolutionNote, "Captain's Log blocker resolved");
  assert.equal(listExpectations(db, { agentId: "other" }).length, 0, "another agent's blockers are not mirrored");
});

test("stale Captain's Log blockers auto-expire after blockerAutoExpireMinutes, closing their entries; 0 never expires", t => {
  const { db } = fixture(t);
  db.exec(CAPTAINS_LOG_DDL);
  addBlocker(db, "b1");
  db.exec("ALTER TABLE captains_log_entries ADD COLUMN native_channels_json TEXT NOT NULL DEFAULT '[]'");
  db.exec(`UPDATE captains_log_entries SET native_channels_json='["C0AHZFCAS1K"]'`);
  syncDeterministicExpectations(db, "main", NOW);
  const row = listExpectations(db, { agentId: "main", sourceKind: "captains_log" })[0]!;
  assert.deepEqual(row.triggerSpec, { channels: ["#acme-ops", "#eng", "C0AHZFCAS1K"] }, "native ids join the human labels");
  assert.equal(row.channel, "#acme-ops", "the display label stays human");

  const day = 24 * 60 * MINUTE;
  assert.equal(syncDeterministicExpectations(db, "main", NOW + 10 * day, { blockerAutoExpireMinutes: 0 }).captainsLog.expired, 0);
  assert.equal(syncDeterministicExpectations(db, "main", NOW + 2 * day).captainsLog.expired, 0, "72h default not reached");
  const sync = syncDeterministicExpectations(db, "main", NOW + 3 * day);
  assert.equal(sync.captainsLog.expired, 1);
  const expired = getExpectation(db, row.id, "main")!;
  assert.equal(expired.status, "expired");
  assert.match(expired.resolutionNote ?? "", /4320 minutes/u);
  assert.equal(listCaptainsLogEntries(db, { agentId: "main", openOnly: true, blockedOnly: true }).length, 0, "linked entries closed too");
  assert.equal(syncDeterministicExpectations(db, "main", NOW + 4 * day).captainsLog.upserted, 0, "never re-mirrored");
  assert.throws(() => syncDeterministicExpectations(db, "main", NOW, { blockerAutoExpireMinutes: -1 }), /blockerAutoExpireMinutes/);
});

test("0.19 per-entry blocker rows migrate onto the topic key; pooled and provider-less Steward rows are retired", t => {
  const { db, store } = fixture(t);
  db.exec(CAPTAINS_LOG_DDL);
  addBlocker(db, "b1");
  addBlocker(db, "b2");
  const legacy = (id: string) => store.upsertExpectation(base({ dedupKey: `captains_log:${id}`, kind: "blocker", sourceKind: "captains_log",
    sourceRef: id, summary: "Shopify API quota", expectedState: "x", dueAtMs: null, evidence: { source: "captains_log", entryId: id } })).expectation;
  const kept = legacy("b1"), duplicate = legacy("b2");
  // 0.19 wrote group/channel sessions into `workspace` and DMs as direct:<account>:<sender>.
  db.prepare(`INSERT INTO expectations (id, agent_id, dedup_key, kind, source_kind, source_ref, audience_key, chat_type, summary,
      expected_state, trigger_spec_json, evidence_json, status, created_at_ms, updated_at_ms)
    VALUES (?, 'main', ?, 'commitment', 'session_steward', 's', ?, ?, 'x', 'x', '{}', '{}', 'open', ?, ?)`).run("pooled-group", "pooled-group",
    "workspace", "group", NOW, NOW);
  db.prepare(`INSERT INTO expectations (id, agent_id, dedup_key, kind, source_kind, source_ref, audience_key, chat_type, summary,
      expected_state, trigger_spec_json, evidence_json, status, created_at_ms, updated_at_ms)
    VALUES (?, 'main', ?, 'commitment', 'session_steward', 's', ?, 'direct', 'x', 'x', '{}', '{}', 'open', ?, ?)`).run("old-dm", "old-dm",
    "direct:T1:U1", NOW, NOW);
  store.upsertExpectation(base({ dedupKey: "session_steward:new-dm", sourceKind: "session_steward", chatType: "direct",
    audienceKey: directAudienceKey("slack", "T1", "U1")! }));

  const sync = syncDeterministicExpectations(db, "main", NOW);
  assert.equal(sync.retired, 2);
  assert.equal(getExpectation(db, "pooled-group", "main")?.status, "dismissed");
  assert.equal(getExpectation(db, "old-dm", "main")?.status, "dismissed");
  assert.equal(listExpectations(db, { agentId: "main", status: "open", sourceKind: "session_steward" }).length, 1, "new-shape DM kept");
  const topic = listExpectations(db, { agentId: "main", status: "open", sourceKind: "captains_log" });
  assert.deepEqual(topic.map(row => [row.id, row.dedupKey]), [[kept.id, "captains_log_topic:shopify api quota"]], "same id, new key");
  assert.deepEqual((topic[0]!.evidence as { entryIds: string[] }).entryIds, ["b1", "b2"]);
  assert.equal(getExpectation(db, duplicate.id, "main")?.status, "dismissed");
});

test("admin People todos and todos about soft-deleted or injection-disabled people are never mirrored", t => {
  const { db } = fixture(t);
  db.exec(PEOPLE_TODOS_DDL);
  addPerson(db, "active");
  addPerson(db, "gone", "unavailable", 0);
  addPerson(db, "muted", "active", 0);
  addTodo(db, "ok", JSON.stringify({ personId: "active", summary: "Confirm Dana's role" }));
  addTodo(db, "soft", JSON.stringify({ personId: "active" }), "open", "soft_delete_review");
  addTodo(db, "enrich", JSON.stringify({ personId: "active" }), "open", "needs_enrichment");
  addTodo(db, "identity", JSON.stringify({ personId: "active" }), "open", "incomplete_slack_identity");
  addTodo(db, "deleted-person", JSON.stringify({ personId: "gone", summary: "Follow up with a deleted person" }));
  addTodo(db, "muted-person", JSON.stringify({ personId: "muted", summary: "Follow up with a muted person" }));
  addTodo(db, "unknown-person", JSON.stringify({ personId: "nobody", summary: "Unknown person" }));
  assert.ok(isAdministrativePeopleTodo("soft_delete_review") && !isAdministrativePeopleTodo("missing_dossier"));

  const sync = syncDeterministicExpectations(db, "main", NOW);
  assert.equal(sync.peopleTodos.upserted, 1);
  assert.deepEqual(listExpectations(db, { agentId: "main" }).map(row => row.dedupKey), ["people_todo:ok"]);

  // Soft-deleting the person later retires the already-mirrored todo; restoring them brings it back.
  db.exec("UPDATE people SET status='unavailable', injection_enabled=0 WHERE id='active'");
  assert.equal(syncDeterministicExpectations(db, "main", NOW + MINUTE).peopleTodos.suppressed, 1);
  assert.equal(listExpectations(db, { agentId: "main" })[0]?.status, "dismissed");
  db.exec("UPDATE people SET status='active', injection_enabled=1 WHERE id='active'");
  assert.equal(syncDeterministicExpectations(db, "main", NOW + 2 * MINUTE).peopleTodos.reopened, 1);
});

test("blocker topics normalize case, punctuation and [BLOCKED] prefixes", () => {
  assert.equal(normalizeBlockerTopic("[BLOCKED] Shopify  API-quota!"), "shopify api quota");
  assert.equal(normalizeBlockerTopic("   "), "");
});

test("deterministic ingestion mirrors people todos, parses arbitrary context safely and follows resolve/reopen", t => {
  const { db } = fixture(t);
  db.exec(PEOPLE_TODOS_DDL);
  addPerson(db, "person-1");
  addTodo(db, "t1", JSON.stringify({ personId: "person-1", displayName: "Dana Lee", senderId: "U123", summary: "Confirm Dana's role at Acme" }));
  addTodo(db, "t2", "not json at all");
  addTodo(db, "t3", JSON.stringify([1, 2, 3]));
  addTodo(db, "t4", JSON.stringify({ personId: 42, summary: { nested: true } }));
  addTodo(db, "overflow", "{}", "overflow");

  let sync = syncDeterministicExpectations(db, "main", NOW);
  assert.deepEqual(sync.peopleTodos, { upserted: 4, resolved: 0, reopened: 0, suppressed: 0, skipped: false });
  assert.equal(sync.captainsLog.skipped, true);
  const todo = listExpectations(db, { agentId: "main", personId: "person-1" })[0]!;
  assert.equal(todo.dedupKey, "people_todo:t1");
  assert.equal(todo.kind, "todo");
  assert.equal(todo.sourceKind, "people_todo");
  assert.equal(todo.audienceKey, "workspace");
  assert.equal(todo.subjectLabel, "Dana Lee");
  assert.equal(todo.summary, "Confirm Dana's role at Acme");
  assert.deepEqual(todo.triggerSpec, { personIds: ["person-1"], senderIds: ["U123"] });
  const malformed = listExpectations(db, { agentId: "main", sourceKind: "people_todo" }).filter(e => e.dedupKey !== "people_todo:t1");
  assert.equal(malformed.length, 3);
  for (const row of malformed) {
    assert.equal(row.subjectPersonId, null);
    assert.equal(row.summary, "People todo: missing dossier");
  }

  db.prepare("UPDATE people_todos SET status='resolved', resolved_at=?, resolution_note='Dossier written' WHERE id='t1'")
    .run(new Date(NOW + 5 * MINUTE).toISOString());
  sync = syncDeterministicExpectations(db, "main", NOW + 10 * MINUTE);
  assert.equal(sync.peopleTodos.resolved, 1);
  let current = getExpectation(db, todo.id, "main")!;
  assert.equal(current.status, "kept");
  assert.equal(current.resolutionNote, "Dossier written");
  assert.equal(current.resolvedAtMs, NOW + 5 * MINUTE);

  // The source reopening an auto-resolved todo makes the expectation live again.
  db.exec("UPDATE people_todos SET status='open', resolved_at=NULL, resolution_note=NULL WHERE id='t1'");
  sync = syncDeterministicExpectations(db, "main", NOW + 20 * MINUTE);
  assert.equal(sync.peopleTodos.reopened, 1);
  current = getExpectation(db, todo.id, "main")!;
  assert.equal(current.status, "open");

  // A Steward/operator resolution is never undone by the still-open source row.
  const steward = listExpectations(db, { agentId: "main", sourceKind: "people_todo" }).find(e => e.dedupKey === "people_todo:t2")!;
  db.prepare("UPDATE expectations SET status='dismissed', resolved_at_ms=? WHERE id=?").run(NOW, steward.id);
  assert.equal(syncDeterministicExpectations(db, "main", NOW + 30 * MINUTE).peopleTodos.reopened, 0);
  assert.equal(getExpectation(db, steward.id, "main")?.status, "dismissed");
});
