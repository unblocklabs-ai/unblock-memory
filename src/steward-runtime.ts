import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { agentStateDir, agentTranscriptDatabase } from "./agent-paths.js";
import type { UnblockMemoryConfig } from "./config.js";
import { DEFAULTS } from "./defaults.js";
import { EXPECTATION_STATUSES, ExpectationsStore, syncDeterministicExpectations } from "./expectations-store.js";
import { MEMORY_DATABASE } from "./memory-database.js";
import { runOutcomeLedgerPass, summarizeOutcomeMetrics, type OutcomeLedgerPassResult } from "./outcome-ledger.js";
import { responseCohort } from "./response-audit.js";
import { resolveTimezone } from "./session-projector.js";
import { listOpenBlockers, runCaptainsLogPass, type CaptainsLogPassResult } from "./steward-captains-log.js";
import type { StewardConfig } from "./steward-config.js";
import {
  resolveExpectationsFromCaptainsLog, runExpectationsPass, type CaptainsLogDecide, type ExpectationsPassOptions, type ExpectationsPassResult,
  type ResolveFromCaptainsLogResult,
} from "./steward-expectations.js";
import {
  buildPeopleShadowReport,
  runPeopleShadowPass,
  PEOPLE_SHADOW_KIND,
  type PeopleInventoryContext,
  type PeopleShadowPassResult,
} from "./steward-people-shadow.js";
import type { StewardRunner } from "./steward-runner.js";
import { WorkStore } from "./work-store.js";

/* ═════════════════════════ Background semaphore ═════════════════════════ */

const BACKGROUND_SLOTS = Symbol.for("unblock-memory.steward.backgroundSlots");
type SlotState = { active: number };

function slots(): SlotState {
  const global = globalThis as typeof globalThis & { [BACKGROUND_SLOTS]?: SlotState };
  global[BACKGROUND_SLOTS] ??= { active: 0 };
  return global[BACKGROUND_SLOTS];
}

/** Process-wide (all agents, all plugin instances) background Steward slot; returns a one-shot release or undefined at capacity. */
export function tryAcquireBackgroundSlot(maxActive: number): (() => void) | undefined {
  const state = slots();
  if (state.active >= Math.max(1, maxActive)) return undefined;
  state.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
  };
}

export function activeBackgroundStewards(): number {
  return slots().active;
}

/* ═════════════════════════ Gateway orchestrator ═════════════════════════ */

type StewardRuntimeOptions = {
  config: StewardConfig;
  /** Full plugin config (needed by publish-mode People Learning inventory and Captain's Log). */
  pluginConfig?: UnblockMemoryConfig;
  /**
   * Lazily built on the first background tick; undefined skips model-backed work (the Outcome Ledger and the
   * deterministic Expectations ingestion still run).
   */
  createRunner(): Pick<StewardRunner, "complete"> | undefined;
  /** Test seam; defaults to a dedicated `WorkStore` connection on the agent's memory database. */
  openWorkStore?(dbPath: string): WorkStore;
  dbPathForAgent?(agentId: string): string;
  transcriptDbForAgent?(cfg: OpenClawConfig, agentId: string): string;
  workspaceDirForAgent?(cfg: OpenClawConfig, agentId: string): string;
  listAgents?(cfg: OpenClawConfig): string[];
  shutdownGraceMs?: number;
  /** Test seam for the post-Captain's-Log d1.2 expectation check (defaults to `@unblocklabs/decisions`). */
  captainsLogDecide?: CaptainsLogDecide;
};

type CaptainsLogFollowUp = { resolution?: ResolveFromCaptainsLogResult };

/**
 * After a Captain's Log append: close the workspace/channel expectations its new entries settle (one d1.2 call), then
 * mirror the new blockers. Judging first means fresh blockers are never evaluated against their own capture. Each step
 * is isolated, so a d1.2 hiccup never fails Captain's Log.
 */
