import assert from "node:assert/strict";
import test from "node:test";
import { LEGACY_SYSTEMONE_ENDPOINT } from "@unblocklabs/decisions";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { DEFAULT_CORPORA, DEFAULT_PEOPLE_CONFIG, resolveConfig } from "../src/config.js";

test("whisperer trigger allowlists default empty and deduplicate in input order", () => {
  assert.deepEqual(resolveConfig({}).whispererTriggers, { cron: [], subagent: [], heartbeat: [] });
  assert.deepEqual(resolveConfig({ whispererTriggers: {
    cron: ["skill", "memory", "skill", "myTurn", "memory"],
    subagent: ["people", "safety", "people"],
  } }).whispererTriggers, {
    cron: ["skill", "memory", "myTurn"], subagent: ["people", "safety"], heartbeat: [],
  });
});

test("host and runtime reject unknown whisperer surfaces and invalid allowlists", async () => {
  const validate = await manifestValidator("unblock-memory:test:whisperer-triggers");
  const valid = validate({ whispererTriggers: { cron: ["skill", "skill"], heartbeat: ["memory", "people", "myTurn", "safety"] } });
  assert.equal(valid.ok, true);
  assert.deepEqual(resolveConfig(valid.value).whispererTriggers, {
    cron: ["skill"], subagent: [], heartbeat: ["memory", "people", "myTurn", "safety"],
  });
  for (const value of [null, false, [], { "": [] }, { user: [] }, { memory: [] }, { cron: "skill" },
    { subagent: ["unknown"] }, { heartbeat: [1] }, { heartbeat: null }]) {
    assert.equal(validate({ whispererTriggers: value }).ok, false, JSON.stringify(value));
    assert.throws(() => resolveConfig({ whispererTriggers: value }), /whispererTriggers/);
  }
});

test("Decision model is enabled by default with optional explicit credentials, endpoint, and model", () => {
  const defaultDecisionModel = {
    enabled: true,
    endpoint: "https://codex.unblocklabs.ai/v1/decisions",
    model: "liquid/d1.2-ultra",
    timeoutMs: 4000,
  };
  assert.deepEqual(resolveConfig(undefined).decisionModel, defaultDecisionModel);
  assert.deepEqual(resolveConfig({}).decisionModel, defaultDecisionModel);
  assert.deepEqual(resolveConfig({ decisionModel: { apiKey: " fake-key " } }).decisionModel,
    { ...defaultDecisionModel, apiKey: "fake-key" });
  assert.deepEqual(resolveConfig({ decisionModel: { enabled: false, apiKeyFile: " /tmp/decisionModel.env ", timeoutMs: 500 } }).decisionModel,
    { ...defaultDecisionModel, enabled: false, timeoutMs: 500, apiKeyFile: "/tmp/decisionModel.env" });
  assert.deepEqual(resolveConfig({ decisionModel: { endpoint: "https://other.example/v1/decisions///" } }).decisionModel,
    { ...defaultDecisionModel, endpoint: "https://other.example/v1/decisions" });
  assert.equal(resolveConfig({ decisionModel: { endpoint: LEGACY_SYSTEMONE_ENDPOINT } }).decisionModel.model, defaultDecisionModel.model);
  assert.deepEqual(resolveConfig({ decisionModel: { endpoint: "https://other.example/v1/decisions/", model: " custom/model " } }).decisionModel,
    { ...defaultDecisionModel, endpoint: "https://other.example/v1/decisions", model: "custom/model" });
  for (const loopback of ["http://127.0.0.1:8787/v1/decisions", "http://localhost:8787/v1/decisions", "http://[::1]:8787/v1/decisions"]) {
    assert.equal(resolveConfig({ decisionModel: { endpoint: loopback } }).decisionModel.endpoint, loopback);
  }
  for (const decisionModel of [false, [], { enabled: "yes" }, { apiKey: " " }, { apiKeyFile: "relative" },
    { apiKey: "fake", apiKeyFile: "/tmp/key" }, { unknownKey: true },
    { endpoint: "ftp://other.example" }, { endpoint: "http://other.example/v1/decisions" },
    { endpoint: "https://" },
    { endpoint: "https://:443/v1/decisions" },
    { endpoint: " https://codex.unblocklabs.ai/v1/decisions " },
    { endpoint: "https://codex.unblocklabs.ai/v1/decisions path" },
    { endpoint: "https://user:pass@other.example/v1" },
    { endpoint: "https://other.example/v1?" }, { endpoint: "https://other.example/v1#" },
    { endpoint: "https://other.example/v1?x=1" }, { endpoint: "https://other.example/v1#frag" },
    { model: " " }, { model: 123 }, { model: "liquid/d1.2-ultra-20261116" },
    { timeoutMs: 0 }, { timeoutMs: 10001 }, { timeoutMs: 1.2 }]) {
    assert.throws(() => resolveConfig({ decisionModel }), /decisionModel/);
  }
});

