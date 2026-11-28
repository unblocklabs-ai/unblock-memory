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
  cancelAllDeepThoughtJobs,
  createDeepThoughtTool,
  DEEP_THOUGHT_RESULT_SCHEMA,
  type DeepThoughtConfig,
  type DeepThoughtDeps,
  type DeepThoughtOutcome,
  type DeepThoughtResult,
  type DeepThoughtRuntime,
  runDeepThoughtInvestigation,
} from "../src/deep-thought.js";
import { resolveStewardConfig } from "../src/steward-config.js";
import { createStewardRunner, type StewardRunner, type StewardRunRequest, type StewardRunResult, type StewardUsage } from "../src/steward-runner.js";
import type { QmdMemoryRuntime } from "../src/runtime.js";
import { PeopleStores, type PersonDossier } from "../src/people-store.js";
import { DeepThoughtStore } from "../src/deep-thought-store.js";

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
        if (request.maxTurns > 0 && turns >= request.maxTurns) {
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
        { source: "qmd://memory/retro.md", quote: "The launch moved to   FRIDAY" },
        { source: "qmd://memory/launch.md", quote: "The board cancelled the launch indefinitely." },
        { source: "qmd://memory/never-seen.md", quote: "invented" },
        { source: "/Users/someone/secret.md", quote: "raw path" },
        { source: "person:not-looked-up", quote: "invented person" },
      ],
    }) },
  ]);
  const outcome = await execute(createDeepThoughtTool(toolContext(), deps(runtime, runner)), { question: "launch date?" });
  assert.equal(outcome.status, "complete");
  assert.deepEqual(outcome.citations.map(c => c.source), ["qmd://memory/retro.md"],
    "a quote is kept only when grounded (case/whitespace-insensitive) in the text its visited source returned");
  assert.equal(outcome.unverifiedCitationsDropped, 4, "a fabricated quote on a visited source is dropped too");

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
  for (const bad of [{ question: "   " }, { question: "q", extra: 1 }, { question: "q", maxHops: 0 }]) {
    assert.equal(Value.Check(tool.parameters, bad), false, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(Value.Check(tool.parameters, { question: "x".repeat(2500), focus: "f", corpora: ["all"], maxHops: 25 }), true);
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

test("quote grounding: verbatim or high token overlap with the cited source's own returned text; never another source's", async () => {
  const { runtime } = fakeRuntime([hit("launch"), { ...hit("budget"), snippet: "Budget review: Q3 spend is frozen until December." }]);
  const { runner } = scriptedRunner([
    [{ call: "search_memory", args: { bm25Query: "launch", vectorQuery: "launch" } },
      { call: "read_memory", args: { path: "qmd://memory/launch.md" } }],
    { submit: () => ({ answer: "Friday; spend frozen.", confidence: "high", citations: [
      { source: "qmd://memory/launch.md#L2", quote: "Launch moved to Friday (2026-11-20)." },
      { source: "qmd://memory/budget.md", quote: "Q3 spend is frozen until December" },
      { source: "qmd://memory/budget.md", quote: "spend frozen until December for Q3" },
      { source: "qmd://memory/budget.md", quote: "the launch moved to Friday" },
      { source: "qmd://memory/launch.md", quote: "" },
    ] }) },
  ]);
  const outcome = await execute(createDeepThoughtTool(toolContext(), deps(runtime, runner)), { question: "q" });
  assert.deepEqual(outcome.citations.map(c => c.quote), ["Launch moved to Friday (2026-11-20).", "Q3 spend is frozen until December",
    "spend frozen until December for Q3"], "read_memory content and reordered-but-overlapping quotes are grounded");
  assert.equal(outcome.unverifiedCitationsDropped, 2, "another source's text and empty quotes do not ground a citation");
});

test("lookup_person skips people excluded from injection (injectionEnabled === false)", async t => {
  const people = peopleFixture();
  t.after(people.cleanup);
  people.stores.get("main").setInjection(people.mira.id, false);
  const { runtime } = fakeRuntime();
  const { runner } = scriptedRunner([
    [{ call: "lookup_person", args: { query: "Mira" } }, { call: "lookup_person", args: { query: people.mira.id } }],
    { submit: outputs => {
      for (const output of outputs) assert.equal((output as { status: string }).status, "not_found");
      return { answer: "Unknown.", confidence: "low", citations: [{ source: `person:${people.mira.id}`, quote: "Mira leads launch planning at ExampleCo." }] };
    } },
  ]);
  const outcome = await execute(createDeepThoughtTool(toolContext(), deps(runtime, runner, { people: { enabled: true, stores: people.stores } })),
    { question: "Who is Mira?" });
  assert.deepEqual(outcome.citations, []);
  assert.equal(outcome.unverifiedCitationsDropped, 1);
});

test("through the real runner, an exhausted tool budget still returns the forced wrap-up's grounded answer", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("no network in tests"); });
  const { runtime } = fakeRuntime();
  const call = (name: string, id: string, args: unknown) => ({ type: "function_call", status: "completed", call_id: id, name,
    arguments: JSON.stringify(args) });
  const replies = [
    { status: "completed", output: [call("search_memory", "c1", { bm25Query: "launch", vectorQuery: "launch", corpora: null,
      sessionFilter: null, maxResults: null })] },
    { status: "completed", output: [call("submit_result", "c2", { status: "incomplete", answer: "Probably Friday.", confidence: "medium",
      openQuestions: null, citations: [{ source: "qmd://memory/launch.md", quote: "the launch moved to Friday", lines: null, date: null }] })] },
  ];
  const sent: { tools: { name: string }[]; tool_choice?: unknown }[] = [];
  const runner = createStewardRunner({
    config: resolveStewardConfig({ enabled: true, deepThought: { enabled: true } }),
    resolveApiKey: async () => "test-token",
    fetch: async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json(replies.shift()); },
  });
  const outcome = await execute(createDeepThoughtTool(toolContext(), deps(runtime, runner, { config: { ...CONFIG, maxToolCalls: 1 } })),
    { question: "When is the launch?" });
  assert.equal(outcome.status, "incomplete");
  assert.equal(outcome.answer, "Probably Friday.");
  assert.deepEqual(outcome.citations, [{ source: "qmd://memory/launch.md", quote: "the launch moved to Friday" }],
    "strict-mode nulls are decoded away before validation");
  assert.equal(outcome.openQuestions.length, 0);
  assert.deepEqual(sent[1]!.tools.map(tool => tool.name), ["submit_result"]);
  assert.deepEqual(sent[1]!.tool_choice, { type: "function", name: "submit_result" });
});

