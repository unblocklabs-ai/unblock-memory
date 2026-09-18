import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { PeopleStore, PeopleStores } from "../src/people-store.js";
import { resolveConfig } from "../src/config.js";
import { peoplePrimerSchema } from "../src/people-primer-config.js";
import { primePersonDossier } from "../src/people-primer.js";
import { registerPeoplePrimerTool } from "../src/people-primer-tool.js";
import type { QmdMemoryRuntime } from "../src/runtime.js";
import type { CorpusMemorySearchResult } from "../src/contracts.js";

const config = resolveConfig({ people: { enabled: true }, peoplePrimer: { enabled: true, corpora: ["memory"] } });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "people-primer-"));
  const path = join(root, "people.sqlite");
  const store = new PeopleStore(path, { maxOpenTodos: 10, maxBlurbChars: 1200 });
  t.after(() => store.close());
  const person = store.upsertIdentity({ provider: "slack", accountScope: "default", externalId: "U123", displayName: "Mira" }).person;
  return { root, path, store, personId: person.id, agentName: "Bill", config: config.peoplePrimer,
    apiKey: "fake-secret", signal: new AbortController().signal };
}
function hit(overrides: Partial<CorpusMemorySearchResult> = {}): CorpusMemorySearchResult {
  return { path: "qmd://memory/mira.md", startLine: 2, endLine: 4, snippet: "Mira leads support and asks for concise updates.",
    score: 0.7, source: "memory", corpus: "memory", ...overrides };
}
function mockJudge(t: test.TestContext, values: Record<string, number> = {}) {
  const requests: { state: Record<string, unknown>; questions: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, { type: "noul", noul: values[k] ?? 0.95 }])) });
  });
  return requests;
}

test("primer defaults, strict config and manifest schema agree", async () => {
  assert.equal(resolveConfig({}).peoplePrimer.enabled, false);
  assert.equal(config.peoplePrimer.hitsPerQuestion, 30);
  for (const bad of [null, true, [], { unexpected: true }, { hitsPerQuestion: 41 }, { hitsPerQuestion: "30" },
    { minScore: NaN }, { minUsefulness: 0.2 }, { timeoutMs: 60001 }, { corpora: ["unknown"] }]) {
    assert.throws(() => resolveConfig({ peoplePrimer: bad }), /peoplePrimer/);
  }
  assert.throws(() => resolveConfig({ peoplePrimer: { enabled: true, corpora: ["memory"] } }), /people.enabled/);
  assert.throws(() => resolveConfig({ people: { enabled: true }, peoplePrimer: { enabled: true } }), /corpora/);
  const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(peoplePrimerSchema.properties)), manifest.configSchema.properties.peoplePrimer.properties);
  assert.ok(Value.Check(peoplePrimerSchema, config.peoplePrimer));
});

test("all eligible shortlist hits are graded, cross-question spans deduplicate, outputs stay bounded", async t => {
  const f = await fixture(t);
  const requests = mockJudge(t);
  let searches = 0;
  const result = await primePersonDossier({ ...f, search: async (_query, options) => {
    searches++; assert.equal(options.maxResults, 30); assert.deepEqual(options.corpora, ["memory"]);
    return Array.from({ length: 30 }, (_, i) => hit({ path: `qmd://memory/${i}.md`, snippet: `Mira leads team ${i}.` }));
  } });
  assert.equal(result.status, "ok");
  assert.equal(searches, 3);
  assert.equal(requests.length, 30, "not just five final evidence items");
  assert.equal(result.stats?.uniqueCandidates, 30);
  assert.equal(result.questions?.[0].qualifying, 30);
  assert.equal(result.questions?.[0].evidence.length, 3);
  assert.equal(result.questions?.[0].coverage, "evidence_found");
  assert.equal(result.evidence?.length, 3, "shared excerpts are not repeated across questions");
  assert.equal(result.questions?.[0].evidence[0].evidenceId, result.evidence?.[0].id);
  assert.equal(Object.keys(requests[0].questions).length, 7);
  assert.equal(JSON.stringify(requests[0]).includes("qmd://"), false);
  assert.equal(f.store.getDossier(f.personId), undefined);
});

