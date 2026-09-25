// Recheck the final unpacked artifact against the completed isolated upgrade, without re-embedding.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const [plugin, snapshot, upgraded, keyFile, output] = process.argv.slice(2);
const imp = file => import(pathToFileURL(`${plugin}/dist/src/${file}.js`));
const { QmdMemoryManager } = await imp("manager");
const { resolveSources, resolveSessionSource } = await imp("sources");
const { resolveConfig } = await imp("config");
const { resolveTypeSafeApiKey } = await imp("typesafe-client");
const { registerMemoryWhisperer } = await imp("memory-whisperer");
const { WhispererDiagnostics } = await imp("diagnostics");
const report = JSON.parse(await readFile(`${upgraded}/results.json`, "utf8"));
const config = JSON.parse(await readFile(`${snapshot}/openclaw.json`, "utf8")).plugins.entries["unblock-memory"].config;
const sessionConfig = config.corpora.find(c => c.kind === "sessions");
const sessionSource = resolveSessionSource(`${snapshot}/agents/main/unblock-memory/sessions`, sessionConfig.chatTypes);
const stage = `${upgraded}/after`;
const manager = new QmdMemoryManager({ dbPath: `${stage}/index.sqlite`, curationPath: `${stage}/curation.sqlite`,
  workspaceDir: `${snapshot}/workspace`, keepModelsWarm: false,
  sources: [...resolveSources(`${snapshot}/workspace`, config.corpora.filter(c => c.kind === "files")),
    { ...sessionSource, root: `${stage}/sessions`, watchPath: `${stage}/sessions` }],
  sessions: { agentId: "main", agentName: "Bill", chatTypes: sessionConfig.chatTypes, maxExpandedTokens: 500,
    collection: sessionSource.collection, timezone: "America/New_York", databasePath: `${snapshot}/agents/main/agent/openclaw-agent.sqlite`,
    manifestPath: `${stage}/manifest.json`, outputDir: `${stage}/sessions` },
});
const result = { diagnostics: null, retrieval: [], hooks: [] };
try {
  result.diagnostics = await manager.diagnostics();
  assert.equal(result.diagnostics.needsEmbedding, 0);
  assert.equal(result.diagnostics.semanticChunkingVersion, 7);
  for (const [i, probe] of report.queries.entries()) {
    const hits = await manager.search(probe.query, { corpora: [probe.corpus], maxResults: 5, minScore: -1 });
    const hit = hits.find(hit => hit.path === probe.path);
    const read = hit ? await manager.readFile({ relPath: hit.path, from: hit.startLine, lines: hit.endLine - hit.startLine + 1 }) : undefined;
    const valid = read?.status === "ok" && read.text.includes(probe.query);
    result.retrieval.push({ corpus: probe.corpus, valid });
    if (report.before[i].citationValid) assert.ok(valid, "Final artifact retrieval regression");
  }
} finally { await manager.close(); }
const apiKey = await resolveTypeSafeApiKey({ enabled: true, apiKeyFile: keyFile, timeoutMs: 1500 });
assert.ok(apiKey);
const excerpts = ["Atlas staging rollout requires Ava's approval.", "Ava must approve before Atlas staging is rolled out.", "Atlas staging must use the EU region."];
// Keep production defaults unchanged. Explicit 0.8 cases isolate refinement from
// the conservative usefulness gate. Two duplicate-only candidates expose removal
// within the supported two-hint cap; the mixed case checks distinct evidence.
for (const test of [
  { name: "default-usefulness", excerpts, overrides: { complementaryHints: true } },
  { name: "explicit-threshold-baseline", excerpts: excerpts.slice(0, 2), overrides: { minUsefulness: 0.8 } },
  { name: "explicit-threshold-duplicates", excerpts: excerpts.slice(0, 2), overrides: { minUsefulness: 0.8, complementaryHints: true } },
  { name: "explicit-threshold-mixed", excerpts, overrides: { minUsefulness: 0.8, complementaryHints: true } },
]) {
const hooks = new Map();
const diagnostics = new WhispererDiagnostics();
const beforePrompt = registerMemoryWhisperer({ config: {}, logger: { info() {}, warn() {} }, on(name, handler) { hooks.set(name, handler); } },
  { async getMemorySearchManager() { return { manager: { async search() { return test.excerpts.map((snippet, i) => ({
    path: `qmd://synthetic/note-${i}.md`, corpus: "memory", snippet, startLine: 1, endLine: 1,
    citation: `qmd://synthetic/note-${i}.md#L1`, score: 0.9, source: "memory",
  })); } } }; } },
  resolveConfig({ memoryWhisperer: { enabled: true, corpora: ["memory"], ...test.overrides } }).memoryWhisperer,
  { enabled: true, apiKey, timeoutMs: 1500 }, diagnostics);
assert.ok(beforePrompt);
const start = performance.now();
const hint = await beforePrompt({ prompt: "Prepare an Atlas staging deployment plan. What constraints from past decisions do we need to honor?", messages: [] },
  { trigger: "user", agentId: "validation", sessionId: "synthetic", runId: "run" });
const hints = hint ? JSON.parse(hint.appendContext.split("\n")[1]) : [];
result.hooks.push({ name: test.name, syntheticRetrievalLiveTypeSafe: true, emitted: hints.length, milliseconds: Math.round(performance.now() - start),
  complementary: hints.some(h => h.body.includes("EU region")) && hints.filter(h => h.body.includes("Ava")).length === 1,
  diagnostics: diagnostics.snapshot("validation") });
hooks.get("gateway_stop")();
}
await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(result));
// Scores can vary around 0.9. Observe default yield instead of prescribing its
// count; deterministic tests cover threshold enforcement and safe rejection.
assert.ok(result.hooks[0].emitted <= 2);
for (const hook of result.hooks) {
  assert.ok(hook.milliseconds < 3000, "Live hook exceeded its configured budget");
  assert.ok(!hook.diagnostics.memory.failed && !hook.diagnostics.memory.timed_out &&
    !hook.diagnostics.memory.redundancy_unavailable, "Live hook failed or used optional-refinement fallback");
}
assert.equal(result.hooks[1].emitted, 2, "Baseline did not retain both useful paraphrases; inspect live scores");
assert.equal(result.hooks[2].emitted, 1, "Refinement did not remove exactly one paraphrase");
assert.equal(result.hooks[3].emitted, 2, "Mixed refinement did not retain two hints");
assert.ok(result.hooks[3].complementary, "Live hook did not preserve complementary evidence; inspect before enabling");
