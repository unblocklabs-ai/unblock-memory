import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "../src/config.js";
import { listExpectations } from "../src/expectations-store.js";
import { MemoryCrystalsStore } from "../src/memory-crystals.js";
import { OutcomeLedgerStore } from "../src/outcome-ledger.js";
import { OUTCOME_LEDGER_KIND } from "../src/outcome-ledger.js";
import { writeRecallBatch, type RecallLedgerEvent } from "../src/recall-ledger.js";
import { resolveStewardConfig } from "../src/steward-config.js";
import { type CaptainsLogDecide } from "../src/steward-expectations.js";
import { createStewardRunner, type StewardCompleteRequest, type StewardCompleteResult, type StewardRunner } from "../src/steward-runner.js";
import { registerStewardRuntime, type StewardMemoryAccess } from "../src/steward-runtime.js";
import { WorkStore } from "../src/work-store.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

const HOUR = 3_600_000;

/** Minimal commander stand-in: `--long-flag <value>` options with defaults, one level of subcommands. */
class FakeCommand {
  readonly commands = new Map<string, FakeCommand>();
  readonly defaults: Record<string, unknown> = {};
  handler?: (opts: Record<string, unknown>) => unknown;
  command(name: string) { const child = new FakeCommand(); this.commands.set(name, child); return child; }
  description() { return this; }
  option(flags: string, _description?: string, fallback?: unknown) {
    if (fallback !== undefined) this.defaults[optionKey(flags)] = fallback;
    return this;
  }
  requiredOption(flags: string, description?: string, fallback?: unknown) { return this.option(flags, description, fallback); }
  action(handler: (opts: Record<string, unknown>) => unknown) { this.handler = handler; return this; }
}
const optionKey = (flags: string) => flags.split(/[ ,]/u)[0]!.replace(/^--/u, "").replace(/-(\w)/gu, (_, c: string) => c.toUpperCase());
type CliRegistrar = (ctx: { program: FakeCommand; config: unknown }) => void;

type RuntimeOptions = Parameters<typeof registerStewardRuntime>[1];

function harness(t: TestContext, steward: unknown = {}, overrides: (root: string) => Partial<RuntimeOptions> = () => ({})) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "steward-runtime-")));
  const dbPath = join(root, "unblock-memory.sqlite");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const warnings: string[] = [];
  let cli: CliRegistrar | undefined;
  const api = {
    registrationMode: "full",
    config: {},
    logger: { warn: (message: string) => warnings.push(message), info() {}, error() {}, debug() {} },
    on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); },
    registerCli: (register: CliRegistrar) => { cli = register; },
  } as unknown as OpenClawPluginApi;
  let runnerRequests = 0;
  const runtime = registerStewardRuntime(api, {
    config: resolveStewardConfig(steward),
    // No model credential: model-backed passes skip, the deterministic Outcome Ledger must still run.
    createRunner: () => { runnerRequests += 1; return undefined; },
    dbPathForAgent: () => dbPath,
    listAgents: () => ["main"],
    ...overrides(root),
  });
  const run = async (...argv: string[]) => {
    const program = new FakeCommand();
    cli!({ program, config: {} });
    const [name, ...rest] = argv;
    const command = program.commands.get("memory-steward")!.commands.get(name!)!;
    const opts: Record<string, unknown> = { ...command.defaults };
    for (let i = 0; i < rest.length; i += 2) opts[optionKey(rest[i]!)] = rest[i + 1];
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => { lines.push(String(line)); };
    try { await command.handler!(opts); }
    finally { console.log = log; }
    return JSON.parse(lines.join("\n")) as Record<string, unknown>;
  };
  return { root, dbPath, runtime, handlers, warnings, run, runnerRequests: () => runnerRequests };
}

