import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { deepThoughtAudienceKey, DeepThoughtStore } from "../src/deep-thought-store.js";
import { MemoryCrystalsStore } from "../src/memory-crystals.js";
import { OutcomeLedgerStore, runOutcomeLedgerPass } from "../src/outcome-ledger.js";
import { registerUnblockMemory, resolveFlushPlan } from "../src/plugin.js";
import type { QmdMemoryRuntime } from "../src/runtime.js";
import { runExpectationsPass } from "../src/steward-expectations.js";
import { WorkStore } from "../src/work-store.js";

test("cold plugin loading does not start the QMD backend", () => {
  const entry = new URL("../index.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "@unblocklabs/qmd") throw new Error("QMD loaded before a memory operation");
      return next(specifier, context);
    }});
    const entry = await import(${JSON.stringify(entry)});
    if (!entry.default) throw new Error("Plugin entry did not load");
    await new Promise(resolve => setTimeout(resolve, 100));
  `], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});

type Tool = {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
};

function parseJsonResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return JSON.parse(content?.[0]?.text ?? "") as Record<string, unknown>;
}

test("quality audit is inert when disabled or an explicit key file is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-key-gate-"));
  for (const enabled of [false, true]) {
    let auditFactory: ((ctx: OpenClawPluginToolContext) => Tool | null) | undefined;
    const api = {
      pluginConfig: {
        qualityAudit: { enabled, corpora: ["memory"] },
        decisionModel: { apiKeyFile: join(root, "missing.env") },
      },
      registerCli() {},
      registerService() {},
      on() {},
      registerGatewayMethod() {},
      registerMemoryCapability(capability: { runtime: QmdMemoryRuntime }) {
        Object.defineProperty(capability.runtime, "getMemorySearchManager", {
          value: () => { assert.fail("credential gate must precede manager access"); },
        });
      },
      registerTool(factory: (ctx: OpenClawPluginToolContext) => Tool | null, options: { names: string[] }) {
        if (options.names.includes("memory_audit_quality")) auditFactory = factory;
      },
    } as unknown as OpenClawPluginApi;
    registerUnblockMemory(api);
    const tool = auditFactory!({ agentId: "bill", config: {} } as OpenClawPluginToolContext)!;
    const result = parseJsonResult(await tool.execute("gate", {}));
    assert.equal(result.status, enabled ? "unavailable" : "disabled");
    if (enabled) assert.equal(result.reason, "Decision model API key not configured");
  }
});

test("flush plan honors disable, thresholds, model, and agent timezone", () => {
  const disabled = {
    agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
  } satisfies OpenClawConfig;
  assert.equal(resolveFlushPlan({ cfg: disabled }), null);

  const configured = {
    agents: {
      defaults: {
        userTimezone: " America/Los_Angeles ",
        compaction: {
          memoryFlush: {
            softThresholdTokens: 1234,
            forceFlushTranscriptBytes: "3mb",
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
  assert.equal(plan?.model, undefined);

  // Older hosts still pass this field. Updating only the plugin must not reroute flushes.
  const legacyFlush = { ...configured.agents.defaults.compaction.memoryFlush, model: " local/fast " };
  assert.equal(resolveFlushPlan({ cfg: {
    agents: { defaults: { compaction: { memoryFlush: legacyFlush } } },
  } })?.model, "local/fast");
});

test("registers exactly the clean memory tool contract and validates every tool at execution", async () => {
  const registrations: Array<{
    names: string[];
    factory: (ctx: OpenClawPluginToolContext) => Tool | null;
  }> = [];
  const hooks: string[] = [];
  const api = {
    pluginConfig: {},
    on(name: string) { hooks.push(name); },
    registerCli() {},
    registerService() {},
    registerGatewayMethod() {},
    registerMemoryCapability() {},
    registerTool(
      factory: (ctx: OpenClawPluginToolContext) => Tool | null,
      options: { names: string[] },
    ) {
      registrations.push({ factory, names: options.names });
    },
  } as unknown as OpenClawPluginApi;

  registerUnblockMemory(api);
  assert.deepEqual(
    registrations.flatMap((registration) => registration.names),
    [
      "memory_people_learning",
      "memory_search",
      "memory_get",
      "memory_sync_sessions",
      "memory_sync_status",
      "memory_recluster",
      "memory_list_clusters",
      "memory_fetch_cluster",
      "memory_audit_quality",
      "memory_list_maintenance_tasks",
      "memory_update_maintenance_task",
      "memory_diagnostics",
      "memory_review_claim",
      "memory_review_cluster",
      "deep_thought",
    ],
  );
  assert.ok(
    !registrations.some((registration) =>
      registration.names.some((name) =>
        ["memory_analyze", "memory_clusters", "memory_cluster"].includes(name),
      ),
    ),
  );
  // A default install has no skills corpus and Memory Whisperer is opt-in; the only conversation-access hook is the
  // default-on, read-only Expectations Whisperer (non-bundled plugins need hooks.allowConversationAccess=true for it).
  assert.equal(hooks.filter(name => name === "before_prompt_build").length, 1);
  const quiet: string[] = [];
  registerUnblockMemory({ ...api, pluginConfig: { expectationsWhisperer: { enabled: false } }, registerTool() {},
    on(name: string) { quiet.push(name); } } as unknown as OpenClawPluginApi);
  assert.equal(quiet.includes("before_prompt_build"), false, "disabling Expectations leaves no conversation-access hook");

  const context = {
    agentId: "bill",
    config: {},
  } as OpenClawPluginToolContext;
  const tool = (name: string) =>
    registrations.find((registration) => registration.names.includes(name))!.factory(context)!;
  assert.ok(tool("memory_search").parameters.properties?.corpora);
  assert.ok(tool("memory_search").parameters.properties?.sessionFilter);
  assert.ok(tool("memory_fetch_cluster").parameters.properties?.offset);
  assert.ok(tool("memory_fetch_cluster").parameters.properties?.sort);
  assert.ok(tool("memory_list_maintenance_tasks").parameters.properties?.limit);
  assert.ok(tool("memory_update_maintenance_task").parameters.properties?.action);

  const invalidCalls: Array<[name: string, params: unknown]> = [
    ["memory_diagnostics", { extra: true }],
    ["memory_review_claim", { claim: "x", citations: [] }],
    ["memory_review_claim", { claim: "x", citations: [{ path: "qmd://memory/note.md", from: 0, lines: 1 }] }],
    ["memory_review_cluster", { clusterId: "unknown" }],
    ["memory_audit_quality", { limit: 21 }],
    ["memory_audit_quality", { corpora: ["private"] }],
    ["memory_audit_quality", { after: { documentId: -1, seq: 0 } }],
    ["memory_search", { query: "memory" }],
    ["memory_search", { bm25Query: "memory", vectorQuery: "memory", maxResults: 21 }],
    ["memory_search", { bm25Query: "   ", vectorQuery: "memory" }],
    ["memory_search", { bm25Query: "memory", vectorQuery: "   " }],
    ["memory_search", { bm25Query: "memory", vectorQuery: "memory", minScore: 0.3 }],
    ["memory_search", { bm25Query: "memory", vectorQuery: "memory", minUsefulness: 1.1 }],
    ["memory_search", { bm25Query: "memory", vectorQuery: "memory", corpora: [] }],
    ["memory_search", { bm25Query: "memory", vectorQuery: "memory", corpora: [""] }],
    ["memory_search", { bm25Query: "memory", vectorQuery: "memory", sessionFilter: { startedFrom: "yesterday" } }],
    ["memory_search", { bm25Query: "memory", vectorQuery: "memory", sessionFilter: { chatType: "thread" } }],
    ["memory_search", { bm25Query: "memory", vectorQuery: "memory", sessionFilter: { provider: " " } }],
    ["memory_search", { bm25Query: "memory", vectorQuery: "memory", sessionFilter: { extra: true } }],
    ["memory_search", { bm25Query: "memory", vectorQuery: "memory", extra: true }],
    ["memory_get", { path: "qmd://memory/MEMORY.md", lines: 1_001 }],
    ["memory_get", { path: "   " }],
    ["memory_get", { path: "qmd://memory/MEMORY.md", extra: true }],
    ["memory_get", { path: "qmd://memory/MEMORY.md", from: 1, cursor: { line: 1, offset: 3, revision: "revision" } }],
    ["memory_get", { path: "qmd://memory/MEMORY.md", cursor: { line: 1, offset: -1, revision: "revision" } }],
    ["memory_sync_sessions", { force: "yes" }],
    ["memory_sync_sessions", { extra: true }],
    ["memory_sync_status", { extra: true }],
    ["memory_recluster", { hdbscan: { clusterSelectionEpsilon: Number.POSITIVE_INFINITY } }],
    ["memory_recluster", { seed: -1 }],
    ["memory_recluster", { extra: true }],
    ["memory_list_clusters", { limit: 0 }],
    ["memory_fetch_cluster", { clusterId: "cluster-1" }],
    ["memory_fetch_cluster", { clusterId: "0123456789", topK: 51 }],
    ["memory_fetch_cluster", { clusterId: "0123456789", offset: -1 }],
    ["memory_fetch_cluster", { clusterId: "0123456789", sort: "newest" }],
    ["memory_list_maintenance_tasks", { limit: 11 }],
    ["memory_list_maintenance_tasks", { status: "ignored" }],
    ["memory_update_maintenance_task", { taskId: "task", action: "delete" }],
    [
      "memory_update_maintenance_task",
      {
        taskId: "task",
        action: "resolve",
        annotation: {
          eventTime: "yesterday",
          basis: "agent_verified",
          evidence: "checked",
        },
      },
    ],
  ];
  for (const [name, params] of invalidCalls) {
    await assert.rejects(tool(name).execute("call", params));
  }
});

test("memory search compacts judged results without changing evidence or request context internally", async t => {
  let runtime: QmdMemoryRuntime | undefined;
  let searchFactory: ((ctx: OpenClawPluginToolContext) => Tool | null) | undefined;
  let getFactory: ((ctx: OpenClawPluginToolContext) => Tool | null) | undefined;
  const api = {
    pluginConfig: { decisionModel: { enabled: true, apiKey: "test-key" } },
    on() {},
    registerCli() {},
    registerService() {},
    registerGatewayMethod() {},
    registerMemoryCapability(capability: { runtime: QmdMemoryRuntime }) {
      runtime = capability.runtime;
    },
    registerTool(
      factory: (ctx: OpenClawPluginToolContext) => Tool | null,
      options: { names: string[] },
    ) {
      if (options.names.includes("memory_search")) searchFactory = factory;
      if (options.names.includes("memory_get")) getFactory = factory;
    },
  } as unknown as OpenClawPluginApi;
  registerUnblockMemory(api);
  assert.ok(runtime);
  assert.ok(searchFactory);
  assert.ok(getFactory);

  const startedAt = Date.parse("2026-08-25T14:00:00Z");
  const internalResult = {
    path: "qmd://sessions/session.md",
    startLine: 1,
    endLine: 2,
    score: 0.87654321,
    vectorScore: 0.87654321,
    snippet: "session body",
    source: "memory" as const,
    corpus: "sessions",
    citation: "sessions/session.md#L1-L2",
    messageTimestamp: "2026-08-25 14:33:02 UTC",
    sessionMessages: [
      { type: "user", name: "Bek", timestamp: "2026-08-25 14:32:09 UTC", body: "Why?\n\n&gt; Quoted text." },
      { type: "assistant", name: "Bill", timestamp: "2026-08-25 14:33:02 UTC", body: "**Original** `body`", partial: true },
    ],
    session: {
      sessionId: "session-1",
      provider: "slack",
      chatType: "channel" as const,
      accountId: "workspace",
      conversationId: "C123",
      startedAt,
    },
  };
  const fileResult = {
    path: "qmd://memory/MEMORY.md",
    startLine: 3,
    endLine: 4,
    score: 0.304999,
    snippet: "source text\nwith original formatting",
    source: "memory" as const,
    corpus: "memory",
    citation: "memory/MEMORY.md#L3-L4",
  };
  const unknownSessionResult = {
    path: internalResult.path, startLine: 8, endLine: 9,
    score: internalResult.score, vectorScore: internalResult.vectorScore,
    source: "memory", corpus: "sessions", session: internalResult.session,
    snippet: "Unattributed legacy text",
  };
  const originalResults = structuredClone([internalResult, fileResult]);
  let searchContext: unknown;
  let readParams: { requestContext?: unknown; cursor?: unknown } | undefined;
  Object.defineProperty(runtime, "getMemorySearchManager", {
    value: async () => ({
      manager: {
        searchCandidates: async (_queries: unknown, options: { requestContext?: unknown }) => {
          searchContext = options.requestContext;
          return [internalResult, fileResult, unknownSessionResult];
        },
        readFile: async (params: NonNullable<typeof readParams>) => {
          readParams = params;
          return { status: "stale_cursor", text: "", path: "qmd://memory/missing.md", error: "Restart without cursor." };
        },
      },
    }),
  });

  const context = {
    agentId: "bill",
    config: {},
    sessionKey: "agent:bill:slack:channel:C123",
    sessionId: "session-123",
    messageChannel: "slack",
    agentAccountId: "workspace-1",
    nativeChannelId: "C123",
    deliveryContext: { channel: "slack", accountId: "workspace-1", to: "channel:C123" },
  } satisfies OpenClawPluginToolContext;
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    const request = JSON.parse(String(init?.body));
    const [state] = request.state;
    assert.deepEqual(state.conversation, { history: [], currentRequest: "session" });
    return Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { memory_0: { type: "noul",
      noul: state.candidates[0].corpus === "memory" ? 0.304999 : 0.87654321 } } });
  });
  const tool = searchFactory(context)!;
  const response = await tool.execute("search", { bm25Query: "session", vectorQuery: "session", minUsefulness: 0 }) as {
    content: Array<{ type: string; text: string }>;
    details: unknown;
  };
  const result = parseJsonResult(response);
  const cursor = { line: 2, offset: 3, revision: "revision" };
  const readResult = parseJsonResult(await getFactory(context)!.execute("get", { path: "qmd://memory/missing.md", cursor }));
  assert.equal(readResult.status, "stale_cursor");
  assert.deepEqual(result, {
    rankingMode: "decision",
    scoreMeaning: "usefulness_probability",
    minUsefulnessApplied: true,
    results: [
      {
        path: internalResult.path,
        startLine: 1,
        endLine: 2,
        score: 0.88,
        snippet: internalResult.sessionMessages,
        corpus: "sessions",
        messageTimestamp: internalResult.messageTimestamp,
        session: {
          ...internalResult.session,
          startedAt: "2026-08-25T14:00:00.000Z",
        },
      },
      {
        path: internalResult.path, startLine: 8, endLine: 9, score: 0.88,
        snippet: [{ body: unknownSessionResult.snippet, partial: true }], corpus: "sessions",
        session: { ...internalResult.session, startedAt: "2026-08-25T14:00:00.000Z" },
      },
      {
        path: fileResult.path, startLine: 3, endLine: 4, score: 0.3,
        snippet: fileResult.snippet, corpus: "memory",
      },
    ],
  });
  assert.deepEqual(response.details, result);
  assert.deepEqual(response.content, [{ type: "text", text: JSON.stringify(result) }]);
  assert.deepEqual([internalResult, fileResult], originalResults);
  const expected = {
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    messageChannel: context.messageChannel,
    agentAccountId: context.agentAccountId,
    nativeChannelId: context.nativeChannelId,
    deliveryContext: context.deliveryContext,
  };
  assert.deepEqual(searchContext, expected);
  assert.deepEqual(readParams?.requestContext, expected);
  assert.deepEqual(readParams?.cursor, cursor);
});

test("session sync tools accept and report status without awaiting cold initialization", async () => {
  const registrations = new Map<string, (ctx: OpenClawPluginToolContext) => Tool | null>();
  const hooks: string[] = [];
  let runtime: QmdMemoryRuntime | undefined;
  const api = {
    on(name: string) { hooks.push(name); },
    pluginConfig: {
      corpora: [
        { name: "memory", kind: "files", paths: ["MEMORY.md"] },
        { name: "sessions", kind: "sessions" },
      ],
    },
    registerCli() {},
    registerService() {},
    registerGatewayMethod() {},
    registerMemoryCapability(capability: { runtime: QmdMemoryRuntime }) {
      runtime = capability.runtime;
    },
    registerTool(
      factory: (ctx: OpenClawPluginToolContext) => Tool | null,
      options: { names: string[] },
    ) {
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
  assert.ok(hooks.includes("gateway_start") && hooks.includes("gateway_stop"));

  let releaseManager = () => {};
  const managerGate = new Promise<void>((resolve) => {
    releaseManager = resolve;
  });
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
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("sync acceptance blocked")), 100),
    ),
  ]);
  assert.equal(parseJsonResult(accepted).status, "started");
  const status = parseJsonResult(await tool("memory_sync_status").execute("status", {}));
  assert.equal(status.status, "running");
  assert.equal(status.phase, "queued");

  releaseManager();
});

test("an explicit Skill Whisperer enable without a skills corpus warns instead of failing silently", () => {
  // Host-applied manifest defaults carry no `enabled`, so only an operator's true can warn.
  const quiet = { expectationsWhisperer: { enabled: false } };
  const cases: [Record<string, unknown>, boolean][] = [
    [{ ...quiet, skillWhisperer: { enabled: true } }, true],
    [quiet, false],
    [{ ...quiet, skillWhisperer: { historyMessages: 5, minScore: 0.5, cooldownTurns: 10 } }, false],
  ];
  for (const [pluginConfig, warned] of cases) {
    const warnings: string[] = [], hooks: string[] = [];
    registerUnblockMemory({
      pluginConfig, on(name: string) { hooks.push(name); },
      registerCli() {}, registerService() {}, registerGatewayMethod() {}, registerMemoryCapability() {}, registerTool() {},
      logger: { warn(message: string) { warnings.push(message); }, info() {}, debug() {}, error() {} },
    } as unknown as OpenClawPluginApi);
    assert.equal(warnings.some(w => w.includes('no corpus has kind "skills"')), warned, JSON.stringify(pluginConfig));
    assert.equal(hooks.includes("before_prompt_build"), false);
  }
});

test("steward: memory-steward CLI always registers; deep_thought and the shadow loop default on and honor opt-out", () => {
  const register = (pluginConfig: Record<string, unknown>, registrationMode = "full") => {
    const tools: string[] = [], cli: string[] = [], hooks: string[] = [];
    registerUnblockMemory({
      pluginConfig, registrationMode, config: {},
      on(name: string) { hooks.push(name); },
      registerCli(_register: unknown, options?: { descriptors?: { name: string }[] }) {
        cli.push(...(options?.descriptors ?? []).map(descriptor => descriptor.name));
      },
      registerService() {}, registerGatewayMethod() {}, registerMemoryCapability() {},
      registerTool(_factory: unknown, options: { names: string[] }) { tools.push(...options.names); },
      logger: { warn() {}, info() {}, debug() {}, error() {} },
    } as unknown as OpenClawPluginApi);
    return { tools, cli, hooks };
  };
  const defaults = register({});
  assert.ok(defaults.cli.includes("memory-steward"));
  assert.deepEqual(defaults.tools.filter(name => name === "deep_thought"), ["deep_thought"]);
  // Master switch off disables both sub-features even if sub-feature flags are true; sub-feature opt-out works individually.
  assert.equal(register({ steward: { enabled: false } }).tools.includes("deep_thought"), false);
  assert.equal(register({ steward: { enabled: false, deepThought: { enabled: true } } }).tools.includes("deep_thought"), false);
  assert.equal(register({ steward: { enabled: true, deepThought: { enabled: false } } }).tools.includes("deep_thought"), false);
  const metadata = register({ steward: { enabled: true, peopleShadow: { enabled: true } } }, "cli-metadata");
  assert.ok(metadata.cli.includes("memory-steward"), "CLI descriptors are available to cli-metadata loads");
  assert.equal(metadata.hooks.length, 0, "cli-metadata never starts background work");
  const shadowHooks = register({ steward: { enabled: true, peopleShadow: { enabled: true } } }).hooks;
  const quietHooks = register({ steward: { enabled: true, peopleShadow: { enabled: false }, captainsLog: { enabled: false },
    outcomeLedger: { enabled: false }, expectations: { enabled: false }, crystals: { enabled: false }, overnight: { enabled: false },
    skills: { enabled: false } } }).hooks;
  const crystalsOnlyHooks = register({ steward: { enabled: true, peopleShadow: { enabled: false }, captainsLog: { enabled: false },
    outcomeLedger: { enabled: false }, expectations: { enabled: false }, overnight: { enabled: false }, skills: { enabled: false } } }).hooks;
  const overnightOnlyHooks = register({ steward: { enabled: true, peopleShadow: { enabled: false }, captainsLog: { enabled: false },
    outcomeLedger: { enabled: false }, expectations: { enabled: false }, crystals: { enabled: false }, skills: { enabled: false } } }).hooks;
  const skillsOnlyHooks = register({ steward: { enabled: true, peopleShadow: { enabled: false }, captainsLog: { enabled: false },
    outcomeLedger: { enabled: false }, expectations: { enabled: false }, crystals: { enabled: false }, overnight: { enabled: false } } }).hooks;
  const ledgerOnlyHooks = register({ steward: { enabled: true, peopleShadow: { enabled: false }, captainsLog: { enabled: false },
    expectations: { enabled: false } } }).hooks;
  const expectationsOnlyHooks = register({ steward: { enabled: true, peopleShadow: { enabled: false }, captainsLog: { enabled: false },
    outcomeLedger: { enabled: false } } }).hooks;
  assert.equal(ledgerOnlyHooks.filter(name => name === "gateway_start").length, shadowHooks.filter(name => name === "gateway_start").length,
    "the default-on Outcome Ledger alone still starts the background Steward loop");
  assert.equal(expectationsOnlyHooks.filter(name => name === "gateway_start").length, shadowHooks.filter(name => name === "gateway_start").length,
    "the default-on Expectations pass alone still starts the background Steward loop (no runner needed)");
  assert.equal(crystalsOnlyHooks.filter(name => name === "gateway_start").length, shadowHooks.filter(name => name === "gateway_start").length,
    "the default-on Crystals pass alone still starts the background Steward loop");
  assert.equal(overnightOnlyHooks.filter(name => name === "gateway_start").length, shadowHooks.filter(name => name === "gateway_start").length,
    "the default-on Overnight pass alone still starts the background Steward loop");
  assert.equal(skillsOnlyHooks.filter(name => name === "gateway_start").length, shadowHooks.filter(name => name === "gateway_start").length,
    "the default-on self-writing Skills pass alone still starts the background Steward loop");
  assert.equal(shadowHooks.filter(name => name === "gateway_start").length, quietHooks.filter(name => name === "gateway_start").length + 1,
    "the background Steward loop adds exactly one gateway_start hook");
});

test("deep_thought gets a per-agent durable store and live QMD generations; gateway_stop closes the store", async () => {
  const registrations = new Map<string, (ctx: OpenClawPluginToolContext) => Tool | null>();
  const handlers = new Map<string, (() => unknown)[]>();
  let runtime: QmdMemoryRuntime | undefined;
  const api = {
    pluginConfig: { corpora: [{ name: "memory", kind: "files", paths: ["MEMORY.md"] }] },
    on(name: string, handler: () => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCli() {}, registerService() {}, registerGatewayMethod() {},
    registerMemoryCapability(capability: { runtime: QmdMemoryRuntime }) { runtime = capability.runtime; },
    registerTool(factory: (ctx: OpenClawPluginToolContext) => Tool | null, options: { names: string[] }) {
      for (const name of options.names) registrations.set(name, factory);
    },
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  } as unknown as OpenClawPluginApi;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = await mkdtemp(join(tmpdir(), "unblock-memory-plugin-deep-thought-"));
  try { registerUnblockMemory(api); } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  let generation = 3;
  const generationRequests: (readonly string[])[] = [];
  Object.defineProperty(runtime!, "getMemorySearchManager", {
    value: async () => ({ manager: { async getCollectionGenerations(corpora: readonly string[]) {
      generationRequests.push(corpora);
      return { "memory-collection": generation };
    } } }),
  });
  // A DM session's cache audience needs the verified requester (fail closed without one).
  const context = { agentId: "bill", config: {}, sessionKey: "agent:bill:slack:direct:u1", messageChannel: "slack",
    agentAccountId: "workspace", requesterSenderId: "U1" } as OpenClawPluginToolContext;
  const audienceKey = deepThoughtAudienceKey({ agentId: "bill", sessionKey: context.sessionKey, provider: "slack", accountId: "workspace",
    senderId: "U1" })!;
  const seed = new DeepThoughtStore(runtime!.memoryDatabasePath("bill"));
  seed.saveDerivedObservation({ agentId: "bill", question: "Who owns the launch?", audienceKey, corpora: ["memory"],
    collectionGenerations: { "memory-collection": 3 }, answer: "Mira owns it.", confidence: "high", citations: [] });
  seed.close();

  const ask = async () => parseJsonResult(await registrations.get("deep_thought")!(context)!.execute("dt", { question: "Who owns the launch?" }));
  const hit = await ask();
  assert.equal(hit.cached, true, JSON.stringify(hit));
  assert.equal(hit.answer, "Mira owns it.");
  assert.deepEqual(generationRequests, [["memory"]], "generations are read for exactly the approved corpora");

  for (const handler of handlers.get("gateway_stop") ?? []) await handler();
  generation = 4;
  // Reopened lazily after a stop; an advanced generation invalidates the stored answer.
  const reopened = registrations.get("deep_thought")!(context)!;
  assert.ok(reopened);
  const check = new DeepThoughtStore(runtime!.memoryDatabasePath("bill"));
  try {
    const before = check.listDerivedObservations({ agentId: "bill" });
    assert.equal(before.length, 1);
    assert.equal(before[0]!.status, "fresh");
    assert.equal(check.findFreshDerivedObservation({ agentId: "bill", question: "Who owns the launch?", audienceKey,
      corpora: ["memory"], currentGenerations: { "memory-collection": 4 } }), undefined);
    assert.equal(check.listDerivedObservations({ agentId: "bill" })[0]!.status, "stale");
  } finally { check.close(); }
});

/* ───────────── Option A integration: Expectations, derived observations, recipe stamping ───────────── */

/** Minimal commander stand-in for `memory-steward` subcommands. */
class FakeCommand {
  readonly commands = new Map<string, FakeCommand>();
  readonly defaults: Record<string, unknown> = {};
  handler?: (opts: Record<string, unknown>) => unknown;
  command(name: string) { const child = new FakeCommand(); this.commands.set(name, child); return child; }
  description() { return this; }
  option(flags: string, _description?: string, fallback?: unknown) {
    if (fallback !== undefined) this.defaults[cliKey(flags)] = fallback;
    return this;
  }
  requiredOption(flags: string, description?: string, fallback?: unknown) { return this.option(flags, description, fallback); }
  action(handler: (opts: Record<string, unknown>) => unknown) { this.handler = handler; return this; }
}
const cliKey = (flags: string) => flags.split(/[ ,]/u)[0]!.replace(/^--/u, "").replace(/-(\w)/gu, (_, c: string) => c.toUpperCase());
type Hook = (event: unknown, context: unknown) => unknown;

/** The real plugin over a temp state dir; host registration and the QMD manager are the only fakes. */
async function integrationPlugin(t: TestContext, pluginConfig: Record<string, unknown>) {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const stateDir = await mkdtemp(join(tmpdir(), "unblock-memory-option-a-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const hooks = new Map<string, Hook[]>();
  const tools = new Map<string, (ctx: OpenClawPluginToolContext) => Tool | null>();
  const clis: ((ctx: { program: FakeCommand; config: unknown }) => void)[] = [];
  let runtime: QmdMemoryRuntime | undefined;
  const cfg = { agents: { list: [{ id: "bill" }] } };
  const api = {
    pluginConfig, config: cfg, registrationMode: "full",
    on(name: string, handler: Hook) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerCli(register: (ctx: { program: FakeCommand; config: unknown }) => void) { clis.push(register); },
    registerService() {}, registerGatewayMethod() {},
    registerMemoryCapability(capability: { runtime: QmdMemoryRuntime }) { runtime = capability.runtime; },
    registerTool(factory: (ctx: OpenClawPluginToolContext) => Tool | null, options: { names: string[] }) {
      for (const name of options.names) tools.set(name, factory);
    },
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  } as unknown as OpenClawPluginApi;
  registerUnblockMemory(api);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const handler of hooks.get("gateway_stop") ?? []) await handler({}, {});
  };
  t.after(async () => {
    await stop();
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  });
  const prompt = async (event: unknown, context: unknown) => {
    const handlers = hooks.get("before_prompt_build") ?? [];
    assert.equal(handlers.length, 1, "one composed whisperer contribution");
    return await handlers[0]!(event, context) as { appendContext: string } | undefined;
  };
  const cli = async (...argv: string[]) => {
    const program = new FakeCommand();
    for (const register of clis) register({ program, config: cfg });
    const [name, ...rest] = argv;
    const command = program.commands.get("memory-steward")!.commands.get(name!)!;
    const opts: Record<string, unknown> = { ...command.defaults };
    for (let i = 0; i < rest.length; i += 2) opts[cliKey(rest[i]!)] = rest[i + 1];
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => { lines.push(String(line)); };
    try { await command.handler!(opts); } finally { console.log = log; }
    return JSON.parse(lines.join("\n")) as Record<string, unknown>;
  };
  return { runtime: runtime!, prompt, tools, cli, stop, dbPath: runtime!.memoryDatabasePath("bill") };
}

const CHANNEL_SESSION = "agent:bill:slack:channel:c0launch";
/** A host-shaped `before_prompt_build` context for a Slack channel turn (see buildAgentHookContextChannelFields). */
const channelTurn = (runId: string, senderId = "U-bob") => ({
  trigger: "user", agentId: "bill", sessionKey: CHANNEL_SESSION, sessionId: "s-launch", runId,
  messageProvider: "slack", channel: "slack", accountId: "workspace", chatId: "c0launch", channelId: "c0launch", senderId,
});

test("integration: a Captain's Log [BLOCKED] entry is ingested by the Expectations pass and whispered on a matching turn", async t => {
  const plugin = await integrationPlugin(t, { decisionModel: { enabled: false } });
  // The WorkStore opens (and marks) the plugin memory database, exactly as the Steward tick does.
  const store = new WorkStore(plugin.dbPath);
  try {
    store.db.exec(`CREATE TABLE captains_log_entries (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, day TEXT NOT NULL, captured_at_ms INTEGER NOT NULL, section_hash TEXT NOT NULL,
      ordinal INTEGER NOT NULL, topic TEXT NOT NULL, summary TEXT NOT NULL, blocked INTEGER NOT NULL CHECK(blocked IN (0, 1)),
      resolved_at_ms INTEGER, resolution_note TEXT, channels_json TEXT NOT NULL CHECK(json_valid(channels_json)),
      session_refs_json TEXT NOT NULL CHECK(json_valid(session_refs_json))) STRICT`);
    store.db.prepare("INSERT INTO captains_log_entries VALUES ('cl-1', 'bill', '2026-11-27', ?, 'h', 0, 'Shopify API quota', ?, 1, NULL, NULL, ?, '[]')")
      .run(Date.now() - 60_000, "Acme catalog sync is blocked on the Shopify API quota", JSON.stringify(["#c0launch"]));

    const turn = { prompt: "Any update on the Acme sync?", messages: [] };
    assert.equal(await plugin.prompt(turn, channelTurn("before-pass")), undefined, "nothing is whispered before ingestion");
    // No runner: deterministic ingestion only, zero model cost.
    const pass = await runExpectationsPass({ agentId: "bill", workStore: store, owner: "integration" });
    assert.equal(pass.status, "deterministic_only", JSON.stringify(pass));
    assert.equal(pass.deterministic?.captainsLog.upserted, 1);
  } finally { store.close(); }

  const turn = { prompt: "Any update on the Acme sync?", messages: [] };
  const result = await plugin.prompt(turn, channelTurn("after-pass"));
  const block = result?.appendContext.match(/^<unblock_memory>\n<expectations>\n[^\n]+\n\[([^]*)\]\n<\/expectations>\n<\/unblock_memory>$/u);
  assert.ok(block, result?.appendContext);
  const [hint] = JSON.parse(`[${block[1]}]`) as Record<string, unknown>[];
  assert.equal(hint!.kind, "blocker");
  assert.equal(hint!.summary, "Shopify API quota");
  assert.equal(hint!.expectedState, "Acme catalog sync is blocked on the Shopify API quota");
  assert.deepEqual(hint!.matchedBy, ["channel_match", "active_blocker"]);
  // Workspace blockers are shared by design: a DM turn sees them too, but only as an active blocker (no channel match).
  const dm = await plugin.prompt(turn, { trigger: "user", agentId: "bill", sessionKey: "agent:bill:slack:direct:u-bob",
    sessionId: "s-dm", runId: "dm-1", messageProvider: "slack", accountId: "workspace", senderId: "U-bob" });
  assert.match(dm?.appendContext ?? "", /"matchedBy":\["active_blocker"\]/u);

  const listed = await plugin.cli("expectations", "--agent", "bill");
  assert.equal((listed.summary as { byStatus: { open: number } }).byStatus.open, 1);
  assert.deepEqual((listed.expectations as { sourceKind: string }[]).map(item => item.sourceKind), ["captains_log"]);
});

test("integration: a saved deep_thought synthesis is whispered by the Memory Whisperer until its QMD generation advances", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ model: "liquid/d1.2-ultra-20261116", answers: {} }));
  const plugin = await integrationPlugin(t, {
    corpora: [{ name: "memory", kind: "files", paths: ["MEMORY.md"] }],
    decisionModel: { apiKey: "fake-secret", timeoutMs: 1000 },
    memoryWhisperer: { enabled: true, corpora: ["memory"], recipeHash: "mem-b" },
    expectationsWhisperer: { enabled: false },
  });
  let generation = 3;
  Object.defineProperty(plugin.runtime, "getMemorySearchManager", {
    value: async () => ({ manager: {
      async searchCandidates() { return []; },
      async getCollectionGenerations() { return { "memory-collection": generation }; },
    } }),
  });
  // Saved under the key deep_thought derives from a host-shaped TOOL context in this channel (see deep-thought.ts):
  // the tool sees the native-case channel id and the asker; the hook below sees neither.
  const toolIdentity = { agentId: "bill", sessionKey: CHANNEL_SESSION, provider: "slack", accountId: "workspace", senderId: "U-alice" };
  const store = new DeepThoughtStore(plugin.dbPath);
  const saved = store.saveDerivedObservation({ agentId: "bill", question: "Who owns the Acme launch checklist?",
    audienceKey: deepThoughtAudienceKey(toolIdentity)!, corpora: ["memory"], collectionGenerations: { "memory-collection": 3 },
    answer: "Mira owns the Acme launch checklist.", confidence: "high", citations: [{ source: "qmd://memory/launch.md", quote: "Mira" }] });
  store.close();

  const turn = { prompt: "Remind me who owns the Acme launch checklist?", messages: [] };
  const result = await plugin.prompt(turn, channelTurn("dt-1"));
  const payload = result?.appendContext.match(/^<unblock_memory>\n<memory>\n([^]*)\n<\/memory>\n<\/unblock_memory>$/u)?.[1];
  assert.ok(payload, result?.appendContext);
  const entries = JSON.parse(payload) as Record<string, unknown>[];
  assert.deepEqual(entries.map(entry => [entry.source, entry.answer]),
    [[`derived_observation:${saved.id}`, "Mira owns the Acme launch checklist."]]);

  // A DM session for the same account never sees the channel's synthesis.
  assert.equal(await plugin.prompt(turn, { ...channelTurn("dt-dm"), sessionKey: "agent:bill:main", sessionId: "s-main",
    chatId: "user:u-bob", channelId: "user:u-bob" }), undefined);
  // The instant the searched collection advances, the synthesis is retired (fresh session: no cooldown in play).
  generation = 4;
  assert.equal(await plugin.prompt(turn, { ...channelTurn("dt-2"), sessionId: "s-launch-2" }), undefined);
  assert.ok(fetch.mock.calls.every(call => String(call.arguments[0]).startsWith("https://codex.unblocklabs.ai/")),
    "only the (mocked) decision endpoint is called: derived matching itself is local");
});

test("integration: recipeHash stamped on memory_search and skill exposures flows into memory-steward outcomes byRecipe", async t => {
  const plugin = await integrationPlugin(t, {
    corpora: [{ name: "memory", kind: "files", paths: ["MEMORY.md"] }, { name: "skills", kind: "skills", paths: ["skills/**/SKILL.md"] }],
    decisionModel: { enabled: false },
    recallLedger: { enabled: true },
    memoryWhisperer: { recipeHash: " mem-b " },
    skillWhisperer: { recipeHash: "skill-b", minScore: 0.1 },
    expectationsWhisperer: { enabled: false },
  });
  const skill = { name: "deploy", description: "Use deploy for release workflows.", path: "/skills/deploy/SKILL.md" };
  Object.defineProperty(plugin.runtime, "getMemorySearchManager", {
    value: async () => ({ manager: {
      async searchCandidates() {
        return [{ path: "qmd://memory/release.md", startLine: 1, endLine: 2, score: 0.4, snippet: "Release steps", source: "memory",
          corpus: "memory", citation: "memory/release.md#L1-L2" }];
      },
      async searchSkills() { return [{ ...skill, score: 0.9 }]; },
      async listSkills() { return [skill]; },
    } }),
  });
  Object.defineProperty(plugin.runtime, "resolveSkillPath", { value: (_params: unknown, path: string) => path });

  const context = { agentId: "bill", config: {}, sessionKey: "agent:bill:main", sessionId: "s-1", runId: "run-1" } as OpenClawPluginToolContext;
  const search = parseJsonResult(await plugin.tools.get("memory_search")!(context)!.execute("call-1",
    { bm25Query: "release", vectorQuery: "How do we release?" }));
  assert.equal((search.results as unknown[]).length, 1);
  const whispered = await plugin.prompt({ prompt: "Deploy this release", messages: [] },
    { trigger: "user", agentId: "bill", sessionKey: "agent:bill:main", sessionId: "s-1", runId: "run-2" });
  assert.match(whispered?.appendContext ?? "", /name="deploy"/u);
  await plugin.stop(); // Flushes the recall-ledger writer.

  const db = new DatabaseSync(plugin.dbPath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT source, recipe_hash FROM recall_queries").all().map(row => ({ ...row })),
      [{ source: "tool", recipe_hash: "mem-b" }]);
    assert.equal(db.prepare("SELECT chat_type FROM recall_queries WHERE source='tool'").get()?.chat_type, "direct",
      "toolOrigin infers the untyped main DM session agent:<id>:main as direct");
    assert.deepEqual(db.prepare("SELECT recipe_hash FROM skill_routing_events").all().map(row => row.recipe_hash), ["skill-b"]);
  } finally { db.close(); }

  const store = new WorkStore(plugin.dbPath);
  try {
    const pass = await runOutcomeLedgerPass({ agentId: "bill", owner: "integration", workStore: store, now: () => Date.now() + 3_600_000 });
    assert.equal(pass.status, "ok", JSON.stringify(pass));
  } finally { store.close(); }
  const outcomes = await plugin.cli("outcomes", "--agent", "bill");
  assert.deepEqual(Object.keys(outcomes.byRecipe as object).sort(), ["mem-b", "skill-b"]);
  assert.equal((await plugin.cli("outcomes", "--agent", "bill", "--recipe", "skill-b")).totalOutcomes, 1);
});

/* ───────────── Pillar 1 integration: Brightness A/B recipes and Memory Crystals ───────────── */

type JudgeBody = { state?: [{ candidates: [{ excerpt: string }] }] };
/** Decision endpoint stand-in: each candidate's usefulness by excerpt. */
function judgeByExcerpt(t: TestContext, usefulness: (excerpt: string) => number) {
  return t.mock.method(globalThis, "fetch", async (...[, init]: Parameters<typeof fetch>) => {
    const excerpt = (JSON.parse(String(init?.body)) as JudgeBody).state?.[0].candidates[0].excerpt ?? "";
    return Response.json({ model: "liquid/d1.2-ultra-20261116", answers: { memory_0: { type: "noul", noul: usefulness(excerpt) } } });
  });
}
const memoryEntries = (result: { appendContext: string } | undefined) => {
  const payload = result?.appendContext.match(/^<unblock_memory>\n<memory>\n([^]*)\n<\/memory>\n<\/unblock_memory>$/u)?.[1];
  assert.ok(payload, result?.appendContext);
  return JSON.parse(payload) as Record<string, unknown>[];
};

test("integration: brightness outcome_v1 re-orders live Memory Whisperer finalists and stamps brightness:outcome_v1 on recall_queries", async t => {
  judgeByExcerpt(t, excerpt => excerpt.startsWith("Alpha") ? 0.92 : 0.9);
  const plugin = await integrationPlugin(t, {
    corpora: [{ name: "memory", kind: "files", paths: ["MEMORY.md"] }],
    decisionModel: { apiKey: "fake-secret", timeoutMs: 1000 },
    recallLedger: { enabled: true },
    // One-line A/B arm flip: no recipeHash set, so the recipe labels its own exposures.
    memoryWhisperer: { enabled: true, corpora: ["memory"], mode: "legacy", api: { endpoint: "" }, brightness: { recipe: "outcome_v1" } },
    expectationsWhisperer: { enabled: false },
  });
  const alpha = "qmd://memory/alpha.md", beta = "qmd://memory/beta.md";
  Object.defineProperty(plugin.runtime, "getMemorySearchManager", {
    value: async () => ({ manager: {
      async searchCandidates() {
        return [
          { path: alpha, startLine: 1, endLine: 2, score: 0.5, snippet: "Alpha: the release train leaves Tuesday", source: "memory",
            corpus: "memory", citation: "memory/alpha.md#L1-L2" },
          { path: beta, startLine: 1, endLine: 2, score: 0.4, snippet: "Beta: the release train moved to Thursday", source: "memory",
            corpus: "memory", citation: "memory/beta.md#L1-L2" },
        ];
      },
    } }),
  });
  // Outcome Ledger evidence: Beta helped recent turns, Alpha hurt one.
  const store = new WorkStore(plugin.dbPath);
  try {
    const ledger = new OutcomeLedgerStore(store.db);
    const insert = ledger.db.prepare(`INSERT INTO memory_outcomes
      (id,agent_id,subject_kind,subject_id,verdict,confidence,evidence_turn_id,signals_json,measured_at)
      VALUES (?,'bill','memory_hit',?,?,1,'turn','{}',?)`);
    insert.run("o-1", beta, "helped", Date.now() - 3_600_000);
    insert.run("o-2", beta, "helped", Date.now() - 7_200_000);
    insert.run("o-3", alpha, "hurt", Date.now() - 3_600_000);
  } finally { store.close(); }

  const result = await plugin.prompt({ prompt: "When does the release train leave?", messages: [] }, channelTurn("bright-1"));
  assert.deepEqual(memoryEntries(result).map(entry => entry.source), [beta, alpha],
    "Beta (usefulness 0.90, helped) now outranks Alpha (usefulness 0.92, hurt)");
  await plugin.stop(); // Flushes the recall-ledger writer.

  const db = new DatabaseSync(plugin.dbPath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT source, recipe_hash, outcome FROM recall_queries").all().map(row => ({ ...row })),
      [{ source: "whisperer", recipe_hash: "brightness:outcome_v1", outcome: "emitted" }]);
    assert.deepEqual(db.prepare("SELECT source_path, final_rank FROM recall_hits WHERE disposition='emitted' ORDER BY final_rank").all()
      .map(row => ({ ...row })), [{ source_path: beta, final_rank: 1 }, { source_path: alpha, final_rank: 2 }]);
  } finally { db.close(); }
});

test("integration: an active crystal is whispered on a matching turn, counts its hit, and never crosses corpora or audiences", async t => {
  const fetch = judgeByExcerpt(t, () => 0.95);
  const plugin = await integrationPlugin(t, {
    corpora: [{ name: "memory", kind: "files", paths: ["MEMORY.md"] }, { name: "knowledge", kind: "files", paths: ["KNOWLEDGE.md"] }],
    decisionModel: { apiKey: "fake-secret", timeoutMs: 1000 },
    memoryWhisperer: { enabled: true, corpora: ["memory"], mode: "legacy", api: { endpoint: "" }, crystalMaxHints: 0 },
    expectationsWhisperer: { enabled: false },
  });
  Object.defineProperty(plugin.runtime, "getMemorySearchManager", {
    value: async () => ({ manager: { async searchCandidates() { return []; } } }),
  });
  const channelAudience = deepThoughtAudienceKey({ agentId: "bill", sessionKey: CHANNEL_SESSION, provider: "slack", accountId: "workspace" })!;
  const otherAudience = deepThoughtAudienceKey({ agentId: "bill", sessionKey: "agent:bill:slack:channel:c0other", provider: "slack",
    accountId: "workspace" })!;
  const crystals = new MemoryCrystalsStore(plugin.dbPath);
  const member = (path: string, corpus = "memory") => ({ corpus, sourcePath: path, docHash: `doc-${path}`, chunkPos: 0, chunkLen: 40,
    quoteSha256: "a".repeat(64) });
  const put = (id: string, audienceKey: string, corpora: string[], extra: { tier?: "stm" | "ltm"; title?: string; summary?: string } = {}) =>
    crystals.upsertCrystal({ id, agentId: "bill", audienceKey, corpora, inputDigest: `digest-${id}`, tier: extra.tier ?? "stm",
      title: extra.title ?? "Acme launch checklist owner",
      summary: extra.summary ?? "Mira owns the Acme launch checklist and signs off QA before launch.",
      members: corpora.map(corpus => member(`qmd://${corpus}/launch.md`, corpus)) });
  try {
    put("c-workspace", "workspace", ["memory"], { tier: "ltm" });
    put("c-channel", channelAudience, ["memory"], { title: "Acme launch checklist in this channel" });
    put("c-knowledge", "workspace", ["memory", "knowledge"]); // draws on a corpus this whisperer may not read
    put("c-other-channel", otherAudience, ["memory"]); // another channel's audience
    put("c-retired", "workspace", ["memory"]);
    crystals.retireCrystal("c-retired", "bill");
    put("c-unrelated", "workspace", ["memory"], { title: "Office plants watering rota", summary: "Ferns are watered every Monday." });
  } finally { crystals.close(); }
  const hits = () => {
    const db = new DatabaseSync(plugin.dbPath, { readOnly: true });
    try {
      return Object.fromEntries(db.prepare("SELECT id, hit_count FROM memory_crystals ORDER BY id").all().map(row => [row.id, row.hit_count]));
    } finally { db.close(); }
  };
  const settleHits = () => new Promise(resolve => setImmediate(resolve));
  const turn = { prompt: "Who owns the Acme launch checklist?", messages: [] };

  const result = await plugin.prompt(turn, channelTurn("crystal-1"));
  const entries = memoryEntries(result);
  assert.deepEqual(entries.map(entry => entry.source), ["memory_crystal:c-workspace", "memory_crystal:c-channel"],
    "only this channel's and workspace crystals over allowed corpora, LTM first");
  assert.deepEqual(entries[0], { source: "memory_crystal:c-workspace", tier: "ltm", title: "Acme launch checklist owner",
    summary: "Mira owns the Acme launch checklist and signs off QA before launch.", revision: 1 });
  await settleHits();
  assert.deepEqual(hits(), { "c-channel": 1, "c-knowledge": 0, "c-other-channel": 0, "c-retired": 0, "c-unrelated": 0, "c-workspace": 1 });

  // Per-session cooldown: the same session does not see the same crystals again right away.
  assert.equal(await plugin.prompt(turn, channelTurn("crystal-2")), undefined);
  // A DM sees only the shared workspace crystal, never the channel's.
  const dm = await plugin.prompt(turn, { trigger: "user", agentId: "bill", sessionKey: "agent:bill:slack:direct:u-bob", sessionId: "s-dm",
    runId: "crystal-dm", messageProvider: "slack", accountId: "workspace", senderId: "U-bob" });
  assert.deepEqual(memoryEntries(dm).map(entry => entry.source), ["memory_crystal:c-workspace"]);
  await settleHits();
  assert.equal(hits()["c-workspace"], 2);
  assert.equal(hits()["c-channel"], 1);
  assert.equal(fetch.mock.callCount(), 0, "crystal matching is local: zero model calls");
});

