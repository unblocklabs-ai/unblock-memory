import { Type } from "typebox";
import { Value } from "typebox/value";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig, type UnblockMemoryConfig } from "./config.js";
import { resolveTypeSafeApiKey } from "./typesafe.js";
import { registerPeopleHooks } from "./people-hooks.js";
import { PeopleStores } from "./people-store.js";
import { registerPeopleTools } from "./people-tools.js";
import { registerPeoplePrimerTool } from "./people-primer-tool.js";
import { QmdMemoryRuntime } from "./runtime.js";
import { registerSkillWhisperer } from "./skill-whisperer.js";
import { registerMemoryWhisperer } from "./memory-whisperer.js";
import { getContext } from "./tool-context.js";
import { WhispererDiagnostics } from "./diagnostics.js";
import { registerReviewTools } from "./review-tools.js";
import { registerResponseAudit } from "./response-runtime.js";
import { resolveTimezone } from "./session-projector.js";

const searchParameters = Type.Object(
  {
    query: Type.String({ pattern: "\\S" }),
    corpora: Type.Optional(Type.Array(Type.String({ pattern: "\\S" }), {
      minItems: 1, description: 'Configured corpus names; default is all non-skill corpora. Use ["all"] alone for explicit all-corpora recall.',
    })),
    sessionFilter: Type.Optional(
      Type.Object(
        {
          startedFrom: Type.Optional(
            Type.String({
              description: "Inclusive lower bound on session start time, not message or claim dates (ISO 8601).",
              pattern:
                "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$",
            }),
          ),
          startedTo: Type.Optional(
            Type.String({
              description: "Inclusive upper bound on session start time, not message or claim dates (ISO 8601).",
              pattern:
                "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$",
            }),
          ),
          provider: Type.Optional(Type.String({ pattern: "\\S" })),
          chatType: Type.Optional(
            Type.Union([Type.Literal("channel"), Type.Literal("group"), Type.Literal("direct")]),
          ),
          accountId: Type.Optional(Type.String({ pattern: "\\S" })),
          conversationId: Type.Optional(Type.String({ pattern: "\\S" })),
        },
        { additionalProperties: false, description: "Restricts session documents only; selected file corpora remain eligible. Not an audience access control." },
      ),
    ),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum hits; default 5." })),
    minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Minimum vector similarity; default 0.3. Not confidence in factual truth." })),
  },
  { additionalProperties: false },
);

const getParameters = Type.Object(
  {
    path: Type.String({ pattern: "\\S" }),
    from: Type.Optional(Type.Integer({ minimum: 1, description: "First source line, 1-based; default 1. Use nextFrom from a truncated read to continue." })),
    lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Requested lines; default 120, also bounded by 12,000 content characters." })),
  },
  { additionalProperties: false },
);

const syncSessionsParameters = Type.Object(
  {
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const syncStatusParameters = Type.Object({}, { additionalProperties: false });

function createSearchTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search this agent's configured memory corpora with local vector retrieval, not QMD's hybrid query. Skills are excluded. Session snippets are arrays of messages (type, name, timestamp, body; partial when incomplete); file snippets are strings. Results are evidence leads; inspect source context with memory_get. Empty results or errors do not prove absence of a fact.",
    parameters: searchParameters,
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const {
        query: untrimmedQuery,
        corpora,
        sessionFilter,
        maxResults,
        minScore,
      } = Value.Parse(searchParameters, params);
      const query = untrimmedQuery.trim();
      const { manager, error } = await runtime.getMemorySearchManager(active);
      if (!manager) return jsonResult({ results: [], error: error ?? "memory unavailable" });
      const results = await manager.search(query, {
        corpora: corpora?.map((corpus) => corpus.trim()),
        sessionFilter,
        maxResults,
        minScore,
        signal,
        requestContext: active.requestContext,
      });
      // Compact only the public tool response; internal ranking and consumers keep
      // full-precision scores and the host's source/citation compatibility fields.
      const payload = {
        results: results.map(({ source: _source, citation: _citation, session, sessionMessages, ...result }) => ({
          ...result,
          snippet: result.corpus === "sessions" ? sessionMessages ?? [{ body: result.snippet, partial: true }] : result.snippet,
          score: Number(result.score.toFixed(2)),
          ...(result.vectorScore !== undefined ? { vectorScore: Number(result.vectorScore.toFixed(2)) } : {}),
          ...(result.textScore !== undefined ? { textScore: Number(result.textScore.toFixed(2)) } : {}),
          ...(session ? { session: { ...session, startedAt: new Date(session.startedAt).toISOString() } } : {}),
        })),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        details: payload,
      };
    },
  };
}

function createGetTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_get",
    label: "Memory Get",
    description: "Read an exact indexed qmd:// source path returned by memory tools. Defaults to 120 lines, bounded to 12,000 content characters. Check truncated/nextFrom and continue when present; not_found or unavailable is not a successful empty read.",
    parameters: getParameters,
    async execute(_toolCallId: string, params: unknown) {
      const { path: untrimmedPath, from, lines } = Value.Parse(getParameters, params);
      const path = untrimmedPath.trim();
      const { manager, error } = await runtime.getMemorySearchManager(active);
      if (!manager)
        return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
      return jsonResult(
        await manager.readFile({
          relPath: path,
          from,
          lines,
          requestContext: active.requestContext,
        }),
      );
    },
  };
}

function createSyncSessionsTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_sync_sessions",
    label: "Sync Memory Sessions",
    description:
      "Start projecting and indexing this agent's configured OpenClaw session transcripts. Use memory_sync_status to check completion.",
    parameters: syncSessionsParameters,
    async execute(_toolCallId: string, params: unknown) {
      const { force } = Value.Parse(syncSessionsParameters, params);
      return jsonResult(await runtime.startSessionSync(active, force));
    },
  };
}

function createSyncStatusTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_sync_status",
    label: "Memory Session Sync Status",
    description: "Check the current or latest session transcript sync.",
    parameters: syncStatusParameters,
    async execute(_toolCallId: string, params: unknown) {
      Value.Parse(syncStatusParameters, params);
      return jsonResult(await runtime.sessionSyncStatus(active.agentId));
    },
  };
}

const reclusterParameters = Type.Object(
  {
    space: Type.Optional(
      Type.Object(
        {
          method: Type.Optional(Type.Union([Type.Literal("umap"), Type.Literal("none")])),
          nComponents: Type.Optional(Type.Integer({ minimum: 2, maximum: 100 })),
          nNeighbors: Type.Optional(Type.Integer({ minimum: 2, maximum: 200 })),
          minDist: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    hdbscan: Type.Optional(
      Type.Object(
        {
          minClusterSize: Type.Optional(Type.Integer({ minimum: 2, maximum: 100_000 })),
          minSamples: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
          clusterSelectionMethod: Type.Optional(
            Type.Union([Type.Literal("eom"), Type.Literal("leaf")]),
          ),
          clusterSelectionEpsilon: Type.Optional(Type.Number({ minimum: 0 })),
          allowSingleCluster: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_294_967_295 })),
  },
  { additionalProperties: false },
);

function createReclusterTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_recluster",
    label: "Recluster Memory",
    description:
      "Rebuild memory clusters from existing QMD vectors. Call only when memory_list_clusters reports missing or stale analysis.",
    parameters: reclusterParameters,
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const options = Value.Parse(reclusterParameters, params);
      const { manager, error } = await runtime.getMemorySearchManager(active);
      if (!manager)
        return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
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

const listClustersParameters = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);

function createListClustersTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_list_clusters",
    label: "List Memory Clusters",
    description:
      "List current memory clusters and freshness. Call this before memory_recluster or memory_fetch_cluster.",
    parameters: listClustersParameters,
    async execute(_toolCallId: string, params: unknown) {
      const { limit } = Value.Parse(listClustersParameters, params);
      const { manager, error } = await runtime.getMemorySearchManager(active);
      if (!manager)
        return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
      return jsonResult(await manager.listClusters(limit));
    },
  };
}

const fetchClusterParameters = Type.Object(
  {
    clusterId: Type.String({ pattern: "^[0-9a-f]{10}$" }),
    topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    sort: Type.Optional(
      Type.Union([
        Type.Literal("representative"),
        Type.Literal("score_desc"),
        Type.Literal("score_asc"),
        Type.Literal("date_desc"),
        Type.Literal("date_asc"),
      ]),
    ),
  },
  { additionalProperties: false },
);

function createFetchClusterTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_fetch_cluster",
    label: "Fetch Memory Cluster",
    description:
      "Fetch a sorted page of QMD chunks for a clusterId returned by memory_list_clusters.",
    parameters: fetchClusterParameters,
    async execute(_toolCallId: string, params: unknown) {
      const { clusterId, topK, offset, sort } = Value.Parse(fetchClusterParameters, params);
      const { manager, error } = await runtime.getMemorySearchManager(active);
      if (!manager)
        return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
      return jsonResult(await manager.fetchCluster({ clusterId, topK, offset, sort }));
    },
  };
}

const maintenanceStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("resolved"),
  Type.Literal("deferred"),
  Type.Literal("irrelevant"),
]);

const auditQualityParameters = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  after: Type.Optional(Type.Object({
    documentId: Type.Integer({ minimum: 1 }), seq: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

function createAuditQualityTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext, config: UnblockMemoryConfig) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_audit_quality", label: "Audit Memory Quality",
    description: "Audit a bounded page of approved indexed chunks using TypeSafe. Records review indicators in the maintenance inbox; never edits, deletes or suppresses source data. Continue with the returned next cursor; restart without after for a cached rescan.",
    parameters: auditQualityParameters,
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const options = Value.Parse(auditQualityParameters, params);
      if (!config.qualityAudit.enabled || !config.typesafe.enabled) return jsonResult({ status: "disabled" });
      const deadline = AbortSignal.timeout(30_000);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        combined.throwIfAborted();
        const apiKey = await resolveTypeSafeApiKey(config.typesafe);
        if (!apiKey) return jsonResult({ status: "unavailable", reason: "TypeSafe API key not configured" });
        combined.throwIfAborted();
        const { manager } = await runtime.getMemorySearchManager(active);
        if (!manager) return jsonResult({ status: "unavailable", reason: "Memory manager unavailable" });
        return jsonResult(await manager.auditQuality({
          ...options, corpora: config.qualityAudit.corpora, minNoise: config.qualityAudit.minNoise,
          apiKey, timeoutMs: config.typesafe.timeoutMs, signal: combined,
        }));
      } catch {
        return jsonResult({ status: "unavailable", reason: "Quality audit failed or was cancelled; retry the same page" });
      }
    },
  };
}

const listMaintenanceParameters = Type.Object(
  {
    status: Type.Optional(maintenanceStatus),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  { additionalProperties: false },
);

function createListMaintenanceTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_list_maintenance_tasks",
    label: "List Memory Maintenance Tasks",
    description:
      "List a bounded curation inbox of chronology, duplicate and quality-review indicators.",
    parameters: listMaintenanceParameters,
    async execute(_toolCallId: string, params: unknown) {
      const options = Value.Parse(listMaintenanceParameters, params);
      const { manager, error } = await runtime.getMemorySearchManager(active);
      if (!manager)
        return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
      return jsonResult({ status: "ok", tasks: await manager.listMaintenanceTasks(options) });
    },
  };
}

const isoTimestamp = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$",
});

