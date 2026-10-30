import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "../../src/config.js";
import { resolveSafetyWhisperer } from "../../src/safety-config.js";
import { registerSafetyWhisperer } from "../../src/safety-whisperer.js";
import { TYPESAFE_MODEL } from "../../src/typesafe-client.js";
import { cases, scenarios } from "./cases.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const thresholds = [0.3, 0.4, 0.5, 0.7];

const ids = new Set(cases.map(c => c.id));
if (ids.size !== cases.length) throw new Error("case ids must be unique");
for (const c of cases) {
  if (c.expected.some(id => !scenarios.some(s => s.id === id))) throw new Error(`${c.id} expects an unknown scenario`);
}
if (!process.argv.includes("--live")) {
  console.log(`${cases.length} cases over ${scenarios.length} scenarios are valid; pass --live to call TypeSafe.`);
  process.exit(0);
}

// Production path: real config resolver, identity filtering, history shaping and request. minProbability 0
// keeps every probability visible; thresholds are applied below.
const safetyWhisperer = resolveSafetyWhisperer({ enabled: true, timeoutMs: 10_000, scenarios: scenarios.map(s => ({ ...s, minProbability: 0 })) });
const api = {
  config: { plugins: { entries: { "unblock-memory": { hooks: { allowConversationAccess: true } } } }, messages: { queue: { mode: "followup" } } },
  logger: { warn: (message: string) => console.error(message) },
  on() {},
} as unknown as OpenClawPluginApi;
const before = registerSafetyWhisperer(api, { ...resolveConfig({}), safetyWhisperer, typesafe: { enabled: true, timeoutMs: 10_000 } })!;

const realFetch = globalThis.fetch;
let answers: Record<string, { noul: number }> | undefined;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const response = await realFetch(...args);
  answers = (await response.clone().json() as { answers?: Record<string, { noul: number }> }).answers;
  return response;
};

const rows: ((typeof cases)[number] & { probabilities: Record<string, number>; elapsedMs: number })[] = [];
for (const [index, c] of cases.entries()) {
  answers = undefined;
  const started = performance.now();
  await before({ prompt: c.prompt, messages: c.history ?? [] }, { trigger: "user", agentId: "eval", sessionId: `eval-${index}`,
    runId: `eval-${index}`, messageProvider: "slack", accountId: "eval", senderId: "U_EVAL", chatId: "C_EVAL" });
  if (!answers) throw new Error(`${c.id}: no TypeSafe answers; see warnings above`);
  const probabilities = Object.fromEntries(scenarios.map((s, i) => [s.id, answers![`scenario_${i}`].noul]));
  rows.push({ ...c, probabilities, elapsedMs: Math.round(performance.now() - started) });
}

const summary = thresholds.map(threshold => {
  const errors: string[] = [];
  for (const row of rows) for (const s of scenarios) {
    const expected = row.expected.includes(s.id), flagged = row.probabilities[s.id] >= threshold;
    if (expected !== flagged) errors.push(`${row.id}/${s.id}: ${flagged ? "false positive" : "missed"} (${row.probabilities[s.id].toFixed(3)})`);
  }
  return { threshold, errors };
});

console.log(`model ${TYPESAFE_MODEL}; ${rows.length} cases\n`);
console.log("| case | expected | " + scenarios.map(s => s.id).join(" | ") + " | ms |");
console.log("| --- | --- | " + scenarios.map(() => "---").join(" | ") + " | --- |");
for (const row of rows) {
  console.log(`| ${row.id} | ${row.expected.join(", ") || "none"} | ` +
    scenarios.map(s => row.probabilities[s.id].toFixed(3)).join(" | ") + ` | ${row.elapsedMs} |`);
}
for (const { threshold, errors } of summary) {
  console.log(`\nthreshold ${threshold}: ${errors.length} errors${errors.length ? "\n  " + errors.join("\n  ") : ""}`);
}
const directory = join(root, "reports", "safety-whisperer");
await mkdir(directory, { recursive: true });
const file = join(directory, `${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
await writeFile(file, JSON.stringify({ model: TYPESAFE_MODEL, rows, summary }, null, 2));
console.log(`\nreport: ${file}`);
