import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CORPORA, resolveConfig } from "../src/config.js";

test("uses the canonical memory corpus when corpora are absent", () => {
  assert.deepEqual(resolveConfig(undefined).corpora, DEFAULT_CORPORA);
  assert.deepEqual(resolveConfig({}).corpora, DEFAULT_CORPORA);
});

test("validates and trims named file corpora", () => {
  assert.deepEqual(resolveConfig({
    corpora: [
      { name: " memory ", kind: "files", paths: [" MEMORY.md "] },
      { name: " projects ", kind: "files", paths: [" ../shared/**/*.md "] },
    ],
  }).corpora, [
    { name: "memory", kind: "files", paths: ["MEMORY.md"] },
    { name: "projects", kind: "files", paths: ["../shared/**/*.md"] },
  ]);
});

test("validates the optional sessions corpus and defaults its chat types", () => {
  const memory = { name: "memory", kind: "files", paths: ["MEMORY.md"] };
  assert.deepEqual(resolveConfig({ corpora: [memory, {
    name: "sessions",
    kind: "sessions",
  }] }).corpora, [memory, {
    name: "sessions",
    kind: "sessions",
    chatTypes: ["channel", "group"],
  }]);
  assert.deepEqual(resolveConfig({ corpora: [memory, {
    name: "sessions",
    kind: "sessions",
    chatTypes: ["direct", "direct"],
  }] }).corpora[1], {
    name: "sessions",
    kind: "sessions",
    chatTypes: ["direct"],
  });
});

test("analysis is opt-in and requires an absolute executable path", () => {
  assert.equal(resolveConfig(undefined).analysis.executable, undefined);
  assert.equal(resolveConfig({ analysis: {} }).analysis.executable, undefined);
  assert.equal(resolveConfig({ analysis: { executable: " /opt/unblock-memory-analysis " } }).analysis.executable, "/opt/unblock-memory-analysis");
  assert.throws(() => resolveConfig({ analysis: { executable: "unblock-memory-analysis" } }), /absolute/);
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
  assert.throws(() => resolveConfig({ corpora: [{ ...memory, kind: "sessions" }] }), /unknown property: paths/);
  assert.throws(() => resolveConfig({ corpora: [{ ...memory, name: "all" }] }), /reserved/);
  assert.throws(() => resolveConfig({ corpora: [{ ...memory, name: "sessions" }] }), /must have kind "sessions"/);
  assert.throws(() => resolveConfig({ corpora: [{ ...memory, extra: true }] }), /unknown property/);
  assert.throws(() => resolveConfig({
    corpora: [memory, { ...memory, paths: ["other.md"] }],
  }), /unique/);
  assert.throws(() => resolveConfig({
    corpora: [{ ...memory, name: "projects" }],
  }), /exactly one.*memory/);
  assert.throws(() => resolveConfig({ corpora: "memory" }), /non-empty array/);
  assert.throws(() => resolveConfig({ corpora: [memory, {
    name: "sessions", kind: "sessions", chatTypes: ["private"],
  }] }), /chatTypes/);
  assert.throws(() => resolveConfig({ corpora: [memory, {
    name: "history", kind: "sessions",
  }] }), /must be named "sessions"/);
});
