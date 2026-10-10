import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@unblocklabs/qmd";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerUnblockMemory } from "../src/plugin.js";
import type { QmdMemoryRuntime } from "../src/runtime.js";
import { QmdMemoryManager } from "../src/manager.js";
import { resolveSource, resolveSessionSource } from "../src/sources.js";

test("explicit two-query search retrieves, scopes, deduplicates and judges real indexed evidence without generation or recall gating", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-search-e2e-"));
  const files = resolveSource(root, "*.md", "memory");
  const sessions = resolveSessionSource(join(root, "sessions"), ["channel", "direct"]);
  const qmd = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: Object.fromEntries(
    [files, sessions].map(source => [source.collection, { path: source.root, pattern: source.pattern }]),
  ) } });
  const docs = [
    { collection: files.collection, path: "keyword.md", text: "Exactneedle rollout was approved by Bek.", vector: [0, 1] },
    { collection: files.collection, path: "semantic.md", text: "The decision was to deploy only after review.", vector: [1, 0] },
    { collection: files.collection, path: "unrelated.md", text: "Exactneedle was mentioned in unrelated lunch planning.", vector: [0, 1] },
    { collection: sessions.collection, path: "channel.md", text: "Exactneedle channel discussion records the rollout approval.", vector: [1, 0] },
    { collection: sessions.collection, path: "direct.md", text: "Exactneedle secret direct-message content must not be sent.", vector: [1, 0] },
  ];
  qmd.internal.ensureVecTable(2);
  const model = qmd.internal.llm!.embedModelName;
  for (const [index, doc] of docs.entries()) {
    const hash = `search-e2e-${index}`;
    qmd.internal.insertContent(hash, doc.text, "2026-10-10");
    qmd.internal.insertDocument(doc.collection, doc.path, "Evidence", hash, "2026-10-10", "2026-10-10");
    qmd.internal.insertEmbedding(hash, 0, 0, new Float32Array(doc.vector), model, "2026-10-10", 1, undefined, doc.text.length);
  }
  const embeddings: string[] = [];
  t.mock.method(qmd.internal.llm!, "embed", async (query: string) => {
    embeddings.push(query);
    return { embedding: [1, 0], model };
  });
  const manifestPath = join(root, "sessions-manifest.json");
  await writeFile(manifestPath, JSON.stringify({ version: 1, sessions: Object.fromEntries(["channel", "direct"].map(chatType =>
    [chatType, { sessionId: chatType, provider: "slack", chatType, startedAt: 0, documentPath: `${chatType}.md` }])) }));
  const manager = new QmdMemoryManager({ dbPath: qmd.dbPath, workspaceDir: root, sources: [files, sessions],
    storeFactory: async () => qmd, sessions: { agentId: "bill", agentName: "Bill", chatTypes: ["channel", "direct"],
      collection: sessions.collection, databasePath: join(root, "unused.sqlite"), manifestPath,
      outputDir: sessions.root, timezone: "UTC", maxExpandedTokens: 500 } });
  t.after(() => manager.close());
  type Tool = { execute(id: string, input: unknown, signal?: AbortSignal): Promise<unknown> };
  let factory: ((context: OpenClawPluginToolContext) => Tool | null) | undefined;
  let diagnosticsFactory: typeof factory;
  const api = {
    pluginConfig: { typesafe: { enabled: true, apiKey: "test-key" } },
    registerCli() {}, registerGatewayMethod() {},
    registerMemoryCapability({ runtime }: { runtime: QmdMemoryRuntime }) {
      Object.defineProperty(runtime, "getMemorySearchManager", { value: async () => ({ manager }) });
    },
    registerTool(candidate: typeof factory, options: { names: string[] }) {
      if (options.names.includes("memory_search")) factory = candidate;
      if (options.names.includes("memory_diagnostics")) diagnosticsFactory = candidate;
    },
  } as unknown as OpenClawPluginApi;
  registerUnblockMemory(api);
  const context = { agentId: "search-e2e", config: {} } as OpenClawPluginToolContext;
  const tool = factory!(context)!;
  const diagnostics = diagnosticsFactory!(context)!;
  const judged: string[] = [];
  let fail = false;
  t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone", "no query generation service");
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(request.questions), ["memory_0"], "no recall gate");
    assert.deepEqual(request.state.conversation, { history: [], currentRequest: "Who approved the rollout and under what conditions?" });
    assert.equal(request.state.candidates.length, 1);
    const path: string = request.state.candidates[0].sourcePath;
    assert.ok(!path.endsWith("direct.md"), "session filter applies before external judging");
    judged.push(path);
    if (fail || path.endsWith("channel.md")) return new Response(null, { status: 529 });
    const noul = path.endsWith("semantic.md") ? 0.956 : path.endsWith("keyword.md") ? 0.854 : 0.1;
    return Response.json({ model: "jev-1.13.0", answers: { memory_0: { type: "noul", noul } } });
  });
  const input = { bm25Query: "Exactneedle", vectorQuery: "Who approved the rollout and under what conditions?",
    corpora: ["memory", "sessions"], sessionFilter: { chatType: "channel" }, maxResults: 2 };
  const result = await tool.execute("search", input) as { details: { results: { path: string; score: number; snippet: string }[]; warning: string } };
  assert.deepEqual(result.details.results.map(hit => [hit.path.split("/").at(-1), hit.score]), [["semantic.md", 0.96], ["keyword.md", 0.85]]);
  assert.equal(result.details.results[0]!.snippet, docs[1]!.text);
  assert.equal(new Set(judged).size, judged.length, "each deduplicated passage is judged once");
  assert.equal(judged.length, 4, "both lanes contribute while the DM is excluded");
  assert.equal(embeddings.length, 1);
  assert.ok(embeddings[0]!.endsWith(input.vectorQuery));
  assert.match(result.details.warning, /partial/);
  fail = true;
  const failed = await tool.execute("failed", { ...input, minUsefulness: 0 }) as { details: { results: unknown[]; error: string } };
  assert.deepEqual(failed.details.results, []);
  assert.match(failed.details.error, /judgments failed/);
  const snapshot = await diagnostics.execute("diagnostics", {}) as { details: {
    whisperers: { telemetry: { operations: Record<string, {
      calls: number; outcomes: Record<string, number>;
      measurements: Record<string, { samples: number; total: number }>;
    }> } };
  } };
  const operations = snapshot.details.whisperers.telemetry.operations;
  assert.equal(operations.memorySearch?.calls, 2);
  assert.equal(operations.memorySearch!.outcomes.partial, 1);
  assert.equal(operations.memorySearch!.outcomes.failed, 1);
  assert.equal(operations.memorySearch!.measurements.elapsedMs!.samples, 2);
  assert.equal(operations.memorySearch!.measurements.results!.total, 2);
  assert.equal(operations.memorySearch!.measurements.retrievalMs!.samples, 2);
  assert.equal(operations.memorySearch!.measurements.judgeMs!.samples, 2);
  assert.equal(operations.memoryWhisperer, undefined, "manual search must not count as automatic recall");
  assert.ok(!JSON.stringify(operations).includes("Exactneedle"), "telemetry contains no query or evidence text");
  const calls = judged.length;
  await assert.rejects(tool.execute("legacy", { query: "Exactneedle" }));
  await assert.rejects(tool.execute("too-large", { ...input, vectorQuery: "x".repeat(24_001) }), /context budget/);
  await assert.rejects(tool.execute("cancelled", input, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(judged.length, calls, "invalid input never reaches TypeSafe");
  const finalSnapshot = await diagnostics.execute("diagnostics", {}) as typeof snapshot;
  const finalOperations = finalSnapshot.details.whisperers.telemetry.operations;
  assert.equal(finalOperations.memorySearch!.calls, 5, "one observation per tool invocation, even on early failures");
  assert.deepEqual(finalOperations.memorySearch!.outcomes, { partial: 1, failed: 2, skipped: 1, cancelled: 1 });
  assert.equal(finalOperations.memorySearch!.measurements.elapsedMs!.samples, 5);
});
