import { DEFAULTS } from "./defaults.js";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { MEMORY_DATABASE } from "./memory-database.js";
import { join } from "node:path";
import {
  resolveAgentWorkspaceDir,
  resolveStateDir,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listAgentIds, resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { CorpusConfig } from "./config.js";
import type { ExtractionConfig } from "./extraction-config.js";
import type { FleetCommonsConfig, FleetCommonsSyncResult } from "./fleet-commons.js";
import type { MemoryPluginRuntimeContract } from "./contracts.js";
import { QmdMemoryManager, type ManagerSessionConfig, type SkillCatalogEntry } from "./manager.js";
import { resolveTimezone } from "./session-projector.js";
import { unchangedSessionSync, type SessionSyncResult } from "./session-sync.js";
import {
  SessionSyncState, legacySessionArtifactsRetirable, removeLegacySessionSyncArtifacts, type SessionSyncReceipt,
} from "./session-sync-state.js";
import { resolveConfiguredSkillPath, resolveSessionSource, resolveSources } from "./sources.js";
import { classifyWorkspaceMemoryPaths } from "./workspace-path-classifier.js";
import { agentStateDir, agentTranscriptDatabase } from "./agent-paths.js";
import { WorkFenceLostError, WorkStore, startWorkHeartbeat, type WorkClaim, type WorkItem } from "./work-store.js";

export type SessionSyncStatus =
  | { status: "idle" }
  | { status: "running"; phase: "queued" | "projecting" | "indexing"; startedAt: string }
  | ({ status: "completed"; startedAt: string; completedAt: string } & SessionSyncResult)
  | { status: "failed"; startedAt: string; completedAt: string; error: string };

export type SessionSyncStartResult =
  | { status: "started"; startedAt: string }
  | { status: "already_running"; startedAt: string }
  | { status: "unavailable"; error: string };

/** One fenced `mode='run'` WorkStore row per agent (`scope = agentId`) serializes syncs across processes. */
const SESSION_SYNC_WORK_KIND = "session_sync";

type SessionSyncRun = { work: WorkStore; state: SessionSyncState; claim: WorkClaim; startedAt: string; directory: string };

function publicStatus(receipt: SessionSyncReceipt): SessionSyncStatus {
  if (receipt.status !== "running") return receipt;
  const { attempt: _attempt, ...running } = receipt;
  return running;
}

function runningStatus(row: WorkItem, receipt: SessionSyncReceipt | undefined): Extract<SessionSyncStatus, { status: "running" }> {
  // Between claim and the owner's first receipt write, only the lease itself is visible.
  return receipt?.status === "running" && receipt.attempt === row.attempt
    ? { status: "running", phase: receipt.phase, startedAt: receipt.startedAt }
    : { status: "running", phase: "queued", startedAt: new Date(row.updatedAt).toISOString() };
}

function liveRun(row: WorkItem | undefined, now = Date.now()): row is WorkItem {
  return row?.status === "running" && row.leaseUntil > now;
}

const curationDatabasePath = (directory: string) => join(directory, MEMORY_DATABASE);
const qmdDatabasePath = (directory: string) => join(directory, "index.sqlite");

type FleetCommonsScheduleHooks = {
  onError: (error: unknown) => void;
  /** Receives one warning per sync that rejected feed entries (sanitized ids and fixed reasons only). */
  onRejected?: (message: string) => void;
  /** Gateway lifetime signal: aborting it stops the schedule and in-flight requests. */
  signal?: AbortSignal;
};
type FleetCommonsSchedule = { controller: AbortController; hooks: FleetCommonsScheduleHooks };
type ManagerEntry = { manager: QmdMemoryManager; ready?: Promise<void>; started?: boolean };

export class QmdMemoryRuntime implements MemoryPluginRuntimeContract {
  readonly #corpora: readonly CorpusConfig[];
  readonly #extraction?: ExtractionConfig;
  readonly #fleetCommons?: FleetCommonsConfig;
  readonly #syntheticInput?: ManagerSessionConfig["syntheticInput"];
  readonly #analysisExecutable?: string;
  readonly #keepEmbeddingModelWarm: boolean;
  readonly #stateRoot: string;
  readonly #onError?: (error: unknown) => void;
  readonly #recallLedgerEnabled: boolean;
  readonly #managers = new Map<string, ManagerEntry>();
  readonly #closingManagers = new Map<string, Promise<void>>();
  readonly #activeSessionSyncs = new Map<string, Promise<void>>();
  readonly #pendingSessionSyncStarts = new Set<Promise<unknown>>();
  /** Lease owner for this runtime's session syncs; `close()` (gateway_stop) releases it with 0 strikes. */
  readonly #workOwner = `session-sync:${process.pid}:${randomUUID()}`;
  readonly #runningSyncs = new Set<{ work: WorkStore; abort: AbortController }>();
  #shutdownStarted = false;
  #reloadFences = 0;
  #closeAllFences = 0;
  #closePromise?: Promise<void>;
  #sessionSyncTimer?: NodeJS.Timeout;
  #schedule?: { cfg: OpenClawConfig; onError: (error: unknown) => void };
  #fleetCommonsTimer?: NodeJS.Timeout;
  #fleetCommonsRun?: Promise<void>;
  /** Retain the aborted schedule so a manager finishing startup cannot lose the gateway's cancellation. */
  #fleetCommonsSchedule?: FleetCommonsSchedule;
  /** Aborted by `close()`: stops in-flight Fleet Commons requests instead of waiting out their timeouts. */
  readonly #fleetCommonsLifetime = new AbortController();

  /**
   * Periodic Fleet Commons sync (only when `fleetCommons.enabled`): every `syncIntervalMinutes`, each already-open agent
   * manager pulls the feed into its own cache and projected collection; unused agents are never cold-started. A run still
   * in flight skips the next tick. `close()` or the gateway `signal` stops the timer and aborts in-flight requests.
   */
  startFleetCommonsSchedule(onError: (error: unknown) => void, options: Omit<FleetCommonsScheduleHooks, "onError"> = {}): void {
    this.stopFleetCommonsSchedule();
    const fleetCommons = this.#fleetCommons;
    if (this.#shutdownStarted || !fleetCommons?.enabled) return;
    const scheduleController = new AbortController();
    const schedule = { controller: scheduleController, hooks: { ...options, onError } };
    this.#fleetCommonsSchedule = schedule;
    if (options.signal?.aborted) {
      scheduleController.abort(options.signal.reason);
      return;
    }
    options.signal?.addEventListener("abort", () => this.stopFleetCommonsSchedule(),
      { once: true, signal: scheduleController.signal });
    const intervalMs = Math.min(2 ** 31 - 1, Math.max(1, Math.round(fleetCommons.syncIntervalMinutes * 60_000)));
    this.#fleetCommonsTimer = setInterval(() => {
      if (scheduleController.signal.aborted || this.#shutdownStarted || this.#fleetCommonsRun) return;
      this.#fleetCommonsRun = (async () => {
        for (const [agentId, entry] of [...this.#managers]) {
          if (scheduleController.signal.aborted || this.#shutdownStarted) return;
          if (entry.started && this.#managers.get(agentId) === entry) {
            await this.#syncFleetCommonsFor(agentId, entry.manager, schedule);
          }
        }
      })().catch(onError).finally(() => { this.#fleetCommonsRun = undefined; });
    }, intervalMs);
    this.#fleetCommonsTimer.unref();
  }

  stopFleetCommonsSchedule(): void {
    if (this.#fleetCommonsTimer) clearInterval(this.#fleetCommonsTimer);
    this.#fleetCommonsTimer = undefined;
    this.#fleetCommonsSchedule?.controller.abort();
  }

  /** One Fleet Commons sync for one agent; `disabled` without touching the index when `fleetCommons.enabled` is false. */
  async syncFleetCommons(params: { cfg: OpenClawConfig; agentId: string }, signal?: AbortSignal): Promise<FleetCommonsSyncResult> {
    if (!this.#fleetCommons?.enabled) return { status: "disabled" };
    const { manager, error } = await this.getMemorySearchManager(params);
    if (!manager) throw new Error(error ?? "memory unavailable");
    return manager.syncFleetCommons(signal);
  }

  /** Background sync of one open manager: errors and rejected entries are reported, never thrown. */
  async #syncFleetCommonsFor(agentId: string, manager: QmdMemoryManager, schedule?: FleetCommonsSchedule): Promise<void> {
    if (!this.#fleetCommons?.enabled) return;
    const hooks = schedule?.hooks;
    const lifetime = this.#fleetCommonsLifetime.signal;
    const signal = schedule ? AbortSignal.any([lifetime, schedule.controller.signal]) : lifetime;
    if (signal.aborted || this.#shutdownStarted) return;
    try {
      const result = await manager.syncFleetCommons(signal);
      if (signal.aborted || result.status === "disabled" || !result.rejected.length) return;
      const message = `unblock-memory fleet commons rejected ${result.rejected.length} entr${result.rejected.length === 1 ? "y" : "ies"}` +
        ` for agent ${agentId}: ${result.rejected.map(({ id, reasons }) => `${id} (${reasons.join(", ")})`).join("; ")}`;
      if (hooks?.onRejected) hooks.onRejected(message);
      else console.warn(message);
    } catch (error) {
      if (signal.aborted || this.#shutdownStarted) return;
      if (hooks) hooks.onError(error);
      else this.#reportError(error);
    }
  }

  startSessionSyncSchedule(cfg: OpenClawConfig, onError: (error: unknown) => void): void {
    this.stopSessionSyncSchedule();
    if (this.#shutdownStarted) return;
    const sessions = this.#corpora.find((corpus) => corpus.kind === "sessions");
    if (!sessions?.syncIntervalMinutes) return;
    this.#schedule = { cfg, onError };
    if (this.#reloadFences === 0 && this.#closeAllFences === 0) {
      this.#startSessionSyncTimer(sessions.syncIntervalMinutes, cfg, onError);
    }
  }

  stopSessionSyncSchedule(): void {
    this.#schedule = undefined;
    this.#pauseSessionSyncSchedule();
  }

  #pauseSessionSyncSchedule(): void {
    if (this.#sessionSyncTimer) clearInterval(this.#sessionSyncTimer);
    this.#sessionSyncTimer = undefined;
  }

  #maybeResumeSessionSyncSchedule(): void {
    if (
      this.#shutdownStarted ||
      this.#reloadFences > 0 ||
      this.#closeAllFences > 0 ||
      this.#sessionSyncTimer ||
      !this.#schedule
    ) {
      return;
    }
    const sessions = this.#corpora.find((corpus) => corpus.kind === "sessions");
    if (!sessions?.syncIntervalMinutes) return;
    this.#startSessionSyncTimer(sessions.syncIntervalMinutes, this.#schedule.cfg, this.#schedule.onError);
  }

  #startSessionSyncTimer(
    syncIntervalMinutes: number,
    cfg: OpenClawConfig,
    onError: (error: unknown) => void,
  ): void {
    this.#sessionSyncTimer = setInterval(() => {
      for (const agentId of listAgentIds(cfg)) {
        void this.startSessionSync({ cfg, agentId }).catch(onError);
      }
    }, syncIntervalMinutes * 60_000);
    this.#sessionSyncTimer.unref();
  }

  #admissionBlockedReason(): string | undefined {
    if (this.#shutdownStarted) return "memory runtime is closing";
    if (this.#reloadFences > 0) return "memory runtime is reloading";
    if (this.#closeAllFences > 0) return "memory runtime is closing";
    return undefined;
  }

  #reportError(error: unknown): void {
    const onError = this.#onError ?? this.#schedule?.onError;
    if (onError) onError(error);
    else console.warn(`unblock-memory session sync: ${String(error)}`);
  }

  #openSessionWork(agentId: string): { work: WorkStore; state: SessionSyncState; directory: string } {
    const directory = this.#stateDir(agentId);
    const work = new WorkStore(curationDatabasePath(directory));
    try { return { work, state: new SessionSyncState(work.db, agentId, directory), directory }; }
    catch (error) { work.close(); throw error; }
  }

  constructor(
    corpora: readonly CorpusConfig[],
    options: {
      analysisExecutable?: string;
      keepEmbeddingModelWarm?: boolean;
      stateRoot?: string;
      extraction?: ExtractionConfig;
      fleetCommons?: FleetCommonsConfig;
      syntheticInput?: ManagerSessionConfig["syntheticInput"];
      recallLedgerEnabled?: boolean;
      onError?: (error: unknown) => void;
    } = {},
  ) {
    this.#corpora = corpora;
    this.#extraction = options.extraction;
    this.#fleetCommons = options.fleetCommons;
    this.#syntheticInput = options.syntheticInput;
    this.#analysisExecutable = options.analysisExecutable;
    this.#keepEmbeddingModelWarm = options.keepEmbeddingModelWarm ?? true;
    this.#stateRoot = options.stateRoot ?? resolveStateDir();
    this.#recallLedgerEnabled = options.recallLedgerEnabled ?? false;
    this.#onError = options.onError;
  }

  memoryDatabasePath(agentId: string): string {
    return curationDatabasePath(this.#stateDir(agentId));
  }

  get fleetCommonsAllowExpired(): boolean {
    return this.#fleetCommons?.enabled === true && this.#fleetCommons.allowExpired;
  }

  searchableCorpora(): string[] {
    const names = this.#corpora.filter((corpus) => corpus.kind !== "skills").map((corpus) => corpus.name);
    if (this.#extraction?.enabled && this.#extraction.publish && !names.includes("extracted")) {
      names.push("extracted");
    }
    if (this.#fleetCommons?.enabled && !names.includes("fleet")) names.push("fleet");
    return names;
  }

  getMemorySearchManager(params: { cfg: OpenClawConfig; agentId: string }) {
    return this.#getManager(params, true);
  }

  async #getManager(params: { cfg: OpenClawConfig; agentId: string }, startMemory: boolean) {
    while (true) {
      const blocked = this.#admissionBlockedReason();
      if (blocked) {
        return { manager: null, error: blocked };
      }
      const closing = this.#closingManagers.get(params.agentId);
      if (closing) {
        await closing.catch(() => undefined);
        continue;
      }
      let entry = this.#managers.get(params.agentId);
      try {
        if (!entry) {
          entry = { manager: this.#createManager(params.cfg, params.agentId) };
          this.#managers.set(params.agentId, entry);
        }
        if (startMemory) {
          entry.ready ??= this.#startManager(params.agentId, entry);
          await entry.ready;
        }
        const blockedAfter = this.#admissionBlockedReason();
        if (blockedAfter) {
          return { manager: null, error: blockedAfter };
        }
        if (this.#managers.get(params.agentId) !== entry) {
          continue;
        }
        return { manager: entry.manager };
      } catch (error) {
        if (this.#managers.get(params.agentId) === entry) this.#managers.delete(params.agentId);
        return { manager: null, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  resolveMemoryBackendConfig() {
    return { backend: "builtin" as const };
  }

  classifyWorkspaceMemoryPaths: NonNullable<
    MemoryPluginRuntimeContract["classifyWorkspaceMemoryPaths"]
  > = classifyWorkspaceMemoryPaths;

  startSessionSync(
    params: { cfg: OpenClawConfig; agentId: string },
    force = false,
  ): Promise<SessionSyncStartResult> {
    const blocked = this.#admissionBlockedReason();
    if (blocked) {
      return Promise.resolve({
        status: "unavailable",
        error: blocked,
      });
    }
    if (!this.#corpora.some((corpus) => corpus.kind === "sessions")) {
      return Promise.resolve({
        status: "unavailable",
        error: 'memory session sync requires a configured "sessions" corpus',
      });
    }
    const pending = this.#startSessionSync(params, force);
    this.#pendingSessionSyncStarts.add(pending);
    const cleanup = () => {
      this.#pendingSessionSyncStarts.delete(pending);
    };
    pending.then(cleanup, cleanup);
    return pending;
  }

  async #startSessionSync(
    params: { cfg: OpenClawConfig; agentId: string },
    force: boolean,
  ): Promise<SessionSyncStartResult> {
    const startedAt = new Date().toISOString();
    const { work, state, directory } = this.#openSessionWork(params.agentId);
    let handedOff = false;
    try {
      const key = { kind: SESSION_SYNC_WORK_KIND, scope: params.agentId };
      const claimRun = () => work.claim({ ...key, mode: "run", owner: this.#workOwner,
        leaseMs: DEFAULTS.sessionSync.leaseMs, ignoreDueAt: true });
      work.enqueue({ ...key, mode: "run" });
      let claim = claimRun();
      // Re-arm a row some other path left settled; `requeue` never steals a live lease.
      if (!claim && !liveRun(work.get(key.kind, key.scope)) && work.requeue(key.kind, key.scope, 0)) claim = claimRun();
      if (!claim) {
        const row = work.get(key.kind, key.scope);
        return { status: "already_running", startedAt: row ? runningStatus(row, state.readReceipt()).startedAt : startedAt };
      }
      const blocked = this.#admissionBlockedReason();
      if (blocked) {
        work.fail(claim, { error: blocked, retryAt: 0 });
        return { status: "unavailable", error: blocked };
      }
      const held = claim;
      work.withFence(held, () => state.writeReceipt({ status: "running", phase: "queued", startedAt, attempt: held.attempt }));
      const run = this.#runSessionSync(params, force, { work, state, claim: held, startedAt, directory });
      handedOff = true;
      this.#activeSessionSyncs.set(directory, run);
      const cleanupRun = () => {
        if (this.#activeSessionSyncs.get(directory) === run) {
          this.#activeSessionSyncs.delete(directory);
        }
      };
      run.then(cleanupRun, cleanupRun);
      return { status: "started", startedAt };
    } finally {
      if (!handedOff) work.close();
    }
  }

  async #runSessionSync(
    params: { cfg: OpenClawConfig; agentId: string },
    force: boolean,
    run: SessionSyncRun,
  ): Promise<void> {
    const { work, state, claim, startedAt } = run;
    const abort = new AbortController();
    const tracked = { work, abort };
    this.#runningSyncs.add(tracked);
    const heartbeat = startWorkHeartbeat(work, claim, {
      intervalMs: DEFAULTS.sessionSync.heartbeatMs,
      leaseMs: DEFAULTS.sessionSync.leaseMs,
      onFenceLost: (error) => abort.abort(error),
      onError: (error) => this.#reportError(error),
    });
    // Probe the fence before every QMD mutation (a cheap read): a reclaimed or interrupted attempt aborts at once
    // instead of writing until the next heartbeat notices.
    const beforeWrite = () => {
      const row = work.get(claim.kind, claim.scope);
      if (row?.status !== "running" || row.attempt !== claim.attempt) abort.abort(new WorkFenceLostError(claim, "session sync write"));
    };
    const writePhase = (phase: "projecting" | "indexing") => {
      try { work.withFence(claim, () => state.writeReceipt({ status: "running", phase, startedAt, attempt: claim.attempt })); }
      catch (error) { if (error instanceof WorkFenceLostError) abort.abort(error); /* A busy phase write is cosmetic. */ }
    };
    try {
      const sessions = this.#sessionConfig(params.cfg, params.agentId);
      let result = !force && sessions
        ? await unchangedSessionSync({ ...sessions, state: { read: () => state.readManifest() } },
          qmdDatabasePath(run.directory))
        : undefined;
      if (!result) {
        abort.signal.throwIfAborted();
        const { manager, error } = await this.getMemorySearchManager(params);
        if (!manager) throw new Error(error ?? "memory unavailable");
        result = await manager.syncSessions(force, writePhase, {
          signal: abort.signal,
          beforeWrite,
          // A fenced-out (reclaimed or interrupted) attempt can never publish its manifest.
          persist: (manifest) => work.withFence(claim, () => state.writeManifest(manifest)),
        });
      }
      const completed: SessionSyncReceipt = { status: "completed", startedAt, completedAt: new Date().toISOString(), ...result };
      work.commitWithDomain(claim, { nextDueAt: 0 }, () => state.writeReceipt(completed));
      // SQLite now owns a certified manifest: retire the Markdown-transport sidecars and plaintext projections, unless
      // a still-failing (cold, unreadable) window still has a usable legacy disk projection.
      if (state.revision() > 0 && legacySessionArtifactsRetirable(run.directory, state.readManifest())) {
        removeLegacySessionSyncArtifacts(run.directory);
      }
    } catch (error) {
      // Released by gateway_stop or reclaimed elsewhere: the lease is gone, so record nothing here.
      if (error instanceof WorkFenceLostError || abort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      try {
        work.withFence(claim, () => state.writeReceipt({ status: "failed", startedAt, completedAt: new Date().toISOString(), error: message }));
        work.fail(claim, { error: message, retryAt: 0 });
      } catch {
        // Fence lost while failing: the next status read reports the interruption.
      }
    } finally {
      heartbeat.stop();
      this.#runningSyncs.delete(tracked);
      work.close();
    }
  }

  async sessionSyncStatus(agentId: string): Promise<SessionSyncStatus> {
    const directory = this.#stateDir(agentId);
    if (!lstatSync(curationDatabasePath(directory), { throwIfNoEntry: false }) &&
      !lstatSync(join(directory, "session-sync-status.json"), { throwIfNoEntry: false })) {
      return { status: "idle" };
    }
    const { work, state } = this.#openSessionWork(agentId);
    try {
      const row = work.get(SESSION_SYNC_WORK_KIND, agentId);
      const receipt = state.readReceipt();
      if (liveRun(row)) return runningStatus(row, receipt);
      if (receipt?.status === "running") {
        // Its lease expired or gateway_stop released it: that attempt can never finish.
        const current = state.interruptReceipt(receipt.attempt, new Date().toISOString());
        const refreshed = work.get(SESSION_SYNC_WORK_KIND, agentId);
        if (liveRun(refreshed)) return runningStatus(refreshed, current);
        return current ? publicStatus(current) : { status: "idle" };
      }
      return receipt ? publicStatus(receipt) : { status: "idle" };
    } finally {
      work.close();
    }
  }

  /** Synchronous graceful release for gateway_stop: free the lease (0 strikes), then stop in-flight syncs. */
  #interruptSessionSyncs(): void {
    for (const { work } of this.#runningSyncs) {
      try { work.interruptOwner(this.#workOwner); }
      catch { /* A busy store keeps its lease; it expires and the abort below still stops the run. */ }
    }
    for (const { abort } of this.#runningSyncs) abort.abort(new Error("memory runtime is closing"));
  }

  async #drainSessionSyncs(): Promise<void> {
    while (this.#pendingSessionSyncStarts.size > 0 || this.#activeSessionSyncs.size > 0) {
      await Promise.allSettled([
        ...this.#pendingSessionSyncStarts,
        ...this.#activeSessionSyncs.values(),
      ]);
    }
  }

  #hasWorkToDrain(): boolean {
    return this.#pendingSessionSyncStarts.size > 0 || this.#activeSessionSyncs.size > 0 ||
      this.#managers.size > 0 || this.#closingManagers.size > 0;
  }

  #closeManagerBatch(): Promise<PromiseSettledResult<void>[]> | undefined {
    const agentIds = new Set([...this.#managers.keys(), ...this.#closingManagers.keys()]);
    if (agentIds.size) return Promise.allSettled([...agentIds].map(agentId => this.closeMemorySearchManager({ agentId })));
  }

  prepareReload(
    change: Parameters<NonNullable<MemoryPluginRuntimeContract["prepareReload"]>>[0],
  ): ReturnType<NonNullable<MemoryPluginRuntimeContract["prepareReload"]>> {
    // QMD embeds locally rather than via host MemoryEmbeddingProviderAdapter instances,
    // so only retiring this runtime affects its managers and session syncs.
    if (!change.retireRuntime) {
      return {
        drain: async () => ({ errors: [] }),
        resume() {},
      };
    }
    this.#reloadFences += 1;
    this.#pauseSessionSyncSchedule();
    let resumed = false;
    let drainPromise: Promise<{ errors: readonly unknown[] }> | undefined;
    return {
      drain: () => {
        if (!drainPromise) {
          drainPromise = (async () => {
            const errors: unknown[] = [];
            if (resumed) return { errors };
            do {
              await this.#drainSessionSyncs();
              if (resumed) break;
              const batch = this.#closeManagerBatch();
              if (batch) {
                for (const outcome of await batch) {
                  if (outcome.status === "rejected") errors.push(outcome.reason);
                }
              }
            } while (!resumed && this.#hasWorkToDrain());
            return { errors };
          })();
        }
        return drainPromise;
      },
      resume: () => {
        if (resumed) return;
        resumed = true;
        this.#reloadFences = Math.max(0, this.#reloadFences - 1);
        this.#maybeResumeSessionSyncSchedule();
      },
    };
  }

  async closeMemorySearchManager(params: { agentId: string }): Promise<void> {
    const { agentId } = params;
    const activeSync = this.#activeSessionSyncs.get(this.#stateDir(agentId));
    if (activeSync) await activeSync.catch(() => undefined);
    const previousClose = this.#closingManagers.get(agentId);
    const entry = this.#managers.get(agentId);
    this.#managers.delete(agentId);
    if (!previousClose && !entry) return;

    const closing = (async () => {
      let closeError: unknown;
      if (previousClose) {
        try {
          await previousClose;
        } catch (error) {
          closeError = error;
        }
      }
      if (entry) {
        let startupFailed = false;
        try {
          await entry.ready;
        } catch {
          // Failed startup already cleaned up its own manager inside #startManager.
          startupFailed = true;
        }
        if (!startupFailed) {
          try {
            await entry.manager.close();
          } catch (error) {
            closeError ??= error;
          }
        }
      }
      if (closeError !== undefined) throw closeError;
    })();

    this.#closingManagers.set(agentId, closing);
    try {
      await closing;
    } finally {
      if (this.#closingManagers.get(agentId) === closing) {
        this.#closingManagers.delete(agentId);
      }
    }
  }

  async closeAllMemorySearchManagers(): Promise<void> {
    this.#closeAllFences += 1;
    this.stopSessionSyncSchedule();
    let failure: PromiseRejectedResult | undefined;
    try {
      while (this.#hasWorkToDrain()) {
        await this.#drainSessionSyncs();
        const batch = this.#closeManagerBatch();
        if (!batch) continue;
        const settled = await batch;
        failure ??= settled.find(outcome => outcome.status === "rejected");
      }
    } finally {
      this.#closeAllFences = Math.max(0, this.#closeAllFences - 1);
    }
    if (failure) throw failure.reason;
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#shutdownStarted = true;
    this.stopFleetCommonsSchedule();
    this.#fleetCommonsLifetime.abort(new Error("memory runtime is closing"));
    this.#interruptSessionSyncs();
    const closing = (async () => { await this.closeAllMemorySearchManagers(); })();
    this.#closePromise = closing;
    return closing;
  }

  async searchSkills(
    params: { cfg: OpenClawConfig; agentId: string },
    query: string,
    minScore: number,
    limit: number,
  ) {
    const { manager, error } = await this.getMemorySearchManager(params);
    if (!manager) throw new Error(error ?? "memory unavailable");
    return manager.searchSkills(query, minScore, limit);
  }

  async listSkills(params: { cfg: OpenClawConfig; agentId: string }): Promise<SkillCatalogEntry[]> {
    // The first-use memory sync can load QMD embeddings; the catalog does not need it.
    const { manager, error } = await this.#getManager(params, false);
    if (!manager) throw new Error(error ?? "memory unavailable");
    return manager.listSkills();
  }

  resolveSkillPath(params: { cfg: OpenClawConfig; agentId: string }, path: string): string | undefined {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const skillCorpora = this.#corpora.filter((corpus) => corpus.kind === "skills");
    const sources = resolveSources(workspaceDir, skillCorpora);
    const direct = resolveConfiguredSkillPath(workspaceDir, path, sources);
    if (direct) return direct;
    // A read can pin a configured alias even when its name lost catalog deduplication.
    const aliases = this.#managers.get(params.agentId)?.manager.skillAliases(path) ?? [];
    if (aliases.some(alias => resolveConfiguredSkillPath(workspaceDir, alias, sources) === path)) return path;
  }

  #createManager(cfg: OpenClawConfig, agentId: string): QmdMemoryManager {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const stateDir = this.#stateDir(agentId);
    const fileCorpora = this.#corpora.filter((corpus) => corpus.kind === "files" || corpus.kind === "skills");
    const sessions = this.#sessionConfig(cfg, agentId);
    const sources = resolveSources(workspaceDir, fileCorpora);
    if (sessions) sources.push(this.#sessionSource(agentId, sessions.chatTypes));
    return new QmdMemoryManager({
      workspaceDir,
      dbPath: qmdDatabasePath(stateDir),
      curationPath: curationDatabasePath(stateDir),
      extraction: this.#extraction,
      ...(this.#fleetCommons ? { fleetCommons: this.#fleetCommons } : {}),
      sources,
      keepModelsWarm: this.#keepEmbeddingModelWarm,
      analysisExecutable: this.#analysisExecutable,
      sessions,
      trackRecallLocators: this.#recallLedgerEnabled,
    });
  }

  async #startManager(agentId: string, entry: ManagerEntry): Promise<void> {
    const { manager } = entry;
    const schedule = this.#fleetCommonsSchedule;
    try {
      await manager.start();
    } catch (error) {
      // Release a failed startup before the cache can admit a replacement.
      await manager.close().catch(() => undefined);
      throw error;
    }
    entry.started = true;
    // A stopped schedule stays cancelled even if a replacement was installed during this startup.
    if (this.#managers.get(agentId) === entry) {
      void this.#syncFleetCommonsFor(agentId, manager, schedule ?? this.#fleetCommonsSchedule);
    }
  }

  #sessionConfig(cfg: OpenClawConfig, agentId: string): ManagerSessionConfig | undefined {
    const corpus = this.#corpora.find(corpus => corpus.kind === "sessions");
    if (!corpus) return;
    const stateDir = this.#stateDir(agentId);
    return {
      agentId, agentName: resolveAgentIdentity(cfg, agentId)?.name?.trim() || agentId,
      chatTypes: corpus.chatTypes, maxExpandedTokens: corpus.maxExpandedTokens,
      collection: this.#sessionSource(agentId, corpus.chatTypes).collection,
      databasePath: agentTranscriptDatabase(cfg, agentId),
      statePath: curationDatabasePath(stateDir),
      legacyStateDir: stateDir,
      timezone: resolveTimezone(cfg.agents?.defaults?.userTimezone?.trim()),
      syntheticInput: this.#syntheticInput,
    };
  }

  /** Projected (no files): the retired projection directory only keeps the collection identity stable. */
  #sessionSource(agentId: string, chatTypes: ManagerSessionConfig["chatTypes"]) {
    return resolveSessionSource(join(this.#stateDir(agentId), "sessions"), chatTypes);
  }

  #stateDir(agentId: string): string {
    return agentStateDir(agentId, this.#stateRoot);
  }

}
