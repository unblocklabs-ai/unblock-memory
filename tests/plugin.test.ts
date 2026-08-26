import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { registerUnblockMemory, resolveFlushPlan } from "../src/plugin.js";
import type { QmdMemoryRuntime } from "../src/runtime.js";

type Tool = {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
};

function parseJsonResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return JSON.parse(content?.[0]?.text ?? "") as Record<string, unknown>;
}

test("flush plan honors disable, thresholds, model, and agent timezone", () => {
  const disabled = {
    agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
  } satisfies OpenClawConfig;
  assert.equal(resolveFlushPlan({ cfg: disabled }), null);

  const configured = {
    agents: {
      defaults: {
        userTimezone: "America/Los_Angeles",
        compaction: {
          memoryFlush: {
            softThresholdTokens: 1234,
            forceFlushTranscriptBytes: "3mb",
            model: "local/fast",
          },
        },
      },
    },
  } satisfies OpenClawConfig;
  const plan = resolveFlushPlan({
    cfg: configured,
    nowMs: Date.parse("2026-08-24T02:00:00Z"),
  });
  assert.equal(plan?.relativePath, "memory/2026-08-23.md");
  assert.equal(plan?.softThresholdTokens, 1234);
  assert.equal(plan?.forceFlushTranscriptBytes, 3 * 1024 * 1024);
  assert.equal(plan?.model, "local/fast");
});

test("registers exactly the clean memory tool contract and validates every tool at execution", async () => {
  const registrations: Array<{
    names: string[];
    factory: (ctx: OpenClawPluginToolContext) => Tool | null;
  }> = [];
  const api = {
    pluginConfig: {},
    registerMemoryCapability() {},
    registerTool(factory: (ctx: OpenClawPluginToolContext) => Tool | null, options: { names: string[] }) {
      registrations.push({ factory, names: options.names });
    },
  } as unknown as OpenClawPluginApi;

  registerUnblockMemory(api);
  assert.deepEqual(registrations.flatMap((registration) => registration.names), [
    "memory_search",
    "memory_get",
    "memory_sync_sessions",
    "memory_sync_status",
    "memory_recluster",
    "memory_list_clusters",
    "memory_fetch_cluster",
  ]);
  assert.ok(!registrations.some((registration) =>
    registration.names.some((name) => ["memory_analyze", "memory_clusters", "memory_cluster"].includes(name))));

  const context = {
    agentId: "bill",
    config: {},
  } as OpenClawPluginToolContext;
  const tool = (name: string) => registrations.find((registration) => registration.names.includes(name))!.factory(context)!;
  assert.ok(tool("memory_search").parameters.properties?.corpora);
  assert.ok(tool("memory_search").parameters.properties?.sessionFilter);

  const invalidCalls: Array<[name: string, params: unknown]> = [
    ["memory_search", { query: "memory", maxResults: 21 }],
    ["memory_search", { query: "   " }],
    ["memory_search", { query: "memory", corpora: [] }],
    ["memory_search", { query: "memory", corpora: [""] }],
    ["memory_search", { query: "memory", sessionFilter: { startedFrom: "yesterday" } }],
    ["memory_search", { query: "memory", sessionFilter: { chatType: "thread" } }],
    ["memory_search", { query: "memory", sessionFilter: { provider: " " } }],
    ["memory_search", { query: "memory", sessionFilter: { extra: true } }],
    ["memory_search", { query: "memory", extra: true }],
    ["memory_get", { path: "qmd://memory/MEMORY.md", lines: 1_001 }],
    ["memory_get", { path: "   " }],
    ["memory_get", { path: "qmd://memory/MEMORY.md", extra: true }],
    ["memory_sync_sessions", { force: "yes" }],
    ["memory_sync_sessions", { extra: true }],
    ["memory_sync_status", { extra: true }],
    ["memory_recluster", { hdbscan: { clusterSelectionEpsilon: Number.POSITIVE_INFINITY } }],
    ["memory_recluster", { seed: -1 }],
    ["memory_recluster", { extra: true }],
    ["memory_list_clusters", { limit: 0 }],
    ["memory_fetch_cluster", { clusterId: "cluster-1" }],
    ["memory_fetch_cluster", { clusterId: "0123456789", topK: 51 }],
  ];
  for (const [name, params] of invalidCalls) {
    await assert.rejects(tool(name).execute("call", params));
  }
});

