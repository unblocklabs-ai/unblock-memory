import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { OpenClawConfig, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { CorpusMemorySearchResult, MemoryReadResult } from "../src/contracts.js";
import {
  activeDeepThoughts,
  createDeepThoughtTool,
  DEEP_THOUGHT_RESULT_SCHEMA,
  type DeepThoughtConfig,
  type DeepThoughtDeps,
  type DeepThoughtOutcome,
  type DeepThoughtResult,
  type DeepThoughtRuntime,
} from "../src/deep-thought.js";
import { resolveStewardConfig } from "../src/steward-config.js";
import { createStewardRunner, type StewardRunner, type StewardRunRequest, type StewardRunResult, type StewardUsage } from "../src/steward-runner.js";
import type { QmdMemoryRuntime } from "../src/runtime.js";
import { PeopleStores, type PersonDossier } from "../src/people-store.js";

// Compile-time proof the real runtime satisfies the curator's structural contract.
const _runtimeCompat: (runtime: QmdMemoryRuntime) => DeepThoughtRuntime = runtime => runtime;
void _runtimeCompat;

const CONFIG: DeepThoughtConfig = { enabled: true, maxTurns: 6, maxToolCalls: 16, timeoutMs: 5_000, maxConcurrent: 2 };
const DECISION = { enabled: true, endpoint: "https://decisions.invalid/v1", model: "test", timeoutMs: 50 };

const hit = (name: string, corpus = "memory"): CorpusMemorySearchResult => ({
  path: `qmd://${corpus}/${name}.md`, startLine: 1, endLine: 4, snippet: `Evidence for ${name}: the launch moved to Friday.`,
  source: "memory", corpus, score: 0.03, vectorScore: 0.03, textScore: 4.2,
});

type Recorded = {
  managerParams: unknown[];
  searches: { corpora?: readonly string[]; requestContext?: unknown }[];
  reads: { relPath: string; requestContext?: unknown }[];
};

function fakeRuntime(hits: CorpusMemorySearchResult[] = [hit("launch"), hit("retro")]) {
  const recorded: Recorded = { managerParams: [], searches: [], reads: [] };
  const runtime: DeepThoughtRuntime = {
    searchableCorpora: () => ["memory", "sessions"],
    async getMemorySearchManager(params) {
      recorded.managerParams.push(params);
      return {
        manager: {
          async searchCandidates(_queries, options) {
            recorded.searches.push({ corpora: options.corpora, requestContext: options.requestContext });
            return hits.filter(h => !options.corpora || options.corpora.includes(h.corpus));
          },
          async readFile(params): Promise<MemoryReadResult> {
            recorded.reads.push({ relPath: params.relPath, requestContext: params.requestContext });
            return { status: "ok", path: params.relPath, text: `Body of ${params.relPath}\nLaunch moved to Friday (2026-11-20).`, from: 1, lines: 2 };
          },
        },
      };
    },
  };
  return { runtime, recorded };
}

type RunRunner = Pick<StewardRunner, "run">;
type ScriptStep =
  | { call: string; args: Record<string, unknown> }[]
  | { submit: (outputs: unknown[]) => DeepThoughtResult; status?: "complete" | "incomplete" | "needs_decision" };

const budgetExhausted = <T>(turns: number, toolCalls: number, usage: StewardUsage): StewardRunResult<T> =>
  ({ ok: false, code: "budget_exhausted", error: "Exceeded maxTurns", retryable: false, usage, turns, toolCalls });

/** Mimics StewardRunner.run: validates args against each tool schema, enforces turn budget, honors abort. */
function scriptedRunner(script: ScriptStep[]) {
  const requests: StewardRunRequest<DeepThoughtResult>[] = [];
  const toolNames: string[][] = [];
  const runner: RunRunner = {
    async run<T>(request: StewardRunRequest<T>): Promise<StewardRunResult<T>> {
      requests.push(request as StewardRunRequest<never>);
      toolNames.push(request.tools.map(tool => tool.name));
      const outputs: unknown[] = [];
      let turns = 0, toolCalls = 0;
      for (const step of script) {
        request.signal?.throwIfAborted();
        if (turns >= request.maxTurns) {
          return budgetExhausted(turns, toolCalls, { requests: turns, inputTokens: 10 * turns, outputTokens: 5 * turns });
        }
        turns += 1;
        if (Array.isArray(step)) {
          for (const { call, args } of step) {
            const tool = request.tools.find(t => t.name === call);
            if (!tool) { outputs.push({ error: `unknown tool ${call}` }); continue; }
            assert.ok(Value.Check(tool.parameters, args), `runner validates ${call} args`);
            toolCalls += 1;
            outputs.push(await tool.execute(args, request.signal!));
          }
          continue;
        }
        const result = step.submit(outputs);
        assert.ok(Value.Check(request.submitSchema, result), "submit matches caller schema");
        return { ok: true, status: step.status ?? "complete", data: result as T, summary: result.answer, turns, toolCalls,
          usage: { requests: turns, inputTokens: 100 * turns, outputTokens: 20 * turns } };
      }
      return budgetExhausted(turns, toolCalls, { requests: turns });
    },
  };
  return { runner, requests, toolNames };
}

function toolContext(overrides: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext {
  return {
    config: {} as OpenClawConfig,
    agentId: "main",
    sessionKey: "agent:main:slack:direct:u1",
    sessionId: "session-1",
    messageChannel: "slack",
    agentAccountId: "acct-a",
    runId: "run-1",
    ...overrides,
  } as OpenClawPluginToolContext;
}

function deps(runtime: DeepThoughtRuntime, runner: RunRunner, extra: Partial<DeepThoughtDeps> = {}): DeepThoughtDeps {
  return { runtime, runner, config: CONFIG, decisionModel: DECISION, resolveCredential: async () => undefined, ...extra };
}

async function execute(tool: ReturnType<typeof createDeepThoughtTool>, params: unknown, signal?: AbortSignal): Promise<DeepThoughtOutcome> {
  assert.ok(tool, "tool is registered");
  const result = await tool.execute("call-1", params, signal);
  return result.details as DeepThoughtOutcome;
}

const DOSSIER: PersonDossier = {
  schemaVersion: 1, blurb: "Mira leads launch planning at ExampleCo.", sections: [
    { category: "preferences", claims: [{ statement: "Give the recommendation first.", scope: "Status updates", reviewedAt: "2026-11-16T12:00:00Z",
      epistemicType: "reported", evidence: [{ source: "manual", locator: "Slack acct-a/U1 message 1" }] }] },
  ],
};

function peopleFixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), "deep-thought-people-"));
  const stores = new PeopleStores({ stateRoot, maxOpenTodos: 10, maxBlurbChars: 1200 });
  const store = stores.get("main");
  const mira = store.upsertIdentity({ provider: "slack", accountScope: "acct-a", externalId: "U1", displayName: "Mira" }).person;
  store.replaceVerifiedDossier(mira.id, "Verified from Slack", DOSSIER, "Checked against Slack acct-a");
  // Same name, different account: must never be visible to an acct-a caller.
  const otherMira = store.upsertIdentity({ provider: "slack", accountScope: "acct-b", externalId: "U9", displayName: "Mira Other" }).person;
  store.replaceVerifiedDossier(otherMira.id, "Verified elsewhere", { ...DOSSIER, blurb: "Mira Other runs a different company." }, "acct-b check");
  return { stores, mira, otherMira, cleanup: () => { stores.closeAll(); rmSync(stateRoot, { recursive: true, force: true }); } };
}