test("cache follows evidence changes, never treats existing dossiers as evidence", async t => {
  const f = await fixture(t), requests = mockJudge(t);
  const run = (snippet = hit().snippet) => primePersonDossier({ ...f, search: async () => [hit({ snippet })] });
  await run();
  const cached = await run();
  assert.equal(cached.stats?.cached, 1);
  assert.equal(requests.length, 1);
  const reopened = new PeopleStore(f.path, { maxOpenTodos: 10, maxBlurbChars: 1200 });
  try {
    const result = await primePersonDossier({ ...f, store: reopened, search: async () => [hit()] });
    assert.equal(result.stats?.cached, 1);
  } finally { reopened.close(); }
  await run("Mira now leads product.");
  assert.equal(requests.length, 2);
  f.store.replaceDossier(f.personId, "New role", { schemaVersion: 1, blurb: "Mira leads product", sections: [] });
  await run();
  assert.equal(requests.length, 2);
  assert.equal(requests.some(r => Object.hasOwn(r.state, "currentDossier")), false);
});

test("each background gate independently rejects activity profiles; missing answers stay unknown", async t => {
  const f = await fixture(t);
  for (const gate of ["explicitBackground", "enduring", "recognition"]) {
    mockJudge(t, { [gate]: 0.05 });
    const result = await primePersonDossier({ ...f, search: async () => [hit({ snippet: `Mira requests ${gate} work.` })] });
    assert.ok(result.questions?.every(q => q.coverage === "unknown" && !q.evidence.length && !q.review.length));
    t.mock.restoreAll();
  }
  mockJudge(t);
  const empty = await primePersonDossier({ ...f, search: async () => [] });
  assert.ok(empty.questions?.every(q => q.coverage === "unknown"));
});

test("background evidence found by one search can answer all research questions", async t => {
  const f = await fixture(t);
  const requests = mockJudge(t);
  let searches = 0;
  const result = await primePersonDossier({ ...f, search: async () => ++searches === 2 ? [hit()] : [] });
  assert.equal(requests.length, 1);
  assert.ok(result.questions?.every(q => q.evidence.length === 1));
  assert.equal(result.questions?.[0].retrieved, 0, "retrieval count stays distinct from cross-question grading");
});

test("cache stores only numerical answers, not provider echoes", async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ echo: "PRIVATE_PROVIDER_ECHO", answers: Object.fromEntries(Object.keys(body.questions).map(k =>
      [k, { type: "noul", noul: 0.9, explanation: "PRIVATE_PROVIDER_ECHO" }])) });
  });
  let stored: unknown;
  const cache = f.store.cachePrimerJudgment.bind(f.store);
  t.mock.method(f.store, "cachePrimerJudgment", (person: string, key: string, value: unknown) => {
    stored = value; cache(person, key, value);
  });
  await primePersonDossier({ ...f, search: async () => [hit()] });
  assert.ok(stored);
  assert.equal(JSON.stringify(stored).includes("PRIVATE_PROVIDER_ECHO"), false);
});

test("threshold, approval, oversized and duplicate hits are filtered before egress", async t => {
  const f = await fixture(t), requests = mockJudge(t);
  const result = await primePersonDossier({ ...f, search: async () => [hit(), hit(), hit({ score: 0.1 }),
    hit({ corpus: "private", snippet: "PRIVATE_NEVER_SEND" }), hit({ snippet: "x".repeat(6001) })] });
  assert.equal(requests.length, 1);
  assert.equal(result.questions?.[0].eligible, 1);
  assert.equal(result.questions?.[0].oversized, 1);
  assert.equal(JSON.stringify(requests).includes("PRIVATE_NEVER_SEND"), false);
});

test("wrong-person evidence is excluded and uncertainty is visible", async t => {
  const f = await fixture(t);
  const requests = mockJudge(t, { aboutPerson: 0.6 });
  const result = await primePersonDossier({ ...f, search: async () => [hit()] });
  assert.equal(result.questions?.[0].evidence.length, 0);
  assert.equal(result.questions?.[0].review.length, 1);
  t.mock.restoreAll();
  mockJudge(t, { aboutPerson: 0.01 });
  const other = await primePersonDossier({ ...f, search: async () => [hit({ snippet: "Unrelated Mira" })] });
  assert.equal(other.questions?.[0].review.length, 0);
  assert.equal(requests.length, 1);
});

test("provider failures and malformed answers are explicit, sanitized and never cached", async t => {
  const f = await fixture(t);
  for (const response of [{ answers: {} }, { answers: { aboutPerson: { type: "noul", noul: 5 } } }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(response));
    const result = await primePersonDossier({ ...f, search: async () => [hit()] });
    assert.equal(result.status, "partial"); assert.equal(result.stats?.failed, 1); assert.equal(result.stats?.cached, 0);
    assert.equal(result.questions?.[0].evidence.length, 0);
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("fake-secret PRIVATE"); });
  const result = await primePersonDossier({ ...f, search: async () => [hit()] });
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(f.store.getDossier(f.personId), undefined);
});

