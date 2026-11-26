import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TSchema } from "typebox";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { agentStateDir } from "./agent-paths.js";
import { MEMORY_DATABASE } from "./memory-database.js";
import { buildPeopleShadowReport, runPeopleShadowPass, PEOPLE_SHADOW_KIND, type PeopleShadowPassResult } from "./steward-people-shadow.js";

/* ═════════════════════════ Structural contracts ═════════════════════════
 * Tracks B1 (`src/work-store.ts`) and B2 (`src/steward-runner.ts`) land in parallel.
 * These are the minimal shapes the B3 consumers depend on; the concrete classes are
 * wired in `src/plugin.ts` during integration.
 */

/** Honest, accumulated usage across every request of one attempt. Unknown fields stay undefined — never fake 0. */
export type StewardUsage = {
  requests: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
};

type StewardMessage = { role: "user" | "assistant"; content: string };

/** Mode 1: one-shot structured synthesis (`api.runtime.llm.complete`, fallback Responses JSON). */
export type StewardCompleteRequest = {
  purpose: string;
  systemPrompt: string;
  messages: StewardMessage[];
  schema: TSchema;
  model?: string;
  reasoning?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};
export type StewardCompleteResult<T> = { value: T; usage: StewardUsage };

/** One read-only, message-shaped tool exposed inside a `run` loop. */
export type StewardToolLike = {
  name: string;
  description: string;
  parameters: TSchema;
  execute(args: unknown, context?: { signal: AbortSignal }): Promise<unknown>;
};

/** Mode 2: bounded multi-hop tool loop with a strict `submit_result` (status + `submitSchema`). */
export type StewardRunRequest = {
  purpose: string;
  systemPrompt: string;
  input: string;
  tools: StewardToolLike[];
  submitSchema: TSchema;
  maxTurns: number;
  maxToolCalls: number;
  maxInputTokens?: number;
  maxToolResultChars?: number;
  wallTimeoutMs: number;
  model?: string;
  reasoning?: string;
  signal?: AbortSignal;
};
export type StewardRunResult<T> = {
  status: "complete" | "incomplete" | "needs_decision";
  result?: T;
  turns: number;
  toolCalls: number;
  usage: StewardUsage;
  /** Budget/termination reason when not complete (e.g. `max_turns`, `max_tool_calls`). */
  stopReason?: string;
};

export interface StewardRunnerLike {
  complete<T>(request: StewardCompleteRequest): Promise<StewardCompleteResult<T>>;
  run<T>(request: StewardRunRequest): Promise<StewardRunResult<T>>;
}

export type WorkStatus = "pending" | "running" | "staged" | "completed" | "quarantined";
/** Fenced claim handle: every write checks `(kind, scope, attempt)` only — never wall clock. */
export type WorkRef = { kind: string; scope: string; attempt: number; owner: string };
export type WorkItemLike = {
  kind: string;
  scope: string;
  mode: "run" | "item";
  status: WorkStatus;
  attempt: number;
  owner: string | null;
  leaseUntil: number;
  dueAt: number;
  inputRevision: string | null;
  recipeHash: string | null;
  stage: string | null;
  artifactJson: string | null;
  usageJson: string | null;
  strikes: number;
  lastError: string | null;
  updatedAt: number;
};

export interface WorkStoreLike {
  /** Same connection used for `commitWithDomain`. */
  readonly db: DatabaseSync;
  /** Newer inputRevision/recipeHash resets the row; `requeue` explicitly re-drives quarantined/completed rows. */
  enqueue(input: { kind: string; scope: string; mode: "run" | "item"; inputRevision?: string; recipeHash?: string;
    dueAt?: number; requeue?: boolean }): unknown;
  claim(input: { kind: string; scope?: string; owner: string; leaseMs: number; now?: number }): WorkRef | undefined;
  renew(ref: WorkRef, leaseMs: number): boolean;
  stageArtifact(ref: WorkRef, stage: string, artifactJson: string, usageJson?: string): void;
  commitWithDomain<T>(db: DatabaseSync, ref: WorkRef, fn: () => T): T;
  fail(ref: WorkRef, error: string, options?: { strike?: boolean; retryAt?: number }): void;
  /** Synchronous graceful release of every lease held by `owner`; adds 0 strikes. */
  interruptOwner(owner: string): number;
  list(filter?: { kind?: string; status?: WorkStatus | WorkStatus[] }): WorkItemLike[];
  get(kind: string, scope: string): WorkItemLike | undefined;
}

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

export type StewardRuntimeConfig = {
  enabled: boolean;
  maxActiveBackground?: number;
  intervalMinutes?: number;
  leaseMs?: number;
  peopleShadow: { enabled: boolean; maxItemsPerPass?: number };
};

