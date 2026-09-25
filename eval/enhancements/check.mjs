// Synthetic labeled cases only. Uses the real API; no private corpus or raw answers in logs.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
const [pluginRoot, keyFile, output] = process.argv.slice(2);
assert.ok(pluginRoot && keyFile && output, "PLUGIN_ROOT KEY_FILE NEW_OUTPUT_DIRECTORY");
const { resolveTypeSafeApiKey } = await import(pathToFileURL(`${pluginRoot}/dist/src/typesafe-client.js`));
const { reviewTypeSafeClaim, reviewMemoryRedundancy, complementaryIndices, reviewClusterDefects } = await import(pathToFileURL(`${pluginRoot}/dist/src/typesafe-review.js`));
const apiKey = await resolveTypeSafeApiKey({ enabled: true, apiKeyFile: keyFile, timeoutMs: 10000 });
assert.ok(apiKey, "TypeSafe key not configured");
await mkdir(output, { mode: 0o700 });
const params = { apiKey, timeoutMs: 10000, signal: AbortSignal.timeout(120000) };
const cases = [
  { id: "duplicate_then_distinct", excerpts: ["Atlas staging rollout requires Ava's approval.", "Ava must approve before Atlas staging is rolled out.", "Atlas staging must use the EU region."], expected: [0, 2] },
  { id: "contradiction", excerpts: ["On September 18, Ava approved Atlas production.", "On September 19, Ava revoked approval for Atlas production."], expected: [0, 1] },
  { id: "different_person", excerpts: ["Ava prefers email updates.", "Ben prefers email updates."], expected: [0, 1] },
  { id: "qualification", excerpts: ["Atlas may launch on Friday.", "Atlas launched on Friday."], expected: [0, 1] },
  { id: "region", excerpts: ["Atlas is deployed in eu-west-1.", "Atlas is deployed in eu-central-1."], expected: [0, 1] },
  { id: "condition", excerpts: ["Deploy after approval.", "Deploy after approval and a passing security review."], expected: [0, 1] },
  { id: "numeric", excerpts: ["Atlas retries failed requests three times.", "Atlas retries failed requests five times."], expected: [0, 1] },
  { id: "negation", excerpts: ["Ava approved the rollout.", "Ava did not approve the rollout."], expected: [0, 1] },
  { id: "explicit_corroboration", excerpts: ["Ava observed the outage at noon.", "Ben independently observed the outage at noon."], expected: [0, 1] },
  { id: "deadline", excerpts: ["The report is due Friday.", "The report is due Friday at 9 AM Eastern."], expected: [0, 1] },
  { id: "another_duplicate", excerpts: ["Jules prefers concise written updates.", "Jules likes brief updates in writing.", "Jules is available after 2 PM."], expected: [0, 2] },
  { id: "directional_subset", excerpts: ["Atlas staging runs in Europe and needs Ava's approval.", "Atlas staging needs Ava's approval.", "Production requires Ben's approval."], expected: [0, 2] },
];
const report = { model: "jev-1.13.0", syntheticOnly: true, redundancy: [], claims: [], cluster: null };
for (const item of cases) {
  const start = performance.now();
  const pairs = await reviewMemoryRedundancy({ ...params, excerpts: item.excerpts });
  const selected = complementaryIndices(item.excerpts.length, pairs, 2);
  const baseline = item.excerpts.slice(0, 2).map((_text, i) => i);
  report.redundancy.push({ id: item.id, baseline, selected, expected: item.expected, pairs,
    passed: JSON.stringify(selected) === JSON.stringify(item.expected), milliseconds: Math.round(performance.now() - start) });
}
const evidence = ["Meeting record, September 18, 2026: Ava approved only the Atlas staging rollout for September 20, 2026. Ava explicitly rejected production deployment. Ben attended but did not approve any rollout. The team discussed a possible EU rollout; no decision was made about region."];
for (const [id, claim, expected] of [
  ["supported", "Ava approved Atlas staging for September 20, 2026.", "supports"],
  ["wrong_person", "Ben approved Atlas staging.", "contradicts"],
  ["wrong_date", "Ava approved Atlas staging for September 21, 2026.", "contradicts"],
  ["wrong_scope", "Ava approved Atlas production.", "contradicts"],
  ["negation", "Ava did not approve Atlas staging.", "contradicts"],
  ["unsupported", "Ava prefers written status reports.", "insufficient_evidence"],
  ["certainty", "The team decided to deploy in the EU.", "contradicts"],
]) {
  const start = performance.now();
  const result = await reviewTypeSafeClaim({ ...params, claim, evidence });
  report.claims.push({ id, expected, ...result, passed: result.verdict === expected,
    milliseconds: Math.round(performance.now() - start) });
}
const excerpts = [
  "[Internal task completion event]\nsource: subagent\nsession_key: abc\nsession_id: def\ntype: subagent task\nstatus: complete\nStats: runtime 2s • tokens 20\nAction: Convert the result into a user-facing update; keep this notification private.",
  "[Internal task completion event]\nsource: subagent\nsession_key: ghi\nsession_id: jkl\ntype: subagent task\nstatus: complete\nStats: runtime 3s • tokens 30\nAction: Convert the result into a user-facing update; keep this notification private.",
  "Decision: Production deploys require Ava's written approval, even if staging passed.",
  '{"retryCount":3,"region":"eu-west-1"}',
];
const judgments = await reviewClusterDefects({ ...params, excerpts });
report.cluster = { judgments, passed: judgments[0].defect === judgments[1].defect && judgments[0].defect !== "none_or_uncertain" &&
  judgments[2].defect === "none_or_uncertain" && judgments[3].defect === "none_or_uncertain" };
const passed = report.redundancy.every(item => item.passed) && report.claims.every(item => item.passed) && report.cluster.passed;
await writeFile(`${output}/results.json`, JSON.stringify({ ...report, passed }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ passed, redundancyPassed: report.redundancy.filter(item => item.passed).length,
  redundancyCases: cases.length, claimsPassed: report.claims.filter(item => item.passed).length,
  claimCases: report.claims.length, clusterPassed: report.cluster.passed,
  redundancyMilliseconds: report.redundancy.map(item => item.milliseconds), output }));
if (!passed) process.exitCode = 1;