function deliveredMemory(at: number, runId: string): RecallLedgerEvent[] {
  return [
    { kind: "query", record: { agentId: "main", eventKey: runId, sessionId: "session", runId, createdAtMs: at, source: "whisperer",
      provider: "slack", accountId: "workspace", senderId: "sender", queryFallback: false, corpora: ["memory"],
      rankingMode: "decision", outcome: "emitted", hits: [{ sourcePath: "qmd://memory/guide.md", corpus: "memory",
        rawLeafId: "guide:5", passageId: "guide:5", startLine: 5, endLine: 7, observedAtBasis: "unknown", retrievalRank: 1,
        disposition: "emitted" }] } },
    { kind: "read", record: { agentId: "main", eventKey: `${runId}/read`, sessionId: "session", runId, readAtMs: at + 10,
      sourcePath: "qmd://memory/guide.md", startLine: 5, lineCount: 2, status: "ok" } },
  ];
}

test("the default-on Outcome Ledger runs without a model runner and gates on its own interval", async t => {
  const h = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false } });
  assert.equal(h.runtime.enabled, true, "the ledger alone enables the background loop");
  writeRecallBatch(h.dbPath, deliveredMemory(Date.now() - 2 * HOUR, "turn-1"));

  await h.runtime.tick();
  assert.ok(h.runnerRequests() > 0);
  const first = h.runtime.lastOutcomeLedgerResults().get("main");
  assert.equal(first?.status, "ok", JSON.stringify(first));
  assert.equal(first.status === "ok" && first.measured, 1);
  await h.runtime.tick();
  assert.equal(h.runtime.lastOutcomeLedgerResults().get("main")?.status, "not_due");
  assert.deepEqual(h.warnings, []);
  const check = new WorkStore(h.dbPath);
  t.after(() => check.close());
  assert.equal(check.get(OUTCOME_LEDGER_KIND, "main")?.owner, null, "the pass released its lease");

  const all = await h.run("outcomes", "--agent", "main");
  assert.equal(all.totalOutcomes, 1);
  assert.equal(all.whisperUsedRate, 1);
  assert.deepEqual(Object.keys(all.byRecipe as object), ["default"]);
  const recent = await h.run("outcomes", "--since-hours", "1");
  assert.equal(recent.totalOutcomes, 0, "--since-hours bounds exposure time");
  assert.equal(recent.sinceHours, 1);
  assert.equal((await h.run("outcomes", "--recipe", "other")).totalOutcomes, 0);

  const status = await h.run("status");
  assert.equal(status.outcomeLedger, true);
  assert.deepEqual((status.counts as Record<string, unknown>)[OUTCOME_LEDGER_KIND], { pending: 1 });

  const requeued = await h.run("requeue", "--kind", OUTCOME_LEDGER_KIND, "--scope", "main");
  assert.equal(requeued.status, "requeued");
});

test("blockers lists open [BLOCKED] entries and validates its limit; disabling the ledger skips it", async t => {
  const h = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, outcomeLedger: { enabled: false },
    expectations: { enabled: false }, crystals: { enabled: false }, overnight: { enabled: false } });
  assert.equal(h.runtime.enabled, false);
  assert.deepEqual(await h.run("blockers", "--agent", "main"), { agentId: "main", count: 0, blockers: [] });
  await assert.rejects(h.run("blockers", "--limit", "-1"), /--limit/u);
  await assert.rejects(h.run("outcomes", "--since-hours", "0"), /--since-hours/u);
  await assert.rejects(h.run("blockers", "--agent", "ghost"), /Unknown steward agent/u);
  await h.runtime.tick();
  assert.equal(h.runtime.lastOutcomeLedgerResults().size, 0);
  assert.equal((await h.run("status")).outcomeLedger, false);
});

