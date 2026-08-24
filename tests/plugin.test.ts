import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveFlushPlan } from "../src/plugin.js";

test("flush plan honors disable, thresholds, model, and agent timezone", () => {
  const disabled = {
    agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
  } satisfies OpenClawConfig;
  assert.equal(resolveFlushPlan({ cfg: disabled }), null);

  const configured = {
    agents: {
      defaults: {
        userTimezone: "America/Los_Angeles",
        compaction: {
          memoryFlush: {
            softThresholdTokens: 1234,
            forceFlushTranscriptBytes: "3mb",
            model: "local/fast",
          },
        },
      },
    },
  } satisfies OpenClawConfig;
  const plan = resolveFlushPlan({
    cfg: configured,
    nowMs: Date.parse("2026-08-24T02:00:00Z"),
  });
  assert.equal(plan?.relativePath, "memory/2026-08-23.md");
  assert.equal(plan?.softThresholdTokens, 1234);
  assert.equal(plan?.forceFlushTranscriptBytes, 3 * 1024 * 1024);
  assert.equal(plan?.model, "local/fast");
});