test("integration: published \"extracted\" in memoryWhisperer.corpora whispers extracted facts, derived observations and crystals grounded in it", async t => {
  judgeByExcerpt(t, () => 0.95);
  const plugin = await integrationPlugin(t, {
    corpora: [{ name: "memory", kind: "files", paths: ["MEMORY.md"] }, { name: "sessions", kind: "sessions", chatTypes: ["channel"] }],
    extraction: { enabled: true, publish: true, chatTypes: ["channel"] },
    decisionModel: { apiKey: "fake-secret", timeoutMs: 1000 },
    memoryWhisperer: { enabled: true, corpora: ["memory", "extracted"], mode: "legacy", api: { endpoint: "" } },
    expectationsWhisperer: { enabled: false },
  });
  const searched: (readonly string[] | undefined)[] = [];
  const generationCalls: (readonly string[])[] = [];
  Object.defineProperty(plugin.runtime, "getMemorySearchManager", {
    value: async () => ({ manager: {
      async searchCandidates(_queries: unknown, options: { corpora?: readonly string[] }) {
        searched.push(options.corpora);
        return [{ path: "qmd://unblock-extracted/facts/acme.md", startLine: 1, endLine: 1, score: 0.4,
          snippet: "Extracted fact: Mira signs off the Acme launch checklist.", source: "memory", corpus: "extracted",
          citation: "extracted/facts/acme.md#L1-L1" }];
      },
      async getCollectionGenerations(corpora: readonly string[]) {
        generationCalls.push(corpora);
        return { "unblock-extracted": 5 };
      },
    } }),
  });
  const toolIdentity = { agentId: "bill", sessionKey: CHANNEL_SESSION, provider: "slack", accountId: "workspace", senderId: "U-alice" };
  const store = new DeepThoughtStore(plugin.dbPath);
  const saved = store.saveDerivedObservation({ agentId: "bill", question: "Who owns the Acme launch checklist?",
    audienceKey: deepThoughtAudienceKey(toolIdentity)!, corpora: ["extracted"], collectionGenerations: { "unblock-extracted": 5 },
    answer: "Mira owns the Acme launch checklist.", confidence: "high",
    citations: [{ source: "qmd://unblock-extracted/facts/acme.md", quote: "Mira" }] });
  store.close();
  const crystals = new MemoryCrystalsStore(plugin.dbPath);
  try {
    crystals.upsertCrystal({ id: "c-extracted", agentId: "bill", audienceKey: "workspace", corpora: ["extracted"], inputDigest: "d-x",
      tier: "stm", title: "Acme launch checklist owner", summary: "Mira owns the Acme launch checklist and signs off QA.",
      members: [{ corpus: "extracted", sourcePath: "qmd://unblock-extracted/facts/acme.md", docHash: "doc-x", chunkPos: 0, chunkLen: 40,
        quoteSha256: "a".repeat(64) }] });
  } finally { crystals.close(); }

  const entries = memoryEntries(await plugin.prompt({ prompt: "Who owns the Acme launch checklist?", messages: [] }, channelTurn("x-1")));
  assert.deepEqual(entries.map(entry => entry.source), [
    `derived_observation:${saved.id}`, "memory_crystal:c-extracted", "qmd://unblock-extracted/facts/acme.md",
  ], "a synthesis, a crystal and a raw fact all grounded in the published extracted corpus");
  assert.ok(searched.length > 0 && searched.every(corpora => corpora?.includes("extracted")), JSON.stringify(searched));
  assert.ok(generationCalls.some(corpora => corpora.includes("extracted")), "derived freshness is checked against extracted generations");
});
