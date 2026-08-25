import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PATHS, resolveConfig } from "../src/config.js";

test("uses canonical defaults only when paths are absent", () => {
  assert.deepEqual(resolveConfig(undefined).paths, DEFAULT_PATHS);
  assert.deepEqual(resolveConfig({ paths: [" ../shared/**/*.md "] }).paths, [
    "../shared/**/*.md",
  ]);
  assert.deepEqual(resolveConfig({ paths: [] }).paths, []);
});

test("analysis is opt-in and requires an absolute executable path", () => {
  assert.equal(resolveConfig(undefined).analysis.executable, undefined);
  assert.equal(resolveConfig({ analysis: {} }).analysis.executable, undefined);
  assert.equal(resolveConfig({ analysis: { executable: " /opt/unblock-memory-analysis " } }).analysis.executable, "/opt/unblock-memory-analysis");
  assert.throws(() => resolveConfig({ analysis: { executable: "unblock-memory-analysis" } }), /absolute/);
  assert.throws(() => resolveConfig({ analysis: { executable: "" } }), /absolute/);
  assert.throws(() => resolveConfig({ analysis: true }), /must be an object/);
});

test("rejects malformed path settings", () => {
  assert.throws(() => resolveConfig({ paths: [""] }), /non-empty strings/);
  assert.throws(() => resolveConfig({ paths: "memory" }), /array/);
});
