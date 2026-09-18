// Read-only on-host evidence view for manual calibration. Never reads credentials.
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
const [directory, selection = "flags", offset = "0"] = process.argv.slice(2);
const outcomeModule = await import(pathToFileURL(`${directory}/package/dist/src/response-outcome.js`)).catch(() => null);
const outcomeOf = r => outcomeModule?.responseOutcome(r) ?? { status: r.retrospective.judgment?.outcome?.confidence >= 0.8 ? r.retrospective.judgment.outcome.choice : "uncertain" };
const db = new DatabaseSync(`${directory}/agents/main/unblock-memory/response-audit.sqlite`, { readOnly: true });
const results = new Map(db.prepare("SELECT id,result FROM response_results WHERE status='ok' AND active=1").all()
  .map(r => [r.id, JSON.parse(r.result)]));
db.close();
const evidence = JSON.parse(await readFile(`${directory}/evidence.json`, "utf8"));
const flagged = r => outcomeOf(r).status === "reported_shortfall" ||
  r.retrospective.judgment?.correction.noul >= 0.8 || r.retrospective.judgment?.deliveryAdmission.noul >= 0.8 ||
  (r.feedback.sentiment.choice === "dissatisfied" && r.feedback.sentiment.confidence >= 0.8) || r.quality.underdelivery.noul >= 0.8;
const counts = {};
for (const r of results.values()) {
  const label = outcomeOf(r).status;
  counts[label] = (counts[label] ?? 0) + 1;
}
console.log(JSON.stringify({ total: results.size, counts }));
const selected = evidence.filter(e => {
  const r = results.get(e.id);
  return r && (selection === "flags" ? flagged(r) : selection === "sample" ? !flagged(r) : e.id.startsWith(selection));
}).slice(Number(offset), Number(offset) + (selection.length > 10 ? 1 : 6));
const text = (messages, limit) => messages.map(m => m.text).join("\n\n").slice(0, limit);
for (const e of selected) {
  const r = results.get(e.id);
  console.log(JSON.stringify({ id: e.id, date: new Date(e.timestamp).toISOString(),
    request: text(e.request, 1500), answer: text(e.answer, selection.length > 10 ? 18000 : 2500),
    feedback: text(e.feedback, 2200), next: text(e.followup.messages, selection.length > 10 ? 14000 : 2000),
    outcome: Object.fromEntries(Object.entries(r.retrospective.judgment ?? {}).map(([k, v]) => [k, v.type === "noul" ? v.noul : [v.choice, v.confidence]])), originalUnderdelivery: r.quality.underdelivery.noul,
    composed: outcomeOf(r),
    feedbackTarget: r.feedback.target.choice, sentiment: r.feedback.sentiment.choice }));
}
