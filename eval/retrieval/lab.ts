import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@unblocklabs/qmd";
import { QmdMemoryManager } from "../../src/manager.js";
import { resolveSources } from "../../src/sources.js";
import { defaultContextChars, syntheticCases, syntheticDocuments, validateDataset, type FrozenDocument, type FrozenRetrievalCase } from "./cases.js";
import { aggregateScores, quantile, scoreArm, type RetrievalHit, type RetrievalRun } from "./scoring.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

function parseArgs(): { out?: string; repeat: number } {
  const args = process.argv.slice(2);
  let out: string | undefined;
  let repeat = 2;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--out") {
      out = args[++index];
      if (!out) throw new Error("--out requires a directory");
      continue;
    }
    if (arg === "--repeat") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 20) throw new Error("--repeat must be an integer from 1 to 20");
      repeat = value;
      continue;
    }
    throw new Error("Usage: lab.ts [--repeat N] [--out DIRECTORY]");
  }
  return { out, repeat };
}

async function writePrivate(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function makeCorpus(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "unblock-memory-retrieval-lab-"));
  for (const document of syntheticDocuments) {
    const path = join(workspace, document.path);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    await writePrivate(path, document.body);
  }
  return workspace;
}

export async function runArm(
  name: string,
  retrieve: (query: string) => Promise<readonly RetrievalHit[]>,
  cases: readonly FrozenRetrievalCase[],
  documents: readonly FrozenDocument[],
  repeat: number,
  setupError?: string,
) {
  let warmupMs: number | null = null;
  if (!setupError) {
    const started = performance.now();
    try {
      await retrieve(cases[0]?.query ?? "warm up retrieval");
    } catch {
      setupError = "warmup_failed";
    }
    warmupMs = performance.now() - started;
  }
  const runs: Record<string, RetrievalRun> = {};
  const successfulLatenciesMs: number[] = [];
  let failedTrials = 0;
  for (const item of cases) {
    if (setupError) {
      runs[item.id] = { status: "error", hits: [], latencyMs: 0, error: setupError };
      continue;
    }
    for (let trial = 0; trial < repeat; trial += 1) {
      const started = performance.now();
      let run: RetrievalRun;
      try {
        const hits = await retrieve(item.query);
        run = { status: "ok", hits, latencyMs: performance.now() - started };
      } catch {
        run = { status: "error", hits: [], latencyMs: performance.now() - started, error: "retrieval_failed" };
      }
      if (run.status === "ok") successfulLatenciesMs.push(run.latencyMs);
      else failedTrials += 1;
      // Never substitute a later successful trial for a failed quality prediction.
      if (trial === 0) runs[item.id] = run;
    }
  }
  return { name, warmupMs, trials: setupError ? 0 : repeat, setupError: setupError ?? null,
    runs, successfulLatenciesMs, failedTrials,
    scored: scoreArm(cases, new Map(Object.entries(runs)), documents) };
}

type ArmReport = Awaited<ReturnType<typeof runArm>>;

