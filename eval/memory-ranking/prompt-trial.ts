/** Isolated prompt experiment: frozen state, one independent request per unique input. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveConfig } from "../../src/config.js";
import { requestTypeSafe, resolveTypeSafeApiKey, TYPESAFE_MODEL, TypeSafeRequestError } from "../../src/typesafe-client.js";

type Input = { id: string; state: unknown };
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const { values } = parseArgs({ options: { inputs: { type: "string" }, questions: { type: "string" },
  config: { type: "string" }, out: { type: "string" }, live: { type: "boolean", default: false } } });
if (!values.live || !values.inputs || !values.questions || !values.config || !values.out)
  throw new Error("prompt-trial.ts --live --inputs FROZEN.jsonl --questions PROMPT.json --config HOST.json --out NEW_DIR");
const questions: unknown = JSON.parse(readFileSync(values.questions, "utf8"));
const question = record(record(questions)?.memory_0);
if (!question || question.type !== "noul" || Object.keys(record(questions)!).length !== 1)
  throw new Error("Prompt-only trials must retain the single memory_0 Noul question");
const inputs = readFileSync(values.inputs, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Input);
if (!inputs.length || new Set(inputs.map(i => i.id)).size !== inputs.length || inputs.some(i => i.id !== hash(i.state)))
  throw new Error("Frozen input IDs must be unique state hashes");
const host = record(JSON.parse(readFileSync(values.config, "utf8")));
const config = resolveConfig(record(record(record(host?.plugins)?.entries)?.["unblock-memory"])?.config);
const apiKey = await resolveTypeSafeApiKey(config.typesafe);
if (!apiKey) throw new Error("TypeSafe credential unavailable");
process.umask(0o077);
mkdirSync(values.out, { mode: 0o700 });
const out = values.out;
const save = (file: string, v: unknown) => writeFileSync(join(out, file), JSON.stringify(v, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const append = (v: unknown) => appendFileSync(join(out, "judgments.jsonl"), JSON.stringify(v) + "\n", { mode: 0o600 });
save("manifest.json", { startedAt: new Date().toISOString(), model: TYPESAFE_MODEL, inputs: inputs.length,
  inputHash: hash(inputs), promptHash: hash(questions), timeoutMs: config.typesafe.timeoutMs,
  stateMode: "frozen-production-state-no-query-rank-score-or-reference-label", concurrency: inputs.length });
save("questions.json", questions);
let completed = 0, failed = 0, inputTokens = 0, outputTokens = 0;
const started = performance.now();
await Promise.all(inputs.map(async input => {
  const requestStarted = performance.now();
  append({ id: input.id, status: "attempted" });
  try {
    const payload = await requestTypeSafe({ apiKey, timeoutMs: config.typesafe.timeoutMs }, input.state, questions);
    const response = record(payload), answers = record(response?.answers), answer = record(answers?.memory_0);
    const score = answer?.noul;
    if (!answers || Object.keys(answers).length !== 1 || answer?.type !== "noul" ||
      typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1)
      throw new TypeSafeRequestError("Invalid memory judgment", "invalid_response");
    const usage = record(response?.usage);
    inputTokens += typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
    outputTokens += typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
    append({ id: input.id, status: "complete", score, elapsedMs: performance.now() - requestStarted, usage });
    completed++;
  } catch (error) {
    append({ id: input.id, status: "failed", elapsedMs: performance.now() - requestStarted,
      error: error instanceof TypeSafeRequestError ? error.code : "unexpected",
      ...(error instanceof TypeSafeRequestError && error.status ? { httpStatus: error.status } : {}) });
    failed++;
  }
}));
const summary = { completed, failed, elapsedMs: performance.now() - started, inputTokens, outputTokens };
save("summary.json", summary);
console.log(JSON.stringify(summary));
if (failed) process.exitCode = 1;
