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
    ['{"training":{"leaseMs":9000}}', /heartbeats must be shorter/u],
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

test("training accepts only the isolated completion name derived from the configured teacher", t => {
  const { file, write } = overrideFixture(t);
  write(JSON.stringify({ training: { teacherModel: "custom/replacement-teacher", candidatesPerRound: 2 } }));
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { trainingTeacher } from "./src/training-models.ts";
    let model = "replacement-teacher";
    const teacher = trainingTeacher({ llm: { async complete(request) {
      assert.equal(request.model, "custom/replacement-teacher");
      return { model, execution: { mode: "isolated-agent-runtime" }, text: '{"queries":["one","two"]}' };
    } } }, "main");
    const input = { history: [], currentRequest: "Recall the decision." };
    assert.deepEqual((await teacher(input, "lex")).queries, ["one", "two"]);
    model = "gpt-6-luna";
    await assert.rejects(teacher(input, "lex"), /requires isolated replacement-teacher output/u);
  `], { env: { ...process.env, UNBLOCK_MEMORY_DEFAULTS_FILE: file }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});