test("default unlimited config fans out freely with retrieval ranking and zero arbitrary caps", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("no network in tests"); });
  const { runtime } = fakeRuntime();
  let decisionCredentialLookups = 0;
  const unlimited = resolveStewardConfig(undefined).deepThought;
  const { runner, requests } = scriptedRunner([
    [{ call: "search_memory", args: { bm25Query: "launch", vectorQuery: "launch", maxResults: 25 } }],
    { submit: outputs => {
      const search = outputs[0] as { rankingMode: string; results: unknown[] };
      assert.equal(search.rankingMode, "retrieval", "retrieval ranking skips decision-model filtering by default");
      assert.equal(search.results.length, 2);
      return { answer: "All clear.", confidence: "high", citations: [{ source: "qmd://memory/launch.md", quote: "the launch moved to Friday" }] };
    } },
  ]);
  const outcome = await execute(createDeepThoughtTool(toolContext(), deps(runtime, runner, {
    config: unlimited,
    resolveCredential: async () => { decisionCredentialLookups += 1; return "decision-key"; },
  })), { question: "What happened?" });
  assert.equal(outcome.status, "complete");
  assert.equal(decisionCredentialLookups, 0, "default retrieval ranking does not look up or call the decision model");
  assert.equal(requests[0]!.maxTurns, 0);
  assert.equal(requests[0]!.maxToolCalls, 0);
  assert.equal(requests[0]!.wallTimeoutMs, 0);
});

