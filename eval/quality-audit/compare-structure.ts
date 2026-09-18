// Explicit on-host comparison. Never writes to the production index or curation store.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type * as TypeSafe from "../../src/typesafe.js";

const history = Type.Array(Type.Object({ role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]), content: Type.String() }));
const casesSchema = Type.Array(Type.Union([
  Type.Object({ kind: Type.Literal("quality"), id: Type.String(), cohort: Type.String(), corpus: Type.String(),
    text: Type.String(), sourceKind: Type.Union([Type.Literal("files"), Type.Literal("sessions")]),
    expected: Type.Optional(Type.Boolean()), structuralFlag: Type.Boolean() }),
  Type.Object({ kind: Type.Literal("skill"), id: Type.String(), currentRequest: Type.String(), history,
    candidates: Type.Array(Type.Object({ name: Type.String(), description: Type.String() })), expected: Type.Array(Type.String()) }),
  Type.Object({ kind: Type.Literal("memory"), id: Type.String(),
    conversation: Type.Object({ currentRequest: Type.String(), history, truncated: Type.Boolean() }),
    candidates: Type.Array(Type.Object({ excerpt: Type.String(), corpus: Type.String() })), expected: Type.Array(Type.Boolean()) }),
]));
type Case = Static<typeof casesSchema>[number];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function main() {
  const [baselinePath, structuredPath, casesPath, outputPath, configPath] = process.argv.slice(2);
  if (!baselinePath || !structuredPath || !casesPath || !outputPath || !configPath) {
    throw new Error("Usage: compare-structure baseline-module structured-module cases.json output.jsonl openclaw.json");
  }
  process.umask(0o077);
  const baseline: typeof TypeSafe = await import(pathToFileURL(resolve(baselinePath)).href);
  const structured: typeof TypeSafe = await import(pathToFileURL(resolve(structuredPath)).href);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const apiKey = await baseline.resolveTypeSafeApiKey(config.plugins.entries["unblock-memory"].config.typesafe);
  if (!apiKey) throw new Error("No TypeSafe key configured");
  const raw: unknown = JSON.parse(await readFile(casesPath, "utf8"));
  if (!Value.Check(casesSchema, raw)) throw new Error("Invalid comparison fixtures");
  const cases = raw;
  const jobs: Case[][] = [];
  const quality = cases.filter(item => item.kind === "quality");
  for (let i = 0; i < quality.length; i += 4) jobs.push(quality.slice(i, i + 4));
  for (const item of cases.filter(item => item.kind !== "quality")) jobs.push([item]);
  const fixtureHash = hash(JSON.stringify(cases));
  const moduleHashes = {
    baseline: hash(await readFile(baselinePath, "utf8")),
    structured: hash(await readFile(structuredPath, "utf8")),
  };
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  // Exclusive output creation prevents accidental mixing of separate runs.
  await appendFile(outputPath, JSON.stringify({ type: "metadata", fixtureHash, moduleHashes,
    cases: cases.length, jobs: jobs.length, repeats: 2, timeoutMs: 10_000, startedAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
  const realFetch = globalThis.fetch;
  let trace: { stateHash?: string; requestBytes?: number; usage?: unknown; model?: unknown } = {};
  globalThis.fetch = async (url, init) => {
    const body = String(init?.body);
    const request = JSON.parse(body);
    trace.stateHash = hash(JSON.stringify(request.state));
    trace.requestBytes = Buffer.byteLength(body);
    const response = await realFetch(url, init);
    if (response.ok) {
      const payload = await response.clone().json() as { usage?: unknown; model?: unknown };
      trace.usage = payload.usage;
      trace.model = payload.model;
    }
    return response;
  };
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const [index, job] of jobs.entries()) {
        const order = (index + repeat) % 2 ? ["structured", "baseline"] as const : ["baseline", "structured"] as const;
        for (const arm of order) {
          const module = arm === "baseline" ? baseline : structured;
          trace = {};
          const start = performance.now();
          const common = { apiKey, timeoutMs: 10_000, signal: new AbortController().signal };
          const first = job[0];
          let outputs: unknown;
          if (first.kind === "quality") {
            const chunks = job.map(item => {
              if (item.kind !== "quality") throw new Error("Mixed job");
              return { text: item.text, sourceKind: item.sourceKind };
            });
            const answers = await module.judgeTypeSafeQuality({ ...common, chunks });
            outputs = answers.map((answer, i) => {
              const item = job[i];
              if (item.kind !== "quality") throw new Error("Mixed job");
              return { id: item.id, corpus: item.corpus, cohort: item.cohort, ...answer,
                flagged: item.structuralFlag || answer.noise >= 0.8, expected: item.expected };
            });
          } else if (first.kind === "skill") {
            const picked = await module.selectTypeSafeSkill({ ...common, ...first });
            const name = picked === undefined ? "none" : first.candidates[picked].name;
            outputs = [{ id: first.id, selected: name,
              correct: first.expected.length ? first.expected.includes(name) : name === "none" }];
          } else {
            const answers = await module.judgeTypeSafeMemories({ ...common, ...first });
            outputs = answers.map((probability, i) => ({ id: `${first.id}:${i}`, probability,
              included: probability >= 0.9, expected: first.expected[i], correct: (probability >= 0.9) === first.expected[i] }));
          }
          await appendFile(outputPath, JSON.stringify({ type: "result", repeat, job: index, arm, kind: first.kind,
            elapsedMs: Math.round(performance.now() - start), ...trace, outputs }) + "\n");
        }
        if ((index + 1) % 20 === 0) console.log(JSON.stringify({ repeat, jobsCompleted: index + 1, totalJobs: jobs.length }));
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(JSON.stringify({ complete: true, outputPath }));
}

main().catch(() => { console.error("Comparison failed; partial output retained, no prediction substituted."); process.exitCode = 1; });