test("outcomes and blockers are read-only: a missing database is never created and missing tables read empty", async t => {
  const h = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, outcomeLedger: { enabled: false },
    expectations: { enabled: false } });
  assert.equal(existsSync(h.dbPath), false);
  const outcomes = await h.run("outcomes", "--agent", "main");
  assert.equal(outcomes.totalOutcomes, 0);
  assert.equal(outcomes.whisperUsedRate, null);
  assert.deepEqual(outcomes.byRecipe, {});
  assert.deepEqual(await h.run("blockers", "--agent", "main"), { agentId: "main", count: 0, blockers: [] });
  assert.equal(existsSync(h.dbPath), false, "reporting must not create the database");

  // An existing database without the ledger tables is neither migrated nor an error.
  const raw = new DatabaseSync(h.dbPath);
  raw.exec("CREATE TABLE unrelated (id INTEGER)");
  raw.close();
  assert.equal((await h.run("outcomes")).totalOutcomes, 0);
  assert.equal((await h.run("blockers")).count, 0);
  const check = new DatabaseSync(h.dbPath, { readOnly: true });
  t.after(() => check.close());
  assert.deepEqual(check.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ["unrelated"]);
});

function seedBlocker(dbPath: string, id = "cl-1", topic = "Shopify quota") {
  const store = new WorkStore(dbPath); // opens and marks the plugin memory database
  try {
    store.db.exec(`CREATE TABLE IF NOT EXISTS captains_log_entries (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, day TEXT NOT NULL, captured_at_ms INTEGER NOT NULL, section_hash TEXT NOT NULL,
      ordinal INTEGER NOT NULL, topic TEXT NOT NULL, summary TEXT NOT NULL, blocked INTEGER NOT NULL CHECK(blocked IN (0, 1)),
      resolved_at_ms INTEGER, resolution_note TEXT, channels_json TEXT NOT NULL CHECK(json_valid(channels_json)),
      session_refs_json TEXT NOT NULL CHECK(json_valid(session_refs_json))) STRICT`);
    store.db.prepare("INSERT INTO captains_log_entries VALUES (?, 'main', '2026-11-27', ?, ?, 0, ?, 'Acme sync blocked', 1, NULL, NULL, '[\"#acme\"]', '[]')")
      .run(id, Date.now() - HOUR, `h-${id}`, topic);
  } finally { store.close(); }
}

test("the default-on Expectations pass runs in tick() without a runner, on its own interval, with a read-only CLI and --run", async t => {
  const h = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, outcomeLedger: { enabled: false } });
  assert.equal(h.runtime.enabled, true, "Expectations alone enables the background loop");
  // Read-only before any work: the CLI never creates the database.
  const empty = await h.run("expectations", "--agent", "main");
  assert.deepEqual(empty.expectations, []);
  assert.equal((empty.summary as { total: number }).total, 0);
  assert.equal(existsSync(h.dbPath), false, "reporting must not create the database");

  seedBlocker(h.dbPath);
  await h.runtime.tick();
  assert.ok(h.runnerRequests() > 0, "the runner was requested once and was unavailable");
  const result = h.runtime.lastExpectationsResults().get("main");
  assert.equal(result?.status, "deterministic_only", JSON.stringify(result));
  assert.equal(result?.deterministic?.captainsLog.upserted, 1);
  assert.equal(h.runtime.lastOutcomeLedgerResults().size, 0);
  assert.deepEqual(h.warnings, []);
  await h.runtime.tick();
  assert.equal(h.runtime.lastExpectationsResults().get("main")?.status, "not_due", "gated on its own interval");

  const listed = await h.run("expectations", "--agent", "main", "--status", "open");
  assert.equal(listed.status, "open");
  assert.deepEqual((listed.expectations as { kind: string; summary: string }[]).map(({ kind, summary }) => [kind, summary]),
    [["blocker", "Shopify quota"]]);
  assert.deepEqual((await h.run("expectations", "--status", "kept")).expectations, []);
  assert.equal(((await h.run("expectations", "--limit", "1")).expectations as unknown[]).length, 1);
  await assert.rejects(h.run("expectations", "--status", "closed"), /--status/u);
  await assert.rejects(h.run("expectations", "--limit", "-1"), /--limit/u);
  await assert.rejects(h.run("expectations", "--agent", "ghost"), /Unknown steward agent/u);

  const status = await h.run("status");
  assert.equal(status.expectations, true);
  assert.deepEqual((status.counts as Record<string, unknown>).expectations, { pending: 1 });

  // --run triggers one pass now (requeue first: the scheduled item is not due yet).
  assert.equal((await h.run("expectations", "--run", "true")).status, "not_due");
  assert.equal((await h.run("requeue", "--kind", "expectations", "--scope", "main")).status, "requeued");
  seedBlocker(h.dbPath, "cl-2");
  const ran = await h.run("expectations", "--run", "true");
  assert.equal(ran.status, "deterministic_only", JSON.stringify(ran));
  assert.equal((ran.deterministic as { captainsLog: { upserted: number } }).captainsLog.upserted, 1);
});