async function manifestValidator(cacheKey: string) {
  const { validateJsonSchemaValue } = await import(import.meta.resolve("openclaw/plugin-sdk/json-schema-runtime")) as {
    validateJsonSchemaValue: (args: {
      schema: Record<string, unknown>;
      cacheKey: string;
      value: unknown;
      applyDefaults?: boolean;
    }) => { ok: boolean; value?: Record<string, unknown>; errors?: unknown[] };
  };
  return (value: unknown) => validateJsonSchemaValue({
    schema: manifest.configSchema,
    cacheKey,
    value,
    applyDefaults: true,
  });
}

test("host and runtime reject the old provider key and unsafe endpoint forms", async () => {
  const validate = await manifestValidator("unblock-memory:test:manifest");
  for (const valid of [
    "https://codex.unblocklabs.ai/v1/decisions",
    "https://other.example/v1/decisions",
    "http://127.0.0.1:8787/v1/decisions",
    "http://localhost:8787/v1/decisions",
    "http://[::1]:8787/v1/decisions",
  ]) {
    const host = validate({ decisionModel: { endpoint: valid } });
    assert.equal(host.ok, true, valid);
    assert.equal(resolveConfig(host.value).decisionModel.endpoint, valid);
  }
  const canonicalized = validate({ decisionModel: { endpoint: "HTTPS://other.example./v1/decisions" } });
  assert.equal(canonicalized.ok, true);
  assert.equal(resolveConfig(canonicalized.value).decisionModel.endpoint, "https://other.example./v1/decisions");
  const legacy = { typesafe: { apiKey: "old-key" } };
  for (const value of [legacy, { ...legacy, decisionModel: { apiKey: "new-key" } }]) {
    assert.equal(validate(value).ok, false);
    assert.throws(() => resolveConfig(value), /config has unknown property/);
  }
  for (const invalid of [
    "https://",
    "https://:443/v1/decisions",
    "https://other.example:65536/v1/decisions",
    "https://[:::]/v1/decisions",
    "http://other.example/v1/decisions",
    "https://user:pass@other.example/v1",
    "https://other.example/v1?",
    "https://other.example/v1#",
    "https://other.example/v1?x=1",
    "https://other.example/v1#frag",
    "https://codex.unblocklabs.ai/v1/decisions path",
    " https://codex.unblocklabs.ai/v1/decisions ",
  ]) {
    assert.equal(validate({ decisionModel: { endpoint: invalid } }).ok, false, invalid);
    assert.throws(() => resolveConfig({ decisionModel: { endpoint: invalid } }), /decisionModel/);
  }
  const emptyRes = validate({});
  assert.equal(emptyRes.ok, true);
  assert.equal(resolveConfig(emptyRes.value).decisionModel.endpoint, "https://codex.unblocklabs.ai/v1/decisions");
  assert.equal(resolveConfig(emptyRes.value).decisionModel.model, "liquid/d1.2-ultra");
});

test("uses the canonical memory corpus when corpora are absent", () => {
  assert.deepEqual(resolveConfig(undefined), resolveConfig({}));
  assert.deepEqual(resolveConfig(null), resolveConfig({}));
  assert.deepEqual(resolveConfig(undefined).corpora, DEFAULT_CORPORA);
  assert.deepEqual(resolveConfig({}).corpora, DEFAULT_CORPORA);
});