const updateMaintenanceParameters = Type.Object(
  {
    taskId: Type.String({ pattern: "\\S" }),
    action: Type.Union([
      Type.Literal("resolve"),
      Type.Literal("defer"),
      Type.Literal("irrelevant"),
    ]),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    annotation: Type.Optional(
      Type.Object(
        {
          scope: Type.Optional(Type.Union([Type.Literal("chunk"), Type.Literal("document")])),
          eventTime: isoTimestamp,
          basis: Type.Union([
            Type.Literal("path"),
            Type.Literal("frontmatter"),
            Type.Literal("session"),
            Type.Literal("agent_verified"),
          ]),
          evidence: Type.String({ minLength: 1, maxLength: 500 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

function createUpdateMaintenanceTool(runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_update_maintenance_task",
    label: "Update Memory Maintenance Task",
    description:
      "Resolve completed work, defer outstanding work, or dismiss an irrelevant memory-maintenance proposal. This tool never edits source Markdown.",
    parameters: updateMaintenanceParameters,
    async execute(_toolCallId: string, params: unknown) {
      const { taskId, action, note, annotation } = Value.Parse(updateMaintenanceParameters, params);
      const { manager, error } = await runtime.getMemorySearchManager(active);
      if (!manager)
        return jsonResult({ status: "unavailable", error: error ?? "memory unavailable" });
      const updated = manager.updateMaintenanceTask({
        id: taskId,
        status: action === "resolve" ? "resolved" : action === "defer" ? "deferred" : "irrelevant",
        note,
        ...(annotation
          ? { annotation: { ...annotation, scope: annotation.scope ?? "chunk" } }
          : {}),
      });
      return jsonResult(updated ? { status: "ok", task: updated } : { status: "not_found" });
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

export function resolveFlushPlan(params: { cfg?: OpenClawConfig; nowMs?: number } = {}) {
  const configured = params.cfg?.agents?.defaults?.compaction?.memoryFlush;
  if (configured?.enabled === false) return null;

  const nowMs = params.nowMs ?? Date.now();
  const date = formatDateInTimezone(nowMs, resolveTimezone(params.cfg?.agents?.defaults?.userTimezone?.trim()));
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
  registerResponseAudit(api, config);
  if (api.registrationMode === "cli-metadata") return;
  const runtime = new QmdMemoryRuntime(config.corpora, {
    analysisExecutable: config.analysis.executable,
    keepEmbeddingModelWarm: config.keepEmbeddingModelWarm,
  });
  const capability = {
    deterministicRecallToolName: "memory_search",
    supportsPrivateTranscriptRecall: false,
    promptBuilder: ({ availableTools }: { availableTools: Set<string> }) =>
      availableTools.has("memory_search")
        ? [
            "Use memory_search for relevant past facts, then memory_get to verify source context, attribution and dates. Follow read continuation when present. Empty search is not proof of absence; historical memory is not current authorization.",
          ]
        : [],
    flushPlanResolver: resolveFlushPlan,
    runtime,
  };
  api.registerMemoryCapability(capability);
  if (config.corpora.some((corpus) => corpus.kind === "sessions" && corpus.syncIntervalMinutes > 0)) {
    api.on("gateway_start", () => runtime.startSessionSyncSchedule(api.config, (error) => {
      api.logger.warn(`unblock-memory scheduled session sync could not start: ${String(error)}`);
    }));
    api.on("gateway_stop", () => runtime.stopSessionSyncSchedule());
  }
  if (config.people.enabled) {
    const peopleStores = new PeopleStores({
      maxOpenTodos: config.people.todos.maxOpen,
      maxBlurbChars: config.people.whisperer.maxChars,
    });
    registerPeopleHooks(api, peopleStores, config.people);
    registerPeopleTools(api, peopleStores, config, runtime);
    registerPeoplePrimerTool(api, runtime, peopleStores, config);
    api.on("gateway_stop", () => peopleStores.closeAll());
  }
  const diagnostics = new WhispererDiagnostics();
  registerSkillWhisperer(api, runtime, config.skillWhisperer, config.typesafe, diagnostics);
  registerMemoryWhisperer(api, runtime, config.memoryWhisperer, config.typesafe, diagnostics);
  api.registerTool((ctx) => createSearchTool(runtime, ctx), { names: ["memory_search"] });
  api.registerTool((ctx) => createGetTool(runtime, ctx), { names: ["memory_get"] });
  api.registerTool((ctx) => createSyncSessionsTool(runtime, ctx), {
    names: ["memory_sync_sessions"],
  });
  api.registerTool((ctx) => createSyncStatusTool(runtime, ctx), { names: ["memory_sync_status"] });
  api.registerTool((ctx) => createReclusterTool(runtime, ctx), { names: ["memory_recluster"] });
  api.registerTool((ctx) => createListClustersTool(runtime, ctx), {
    names: ["memory_list_clusters"],
  });
  api.registerTool((ctx) => createFetchClusterTool(runtime, ctx), {
    names: ["memory_fetch_cluster"],
  });
  api.registerTool((ctx) => createAuditQualityTool(runtime, ctx, config), { names: ["memory_audit_quality"] });
  api.registerTool((ctx) => createListMaintenanceTool(runtime, ctx), {
    names: ["memory_list_maintenance_tasks"],
  });
  api.registerTool((ctx) => createUpdateMaintenanceTool(runtime, ctx), {
    names: ["memory_update_maintenance_task"],
  });
  registerReviewTools(api, runtime, config, diagnostics);
}
