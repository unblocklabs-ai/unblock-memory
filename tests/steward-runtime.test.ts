import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { QMDStore } from "@unblocklabs/qmd";
import { resolveConfig } from "../src/config.js";
import { listExpectations } from "../src/expectations-store.js";
import { syncFleetCommons, type FleetCommonsEntry } from "../src/fleet-commons.js";
import { createFleetOrganismHub } from "../src/fleet-organism-hub.js";
import { MemoryCrystalsStore } from "../src/memory-crystals.js";
import { OutcomeLedgerStore } from "../src/outcome-ledger.js";
import { OUTCOME_LEDGER_KIND } from "../src/outcome-ledger.js";
import { writeRecallBatch, type RecallLedgerEvent } from "../src/recall-ledger.js";
import { listSkillProposals, sha256, upsertSkillProposal, type SkillProposalInput } from "../src/skill-proposals-store.js";
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
  handler?: (...args: unknown[]) => unknown;
  command(name: string) { const child = new FakeCommand(); this.commands.set(name, child); return child; }
  description() { return this; }
  option(flags: string, _description?: string, fallback?: unknown) {
    if (fallback !== undefined) this.defaults[optionKey(flags)] = fallback;
    return this;
  }
  requiredOption(flags: string, description?: string, fallback?: unknown) { return this.option(flags, description, fallback); }
  action(handler: (...args: never[]) => unknown) { this.handler = handler as (...args: unknown[]) => unknown; return this; }
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
  /** `name <positional...> --flag value ...`; commands declared as `"name <arg>"` receive positionals first, like commander. */
  const runText = async (...argv: string[]) => {
    const program = new FakeCommand();
    cli!({ program, config: {} });
    const [name, ...rest] = argv;
    const commands = program.commands.get("memory-steward")!.commands;
    const command = commands.get(name!) ?? [...commands].find(([declared]) => declared.split(" ")[0] === name)![1];
    const positionals: string[] = [];
    while (rest.length && !rest[0]!.startsWith("--")) positionals.push(rest.shift()!);
    const opts: Record<string, unknown> = { ...command.defaults };
    for (let i = 0; i < rest.length; i += 2) opts[optionKey(rest[i]!)] = rest[i + 1];
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => { lines.push(String(line)); };
    try { await command.handler!(...positionals, opts); }
    finally { console.log = log; }
    return lines.join("\n");
  };
  const run = async (...argv: string[]) => JSON.parse(await runText(...argv)) as Record<string, unknown>;
  return { root, dbPath, runtime, handlers, warnings, run, runText, runnerRequests: () => runnerRequests };
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
    expectations: { enabled: false }, crystals: { enabled: false }, overnight: { enabled: false },
    skills: { enabled: false } });
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

/* ═════════════════════════ Step 4: self-writing skills + Fleet Organism ═════════════════════════ */

const OTHER_PASSES_OFF = { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, outcomeLedger: { enabled: false },
  expectations: { enabled: false }, crystals: { enabled: false }, overnight: { enabled: false } };
const LIVE_SKILL = "---\nname: deploy\ndescription: Deploy things.\n---\n\n# Deploy\n\n1. Ship it.\n";

/** A workspace with one live `skills/deploy/SKILL.md`, and the plugin config whose `skills` corpus roots it. */
function skillsWorkspace(root: string, extra: Record<string, unknown> = {}) {
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "skills", "deploy"), { recursive: true });
  const live = join(workspace, "skills", "deploy", "SKILL.md");
  writeFileSync(live, LIVE_SKILL);
  const pluginConfig = resolveConfig({ corpora: [{ name: "memory", kind: "files", paths: ["MEMORY.md"] },
    { name: "skills", kind: "skills", paths: ["skills"] }], ...extra });
  return { workspace, live, pluginConfig };
}

function seedProposals(dbPath: string, ...inputs: SkillProposalInput[]) {
  const store = new WorkStore(dbPath);
  try { return inputs.map(input => upsertSkillProposal(store.db, input).proposal); } finally { store.close(); }
}

const replayMetrics = (recallGainPp: number) => ({ baselineRecall: 0.4, candidateRecall: 0.4 + recallGainPp / 100, recallGainPp,
  baselineFalseActivation: 0, candidateFalseActivation: 0, falseActivationDeltaPp: 0, criticalRegressions: 0, samplesEvaluated: 12 });