test("async jobId handoff: returns running past syncWaitMs, isolates caller, collects final synthesis and supports cancel", async t => {
  t.after(() => cancelAllDeepThoughtJobs());
  const { runtime } = fakeRuntime();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const slowRunner: RunRunner = {
    async run<T>(request: StewardRunRequest<T>): Promise<StewardRunResult<T>> {
      const search = request.tools.find(tool => tool.name === "search_memory")!;
      await search.execute({ bm25Query: "launch", vectorQuery: "launch" }, request.signal!);
      await done;
      return {
        ok: true,
        status: "complete",
        data: {
          answer: "Finished deep dive after handoff.",
          confidence: "high",
          citations: [{ source: "qmd://memory/launch.md", quote: "the launch moved to Friday" }],
        } as T,
        summary: "Finished deep dive after handoff.",
        turns: 2,
        toolCalls: 1,
        usage: { requests: 2, inputTokens: 120, outputTokens: 30 },
      };
    },
  };
  const handoffConfig: DeepThoughtConfig = { ...CONFIG, timeoutMs: 0, syncWaitMs: 30, jobRetentionMs: 60_000 };
  const callerTool = createDeepThoughtTool(toolContext(), deps(runtime, slowRunner, { config: handoffConfig }));
  const otherSessionTool = createDeepThoughtTool(toolContext({ sessionKey: "agent:main:slack:direct:u2" }),
    deps(runtime, slowRunner, { config: handoffConfig }));

  // Initial call hands off at syncWaitMs while keeping the background job running even if initial signal aborts afterwards.
  const initialController = new AbortController();
  const running = await execute(callerTool, { question: "Deep question?" }, initialController.signal);
  assert.equal(running.status, "running");
  assert.ok(running.jobId);
  assert.equal(running.toolCallsUsed, 1);
  assert.equal(running.lastTool, "search_memory");
  assert.equal(activeDeepThoughts(), 1);
  initialController.abort();

  // Different session cannot inspect or hijack the jobId.
  const wrongCaller = await execute(otherSessionTool, { jobId: running.jobId });
  assert.equal(wrongCaller.status, "invalid_request");

  // Finish the background investigation, then poll with jobId to collect the grounded result.
  finish();
  const collected = await execute(callerTool, { jobId: running.jobId });
  assert.equal(collected.status, "complete");
  assert.equal(collected.jobId, running.jobId);
  assert.equal(collected.answer, "Finished deep dive after handoff.");
  assert.deepEqual(collected.citations.map(c => c.source), ["qmd://memory/launch.md"]);
  assert.equal(activeDeepThoughts(), 0);

  // Explicit cancel stops a running background job cleanly.
  const hanging: RunRunner = {
    run: request => new Promise(resolve => {
      request.signal!.addEventListener("abort", () => resolve({ ok: false, code: "aborted", error: "Steward aborted", retryable: false,
        usage: { requests: 1 }, turns: 1, toolCalls: 0 }), { once: true });
    }),
  };
  const cancelTool = createDeepThoughtTool(toolContext(), deps(runtime, hanging, { config: handoffConfig }));
  const started = await execute(cancelTool, { question: "Long job to cancel" });
  assert.equal(started.status, "running");
  assert.ok(started.jobId);
  assert.equal(activeDeepThoughts(), 1);
  const cancelled = await execute(cancelTool, { jobId: started.jobId, cancel: true });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(activeDeepThoughts(), 0);
});

/* ───────────── Step 1B: durable jobs + generation-keyed derived observations ───────────── */

function storeFixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "deep-thought-durable-"));
  const path = join(dir, "unblock-memory-test.sqlite");
  const opened: DeepThoughtStore[] = [];
  const open = () => { const store = new DeepThoughtStore(path); opened.push(store); return store; };
  t.after(() => { for (const store of opened) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, open };
}

const GROUNDED = [
  [{ call: "search_memory", args: { bm25Query: "launch", vectorQuery: "launch date" } }],
  { submit: () => ({ answer: "The launch moved to Friday.", confidence: "high" as const, openQuestions: ["Retro?"],
    citations: [{ source: "qmd://memory/launch.md", quote: "the launch moved to Friday" }] }) },
] satisfies ScriptStep[];