function format(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

async function readQmdPackageIdentity(): Promise<{ name: string; version: string }> {
  const parsed = JSON.parse(await readFile(join(root, "node_modules/@unblocklabs/qmd/package.json"), "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || !("name" in parsed) || !("version" in parsed) ||
      typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    throw new Error("QMD package metadata must contain string name and version");
  }
  return { name: parsed.name, version: parsed.version };
}

function markdownReport(indexMs: number, arms: readonly ArmReport[]): string {
  const lines = ["# Retrieval lab", "", "Synthetic corpus: 6 answerable and 2 no-answer cases. Not a product-quality claim.", "",
    `- Setup + embedding/indexing: ${Math.round(indexMs)} ms; warmup and failed trials are excluded from query percentiles.`,
    `- Context budget: ${defaultContextChars} excerpt characters per case unless overridden in inputs.json (sync-plan: 520).`,
    "- All arms share one isolated index and exact collection-qualified source identities. Labels are not sent to retrieval.", "",
    "| Arm | Evidence-group recall | Complete coverage | MRR | Citation integrity | Forbidden evidence (labeled cases) | No-answer empty | Warm p50 ms | Warm p95 ms | Quality errors | Successful / failed trials |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  for (const arm of arms) {
    const aggregate = arm.scored.aggregate;
    lines.push(`| ${arm.name} | ${format(aggregate.evidenceGroupRecall)} | ${format(aggregate.completeCoverage)} | ${format(aggregate.meanReciprocalRank)} | ${format(aggregate.citationIntegrityRate)} | ${format(aggregate.forbiddenEvidenceRate)} | ${format(aggregate.noAnswerEmptyRate)} | ${format(quantile(arm.successfulLatenciesMs, 0.5))} | ${format(quantile(arm.successfulLatenciesMs, 0.95))} | ${aggregate.errors} | ${arm.successfulLatenciesMs.length} / ${arm.failedTrials} |`);
  }
  lines.push("", "## Split breakdown", "", "| Arm | Split | Evidence-group recall | Complete coverage | MRR | Errors |", "|---|---|---:|---:|---:|---:|");
  for (const arm of arms) for (const split of ["dev", "holdout"] as const) {
    const aggregate = aggregateScores(arm.scored.cases.filter(score => score.split === split));
    lines.push(`| ${arm.name} | ${split} | ${format(aggregate.evidenceGroupRecall)} | ${format(aggregate.completeCoverage)} | ${format(aggregate.meanReciprocalRank)} | ${aggregate.errors} |`);
  }
  lines.push("", "## Interpretation", "",
    "- vector@5 and vector@20 use the unchanged production manager with the normal 0.3 cutoff; lexical uses its whole-document BM25 path.",
    "- hybrid@20 calls QMD search with rerank:false, limit:20, candidateLimit:20 and minScore:0. QMD owns discovery, deduplication and local rank fusion; no TypeSafe call.",
    "- Hybrid's rank-fusion scores are not vector similarities: compare evidence at equal context budgets, not numeric score thresholds. Internal retrieval breadth is SDK-owned, not an equal-compute ablation.",
    "- All repeat trials include result construction. First trials determine quality; successful repeats measure query latency, not independent quality observations.",
    "- Citation integrity checks source spans, not generated answers. Nonempty no-answer retrieval is not automatically a false answer.");
  for (const arm of arms) if (arm.setupError) lines.push(`- ${arm.name} unavailable: ${arm.setupError}; no quality or latency claim.`);
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  validateDataset();
  const { out, repeat } = parseArgs();
  const reportDir = resolve(out ?? join(root, "reports", "retrieval-lab", new Date().toISOString().replace(/[:.]/g, "-")));
  // Do not overwrite an earlier run or quietly reopen its index.
  await mkdir(resolve(reportDir, ".."), { recursive: true, mode: 0o700 });
  await mkdir(reportDir, { mode: 0o700 });
  const workspace = await makeCorpus();
  const sources = resolveSources(workspace, [{ name: "memory", kind: "files", paths: ["memory/**/*.md"] }]);
  const source = sources[0]!;
  // Bind the frozen documents once to the exact addresses used by every arm.
  const documents = syntheticDocuments.map(document => ({ ...document,
    path: `qmd://${source.collection}/${relative(source.root, join(workspace, document.path))}` }));
  validateDataset(documents, syntheticCases);
  const indexStarted = performance.now();
  const dbPath = join(reportDir, "index.sqlite");
  const store = await createStore({ dbPath, keepModelsWarm: true, config: {
    collections: { [source.collection]: { path: source.root, pattern: source.pattern } },
  } });
  let managerOwnsStore = false;
  const manager = new QmdMemoryManager({ dbPath, workspaceDir: workspace, sources,
    storeFactory: async () => { managerOwnsStore = true; return store; } });
  const arms: ArmReport[] = [];
  let indexError: string | undefined;
  try {
    try {
      // Match normal manager initialization before its collection-scoped sync.
      const initialized = await store.embed({ chunkStrategy: "semantic" });
      if (initialized.errors) throw new Error("Semantic chunk initialization failed");
      await manager.sync();
    } catch (error) {
      indexError = "index_setup_failed";
      console.error("Retrieval lab setup failed:", error);
    }
    const indexMs = performance.now() - indexStarted;
    for (const limit of [5, 20]) {
      arms.push(await runArm(`vector@${limit}`, query => manager.search(query, {
        corpora: ["memory"], maxResults: limit, minScore: 0.3,
      }), syntheticCases, documents, repeat, indexError));
    }
    arms.push(await runArm("lexical", query => manager.search(query, {
      corpora: ["memory"], lexicalOnly: true, maxResults: 20, minScore: -1,
    }), syntheticCases, documents, repeat, indexError));
    arms.push(await runArm("hybrid@20", async query => {
      const results = await store.search({ query, collection: source.collection,
        rerank: false, limit: 20, candidateLimit: 20, minScore: 0 });
      return results.map(hit => {
        const startLine = hit.body.slice(0, hit.bestChunkPos).split("\n").length;
        return { path: hit.file, snippet: hit.bestChunk, score: hit.score, startLine,
          endLine: startLine + hit.bestChunk.split("\n").length - 1 };
      });
    }, syntheticCases, documents, repeat, indexError));
    const metadata = {
      version: 2,
      generatedAt: new Date().toISOString(),
      gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      qmdPackage: await readQmdPackageIdentity(),
      embeddingModel: store.internal.llm?.embedModelName ?? null,
      caseCount: syntheticCases.length, documentCount: documents.length, repeat,
      defaultContextChars, indexMs, indexError: indexError ?? null,
    };
    await writePrivate(join(reportDir, "inputs.json"), JSON.stringify({ metadata, documents, cases: syntheticCases }, null, 2));
    await writePrivate(join(reportDir, "results.json"), JSON.stringify(arms, null, 2));
    await writePrivate(join(reportDir, "README.md"), markdownReport(indexMs, arms));
    console.log(`Retrieval lab report: ${reportDir}`);
    for (const arm of arms) console.log(`${arm.name}: recall=${format(arm.scored.aggregate.evidenceGroupRecall)} complete=${format(arm.scored.aggregate.completeCoverage)} p50=${format(quantile(arm.successfulLatenciesMs, 0.5))}ms`);
  } finally {
    await manager.close();
    if (!managerOwnsStore) await store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
