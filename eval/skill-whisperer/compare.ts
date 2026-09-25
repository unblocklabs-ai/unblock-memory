import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { QmdMemoryManager } from "../../src/manager.js";
import { resolveSources } from "../../src/sources.js";
import { buildSkillWhispererQuery } from "../../src/skill-whisperer.js";
import { cases } from "./cases.js";
import { selectTypeSafeSkill } from "../../src/typesafe.js";
import { TYPESAFE_MODEL } from "../../src/typesafe-client.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const model = TYPESAFE_MODEL;
const minScore = 0.5;
const shortlistSize = 3;
const inputPricePerMillion = 0.042; // Published pricing, checked 2026-09-17.

const rosterSchema = Type.Array(Type.Object({
  name: Type.String(), description: Type.String(), source: Type.String(),
}));
const usageSchema = Type.Object({
  usage: Type.Object({ input_tokens: Type.Integer({ minimum: 0 }), output_tokens: Type.Integer({ minimum: 0 }) }),
});
type ApiResult = { choice: string; elapsedMs: number; requests: number; failed: number;
  usage: { input_tokens: number; output_tokens: number } };
type Row = {
  id: string; kind: string; prompt: string; expected: string[];
  history: { role: "user" | "assistant"; content: string }[];
  vectorMs: number; candidates: { name: string; score: number }[];
  baseline: string; hybrid?: ApiResult; direct?: ApiResult;
};

function quantile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0);
}
function correct(row: Row, choice: string) {
  return row.expected.length ? row.expected.includes(choice) : choice === "none";
}
function selected(row: Row, arm: "baseline" | "hybrid" | "direct") {
  return arm === "baseline" ? row.baseline : row[arm]?.choice;
}