test("durable jobs: a completed jobId is collectible after a simulated restart, owner-fenced, and retention 0 never expires", async t => {
  t.after(() => cancelAllDeepThoughtJobs());
  const fixture = storeFixture(t);
  const { runtime } = fakeRuntime();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const slow: RunRunner = {
    async run<T>(request: StewardRunRequest<T>): Promise<StewardRunResult<T>> {
      await request.tools.find(tool => tool.name === "search_memory")!.execute({ bm25Query: "launch", vectorQuery: "launch" }, request.signal!);
      await done;
      return { ok: true, status: "complete", summary: "Friday.", turns: 2, toolCalls: 1, usage: { requests: 2 },
        data: { answer: "Friday.", confidence: "high", citations: [{ source: "qmd://memory/launch.md", quote: "the launch moved to Friday" }] } as T };
    },
  };
  const config: DeepThoughtConfig = { ...CONFIG, timeoutMs: 0, syncWaitMs: 20, jobRetentionMs: 0 };
  const store = fixture.open();
  const running = await execute(createDeepThoughtTool(toolContext(), deps(runtime, slow, { config, store })), { question: "Deep question?" });
  assert.equal(running.status, "running");
  const persisted = store.getJob(running.jobId!)!;
  assert.equal(persisted.status, "running");
  assert.equal(persisted.toolCallsUsed, 1, "tool-call progress is persisted while running");
  assert.equal(persisted.lastTool, "search_memory");
  finish();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.getJob(running.jobId!)!.status, "complete");
  assert.equal(store.getJob(running.jobId!)!.expiresAt, undefined, "jobRetentionMs 0 = unlimited: no expiry");

  // Simulated restart: in-process registry is gone, a new connection opens the same database.
  cancelAllDeepThoughtJobs();
  const reopened = fixture.open();
  const restarted = (ctx = toolContext()) => createDeepThoughtTool(ctx, deps(runtime, slow, { config, store: reopened }));
  const collected = await execute(restarted(), { jobId: running.jobId });
  assert.equal(collected.status, "complete");
  assert.equal(collected.jobId, running.jobId);
  assert.equal(collected.answer, "Friday.");
  assert.deepEqual(collected.citations.map(c => c.source), ["qmd://memory/launch.md"]);
  const intruder = await execute(restarted(toolContext({ sessionKey: "agent:main:slack:direct:u2" })), { jobId: running.jobId });
  assert.equal(intruder.status, "invalid_request", "another session cannot collect a persisted job");
  assert.equal((await execute(restarted(toolContext({ agentAccountId: "acct-b" })), { jobId: running.jobId })).status, "invalid_request");
  assert.equal((await execute(restarted(), { jobId: running.jobId, cancel: true })).status, "complete", "cancel on a finished job returns it…");
  assert.equal((await execute(restarted(), { jobId: running.jobId })).status, "invalid_request", "…and forgets it");
  assert.equal(activeDeepThoughts(), 0);
});

test("durable jobs: a running job orphaned by a restart is recovered as cancelled instead of hanging forever", async t => {
  t.after(() => cancelAllDeepThoughtJobs());
  const fixture = storeFixture(t);
  const { runtime } = fakeRuntime();
  const hanging: RunRunner = {
    run: request => new Promise(resolve => {
      request.signal!.addEventListener("abort", () => resolve({ ok: false, code: "aborted", error: "Steward aborted", retryable: false,
        usage: { requests: 1 }, turns: 1, toolCalls: 0 }), { once: true });
    }),
  };
  const config: DeepThoughtConfig = { ...CONFIG, timeoutMs: 0, syncWaitMs: 20, jobRetentionMs: 60_000 };
  const running = await execute(createDeepThoughtTool(toolContext(), deps(runtime, hanging, { config, store: fixture.open() })),
    { question: "Never finishes" });
  assert.equal(running.status, "running");

  // Simulate a hard crash: the process-global registry loses the job while the database still says running.
  const registry = (globalThis as Record<symbol, Map<string, { controller: AbortController; promise: Promise<unknown> }>>)[
    Symbol.for("unblock-memory.deepThought.jobs")]!;
  const orphan = registry.get(running.jobId!)!;
  registry.delete(running.jobId!);
  t.after(async () => { orphan.controller.abort(); await orphan.promise; });

  const reopened = fixture.open();
  const polled = await execute(createDeepThoughtTool(toolContext(), deps(runtime, hanging, { config, store: reopened })), { jobId: running.jobId });
  assert.equal(polled.status, "cancelled");
  assert.equal(polled.jobId, running.jobId);
  assert.match(polled.note ?? "", /interrupted when the Gateway restarted/u);
  assert.equal(reopened.getJob(running.jobId!)!.status, "cancelled");
  assert.ok(reopened.getJob(running.jobId!)!.expiresAt! > Date.now(), "recovered record honors jobRetentionMs");
});

