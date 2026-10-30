import { join, dirname } from "node:path";
import { resolveAgentDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { MEMORY_DATABASE } from "./memory-database.js";
import { dateOption } from "./date-option.js";
import { linkInsideOutPeople, purgeInsideOutPerson, repairInsideOutIdentities, reportInsideOut, runInsideOut, refreshInsideOutBaselinesAsync, reportInsideOutBaselines } from "./inside-out.js";
import { agentStateDir, agentTranscriptDatabase } from "./agent-paths.js";
export function registerInsideOut(api, config) {
    const paths = (cfg, agentId) => {
        if (!listAgentIds(cfg).includes(agentId))
            throw new Error("Unknown Inside Out agent");
        const agentDir = resolveAgentDir(cfg, agentId);
        return { agentId, databasePath: agentTranscriptDatabase(cfg, agentId), sessionsDir: join(dirname(agentDir), "sessions"),
            storePath: join(agentStateDir(agentId), MEMORY_DATABASE) };
    };
    api.registerCli(({ program, config: cfg }) => {
        const root = program.command("memory-emotions").description("Inside Out: review human replies and analyze emotion probabilities");
        root.command("link-people").description("Backfill or refresh People identity links without Jev")
            .option("--agent <id>", "Agent id", "main")
            .option("--repair-identities", "Recover legacy sender/channel metadata for unlinked reviews")
            .action(async (opts) => {
            const p = paths(cfg, opts.agent);
            const repair = opts.repairIdentities ? await repairInsideOutIdentities(p) : undefined;
            console.log(JSON.stringify({ ...repair, ...linkInsideOutPeople(p.storePath) }, null, 2));
            await refreshInsideOutBaselinesAsync(p.storePath, { minInteractions: config.insideOut.baselineMinInteractions, link: false });
            if (repair?.errors.length)
                process.exitCode = 1;
        });
        root.command("run").option("--agent <id>", "Agent id", "main").option("--retry", "Retry failed judgments immediately")
            .option("--session <id>", "Review only this session")
            .action(async (opts) => {
            const result = await runInsideOut({ ...paths(cfg, opts.agent), config, retry: opts.retry, sessionId: opts.session });
            console.log(JSON.stringify(result, null, 2));
            if ("failed" in result && (result.failed || result.errors.length || result.baselineError))
                process.exitCode = 1;
        });
        root.command("baseline-refresh").description("Update local weekly baselines and missing comparisons; no Jev calls")
            .option("--agent <id>", "Agent id", "main")
            .option("--recompare", "Append revised comparisons using newly available historical grades; preserve earlier results")
            .action(async (opts) => {
            console.log(JSON.stringify(await refreshInsideOutBaselinesAsync(paths(cfg, opts.agent).storePath, { minInteractions: config.insideOut.baselineMinInteractions, recompare: opts.recompare }), null, 2));
        });
        root.command("baselines").description("Read person-linked weekly and cumulative baseline history")
            .option("--agent <id>", "Agent id", "main").option("--person <id>", "Exact PeopleSQL person ID")
            .option("--since <date>", "Inclusive UTC period-end date YYYY-MM-DD").option("--limit <n>", "Maximum weekly snapshots, 1–1000", "100")
            .action((opts) => {
            console.log(JSON.stringify(reportInsideOutBaselines(paths(cfg, opts.agent).storePath, { personId: opts.person, since: opts.since ? dateOption(opts.since, 0) : undefined, limit: Number(opts.limit) }), null, 2));
        });
        root.command("purge").description("Delete one person's emotion baselines and assessment history; no Jev calls")
            .requiredOption("--person <id>", "Exact PeopleSQL person ID").option("--agent <id>", "Agent id", "main")
            .option("--grades", "Also erase this person's raw emotion grades; tombstones keep those replies from being regraded")
            .action((opts) => {
            console.log(JSON.stringify(purgeInsideOutPerson(paths(cfg, opts.agent).storePath, opts.person, { grades: opts.grades }), null, 2));
        });
        for (const command of ["report", "export"]) {
            root.command(command).option("--agent <id>", "Agent id", "main")
                .option("--session <id>", "Filter one session")
                .option("--sender <id>", "Human sender ID").option("--since <date>", "Inclusive UTC date YYYY-MM-DD")
                .option("--person <id>", "Exact PeopleSQL person ID").option("--deviation-history", "Include previous personal comparisons (export)")
                .option("--emotion <name>", "Filter an emotion probability").option("--min <probability>", "Minimum probability", "0")
                .option("--bucket <period>", "day or week (report)", "day")
                .action((opts) => {
                console.log(JSON.stringify(reportInsideOut(paths(cfg, opts.agent).storePath, { ...opts,
                    sessionId: opts.session, personId: opts.person, personal: command === "export",
                    since: opts.since ? dateOption(opts.since, 0) : undefined, min: Number(opts.min), summary: command === "report" }), null, 2));
            });
        }
    }, { descriptors: [{ name: "memory-emotions", description: "Inside Out emotion reviews and reports", hasSubcommands: true }] });
    if (api.registrationMode === "cli-metadata" || !config.insideOut.enabled)
        return;
    let timer, baselineTimer, running;
    let refreshing;
    let lifetime = new AbortController();
    const tick = () => {
        if (running)
            return;
        running = (async () => {
            for (const agentId of listAgentIds(api.config)) {
                if (lifetime.signal.aborted)
                    break;
                try {
                    const result = await runInsideOut({ ...paths(api.config, agentId), config, signal: lifetime.signal });
                    if ("failed" in result && (result.failed || result.errors.length))
                        api.logger.warn("Inside Out: some reviews or sources failed; inspect memory-emotions export");
                    if ("baselineError" in result && result.baselineError)
                        api.logger.warn(`Inside Out baselines: ${result.baselineError}`);
                }
                catch (error) {
                    if (!lifetime.signal.aborted)
                        api.logger.warn(`Inside Out: ${String(error)}`);
                }
            }
        })().finally(() => { running = undefined; });
    };
    api.on("gateway_start", () => {
        lifetime = new AbortController();
        const refresh = () => {
            if (refreshing)
                return;
            refreshing = (async () => {
                for (const agentId of listAgentIds(api.config)) {
                    if (lifetime.signal.aborted)
                        break;
                    try {
                        await refreshInsideOutBaselinesAsync(paths(api.config, agentId).storePath, { minInteractions: config.insideOut.baselineMinInteractions }, lifetime.signal);
                    }
                    catch (error) {
                        if (!lifetime.signal.aborted)
                            api.logger.warn(`Inside Out baselines: ${String(error)}`);
                    }
                }
            })().finally(() => { refreshing = undefined; });
        };
        // Local statistics remain available when inference is manual-only or lacks a key.
        baselineTimer = setInterval(refresh, 86400_000);
        baselineTimer.unref();
        refresh();
        if (config.typesafe.enabled && config.insideOut.intervalMinutes) {
            timer = setInterval(tick, config.insideOut.intervalMinutes * 60_000);
            timer.unref();
            tick();
        }
    });
    // Aborting cancels active baseline workers rather than waiting for a full historical pass.
    api.on("gateway_stop", async () => { if (timer)
        clearInterval(timer); if (baselineTimer)
        clearInterval(baselineTimer); lifetime.abort(); await Promise.all([running, refreshing]); });
}
