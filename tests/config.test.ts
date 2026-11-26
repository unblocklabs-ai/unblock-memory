import assert from "node:assert/strict";
import test from "node:test";
import { LEGACY_SYSTEMONE_ENDPOINT } from "@unblocklabs/decisions";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { DEFAULT_CORPORA, DEFAULT_PEOPLE_CONFIG, resolveConfig } from "../src/config.js";

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

test("host and runtime reject the old provider key and unsafe endpoint forms", async () => {
  const { validateJsonSchemaValue } = await import(import.meta.resolve("openclaw/plugin-sdk/json-schema-runtime")) as {
    validateJsonSchemaValue: (args: {
      schema: Record<string, unknown>;
      cacheKey: string;
      value: unknown;
      applyDefaults?: boolean;
    }) => { ok: boolean; value?: Record<string, unknown>; errors?: unknown[] };
  };
  const validate = (value: unknown) => validateJsonSchemaValue({
    schema: manifest.configSchema,
    cacheKey: "unblock-memory:test:manifest",
    value,
    applyDefaults: true,
  });
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
