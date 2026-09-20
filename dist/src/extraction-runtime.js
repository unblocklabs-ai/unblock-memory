import { join } from "node:path";
import { listAgentIds, resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentDir, resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { MEMORY_DATABASE, hasMemoryTable } from "./memory-database.js";
import { ExtractionStore } from "./extraction-store.js";
import { extractionSessions } from "./extraction-source.js";
export function registerExtraction(api, config, runtime) {
    const options = (cfg, agentId) => {
        if (!listAgentIds(cfg).includes(agentId))
            throw new Error("Unknown extraction agent");
        return { agentId, agentName: resolveAgentIdentity(cfg, agentId)?.name?.trim() || agentId,
            config, runtime: api.runtime, storePath: join(resolveStateDir(), "agents", agentId, "unblock-memory", MEMORY_DATABASE),
            sessions: () => extractionSessions(join(resolveAgentDir(cfg, agentId), "openclaw-agent.sqlite"), agentId, config.extraction.chatTypes) };
    };
    const run = async (cfg, agentId, signal, since, sessionId, scheduled = false) => {
        const opts = options(cfg, agentId);
        // Keep the extraction tokenizer/model modules out of normal plugin startup.
        const { runExtraction } = await import("./extraction-worker.js");
        const result = await runExtraction({ ...opts, signal, since, scheduled, sessionId });
        if (result.status === "completed" && config.extraction.publish && runtime) {
            const { manager, error } = await runtime.getMemorySearchManager({ cfg, agentId });
            if (!manager)
                throw new Error(error ?? "Extraction index unavailable");
            await manager.syncExtracted();
        }
        return result;
    };
    api.registerCli(({ program, config: cfg }) => {
        const root = program.command("memory-extract").description("Optional session fact extraction; no daily Markdown writes");
        root.command("run").option("--agent <id>", "Agent id", "main")
            .option("--since <date>", "Explicit bounded backfill from YYYY-MM-DD UTC; repeat to resume")
            .option("--session <id>", "Restrict this run to one session")
            .action(async (opts) => {
            let since;
            if (opts.since !== undefined) {
                since = Date.parse(opts.since);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.since) || !Number.isFinite(since) || new Date(since).toISOString().slice(0, 10) !== opts.since) {
                    throw new Error("since must be a valid YYYY-MM-DD UTC date");
                }
            }
            try {
                const result = await run(cfg, opts.agent, AbortSignal.timeout(600_000), since, opts.session);
                console.log(JSON.stringify(result, null, 2));
                if (result.status === "unavailable" || (result.status === "completed" && result.failed))
                    process.exitCode = 1;
            }
            catch {
                console.log(JSON.stringify({ status: "unavailable", reason: "Extraction failed; check host prerequisites and operator report" }));
                process.exitCode = 1;
            }
        });
        root.command("report").option("--agent <id>", "Agent id", "main").action((opts) => {
            const { storePath } = options(cfg, opts.agent);
            if (!hasMemoryTable(storePath, "extracted_memories")) {
                console.log(JSON.stringify({ status: "not_run" }));
                return;
            }
            const store = new ExtractionStore(storePath);
            try {
                console.log(JSON.stringify(store.report(), null, 2));
            }
            finally {
                store.close();
            }
        });
    }, { descriptors: [{ name: "memory-extract", description: "Extract and inspect source-linked session facts", hasSubcommands: true }] });
    if (api.registrationMode === "cli-metadata" || !config.extraction.enabled || !config.extraction.intervalMinutes || !config.typesafe.enabled)
        return;
    let timer, running;
    let lifetime = new AbortController();
    const tick = () => {
        if (running || lifetime.signal.aborted)
            return;
        running = (async () => {
            for (const agentId of listAgentIds(api.config)) {
                if (lifetime.signal.aborted)
                    break;
                try {
                    const result = await run(api.config, agentId, lifetime.signal, undefined, undefined, true);
                    if (result.status === "unavailable" || (result.status === "completed" && result.failed))
                        api.logger.warn("unblock-memory extraction unavailable; inspect memory-extract report");
                }
                catch {
                    api.logger.warn("unblock-memory extraction unavailable");
                }
            }
        })().finally(() => { running = undefined; });
    };
    api.on("gateway_start", () => {
        if (timer)
            clearInterval(timer);
        lifetime = new AbortController();
        timer = setInterval(tick, 60_000);
        timer.unref();
        tick();
    });
    api.on("gateway_stop", async () => { if (timer)
        clearInterval(timer); timer = undefined; lifetime.abort(); await running; });
}