test("validates the session sync interval and manual-only opt-out", () => {
  const resolve = (syncIntervalMinutes: unknown) => resolveConfig({
    corpora: [...DEFAULT_CORPORA, { name: "sessions", kind: "sessions", syncIntervalMinutes }],
  }).corpora[1];
  for (const minutes of [0, 1, 5, 15, 60, 1440]) {
    const corpus = resolve(minutes);
    assert.ok(corpus?.kind === "sessions");
    assert.equal(corpus.syncIntervalMinutes, minutes);
  }
  for (const invalid of [-1, 0.5, 1441, Infinity, "15", true]) {
    assert.throws(() => resolve(invalid), /syncIntervalMinutes/);
  }
});

test("keeps the embedding model warm by default and accepts an opt-out", () => {
  assert.equal(resolveConfig(undefined).keepEmbeddingModelWarm, true);
  assert.equal(resolveConfig({ keepEmbeddingModelWarm: false }).keepEmbeddingModelWarm, false);
  assert.throws(() => resolveConfig({ keepEmbeddingModelWarm: "yes" }), /must be a boolean/);
});

test("keeps PeopleSQL off by default and validates its bounded controls", () => {
  assert.deepEqual(resolveConfig(undefined).people, DEFAULT_PEOPLE_CONFIG);
  assert.deepEqual(
    resolveConfig({
      people: {
        enabled: true,
        whisperer: { enabled: true, maxChars: 800 },
        todos: { maxOpen: 20 },
      },
    }).people,
    {
      enabled: true,
      whisperer: { enabled: true, maxChars: 800 },
      todos: { maxOpen: 20 },
      learning: { ...DEFAULT_PEOPLE_CONFIG.learning, enabled: true },
    },
  );
  assert.throws(() => resolveConfig({ people: true }), /people must be an object/);
  assert.throws(() => resolveConfig({ people: { enabled: "yes" } }), /enabled must be a boolean/);
  assert.throws(
    () => resolveConfig({ people: { evidenceCorpora: ["sessions"] } }),
    /unknown property: evidenceCorpora/,
  );
  assert.throws(
    () => resolveConfig({ people: { refinement: { maxPeoplePerRun: 2 } } }),
    /unknown property: refinement/,
  );
  assert.throws(
    () => resolveConfig({ people: { whisperer: { maxChars: 1.5 } } }),
    /positive integer/,
  );
  assert.throws(() => resolveConfig({ people: { whisperer: { maxChars: 4001 } } }), /4000/);
  assert.throws(() => resolveConfig({ people: { todos: { maxOpen: 10_001 } } }), /10000/);
  assert.throws(() => resolveConfig({ people: { todos: { maxOpen: 0 } } }), /positive integer/);
  assert.throws(() => resolveConfig({ people: { extra: true } }), /unknown property/);
});

test("enables skill whispering by default only once a skills corpus exists and validates its lean controls", () => {
  assert.deepEqual(resolveConfig(undefined).skillWhisperer, {
    enabled: false,
    historyMessages: 5,
    minScore: 0.5,
    cooldownTurns: 10,
    recipeHash: "default",
  });
  const corpora = [
    { name: "memory", kind: "files", paths: ["MEMORY.md"] },
    { name: "skills", kind: "skills", paths: [" skills/**/SKILL.md "] },
  ];
  assert.deepEqual(
    resolveConfig({
      corpora,
      skillWhisperer: { enabled: true, historyMessages: 0, minScore: 0.7, cooldownTurns: 0 },
    }).skillWhisperer,
    {
      enabled: true,
      historyMessages: 0,
      minScore: 0.7,
      cooldownTurns: 0,
      recipeHash: "default",
    },
  );
  assert.deepEqual(resolveConfig({ corpora }).corpora[1], {
    name: "skills",
    kind: "skills",
    paths: ["skills/**/SKILL.md"],
  });
  // No skills corpus means nothing to suggest: inactive, even when explicitly or host-defaulted true.
  assert.equal(resolveConfig({ skillWhisperer: {} }).skillWhisperer.enabled, false);
  assert.equal(resolveConfig({ skillWhisperer: { enabled: true } }).skillWhisperer.enabled, false);
  assert.equal(resolveConfig({ corpora }).skillWhisperer.enabled, true, "a skills corpus turns it on by default");
  assert.equal(resolveConfig({ corpora, skillWhisperer: {} }).skillWhisperer.enabled, true);
  assert.equal(resolveConfig({ corpora, skillWhisperer: { enabled: false } }).skillWhisperer.enabled, false);
  assert.throws(
    () => resolveConfig({ skillWhisperer: { historyMessages: -1 } }),
    /non-negative integer/,
  );
  assert.throws(() => resolveConfig({ skillWhisperer: { minScore: 1.1 } }), /between 0 and 1/);
  assert.throws(
    () => resolveConfig({ skillWhisperer: { cooldownTurns: 1.5 } }),
    /non-negative integer/,
  );
  assert.throws(() => resolveConfig({ skillWhisperer: { extra: true } }), /unknown property/);
});

