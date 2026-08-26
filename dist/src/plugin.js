import { Type } from "typebox";
import { Value } from "typebox/value";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { resolveConfig } from "./config.js";
import { QmdMemoryRuntime } from "./runtime.js";
function getContext(ctx) {
    const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
    if (!cfg || !ctx.agentId)
        return undefined;
    return { cfg, agentId: ctx.agentId };
}
const searchParameters = Type.Object({
    query: Type.String({ pattern: "\\S" }),
    corpora: Type.Optional(Type.Array(Type.String({ pattern: "\\S" }), { minItems: 1 })),
    sessionFilter: Type.Optional(Type.Object({
        startedFrom: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$" })),
        startedTo: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$" })),
        provider: Type.Optional(Type.String({ pattern: "\\S" })),
        chatType: Type.Optional(Type.Union([
            Type.Literal("channel"),
            Type.Literal("group"),
            Type.Literal("direct"),
        ])),
        accountId: Type.Optional(Type.String({ pattern: "\\S" })),
        conversationId: Type.Optional(Type.String({ pattern: "\\S" })),
    }, { additionalProperties: false })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
}, { additionalProperties: false });
const getParameters = Type.Object({
    path: Type.String({ pattern: "\\S" }),
    from: Type.Optional(Type.Integer({ minimum: 1 })),
    lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
}, { additionalProperties: false });
const syncSessionsParameters = Type.Object({
    force: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const syncStatusParameters = Type.Object({}, { additionalProperties: false });
function createSearchTool(runtime, ctx) {
    const active = getContext(ctx);
    if (!active)
        return null;
    return {
        name: "memory_search",
        label: "Memory Search",
        description: "Search configured Markdown corpora with semantic vector retrieval. Omit corpora to search all of them.",
        parameters: searchParameters,
        async execute(_toolCallId, params, signal) {
            const { query: untrimmedQuery, corpora, sessionFilter, maxResults, minScore } = Value.Parse(searchParameters, params);
            const query = untrimmedQuery.trim();
            const { manager, error } = await runtime.getMemorySearchManager(active);
            if (!manager)
                return jsonResult({ results: [], error: error ?? "memory unavailable" });
            const results = await manager.search(query, {
                corpora: corpora?.map((corpus) => corpus.trim()),
                sessionFilter,
                maxResults,
                minScore,
                signal,
            });
            return jsonResult({ results, provider: "unblock-memory" });
        },
    };
}
function createGetTool(runtime, ctx) {
    const active = getContext(ctx);
    if (!active)
        return null;
    return {
        name: "memory_get",
        label: "Memory Get",
        description: "Read an exact qmd:// path returned by memory_search.",
        parameters: getParameters,
        async execute(_toolCallId, params) {
            const { path: untrimmedPath, from, lines } = Value.Parse(getParameters, params);
            const path = untrimmedPath.trim();
            const { manager, error } = await runtime.getMemorySearchManager(active);
            if (!manager)
                return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
            return jsonResult(await manager.readFile({
                relPath: path,
                from,
                lines,
            }));
        },
    };
}
function createSyncSessionsTool(runtime, ctx) {
    const active = getContext(ctx);
    if (!active)
        return null;
    return {
        name: "memory_sync_sessions",
        label: "Sync Memory Sessions",
        description: "Start projecting and indexing this agent's configured OpenClaw session transcripts. Use memory_sync_status to check completion.",
        parameters: syncSessionsParameters,
        async execute(_toolCallId, params) {
            const { force } = Value.Parse(syncSessionsParameters, params);
            return jsonResult(runtime.startSessionSync(active, force));
        },
    };
}
function createSyncStatusTool(runtime, ctx) {
    const active = getContext(ctx);
    if (!active)
        return null;
    return {
        name: "memory_sync_status",
        label: "Memory Session Sync Status",
        description: "Check the current or latest session transcript sync.",
        parameters: syncStatusParameters,
        async execute(_toolCallId, params) {
            Value.Parse(syncStatusParameters, params);
            return jsonResult(runtime.sessionSyncStatus(active.agentId));
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
function createReclusterTool(runtime, ctx) {
    const active = getContext(ctx);
    if (!active)
        return null;
    return {
        name: "memory_recluster",
        label: "Recluster Memory",
        description: "Rebuild memory clusters from existing QMD vectors. Call only when memory_list_clusters reports missing or stale analysis.",
        parameters: reclusterParameters,
        async execute(_toolCallId, params, signal) {
            const options = Value.Parse(reclusterParameters, params);
            const { manager, error } = await runtime.getMemorySearchManager(active);
            if (!manager)
                return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
            try {
                return jsonResult(await manager.recluster(options, signal));
            }
            catch (analysisError) {
                return jsonResult({
                    status: "unavailable",
                    error: analysisError instanceof Error ? analysisError.message : String(analysisError),
                });
            }
        },
    };
}
const listClustersParameters = Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, { additionalProperties: false });
function createListClustersTool(runtime, ctx) {
    const active = getContext(ctx);
    if (!active)
        return null;
    return {
        name: "memory_list_clusters",
        label: "List Memory Clusters",
        description: "List current memory clusters and freshness. Call this before memory_recluster or memory_fetch_cluster.",
        parameters: listClustersParameters,
        async execute(_toolCallId, params) {
            const { limit } = Value.Parse(listClustersParameters, params);
            const { manager, error } = await runtime.getMemorySearchManager(active);
            if (!manager)
                return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
            return jsonResult(await manager.listClusters(limit));
        },
    };
}
const fetchClusterParameters = Type.Object({
    clusterId: Type.String({ pattern: "^[0-9a-f]{10}$" }),
    topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, { additionalProperties: false });
function createFetchClusterTool(runtime, ctx) {
    const active = getContext(ctx);
    if (!active)
        return null;
    return {
        name: "memory_fetch_cluster",
        label: "Fetch Memory Cluster",
        description: "Fetch the top representative QMD chunks for a clusterId returned by memory_list_clusters.",
        parameters: fetchClusterParameters,
        async execute(_toolCallId, params) {
            const { clusterId, topK } = Value.Parse(fetchClusterParameters, params);
            const { manager, error } = await runtime.getMemorySearchManager(active);
            if (!manager)
                return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
            return jsonResult(await manager.fetchCluster({ clusterId, topK }));
        },
    };
}
function formatDateInTimezone(timestamp, timezone) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date(timestamp));
    const part = (type) => parts.find((entry) => entry.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
}
function nonNegativeInteger(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : fallback;
}
function parseByteSize(value) {
    if (typeof value === "number") {
        const bytes = Math.floor(value);
        return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
    }
    if (typeof value !== "string")
        return undefined;
    const match = /^(\d+(?:\.\d+)?)(b|k|kb|m|mb|g|gb|t|tb)?$/i.exec(value.trim());
    if (!match)
        return undefined;
    const unit = (match[2] ?? "b").toLowerCase();
    const powers = {
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
    const bytes = Math.round(Number(match[1]) * 1024 ** powers[unit]);
    return Number.isSafeInteger(bytes) ? bytes : undefined;
}
function resolveTimezone(cfg) {
    const configured = cfg?.agents?.defaults?.userTimezone?.trim();
    if (configured) {
        try {
            new Intl.DateTimeFormat("en-US", { timeZone: configured }).format();
            return configured;
        }
        catch {
            // Host validation normally prevents this; fall through defensively.
        }
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
export function resolveFlushPlan(params = {}) {
    const configured = params.cfg?.agents?.defaults?.compaction?.memoryFlush;
    if (configured?.enabled === false)
        return null;
    const nowMs = params.nowMs ?? Date.now();
    const date = formatDateInTimezone(nowMs, resolveTimezone(params.cfg));
    const target = `memory/${date}.md`;
    return {
        softThresholdTokens: nonNegativeInteger(configured?.softThresholdTokens, 4000),
        forceFlushTranscriptBytes: parseByteSize(configured?.forceFlushTranscriptBytes) ?? 2 * 1024 * 1024,
        reserveTokensFloor: 20_000,
        model: configured?.model?.trim() || undefined,
        prompt: `Pre-compaction memory flush. Store durable memories only in ${target}. If it exists, append; never overwrite it or bootstrap files. Do not create timestamped variants. If nothing is durable, reply NO_REPLY.`,
        systemPrompt: `Capture durable memories in ${target}; append only and do not overwrite bootstrap files. Usually NO_REPLY is correct.`,
        relativePath: target,
    };
}
export function registerUnblockMemory(api) {
    const config = resolveConfig(api.pluginConfig);
    const runtime = new QmdMemoryRuntime(config.corpora, config.analysis.executable);
    const capability = {
        deterministicRecallToolName: "memory_search",
        supportsPrivateTranscriptRecall: false,
        promptBuilder: ({ availableTools }) => availableTools.has("memory_search")
            ? ["Use memory_search for relevant past facts, then memory_get when more surrounding context is needed."]
            : [],
        flushPlanResolver: resolveFlushPlan,
        runtime,
    };
    api.registerMemoryCapability(capability);
    api.registerTool((ctx) => createSearchTool(runtime, ctx), { names: ["memory_search"] });
    api.registerTool((ctx) => createGetTool(runtime, ctx), { names: ["memory_get"] });
    api.registerTool((ctx) => createSyncSessionsTool(runtime, ctx), { names: ["memory_sync_sessions"] });
    api.registerTool((ctx) => createSyncStatusTool(runtime, ctx), { names: ["memory_sync_status"] });
    api.registerTool((ctx) => createReclusterTool(runtime, ctx), { names: ["memory_recluster"] });
    api.registerTool((ctx) => createListClustersTool(runtime, ctx), { names: ["memory_list_clusters"] });
    api.registerTool((ctx) => createFetchClusterTool(runtime, ctx), { names: ["memory_fetch_cluster"] });
}
