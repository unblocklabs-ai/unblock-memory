import { Type } from "typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./config.js";
import { QmdMemoryRuntime } from "./runtime.js";

function getContext(ctx: OpenClawPluginToolContext) {
  const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
  if (!cfg || !ctx.agentId) return undefined;
  return { cfg, agentId: ctx.agentId };
}

function toolParams(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function createSearchTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_search",
    label: "Memory Search",
    description: "Search canonical Markdown memory with semantic vector retrieval.",
    parameters: Type.Object({
      query: Type.String(),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    }),
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const raw = toolParams(params);
      const query = readStringParam(raw, "query");
      if (!query) throw new Error("query is required");
      const maxResults = typeof raw.maxResults === "number" ? raw.maxResults : undefined;
      const minScore = typeof raw.minScore === "number" ? raw.minScore : undefined;
      const { manager, error } = await runtime.getMemorySearchManager(active);
      if (!manager) return jsonResult({ results: [], error: error ?? "memory unavailable" });
      const results = await manager.search(query, { maxResults, minScore, signal });
      return jsonResult({ results, provider: "unblock-qmd" });
    },
  };
}

function createGetTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_get",
    label: "Memory Get",
    description: "Read an exact qmd:// path returned by memory_search.",
    parameters: Type.Object({
      path: Type.String(),
      from: Type.Optional(Type.Integer({ minimum: 1 })),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const raw = toolParams(params);
      const path = readStringParam(raw, "path");
      if (!path) throw new Error("path is required");
      const { manager, error } = await runtime.getMemorySearchManager(active);
      if (!manager) return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
      return jsonResult(await manager.readFile({
        relPath: path,
        from: typeof raw.from === "number" ? raw.from : undefined,
        lines: typeof raw.lines === "number" ? raw.lines : undefined,
      }));
    },
  };
}

function formatDateInTimezone(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function parseByteSize(value: unknown): number | undefined {
  if (typeof value === "number") {
    const bytes = Math.floor(value);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  }
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)(b|k|kb|m|mb|g|gb|t|tb)?$/i.exec(value.trim());
  if (!match) return undefined;
  const unit = (match[2] ?? "b").toLowerCase();
  const powers: Record<string, number> = {
    b: 0,
    k: 1,
    kb: 1,
    m: 2,
    mb: 2,
    g: 3,
    gb: 3,
    t: 4,
    tb: 4,
  };
  const bytes = Math.round(Number(match[1]) * 1024 ** powers[unit]!);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

function resolveTimezone(cfg: OpenClawConfig | undefined): string {
  const configured = cfg?.agents?.defaults?.userTimezone?.trim();
  if (configured) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: configured }).format();
      return configured;
    } catch {
      // Host validation normally prevents this; fall through defensively.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function resolveFlushPlan(params: { cfg?: OpenClawConfig; nowMs?: number } = {}) {
  const configured = params.cfg?.agents?.defaults?.compaction?.memoryFlush;
  if (configured?.enabled === false) return null;

  const nowMs = params.nowMs ?? Date.now();
  const date = formatDateInTimezone(nowMs, resolveTimezone(params.cfg));
  const target = `memory/${date}.md`;
  return {
    softThresholdTokens: nonNegativeInteger(configured?.softThresholdTokens, 4000),
    forceFlushTranscriptBytes:
      parseByteSize(configured?.forceFlushTranscriptBytes) ?? 2 * 1024 * 1024,
    reserveTokensFloor: 20_000,
    model: configured?.model?.trim() || undefined,
    prompt: `Pre-compaction memory flush. Store durable memories only in ${target}. If it exists, append; never overwrite it or bootstrap files. Do not create timestamped variants. If nothing is durable, reply NO_REPLY.`,
    systemPrompt: `Capture durable memories in ${target}; append only and do not overwrite bootstrap files. Usually NO_REPLY is correct.`,
    relativePath: target,
  };
}

export function registerUnblockQmd(api: OpenClawPluginApi): void {
  const config = resolveConfig(api.pluginConfig);
  const runtime = new QmdMemoryRuntime(config.paths);
  const capability = {
    deterministicRecallToolName: "memory_search",
    supportsPrivateTranscriptRecall: false,
    promptBuilder: ({ availableTools }: { availableTools: Set<string> }) =>
      availableTools.has("memory_search")
        ? ["Use memory_search for relevant past facts, then memory_get when more surrounding context is needed."]
        : [],
    flushPlanResolver: resolveFlushPlan,
    runtime,
  };
  api.registerMemoryCapability(capability);
  api.registerTool((ctx) => createSearchTool(runtime, ctx), { names: ["memory_search"] });
  api.registerTool((ctx) => createGetTool(runtime, ctx), { names: ["memory_get"] });
}