type ClosableWorkStore = WorkStoreLike & { close(): void };

export type StewardRuntimeOptions = {
  config: StewardRuntimeConfig;
  /** Lazily built; undefined (e.g. no credential) skips background work without error. */
  createRunner(): StewardRunnerLike | undefined;
  openWorkStore(dbPath: string): ClosableWorkStore;
  dbPathForAgent?(agentId: string): string;
  listAgents?(cfg: OpenClawConfig): string[];
  shutdownGraceMs?: number;
};

const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

class StewardShutdownError extends Error {
  override name = "StewardShutdownError";
  constructor() { super("gateway stopping"); }
}

export function registerStewardRuntime(api: OpenClawPluginApi, options: StewardRuntimeOptions) {
  const dbPathForAgent = options.dbPathForAgent ?? ((agentId: string) => join(agentStateDir(agentId), MEMORY_DATABASE));
  const listAgents = options.listAgents ?? listAgentIds;
  registerStewardCli(api, options, dbPathForAgent);

  const owner = `steward:${process.pid}:${randomUUID()}`;
  const openStores = new Set<ClosableWorkStore>();
  let lifetime = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const lastResults = new Map<string, PeopleShadowPassResult>();

  const tick = (): Promise<void> => {
    if (running) return running;
    const { signal } = lifetime;
    if (signal.aborted) return Promise.resolve();
    const release = tryAcquireBackgroundSlot(options.config.maxActiveBackground ?? 1);
    if (!release) return Promise.resolve(); // Another agent/instance holds the gateway's background slot.
    running = (async () => {
      const runner = options.createRunner();
      if (!runner) return;
      for (const agentId of listAgents(api.config)) {
        if (signal.aborted) break;
        let store: ClosableWorkStore | undefined;
        try {
          const dbPath = dbPathForAgent(agentId);
          store = options.openWorkStore(dbPath);
          openStores.add(store);
          if (options.config.peopleShadow.enabled) {
            lastResults.set(agentId, await runPeopleShadowPass({
              dbPath, agentId, workStore: store, runner, owner, signal,
              leaseMs: options.config.leaseMs, maxItems: options.config.peopleShadow.maxItemsPerPass,
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
      new Promise<void>(resolve => { graceTimer = setTimeout(resolve, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS); graceTimer.unref?.(); }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
  };

  const enabled = api.registrationMode !== "cli-metadata" && options.config.enabled && options.config.peopleShadow.enabled;
  if (enabled) {
    api.on("gateway_start", () => {
      if (timer) clearInterval(timer);
      if (lifetime.signal.aborted) lifetime = new AbortController();
      const intervalMs = Math.max(1, options.config.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 60_000;
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

function registerStewardCli(api: OpenClawPluginApi, options: StewardRuntimeOptions, dbPathForAgent: (agentId: string) => string) {
  const knownAgent = (cfg: OpenClawConfig, agentId: string) => {
    if (!(options.listAgents ?? listAgentIds)(cfg).includes(agentId)) throw new Error("Unknown steward agent");
    return dbPathForAgent(agentId);
  };
  const withStore = <T>(dbPath: string, fn: (store: ClosableWorkStore) => T): T => {
    const store = options.openWorkStore(dbPath);
    try { return fn(store); } finally { store.close(); }
  };
  api.registerCli(({ program, config: cfg }) => {
    const root = program.command("memory-steward").description("Steward background work: status, People shadow report, re-drive");
    root.command("status").description("Work item counts by kind/status plus the quarantined backlog")
      .option("--agent <id>", "Agent id", "main").option("--kind <kind>", "Filter one work kind")
      .action((opts: { agent: string; kind?: string }) => {
        const dbPath = knownAgent(cfg, opts.agent);
        withStore(dbPath, store => {
          const items = store.list(opts.kind ? { kind: opts.kind } : undefined);
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
          const existing = store.get(opts.kind, opts.scope);
          if (!existing) { console.log(JSON.stringify({ status: "not_found" })); process.exitCode = 1; return; }
          store.enqueue({ kind: existing.kind, scope: existing.scope, mode: existing.mode,
            ...(existing.inputRevision ? { inputRevision: existing.inputRevision } : {}),
            ...(existing.recipeHash ? { recipeHash: existing.recipeHash } : {}), requeue: true });
          console.log(JSON.stringify({ status: "requeued", item: store.get(opts.kind, opts.scope) }, null, 2));
        });
      });
  }, { descriptors: [{ name: "memory-steward", description: "Steward background work status and People shadow report", hasSubcommands: true }] });
}
