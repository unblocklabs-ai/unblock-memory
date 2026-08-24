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

test("rejects malformed path settings", () => {
  assert.throws(() => resolveConfig({ paths: [""] }), /non-empty strings/);
  assert.throws(() => resolveConfig({ paths: "memory" }), /array/);
});
