import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { normalizeAgentIdStrict } from "openclaw/plugin-sdk/routing";
import type { UnblockMemoryConfig } from "./config.js";
import { resolveSources } from "./sources.js";
import { auditResponses, responseCohort } from "./response-audit.js";
import { ResponseAuditStore } from "./response-store.js";
import type { ResponseReviewStatus } from "./response-reviews.js";

function dateOption(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error("Dates must be valid YYYY-MM-DD UTC dates");
  }
  return Date.parse(value);
}

export function registerResponseAudit(api: OpenClawPluginApi, config: UnblockMemoryConfig) {
  const options = (cfg: OpenClawConfig, id: string) => {
    const normalized = normalizeAgentIdStrict(id);
    if (!normalized.ok || !listAgentIds(cfg).includes(normalized.value)) throw new Error("Unknown response-audit agent");
    const agentId = normalized.value;
    const state = join(resolveStateDir(), "agents", agentId, "unblock-memory");
    return { agentId, config, databasePath: join(resolveAgentDir(cfg, agentId), "openclaw-agent.sqlite"),
      storePath: join(state, "response-audit.sqlite"), indexPath: join(state, "index.sqlite"),
      peoplePath: join(state, "people.sqlite"),
      sources: resolveSources(resolveAgentWorkspaceDir(cfg, agentId), config.corpora.filter(c => c.kind === "files")
        .filter(c => config.responseAudit.memoryCorpora.includes(c.name))) };
  };
  api.registerCli(({ program, config: cfg }) => {
    const root = program.command("memory-responses").description("Operator-only response quality audits and evidence-linked trend reports");
    root.command("audit").option("--agent <id>", "Agent id", "main").option("--dry-run", "Preview bounded coverage without inference or audit writes")
      .action(async (opts: { agent: string; dryRun?: boolean }) => {
        const result = await auditResponses({ ...options(cfg, opts.agent), dryRun: opts.dryRun });
        console.log(JSON.stringify(result, null, 2));
        if (result.status === "unavailable") process.exitCode = 1;
      });
    root.command("report").option("--agent <id>", "Agent id", "main").option("--episode <id>", "Include one episode's judgments and source event references")
      .option("--since <date>", "Inclusive UTC date YYYY-MM-DD").option("--until <date>", "Exclusive UTC date YYYY-MM-DD")
      .option("--bucket <period>", "day or week", "week").option("--sender <id>", "Human sender ID; requires --account")
      .option("--account <scope>", "Provider account scope; requires --sender").option("--person <id>", "Linked people-store person ID")
      .option("--task-type <type>", "Task classification").option("--model <id>", "Agent model")
      .action((opts: { agent: string; episode?: string; since?: string; until?: string; bucket: string; sender?: string; account?: string; person?: string; taskType?: string; model?: string }) => {
        if (!config.responseAudit.enabled) { console.log(JSON.stringify({ status: "disabled" })); return; }
        const { storePath } = options(cfg, opts.agent);
        if (!existsSync(storePath)) { console.log(JSON.stringify({ status: "not_run" })); return; }
        const store = new ResponseAuditStore(storePath);
        if (opts.bucket !== "day" && opts.bucket !== "week") { store.close(); throw new Error("Bucket must be day or week"); }
        try { console.log(JSON.stringify(store.report(responseCohort(config.responseAudit), dateOption(opts.since, Date.now() - config.responseAudit.lookbackDays * 86400_000), opts.episode,
          { until: dateOption(opts.until, Number.MAX_SAFE_INTEGER), bucket: opts.bucket, senderId: opts.sender,
            accountScope: opts.account, personId: opts.person, taskType: opts.taskType, agentModel: opts.model }), null, 2)); }
        finally { store.close(); }
      });
    const withStore = (agent: string, fn: (store: ResponseAuditStore, cohort: string) => unknown) => {
      if (!config.responseAudit.enabled) throw new Error("Response audit is disabled");
      const { storePath } = options(cfg, agent);
      if (!existsSync(storePath)) throw new Error("Response audit has not run");
      const store = new ResponseAuditStore(storePath);
      try { console.log(JSON.stringify(fn(store, responseCohort(config.responseAudit)), null, 2)); }
      finally { store.close(); }
    };
    root.command("tasks").description("Operator-only response reviews; never automatically writes memories or preferences")
      .option("--agent <id>", "Agent id", "main").option("--id <id>", "One task with evidence")
      .action((opts: { agent: string; id?: string }) => withStore(opts.agent, (store, cohort) => {
        const tasks = store.reviews.list(cohort, opts.id);
        return { tasks: tasks.slice(0, 1000), capped: tasks.length > 1000 };
      }));
    root.command("review").requiredOption("--id <id>", "Task ID").requiredOption("--status <status>", "pending, resolved, dismissed or deferred")
      .requiredOption("--reviewer <kind>", "human or agent: provenance, not an authorization grant")
      .requiredOption("--note <text>", "Evidence-based decision; no automatic whisperer write")
      .option("--agent <id>", "Agent id", "main")
      .action((opts: { agent: string; id: string; status: ResponseReviewStatus; reviewer: "human" | "agent"; note: string }) => withStore(opts.agent, (store, cohort) => {
        store.reviews.decide(cohort, opts.id, opts.status, opts.reviewer, opts.note);
        return store.reviews.list(cohort, opts.id);
      }));
    root.command("annotate").option("--agent <id>", "Agent id", "main").requiredOption("--date <date>", "UTC date YYYY-MM-DD")
      .requiredOption("--kind <kind>", "model, prompt, deployment or other").requiredOption("--note <text>", "Known change; correlation is not causation")
      .action((opts: { agent: string; date: string; kind: string; note: string }) => withStore(opts.agent, store =>
        ({ id: store.reviews.annotate(dateOption(opts.date, NaN), opts.kind, opts.note) })));
    root.command("retry-failed").description("Reset failed stage retries without discarding successful judgments; next audit performs the work")
      .option("--agent <id>", "Agent id", "main")
      .action((opts: { agent: string }) => withStore(opts.agent, (store, cohort) => store.retryFailed(cohort)));
  }, { descriptors: [{ name: "memory-responses", description: "Audit human-agent exchanges and report quality signals", hasSubcommands: true }] });
  if (api.registrationMode === "cli-metadata" || !config.responseAudit.enabled || !config.typesafe.enabled || !config.responseAudit.intervalMinutes) return;
  let timer: NodeJS.Timeout | undefined, running: Promise<void> | undefined, lifetime = new AbortController();
  const tick = () => {
    if (running || lifetime.signal.aborted) return;
    running = (async () => {
      for (const id of listAgentIds(api.config)) {
        if (lifetime.signal.aborted) break;
        try {
          const params = options(api.config, id);
          const store = new ResponseAuditStore(params.storePath);
          let due: boolean;
          try { due = store.claimScheduled(Date.now(), config.responseAudit.intervalMinutes * 60_000); }
          finally { store.close(); }
          if (!due) continue;
          const result = await auditResponses({ ...params, signal: lifetime.signal });
          if (result.status === "unavailable") api.logger.warn("unblock-memory response audit unavailable; inspect operator report");
        } catch { api.logger.warn("unblock-memory response audit unavailable"); }
      }
    })().catch(() => { api.logger.warn("unblock-memory response audit unavailable"); }).finally(() => { running = undefined; });
  };
  api.on("gateway_start", () => {
    if (timer) clearInterval(timer);
    lifetime = new AbortController();
    // A minute poll honors durable due times without relying on process uptime.
    timer = setInterval(tick, 60_000);
    timer.unref();
    tick(); // New schedules wait one interval; overdue schedules get one bounded attempt.
  });
  api.on("gateway_stop", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    lifetime.abort();
    await running;
  });
}