test("derived observations: repeat asks are served cached in 0 hops; generation advance, ACL and fresh: true all re-run", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("no network in tests"); });
  const fixture = storeFixture(t);
  const store = fixture.open();
  const { runtime, recorded } = fakeRuntime();
  const { runner, requests } = scriptedRunner(GROUNDED);
  const generations: Record<string, number> = { memory: 3, sessions: 7 };
  const generationCalls: (readonly string[])[] = [];
  const getCollectionGenerations = (corpora: readonly string[]) => {
    generationCalls.push([...corpora]);
    return Object.fromEntries(corpora.map(name => [name, generations[name]!]));
  };
  // A DM session's cache audience needs the verified requester.
  const asker = (overrides: Partial<OpenClawPluginToolContext> = {}) => toolContext({ requesterSenderId: "U1", ...overrides });
  const tool = (ctx = asker(), extra: Partial<DeepThoughtDeps> = {}) =>
    createDeepThoughtTool(ctx, deps(runtime, runner, { store, getCollectionGenerations, ...extra }));

  const first = await execute(tool(), { question: "When did the launch move?" });
  assert.equal(first.status, "complete");
  assert.equal(first.cached, undefined);
  assert.ok(first.derivedObservationId, "a verified complete answer is saved");
  assert.equal(requests.length, 1);

  const searchesBefore = recorded.searches.length;
  const cached = await execute(tool(), { question: "  when did the LAUNCH move " });
  assert.equal(cached.status, "complete");
  assert.equal(cached.cached, true);
  assert.equal(cached.derivedObservationId, first.derivedObservationId);
  assert.equal(cached.answer, "The launch moved to Friday.");
  assert.equal(cached.confidence, "high");
  assert.deepEqual(cached.citations, first.citations);
  assert.deepEqual(cached.openQuestions, ["Retro?"]);
  assert.equal(cached.hopsUsed, 0);
  assert.equal(cached.toolCallsUsed, 0);
  assert.equal(cached.usage, undefined, "no model usage");
  assert.equal(requests.length, 1, "zero model calls");
  assert.equal(recorded.searches.length, searchesBefore, "zero memory searches");
  assert.equal(store.getDerivedObservation(first.derivedObservationId!)!.hitCount, 1);
  assert.deepEqual(generationCalls.at(-1), ["memory", "sessions"], "generations are requested for the approved corpora");

  // ACL: another session's audience and a different corpora set never see this answer.
  const otherSession = await execute(tool(asker({ sessionKey: "agent:main:slack:direct:u2" })), { question: "When did the launch move?" });
  assert.equal(otherSession.cached, undefined);
  assert.equal(requests.length, 2);
  const narrowed = await execute(tool(), { question: "When did the launch move?", corpora: ["memory"] });
  assert.equal(narrowed.cached, undefined);
  assert.equal(requests.length, 3);
  const focused = await execute(tool(), { question: "When did the launch move?", focus: "who decided" });
  assert.equal(focused.cached, undefined, "a different focus is a different investigation");
  assert.equal(requests.length, 4);

  // Advancing ANY searched collection's generation invalidates and re-runs.
  generations.sessions = 8;
  const advanced = await execute(tool(), { question: "When did the launch move?" });
  assert.equal(advanced.cached, undefined);
  assert.equal(requests.length, 5);
  assert.equal(store.getDerivedObservation(first.derivedObservationId!)!.status, "stale");
  assert.notEqual(advanced.derivedObservationId, first.derivedObservationId);
  assert.equal((await execute(tool(), { question: "When did the launch move?" })).cached, true, "the re-run answer now serves");
  assert.equal(requests.length, 5);

  // fresh: true bypasses the cache and supersedes the served row.
  const forced = await execute(tool(), { question: "When did the launch move?", fresh: true });
  assert.equal(forced.cached, undefined);
  assert.equal(requests.length, 6);
  assert.equal(store.getDerivedObservation(advanced.derivedObservationId!)!.status, "superseded");
  assert.equal(store.getDerivedObservation(forced.derivedObservationId!)!.status, "fresh");

  // bypassCache dep never serves (but still saves).
  const bypassed = await execute(tool(asker(), { bypassCache: true }), { question: "When did the launch move?" });
  assert.equal(bypassed.cached, undefined);
  assert.equal(requests.length, 7);

  // A shared audienceKey resolver deliberately lets two sessions share answers.
  const team = { audienceKey: () => "team:acct-a" };
  await execute(tool(toolContext(), team), { question: "Team question?" });
  const shared = await execute(tool(toolContext({ sessionKey: "agent:main:slack:direct:u2" }), team), { question: "Team question?" });
  assert.equal(shared.cached, true);
  assert.equal(requests.length, 8);

  const fresh = store.listDerivedObservations({ agentId: "main", status: "fresh", limit: 0 });
  assert.ok(fresh.every(row => Object.keys(row.collectionGenerations).length > 0));
  assert.equal(new Set(fresh.map(row => `${row.questionHash}|${row.audienceKey}|${row.corpora.join(",")}`)).size, fresh.length,
    "one fresh row per exact key");

  // No verified requester on a non-shared session (e.g. dmScope=main `agent:main:main`): the cache is skipped both ways.
  const saved = store.listDerivedObservations({ agentId: "main", limit: 0 }).length;
  for (const sessionKey of ["agent:main:main", "agent:main:slack:direct:u1"]) {
    const anonymous = await execute(tool(toolContext({ sessionKey })), { question: "When did the launch move?" });
    assert.equal(anonymous.status, "complete");
    assert.equal(anonymous.cached, undefined, `${sessionKey}: never served another caller's answer`);
    assert.equal(anonymous.derivedObservationId, undefined, `${sessionKey}: never saved under a pooled key`);
  }
  assert.equal(store.listDerivedObservations({ agentId: "main", limit: 0 }).length, saved);
});

