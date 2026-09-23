import { existsSync, openSync, writeSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveAgentDir, resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { normalizeAgentIdStrict } from "openclaw/plugin-sdk/routing";
import { TrainingStore } from "./training-store.js";
import { TRAINING_GATE_THRESHOLD } from "./training-gate.js";
import { collectTraining, runTraining } from "./training.js";
import { generateTrainingQueries, evaluateTrainingQueries, exportQueryTraining, TRAINING_EVALUATION_CONCURRENCY } from "./training-queries.js";
function dateOption(value, fallback) {
    if (value === undefined)
        return fallback;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
        throw new Error("Dates must be valid YYYY-MM-DD UTC dates");
    }
    return Date.parse(value);
}
function thresholdOption(value) {
    const result = Number(value);
    if (!value.trim() || !Number.isFinite(result) || result < 0 || result > 1)
        throw new Error("Threshold must be between 0 and 1");
    return result;
}
/** CLI only: no scheduler, tools, hooks, or live memory-index changes. */
export function registerMemoryTraining(api, config) {
    const paths = (cfg, id) => {
        const normalized = normalizeAgentIdStrict(id);
        if (!normalized.ok || !listAgentIds(cfg).includes(normalized.value))
            throw new Error("Unknown memory-training agent");
        const agentId = normalized.value;
        const stateDir = join(resolveStateDir(), "agents", agentId, "unblock-memory");
        return { agentId, databasePath: join(resolveAgentDir(cfg, agentId), "openclaw-agent.sqlite"),
            stateDir, storePath: join(stateDir, "training.sqlite") };
    };
    api.registerCli(({ program, config: cfg }) => {
        const root = program.command("memory-training").description("Operator-only resumable LFM query-training pipeline");
        const withStore = async (agent, options, fn) => {
            const source = paths(cfg, agent);
            if (!options.create && !existsSync(source.storePath))
                throw new Error("No training database; run memory-training collect first");
            const store = new TrainingStore(source.storePath, source.agentId);
            try {
                return await (options.readOnly ? fn(store, source) : store.locked(() => fn(store, source)));
            }
            finally {
                store.close();
            }
        };
        root.command("collect").option("--agent <id>", "Agent id", "main")
            .option("--since <date>", "Inclusive user-message date YYYY-MM-DD UTC")
            .option("--until <date>", "Exclusive user-message date YYYY-MM-DD UTC")
            .option("--dry-run", "Coverage only; no database writes or API calls")
            .action(async (opts) => {
            const since = dateOption(opts.since, 0), until = dateOption(opts.until, Number.MAX_SAFE_INTEGER);
            if (until <= since)
                throw new Error("until must be later than since");
            const result = opts.dryRun ? collectTraining(paths(cfg, opts.agent), undefined, { since, until }) :
                await withStore(opts.agent, { create: true }, (store, source) => collectTraining(source, store, { since, until }));
            console.log(JSON.stringify(result, null, 2));
        });
        root.command("run").description("Judge whether historical recall would help each collected input").option("--agent <id>", "Agent id", "main")
            .option("--max-examples <n>", "Optional maximum new API calls; no example-count limit by default")
            .option("--max-input-bytes <n>", "Maximum total serialized state + question bytes, not tokens", "3000000")
            .option("--concurrency <n>", "Concurrent TypeSafe recall requests", "256")
            .option("--dry-run", "Refresh local checkpoints and preview pending work without API calls")
            .action(async (opts) => {
            const result = await withStore(opts.agent, {}, (store, source) => runTraining(source, store, config, {
                maxExamples: opts.maxExamples === undefined ? undefined : Number(opts.maxExamples),
                maxInputBytes: Number(opts.maxInputBytes), concurrency: Number(opts.concurrency), dryRun: opts.dryRun,
            }));
            console.log(JSON.stringify(result, null, 2));
            if (result.failed || result.ambiguous)
                process.exitCode = 1;
        });
        for (const command of ["generate", "evaluate"]) {
            const stage = root.command(command).description(command === "generate" ? "Generate ten exact queries with isolated gpt-6-luna" : "Rank queries using existing historical QMD results")
                .option("--agent <id>", "Agent id", "main")
                .option("--threshold <p>", "Minimum completed recall probability", String(TRAINING_GATE_THRESHOLD))
                .option("--max-examples <n>", "Optional maximum uncached examples")
                .option("--dry-run", "Refresh local sources and preview work without provider calls");
            if (command === "generate")
                stage.option("--max-input-bytes <n>", "Teacher input byte budget", "3000000")
                    .option("--concurrency <n>", "Concurrent isolated teacher completions", "8");
            else
                stage.option("--max-calls <n>", "Maximum new retrieval operations plus uncached passage judgments")
                    .option("--exclude-judgment <hash...>", "Explicitly exclude exact judgment hashes; persist exclusions, never score as zero")
                    .option("--concurrency <n>", "Concurrent historical inputs; remote passage judgments run concurrently", String(TRAINING_EVALUATION_CONCURRENCY));
            stage.action(async (opts) => {
                const options = { maxExamples: opts.maxExamples === undefined ? undefined : Number(opts.maxExamples),
                    dryRun: opts.dryRun, threshold: thresholdOption(opts.threshold) };
                const result = await withStore(opts.agent, {}, async (store, source) => command === "generate"
                    ? await generateTrainingQueries(source, store, api.runtime, { ...options, maxInputBytes: Number(opts.maxInputBytes), concurrency: Number(opts.concurrency) })
                    : await evaluateTrainingQueries(source, store, config, { ...options, maxCalls: opts.maxCalls === undefined ? undefined : Number(opts.maxCalls),
                        concurrency: Number(opts.concurrency), excludeJudgments: opts.excludeJudgment }));
                console.log(JSON.stringify(result, null, 2));
                if (result.failed || result.ambiguous || result.blocked)
                    process.exitCode = 1;
            });
        }
        root.command("status").option("--agent <id>", "Agent id", "main")
            .option("--threshold <p>", "Minimum completed recall probability for query eligibility", String(TRAINING_GATE_THRESHOLD))
            .action(async (opts) => {
            const threshold = thresholdOption(opts.threshold);
            console.log(JSON.stringify(await withStore(opts.agent, { readOnly: true }, store => store.status(threshold)), null, 2));
        });
        root.command("retry-failed").option("--agent <id>", "Agent id", "main")
            .option("--include-ambiguous", "Explicitly permit retrying requests that may already have been billed")
            .action(async (opts) => {
            const reset = await withStore(opts.agent, {}, store => store.retry(opts.includeAmbiguous === true));
            console.log(JSON.stringify({ reset, calls: 0 }));
        });
        root.command("export").option("--agent <id>", "Agent id", "main")
            .option("--threshold <p>", "Minimum completed recall probability", String(TRAINING_GATE_THRESHOLD))
            .option("--stage <stage>", "query-training or recall-gate", "query-training")
            .requiredOption("--output <path>", "New private JSONL file; refuses overwrite")
            .action(async (opts) => {
            if (!["recall-gate", "query-training"].includes(opts.stage))
                throw new Error("Unknown training export stage");
            const output = resolve(opts.output);
            const threshold = thresholdOption(opts.threshold);
            const result = await withStore(opts.agent, {}, (store, source) => {
                collectTraining(source, store, { existingOnly: true });
                const fd = openSync(output, "wx", 0o600);
                let rows = 0;
                const data = opts.stage === "query-training" ? exportQueryTraining(store, threshold) : store.exportRows(threshold);
                try {
                    for (const row of data) {
                        writeSync(fd, JSON.stringify(row) + "\n");
                        rows++;
                    }
                }
                finally {
                    closeSync(fd);
                }
                return { output, rows, stage: opts.stage };
            });
            console.log(JSON.stringify(result, null, 2));
        });
    }, { descriptors: [{ name: "memory-training", description: "Collect, generate and rank resumable LFM query examples", hasSubcommands: true }] });
}