test("aborted retrieval cannot later send evidence; unknown and bot people do not search", async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", () => { assert.fail("no egress"); });
  const control = new AbortController();
  let resolve!: (value: CorpusMemorySearchResult[]) => void;
  const pending = new Promise<CorpusMemorySearchResult[]>(r => { resolve = r; });
  const run = primePersonDossier({ ...f, signal: control.signal, search: () => pending });
  control.abort();
  await assert.rejects(run);
  resolve([hit()]);
  await new Promise(r => setImmediate(r));
  assert.equal((await primePersonDossier({ ...f, personId: "unknown", search: async () => { assert.fail(); } })).status, "not_found");
  const bot = f.store.upsertIdentity({ provider: "slack", accountScope: "default", externalId: "BOT", isBot: true }).person;
  assert.equal((await primePersonDossier({ ...f, personId: bot.id, search: async () => { assert.fail(); } })).status, "unavailable");
});

test("tool gates disabled and missing credentials before accessing stores or retrieval", async () => {
  for (const enabled of [false, true]) {
    let tool: { execute(id: string, args: unknown): Promise<unknown> } | undefined;
    const cfg = resolveConfig({ people: { enabled: true }, peoplePrimer: { enabled, corpora: ["memory"] },
      typesafe: { apiKeyFile: "/nonexistent/primer-key.env" } });
    registerPeoplePrimerTool({ registerTool(factory: (ctx: OpenClawPluginToolContext) => typeof tool) {
      tool = factory({ agentId: "bill", config: {} } as OpenClawPluginToolContext);
    } } as unknown as OpenClawPluginApi,
    { getMemorySearchManager() { assert.fail("no retrieval"); } } as unknown as QmdMemoryRuntime,
    { get() { assert.fail("no store"); } } as unknown as PeopleStores, cfg);
    const result = await tool!.execute("id", { personId: "p" }) as { content: { text: string }[] };
    assert.equal(JSON.parse(result.content[0].text).status, enabled ? "unavailable" : "disabled");
  }
});

test("draft mode reviews indexed evidence with primer approval, skips search and sanitizes failures", async t => {
  const f = await fixture(t);
  const cfg = resolveConfig({ people: { enabled: true }, peoplePrimer: { enabled: true, corpora: ["memory"] },
    typesafe: { apiKey: "fake-secret" } });
  let calls = 0, fail = false;
  let tool: { execute(id: string, args: unknown): Promise<{ content: { text: string }[] }> } | undefined;
  registerPeoplePrimerTool({ registerTool(factory: (ctx: OpenClawPluginToolContext) => typeof tool) {
    tool = factory({ agentId: "bill", config: {} } as OpenClawPluginToolContext);
  } } as unknown as OpenClawPluginApi,
  { async getMemorySearchManager() { return { manager: {
    search() { assert.fail("draft mode must not search"); },
    async reviewClaim(args: { corpora: string[]; personBackground: { name: string; agentName: string }; claim: string }) {
      calls++;
      assert.deepEqual(args.corpora, ["memory"]);
      assert.deepEqual(args.personBackground, { name: "Mira", agentName: "Bill" });
      if (fail) throw new Error("fake-secret PRIVATE");
      return { status: "ok", needsReview: false };
    },
  } }; } } as unknown as QmdMemoryRuntime,
  { get() { return f.store; } } as unknown as PeopleStores, cfg);
  const args = { personId: f.personId, agentName: "Bill", draft: { blurb: "Mira is CEO.", citations: [{ path: hit().path, from: 2, lines: 3 }] } };
  assert.equal(cfg.evidenceReview.enabled, false);
  assert.equal(JSON.parse((await tool!.execute("id", args)).content[0].text).status, "ok");
  const tooLong = await tool!.execute("id", { ...args, draft: { ...args.draft, blurb: "word ".repeat(71) } });
  assert.equal(JSON.parse(tooLong.content[0].text).status, "invalid");
  assert.equal(calls, 1);
  fail = true;
  const unavailable = JSON.parse((await tool!.execute("id", args)).content[0].text);
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.needsReview, true);
  assert.equal(JSON.stringify(unavailable).includes("PRIVATE"), false);
  assert.equal(f.store.getDossier(f.personId), undefined);
});