test("multi-hop investigation: search_memory → read_memory → lookup_person → submit_result yields verified citations", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("no network in tests"); });
  const people = peopleFixture();
  t.after(people.cleanup);
  const { runtime, recorded } = fakeRuntime();
  const { runner, requests, toolNames } = scriptedRunner([
    [{ call: "search_memory", args: { bm25Query: "launch Friday", vectorQuery: "When did the launch move and who decided?" } }],
    [{ call: "read_memory", args: { path: "qmd://memory/launch.md", lines: 20 } }],
    [{ call: "lookup_person", args: { query: "mira" } }],
    { submit: outputs => {
      const search = outputs[0] as { results: { path: string }[] };
      assert.equal(search.results.length, 2, "search output is visible to the curator");
      const person = outputs[2] as { matches: { source: string; dossier: unknown }[] };
      assert.equal(person.matches.length, 1, "only the caller-account Mira is visible");
      return {
        answer: "The launch moved to Friday; Mira (launch lead) prefers the recommendation first.",
        confidence: "high",
        citations: [
          { source: "qmd://memory/launch.md#L1-L2", lines: "1-2", quote: "Launch moved to Friday" },
          { source: person.matches[0]!.source, quote: "Mira leads launch planning at ExampleCo." },
        ],
        openQuestions: ["Was the retro scheduled?"],
      };
    } },
  ]);
  const tool = createDeepThoughtTool(toolContext(), deps(runtime, runner, { people: { enabled: true, stores: people.stores } }));
  const outcome = await execute(tool, { question: "When did the launch move, and how should I brief Mira?", focus: "dates", maxHops: 8 });

  assert.equal(outcome.status, "complete");
  assert.equal(outcome.confidence, "high");
  assert.equal(outcome.citations.length, 2);
  assert.equal(outcome.citations[1]!.source, `person:${people.mira.id}`);
  assert.equal(outcome.unverifiedCitationsDropped, undefined);
  assert.equal(outcome.hopsUsed, 4);
  assert.equal(outcome.toolCallsUsed, 3);
  assert.deepEqual(outcome.openQuestions, ["Was the retro scheduled?"]);
  assert.deepEqual(outcome.usage, { requests: 4, inputTokens: 400, outputTokens: 80 });
  assert.deepEqual(outcome.corpora, ["memory", "sessions"]);
  assert.deepEqual(toolNames[0], ["search_memory", "read_memory", "lookup_person"], "zero write/bash tools; submit is runner-owned");
  assert.equal(requests[0]!.maxTurns, CONFIG.maxTurns, "maxHops is clamped by config.maxTurns");
  assert.equal(requests[0]!.maxToolCalls, CONFIG.maxToolCalls);
  assert.equal(requests[0]!.submitSchema, DEEP_THOUGHT_RESULT_SCHEMA);
  assert.match(requests[0]!.userPrompt, /Focus: dates/u);

  // Caller scope forwarded verbatim to every memory call.
  const managerActive = recorded.managerParams[0] as { agentId: string; requestContext: unknown };
  assert.equal(managerActive.agentId, "main");
  assert.equal(recorded.searches[0]!.requestContext, managerActive.requestContext);
  assert.equal(recorded.reads[0]!.requestContext, managerActive.requestContext);
  assert.deepEqual(managerActive.requestContext, {
    sessionKey: "agent:main:slack:direct:u1", sessionId: "session-1", messageChannel: "slack",
    agentAccountId: "acct-a", nativeChannelId: undefined, deliveryContext: undefined,
  });
  assert.equal(activeDeepThoughts(), 0);
});