test("derived observations are never saved or served without generations, and never for fabricated-citation answers", async t => {
  const fixture = storeFixture(t);
  const store = fixture.open();
  const { runtime } = fakeRuntime();
  const { runner, requests } = scriptedRunner(GROUNDED);

  for (const getCollectionGenerations of [undefined, () => ({}), () => { throw new Error("qmd offline"); },
    async () => ({ memory: -1, sessions: 1 })]) {
    const outcome = await execute(createDeepThoughtTool(toolContext(), deps(runtime, runner, { store, getCollectionGenerations })),
      { question: "Uncacheable?" });
    assert.equal(outcome.status, "complete", "investigation still succeeds");
    assert.equal(outcome.derivedObservationId, undefined);
  }
  assert.equal(requests.length, 4);
  assert.equal(store.listDerivedObservations({ agentId: "main" }).length, 0);

  const { runner: fabricated } = scriptedRunner([{ submit: () => ({ answer: "Guess.", confidence: "high",
    citations: [{ source: "qmd://memory/never-seen.md", quote: "x" }] }) }]);
  const outcome = await execute(createDeepThoughtTool(toolContext(), deps(runtime, fabricated,
    { store, getCollectionGenerations: async () => ({ memory: 1, sessions: 1 }) })), { question: "Fabricated?" });
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.derivedObservationId, undefined, "an answer whose every citation was dropped is never cached");
  assert.equal(store.listDerivedObservations({ agentId: "main" }).length, 0);

  // Without a store, behavior is the pre-1B in-memory path (nothing persisted, nothing cached).
  const { runner: plain, requests: plainRequests } = scriptedRunner(GROUNDED);
  for (let i = 0; i < 2; i += 1) {
    const result = await execute(createDeepThoughtTool(toolContext(), deps(runtime, plain, { getCollectionGenerations: () => ({ memory: 1 }) })),
      { question: "No store?" });
    assert.equal(result.cached, undefined);
  }
  assert.equal(plainRequests.length, 2);
});

test("derived observations are never saved for investigations that used lookup_person or cite nothing", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("no network in tests"); });
  const people = peopleFixture();
  t.after(people.cleanup);
  const fixture = storeFixture(t);
  const store = fixture.open();
  const { runtime } = fakeRuntime();
  const getCollectionGenerations = async () => ({ memory: 1, sessions: 1 });

  // Grounded citations, but a People dossier was consulted: it can be revoked without a generation change.
  const { runner: withPerson, requests: personRequests } = scriptedRunner([
    [{ call: "search_memory", args: { bm25Query: "launch", vectorQuery: "launch date" } },
      { call: "lookup_person", args: { query: "Mira" } }],
    { submit: () => ({ answer: "The launch moved to Friday.", confidence: "high" as const,
      citations: [{ source: "qmd://memory/launch.md", quote: "the launch moved to Friday" }] }) },
  ]);
  const personTool = () => createDeepThoughtTool(toolContext(), deps(runtime, withPerson,
    { store, getCollectionGenerations, people: { enabled: true, stores: people.stores } }));
  const first = await execute(personTool(), { question: "Who moved the launch?" });
  assert.equal(first.status, "complete");
  assert.equal(first.citations.length, 1);
  assert.equal(first.derivedObservationId, undefined, "a lookup_person investigation is never cached");
  const second = await execute(personTool(), { question: "Who moved the launch?" });
  assert.equal(second.cached, undefined);
  assert.equal(personRequests.length, 2, "the repeat re-investigates instead of serving stale People facts");

  // A complete answer with zero citations is not grounded evidence.
  const { runner: uncited } = scriptedRunner([
    [{ call: "search_memory", args: { bm25Query: "launch", vectorQuery: "launch date" } }],
    { submit: () => ({ answer: "Probably Friday.", confidence: "medium" as const, citations: [] }) },
  ]);
  const outcome = await execute(createDeepThoughtTool(toolContext(), deps(runtime, uncited, { store, getCollectionGenerations })),
    { question: "Uncited?" });
  assert.equal(outcome.status, "complete");
  assert.deepEqual(outcome.citations, []);
  assert.equal(outcome.derivedObservationId, undefined, "citations: [] is never cached");
  assert.equal(store.listDerivedObservations({ agentId: "main" }).length, 0);
});

