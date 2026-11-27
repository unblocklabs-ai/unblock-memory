import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { agentStateDir, agentTranscriptDatabase } from "./agent-paths.js";
import type { UnblockMemoryConfig } from "./config.js";
import { DEFAULTS } from "./defaults.js";
import { MEMORY_DATABASE } from "./memory-database.js";
import { resolveTimezone } from "./session-projector.js";
import { runCaptainsLogPass, type CaptainsLogPassResult } from "./steward-captains-log.js";
import type { StewardConfig } from "./steward-config.js";
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
  /** Lazily built on the first background tick; undefined skips background work without error. */
  createRunner(): Pick<StewardRunner, "complete"> | undefined;
  /** Test seam; defaults to a dedicated `WorkStore` connection on the agent's memory database. */
  openWorkStore?(dbPath: string): WorkStore;
  dbPathForAgent?(agentId: string): string;
  transcriptDbForAgent?(cfg: OpenClawConfig, agentId: string): string;
  workspaceDirForAgent?(cfg: OpenClawConfig, agentId: string): string;
  listAgents?(cfg: OpenClawConfig): string[];
  shutdownGraceMs?: number;
};

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
        agents = runner ? listAgents(api.config) : [];
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
          if (options.config.peopleShadow.enabled && runner) {
            lastResults.set(agentId, await runPeopleShadowPass({
              mode: options.config.peopleShadow.mode,
              ...(inventoryContext ? { inventoryContext } : {}),
              minConfidence: options.config.peopleShadow.minConfidence,
              maxHandles: options.config.peopleShadow.maxHandles,
              maxExcerptChars: options.config.peopleShadow.maxExcerptChars,
              maxExportBytes: options.config.peopleShadow.maxExportBytes,
              dbPath, agentId, workStore: store, runner, owner, signal,
              maxItems: options.config.peopleShadow.maxItemsPerRun, timeoutMs: options.config.peopleShadow.timeoutMs,
            }));
          }
          if (options.config.captainsLog.enabled && runner && !signal.aborted) {
            const cl = options.config.captainsLog;
            const workspaceDir = workspaceDirForAgent(api.config, agentId);
            const databasePath = transcriptDbForAgent(api.config, agentId);
            lastCaptainsLogResults.set(agentId, await runCaptainsLogPass({
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
            }));
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
    (options.config.peopleShadow.enabled || options.config.captainsLog.enabled);
  if (enabled) {
    api.on("gateway_start", () => {
      if (timer) clearInterval(timer);
      if (lifetime.signal.aborted) lifetime = new AbortController();
      const intervals: number[] = [];
      if (options.config.peopleShadow.enabled) intervals.push(options.config.peopleShadow.intervalMinutes);
      if (options.config.captainsLog.enabled) intervals.push(options.config.captainsLog.intervalMinutes);
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
  api.registerCli(({ program, config: cfg }) => {
    const root = program.command("memory-steward").description("Steward background work: status, People report, Captain's Log, re-drive");
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
          console.log(JSON.stringify(result, null, 2));
        } finally { store.close(); }
      });
    root.command("requeue").description("Explicitly re-drive one quarantined or completed work item")
      .requiredOption("--scope <scope>", "Exact work scope").option("--kind <kind>", "Work kind", PEOPLE_SHADOW_KIND)
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
  }, { descriptors: [{ name: "memory-steward", description: "Steward background work status, People report and Captain's Log", hasSubcommands: true }] });
}