test("hallucinated and unvisited citation paths are stripped and counted", async () => {
  const { runtime } = fakeRuntime();
  const { runner } = scriptedRunner([
    [{ call: "search_memory", args: { bm25Query: "launch", vectorQuery: "launch date" } }],
    { submit: () => ({
      answer: "Launch moved to Friday.",
      confidence: "high",
      citations: [
        { source: "qmd://memory/retro.md", quote: "surfaced by search" },
        { source: "qmd://memory/never-seen.md", quote: "invented" },
        { source: "/Users/someone/secret.md", quote: "raw path" },
        { source: "person:not-looked-up", quote: "invented person" },
      ],
    }) },
  ]);
  const outcome = await execute(createDeepThoughtTool(toolContext(), deps(runtime, runner)), { question: "launch date?" });
  assert.equal(outcome.status, "complete");
  assert.deepEqual(outcome.citations.map(c => c.source), ["qmd://memory/retro.md"]);
  assert.equal(outcome.unverifiedCitationsDropped, 3);

  const { runner: allBad } = scriptedRunner([{ submit: () => ({ answer: "Guess.", confidence: "high",
    citations: [{ source: "qmd://memory/never-seen.md", quote: "x" }] }) }]);
  const downgraded = await execute(createDeepThoughtTool(toolContext(), deps(runtime, allBad)), { question: "launch?" });
  assert.equal(downgraded.citations.length, 0);
  assert.equal(downgraded.unverifiedCitationsDropped, 1);
  assert.equal(downgraded.confidence, "low", "an answer whose every citation was fabricated cannot stay high-confidence");
});

