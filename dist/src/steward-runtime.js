import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { agentStateDir } from "./agent-paths.js";
import { DEFAULTS } from "./defaults.js";
import { MEMORY_DATABASE } from "./memory-database.js";
import { buildPeopleShadowReport, runPeopleShadowPass, PEOPLE_SHADOW_KIND } from "./steward-people-shadow.js";
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
    const listAgents = options.listAgents ?? listAgentIds;
    const openWorkStore = options.openWorkStore ?? ((dbPath) => new WorkStore(dbPath));
    registerStewardCli(api, options, dbPathForAgent, openWorkStore);
    const owner = `steward:${process.pid}:${randomUUID()}`;
    const openStores = new Set();
    let lifetime = new AbortController();
    let timer;
    let running;
    const lastResults = new Map();
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
                agents = runner ? listAgents(api.config) : [];
            }
            catch (error) {
                // `void tick()` must never surface an unhandled rejection.
                if (!signal.aborted)
                    api.logger.warn(`unblock-memory steward: ${String(error)}`);
                return;
            }
            for (const agentId of agents) {
                if (signal.aborted)
                    break;
                let store;
                try {
                    const dbPath = dbPathForAgent(agentId);
                    store = openWorkStore(dbPath);
                    openStores.add(store);
                    if (options.config.peopleShadow.enabled && runner) {
                        lastResults.set(agentId, await runPeopleShadowPass({
                            dbPath, agentId, workStore: store, runner, owner, signal,
                            maxItems: options.config.peopleShadow.maxItemsPerRun, timeoutMs: options.config.peopleShadow.timeoutMs,
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
    const enabled = api.registrationMode !== "cli-metadata" && options.config.enabled && options.config.peopleShadow.enabled;
    if (enabled) {
        api.on("gateway_start", () => {
            if (timer)
                clearInterval(timer);
            if (lifetime.signal.aborted)
                lifetime = new AbortController();
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
function summarize(items) {
    const byKind = {};
    for (const item of items) {
        byKind[item.kind] ??= {};
        byKind[item.kind][item.status] = (byKind[item.kind][item.status] ?? 0) + 1;
    }
    return byKind;
}
function registerStewardCli(api, options, dbPathForAgent, openWorkStore) {
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
    api.registerCli(({ program, config: cfg }) => {
        const root = program.command("memory-steward").description("Steward background work: status, People shadow report, re-drive");
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
                    counts: summarize(items),
                    quarantined: items.filter(item => item.status === "quarantined")
                        .map(({ kind, scope, strikes, lastError }) => ({ kind, scope, strikes, lastError })),
                }, null, 2));
            });
        });
        root.command("shadow-report").description("Side-by-side People shadow proposals vs cron receipts (read-only)")
            .option("--agent <id>", "Agent id", "main").option("--manifest <id>", "One people-learning run id, e.g. nightly:2026-11-25")
            .action((opts) => {
            console.log(JSON.stringify(buildPeopleShadowReport(knownAgent(cfg, opts.agent), opts.manifest), null, 2));
        });
        root.command("requeue").description("Explicitly re-drive one quarantined or completed work item")
            .requiredOption("--scope <scope>", "Exact work scope").option("--kind <kind>", "Work kind", PEOPLE_SHADOW_KIND)
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
    }, { descriptors: [{ name: "memory-steward", description: "Steward background work status and People shadow report", hasSubcommands: true }] });
}
