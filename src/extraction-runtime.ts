import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { callGatewayFromCli, errorShape, ErrorCodes } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { listAgentIds, resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentDir, resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { UnblockMemoryConfig } from "./config.js";
import type { QmdMemoryRuntime } from "./runtime.js";
import { MEMORY_DATABASE, hasMemoryTable } from "./memory-database.js";
import { ExtractionStore } from "./extraction-store.js";
import { extractionSessions } from "./extraction-source.js";

export function registerExtraction(api: OpenClawPluginApi, config: UnblockMemoryConfig, runtime?: QmdMemoryRuntime) {
  let lifetime = new AbortController();
  let timer: NodeJS.Timeout | undefined, running: Promise<void> | undefined;
  const options = (cfg: OpenClawConfig, agentId: string) => {
    if (!listAgentIds(cfg).includes(agentId)) throw new Error("Unknown extraction agent");
    return { agentId, agentName: resolveAgentIdentity(cfg, agentId)?.name?.trim() || agentId,
      config, runtime: api.runtime, storePath: join(resolveStateDir(), "agents", agentId, "unblock-memory", MEMORY_DATABASE),
      sessions: () => extractionSessions(join(resolveAgentDir(cfg, agentId), "openclaw-agent.sqlite"), agentId, config.extraction.chatTypes) };
  };
  const run = async (cfg: OpenClawConfig, agentId: string, signal: AbortSignal, since?: number, sessionId?: string, scheduled = false) => {
    const opts = options(cfg, agentId);
    // Keep the extraction tokenizer/model modules out of normal plugin startup.
    const { runExtraction } = await import("./extraction-worker.js");
    const result = await runExtraction({ ...opts, signal, since, scheduled, sessionId });
    if (result.status === "completed" && config.extraction.publish && runtime) {
      const { manager, error } = await runtime.getMemorySearchManager({ cfg, agentId });
      if (!manager) throw new Error(error ?? "Extraction index unavailable");
      await manager.syncExtracted();
    }
    return result;
  };
  api.registerCli(({ program, config: cfg }) => {
    const root = program.command("memory-extract").description("Optional session fact extraction; no daily Markdown writes");
    root.command("run").option("--agent <id>", "Agent id", "main")
      .option("--since <date>", "Explicit bounded backfill from YYYY-MM-DD UTC; repeat to resume")
      .option("--session <id>", "Restrict this run to one session")
      .action(async (opts: { agent: string; since?: string; session?: string }) => {
        let since: number | undefined;
        if (opts.since !== undefined) {
          since = Date.parse(opts.since);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.since) || !Number.isFinite(since) || new Date(since).toISOString().slice(0,10) !== opts.since) {
            throw new Error("since must be a valid YYYY-MM-DD UTC date");
          }
        }
        try {
          // Native harnesses live in the Gateway, not the cold CLI metadata loader.
          const result = await callGatewayFromCli("unblock-memory.extract", { timeout: "600000" },
            { agentId: opts.agent, ...(since === undefined ? {} : { since }), ...(opts.session ? { sessionId: opts.session } : {}) });
          console.log(JSON.stringify(result, null, 2));
          if (result.status === "unavailable" || (result.status === "completed" && result.failed)) process.exitCode = 1;
        } catch { console.log(JSON.stringify({ status: "unavailable", reason: "Extraction failed; check the running Gateway, host prerequisites and operator report" })); process.exitCode = 1; }
      });
    root.command("report").option("--agent <id>", "Agent id", "main").action((opts: { agent: string }) => {
      const { storePath } = options(cfg, opts.agent);
      if (!hasMemoryTable(storePath, "extracted_memories")) { console.log(JSON.stringify({ status: "not_run" })); return; }
      const store = new ExtractionStore(storePath);
      try { console.log(JSON.stringify(store.report(), null, 2)); } finally { store.close(); }
    });
  }, { descriptors: [{ name: "memory-extract", description: "Extract and inspect source-linked session facts", hasSubcommands: true }] });
  if (api.registrationMode === "cli-metadata") return;
  const runParams = Type.Object({ agentId: Type.String(), since: Type.Optional(Type.Integer({ minimum: 0 })),
    sessionId: Type.Optional(Type.String()) }, { additionalProperties: false });
  api.registerGatewayMethod("unblock-memory.extract", async ({ params, respond }) => {
    if (!Value.Check(runParams, params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid extraction parameters")); return;
    }
    try { respond(true, await run(api.config, params.agentId, lifetime.signal, params.since, params.sessionId)); }
    catch { respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Extraction failed; check host prerequisites and operator report")); }
  }, { scope: "operator.admin" });
  if (!config.extraction.enabled) return;
  api.on("gateway_stop", async () => { lifetime.abort(); if (timer) clearInterval(timer); timer = undefined; await running; });
  if (!config.extraction.intervalMinutes || !config.typesafe.enabled) return;
  const tick = () => {
    if (running || lifetime.signal.aborted) return;
    running = (async () => {
      for (const agentId of listAgentIds(api.config)) {
        if (lifetime.signal.aborted) break;
        try {
          const result = await run(api.config, agentId, lifetime.signal, undefined, undefined, true);
          if (result.status === "unavailable" || (result.status === "completed" && result.failed)) api.logger.warn("unblock-memory extraction unavailable; inspect memory-extract report");
        } catch { api.logger.warn("unblock-memory extraction unavailable"); }
      }
    })().finally(() => { running = undefined; });
  };
  api.on("gateway_start", () => {
    if (timer) clearInterval(timer);
    lifetime = new AbortController(); timer = setInterval(tick, 60_000); timer.unref(); tick();
  });
}