test("validates and trims named file corpora", () => {
  assert.deepEqual(
    resolveConfig({
      corpora: [
        { name: " memory ", kind: "files", paths: [" MEMORY.md "] },
        { name: " projects ", kind: "files", paths: [" ../shared/**/*.md "] },
      ],
    }).corpora,
    [
      { name: "memory", kind: "files", paths: ["MEMORY.md"] },
      { name: "projects", kind: "files", paths: ["../shared/**/*.md"] },
    ],
  );
});

test("validates the optional sessions corpus and defaults its chat types", () => {
  const memory = { name: "memory", kind: "files", paths: ["MEMORY.md"] };
  assert.deepEqual(
    resolveConfig({
      corpora: [
        memory,
        {
          name: "sessions",
          kind: "sessions",
        },
      ],
    }).corpora,
    [
      memory,
      {
        name: "sessions",
        kind: "sessions",
        chatTypes: ["channel", "group"],
        maxExpandedTokens: 500,
        syncIntervalMinutes: 5,
      },
    ],
  );
  assert.deepEqual(
    resolveConfig({
      corpora: [
        memory,
        {
          name: "sessions",
          kind: "sessions",
          chatTypes: ["direct", "direct"],
        },
      ],
    }).corpora[1],
    {
      name: "sessions",
      kind: "sessions",
      chatTypes: ["direct"],
      maxExpandedTokens: 500,
      syncIntervalMinutes: 5,
    },
  );
  assert.deepEqual(resolveConfig({
    corpora: [memory, {
      name: "sessions",
      kind: "sessions",
      maxExpandedTokens: 800,
    }],
  }).corpora[1], {
    name: "sessions",
    kind: "sessions",
    chatTypes: ["channel", "group"],
    maxExpandedTokens: 800,
    syncIntervalMinutes: 5,
  });
  assert.throws(() => resolveConfig({
    corpora: [memory, {
      name: "sessions",
      kind: "sessions",
      maxExpandedTokens: 10_001,
    }],
  }), /10000/);
});

test("analysis is opt-in and requires an absolute executable path", () => {
  assert.equal(resolveConfig(undefined).analysis.executable, undefined);
  assert.equal(resolveConfig({ analysis: {} }).analysis.executable, undefined);
  assert.equal(
    resolveConfig({ analysis: { executable: " /opt/unblock-memory-analysis " } }).analysis
      .executable,
    "/opt/unblock-memory-analysis",
  );
  assert.throws(
    () => resolveConfig({ analysis: { executable: "unblock-memory-analysis" } }),
    /absolute/,
  );
  assert.throws(() => resolveConfig({ analysis: { executable: "" } }), /absolute/);
  assert.throws(() => resolveConfig({ analysis: true }), /must be an object/);
  assert.throws(() => resolveConfig({ analysis: [] }), /must be an object/);
  assert.throws(() => resolveConfig({ analysis: { extra: true } }), /unknown property/);
});