test("job ownership binds the requester sender and native peer, not just a shared session key", async t => {
  t.after(() => cancelAllDeepThoughtJobs());
  const fixture = storeFixture(t);
  const store = fixture.open();
  const { runtime } = fakeRuntime();
  const hanging: RunRunner = {
    run: request => new Promise(resolve => {
      request.signal!.addEventListener("abort", () => resolve({ ok: false, code: "aborted", error: "Steward aborted", retryable: false,
        usage: { requests: 1 }, turns: 1, toolCalls: 0 }), { once: true });
    }),
  };
  const config: DeepThoughtConfig = { ...CONFIG, timeoutMs: 0, syncWaitMs: 20, jobRetentionMs: 60_000 };
  // dmScope=main: two peers share one session key.
  const shared = { sessionKey: "agent:main:main" };
  const tool = (ctx: Partial<OpenClawPluginToolContext>) =>
    createDeepThoughtTool(toolContext({ ...shared, ...ctx }), deps(runtime, hanging, { config, store }));
  const alice = { requesterSenderId: "U-alice", nativeChannelId: "D-alice" } as Partial<OpenClawPluginToolContext>;
  const running = await execute(tool(alice), { question: "Alice's private question" });
  assert.equal(running.status, "running");

  for (const peer of [{ requesterSenderId: "U-bob", nativeChannelId: "D-alice" }, { requesterSenderId: "U-alice", nativeChannelId: "D-bob" },
    {}] as Partial<OpenClawPluginToolContext>[]) {
    assert.equal((await execute(tool(peer), { jobId: running.jobId })).status, "invalid_request", JSON.stringify(peer));
  }
  // The durable fallback is fenced the same way after a restart.
  const registry = (globalThis as Record<symbol, Map<string, { controller: AbortController; promise: Promise<unknown> }>>)[
    Symbol.for("unblock-memory.deepThought.jobs")]!;
  const live = registry.get(running.jobId!)!;
  live.controller.abort();
  await live.promise;
  registry.delete(running.jobId!);
  assert.equal((await execute(tool({ requesterSenderId: "U-bob", nativeChannelId: "D-alice" } as Partial<OpenClawPluginToolContext>),
    { jobId: running.jobId })).status, "invalid_request");
  assert.equal((await execute(tool(alice), { jobId: running.jobId })).status, "cancelled", "the owner still collects it");
});

test("a slow cold generations snapshot still hands off a jobId within syncWaitMs and the job waits for it", async t => {
  t.after(() => cancelAllDeepThoughtJobs());
  const fixture = storeFixture(t);
  const store = fixture.open();
  const { runtime } = fakeRuntime();
  const { runner, requests } = scriptedRunner(GROUNDED);
  let release!: (value: Record<string, number>) => void;
  const cold = new Promise<Record<string, number>>(resolve => { release = resolve; });
  const config: DeepThoughtConfig = { ...CONFIG, timeoutMs: 0, syncWaitMs: 30, jobRetentionMs: 60_000 };
  const tool = createDeepThoughtTool(toolContext({ requesterSenderId: "U1" }),
    deps(runtime, runner, { config, store, getCollectionGenerations: () => cold }));
  const startedAt = performance.now();
  const running = await execute(tool, { question: "Cold index?" });
  assert.ok(performance.now() - startedAt < 500, "the caller is not blocked by cold indexing");
  assert.equal(running.status, "running");
  assert.ok(running.jobId);
  assert.equal(requests.length, 0, "the run waits for the pre-run generations snapshot");

  release({ memory: 2, sessions: 5 });
  const collected = await execute(tool, { jobId: running.jobId });
  assert.equal(collected.status, "complete");
  assert.ok(collected.derivedObservationId, "the late snapshot still keys the saved answer");
  assert.deepEqual(store.getDerivedObservation(collected.derivedObservationId!)!.collectionGenerations, { memory: 2, sessions: 5 });
});