const descriptionUpdate = (live: string): SkillProposalInput => ({ agentId: "main", kind: "description_update", skillName: "deploy",
  skillPath: live, title: "Sharpen routing description for deploy", rationale: "Missed deploy requests", baseSha256: sha256(LIVE_SKILL),
  proposedDescription: "Deploy services safely with rollback checks.",
  proposedContent: LIVE_SKILL.replace("Deploy things.", "\"Deploy services safely with rollback checks.\""), replayMetrics: replayMetrics(12.4) });
const newSkill: SkillProposalInput = { agentId: "main", kind: "new_skill", skillName: "rollback", skillPath: "rollback/SKILL.md",
  title: "New skill: Roll back a release", rationale: "Recurring procedure", proposedDescription: "Roll back a bad release.",
  proposedContent: "---\nname: \"rollback\"\ndescription: \"Roll back a bad release.\"\n---\n\n# Roll back\n\n## Steps\n\n1. Revert.\n" };

test("memory-steward skills / skill-review / skill-apply: read-only listing, operator review, and a confined apply", async t => {
  let ws!: ReturnType<typeof skillsWorkspace>;
  const h = harness(t, { ...OTHER_PASSES_OFF, skills: { enabled: false } }, root => {
    ws = skillsWorkspace(root);
    return { pluginConfig: ws.pluginConfig, workspaceDirForAgent: () => ws.workspace };
  });
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const empty = await h.run("skills");
  assert.deepEqual(empty.proposals, []);
  assert.equal((empty.summary as { total: number }).total, 0);
  assert.partialDeepStrictEqual(await h.run("skill-review", "skillprop:none", "--approve", "true"), { status: "error", code: "not_found" });
  assert.equal(existsSync(h.dbPath), false, "listing and a not-found review never create the database");
  await assert.rejects(h.run("skills", "--status", "maybe"), /--status must be one of/u);
  await assert.rejects(h.run("skills", "--kind", "rewrite"), /--kind must be one of/u);
  await assert.rejects(h.run("skills", "--limit", "-1"), /--limit/u);
  await assert.rejects(h.run("skills", "--agent", "ghost"), /Unknown steward agent/u);

  const [update, fresh, pitfall] = seedProposals(h.dbPath, descriptionUpdate(ws.live), newSkill, { ...descriptionUpdate(ws.live),
    kind: "pitfall_patch", title: "Add 1 pitfall to deploy", proposedDescription: null, proposedContent: `${LIVE_SKILL}\n## Pitfalls\n\n- Check flags.\n` });
  assert.equal(((await h.run("skills", "--status", "pending")).proposals as unknown[]).length, 3);
  assert.deepEqual(((await h.run("skills", "--kind", "new_skill")).proposals as { id: string }[]).map(p => p.id), [fresh!.id]);
  assert.equal(((await h.run("skills", "--limit", "1")).proposals as unknown[]).length, 1);

  await assert.rejects(h.run("skill-review", update!.id), /exactly one of --approve or --reject/u);
  await assert.rejects(h.run("skill-review", update!.id, "--approve", "true", "--reject", "true"), /exactly one/u);
  assert.partialDeepStrictEqual(await h.run("skill-apply", update!.id), { status: "error", code: "invalid_state" },
    "nothing is applied before an operator approves it");
  assert.equal(readFileSync(ws.live, "utf8"), LIVE_SKILL);
  const approved = await h.run("skill-review", update!.id, "--approve", "true", "--by", "ops", "--note", "lgtm");
  assert.partialDeepStrictEqual(approved, { status: "approved", proposal: { reviewedBy: "ops", reviewNote: "lgtm" } });
  assert.partialDeepStrictEqual(await h.run("skill-review", update!.id, "--reject", "true"), { status: "error", code: "invalid_state" });
  assert.equal((await h.run("skill-review", pitfall!.id, "--reject", "true")).status, "rejected");

  const preview = await h.run("skill-apply", update!.id, "--dry-run", "true");
  assert.equal(preview.status, "preview");
  assert.match(String(preview.diff), /^\+description: "Deploy services safely with rollback checks\."$/mu);
  assert.equal(readFileSync(ws.live, "utf8"), LIVE_SKILL, "a dry run never writes");
  assert.partialDeepStrictEqual(await h.run("skill-apply", update!.id), { status: "applied", targetPath: ws.live });
  assert.match(readFileSync(ws.live, "utf8"), /description: "Deploy services safely with rollback checks\."/u);

  await h.run("skill-review", fresh!.id, "--approve", "true");
  assert.partialDeepStrictEqual(await h.run("skill-apply", fresh!.id, "--target-dir", join(h.root, "elsewhere")),
    { status: "error", code: "path_outside_root" }, "new skills only land inside a configured skills corpus root");
  const landed = join(ws.workspace, "skills", "rollback", "SKILL.md");
  assert.partialDeepStrictEqual(await h.run("skill-apply", fresh!.id), { status: "applied", targetPath: landed });
  assert.equal(readFileSync(landed, "utf8"), newSkill.proposedContent);
  const store = new WorkStore(h.dbPath);
  try {
    assert.deepEqual(listSkillProposals(store.db, { agentId: "main" }).map(p => [p.kind, p.status]).sort(),
      [["description_update", "applied"], ["new_skill", "applied"], ["pitfall_patch", "rejected"]]);
  } finally { store.close(); }
});