test("rejects malformed or ambiguous corpora", () => {
  const memory = { name: "memory", kind: "files", paths: ["MEMORY.md"] };
  assert.throws(() => resolveConfig({ paths: ["MEMORY.md"] }), /unknown property: paths/);
  assert.throws(() => resolveConfig({ corpora: [] }), /non-empty array/);
  assert.throws(() => resolveConfig({ corpora: [{ ...memory, paths: [] }] }), /non-empty array/);
  assert.throws(
    () => resolveConfig({ corpora: [{ ...memory, kind: "sessions" }] }),
    /unknown property: paths/,
  );
  assert.throws(() => resolveConfig({ corpora: [{ ...memory, name: "all" }] }), /reserved/);
  assert.throws(
    () => resolveConfig({ corpora: [{ ...memory, name: "sessions" }] }),
    /must have kind "sessions"/,
  );
  assert.throws(
    () => resolveConfig({ corpora: [{ ...memory, name: "skills" }] }),
    /must have kind "skills"/,
  );
  assert.throws(() => resolveConfig({ corpora: [{ ...memory, extra: true }] }), /unknown property/);
  assert.throws(
    () =>
      resolveConfig({
        corpora: [memory, { ...memory, paths: ["other.md"] }],
      }),
    /unique/,
  );
  assert.throws(
    () =>
      resolveConfig({
        corpora: [{ ...memory, name: "projects" }],
      }),
    /exactly one.*memory/,
  );
  assert.throws(() => resolveConfig({ corpora: "memory" }), /non-empty array/);
  assert.throws(
    () =>
      resolveConfig({
        corpora: [
          memory,
          {
            name: "sessions",
            kind: "sessions",
            chatTypes: ["private"],
          },
        ],
      }),
    /chatTypes/,
  );
  assert.throws(
    () =>
      resolveConfig({
        corpora: [
          memory,
          {
            name: "history",
            kind: "sessions",
          },
        ],
      }),
    /must be named "sessions"/,
  );
  assert.throws(
    () =>
      resolveConfig({
        corpora: [
          memory,
          {
            name: "abilities",
            kind: "skills",
            paths: ["skills/**/SKILL.md"],
          },
        ],
      }),
    /must be named "skills"/,
  );
});

test("memoryWhisperer.mode defaults to v2, accepts legacy, and keeps old fleet api/mlx configs loading", async () => {
  const validate = await manifestValidator("unblock-memory:test:memory-whisperer-mode");
  assert.equal(resolveConfig({}).memoryWhisperer.mode, "v2");
  assert.deepEqual(manifest.configSchema.properties.memoryWhisperer.properties.mode.enum, ["v2", "legacy"]);
  const fleet = { memoryWhisperer: { enabled: true, corpora: ["memory"],
    api: { endpoint: "http://192.168.1.191:18087", apiKeyFile: "/Users/agent/.openclaw/query-token" } } };
  const hosted = validate(fleet);
  assert.equal(hosted.ok, true, JSON.stringify(hosted.errors));
  const resolved = resolveConfig(hosted.value).memoryWhisperer;
  assert.equal(resolved.mode, "v2", "an old query endpoint does not opt back into legacy");
  assert.equal(resolved.api.endpoint, "http://192.168.1.191:18087");
  const deprecated = { memoryWhisperer: { mlx: { pythonPath: "/usr/bin/python3", modelPath: "/models/query" } } };
  assert.equal(validate(deprecated).ok, true);
  assert.equal(resolveConfig(deprecated).memoryWhisperer.mode, "v2");
  for (const mode of ["v2", "legacy"] as const) {
    assert.equal(validate({ memoryWhisperer: { mode } }).ok, true);
    assert.equal(resolveConfig({ memoryWhisperer: { mode } }).memoryWhisperer.mode, mode);
  }
  for (const mode of ["v1", "", "V2", 2]) {
    assert.equal(validate({ memoryWhisperer: { mode } }).ok, false, JSON.stringify(mode));
    assert.throws(() => resolveConfig({ memoryWhisperer: { mode } }), /memoryWhisperer\.mode/u);
  }
});