test("disabling steward.expectations skips the pass; status reports it off", async t => {
  const h = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, expectations: { enabled: false } });
  seedBlocker(h.dbPath);
  await h.runtime.tick();
  assert.equal(h.runtime.lastExpectationsResults().size, 0);
  assert.equal(h.runtime.lastOutcomeLedgerResults().get("main")?.status, "ok");
  assert.equal((await h.run("status")).expectations, false);
  assert.deepEqual((await h.run("expectations")).expectations, [], "the read-only view still works with the pass off");
});

test("recipe hashes stamped on recall and skill exposures flow through the background tick into outcomes byRecipe", async t => {
  const h = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, expectations: { enabled: false },
    outcomeLedger: { lateEvidenceRescanMs: 0 } });
  const at = Date.now() - 2 * HOUR;
  const [memory, read] = deliveredMemory(at, "turn-a");
  writeRecallBatch(h.dbPath, [
    { ...memory!, record: { ...(memory!.record as object), recipeHash: "mem-b" } } as RecallLedgerEvent, read!,
    { kind: "skill_routing", record: { agentId: "main", eventKey: "route-1", sessionId: "session", runId: "turn-s", createdAtMs: at,
      recipeHash: "skill-b", mode: "direct", candidateCount: 1, scores: [], emitted: ["/skills/deploy/SKILL.md"], outcome: "emitted" } },
  ]);
  await h.runtime.tick();
  assert.equal(h.runtime.lastOutcomeLedgerResults().get("main")?.status, "ok");
  const outcomes = await h.run("outcomes", "--agent", "main");
  assert.deepEqual(Object.keys(outcomes.byRecipe as object).sort(), ["mem-b", "skill-b"]);
  assert.equal((await h.run("outcomes", "--recipe", "mem-b")).whisperUsedRate, 1);
});

/* ═════════════════════════ Post-Captain's-Log d1.2 check ═════════════════════════ */

type ClEntry = { topic: string; summary: string; blocked?: boolean; sessionRefs: string[] };

/**
 * A live-shaped agent: #fipl-customer-alerts carries Greg's approval, the memory database holds Fred's open [BLOCKED]
 * entry, and the Steward runner answers Captain's Log with `entries` (extraction / sweep calls return nothing).
 */
function closeLoopHarness(t: TestContext, entries: ClEntry[], decide: CaptainsLogDecide, steward: Record<string, unknown> = {}) {
  const h = harness(t, { peopleShadow: { enabled: false }, outcomeLedger: { enabled: false }, ...steward }, root => {
    const workspaceDir = join(root, "workspace");
    mkdirSync(workspaceDir);
    const agentPath = join(root, "openclaw-agent.sqlite");
    const agent = createAgentDatabase(agentPath);
    try {
      insertSession(agent, { sessionId: "fipl", chatType: "channel" });
      agent.prepare("UPDATE conversations SET label='#fipl-customer-alerts' WHERE conversation_id='conversation-fipl'").run();
      const event = { type: "message", message: { role: "user", content: [{ type: "text", text: "Greg: approved Fred's order, ship it." }] } };
      agent.prepare("INSERT INTO transcript_events VALUES ('fipl', 1, ?, ?)").run(JSON.stringify(event), Date.now() - 60_000);
      agent.prepare("INSERT INTO session_transcript_active_events VALUES ('fipl', 0, 1, 0)").run();
    } finally { agent.close(); }
    const config = resolveStewardConfig(undefined);
    const runner = createStewardRunner({ config, resolveApiKey: async () => "test-provider-credential", fetch: async (_url, init) => {
      const request: { input: [{ content: string }] } = JSON.parse(String(init?.body));
      const prompt = JSON.parse(request.input[0].content) as Record<string, unknown>;
      const value = "existingDailyLog" in prompt ? { shouldAppend: true, entries }
        : "expectations" in prompt ? { judgments: [] } : { expectations: [] };
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
    } });
    return {
      createRunner: () => runner,
      pluginConfig: resolveConfig({}),
      transcriptDbForAgent: () => agentPath,
      workspaceDirForAgent: () => workspaceDir,
      captainsLogDecide: decide,
    };
  });
  seedBlocker(h.dbPath, "fred-1", "Fred order approval");
  const rows = () => {
    const store = new WorkStore(h.dbPath);
    try { return listExpectations(store.db, { agentId: "main" }); } finally { store.close(); }
  };
  return { ...h, rows };
}