test("the Skills pass runs on the background tick (gated by workDue) and via skills --run, with the catalog and decision credentials", async t => {
  const catalogCalls: string[] = [];
  const released: string[] = [];
  let ws!: ReturnType<typeof skillsWorkspace>;
  // No routing history and no crystals: a correct pass makes zero model calls.
  const runner: Pick<StewardRunner, "complete"> = { complete: async () => { throw new Error("unexpected model call"); } };
  const memory: StewardMemoryAccess = {
    async getMemorySearchManager() { return { manager: null }; },
    async skillCatalog({ agentId }) { catalogCalls.push(agentId); return [{ name: "deploy", description: "Deploy things.", path: ws.live }]; },
    async release(agentId) { released.push(agentId); },
  };
  const h = harness(t, OTHER_PASSES_OFF, root => {
    ws = skillsWorkspace(root, { decisionModel: { apiKey: "test-decision-key" } });
    return { pluginConfig: ws.pluginConfig, workspaceDirForAgent: () => ws.workspace, createRunner: () => runner, memory: () => memory };
  });
  assert.equal(h.runtime.enabled, true, "the default-on Skills pass alone enables the background loop");
  assert.equal((await h.run("status")).skills, true);
  await h.runtime.tick();
  const first = h.runtime.lastSkillsResults().get("main");
  assert.partialDeepStrictEqual(first, { status: "ok", modelCalls: 0, proposals: [], errors: [] },
    "decisionModel credentials reach the replay (no replay_unavailable)");
  assert.deepEqual(catalogCalls, ["main"]);
  await h.runtime.tick();
  assert.equal(h.runtime.lastSkillsResults().get("main")?.status, "not_due");
  assert.deepEqual(catalogCalls, ["main"], "a not-due tick never lists the skill catalog");
  assert.ok(Object.hasOwn((await h.run("status")).counts as object, "steward_skills"));
  assert.equal((await h.run("skills", "--run", "true")).status, "ok", "--run ignores the schedule");
  assert.deepEqual(catalogCalls, ["main", "main"]);
  assert.deepEqual(released, ["main"], "the CLI releases the borrowed manager");
  assert.deepEqual(h.warnings, []);
});

test("the Skills pass reports replay_unavailable without decisionModel, and never runs without a skills corpus or runner", async t => {
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  let ws!: ReturnType<typeof skillsWorkspace>;
  const runner: Pick<StewardRunner, "complete"> = { complete: async () => { throw new Error("unexpected model call"); } };
  const memory: StewardMemoryAccess = {
    async getMemorySearchManager() { return { manager: null }; },
    async skillCatalog() { return [{ name: "deploy", description: "Deploy things.", path: ws.live }]; },
  };
  const noDecision = harness(t, OTHER_PASSES_OFF, root => {
    ws = skillsWorkspace(root, { decisionModel: { enabled: false } });
    return { pluginConfig: ws.pluginConfig, workspaceDirForAgent: () => ws.workspace, createRunner: () => runner, memory: () => memory };
  });
  await noDecision.runtime.tick();
  assert.deepEqual(noDecision.runtime.lastSkillsResults().get("main")?.errors, ["description_update:*:replay_unavailable"]);

  const noCorpus = harness(t, OTHER_PASSES_OFF, () => ({ pluginConfig: resolveConfig({}), createRunner: () => runner, memory: () => memory }));
  await noCorpus.runtime.tick();
  assert.equal(noCorpus.runtime.lastSkillsResults().size, 0, "no skills corpus = no root any apply could land in");

  const noRunner = harness(t, OTHER_PASSES_OFF, () => ({ memory: () => memory }));
  assert.deepEqual(await noRunner.run("skills", "--run", "true"), { status: "disabled" });
  assert.equal(existsSync(noRunner.dbPath), false);
});

