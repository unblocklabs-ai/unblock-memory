import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "../src/config.js";
import { registerPeopleCli } from "../src/people-cli.js";

const peopleConfig: UnblockMemoryConfig["people"] = {
  enabled: true,
  refinement: { maxPeoplePerRun: 2 },
  whisperer: { enabled: true, maxChars: 1200 },
  todos: { maxOpen: 10 },
};

test("registers a lazy plugin-owned CLI command for operator automation", () => {
  let descriptors: unknown;
  const api = {
    registerCli(_registrar: unknown, options: { descriptors?: unknown }) {
      descriptors = options.descriptors;
    },
  } as unknown as OpenClawPluginApi;

  registerPeopleCli(api, peopleConfig, async () => ({ results: [] }));

  assert.deepEqual(descriptors, [
    {
      name: "unblock-memory",
      description: "Unblock Memory administration",
      hasSubcommands: true,
    },
  ]);
});