const APPROVAL: ClEntry = { topic: "Fred order approved", summary: "Greg approved Fred's FIPL order in #fipl-customer-alerts.", sessionRefs: ["s1"] };

test("tick(): right after Captain's Log appends, d1.2 closes the resolved blocker, then the new blockers are mirrored", async t => {
  const calls: string[][] = [];
  const decide: CaptainsLogDecide = async (state, questions) => {
    calls.push(Object.values(state.openExpectations).map(item => item.summary));
    return { answers: Object.fromEntries(Object.keys(questions).map(ref => {
      const fred = state.openExpectations[ref]!.summary === "Fred order approval";
      const choice = fred ? "resolved" as const : "still_open" as const;
      return [ref, { type: "choice" as const, choice, confidence: 0.95,
        probabilities: { still_open: fred ? 0.03 : 0.95, resolved: fred ? 0.95 : 0.03, broken: 0.02 } }];
    })) };
  };
  const h = closeLoopHarness(t, [APPROVAL, { topic: "Acme quota", summary: "Acme sync blocked on the Shopify quota", blocked: true, sessionRefs: ["s1"] }], decide);
  await h.runtime.tick();
  assert.deepEqual(h.warnings, []);
  const appended = h.runtime.lastCaptainsLogResults().get("main");
  assert.equal(appended?.status, "appended", JSON.stringify(appended));
  assert.ok(appended?.status === "appended" && appended.entries.every(entry => /^[a-f0-9]{64}$/u.test(entry.id)));
  assert.ok(readFileSync(appended.filePath, "utf8").includes("Fred order approved"));
  assert.deepEqual(h.runtime.lastCaptainsLogResolutions().get("main"), { checked: 1, resolved: 1 });
  assert.deepEqual(calls, [["Fred order approval"]], "the fresh Acme blocker is not judged against its own capture");
  const byKey = new Map(h.rows().map(row => [row.dedupKey, row]));
  assert.equal(byKey.get("captains_log_topic:fred order approval")?.status, "kept");
  assert.equal(byKey.get("captains_log_topic:acme quota")?.status, "open", "the new blocker is mirrored right after the append");
  const blockers = await h.run("blockers");
  assert.deepEqual((blockers.blockers as { topic: string }[]).map(entry => entry.topic), ["Acme quota"], "Fred's ledger entry closed");
});