async function afterCaptainsLogAppend(options: StewardRuntimeOptions, params: {
  store: WorkStore; agentId: string; result: CaptainsLogPassResult; signal?: AbortSignal; warn(message: string): void;
}): Promise<CaptainsLogFollowUp | undefined> {
  const { store, agentId, result, signal, warn } = params;
  const expectations = options.config.expectations;
  if (result.status !== "appended" || !expectations.enabled) return undefined;
  const followUp: CaptainsLogFollowUp = {};
  const decisionModel = options.pluginConfig?.decisionModel;
  if (expectations.captainsLogDecisionResolve && decisionModel?.enabled && !signal?.aborted) {
    try {
      followUp.resolution = await resolveExpectationsFromCaptainsLog({
        db: store.db, agentId, decisionModel,
        newEntries: result.entries.map(entry => ({ ...entry, capturedAtMs: result.capturedAtMs })),
        chatTypes: expectations.captainsLogResolveChatTypes,
        minConfidence: expectations.captainsLogResolveMinConfidence,
        timeoutMs: expectations.captainsLogResolveTimeoutMs,
        ...(signal ? { signal } : {}),
        ...(options.captainsLogDecide ? { decide: options.captainsLogDecide } : {}),
      });
    } catch (error) {
      if (!signal?.aborted) warn(`unblock-memory steward captains-log expectations check (${agentId}): ${String(error)}`);
    }
  }
  if (signal?.aborted) return followUp;
  try {
    syncDeterministicExpectations(store.db, agentId, Date.now(), { blockerAutoExpireMinutes: expectations.blockerAutoExpireMinutes });
  } catch (error) {
    warn(`unblock-memory steward captains-log expectations sync (${agentId}): ${String(error)}`);
  }
  return followUp;
}

/** One Expectations pass, shared by the background tick and `memory-steward expectations --run`. */
function expectationsPassOptions(
  config: StewardConfig["expectations"],
  base: Pick<ExpectationsPassOptions, "agentId" | "workStore" | "owner" | "timezone" | "signal">,
  runner: Pick<StewardRunner, "complete"> | undefined,
  databasePath: () => string,
): ExpectationsPassOptions {
  return {
    ...base,
    intervalMinutes: config.intervalMinutes,
    lookbackMinutes: config.lookbackMinutes,
    dueLeadMinutes: config.dueLeadMinutes,
    sweepAfterMinutes: config.sweepAfterMinutes,
    maxSessionsPerRun: config.maxSessionsPerRun,
    maxCharsPerSession: config.maxCharsPerSession,
    maxSweepItems: config.maxSweepItems,
    timeoutMs: config.timeoutMs,
    excludeChatTypes: config.excludeChatTypes,
    extract: config.extract,
    sweep: config.sweep,
    blockerAutoExpireMinutes: config.blockerAutoExpireMinutes,
    // Without a runner the pass is deterministic-only and never reads transcripts.
    ...(runner ? { runner, databasePath: databasePath() } : {}),
  };
}

class StewardShutdownError extends Error {
  override name = "StewardShutdownError";
  constructor() { super("gateway stopping"); }
}