test("skill-apply confines targets to the configured skills sources and previews through a read-only connection", async t => {
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  let ws!: ReturnType<typeof skillsWorkspace>;
  const opened: string[] = [];
  const h = harness(t, { ...OTHER_PASSES_OFF, skills: { enabled: false } }, root => {
    ws = skillsWorkspace(root);
    return { pluginConfig: ws.pluginConfig, workspaceDirForAgent: () => ws.workspace,
      openWorkStore: (dbPath: string) => { opened.push(dbPath); return new WorkStore(dbPath); } };
  });
  // A SKILL.md in the workspace but outside every skills source, and one reached through a symlink escaping the root.
  const stray = join(ws.workspace, "notes", "SKILL.md");
  mkdirSync(join(ws.workspace, "notes"));
  writeFileSync(stray, LIVE_SKILL);
  const outside = join(h.root, "outside", "evil");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "SKILL.md"), LIVE_SKILL);
  symlinkSync(outside, join(ws.workspace, "skills", "evil"));
  const [update, strayUpdate, escaped] = seedProposals(h.dbPath, descriptionUpdate(ws.live), { ...descriptionUpdate(stray), skillName: "notes" },
    { ...descriptionUpdate(join(ws.workspace, "skills", "evil", "SKILL.md")), skillName: "evil" });
  for (const proposal of [update!, strayUpdate!, escaped!]) await h.run("skill-review", proposal.id, "--approve", "true");
  for (const proposal of [strayUpdate!, escaped!]) {
    assert.partialDeepStrictEqual(await h.run("skill-apply", proposal.id), { status: "error", code: "path_outside_root" });
  }
  assert.equal(readFileSync(stray, "utf8"), LIVE_SKILL);
  assert.equal(readFileSync(join(outside, "SKILL.md"), "utf8"), LIVE_SKILL);

  opened.length = 0;
  const preview = await h.run("skill-apply", update!.id, "--dry-run", "true");
  assert.equal(preview.status, "preview");
  assert.deepEqual(opened, [], "a dry run never opens the read-write work store");
  assert.equal(readFileSync(ws.live, "utf8"), LIVE_SKILL);
  assert.partialDeepStrictEqual(await h.run("skill-apply", update!.id), { status: "applied", targetPath: ws.live });
  assert.deepEqual(opened, [h.dbPath], "a real apply uses the work store");
});

test("skills --run shares the skills-corpus admission check and skips catalog skills outside the configured sources", async t => {
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  let ws!: ReturnType<typeof skillsWorkspace>;
  const catalogCalls: string[] = [];
  const runner: Pick<StewardRunner, "complete"> = { complete: async () => { throw new Error("unexpected model call"); } };
  const memory: StewardMemoryAccess = {
    async getMemorySearchManager() { return { manager: null }; },
    async skillCatalog({ agentId }) {
      catalogCalls.push(agentId);
      return [{ name: "deploy", description: "Deploy things.", path: ws.live }, { name: "stray", description: "Stray.", path: join(h.root, "stray", "SKILL.md") }];
    },
  };
  const noCorpus = harness(t, OTHER_PASSES_OFF, () => ({ pluginConfig: resolveConfig({}), createRunner: () => runner, memory: () => memory }));
  assert.partialDeepStrictEqual(await noCorpus.run("skills", "--run", "true"), { status: "unavailable" });
  assert.deepEqual(catalogCalls, [], "no skills corpus: --run never lists the catalog or drafts anything");

  const h = harness(t, OTHER_PASSES_OFF, root => {
    ws = skillsWorkspace(root, { decisionModel: { apiKey: "test-decision-key" } });
    return { pluginConfig: ws.pluginConfig, workspaceDirForAgent: () => ws.workspace, createRunner: () => runner, memory: () => memory };
  });
  await h.runtime.tick();
  assert.partialDeepStrictEqual(h.runtime.lastSkillsResults().get("main"), { status: "ok", errors: ["catalog:stray:outside_skill_sources"] },
    "the background tick skips a catalog skill outside every skills source");
  const result = await h.run("skills", "--run", "true");
  assert.partialDeepStrictEqual(result, { status: "ok", modelCalls: 0, errors: ["catalog:stray:outside_skill_sources"] },
    "--run applies the same admission check");
});

