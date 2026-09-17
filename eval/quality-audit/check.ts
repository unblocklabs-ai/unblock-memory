// Synthetic cases only; never reads corpus data. Default invocation makes no API calls.
import { judgeTypeSafeQuality } from "../../src/typesafe.js";
import { qualityStructure } from "../../src/quality-audit.js";

const cases = [
  { name: "json-policy", review: false, text: '{"environment":"staging","retentionDays":14,"owner":"platform"}' },
  { name: "code", review: false, text: "Retry policy: await retry(job, { attempts: 3, backoffMs: 250 }); // avoid concurrent index writes" },
  { name: "old-decision", review: false, text: "2024-02-10: chose PostgreSQL over SQLite because the first deployment needed concurrent writers. This describes the decision at the time." },
  { name: "fragment", review: false, text: "That only applies to the other account, not this one." },
  { name: "error-log", review: false, text: "2026-03-02 14:42 ERROR payments: duplicate idempotency key on order 321. Customer was charged once; second request rejected." },
  { name: "preference", review: false, text: "Jamie prefers written summaries before meetings." },
  { name: "transport-noise", review: true, text: Array.from({ length: 12 }, (_, i) =>
    `event: heartbeat_ack\ntrace_id: opaque-${i}\nmessage_id: null\ncontent: null\nusage: null\n`).join("\n") },
  { name: "escaped-envelope", review: true, text: JSON.stringify(JSON.stringify({
    type: "message", role: "user", content: [{ type: "text", text: "Release Orion only after approval." }],
    request_id: "opaque", parent_id: "opaque", delivery_metadata: { status: "ack", attempts: 1 },
    usage: { input_tokens: 0, output_tokens: 0 }, trace: { sampled: false, span_id: "opaque" },
  })) },
];

async function main() {
  if (!process.argv.slice(2).includes("--live")) {
    console.log(`${cases.length} synthetic quality-audit cases. Use --live with TYPESAFE_API_KEY for inference.`);
    return;
  }
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required");
  const rows = [];
  const started = Date.now();
  for (let offset = 0; offset < cases.length; offset += 4) {
    const batch = cases.slice(offset, offset + 4);
    const answers = await judgeTypeSafeQuality({ apiKey, timeoutMs: 10_000,
      signal: new AbortController().signal,
      chunks: batch.map(item => ({ text: item.text, sourceKind: "files" })),
    });
    rows.push(...batch.map((item, i) => ({ name: item.name, expectedReview: item.review,
      ...answers[i], structure: qualityStructure(item.text),
      review: answers[i].noise >= 0.8 || qualityStructure(item.text) === "encoded_message" })));
  }
  console.log(JSON.stringify({ elapsedMs: Date.now() - started, rows }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Quality check failed");
  process.exitCode = 1;
});