export function registerStewardRuntime(api: OpenClawPluginApi, options: StewardRuntimeOptions) {
  const dbPathForAgent = options.dbPathForAgent ?? ((agentId: string) => join(agentStateDir(agentId), MEMORY_DATABASE));
  const transcriptDbForAgent = options.transcriptDbForAgent ?? agentTranscriptDatabase;
  const workspaceDirForAgent = options.workspaceDirForAgent ?? resolveAgentWorkspaceDir;
  const listAgents = options.listAgents ?? listAgentIds;
  const openWorkStore = options.openWorkStore ?? ((dbPath: string) => new WorkStore(dbPath));
  registerStewardCli(api, options, dbPathForAgent, openWorkStore, transcriptDbForAgent, workspaceDirForAgent);

  const owner = `steward:${process.pid}:${randomUUID()}`;
  const openStores = new Set<WorkStore>();
  let lifetime = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const lastResults = new Map<string, PeopleShadowPassResult>();
  const lastCaptainsLogResults = new Map<string, CaptainsLogPassResult>();
  const lastOutcomeLedgerResults = new Map<string, OutcomeLedgerPassResult>();
  const lastExpectationsResults = new Map<string, ExpectationsPassResult>();
  const lastCaptainsLogResolutions = new Map<string, ResolveFromCaptainsLogResult>();
  const outcomeLedger = options.config.outcomeLedger;
  const expectations = options.config.expectations;
  // Same cohort Response Audit writes, so outcomes never mix verdicts from another judge configuration.
  const outcomeCohort = options.pluginConfig?.responseAudit.enabled
    ? responseCohort(options.pluginConfig.responseAudit, options.pluginConfig.decisionModel.model, options.pluginConfig.decisionModel.endpoint)
    : undefined;

  const tick = (): Promise<void> => {
    if (running) return running;
    const { signal } = lifetime;
    if (signal.aborted) return Promise.resolve();
    const release = tryAcquireBackgroundSlot(options.config.maxActiveBackground);
    if (!release) return Promise.resolve(); // Another agent/instance holds the gateway's background slot.
    running = (async () => {
      let agents: string[];
      let runner: Pick<StewardRunner, "complete"> | undefined;
      try {
        runner = options.createRunner();
      } catch (error) {
        // The Outcome Ledger and Expectations ingestion need no model; keep closing the loop without a runner.
        if (!signal.aborted) api.logger.warn(`unblock-memory steward: ${String(error)}`);
      }
      try {
        agents = runner || outcomeLedger.enabled || expectations.enabled ? listAgents(api.config) : [];
      } catch (error) {
        // `void tick()` must never surface an unhandled rejection.
        if (!signal.aborted) api.logger.warn(`unblock-memory steward: ${String(error)}`);
        return;
      }
      const inventoryContext: PeopleInventoryContext | undefined = options.pluginConfig
        ? { cfg: api.config, config: options.pluginConfig }
        : undefined;
      const timezone = resolveTimezone(api.config?.agents?.defaults?.userTimezone?.trim());
      for (const agentId of agents) {
        if (signal.aborted) break;
        let store: WorkStore | undefined;
        try {
          const dbPath = dbPathForAgent(agentId);
          store = openWorkStore(dbPath);
          openStores.add(store);
          if (outcomeLedger.enabled) {
            try {
              lastOutcomeLedgerResults.set(agentId, await runOutcomeLedgerPass({
                agentId, owner, workStore: store, signal,
                intervalMinutes: outcomeLedger.intervalMinutes,
                lookbackMs: outcomeLedger.lookbackMs,
                maxRowsPerPass: outcomeLedger.maxRowsPerPass,
                matchWindowMs: outcomeLedger.matchWindowMs,
                retentionDays: outcomeLedger.retentionDays,
                ...(outcomeLedger.lateEvidenceRescanMs === undefined ? {} : { lateEvidenceRescanMs: outcomeLedger.lateEvidenceRescanMs }),
                ...(options.pluginConfig ? { baselineMinInteractions: options.pluginConfig.insideOut.baselineMinInteractions } : {}),
                ...(outcomeCohort ? { responseCohort: outcomeCohort } : {}),
              }));
            } catch (error) {
              // Isolated: a ledger fault must not skip this agent's model-backed passes.
              if (!signal.aborted) api.logger.warn(`unblock-memory steward outcome ledger (${agentId}): ${String(error)}`);
            }
          }
          if (expectations.enabled && !signal.aborted) {
            try {
              // Runs without a runner too: Captain's Log blockers + people todos are mirrored at zero model cost.
              lastExpectationsResults.set(agentId, await runExpectationsPass(expectationsPassOptions(
                expectations, { agentId, workStore: store, owner, timezone, signal }, runner,
                () => transcriptDbForAgent(api.config, agentId),
              )));
            } catch (error) {
              // Isolated: an Expectations fault must not skip this agent's People / Captain's Log passes.
              if (!signal.aborted) api.logger.warn(`unblock-memory steward expectations (${agentId}): ${String(error)}`);
            }
          }
          if (options.config.peopleShadow.enabled && runner && !signal.aborted) {
            lastResults.set(agentId, await runPeopleShadowPass({
              mode: options.config.peopleShadow.mode,
              ...(inventoryContext ? { inventoryContext } : {}),
              minConfidence: options.config.peopleShadow.minConfidence,
              maxHandles: options.config.peopleShadow.maxHandles,
              maxExcerptChars: options.config.peopleShadow.maxExcerptChars,
              maxExportBytes: options.config.peopleShadow.maxExportBytes,
              ...(options.config.peopleShadow.includeInteractionLearning === undefined ? {}
                : { includeInteractionLearning: options.config.peopleShadow.includeInteractionLearning }),
              maxNewClaimsPerPerson: options.config.peopleShadow.maxNewClaimsPerPerson,
              maxInteractionHandles: options.config.peopleShadow.maxInteractionHandles,
              includeResponseAudit: options.config.peopleShadow.includeResponseAudit,
              dbPath, agentId, workStore: store, runner, owner, signal,
              maxItems: options.config.peopleShadow.maxItemsPerRun, timeoutMs: options.config.peopleShadow.timeoutMs,
            }));
          }
          if (options.config.captainsLog.enabled && runner && !signal.aborted) {
            const cl = options.config.captainsLog;
            const workspaceDir = workspaceDirForAgent(api.config, agentId);
            const databasePath = transcriptDbForAgent(api.config, agentId);
            const captainsLog = await runCaptainsLogPass({
              agentId,
              databasePath,
              workspaceDir,
              workStore: store,
              runner,
              owner,
              timezone,
              intervalMinutes: cl.intervalMinutes,
              lookbackMinutes: cl.lookbackMinutes,
              maxSessionsPerRun: cl.maxSessionsPerRun,
              maxCharsPerSession: cl.maxCharsPerSession,
              maxExistingLogChars: cl.maxExistingLogChars,
              timeoutMs: cl.timeoutMs,
              excludeChatTypes: cl.excludeChatTypes,
              signal,
            });
            lastCaptainsLogResults.set(agentId, captainsLog);
            const followUp = await afterCaptainsLogAppend(options, { store, agentId, result: captainsLog, signal,
              warn: message => api.logger.warn(message) });
            if (followUp?.resolution) lastCaptainsLogResolutions.set(agentId, followUp.resolution);
          }
        } catch (error) {
          if (!signal.aborted) api.logger.warn(`unblock-memory steward (${agentId}): ${String(error)}`);
        } finally {
          if (store) { openStores.delete(store); try { store.close(); } catch {} }
        }
      }
    })().finally(() => { release(); running = undefined; });
    return running;
  };

  const stop = async () => {
    if (timer) { clearInterval(timer); timer = undefined; }
    // Abort in-flight work and release leases in one synchronous step, so a graceful stop adds 0 strikes even if
    // the process exits mid-await. interruptOwner waits at most 200ms on a held lock (the lease then expires).
    lifetime.abort(new StewardShutdownError());
    for (const store of openStores) { try { store.interruptOwner(owner); } catch {} }
    const pending = running;
    if (!pending) return;
    let graceTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>(resolve => { graceTimer = setTimeout(resolve, options.shutdownGraceMs ?? DEFAULTS.steward.shutdownGraceMs); graceTimer.unref?.(); }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
  };

  const enabled = api.registrationMode !== "cli-metadata" && options.config.enabled &&
    (options.config.peopleShadow.enabled || options.config.captainsLog.enabled || outcomeLedger.enabled || expectations.enabled);
  if (enabled) {
    api.on("gateway_start", () => {
      if (timer) clearInterval(timer);
      if (lifetime.signal.aborted) lifetime = new AbortController();
      const intervals: number[] = [];
      if (options.config.peopleShadow.enabled) intervals.push(options.config.peopleShadow.intervalMinutes);
      if (options.config.captainsLog.enabled) intervals.push(options.config.captainsLog.intervalMinutes);
      if (outcomeLedger.enabled) intervals.push(outcomeLedger.intervalMinutes);
      if (expectations.enabled) intervals.push(expectations.intervalMinutes);
      const intervalMs = Math.max(1, Math.min(...intervals)) * 60_000;
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref();
      void tick();
    });
    api.on("gateway_stop", stop);
  }
  return {
    owner,
    tick,
    stop,
    lastResults: () => new Map(lastResults),
    lastCaptainsLogResults: () => new Map(lastCaptainsLogResults),
    lastOutcomeLedgerResults: () => new Map(lastOutcomeLedgerResults),
    lastExpectationsResults: () => new Map(lastExpectationsResults),
    lastCaptainsLogResolutions: () => new Map(lastCaptainsLogResolutions),
    enabled,
  };
}

/* ═════════════════════════ CLI ═════════════════════════ */

function summarize(items: readonly { kind: string; status: string }[]) {
  const byKind: Record<string, Record<string, number>> = {};
  for (const item of items) {
    byKind[item.kind] ??= {};
    byKind[item.kind]![item.status] = (byKind[item.kind]![item.status] ?? 0) + 1;
  }
  return byKind;
}

function registerStewardCli(
  api: OpenClawPluginApi,
  options: StewardRuntimeOptions,
  dbPathForAgent: (agentId: string) => string,
  openWorkStore: (dbPath: string) => WorkStore,
  transcriptDbForAgent: (cfg: OpenClawConfig, agentId: string) => string,
  workspaceDirForAgent: (cfg: OpenClawConfig, agentId: string) => string,
) {
  const knownAgent = (cfg: OpenClawConfig, agentId: string) => {
    if (!(options.listAgents ?? listAgentIds)(cfg).includes(agentId)) throw new Error("Unknown steward agent");
    return dbPathForAgent(agentId);
  };
  const withStore = <T>(dbPath: string, fn: (store: WorkStore) => T): T => {
    const store = openWorkStore(dbPath);
    try { return fn(store); } finally { store.close(); }
  };
  /**
   * Reporting never creates or migrates the database. An absent file reads as an empty in-memory
   * database; readers already treat missing tables as empty.
   */
  const withReadOnlyDb = <T>(dbPath: string, fn: (db: DatabaseSync) => T): T => {
    const db = existsSync(dbPath) ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(":memory:");
    try {
      db.exec(`PRAGMA busy_timeout=${DEFAULTS.sqlite.mainBusyTimeoutMs}`);
      return fn(db);
    } finally { db.close(); }
  };
  api.registerCli(({ program, config: cfg }) => {
    const root = program.command("memory-steward").description("Steward background work: status, People report, Captain's Log, expectations, re-drive");
    root.command("status").description("Work item counts by kind/status plus the quarantined backlog")
      .option("--agent <id>", "Agent id", "main").option("--kind <kind>", "Filter one work kind")
      .action((opts: { agent: string; kind?: string }) => {
        const dbPath = knownAgent(cfg, opts.agent);
        withStore(dbPath, store => {
          const items = store.list(opts.kind);
          console.log(JSON.stringify({
            agentId: opts.agent,
            enabled: options.config.enabled,
            peopleShadow: options.config.peopleShadow.enabled,
            peopleMode: options.config.peopleShadow.mode,
            captainsLog: options.config.captainsLog.enabled,
            outcomeLedger: options.config.outcomeLedger.enabled,
            expectations: options.config.expectations.enabled,
            counts: summarize(items),
            quarantined: items.filter(item => item.status === "quarantined")
              .map(({ kind, scope, strikes, lastError }) => ({ kind, scope, strikes, lastError })),
          }, null, 2));
        });
      });
    root.command("shadow-report").description("Side-by-side People Steward proposals/publications vs cron receipts (read-only)")
      .option("--agent <id>", "Agent id", "main").option("--manifest <id>", "One people-learning run id, e.g. nightly:2026-11-25")
      .action((opts: { agent: string; manifest?: string }) => {
        console.log(JSON.stringify(buildPeopleShadowReport(knownAgent(cfg, opts.agent), opts.manifest), null, 2));
      });
    root.command("captains-log").description("Run or preview Steward Captain's Log distillation for one agent")
      .option("--agent <id>", "Agent id", "main").option("--dry-run", "Preview entries without writing or moving watermarks", false)
      .action(async (opts: { agent: string; dryRun?: boolean }) => {
        const dbPath = knownAgent(cfg, opts.agent);
        const runner = options.createRunner();
        if (!runner) { console.log(JSON.stringify({ status: "disabled" })); process.exitCode = 1; return; }
        const store = openWorkStore(dbPath);
        try {
          const cl = options.config.captainsLog;
          const result = await runCaptainsLogPass({
            agentId: opts.agent,
            databasePath: transcriptDbForAgent(cfg, opts.agent),
            workspaceDir: workspaceDirForAgent(cfg, opts.agent),
            workStore: store,
            runner,
            owner: `steward-cli:${process.pid}:${randomUUID()}`,
            timezone: resolveTimezone(cfg.agents?.defaults?.userTimezone?.trim()),
            intervalMinutes: cl.intervalMinutes,
            lookbackMinutes: cl.lookbackMinutes,
            maxSessionsPerRun: cl.maxSessionsPerRun,
            maxCharsPerSession: cl.maxCharsPerSession,
            maxExistingLogChars: cl.maxExistingLogChars,
            timeoutMs: cl.timeoutMs,
            excludeChatTypes: cl.excludeChatTypes,
            dryRun: Boolean(opts.dryRun),
          });
          // A dry run never appends, so it never resolves or mirrors anything either.
          const followUp = await afterCaptainsLogAppend(options, { store, agentId: opts.agent, result,
            warn: message => console.warn(message) });
          console.log(JSON.stringify(followUp?.resolution ? { ...result, expectationsResolution: followUp.resolution } : result, null, 2));
        } finally { store.close(); }
      });
    root.command("outcomes").description("Outcome Ledger KPIs: whisper use, skill opens, shortfalls, by recipe (read-only)")
      .option("--agent <id>", "Agent id", "main").option("--since-hours <n>", "Only exposures from the last n hours")
      .option("--recipe <hash>", "Only one retrieval recipe hash")
      .action((opts: { agent: string; sinceHours?: string; recipe?: string }) => {
        const sinceHours = opts.sinceHours === undefined ? undefined : Number(opts.sinceHours);
        if (sinceHours !== undefined && !(Number.isFinite(sinceHours) && sinceHours > 0)) {
          throw new Error("--since-hours must be a positive number");
        }
        const recipeHash = opts.recipe?.trim();
        if (opts.recipe !== undefined && !recipeHash) throw new Error("--recipe must be a non-empty hash");
        const dbPath = knownAgent(cfg, opts.agent);
        withReadOnlyDb(dbPath, db => {
          console.log(JSON.stringify({
            agentId: opts.agent,
            ...(sinceHours === undefined ? {} : { sinceHours }),
            ...(recipeHash ? { recipeHash } : {}),
            ...summarizeOutcomeMetrics(db, {
              agentId: opts.agent,
              ...(sinceHours === undefined ? {} : { sinceMs: Date.now() - Math.round(sinceHours * 3_600_000) }),
              ...(recipeHash ? { recipeHash } : {}),
            }),
          }, null, 2));
        });
      });
    root.command("blockers").description("Open [BLOCKED] Captain's Log entries, newest first (read-only)")
      .option("--agent <id>", "Agent id", "main").option("--limit <n>", "Maximum entries (0 = unlimited)", "0")
      .action((opts: { agent: string; limit: string }) => {
        const limit = Number(opts.limit);
        if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer");
        const dbPath = knownAgent(cfg, opts.agent);
        withReadOnlyDb(dbPath, db => {
          const blockers = listOpenBlockers(db, opts.agent, limit);
          console.log(JSON.stringify({ agentId: opts.agent, count: blockers.length, blockers }, null, 2));
        });
      });
    root.command("expectations").description("Open/resolved expectations (read-only); --run triggers one Expectations pass now")
      .option("--agent <id>", "Agent id", "main")
      .option("--status <status>", `Filter one status (${EXPECTATION_STATUSES.join(", ")})`)
      .option("--limit <n>", "Maximum expectations (0 = unlimited)", "0")
      .option("--run", "Run one Expectations pass for this agent and print its result", false)
      .action(async (opts: { agent: string; status?: string; limit: string; run?: boolean }) => {
        const limit = Number(opts.limit);
        if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer");
        const status = opts.status === undefined ? undefined : EXPECTATION_STATUSES.find(value => value === opts.status?.trim());
        if (opts.status !== undefined && !status) throw new Error(`--status must be one of: ${EXPECTATION_STATUSES.join(", ")}`);
        const dbPath = knownAgent(cfg, opts.agent);
        if (opts.run) {
          let runner: Pick<StewardRunner, "complete"> | undefined;
          try { runner = options.createRunner(); }
          catch (error) { console.warn(`unblock-memory steward runner unavailable; running deterministic ingestion only: ${String(error)}`); }
          const store = openWorkStore(dbPath);
          try {
            const result = await runExpectationsPass(expectationsPassOptions(options.config.expectations, {
              agentId: opts.agent, workStore: store, owner: `steward-cli:${process.pid}:${randomUUID()}`,
              timezone: resolveTimezone(cfg.agents?.defaults?.userTimezone?.trim()),
            }, runner, () => transcriptDbForAgent(cfg, opts.agent)));
            console.log(JSON.stringify(result, null, 2));
            if (result.status === "failed") process.exitCode = 1;
          } finally { store.close(); }
          return;
        }
        const read = (db: DatabaseSync) => ({
          summary: ExpectationsStore.summarize(db, opts.agent),
          expectations: ExpectationsStore.list(db, { agentId: opts.agent, ...(status ? { status } : {}), limit }),
        });
        // Never creates or migrates an absent database: that reads as an empty in-memory one.
        const report = ExpectationsStore.readOnly(dbPath, undefined, read) ?? withReadOnlyDb(dbPath, read);
        console.log(JSON.stringify({ agentId: opts.agent, ...(status ? { status } : {}), ...report }, null, 2));
      });
    root.command("requeue").description("Explicitly re-drive one quarantined or completed work item")
      .requiredOption("--scope <scope>", "Exact work scope")
      .option("--kind <kind>", "Work kind (e.g. people_shadow, people_interactions, captains_log, outcome_ledger, expectations)", PEOPLE_SHADOW_KIND)
      .option("--agent <id>", "Agent id", "main")
      .action((opts: { agent: string; kind: string; scope: string }) => {
        const dbPath = knownAgent(cfg, opts.agent);
        withStore(dbPath, store => {
          if (!store.get(opts.kind, opts.scope)) { console.log(JSON.stringify({ status: "not_found" })); process.exitCode = 1; return; }
          if (!store.requeue(opts.kind, opts.scope)) {
            console.log(JSON.stringify({ status: "busy", item: store.get(opts.kind, opts.scope) }, null, 2));
            process.exitCode = 1;
            return;
          }
          console.log(JSON.stringify({ status: "requeued", item: store.get(opts.kind, opts.scope) }, null, 2));
        });
      });
  }, { descriptors: [{ name: "memory-steward", description: "Steward background work status, People report, Captain's Log, outcomes, blockers and expectations", hasSubcommands: true }] });
}