test("steward is optional and enabled by default; host manifest and runtime resolver agree on its shape", async () => {
  const validate = await manifestValidator("unblock-memory:test:steward");
  // Existing fleet configs carry no steward section: both host defaults and the runtime enable it by default.
  for (const fleet of [{}, { decisionModel: { enabled: true } }]) {
    const host = validate(fleet);
    assert.equal(host.ok, true);
    assert.deepEqual(host.value?.steward, { enabled: true });
    const steward = resolveConfig(host.value).steward;
    assert.equal(steward.enabled, true);
    assert.equal(steward.deepThought.enabled, true);
    assert.equal(steward.peopleShadow.enabled, true);
    assert.equal(steward.peopleShadow.includeInteractionLearning, undefined);
    assert.equal(steward.peopleShadow.includeResponseAudit, true);
    assert.deepEqual(steward.outcomeLedger, {
      enabled: true, intervalMinutes: 60, lookbackMs: 604_800_000, maxRowsPerPass: 0, matchWindowMs: 1_800_000, retentionDays: 0,
    }, "lateEvidenceRescanMs stays unset: the ledger's own two-day default applies");
    assert.deepEqual(steward.expectations, {
      enabled: true, intervalMinutes: 60, lookbackMinutes: 70, dueLeadMinutes: 60, sweepAfterMinutes: 1440, maxSessionsPerRun: 0,
      maxCharsPerSession: 0, maxSweepItems: 0, timeoutMs: 0, excludeChatTypes: ["direct"], extract: true, sweep: true, blockerAutoExpireMinutes: 4320,
    });
    assert.deepEqual(resolveConfig(fleet).steward, steward);
  }
  const enabled = {
    steward: {
      enabled: true, model: "gpt-6.2-sol", reasoning: "low", endpoint: "http://127.0.0.1:8787/v1/responses",
      apiKeyFile: "/run/secrets/steward", maxActiveBackground: 6,
      deepThought: {
        enabled: true, maxTurns: 25, maxToolCalls: 100, maxConcurrent: 8, timeoutMs: 300_000, syncWaitMs: 60_000, jobRetentionMs: 600_000,
        wrapUpReserveMs: 15_000, maxToolResultChars: 64_000, maxInputTokens: 200_000, searchRanking: "decision" as const, searchMinUsefulness: 0.25,
        defaultSearchResults: 15, maxSnippetChars: 4_000, maxQuoteChars: 1_200, maxPeopleMatches: 20, reasoning: "low" as const,
      },
      peopleShadow: {
        enabled: true, mode: "shadow" as const, intervalMinutes: 120, maxItemsPerRun: 5, timeoutMs: 30_000,
        minConfidence: "high" as const, maxHandles: 12, maxExcerptChars: 1000, maxExportBytes: 2_000_000,
        includeInteractionLearning: true, maxNewClaimsPerPerson: 3, maxInteractionHandles: 24, includeResponseAudit: false,
      },
      captainsLog: {
        enabled: true, intervalMinutes: 120, lookbackMinutes: 130, maxSessionsPerRun: 10,
        maxCharsPerSession: 8_000, maxExistingLogChars: 12_000, timeoutMs: 60_000, excludeChatTypes: ["direct" as const],
      },
      outcomeLedger: {
        enabled: false, intervalMinutes: 30, lookbackMs: 86_400_000, maxRowsPerPass: 5_000, matchWindowMs: 600_000, retentionDays: 90,
        lateEvidenceRescanMs: 0,
      },
      expectations: {
        enabled: false, intervalMinutes: 30, lookbackMinutes: 40, dueLeadMinutes: 0, sweepAfterMinutes: 0, maxSessionsPerRun: 10,
        maxCharsPerSession: 4_000, maxSweepItems: 25, timeoutMs: 45_000, excludeChatTypes: ["direct" as const, "group" as const],
        extract: false, sweep: false, blockerAutoExpireMinutes: 0,
      },
    },
  };
  const host = validate(enabled);
  assert.equal(host.ok, true, JSON.stringify(host.errors));
  const steward = resolveConfig(host.value).steward;
  assert.equal(steward.endpoint, "http://127.0.0.1:8787/v1/responses");
  assert.deepEqual(steward.deepThought, enabled.steward.deepThought);
  assert.deepEqual(steward.peopleShadow, enabled.steward.peopleShadow);
  assert.deepEqual(steward.captainsLog, enabled.steward.captainsLog);
  assert.deepEqual(steward.outcomeLedger, enabled.steward.outcomeLedger, "an explicit 0 rescan (= full lookback) is preserved");
  assert.deepEqual(steward.expectations, enabled.steward.expectations);
  for (const invalid of [
    { steward: { outcomeLedger: { lateEvidenceRescanMs: -1 } } },
    { steward: { outcomeLedger: { lateEvidenceRescanMs: 1.5 } } },
    { steward: { outcomeLedger: { lateEvidenceRescanMs: "0" } } },
    { steward: { expectations: { extra: true } } },
    { steward: { expectations: { enabled: "true" } } },
    { steward: { expectations: { intervalMinutes: 0 } } },
    { steward: { expectations: { lookbackMinutes: 0 } } },
    { steward: { expectations: { dueLeadMinutes: -1 } } },
    { steward: { expectations: { sweepAfterMinutes: -1 } } },
    { steward: { expectations: { maxSessionsPerRun: -1 } } },
    { steward: { expectations: { blockerAutoExpireMinutes: -1 } } },
    { steward: { expectations: { blockerAutoExpireMinutes: 1.5 } } },
    { steward: { expectations: { maxCharsPerSession: 1.5 } } },
    { steward: { expectations: { maxSweepItems: -1 } } },
    { steward: { expectations: { timeoutMs: -1 } } },
    { steward: { expectations: { excludeChatTypes: ["dm"] } } },
    { steward: { expectations: { excludeChatTypes: "direct" } } },
    { steward: { expectations: { extract: 1 } } },
    { steward: { expectations: { sweep: "yes" } } },
    { steward: { extra: true } },
    { steward: { deepThought: { extra: 1 } } },
    { steward: { deepThought: { maxTurns: -1 } } },
    { steward: { deepThought: { timeoutMs: -1 } } },
    { steward: { deepThought: { searchRanking: "hybrid" } } },
    { steward: { deepThought: { searchMinUsefulness: 1.5 } } },
    { steward: { deepThought: { defaultSearchResults: 0 } } },
    { steward: { peopleShadow: { intervalMinutes: 0 } } },
    { steward: { reasoning: "adaptive" } },
    { steward: { endpoint: "http://remote.example/v1/responses" } },
    { steward: { endpoint: "https://user:pass@remote.example/v1/responses" } },
    { steward: { apiKey: "two words" } },
    { steward: { maxActiveBackground: 0 } },
    { steward: { peopleShadow: { includeInteractionLearning: "yes" } } },
    { steward: { peopleShadow: { maxNewClaimsPerPerson: -1 } } },
    { steward: { peopleShadow: { maxInteractionHandles: 1.5 } } },
    { steward: { peopleShadow: { includeResponseAudit: 1 } } },
    { steward: { outcomeLedger: { extra: true } } },
    { steward: { outcomeLedger: { enabled: "true" } } },
    { steward: { outcomeLedger: { intervalMinutes: 0 } } },
    { steward: { outcomeLedger: { lookbackMs: 0 } } },
    { steward: { outcomeLedger: { maxRowsPerPass: -1 } } },
    { steward: { outcomeLedger: { matchWindowMs: 0 } } },
    { steward: { outcomeLedger: { retentionDays: -1 } } },
  ]) {
    assert.equal(validate(invalid).ok, false, JSON.stringify(invalid));
    assert.throws(() => resolveConfig(invalid), /steward/, JSON.stringify(invalid));
  }
});

