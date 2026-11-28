import { DEFAULTS } from "./defaults.js";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { resolveAgentDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { MEMORY_DATABASE } from "./memory-database.js";
import { dateOption } from "./date-option.js";
import { interruptInsideOut, linkInsideOutPeople, purgeInsideOutPerson, repairInsideOutIdentities, reportInsideOut, runInsideOut, refreshInsideOutBaselinesAsync, reportInsideOutBaselineOverview, reportInsideOutBaselines, reportInsideOutDrift } from "./inside-out.js";
import { SENTIMENT_DRIFT_METRICS } from "./emotion-baselines.js";
const collect = (value, previous) => [...previous, value];
/** `metric=value`; `metric=off` disables that flag. */
function thresholdFlags(entries, flag) {
    return Object.fromEntries(entries.map(entry => {
        const [metric, raw] = entry.split("=");
        if (!SENTIMENT_DRIFT_METRICS.includes(metric) || raw === undefined || raw === "") {
            throw new Error(`--${flag} expects <${SENTIMENT_DRIFT_METRICS.join("|")}>=<number|off>`);
        }
        const value = raw === "off" ? null : Number(raw);
        if (value !== null && !Number.isFinite(value))
            throw new Error(`--${flag} ${metric} must be a number or off`);
        return [metric, value];
    }));
}
function driftOptions(opts) {
    const number = (value) => value === undefined ? undefined : Number(value);
    return { personId: opts.person, rubric: opts.rubric, responseCohort: opts.cohort,
        recentWeeks: number(opts.recentWeeks), anchorWeeks: number(opts.anchorWeeks), minWeeklySamples: number(opts.minWeeklySamples),
        minAnchorSamples: number(opts.minAnchorSamples), minRecentSamples: number(opts.minRecentSamples),
        minResponseConfidence: number(opts.minResponseConfidence),
        driftThresholds: thresholdFlags(opts.threshold, "threshold"), levelThresholds: thresholdFlags(opts.level, "level") };
}
function withDriftOptions(command) {
    return command
        .option("--rubric <rubric>", "Only Inside Out grades from this presence rubric (default: all)")
        .option("--cohort <cohort>", "Only this Response Audit cohort (default: latest assessment per episode)")
        .option("--recent-weeks <n>", "Recent window in weeks ending now (default 3)")
        .option("--anchor-weeks <n>", "Earliest stable weeks forming the anchored baseline (default 4)")
        .option("--min-weekly-samples <n>", "Samples a week needs to count as stable (default 1)")
        .option("--min-anchor-samples <n>", "Samples the anchor needs (default 5)")
        .option("--min-recent-samples <n>", "Samples the recent window needs (default 3)")
        .option("--min-response-confidence <p>", "Minimum audit confidence for dissatisfaction scores, 0–1 (default 0.8)")
        .option("--threshold <metric=value>", "Drift threshold per metric; repeatable; 'off' disables", collect, [])
        .option("--level <metric=value>", "Sustained absolute level per metric; repeatable; 'off' disables", collect, []);
}
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
        root.command("link-people").description("Backfill or refresh People identity links without the decision model")
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
            // Explicit operator pass: run now unless another process holds the live lease.
            const result = await runInsideOut({ ...paths(cfg, opts.agent), config, retry: opts.retry, sessionId: opts.session, manual: true });
            console.log(JSON.stringify(result, null, 2));
            if ("failed" in result && (result.failed || result.errors.length || result.baselineError))
                process.exitCode = 1;
        });
        root.command("baseline-refresh").description("Update local weekly baselines and missing comparisons; no inference")
            .option("--agent <id>", "Agent id", "main")
            .option("--recompare", "Append revised comparisons using newly available historical grades; preserve earlier results")
            .action(async (opts) => {
            console.log(JSON.stringify(await refreshInsideOutBaselinesAsync(paths(cfg, opts.agent).storePath, { minInteractions: config.insideOut.baselineMinInteractions, recompare: opts.recompare }), null, 2));
        });
        withDriftOptions(root.command("baselines")
            .description("Read person-linked weekly and cumulative baseline history (--with-drift adds intensity profiles and the drift summary)")
            .option("--agent <id>", "Agent id", "main").option("--person <id>", "Exact PeopleSQL person ID")
            .option("--since <date>", "Inclusive UTC period-end date YYYY-MM-DD").option("--limit <n>", "Maximum weekly snapshots, 1–1000", "100")
            .option("--with-drift", "Print { baselines, intensity, drift } instead of the baseline array; drift flags apply only with it"))
            .action((opts) => {
            const storePath = paths(cfg, opts.agent).storePath;
            const history = { personId: opts.person, since: opts.since ? dateOption(opts.since, 0) : undefined, limit: Number(opts.limit) };
            // The default stays the original array so existing scripts never break.
            console.log(JSON.stringify(opts.withDrift
                ? reportInsideOutBaselineOverview(storePath, { ...history, drift: driftOptions(opts) })
                : reportInsideOutBaselines(storePath, history), null, 2));
        });
        withDriftOptions(root.command("drift")
            .description("Flag long-term sentiment drift against each person's anchored early weeks; read-only, no inference")
            .option("--agent <id>", "Agent id", "main").option("--person <id>", "Exact PeopleSQL person ID")
            .option("--flagged-only", "Print only flagged entries"))
            .action((opts) => {
            const reports = reportInsideOutDrift(paths(cfg, opts.agent).storePath, driftOptions(opts));
            console.log(JSON.stringify(opts.flaggedOnly ? reports.filter(report => report.flagged) : reports, null, 2));
        });
        root.command("purge").description("Delete one person's emotion baselines and assessment history; no inference")
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
                    minInteractions: config.insideOut.baselineMinInteractions,
                    since: opts.since ? dateOption(opts.since, 0) : undefined, min: Number(opts.min), summary: command === "report" }), null, 2));
            });
        }
    }, { descriptors: [{ name: "memory-emotions", description: "Inside Out emotion reviews and reports", hasSubcommands: true }] });
    if (api.registrationMode === "cli-metadata" || !config.insideOut.enabled)
        return;
    let timer, baselineTimer, running;
    let refreshing;
    let lifetime = new AbortController();
    // One lease owner per registration: hot-replaced instances contend through the shared work row.
    const owner = `inside-out:${process.pid}:${randomUUID()}`;
    const clearTimers = () => {
        if (timer) {
            clearInterval(timer);
            timer = undefined;
        }
        if (baselineTimer) {
            clearInterval(baselineTimer);
            baselineTimer = undefined;
        }
    };
    const tick = () => {
        if (running || lifetime.signal.aborted)
            return;
        const { signal } = lifetime;
        running = (async () => {
            for (const agentId of listAgentIds(api.config)) {
                if (signal.aborted)
                    break;
                try {
                    // Scheduled passes respect the persisted due time, so restarts inside the interval do not re-run.
                    const result = await runInsideOut({ ...paths(api.config, agentId), config, signal, owner });
                    if ("failed" in result && (result.failed || result.errors.length))
                        api.logger.warn("Inside Out: some reviews or sources failed; inspect memory-emotions export");
                    if ("baselineError" in result && result.baselineError)
                        api.logger.warn(`Inside Out baselines: ${result.baselineError}`);
                }
                catch (error) {
                    if (!signal.aborted)
                        api.logger.warn(`Inside Out: ${String(error)}`);
                }
            }
        })().finally(() => { running = undefined; });
    };
    const refresh = () => {
        if (refreshing || lifetime.signal.aborted)
            return;
        const { signal } = lifetime;
        refreshing = (async () => {
            for (const agentId of listAgentIds(api.config)) {
                if (signal.aborted)
                    break;
                try {
                    await refreshInsideOutBaselinesAsync(paths(api.config, agentId).storePath, { minInteractions: config.insideOut.baselineMinInteractions }, signal);
                }
                catch (error) {
                    if (!signal.aborted)
                        api.logger.warn(`Inside Out baselines: ${String(error)}`);
                }
            }
        })().finally(() => { refreshing = undefined; });
    };
    api.on("gateway_start", () => {
        clearTimers();
        if (lifetime.signal.aborted)
            lifetime = new AbortController();
        // Local statistics remain available when inference is manual-only or lacks a key.
        baselineTimer = setInterval(refresh, DEFAULTS.insideOut.baselineRefreshMs);
        baselineTimer.unref();
        refresh();
        if (config.decisionModel.enabled && config.insideOut.intervalMinutes) {
            timer = setInterval(tick, config.insideOut.intervalMinutes * 60_000);
            timer.unref();
            tick();
        }
    });
    // Abort active passes and baseline workers, and release leases in the same synchronous step (graceful stop
    // adds no strikes; the bumped attempt fences out any late write). A held lock costs at most 200ms: the
    // release is skipped and the lease expires instead of stalling shutdown.
    api.on("gateway_stop", async () => {
        clearTimers();
        lifetime.abort();
        interruptInsideOut(owner);
        await Promise.all([running, refreshing]);
    });
}
