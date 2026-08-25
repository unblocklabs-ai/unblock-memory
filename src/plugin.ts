import { Type } from "typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./config.js";
import type { MemoryReclusterOptions } from "./analysis.js";
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
      return jsonResult({ results, provider: "unblock-memory" });
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

const reclusterParameters = Type.Object({
  space: Type.Optional(Type.Object({
    method: Type.Optional(Type.Union([Type.Literal("umap"), Type.Literal("none")])),
    nComponents: Type.Optional(Type.Integer({ minimum: 2, maximum: 100 })),
    nNeighbors: Type.Optional(Type.Integer({ minimum: 2, maximum: 200 })),
    minDist: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  }, { additionalProperties: false })),
  hdbscan: Type.Optional(Type.Object({
    minClusterSize: Type.Optional(Type.Integer({ minimum: 2, maximum: 100_000 })),
    minSamples: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    clusterSelectionMethod: Type.Optional(Type.Union([Type.Literal("eom"), Type.Literal("leaf")])),
    clusterSelectionEpsilon: Type.Optional(Type.Number({ minimum: 0 })),
    allowSingleCluster: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false })),
  seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_294_967_295 })),
}, { additionalProperties: false });

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalNumber(
  value: Record<string, unknown>,
  key: string,
  constraints: { minimum: number; maximum?: number; integer?: boolean },
): number | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  const valid = typeof candidate === "number" && Number.isFinite(candidate) &&
    candidate >= constraints.minimum &&
    (constraints.maximum === undefined || candidate <= constraints.maximum) &&
    (!constraints.integer || Number.isInteger(candidate));
  if (!valid) throw new Error(`${key} is invalid`);
  return candidate;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${unexpected} is not allowed`);
}

function parseReclusterOptions(params: unknown): MemoryReclusterOptions {
  const raw = toolParams(params);
  requireOnlyKeys(raw, ["space", "hdbscan", "seed"]);
  const options: MemoryReclusterOptions = {};
  if (raw.space !== undefined) {
    const space = requireObject(raw.space, "space");
    requireOnlyKeys(space, ["method", "nComponents", "nNeighbors", "minDist"]);
    const method = space.method;
    if (method !== undefined && method !== "umap" && method !== "none") {
      throw new Error("space.method is invalid");
    }
    options.space = {
      ...(method === undefined ? {} : { method }),
      ...optionalEntry("nComponents", optionalNumber(space, "nComponents", { minimum: 2, maximum: 100, integer: true })),
      ...optionalEntry("nNeighbors", optionalNumber(space, "nNeighbors", { minimum: 2, maximum: 200, integer: true })),
      ...optionalEntry("minDist", optionalNumber(space, "minDist", { minimum: 0, maximum: 1 })),
    };
  }
  if (raw.hdbscan !== undefined) {
    const hdbscan = requireObject(raw.hdbscan, "hdbscan");
    requireOnlyKeys(hdbscan, [
      "minClusterSize",
      "minSamples",
      "clusterSelectionMethod",
      "clusterSelectionEpsilon",
      "allowSingleCluster",
    ]);
    const method = hdbscan.clusterSelectionMethod;
    if (method !== undefined && method !== "eom" && method !== "leaf") {
      throw new Error("hdbscan.clusterSelectionMethod is invalid");
    }
    const allowSingleCluster = hdbscan.allowSingleCluster;
    if (allowSingleCluster !== undefined && typeof allowSingleCluster !== "boolean") {
      throw new Error("hdbscan.allowSingleCluster is invalid");
    }
    options.hdbscan = {
      ...optionalEntry("minClusterSize", optionalNumber(hdbscan, "minClusterSize", { minimum: 2, maximum: 100_000, integer: true })),
      ...optionalEntry("minSamples", optionalNumber(hdbscan, "minSamples", { minimum: 1, maximum: 100_000, integer: true })),
      ...(method === undefined ? {} : { clusterSelectionMethod: method }),
      ...optionalEntry("clusterSelectionEpsilon", optionalNumber(hdbscan, "clusterSelectionEpsilon", { minimum: 0 })),
      ...(allowSingleCluster === undefined ? {} : { allowSingleCluster }),
    };
  }
  const seed = optionalNumber(raw, "seed", { minimum: 0, maximum: 4_294_967_295, integer: true });
  if (seed !== undefined) options.seed = seed;
  return options;
}

function optionalEntry<Key extends string>(key: Key, value: number | undefined): Partial<Record<Key, number>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, number>;
}

function createReclusterTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_recluster",
    label: "Recluster Memory",
    description: "Rebuild memory clusters from existing QMD vectors. Call only when memory_list_clusters reports missing or stale analysis.",
    parameters: reclusterParameters,
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const options = parseReclusterOptions(params);
      const { manager, error } = await runtime.getMemorySearchManager(active);
      if (!manager) return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
      try {
        return jsonResult(await manager.recluster(options, signal));
      } catch (analysisError) {
        return jsonResult({
          status: "unavailable",
          error: analysisError instanceof Error ? analysisError.message : String(analysisError),
        });
      }
    },
  };
}

function createListClustersTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_list_clusters",
    label: "List Memory Clusters",
    description: "List current memory clusters and freshness. Call this before memory_recluster or memory_fetch_cluster.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId: string, params: unknown) {
      const raw = toolParams(params);
      requireOnlyKeys(raw, ["limit"]);
      const limit = optionalNumber(raw, "limit", { minimum: 1, maximum: 50, integer: true });
      const { manager, error } = await runtime.getMemorySearchManager(active);
      if (!manager) return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
      return jsonResult(await manager.listClusters(limit));
    },
  };
}

function createFetchClusterTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_fetch_cluster",
    label: "Fetch Memory Cluster",
    description: "Fetch the top representative QMD chunks for a clusterId returned by memory_list_clusters.",
    parameters: Type.Object({
      clusterId: Type.String({ pattern: "^[0-9a-f]{10}$" }),
      topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId: string, params: unknown) {
      const raw = toolParams(params);
      requireOnlyKeys(raw, ["clusterId", "topK"]);
      const clusterId = readStringParam(raw, "clusterId");
      if (!clusterId || !/^[0-9a-f]{10}$/.test(clusterId)) throw new Error("clusterId is invalid");
      const topK = optionalNumber(raw, "topK", { minimum: 1, maximum: 50, integer: true });
      const { manager, error } = await runtime.getMemorySearchManager(active);
      if (!manager) return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
      return jsonResult(await manager.fetchCluster({ clusterId, topK }));
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

export function registerUnblockMemory(api: OpenClawPluginApi): void {
  const config = resolveConfig(api.pluginConfig);
  const runtime = new QmdMemoryRuntime(config.paths, config.analysis.executable);
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
  api.registerTool((ctx) => createReclusterTool(runtime, ctx), { names: ["memory_recluster"] });
  api.registerTool((ctx) => createListClustersTool(runtime, ctx), { names: ["memory_list_clusters"] });
  api.registerTool((ctx) => createFetchClusterTool(runtime, ctx), { names: ["memory_fetch_cluster"] });
}
