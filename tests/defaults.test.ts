import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadOperationalDefaults } from "../src/defaults.js";

function overrideFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "unblock-defaults-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "overrides.json");
  return { directory, file, write: (text: string) => writeFileSync(file, text) };
}

test("source and built defaults resolve the bundled file from another working directory and merge startup overrides", t => {
  const { directory, file, write } = overrideFixture(t);
  write(JSON.stringify({ extraction: { proposalTimeoutMs: 950, minSupport: 0.82 }, memoryWhisperer: { defaultApiEndpoint: "https://query.example" } }));
  const root = new URL("../", import.meta.url);
  // Resolve the test runner from the repo, not from the unrelated cwd.
  const tsx = import.meta.resolve("tsx");
  for (const path of ["src/defaults.ts", "dist/src/defaults.js"]) {
    const run = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", `
      const { DEFAULTS } = await import(process.argv[1]);
      console.log(JSON.stringify([DEFAULTS.extraction.proposalTimeoutMs, DEFAULTS.extraction.validationTimeoutMs,
        DEFAULTS.extraction.minSupport, DEFAULTS.decisionModel.model, DEFAULTS.memoryWhisperer.defaultApiEndpoint]));
    `, new URL(path, root).href], {
      cwd: directory, env: { ...process.env, UNBLOCK_MEMORY_DEFAULTS_FILE: file }, encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [950, 10_000, 0.82, "liquid/d1.2-ultra", "https://query.example"]);
  }
});

test("operational override files reject malformed JSON, unknown keys and invalid values", t => {
  const { file, write } = overrideFixture(t);
  assert.throws(() => loadOperationalDefaults("relative.json"), /absolute/u);
  for (const [content, expected] of [
    ["{", /Cannot load operational defaults/u],
    ["[]", /expected an object/u],
    ['{"extraction":{"unknown":1}}', /Unknown operational default extraction.unknown/u],
    ['{"__proto__":{"polluted":true}}', /Unknown operational default __proto__/u],
    ['{"extraction":{"proposalTimeoutMs":"30000"}}', /extraction.proposalTimeoutMs/u],
    ['{"decisionModel":{"timeoutMs":0}}', /decisionModel.timeoutMs/u],
    ['{"extraction":{"minProposalConfidence":1.01}}', /extraction.minProposalConfidence/u],
    ['{"extraction":{"inputTargetTokens":31000}}', /token budgets conflict/u],
    ['{"extraction":{"leaseMs":9000}}', /heartbeat must be shorter/u],
    ['{"memoryWhisperer":{"defaultApiEndpoint":"file:///tmp/query"}}', /memoryWhisperer.defaultApiEndpoint/u],
    ['{"skillWhisperer":{"maxDirectCatalogSkills":0}}', /skillWhisperer.maxDirectCatalogSkills/u],
    ['{"skillWhisperer":{"catalogBatchSize":81}}', /skillWhisperer.catalogBatchSize/u],
    ['{"skillWhisperer":{"maxMatchesPerTurn":1.5}}', /skillWhisperer.maxMatchesPerTurn/u],
    ['{"skillWhisperer":{"maxActiveSkillsPerSession":0}}', /skillWhisperer.maxActiveSkillsPerSession/u],
    ['{"skillWhisperer":{"maxInjectedChars":32001}}', /skillWhisperer.maxInjectedChars/u],
    ['{"skillWhisperer":{"maxDescriptionChars":0}}', /skillWhisperer.maxDescriptionChars/u],
    ['{"skillWhisperer":{"sessionRetentionDays":-1}}', /skillWhisperer.sessionRetentionDays/u],
  ] as const) {
    write(content);
    assert.throws(() => loadOperationalDefaults(file), expected);
  }
});

test("a retired top-level training section in an override file is ignored, not rejected", t => {
  const { file, write } = overrideFixture(t);
  write(JSON.stringify({ training: { queryModel: "old", epochs: 3 }, memoryWhisperer: { planningTimeoutMs: 1200 } }));
  const loaded = loadOperationalDefaults(file);
  assert.equal(loaded.memoryWhisperer.planningTimeoutMs, 1200, "the rest of the file still applies");
  assert.equal(Object.hasOwn(loaded, "training"), false);
  write('{"extraction":{"training":1}}');
  assert.throws(() => loadOperationalDefaults(file), /Unknown operational default extraction.training/u,
    "only the retired top-level section is ignored");
  write('{"memoryWhisperer":{"planningTimeoutMs":0}}');
  assert.throws(() => loadOperationalDefaults(file), /memoryWhisperer.planningTimeoutMs/u);
});

test("decision pack limits are bounded startup overrides", t => {
  const { file, write } = overrideFixture(t);
  const limits = {
    extraction: {
      replacementOptionsPerChoice: 20,
      replacementBatchSize: 5,
      replacementBatchMaxPayloadBytes: 60_000,
      validatorBatchSize: 4,
      validatorBatchMaxStateBytes: 240_000,
    },
    review: { maxRedundancyPairs: 6, maxRedundancyStateBytes: 24_000 },
    quality: { judgeBatchSize: 6, judgeBatchMaxStateBytes: 18_000 },
    people: { primerBatchSize: 4, primerBatchMaxStateBytes: 16_000 },
  } as const;
  write("{}");
  const bundled = loadOperationalDefaults(file);
  for (const section of Object.keys(limits) as (keyof typeof limits)[]) {
    for (const [key, max] of Object.entries(limits[section])) {
      assert.equal(Object.entries(bundled[section]).find(([name]) => name === key)?.[1], max);
      const writeLimit = (value: number) => write(JSON.stringify({ [section]: { [key]: value } }));
      writeLimit(max - 1);
      assert.equal(Object.entries(loadOperationalDefaults(file)[section]).find(([name]) => name === key)?.[1], max - 1);
      for (const invalid of [0, max + 1]) {
        writeLimit(invalid);
        assert.throws(() => loadOperationalDefaults(file), { message: `Invalid operational default ${section}.${key}: wrong type or out of range` });
      }
    }
  }
});

test("deprecated decision pack limits normalize to byte keys without hiding conflicting overrides", t => {
  const { file, write } = overrideFixture(t);
  for (const [section, alias, key] of [
    ["extraction", "replacementBatchMaxChars", "replacementBatchMaxPayloadBytes"],
    ["extraction", "validatorBatchMaxChars", "validatorBatchMaxStateBytes"],
    ["review", "maxRedundancyChars", "maxRedundancyStateBytes"],
    ["quality", "judgeBatchMaxChars", "judgeBatchMaxStateBytes"],
    ["people", "primerBatchMaxChars", "primerBatchMaxStateBytes"],
  ] as const) {
    for (const patch of [{ [alias]: 4096 }, { [alias]: 4096, [key]: 4096 }]) {
      write(JSON.stringify({ [section]: patch }));
      const resolved = loadOperationalDefaults(file)[section];
      assert.equal(Object.entries(resolved).find(([name]) => name === key)?.[1], 4096);
      assert.equal(Object.hasOwn(resolved, alias), false);
    }
    write(JSON.stringify({ [section]: { [alias]: 4096, [key]: 4097 } }));
    assert.throws(() => loadOperationalDefaults(file), {
      message: `Conflicting operational defaults ${section}.${alias} and ${section}.${key}`,
    });
  }
});

test("hardening limits preserve the bundled operational values", t => {
  const { file, write } = overrideFixture(t);
  write("{}");
  const limits = loadOperationalDefaults(file);
  assert.partialDeepStrictEqual(limits, {
    memoryWhisperer: {
      judgeConversationMaxTokens: 4096, judgeConversationMaxBytes: 24_000, memoryGetDefaultLines: 120,
      fallbackMaxLexTerms: 12, fallbackMaxTermChars: 64, fallbackMaxLexChars: 256,
      fallbackMaxVecChars: 450, fallbackHistoryUserMessages: 2,
    },
    people: {
      primerRequestTimeoutMs: 30_000, learningStartupRetryMs: 5000, learningReconcileRetryMs: 60_000,
      learningStartupRetryLimit: 8, slackTokenMaxChars: 10_000, slackIdMaxChars: 200, slackHandleMaxChars: 200,
      slackCursorMaxChars: 2000, slackAvatarUrlMaxChars: 2000, slackDisplayNameMaxChars: 500,
    },
    sqlite: { skillSessionBusyTimeoutMs: 100 },
    responseAudit: {
      maxFollowupChars: 12_000, maxFollowupMessages: 6, maxFeedbackMessages: 6, memoryCandidateMaxDocChars: 2000,
      memoryCandidateLimit: 3, memoryQueryMaxTerms: 16, memoryQueryMinTermChars: 4,
    },
    analysis: { memberExcerptMaxBytes: 2000, totalExcerptMaxBytes: 12_000, clusterPreviewMaxBytes: 600 },
  });
});

test("host-validated people primer config defers to the operational timeout unless explicitly set", t => {
  const { file, write } = overrideFixture(t);
  write(JSON.stringify({ people: { primerRequestTimeoutMs: 4321 } }));
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
    import { resolveConfig } from "./src/config.ts";
    import manifest from "./openclaw.plugin.json" with { type: "json" };
    for (const [value, expected] of [[{}, 4321], [{ peoplePrimer: {} }, 4321], [{ peoplePrimer: { timeoutMs: 2345 } }, 2345]]) {
      const host = validateJsonSchemaValue({ schema: manifest.configSchema, cacheKey: "unblock-memory:test:primer-timeout",
        value, applyDefaults: true });
      assert.equal(host.ok, true, JSON.stringify(host.errors));
      assert.equal(resolveConfig(host.value).peoplePrimer.timeoutMs, expected);
    }
  `], { env: { ...process.env, UNBLOCK_MEMORY_DEFAULTS_FILE: file }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});
