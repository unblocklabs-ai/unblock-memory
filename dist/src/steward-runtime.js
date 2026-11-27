import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { agentStateDir, agentTranscriptDatabase } from "./agent-paths.js";
import { DEFAULTS } from "./defaults.js";
import { MEMORY_DATABASE } from "./memory-database.js";
import { runOutcomeLedgerPass, summarizeOutcomeMetrics } from "./outcome-ledger.js";
import { responseCohort } from "./response-audit.js";
import { resolveTimezone } from "./session-projector.js";
import { listOpenBlockers, runCaptainsLogPass } from "./steward-captains-log.js";
import { buildPeopleShadowReport, runPeopleShadowPass, PEOPLE_SHADOW_KIND, } from "./steward-people-shadow.js";
import { WorkStore } from "./work-store.js";
/* ═════════════════════════ Background semaphore ═════════════════════════ */
const BACKGROUND_SLOTS = Symbol.for("unblock-memory.steward.backgroundSlots");
function slots() {
    const global = globalThis;
    global[BACKGROUND_SLOTS] ??= { active: 0 };
    return global[BACKGROUND_SLOTS];
}
/** Process-wide (all agents, all plugin instances) background Steward slot; returns a one-shot release or undefined at capacity. */
export function tryAcquireBackgroundSlot(maxActive) {
    const state = slots();
    if (state.active >= Math.max(1, maxActive))
        return undefined;
    state.active += 1;
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        state.active = Math.max(0, state.active - 1);
    };
}
export function activeBackgroundStewards() {
    return slots().active;
}
class StewardShutdownError extends Error {
    name = "StewardShutdownError";
    constructor() { super("gateway stopping"); }
}
export function registerStewardRuntime(api, options) {
    const dbPathForAgent = options.dbPathForAgent ?? ((agentId) => join(agentStateDir(agentId), MEMORY_DATABASE));
    const transcriptDbForAgent = options.transcriptDbForAgent ?? agentTranscriptDatabase;
    const workspaceDirForAgent = options.workspaceDirForAgent ?? resolveAgentWorkspaceDir;
    const listAgents = options.listAgents ?? listAgentIds;
    const openWorkStore = options.openWorkStore ?? ((dbPath) => new WorkStore(dbPath));
    registerStewardCli(api, options, dbPathForAgent, openWorkStore, transcriptDbForAgent, workspaceDirForAgent);
    const owner = `steward:${process.pid}:${randomUUID()}`;
    const openStores = new Set();
    let lifetime = new AbortController();
    let timer;
    let running;
    const lastResults = new Map();
    const lastCaptainsLogResults = new Map();
    const lastOutcomeLedgerResults = new Map();
    const outcomeLedger = options.config.outcomeLedger;
    // Same cohort Response Audit writes, so outcomes never mix verdicts from another judge configuration.
    const outcomeCohort = options.pluginConfig?.responseAudit.enabled
        ? responseCohort(options.pluginConfig.responseAudit, options.pluginConfig.decisionModel.model, options.pluginConfig.decisionModel.endpoint)
        : undefined;
    const tick = () => {
        if (running)
            return running;
        const { signal } = lifetime;
        if (signal.aborted)
            return Promise.resolve();
        const release = tryAcquireBackgroundSlot(options.config.maxActiveBackground);
        if (!release)
            return Promise.resolve(); // Another agent/instance holds the gateway's background slot.
        running = (async () => {
            let agents;
            let runner;
            try {
                runner = options.createRunner();
            }
            catch (error) {
                // The deterministic Outcome Ledger needs no model; keep closing the loop without a runner.
                if (!signal.aborted)
                    api.logger.warn(`unblock-memory steward: ${String(error)}`);
            }
            try {
                agents = runner || outcomeLedger.enabled ? listAgents(api.config) : [];
            }
            catch (error) {
                // `void tick()` must never surface an unhandled rejection.
                if (!signal.aborted)
                    api.logger.warn(`unblock-memory steward: ${String(error)}`);
                return;
            }
            const inventoryContext = options.pluginConfig
                ? { cfg: api.config, config: options.pluginConfig }
                : undefined;
            const timezone = resolveTimezone(api.config?.agents?.defaults?.userTimezone?.trim());
            for (const agentId of agents) {
                if (signal.aborted)
                    break;
                let store;
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
                                ...(options.pluginConfig ? { baselineMinInteractions: options.pluginConfig.insideOut.baselineMinInteractions } : {}),
                                ...(outcomeCohort ? { responseCohort: outcomeCohort } : {}),
                            }));
                        }
                        catch (error) {
                            // Isolated: a ledger fault must not skip this agent's model-backed passes.
                            if (!signal.aborted)
                                api.logger.warn(`unblock-memory steward outcome ledger (${agentId}): ${String(error)}`);
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
                }
                catch (error) {
                    if (!signal.aborted)
                        api.logger.warn(`unblock-memory steward (${agentId}): ${String(error)}`);
                }
                finally {
                    if (store) {
                        openStores.delete(store);
                        try {
                            store.close();
                        }
                        catch { }
                    }
                }
            }
        })().finally(() => { release(); running = undefined; });
        return running;
    };
    const stop = async () => {
        if (timer) {
            clearInterval(timer);
            timer = undefined;
        }
        // Abort in-flight work and release leases in one synchronous step, so a graceful stop adds 0 strikes even if
        // the process exits mid-await. interruptOwner waits at most 200ms on a held lock (the lease then expires).
        lifetime.abort(new StewardShutdownError());
        for (const store of openStores) {
            try {
                store.interruptOwner(owner);
            }
            catch { }
        }
        const pending = running;
        if (!pending)
            return;
        let graceTimer;
        await Promise.race([
            pending.catch(() => undefined),
            new Promise(resolve => { graceTimer = setTimeout(resolve, options.shutdownGraceMs ?? DEFAULTS.steward.shutdownGraceMs); graceTimer.unref?.(); }),
        ]);
        if (graceTimer)
            clearTimeout(graceTimer);
    };
    const enabled = api.registrationMode !== "cli-metadata" && options.config.enabled &&
        (options.config.peopleShadow.enabled || options.config.captainsLog.enabled || outcomeLedger.enabled);
    if (enabled) {
        api.on("gateway_start", () => {
            if (timer)
                clearInterval(timer);
            if (lifetime.signal.aborted)
                lifetime = new AbortController();
            const intervals = [];
            if (options.config.peopleShadow.enabled)
                intervals.push(options.config.peopleShadow.intervalMinutes);
            if (options.config.captainsLog.enabled)
                intervals.push(options.config.captainsLog.intervalMinutes);
            if (outcomeLedger.enabled)
                intervals.push(outcomeLedger.intervalMinutes);
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
        enabled,
    };
}
/* ═════════════════════════ CLI ═════════════════════════ */
function summarize(items) {
    const byKind = {};
    for (const item of items) {
        byKind[item.kind] ??= {};
        byKind[item.kind][item.status] = (byKind[item.kind][item.status] ?? 0) + 1;
    }
    return byKind;
}
function registerStewardCli(api, options, dbPathForAgent, openWorkStore, transcriptDbForAgent, workspaceDirForAgent) {
    const knownAgent = (cfg, agentId) => {
        if (!(options.listAgents ?? listAgentIds)(cfg).includes(agentId))
            throw new Error("Unknown steward agent");
        return dbPathForAgent(agentId);
    };
    const withStore = (dbPath, fn) => {
        const store = openWorkStore(dbPath);
        try {
            return fn(store);
        }
        finally {
            store.close();
        }
    };
    /**
     * Reporting never creates or migrates the database. An absent file reads as an empty in-memory
     * database; readers already treat missing tables as empty.
     */
    const withReadOnlyDb = (dbPath, fn) => {
        const db = existsSync(dbPath) ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(":memory:");
        try {
            db.exec(`PRAGMA busy_timeout=${DEFAULTS.sqlite.mainBusyTimeoutMs}`);
            return fn(db);
        }
        finally {
            db.close();
        }
    };
    api.registerCli(({ program, config: cfg }) => {
        const root = program.command("memory-steward").description("Steward background work: status, People report, Captain's Log, re-drive");
        root.command("status").description("Work item counts by kind/status plus the quarantined backlog")
            .option("--agent <id>", "Agent id", "main").option("--kind <kind>", "Filter one work kind")
            .action((opts) => {
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
                    counts: summarize(items),
                    quarantined: items.filter(item => item.status === "quarantined")
                        .map(({ kind, scope, strikes, lastError }) => ({ kind, scope, strikes, lastError })),
                }, null, 2));
            });
        });
        root.command("shadow-report").description("Side-by-side People Steward proposals/publications vs cron receipts (read-only)")
            .option("--agent <id>", "Agent id", "main").option("--manifest <id>", "One people-learning run id, e.g. nightly:2026-11-25")
            .action((opts) => {
            console.log(JSON.stringify(buildPeopleShadowReport(knownAgent(cfg, opts.agent), opts.manifest), null, 2));
        });
        root.command("captains-log").description("Run or preview Steward Captain's Log distillation for one agent")
            .option("--agent <id>", "Agent id", "main").option("--dry-run", "Preview entries without writing or moving watermarks", false)
            .action(async (opts) => {
            const dbPath = knownAgent(cfg, opts.agent);
            const runner = options.createRunner();
            if (!runner) {
                console.log(JSON.stringify({ status: "disabled" }));
                process.exitCode = 1;
                return;
            }
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
            }
            finally {
                store.close();
            }
        });
        root.command("outcomes").description("Outcome Ledger KPIs: whisper use, skill opens, shortfalls, by recipe (read-only)")
            .option("--agent <id>", "Agent id", "main").option("--since-hours <n>", "Only exposures from the last n hours")
            .option("--recipe <hash>", "Only one retrieval recipe hash")
            .action((opts) => {
            const sinceHours = opts.sinceHours === undefined ? undefined : Number(opts.sinceHours);
            if (sinceHours !== undefined && !(Number.isFinite(sinceHours) && sinceHours > 0)) {
                throw new Error("--since-hours must be a positive number");
            }
            const recipeHash = opts.recipe?.trim();
            if (opts.recipe !== undefined && !recipeHash)
                throw new Error("--recipe must be a non-empty hash");
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
            .action((opts) => {
            const limit = Number(opts.limit);
            if (!Number.isSafeInteger(limit) || limit < 0)
                throw new Error("--limit must be a non-negative integer");
            const dbPath = knownAgent(cfg, opts.agent);
            withReadOnlyDb(dbPath, db => {
                const blockers = listOpenBlockers(db, opts.agent, limit);
                console.log(JSON.stringify({ agentId: opts.agent, count: blockers.length, blockers }, null, 2));
            });
        });
        root.command("requeue").description("Explicitly re-drive one quarantined or completed work item")
            .requiredOption("--scope <scope>", "Exact work scope")
            .option("--kind <kind>", "Work kind (e.g. people_shadow, people_interactions, captains_log, outcome_ledger)", PEOPLE_SHADOW_KIND)
            .option("--agent <id>", "Agent id", "main")
            .action((opts) => {
            const dbPath = knownAgent(cfg, opts.agent);
            withStore(dbPath, store => {
                if (!store.get(opts.kind, opts.scope)) {
                    console.log(JSON.stringify({ status: "not_found" }));
                    process.exitCode = 1;
                    return;
                }
                if (!store.requeue(opts.kind, opts.scope)) {
                    console.log(JSON.stringify({ status: "busy", item: store.get(opts.kind, opts.scope) }, null, 2));
                    process.exitCode = 1;
                    return;
                }
                console.log(JSON.stringify({ status: "requeued", item: store.get(opts.kind, opts.scope) }, null, 2));
            });
        });
    }, { descriptors: [{ name: "memory-steward", description: "Steward background work status, People report, Captain's Log, outcomes and blockers", hasSubcommands: true }] });
}