test("expectationsWhisperer is on by default, preserves explicit 0 = unlimited, and host and runtime reject bad shapes", async () => {
  const validate = await manifestValidator("unblock-memory:test:expectations-whisperer");
  const defaults = { enabled: true, maxHints: 5, cooldownTurns: 10, dueLeadMs: 86_400_000, maxPayloadChars: 0, includeWorkspaceBlockers: true };
  assert.deepEqual(resolveConfig({}).expectationsWhisperer, defaults);
  const host = validate({});
  assert.equal(host.ok, true);
  assert.deepEqual(host.value?.expectationsWhisperer, { enabled: true });
  assert.deepEqual(resolveConfig(host.value).expectationsWhisperer, defaults);
  const zeros = { enabled: false, maxHints: 0, cooldownTurns: 0, dueLeadMs: 0, maxPayloadChars: 0, includeWorkspaceBlockers: false };
  assert.equal(validate({ expectationsWhisperer: zeros }).ok, true);
  assert.deepEqual(resolveConfig({ expectationsWhisperer: zeros }).expectationsWhisperer, zeros, "0 is never replaced by a default");
  assert.deepEqual(resolveConfig({ expectationsWhisperer: { maxHints: 2, maxPayloadChars: 4_000 } }).expectationsWhisperer,
    { ...defaults, maxHints: 2, maxPayloadChars: 4_000 });
  for (const expectationsWhisperer of [null, [], "on", { extra: 1 }, { enabled: "yes" }, { includeWorkspaceBlockers: 1 },
    { maxHints: -1 }, { cooldownTurns: 1.5 }, { dueLeadMs: "1" }, { maxPayloadChars: -5 }]) {
    assert.equal(validate({ expectationsWhisperer }).ok, false, JSON.stringify(expectationsWhisperer));
    assert.throws(() => resolveConfig({ expectationsWhisperer }), /expectationsWhisperer/u, JSON.stringify(expectationsWhisperer));
  }
  assert.throws(() => resolveConfig({ expectationsWhisperer: { maxHints: Number.MAX_SAFE_INTEGER + 1 } }), /expectationsWhisperer\.maxHints/u);
  // The whisperer participates in trigger allowlists, ordered just before safety.
  const triggers = { cron: ["safety", "expectations"], heartbeat: ["expectations"] };
  assert.equal(validate({ whispererTriggers: triggers }).ok, true);
  assert.deepEqual(resolveConfig({ whispererTriggers: triggers }).whispererTriggers,
    { cron: ["safety", "expectations"], subagent: [], heartbeat: ["expectations"] });
});