test("memory_search exposes session start time as ISO 8601", async () => {
  let runtime: QmdMemoryRuntime | undefined;
  let searchFactory: ((ctx: OpenClawPluginToolContext) => Tool | null) | undefined;
  const api = {
    pluginConfig: {},
    registerMemoryCapability(capability: { runtime: QmdMemoryRuntime }) {
      runtime = capability.runtime;
    },
    registerTool(factory: (ctx: OpenClawPluginToolContext) => Tool | null, options: { names: string[] }) {
      if (options.names.includes("memory_search")) searchFactory = factory;
    },
  } as unknown as OpenClawPluginApi;
  registerUnblockMemory(api);
  assert.ok(runtime);
  assert.ok(searchFactory);

  const startedAt = Date.parse("2026-08-25T14:00:00Z");
  const internalResult = {
    path: "qmd://sessions/session.md",
    startLine: 1,
    endLine: 2,
    score: 0.8,
    snippet: "session body",
    source: "memory" as const,
    corpus: "sessions",
    citation: "sessions/session.md#L1-L2",
    session: {
      sessionId: "session-1",
      provider: "slack",
      chatType: "channel" as const,
      accountId: "workspace",
      conversationId: "C123",
      startedAt,
    },
  };
  Object.defineProperty(runtime, "getMemorySearchManager", {
    value: async () => ({ manager: { search: async () => [internalResult] } }),
  });

  const tool = searchFactory({ agentId: "bill", config: {} } as OpenClawPluginToolContext)!;
  const result = parseJsonResult(await tool.execute("search", { query: "session" }));
  assert.deepEqual(result, {
    results: [{
      ...internalResult,
      session: {
        ...internalResult.session,
        startedAt: "2026-08-25T14:00:00.000Z",
      },
    }],
    provider: "unblock-memory",
  });
  assert.equal(internalResult.session.startedAt, startedAt);
});

test("session sync tools accept and report status without awaiting cold initialization", async () => {
  const registrations = new Map<string, (ctx: OpenClawPluginToolContext) => Tool | null>();
  let runtime: QmdMemoryRuntime | undefined;
  const api = {
    pluginConfig: {
      corpora: [
        { name: "memory", kind: "files", paths: ["MEMORY.md"] },
        { name: "sessions", kind: "sessions" },
      ],
    },
    registerMemoryCapability(capability: { runtime: QmdMemoryRuntime }) {
      runtime = capability.runtime;
    },
    registerTool(factory: (ctx: OpenClawPluginToolContext) => Tool | null, options: { names: string[] }) {
      for (const name of options.names) registrations.set(name, factory);
    },
  } as unknown as OpenClawPluginApi;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = await mkdtemp(join(tmpdir(), "unblock-memory-plugin-status-"));
  try {
    registerUnblockMemory(api);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  assert.ok(runtime);

  let releaseManager = () => {};
  const managerGate = new Promise<void>((resolve) => { releaseManager = resolve; });
  Object.defineProperty(runtime, "getMemorySearchManager", {
    value: async () => {
      await managerGate;
      return {
        manager: {
          async syncSessions() {
            return {
              scanned: 0,
              unchanged: 0,
              updated: 0,
              removed: 0,
              skipped: 0,
              failed: 0,
              embedded: 0,
              lastSuccessfulSyncAt: Date.now(),
            };
          },
        },
      };
    },
  });

  const context = { agentId: "bill", config: {} } as OpenClawPluginToolContext;
  const tool = (name: string) => registrations.get(name)!(context)!;
  const accepted = await Promise.race([
    tool("memory_sync_sessions").execute("sync", {}),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("sync acceptance blocked")), 100)),
  ]);
  assert.equal(parseJsonResult(accepted).status, "started");
  const status = parseJsonResult(await tool("memory_sync_status").execute("status", {}));
  assert.equal(status.status, "running");
  assert.equal(status.phase, "queued");

  releaseManager();
});
