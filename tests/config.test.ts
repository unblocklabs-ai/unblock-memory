import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CORPORA, DEFAULT_PEOPLE_CONFIG, resolveConfig } from "../src/config.js";

test("uses the canonical memory corpus when corpora are absent", () => {
  assert.deepEqual(resolveConfig(undefined).corpora, DEFAULT_CORPORA);
  assert.deepEqual(resolveConfig({}).corpora, DEFAULT_CORPORA);
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

test("keeps skill whispering disabled by default and validates its lean controls", () => {
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
  assert.throws(() => resolveConfig({ skillWhisperer: { enabled: true } }), /requires.*skills/);
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