test("restart recovery retries after a transient markInterruptedJobs failure", async t => {
  const fixture = storeFixture(t);
  const store = fixture.open();
  const { runtime } = fakeRuntime();
  const { runner } = scriptedRunner(GROUNDED);
  let calls = 0;
  const original = store.markInterruptedJobs.bind(store);
  t.mock.method(store, "markInterruptedJobs", (...args: Parameters<DeepThoughtStore["markInterruptedJobs"]>) => {
    calls += 1;
    if (calls === 1) throw new Error("database is locked");
    return original(...args);
  });
  const tool = () => createDeepThoughtTool(toolContext(), deps(runtime, runner, { store }));
  assert.equal((await execute(tool(), { question: "First?" })).status, "complete");
  assert.equal((await execute(tool(), { question: "Second?" })).status, "complete");
  assert.equal(calls, 2, "a failed sweep is retried on the next call");
  await execute(tool(), { question: "Third?" });
  assert.equal(calls, 2, "a successful sweep is not repeated");
});

test("headless investigation (Overnight Thinking): bypasses the cache, waits for completion, saves under the explicit audience", async t => {
  t.after(() => cancelAllDeepThoughtJobs());
  const fixture = storeFixture(t);
  const store = fixture.open();
  const { runtime, recorded } = fakeRuntime();
  const { runner, requests, toolNames } = scriptedRunner([...GROUNDED]);
  const audienceKey = "slack:channel:c0launch";
  // A cached answer for this exact key already exists: a headless re-investigation must never serve it.
  const prior = store.saveDerivedObservation({ agentId: "main", question: "When did the launch move?", audienceKey, corpora: ["memory"],
    collectionGenerations: { memory: 1 }, answer: "The launch moved to Thursday.", confidence: "high",
    citations: [{ source: "qmd://memory/launch.md", quote: "Thursday" }] });
  // syncWaitMs is ignored: the background caller always waits for the finished synthesis (no jobId hand-off).
  const background = deps(runtime, runner, { config: { ...CONFIG, syncWaitMs: 1 }, store, getCollectionGenerations: () => ({ memory: 1 }) });
  const outcome = await runDeepThoughtInvestigation(background, {
    cfg: {} as OpenClawConfig, agentId: "main", question: "When did the launch move?", audienceKey, corpora: ["memory"],
  });
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.cached, undefined, "never served from cache");
  assert.equal(outcome.jobId, undefined);
  assert.equal(outcome.answer, "The launch moved to Friday.");
  assert.equal(requests.length, 1);
  assert.deepEqual(toolNames[0], ["search_memory", "read_memory"], "no caller origin: lookup_person is never offered");
  assert.deepEqual(recorded.searches.map(search => search.corpora), [["memory"]]);
  const saved = store.getDerivedObservation(outcome.derivedObservationId!)!;
  assert.equal(saved.audienceKey, audienceKey);
  assert.deepEqual(saved.corpora, ["memory"]);
  assert.equal(store.getDerivedObservation(prior.id)!.status, "superseded");

  for (const request of [{ question: " ", audienceKey }, { question: "Q?", audienceKey: " " }]) {
    const invalid = await runDeepThoughtInvestigation(background, { cfg: {} as OpenClawConfig, agentId: "main", ...request });
    assert.equal(invalid.status, "invalid_request");
  }
  assert.equal(requests.length, 1);
});

test("headless skipSave never saves or supersedes an observation and reports the pre-run generations for a fenced commit", async t => {
  t.after(() => cancelAllDeepThoughtJobs());
  const fixture = storeFixture(t);
  const store = fixture.open();
  const { runtime } = fakeRuntime();
  const { runner, requests } = scriptedRunner([...GROUNDED]);
  const audienceKey = "slack:channel:c0launch";
  const prior = store.saveDerivedObservation({ agentId: "main", question: "When did the launch move?", audienceKey, corpora: ["memory"],
    collectionGenerations: { memory: 1 }, answer: "The launch moved to Thursday.", confidence: "high",
    citations: [{ source: "qmd://memory/launch.md", quote: "Thursday" }] });
  const background = deps(runtime, runner, { store, getCollectionGenerations: () => ({ memory: 2 }) });
  const outcome = await runDeepThoughtInvestigation(background, {
    cfg: {} as OpenClawConfig, agentId: "main", question: "When did the launch move?", audienceKey, corpora: ["memory"], skipSave: true,
  });
  assert.equal(outcome.status, "complete");
  assert.equal(requests.length, 1);
  assert.equal(outcome.derivedObservationId, undefined, "nothing was saved");
  assert.deepEqual(outcome.collectionGenerations, { memory: 2 }, "the pre-run snapshot is handed back to the caller");
  assert.equal(outcome.unverifiedCitationsDropped, undefined);
  assert.equal(store.getDerivedObservation(prior.id)!.status, "fresh", "the prior conclusion is NOT superseded before the caller commits");
});