async function main() {
  const raw: unknown = JSON.parse(await readFile(new URL("roster.json", import.meta.url), "utf8"));
  if (!Value.Check(rosterSchema, raw)) throw new Error("Invalid roster fixture");
  const roster = raw;
  const names = new Set(roster.map(skill => skill.name));
  if (names.size !== roster.length || names.has("none")) throw new Error("Duplicate/reserved skill names");
  if (new Set(cases.map(item => item.id)).size !== cases.length) throw new Error("Duplicate case IDs");
  for (const item of cases) for (const label of item.expected) {
    if (!names.has(label)) throw new Error(`Unknown fixture label: ${label}`);
  }
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--live")) throw new Error("Usage: compare.ts [--live]");
  if (!args.includes("--live")) {
    console.log(`${cases.length} synthetic cases, ${roster.length} snapshotted skills. No API calls made.`);
    console.log(`Use --live for local embeddings and up to ${cases.length * (shortlistSize + roster.length)} independent TypeSafe requests. No conversation logs are read.`);
    return;
  }
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error("Set TYPESAFE_API_KEY using --env-file=.env");
  const reportDir = resolve(root, "reports", "skill-whisperer", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(reportDir, { recursive: true });
  const workspaceDir = join(reportDir, "workspace");
  for (const skill of roster) {
    const directory = join(workspaceDir, "skills", skill.name);
    await mkdir(directory, { recursive: true });
    // Normalize YAML to single-line metadata so both selectors receive identical descriptions.
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${skill.description.replace(/\s+/g, " ")}\n---\n`);
  }
  const manager = new QmdMemoryManager({
    workspaceDir, dbPath: join(reportDir, "index.sqlite"),
    sources: resolveSources(workspaceDir, [{ name: "skills", kind: "skills", paths: ["skills/**/SKILL.md"] }]),
  });
  const rows: Row[] = [];
  const metadata = {
    model, minScore, shortlistSize, historyMessages: 5, inputPricePerMillion,
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    fixtureHash: createHash("sha256").update(JSON.stringify({ roster, cases })).digest("hex"),
    selectorHash: createHash("sha256").update(await readFile(new URL("../../src/typesafe.ts", import.meta.url))).digest("hex"),
    qmdPackage: JSON.parse(await readFile(join(root, "node_modules/@unblocklabs/qmd/package.json"), "utf8")).version as string,
    embeddingModelOverride: process.env.QMD_EMBED_MODEL ?? null,
    selector: "production-per-candidate-noul", roster, cases,
  };
  await writeFile(join(reportDir, "inputs.json"), JSON.stringify(metadata, null, 2));
  const checkpoint = () => writeFile(join(reportDir, "results.json"), JSON.stringify(rows, null, 2));

  async function ask(row: Row, candidates: string[]): Promise<ApiResult> {
    const skills = candidates.map(name => {
      const skill = roster.find(item => item.name === name)!;
      return { name, description: skill.description.replace(/\s+/g, " ") };
    });
    const started = performance.now();
    const nativeFetch = globalThis.fetch;
    const usage = { input_tokens: 0, output_tokens: 0 };
    const trace: { candidate: string; status?: number; elapsedMs?: number }[] = [];
    let failed = 0;
    globalThis.fetch = async (url, init) => {
      const start = performance.now();
      const item = { candidate: String(JSON.parse(String(init?.body)).state.candidate.name), status: 0, elapsedMs: 0 };
      trace.push(item);
      try {
        const response = await nativeFetch(url, init);
        item.status = response.status;
        if (response.ok) {
          const payload: unknown = await response.clone().json();
          if (Value.Check(usageSchema, payload)) {
            usage.input_tokens += payload.usage.input_tokens;
            usage.output_tokens += payload.usage.output_tokens;
          }
        }
        return response;
      } finally { item.elapsedMs = performance.now() - start; }
    };
    try {
      const index = await selectTypeSafeSkill({ apiKey: apiKey!, timeoutMs: 30_000,
        currentRequest: row.prompt, history: row.history, candidates: skills, onCandidateFailure: () => { failed++; } });
      return { choice: index === undefined ? "none" : skills[index].name,
        elapsedMs: performance.now() - started, requests: trace.length, failed, usage };
    } finally {
      globalThis.fetch = nativeFetch;
      await appendFile(join(reportDir, "attempts.jsonl"), trace.map(item => JSON.stringify({ caseId: row.id, ...item })).join("\n") + "\n");
    }
  }

  let coldStartMs = 0;
  try {
    const started = performance.now();
    console.log(`Reports: ${reportDir}\nWarming real QMD skill embeddings (may download the default model)...`);
    await manager.searchSkills("warm up the skill selector", -1, roster.length);
    coldStartMs = performance.now() - started;
    for (const item of cases) {
      const history = item.history ?? [];
      const started = performance.now();
      const candidates = await manager.searchSkills(buildSkillWhispererQuery(item.prompt, history, 5), -1, roster.length);
      const vectorMs = performance.now() - started;
      const row: Row = { ...item, history, vectorMs,
        candidates: candidates.map(({ name, score }) => ({ name, score })),
        baseline: candidates[0]?.score >= minScore ? candidates[0].name : "none" };
      rows.push(row);
      await checkpoint();
      // Each arm uses the production selector: one concurrent request per skill.
      row.hybrid = await ask(row, candidates.slice(0, shortlistSize).map(candidate => candidate.name));
      await checkpoint();
      row.direct = await ask(row, roster.map(skill => skill.name));
      await checkpoint();
      console.log(`${rows.length}/${cases.length} ${row.id}: vector=${row.baseline}, shortlist=${row.hybrid.choice}, direct=${row.direct.choice}`);
    }
  } finally {
    await manager.close();
  }
  const arms = ["baseline", "hybrid", "direct"] as const;
  const metrics = arms.map(arm => {
    const predictions = rows.map(row => ({ row, choice: selected(row, arm) ?? "ERROR" }));
    const latencies = rows.map(row => arm === "baseline" ? row.vectorMs : row[arm]!.elapsedMs + (arm === "hybrid" ? row.vectorMs : 0));
    const inputTokens = rows.reduce((sum, row) => sum + (arm === "baseline" ? 0 : row[arm]!.usage.input_tokens), 0);
    return { arm, correct: predictions.filter(({ row, choice }) => correct(row, choice)).length,
      falseHints: predictions.filter(({ row, choice }) => !row.expected.length && choice !== "none").length,
      wrongSkill: predictions.filter(({ row, choice }) => row.expected.length && choice !== "none" && !correct(row, choice)).length,
      missedSkill: predictions.filter(({ row, choice }) => row.expected.length && choice === "none").length,
      p50Ms: quantile(latencies, 0.5), p95Ms: quantile(latencies, 0.95), inputTokens,
      failedRequests: rows.reduce((sum, row) => sum + (arm === "baseline" ? 0 : row[arm]!.failed), 0),
      estimatedUsd: inputTokens / 1_000_000 * inputPricePerMillion };
  });
  const positive = rows.filter(row => row.expected.length);
  const top3Coverage = positive.filter(row => row.candidates.slice(0, shortlistSize).some(candidate => row.expected.includes(candidate.name))).length;
  const ungatedTop1Correct = rows.filter(row => correct(row, row.candidates[0]?.name ?? "none")).length;
  const thresholdSensitivity = [0, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6].map(threshold => ({
    threshold,
    correct: rows.filter(row => correct(row, (row.candidates[0]?.score ?? -1) >= threshold
      ? row.candidates[0].name : "none")).length,
  }));
  const summary = { ...metadata, coldStartMs, top3Coverage, positiveCases: positive.length,
    negativeCases: rows.length - positive.length, ungatedTop1Correct, thresholdSensitivity, metrics };
  await writeFile(join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));
  const lines = ["# Skill Whisperer comparison", "",
    `${rows.length} authored synthetic cases; ${roster.length} snapshotted skills. Pinned model: ${model}.`, "",
    "| Selector | Correct | False hint on no-skill | Wrong skill | Missed skill | p50 ms | p95 ms | Input tokens | Estimated USD |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...metrics.map(m => `| ${m.arm} | ${m.correct}/${rows.length} | ${m.falseHints} | ${m.wrongSkill} | ${m.missedSkill} | ${m.p50Ms} | ${m.p95Ms} | ${m.inputTokens} | ${m.estimatedUsd.toFixed(6)} |`), "",
    `Top-three retrieval coverage: ${top3Coverage}/${positive.length} positive cases. Ungated vector top-one accuracy: ${ungatedTop1Correct}/${rows.length}.`,
    `Cold local initialization + roster embedding: ${Math.round(coldStartMs)} ms, excluded from warm latency.`, "",
    "## Vector threshold sensitivity (post-hoc diagnostic, not held-out tuning)", "",
    ...thresholdSensitivity.map(item => `- Threshold ${item.threshold}: ${item.correct}/${rows.length} correct.`), "",
    "## Per-case results", "",
    "| Case | Kind | Accepted | Vector | Shortlist + TypeSafe | Full-roster TypeSafe |",
    "|---|---|---|---|---|---|",
    ...rows.map(row => `| ${row.id} | ${row.kind} | ${row.expected.join(', ') || 'none'} | ${row.baseline} | ${selected(row, 'hybrid')} | ${selected(row, 'direct')} |`), "",
    "## Interpretation limits", "",
    "- Labels and selection prompt were authored before calls, but this is a small synthetic smoke evaluation, not blinded or representative fleet traffic.",
    "- Hybrid uses the unthresholded top three. It deliberately replaces the 0.5 similarity gate; it is not merely a veto after that gate.",
    "- All arms see the same normalized descriptions and up to five prior messages. TypeSafe gets explicit currentRequest/history fields; vector search uses the production flattened query.",
    "- Uses the production per-skill usefulness threshold; no threshold was fitted to these cases. Highest qualifying probability wins, ties retain retrieval order.",
    "- Isolated fresh turns: cooldowns, path rejection, actual agent skill use, and downstream task success are not evaluated here.",
    "- Local skills are snapshots, not Bill's configured inventory. No private conversations, dossiers, or memory documents were transmitted.",
    "- Estimated cost uses successful responses and published input-token pricing, not an invoice; failed-request billing is unknown. Timings include HTTP overhead, not an SLA. No retries. attempts.jsonl records candidate-level statuses and latency.",
    "- Calls run in fixed vector/hybrid/direct order; cache, warm-up and time-of-run effects are not controlled. Do not infer a reliable speed advantage between API arms from this pass.",
  ];
  await writeFile(join(reportDir, "report.md"), lines.join("\n") + "\n");
  console.table(metrics);
  console.log(`Report: ${join(reportDir, "report.md")}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Comparison failed");
  process.exitCode = 1;
});
