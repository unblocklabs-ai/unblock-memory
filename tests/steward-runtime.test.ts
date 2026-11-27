import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { OUTCOME_LEDGER_KIND } from "../src/outcome-ledger.js";
import { writeRecallBatch, type RecallLedgerEvent } from "../src/recall-ledger.js";
import { resolveStewardConfig } from "../src/steward-config.js";
import { registerStewardRuntime } from "../src/steward-runtime.js";
import { WorkStore } from "../src/work-store.js";

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

function harness(t: TestContext, steward: unknown = {}) {
  const root = mkdtempSync(join(tmpdir(), "steward-runtime-"));
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
  return { dbPath, runtime, handlers, warnings, run, runnerRequests: () => runnerRequests };
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
  const h = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, outcomeLedger: { enabled: false } });
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
  const h = harness(t, { peopleShadow: { enabled: false }, captainsLog: { enabled: false }, outcomeLedger: { enabled: false } });
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
