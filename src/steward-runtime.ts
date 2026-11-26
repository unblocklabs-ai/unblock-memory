import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { agentStateDir } from "./agent-paths.js";
import { DEFAULTS } from "./defaults.js";
import { MEMORY_DATABASE } from "./memory-database.js";
import type { StewardConfig } from "./steward-config.js";
import { buildPeopleShadowReport, runPeopleShadowPass, PEOPLE_SHADOW_KIND, type PeopleShadowPassResult } from "./steward-people-shadow.js";
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
  /** Lazily built on the first background tick; undefined skips background work without error. */
  createRunner(): Pick<StewardRunner, "complete"> | undefined;
  /** Test seam; defaults to a dedicated `WorkStore` connection on the agent's memory database. */
  openWorkStore?(dbPath: string): WorkStore;
  dbPathForAgent?(agentId: string): string;
  listAgents?(cfg: OpenClawConfig): string[];
  shutdownGraceMs?: number;
};

class StewardShutdownError extends Error {
  override name = "StewardShutdownError";
  constructor() { super("gateway stopping"); }
}

export function registerStewardRuntime(api: OpenClawPluginApi, options: StewardRuntimeOptions) {
  const dbPathForAgent = options.dbPathForAgent ?? ((agentId: string) => join(agentStateDir(agentId), MEMORY_DATABASE));
  const listAgents = options.listAgents ?? listAgentIds;
  const openWorkStore = options.openWorkStore ?? ((dbPath: string) => new WorkStore(dbPath));
  registerStewardCli(api, options, dbPathForAgent, openWorkStore);

  const owner = `steward:${process.pid}:${randomUUID()}`;
  const openStores = new Set<WorkStore>();
  let lifetime = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const lastResults = new Map<string, PeopleShadowPassResult>();

  const tick = (): Promise<void> => {
    if (running) return running;
    const { signal } = lifetime;
    if (signal.aborted) return Promise.resolve();
    const release = tryAcquireBackgroundSlot(options.config.maxActiveBackground);
    if (!release) return Promise.resolve(); // Another agent/instance holds the gateway's background slot.
    running = (async () => {
      const runner = options.createRunner();
      if (!runner) return;
      for (const agentId of listAgents(api.config)) {
        if (signal.aborted) break;
        let store: WorkStore | undefined;
        try {
          const dbPath = dbPathForAgent(agentId);
          store = openWorkStore(dbPath);
          openStores.add(store);
          if (options.config.peopleShadow.enabled) {
            lastResults.set(agentId, await runPeopleShadowPass({
              dbPath, agentId, workStore: store, runner, owner, signal,
              maxItems: options.config.peopleShadow.maxItemsPerRun, timeoutMs: options.config.peopleShadow.timeoutMs,
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
    // Release leases synchronously FIRST so a graceful stop adds 0 strikes even if the process exits mid-await.
    for (const store of openStores) { try { store.interruptOwner(owner); } catch {} }
    lifetime.abort(new StewardShutdownError());
    const pending = running;
    if (!pending) return;
    let graceTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>(resolve => { graceTimer = setTimeout(resolve, options.shutdownGraceMs ?? DEFAULTS.steward.shutdownGraceMs); graceTimer.unref?.(); }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
  };

  const enabled = api.registrationMode !== "cli-metadata" && options.config.enabled && options.config.peopleShadow.enabled;
  if (enabled) {
    api.on("gateway_start", () => {
      if (timer) clearInterval(timer);
      if (lifetime.signal.aborted) lifetime = new AbortController();
      const intervalMs = options.config.peopleShadow.intervalMinutes * 60_000;
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref();
      void tick();
    });
    api.on("gateway_stop", stop);
  }
  return { owner, tick, stop, lastResults: () => new Map(lastResults), enabled };
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

function registerStewardCli(api: OpenClawPluginApi, options: StewardRuntimeOptions, dbPathForAgent: (agentId: string) => string,
  openWorkStore: (dbPath: string) => WorkStore) {
  const knownAgent = (cfg: OpenClawConfig, agentId: string) => {
    if (!(options.listAgents ?? listAgentIds)(cfg).includes(agentId)) throw new Error("Unknown steward agent");
    return dbPathForAgent(agentId);
  };
  const withStore = <T>(dbPath: string, fn: (store: WorkStore) => T): T => {
    const store = openWorkStore(dbPath);
    try { return fn(store); } finally { store.close(); }
  };
  api.registerCli(({ program, config: cfg }) => {
    const root = program.command("memory-steward").description("Steward background work: status, People shadow report, re-drive");
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
            counts: summarize(items),
            quarantined: items.filter(item => item.status === "quarantined")
              .map(({ kind, scope, strikes, lastError }) => ({ kind, scope, strikes, lastError })),
          }, null, 2));
        });
      });
    root.command("shadow-report").description("Side-by-side People shadow proposals vs cron receipts (read-only)")
      .option("--agent <id>", "Agent id", "main").option("--manifest <id>", "One people-learning run id, e.g. nightly:2026-11-25")
      .action((opts: { agent: string; manifest?: string }) => {
        console.log(JSON.stringify(buildPeopleShadowReport(knownAgent(cfg, opts.agent), opts.manifest), null, 2));
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
  }, { descriptors: [{ name: "memory-steward", description: "Steward background work status and People shadow report", hasSubcommands: true }] });
}
