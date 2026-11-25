import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { callGatewayFromCli, errorShape, ErrorCodes } from "openclaw/plugin-sdk/gateway-runtime";
import { listAgentIds, resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import { MEMORY_DATABASE, hasMemoryTable } from "./memory-database.js";
import { ExtractionStore } from "./extraction-store.js";
import { extractionSessions } from "./extraction-source.js";
import { dateOption } from "./date-option.js";
import { agentStateDir, agentTranscriptDatabase } from "./agent-paths.js";
export function registerExtraction(api, config, runtime, deps) {
    let lifetime = new AbortController();
    let stopped = false;
    let timer, running;
    const activeRuns = new Set();
    const track = (pending) => {
        const settled = pending.then(() => undefined, () => undefined);
        activeRuns.add(settled);
        void settled.finally(() => { activeRuns.delete(settled); });
        return pending;
    };
    const options = (cfg, agentId) => {
        if (!listAgentIds(cfg).includes(agentId))
            throw new Error("Unknown extraction agent");
        return { agentId, agentName: resolveAgentIdentity(cfg, agentId)?.name?.trim() || agentId,
            config, runtime: api.runtime, storePath: join(agentStateDir(agentId), MEMORY_DATABASE),
            sessions: () => extractionSessions(agentTranscriptDatabase(cfg, agentId), agentId, config.extraction.chatTypes) };
    };
    const run = (cfg, agentId, signal, since, sessionId, scheduled = false) => track((async () => {
        signal.throwIfAborted();
        const opts = options(cfg, agentId);
        // Keep the extraction tokenizer/model modules out of normal plugin startup.
        const execute = deps?.runExtraction ?? (await import("./extraction-worker.js")).runExtraction;
        signal.throwIfAborted();
        const result = await execute({ ...opts, signal, since, scheduled, sessionId });
        if (result.status === "completed" && config.extraction.publish && runtime) {
            signal.throwIfAborted();
            const { manager, error } = await runtime.getMemorySearchManager({ cfg, agentId });
            if (!manager)
                throw new Error(error ?? "Extraction index unavailable");
            signal.throwIfAborted();
            await manager.syncExtracted();
        }
        return result;
    })());
    api.registerCli(({ program, config: cfg }) => {
        const root = program.command("memory-extract").description("Optional session fact extraction; no daily Markdown writes");
        root.command("run").option("--agent <id>", "Agent id", "main")
            .option("--since <date>", "Explicit bounded backfill from YYYY-MM-DD UTC; repeat to resume")
            .option("--session <id>", "Restrict this run to one session")
            .action(async (opts) => {
            const since = opts.since === undefined ? undefined : dateOption(opts.since, 0);
            try {
                // Native harnesses live in the Gateway, not the cold CLI metadata loader.
                const result = await callGatewayFromCli("unblock-memory.extract", { timeout: "600000" }, { agentId: opts.agent, ...(since === undefined ? {} : { since }), ...(opts.session ? { sessionId: opts.session } : {}) });
                console.log(JSON.stringify(result, null, 2));
                if (result.status === "unavailable" || (result.status === "completed" && result.failed))
                    process.exitCode = 1;
            }
            catch {
                console.log(JSON.stringify({ status: "unavailable", reason: "Extraction failed; check the running Gateway, host prerequisites and operator report" }));
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
    if (api.registrationMode === "cli-metadata")
        return;
    const runParams = Type.Object({ agentId: Type.String(), since: Type.Optional(Type.Integer({ minimum: 0 })),
        sessionId: Type.Optional(Type.String()) }, { additionalProperties: false });
    api.registerGatewayMethod("unblock-memory.extract", async ({ params, respond }) => {
        if (!Value.Check(runParams, params)) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid extraction parameters"));
            return;
        }
        if (stopped || lifetime.signal.aborted) {
            respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Extraction failed; check host prerequisites and operator report"));
            return;
        }
        try {
            respond(true, await run(api.config, params.agentId, lifetime.signal, params.since, params.sessionId));
        }
        catch {
            respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Extraction failed; check host prerequisites and operator report"));
        }
    }, { scope: "operator.admin" });
    api.on("gateway_stop", async () => {
        stopped = true;
        lifetime.abort();
        if (timer)
            clearInterval(timer);
        timer = undefined;
        while (activeRuns.size || running) {
            await Promise.allSettled([...activeRuns, ...(running ? [running] : [])]);
        }
    });
    const tick = () => {
        if (stopped || running || lifetime.signal.aborted)
            return;
        const signal = lifetime.signal;
        running = (async () => {
            for (const agentId of listAgentIds(api.config)) {
                if (stopped || signal.aborted)
                    break;
                try {
                    const result = await run(api.config, agentId, signal, undefined, undefined, true);
                    if (result.status === "unavailable" || (result.status === "completed" && result.failed))
                        api.logger.warn("unblock-memory extraction unavailable; inspect memory-extract report");
                }
                catch {
                    if (!signal.aborted)
                        api.logger.warn("unblock-memory extraction unavailable");
                }
            }
        })().finally(() => { running = undefined; });
    };
    api.on("gateway_start", () => {
        stopped = false;
        if (timer)
            clearInterval(timer);
        timer = undefined;
        if (lifetime.signal.aborted)
            lifetime = new AbortController();
        if (!config.extraction.enabled || !config.extraction.intervalMinutes || !config.typesafe.enabled)
            return;
        timer = setInterval(tick, 60_000);
        timer.unref();
        tick();
    });
}