test("memory-steward fleet-telemetry / fleet-brief / fleet-commons read real stores read-only; --sync goes through the manager", async t => {
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const syncs: string[] = [];
  const released: string[] = [];
  const memory: StewardMemoryAccess = {
    async getMemorySearchManager({ agentId }) {
      return { manager: {
        async listClusters() { return { status: "not_analyzed" as const, clusters: [], noise: null, stale: false, staleSince: null, analyzedAt: null }; },
        async fetchCluster() { return { status: "not_analyzed" as const, stale: false, staleSince: null, analyzedAt: null }; },
        async recluster() { throw new Error("unexpected recluster"); },
        async getCollectionGenerations() { return {}; },
        corpusForCollection: () => undefined,
        async syncFleetCommons() { syncs.push(agentId); return { status: "synced" as const, count: 1, changed: true, rejected: [] }; },
      } };
    },
    async release(agentId) { released.push(agentId); },
  };
  let live = "";
  const h = harness(t, { ...OTHER_PASSES_OFF, skills: { enabled: false } }, root => {
    live = join(root, "skills", "deploy", "SKILL.md");
    return { memory: () => memory,
      pluginConfig: resolveConfig({ fleetCommons: { enabled: true, feedPath: join(root, "feed.json") } }) };
  });
  const telemetry = await h.run("fleet-telemetry");
  assert.partialDeepStrictEqual(telemetry, { schemaVersion: 1, nodeId: "local", agentId: "default", skillProposals: { pending: 0, byKind: {} } });
  assert.partialDeepStrictEqual(await h.run("fleet-brief"), { operatorOnly: true, skillProposals: [], blockers: [] });
  assert.deepEqual(await h.run("fleet-commons"), { agentId: "main", enabled: true, summary: { count: 0 }, entries: [] });
  assert.equal(existsSync(h.dbPath), false, "fleet reporting never creates the database");
  await assert.rejects(h.run("fleet-telemetry", "--format", "xml"), /--format must be one of: json, prometheus/u);
  await assert.rejects(h.run("fleet-brief", "--format", "html"), /--format must be one of: json, markdown/u);
  await assert.rejects(h.run("fleet-telemetry", "--node", "/home/alice/node"), /fleet node and agent aliases/u);
  await assert.rejects(h.run("fleet-telemetry", "--since-hours", "-1"), /--since-hours/u);
  await assert.rejects(h.run("fleet-brief", "--due-soon-hours", "soon"), /--due-soon-hours/u);

  // Real Step 4A rows feed both channels; real Step 4B cache rows feed fleet-commons.
  seedProposals(h.dbPath, descriptionUpdate(live), newSkill);
  const entry: FleetCommonsEntry = { id: "deploy-flag", revision: 3, category: "tool_pitfall", severity: "warn", title: "Deploy flag",
    body: "Pass --wait to the deploy tool.", tags: ["deploy"], updatedAt: Date.now() };
  writeFileSync(join(h.root, "feed.json"), JSON.stringify({ entries: [entry] }));
  const store = { syncProjectedCollection: async () => ({ upserted: 1, unchanged: 0, retracted: 0, embedded: 0, generation: 1 }) };
  await syncFleetCommons({ config: resolveConfig({ fleetCommons: { enabled: true, feedPath: join(h.root, "feed.json") } }).fleetCommons,
    storePath: h.dbPath, store: store as Pick<QMDStore, "syncProjectedCollection"> });

  assert.deepEqual((await h.run("fleet-telemetry", "--node", "charizard")).skillProposals,
    { pending: 2, byKind: { description_update: 1, new_skill: 1 } });
  const scrape = await h.runText("fleet-telemetry", "--node", "charizard", "--format", "prometheus");
  assert.match(scrape, /^unblock_memory_skill_proposals_pending\{node="charizard",agent="default",kind="description_update"\} 1$/mu);
  assert.match(scrape, /^unblock_memory_skill_proposals_pending\{node="charizard",agent="default",kind="new_skill"\} 1$/mu);
  assert.doesNotMatch(scrape, /deploy services|rollback|Sharpen/iu, "telemetry carries counts, never proposal text");
  const brief = await h.run("fleet-brief", "--limit", "1");
  assert.deepEqual(brief.skillProposals, [{ kind: "description_update", skillName: "deploy",
    title: "Sharpen routing description for deploy", recallGainPp: 12.4 }]);
  const markdown = await h.runText("fleet-brief", "--format", "markdown");
  assert.match(markdown, /^## Pending Self-Writing Skill Proposals\n- \*\*local \/ default:\*\* Sharpen routing description for deploy .* 12\.4 pp recall\n- .*Roll back a release/mu);
  assert.match(markdown, /2 pending skill approvals/u);
  const cached = await h.run("fleet-commons") as { summary: { count: number; lastSyncAt?: number; feedDigest?: string }; entries: unknown[] };
  assert.equal(cached.summary.count, 1);
  assert.ok(Number.isSafeInteger(cached.summary.lastSyncAt) && /^[a-f0-9]{64}$/u.test(cached.summary.feedDigest ?? ""));
  assert.deepEqual(cached.entries, [entry]);

  assert.partialDeepStrictEqual(await h.run("fleet-commons", "--sync", "true"), { status: "synced", count: 1 });
  assert.deepEqual([syncs, released], [["main"], ["main"]]);
  const disabled = harness(t, { ...OTHER_PASSES_OFF, skills: { enabled: false } }, () => ({ memory: () => memory, pluginConfig: resolveConfig({}) }));
  assert.deepEqual(await disabled.run("fleet-commons", "--sync", "true"), { status: "disabled" });
  assert.equal((await disabled.run("status")).fleetCommons, false);
  assert.equal((await h.run("status")).fleetCommons, true);
});

test("fleet-telemetry / fleet-brief export --agent-alias (default \"default\"), never the local agent id, and --push with --token-file", async t => {
  const h = harness(t, { ...OTHER_PASSES_OFF, skills: { enabled: false } });
  const ingestFile = join(h.root, "ingest-token");
  writeFileSync(ingestFile, "ingest-secret\n");
  const hub = createFleetOrganismHub({ dbPath: ":memory:", ingestToken: "ingest-secret", operatorToken: "operator-secret" });
  hub.listen(0, "127.0.0.1");
  await once(hub, "listening");
  t.after(() => new Promise<void>(resolve => hub.close(() => resolve())));
  const address = hub.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  assert.equal((await h.run("fleet-telemetry")).agentId, "default");
  assert.doesNotMatch(await h.runText("fleet-telemetry", "--format", "prometheus"), /agent="main"/u);
  assert.partialDeepStrictEqual(await h.run("fleet-brief", "--agent-alias", "ops-a"), { agentId: "ops-a", operatorOnly: true });
  await assert.rejects(h.run("fleet-telemetry", "--agent-alias", "/home/alice/agent"), /fleet node and agent aliases/u);
  await assert.rejects(h.run("fleet-telemetry", "--token-file", ingestFile), /--token-file requires --push/u);
  await assert.rejects(h.run("fleet-telemetry", "--push", "http://fleet-hub.example.test/api/v1/telemetry"), /must use https:\/\//u);
  await assert.rejects(h.run("fleet-telemetry", "--push", `${base}/api/v1/telemetry`), /HTTP 401/u, "no --token-file = no bearer");
  await assert.rejects(h.run("fleet-telemetry", "--push", `${base}/api/v1/telemetry`, "--token-file", ingestFile,
    "--push-timeout-ms", "-1"), /--push-timeout-ms/u);

  const pushed = await h.run("fleet-telemetry", "--node", "charizard", "--push", `${base}/api/v1/telemetry`, "--token-file", ingestFile);
  assert.equal(pushed.agentId, "default");
  await h.run("fleet-brief", "--node", "charizard", "--agent-alias", "ops-a", "--push", `${base}/api/v1/brief`, "--token-file", ingestFile);
  const scrape = await (await fetch(`${base}/metrics`)).text();
  assert.match(scrape, /^unblock_memory_crystals_active\{node="charizard",agent="default",tier="stm"\} 0$/mu);
  assert.doesNotMatch(scrape, /agent="main"/u);
  const stored = await (await fetch(`${base}/api/v1/brief`, { headers: { Authorization: "Bearer operator-secret" } })).json() as
    { briefs: Array<{ nodeId: string; agentId: string }> };
  assert.deepEqual(stored.briefs.map(({ nodeId, agentId }) => [nodeId, agentId]), [["charizard", "ops-a"]]);
  assert.equal(existsSync(h.dbPath), false, "pushing never creates the local database");
});