test("a d1.2 failure only warns; Captain's Log still appends and mirrors, and disabled settings or a dry run never call d1.2", async t => {
  let calls = 0;
  const failing: CaptainsLogDecide = async () => { calls++; throw new Error("d1.2 unavailable"); };
  const h = closeLoopHarness(t, [APPROVAL, { topic: "Acme quota", summary: "Acme sync blocked", blocked: true, sessionRefs: ["s1"] }], failing);
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (line: unknown) => { warnings.push(String(line)); };
  try {
    const preview = await h.run("captains-log", "--dry-run", "true");
    assert.equal(preview.status, "preview");
    assert.equal(calls, 0, "a dry run never appends, resolves or mirrors");
    assert.equal((await h.run("expectations", "--run", "true")).status, "completed", "mirrors Fred's blocker first");
    const result = await h.run("captains-log");
    assert.equal(result.status, "appended", JSON.stringify(result));
    assert.equal(result.expectationsResolution, undefined);
  } finally { console.warn = warn; }
  assert.equal(calls, 1);
  assert.ok(warnings.some(line => /captains-log expectations check \(main\): Error: d1\.2 unavailable/u.test(line)), JSON.stringify(warnings));
  const byKey = new Map(h.rows().map(row => [row.dedupKey, row.status]));
  assert.equal(byKey.get("captains_log_topic:fred order approval"), "open", "nothing was closed");
  assert.equal(byKey.get("captains_log_topic:acme quota"), "open", "new blockers are still mirrored");

  const off = closeLoopHarness(t, [APPROVAL], failing, { expectations: { captainsLogDecisionResolve: false } });
  await off.runtime.tick();
  assert.equal(off.runtime.lastCaptainsLogResults().get("main")?.status, "appended");
  assert.equal(calls, 1, "captainsLogDecisionResolve=false never calls d1.2");
  assert.deepEqual(off.warnings, []);
});

/* ───────────── Pillar 1: Memory Crystals and Overnight Thinking ───────────── */

/** A QMD manager stand-in with no analysis run yet: the Crystals pass then only decays and promotes. */
function fakeMemory() {
  const calls = { managers: 0, released: [] as string[], reclusters: 0 };
  const memory: StewardMemoryAccess = {
    async getMemorySearchManager() {
      calls.managers += 1;
      return { manager: {
        async listClusters() { return { status: "not_analyzed" as const, clusters: [], noise: null, stale: false, staleSince: null, analyzedAt: null }; },
        async fetchCluster() { return { status: "not_analyzed" as const, stale: false, staleSince: null, analyzedAt: null }; },
        async recluster() { calls.reclusters += 1; throw new Error("unexpected recluster"); },
        async getCollectionGenerations() { return {}; },
        corpusForCollection: () => undefined,
      } };
    },
    async release(agentId) { calls.released.push(agentId); },
  };
  return { memory, calls };
}

function seedCrystal(dbPath: string, id: string, tier: "stm" | "ltm" = "stm") {
  const store = new MemoryCrystalsStore(dbPath);
  try {
    store.upsertCrystal({ id, agentId: "main", tier, audienceKey: "workspace", corpora: ["memory"], inputDigest: `digest-${id}`,
      title: `Crystal ${id}`, summary: "A durable synthesis.", staleAfterMs: tier === "stm" ? Date.now() + HOUR : null,
      members: [{ corpus: "memory", sourcePath: "qmd://memory/a.md", docHash: "doc-a", chunkPos: 0, chunkLen: 10, quoteSha256: "b".repeat(64) }] });
  } finally { store.close(); }
}