test("recipeHash defaults to \"default\", is trimmed, and derivedObservations defaults on for the Memory Whisperer", async () => {
  const validate = await manifestValidator("unblock-memory:test:recipe-hash");
  const corpora = [{ name: "memory", kind: "files", paths: ["MEMORY.md"] }, { name: "skills", kind: "skills", paths: ["skills/**/SKILL.md"] }];
  assert.equal(resolveConfig({}).memoryWhisperer.recipeHash, "default");
  assert.equal(resolveConfig({}).memoryWhisperer.derivedObservations, true);
  assert.equal(resolveConfig({ corpora }).skillWhisperer.recipeHash, "default");
  const configured = { corpora, memoryWhisperer: { recipeHash: " rr-b ", derivedObservations: false }, skillWhisperer: { recipeHash: "skills-b" } };
  const host = validate(configured);
  assert.equal(host.ok, true, JSON.stringify(host.errors));
  const resolved = resolveConfig(host.value);
  assert.equal(resolved.memoryWhisperer.recipeHash, "rr-b");
  assert.equal(resolved.memoryWhisperer.derivedObservations, false);
  assert.equal(resolved.skillWhisperer.recipeHash, "skills-b");
  assert.equal(resolveConfig(validate({}).value).memoryWhisperer.derivedObservations, true, "host defaults keep it on");
  for (const [section, value] of [["memoryWhisperer", { recipeHash: " " }], ["memoryWhisperer", { recipeHash: 7 }],
    ["memoryWhisperer", { recipeHash: "" }], ["memoryWhisperer", { derivedObservations: "yes" }],
    ["skillWhisperer", { recipeHash: "" }], ["skillWhisperer", { recipeHash: null }]] as const) {
    assert.equal(validate({ [section]: value }).ok, false, JSON.stringify({ [section]: value }));
    assert.throws(() => resolveConfig({ corpora, [section]: value }), new RegExp(section, "u"), JSON.stringify(value));
  }
});

test("memoryWhisperer derived-observation caps and thresholds are configurable through the manifest", async () => {
  const validate = await manifestValidator("unblock-memory:test:derived");
  const configured = { memoryWhisperer: { derivedMaxHints: 0, derivedMinTokenOverlap: 0.6, derivedMinSharedTokens: 3 } };
  const host = validate(configured);
  assert.equal(host.ok, true, JSON.stringify(host.errors));
  const resolved = resolveConfig(host.value).memoryWhisperer;
  assert.deepEqual([resolved.derivedMaxHints, resolved.derivedMinTokenOverlap, resolved.derivedMinSharedTokens], [0, 0.6, 3]);
  const defaults = resolveConfig({}).memoryWhisperer;
  assert.deepEqual([defaults.derivedMaxHints, defaults.derivedMinTokenOverlap, defaults.derivedMinSharedTokens], [2, 0.45, 2]);
  for (const invalid of [{ derivedMaxHints: -1 }, { derivedMaxHints: 1.5 }, { derivedMinTokenOverlap: 1.5 },
    { derivedMinTokenOverlap: -0.1 }, { derivedMinSharedTokens: 0 }, { derivedMinSharedTokens: "2" }]) {
    assert.equal(validate({ memoryWhisperer: invalid }).ok, false, JSON.stringify(invalid));
    assert.throws(() => resolveConfig({ memoryWhisperer: invalid }), /derived/u, JSON.stringify(invalid));
  }
});