test("caller corpus ACL: unknown/skill corpora are refused, narrowed corpora bound search and reads", async () => {
  const { runtime, recorded } = fakeRuntime([hit("launch"), hit("dm", "sessions")]);
  let ran = false;
  const refusing: RunRunner = { run: async () => { ran = true; throw new Error("must not run"); } };
  for (const corpora of [["skills"], ["secret-corpus"], ["all", "memory"]]) {
    const outcome = await execute(createDeepThoughtTool(toolContext(), deps(runtime, refusing)), { question: "q", corpora });
    assert.equal(outcome.status, "invalid_request", `refuses ${corpora.join(",")}`);
  }
  assert.equal(ran, false, "no model call for unapproved corpora");

  const { runner } = scriptedRunner([
    [
      { call: "search_memory", args: { bm25Query: "launch", vectorQuery: "launch", corpora: ["sessions"] } },
      { call: "search_memory", args: { bm25Query: "launch", vectorQuery: "launch" } },
      { call: "read_memory", args: { path: "qmd://sessions/dm.md" } },
      { call: "read_memory", args: { path: "qmd://memory/launch.md" } },
    ],
    { submit: outputs => {
      assert.equal((outputs[0] as { status: string }).status, "invalid_request", "inner search cannot widen corpora");
      assert.deepEqual((outputs[1] as { results: { path: string }[] }).results.map(r => r.path), ["qmd://memory/launch.md"]);
      assert.equal((outputs[2] as { status: string }).status, "not_found", "unsurfaced path outside narrowed corpora is not readable");
      return { answer: "ok", confidence: "medium", citations: [{ source: "qmd://memory/launch.md", quote: "Launch" },
        { source: "qmd://sessions/dm.md", quote: "leak" }] };
    } },
  ]);
  const outcome = await execute(createDeepThoughtTool(toolContext(), deps(runtime, runner)), { question: "q", corpora: ["memory"] });
  assert.equal(outcome.status, "complete");
  assert.deepEqual(outcome.corpora, ["memory"]);
  assert.deepEqual(recorded.searches.map(s => s.corpora), [["memory"]], "only the approved corpus reached the manager");
  assert.deepEqual(recorded.reads.map(r => r.relPath), ["qmd://memory/launch.md"], "refused read never reached the manager");
  assert.deepEqual(outcome.citations.map(c => c.source), ["qmd://memory/launch.md"]);
  assert.equal(outcome.unverifiedCitationsDropped, 1);
});

test("lookup_person is account-fenced and only registered with people enabled plus a caller account", async t => {
  const people = peopleFixture();
  t.after(people.cleanup);
  const { runtime } = fakeRuntime();
  const probe = () => scriptedRunner([{ submit: () => ({ answer: "n/a", confidence: "low", citations: [] }) }]);

  for (const [label, ctx, enabled] of [
    ["no account", toolContext({ agentAccountId: undefined }), true],
    ["no provider", toolContext({ messageChannel: undefined }), true],
    ["people disabled", toolContext(), false],
  ] as const) {
    const { runner, toolNames } = probe();
    await execute(createDeepThoughtTool(ctx, deps(runtime, runner, { people: { enabled, stores: people.stores } })), { question: "q" });
    assert.ok(!toolNames[0]!.includes("lookup_person"), `lookup_person absent: ${label}`);
  }

  const { runner } = scriptedRunner([
    [
      { call: "lookup_person", args: { query: "Mira Other" } },
      { call: "lookup_person", args: { query: people.otherMira.id } },
      { call: "lookup_person", args: { query: "U9" } },
      { call: "lookup_person", args: { query: "Mira" } },
    ],
    { submit: outputs => {
      for (const output of outputs.slice(0, 3)) assert.equal((output as { status: string }).status, "not_found", "cross-account person invisible");
      const found = outputs[3] as { matches: { source: string; identities: { externalId: string }[]; dossierStatus: string }[] };
      assert.deepEqual(found.matches.map(m => m.source), [`person:${people.mira.id}`]);
      assert.deepEqual(found.matches[0]!.identities.map(i => i.externalId), ["U1"], "only caller-account identities are returned");
      assert.equal(found.matches[0]!.dossierStatus, "verified");
      return { answer: "Mira leads launch planning.", confidence: "medium", citations: [
        { source: `person:${people.mira.id}`, quote: "Mira leads launch planning at ExampleCo." },
        { source: `person:${people.otherMira.id}`, quote: "cross-account" }] };
    } },
  ]);
  const outcome = await execute(createDeepThoughtTool(toolContext({ agentAccountId: "ACCT-A" }),
    deps(runtime, runner, { people: { enabled: true, stores: people.stores } })), { question: "Who is Mira?" });
  assert.deepEqual(outcome.citations.map(c => c.source), [`person:${people.mira.id}`]);
  assert.equal(outcome.unverifiedCitationsDropped, 1, "a person never surfaced to this caller cannot be cited");
});