test("memory-steward crystals is read-only (never creating a database) and --run triggers one Crystals pass now", async t => {
  const fake = fakeMemory();
  const h = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, outcomeLedger: { enabled: false },
    expectations: { enabled: false }, overnight: { enabled: false } }, () => ({ memory: () => fake.memory }));
  assert.equal(h.runtime.enabled, true, "the default-on Crystals pass alone enables the background loop");
  const empty = await h.run("crystals", "--agent", "main");
  assert.deepEqual(empty.crystals, []);
  assert.equal((empty.summary as { total: number }).total, 0);
  assert.equal(existsSync(h.dbPath), false, "reporting must not create the database");
  // An existing database without the crystal tables is neither migrated nor an error.
  const raw = new DatabaseSync(h.dbPath);
  raw.exec("CREATE TABLE unrelated (id INTEGER)");
  raw.close();
  assert.deepEqual((await h.run("crystals")).crystals, []);
  const check = new DatabaseSync(h.dbPath, { readOnly: true });
  assert.deepEqual(check.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ["unrelated"]);
  check.close();
  rmSync(h.dbPath);
  await assert.rejects(h.run("crystals", "--tier", "mid"), /--tier/u);
  await assert.rejects(h.run("crystals", "--limit", "-1"), /--limit/u);
  await assert.rejects(h.run("crystals", "--agent", "ghost"), /Unknown steward agent/u);

  seedCrystal(h.dbPath, "c-stm");
  seedCrystal(h.dbPath, "c-ltm", "ltm");
  const listed = await h.run("crystals", "--tier", "ltm");
  assert.equal(listed.tier, "ltm");
  assert.deepEqual((listed.crystals as { id: string }[]).map(crystal => crystal.id), ["c-ltm"]);
  assert.deepEqual((listed.summary as { activeByTier: unknown }).activeByTier, { stm: 1, ltm: 1 });
  assert.equal(((await h.run("crystals", "--limit", "1")).crystals as unknown[]).length, 1);

  // --run: no runner and no analysis yet, so a deterministic decay/promotion pass, and the CLI releases the manager.
  const ran = await h.run("crystals", "--run", "true");
  assert.equal(ran.status, "ok", JSON.stringify(ran));
  assert.equal(ran.reclustered, false);
  assert.deepEqual(fake.calls.released, ["main"]);
  assert.equal(fake.calls.reclusters, 0, "recluster is never offered without analysis.executable");
  assert.equal((await h.run("crystals", "--run", "true")).status, "ok", "--run ignores the schedule");

  // The background tick runs it too, isolated and on its own schedule — and never cold-starts a manager when not due.
  const managersBefore = fake.calls.managers;
  await h.runtime.tick();
  assert.equal(h.runtime.lastCrystalsResults().get("main")?.status, "not_due");
  assert.equal(fake.calls.managers, managersBefore, "a not-due tick never opens the agent's memory manager");
  assert.deepEqual(h.warnings, []);
  const status = await h.run("status");
  assert.equal(status.crystals, true);
  assert.equal(status.overnight, false);
});

test("memory-steward crystals --run reports an unavailable memory index; the tick skips Crystals without one", async t => {
  const h = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, outcomeLedger: { enabled: false },
    expectations: { enabled: false }, overnight: { enabled: false } });
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  assert.deepEqual(await h.run("crystals", "--run", "true"), { status: "unavailable", reason: "memory index unavailable for this agent" });
  await h.runtime.tick();
  assert.equal(h.runtime.lastCrystalsResults().size, 0);
  assert.equal(existsSync(h.dbPath), false);
});

function postmortemRunner(calls: string[]): Pick<StewardRunner, "complete"> {
  return {
    async complete<T>(request: StewardCompleteRequest<T>): Promise<StewardCompleteResult<T>> {
      calls.push(request.purpose);
      return { ok: true, backend: "responses_api", usage: { requests: 1 },
        data: { rootCause: "stale_memory", diagnosis: "An outdated note was surfaced.", recommendedFix: "Retire memory/old.md.",
          confidence: "high" } as T };
    },
  };
}

