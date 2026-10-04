import { join, dirname } from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentDir, resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import type { UnblockMemoryConfig } from "./config.js";
import { MEMORY_DATABASE } from "./memory-database.js";
import { dateOption } from "./date-option.js";
import { linkInsideOutPeople, repairInsideOutIdentities, reportInsideOut, runInsideOut } from "./inside-out.js";

export function registerInsideOut(api: OpenClawPluginApi, config: UnblockMemoryConfig) {
  const paths = (cfg: OpenClawConfig, agentId: string) => {
    if (!listAgentIds(cfg).includes(agentId)) throw new Error("Unknown Inside Out agent");
    const agentDir = resolveAgentDir(cfg, agentId);
    return { agentId, databasePath: join(agentDir, "openclaw-agent.sqlite"), sessionsDir: join(dirname(agentDir), "sessions"),
      storePath: join(resolveStateDir(), "agents", agentId, "unblock-memory", MEMORY_DATABASE) };
  };
  api.registerCli(({ program, config: cfg }) => {
    const root = program.command("memory-emotions").description("Inside Out: review human replies and analyze emotion probabilities");
    root.command("link-people").description("Backfill or refresh People identity links without Jev")
      .option("--agent <id>", "Agent id", "main")
      .option("--repair-identities", "Recover legacy sender/channel metadata for unlinked reviews")
      .action(async (opts: { agent: string; repairIdentities?: boolean }) => {
        const p = paths(cfg, opts.agent);
        const repair = opts.repairIdentities ? await repairInsideOutIdentities(p) : undefined;
        console.log(JSON.stringify({ ...repair, ...linkInsideOutPeople(p.storePath) }, null, 2));
        if (repair?.errors.length) process.exitCode = 1;
      });
    root.command("run").option("--agent <id>", "Agent id", "main").option("--retry", "Retry failed judgments immediately")
      .option("--session <id>", "Review only this session")
      .action(async (opts: { agent: string; retry?: boolean; session?: string }) => {
        const result = await runInsideOut({ ...paths(cfg, opts.agent), config, retry: opts.retry, sessionId: opts.session });
        console.log(JSON.stringify(result, null, 2));
        if ("failed" in result && (result.failed || result.errors.length)) process.exitCode = 1;
      });
    for (const command of ["report", "export"] as const) {
      root.command(command).option("--agent <id>", "Agent id", "main")
        .option("--session <id>", "Filter one session")
        .option("--sender <id>", "Human sender ID").option("--since <date>", "Inclusive UTC date YYYY-MM-DD")
        .option("--emotion <name>", "Filter an emotion probability").option("--min <probability>", "Minimum probability", "0")
        .option("--bucket <period>", "day or week (report)", "day")
        .action((opts: { agent: string; session?: string; sender?: string; since?: string; emotion?: string; min: string; bucket: string }) => {
          console.log(JSON.stringify(reportInsideOut(paths(cfg, opts.agent).storePath, { ...opts,
            sessionId: opts.session, since: opts.since ? dateOption(opts.since, 0) : undefined, min: Number(opts.min), summary: command === "report" }), null, 2));
        });
    }
  }, { descriptors: [{ name: "memory-emotions", description: "Inside Out emotion reviews and reports", hasSubcommands: true }] });
  if (api.registrationMode === "cli-metadata" || !config.insideOut.enabled || !config.typesafe.enabled || !config.insideOut.intervalMinutes) return;
  let timer: NodeJS.Timeout | undefined, running: Promise<void> | undefined;
  let lifetime = new AbortController();
  const tick = () => {
    if (running) return;
    running = (async () => {
      for (const agentId of listAgentIds(api.config)) {
        if (lifetime.signal.aborted) break;
        try {
          const result = await runInsideOut({ ...paths(api.config, agentId), config, signal: lifetime.signal });
          if ("failed" in result && (result.failed || result.errors.length)) api.logger.warn("Inside Out: some reviews or sources failed; inspect memory-emotions export");
        } catch (error) { if (!lifetime.signal.aborted) api.logger.warn(`Inside Out: ${String(error)}`); }
      }
    })().finally(() => { running = undefined; });
  };
  api.on("gateway_start", () => {
    lifetime = new AbortController();
    timer = setInterval(tick, config.insideOut.intervalMinutes * 60_000); timer.unref(); tick();
  });
  api.on("gateway_stop", async () => { if (timer) clearInterval(timer); lifetime.abort(); await running; });
}
