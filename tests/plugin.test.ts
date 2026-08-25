import assert from "node:assert/strict";
import test from "node:test";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { registerUnblockMemory, resolveFlushPlan } from "../src/plugin.js";

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
  type Tool = {
    name: string;
    execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  };
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

  const invalidCalls: Array<[name: string, params: unknown]> = [
    ["memory_search", { query: "memory", maxResults: 21 }],
    ["memory_search", { query: "   " }],
    ["memory_search", { query: "memory", extra: true }],
    ["memory_get", { path: "qmd://memory/MEMORY.md", lines: 1_001 }],
    ["memory_get", { path: "   " }],
    ["memory_get", { path: "qmd://memory/MEMORY.md", extra: true }],
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