test("concurrency cap returns busy without stampeding; slots are released", async () => {
  const { runtime } = fakeRuntime();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  const blocking: RunRunner = {
    async run<T>(): Promise<StewardRunResult<T>> {
      started += 1;
      await gate;
      return { ok: true, status: "complete", data: { answer: "done", confidence: "low", citations: [] } as T, summary: "done",
        turns: 1, toolCalls: 0, usage: { requests: 1 } };
    },
  };
  const make = () => createDeepThoughtTool(toolContext(), deps(runtime, blocking));
  const first = execute(make(), { question: "a" });
  const second = execute(make(), { question: "b" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(activeDeepThoughts(), 2);
  const third = await execute(make(), { question: "c" });
  assert.equal(third.status, "busy");
  assert.equal(started, 2, "busy call never reached the runner");
  release();
  assert.deepEqual((await Promise.all([first, second])).map(o => o.status), ["complete", "complete"]);
  assert.equal(activeDeepThoughts(), 0);
  assert.equal((await execute(make(), { question: "d" })).status, "complete", "capacity is restored");
});

test("wall timeout, caller abort, runner failure and turn budget all terminate cleanly", async () => {
  const { runtime } = fakeRuntime();
  // Like the real runner, an aborted run resolves with a failure (never rejects).
  const hanging: RunRunner = {
    run: request => new Promise(resolve => {
      request.signal!.addEventListener("abort", () => resolve({ ok: false, code: "aborted", error: "Steward aborted", retryable: false,
        usage: { requests: 1 }, turns: 1, toolCalls: 0 }), { once: true });
    }),
  };
  const timedOut = await execute(createDeepThoughtTool(toolContext(),
    deps(runtime, hanging, { config: { ...CONFIG, timeoutMs: 20 } })), { question: "slow" });
  assert.equal(timedOut.status, "timed_out");
  assert.equal(activeDeepThoughts(), 0);

  const controller = new AbortController();
  const pending = execute(createDeepThoughtTool(toolContext(), deps(runtime, hanging)), { question: "cancel me" }, controller.signal);
  setTimeout(() => controller.abort(), 5);
  assert.equal((await pending).status, "cancelled");
  assert.equal(activeDeepThoughts(), 0);

  const failWith = (code: "transient_provider" | "missing_credentials"): RunRunner => ({
    run: async () => ({ ok: false, code, error: code === "transient_provider" ? "Temporary provider failure" : "No usable Steward credential",
      retryable: code === "transient_provider", usage: { requests: 2, inputTokens: 50 }, turns: 2, toolCalls: 0 }),
  });
  const failed = await execute(createDeepThoughtTool(toolContext(), deps(runtime, failWith("transient_provider"))), { question: "q" });
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /Temporary provider failure/u);
  assert.equal(failed.hopsUsed, 2);
  assert.deepEqual(failed.usage, { requests: 2, inputTokens: 50 }, "failed attempts still report honest usage");
  const unavailable = await execute(createDeepThoughtTool(toolContext(), deps(runtime, failWith("missing_credentials"))), { question: "q" });
  assert.equal(unavailable.status, "unavailable", "no Steward credential is reported as unavailable, not a crash");

  const { runner, requests } = scriptedRunner([
    [{ call: "search_memory", args: { bm25Query: "a", vectorQuery: "a" } }],
    [{ call: "search_memory", args: { bm25Query: "b", vectorQuery: "b" } }],
    { submit: () => ({ answer: "late", confidence: "low", citations: [] }) },
  ]);
  const budget = await execute(createDeepThoughtTool(toolContext(), deps(runtime, runner)), { question: "q", maxHops: 1 });
  assert.equal(requests[0]!.maxTurns, 1, "maxHops narrows the turn budget");
  assert.equal(budget.status, "incomplete");
  assert.equal(budget.answer, undefined);
  assert.equal(budget.error, "Exceeded maxTurns");
  assert.equal(budget.toolCallsUsed, 1);
});

test("disabled config or missing agent context registers no tool; parameters are strict", () => {
  const { runtime } = fakeRuntime();
  const { runner } = scriptedRunner([]);
  assert.equal(createDeepThoughtTool(toolContext(), deps(runtime, runner, { config: { ...CONFIG, enabled: false } })), null);
  assert.equal(createDeepThoughtTool(toolContext({ agentId: undefined }), deps(runtime, runner)), null);
  assert.equal(createDeepThoughtTool(toolContext(), undefined), null);
  const tool = createDeepThoughtTool(toolContext(), deps(runtime, runner))!;
  assert.equal(tool.name, "deep_thought");
  assert.equal(tool.label, "Deep Thought");
  assert.match(tool.description, /memory_search/u);
  for (const bad of [{ question: "   " }, { question: "q", extra: 1 }, { question: "q", maxHops: 9 }, { question: "x".repeat(2001) }]) {
    assert.equal(Value.Check(tool.parameters, bad), false, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(Value.Check(tool.parameters, { question: "q", focus: "f", corpora: ["all"], maxHops: 8 }), true);
});

test("end-to-end through the real StewardRunner: tool calls, submit_result and usage cross the B2/B3 seam", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("no network in tests"); });
  const { runtime, recorded } = fakeRuntime();
  const call = (name: string, id: string, args: unknown) => ({ type: "function_call", status: "completed", call_id: id, name,
    arguments: JSON.stringify(args) });
  const replies = [
    { status: "completed", output: [call("search_memory", "c1", { bm25Query: "launch", vectorQuery: "When is the launch?" })],
      usage: { input_tokens: 100, output_tokens: 10 } },
    { status: "completed", output: [call("submit_result", "c2", { status: "complete", answer: "Friday.", confidence: "high",
      citations: [{ source: "qmd://memory/launch.md", quote: "the launch moved to Friday" }] })],
      usage: { input_tokens: 200, output_tokens: 20 } },
  ];
  const sent: { tools: { name: string }[]; input: { type?: string; call_id?: string; output?: string }[] }[] = [];
  const runner = createStewardRunner({
    config: resolveStewardConfig({ enabled: true, deepThought: { enabled: true } }),
    resolveApiKey: async () => "test-token",
    fetch: async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json(replies.shift()); },
  });
  const outcome = await execute(createDeepThoughtTool(toolContext(), deps(runtime, runner)), { question: "When is the launch?" });
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.answer, "Friday.");
  assert.deepEqual(outcome.citations.map(c => c.source), ["qmd://memory/launch.md"]);
  assert.equal(outcome.hopsUsed, 2);
  assert.equal(outcome.toolCallsUsed, 1);
  assert.deepEqual(outcome.usage, { requests: 2, inputTokens: 300, outputTokens: 30 });
  assert.deepEqual(sent[0]!.tools.map(tool => tool.name), ["search_memory", "read_memory", "submit_result"]);
  const toolOutput = sent[1]!.input.find(item => item.type === "function_call_output" && item.call_id === "c1");
  assert.match(toolOutput?.output ?? "", /qmd:\/\/memory\/launch\.md/u, "search results reached the model");
  assert.equal(recorded.searches.length, 1);
});