test("memory-steward overnight is read-only (never creating a database) and --run ignores the schedule and quiet hours", async t => {
  const calls: string[] = [];
  let runnerAvailable = false;
  const hourNow = new Date().getHours();
  // A quiet window that excludes the current hour: the scheduled pass must wait, an operator --run must not.
  const quiet = { quietHoursStartHour: (hourNow + 2) % 24, quietHoursEndHour: (hourNow + 3) % 24 };
  const h = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, outcomeLedger: { enabled: false },
    expectations: { enabled: false }, crystals: { enabled: false }, overnight: quiet },
  () => ({ createRunner: () => runnerAvailable ? postmortemRunner(calls) : undefined }));
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const empty = await h.run("overnight", "--agent", "main");
  assert.deepEqual(empty, { agentId: "main", summary: { shifts: 0, shiftsByType: {}, postmortems: 0, postmortemsByRootCause: {} },
    shifts: [], postmortems: [] });
  assert.equal(existsSync(h.dbPath), false, "reporting must not create the database");
  await assert.rejects(h.run("overnight", "--limit", "x"), /--limit/u);
  assert.deepEqual(await h.run("overnight", "--run", "true"), { status: "disabled" }, "the pass needs the Steward runner");
  assert.equal(existsSync(h.dbPath), false);

  runnerAvailable = true;
  const ledger = new OutcomeLedgerStore(h.dbPath);
  try {
    ledger.db.prepare(`INSERT INTO memory_outcomes (id,agent_id,subject_kind,subject_id,verdict,confidence,evidence_turn_id,signals_json,measured_at)
      VALUES ('o-hurt','main','memory_hit','qmd://memory/old.md','hurt',0.9,'turn-1','{}',?)`).run(Date.now() - HOUR);
  } finally { ledger.close(); }
  assert.equal(((await h.run("overnight")).summary as { pendingHurtOutcomes?: number }).pendingHurtOutcomes, 1);

  await h.runtime.tick();
  assert.equal(h.runtime.lastOvernightResults().get("main")?.status, "outside_quiet_hours");
  const ran = await h.run("overnight", "--run", "true");
  assert.equal(ran.status, "completed", JSON.stringify(ran));
  assert.deepEqual(ran.postmortems, { candidates: 1, analyzed: 1 });
  assert.deepEqual(calls, ["overnight_postmortem"]);
  // No memory index in this harness: Voltaire and pre-answering have nothing to investigate with.
  assert.equal((ran.voltaire as { investigated: number }).investigated, 0);

  const report = await h.run("overnight", "--limit", "5");
  assert.equal((report.summary as { postmortems: number }).postmortems, 1);
  assert.deepEqual((report.postmortems as { outcomeId: string; rootCause: string }[]).map(({ outcomeId, rootCause }) => [outcomeId, rootCause]),
    [["o-hurt", "stale_memory"]]);
  assert.equal((await h.run("overnight", "--run", "true")).status, "empty", "--run ignores the schedule; the hurt turn is diagnosed once");
  assert.equal((await h.run("status")).overnight, true);
  assert.deepEqual(h.warnings, []);
});

test("background ticks open the memory manager only when Crystals or Overnight is actually due (and inside quiet hours)", async t => {
  const calls: string[] = [];
  const fake = fakeMemory();
  const memory: StewardMemoryAccess = { ...fake.memory, deepThought: () => undefined };
  const h = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, outcomeLedger: { enabled: false },
    expectations: { enabled: false } }, () => ({ memory: () => memory, createRunner: () => postmortemRunner(calls) }));
  await h.runtime.tick();
  assert.equal(h.runtime.lastCrystalsResults().get("main")?.status, "ok");
  assert.equal(h.runtime.lastOvernightResults().get("main")?.status, "empty");
  assert.equal(fake.calls.managers, 2, "first tick: both passes are due, each opens the manager");
  await h.runtime.tick();
  assert.equal(h.runtime.lastCrystalsResults().get("main")?.status, "not_due");
  assert.equal(h.runtime.lastOvernightResults().get("main")?.status, "not_due");
  assert.equal(fake.calls.managers, 2, "a non-due tick never cold-starts the manager");
  assert.deepEqual(h.warnings, []);

  const hourNow = new Date().getHours();
  const quietFake = fakeMemory();
  const quietMemory: StewardMemoryAccess = { ...quietFake.memory, deepThought: () => undefined };
  const quiet = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, outcomeLedger: { enabled: false },
    expectations: { enabled: false }, crystals: { enabled: false },
    overnight: { quietHoursStartHour: (hourNow + 2) % 24, quietHoursEndHour: (hourNow + 3) % 24 } },
  () => ({ memory: () => quietMemory, createRunner: () => postmortemRunner(calls) }));
  await quiet.runtime.tick();
  assert.equal(quiet.runtime.lastOvernightResults().get("main")?.status, "outside_quiet_hours");
  assert.equal(quietFake.calls.managers, 0, "outside quiet hours the manager is never started");
});
