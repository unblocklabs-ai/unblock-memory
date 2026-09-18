// On-host v1/v2 comparison. No raw conversation text is emitted.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
const [baseline, candidate] = process.argv.slice(2);
assert.ok(baseline && candidate);
const load = directory => {
  const db = new DatabaseSync(`${directory}/agents/main/unblock-memory/response-audit.sqlite`, { readOnly: true });
  try { return new Map(db.prepare("SELECT id,result FROM response_results WHERE status='ok' AND active=1").all()
    .map(row => [row.id, JSON.parse(row.result)])); }
  finally { db.close(); }
};
const before = load(baseline), after = load(candidate);
const beforeOutcome = (await import(pathToFileURL(`${baseline}/package/dist/src/response-outcome.js`))).responseOutcome;
const afterOutcome = (await import(pathToFileURL(`${candidate}/package/dist/src/response-outcome.js`))).responseOutcome;
const evidence = JSON.parse(await readFile(`${candidate}/evidence.json`, "utf8"));
const overlapping = [...before.keys()].filter(id => after.has(id));
const counts = (data, ids) => ids.reduce((count, id) => {
  const r = data.get(id), q = r.quality;
  const fulfillmentOK = q.assessability.choice === "assessable" && q.assessability.confidence >= 0.8;
  const fit = q.fitAssessability ?? q.assessability;
  count.fulfillment += Number(fulfillmentOK && q.fulfillment.confidence >= 0.8);
  count.deliverableFit += Number(fit.choice === "assessable" && fit.confidence >= 0.8 && q.deliverableFit.confidence >= 0.8);
  count.laterCorrections += Number((r.retrospective?.judgment?.correction.noul ?? 0) >= 0.8);
  count.deliveryAdmissions += Number((r.retrospective?.judgment?.deliveryAdmission.noul ?? 0) >= 0.8);
  count.reportedMemoryGaps += Number(r.feedback.memoryGap.noul >= 0.8);
  count.clearUnderdelivery += Number((q.underdelivery?.noul ?? 0) >= 0.8);
  return count;
}, { fulfillment: 0, deliverableFit: 0, clearUnderdelivery: 0, laterCorrections: 0, deliveryAdmissions: 0, reportedMemoryGaps: 0 });
const originalReport = JSON.parse(await readFile(`${baseline}/live-results.json`, "utf8"));
const originalFlags = originalReport.report.examples.map(({ id }) => {
  const r = after.get(id), e = evidence.find(e => e.id === id);
  return { id, retained: !!r, ...(r ? { target: r.feedback.target, memoryGap: r.feedback.memoryGap.noul,
    sentiment: r.feedback.sentiment, retrospective: r.retrospective, followupMessages: e.followup.messages.length,
    fitAssessability: r.quality.fitAssessability, contextLimited: e.contextLimited } : {}) };
});
const dirty = evidence.filter(e => [...e.before, ...e.request, ...e.feedback].some(m =>
  m.text.includes("⟦openclaw:ctx⟧") || /^Chat history since last reply:/m.test(m.text))).length;
assert.equal(dirty, 0, "Transport/history envelope survived extraction");
const result = { baseline: before.size, candidate: after.size, overlapping: overlapping.length,
  removed: [...before.keys()].filter(id => !after.has(id)), added: [...after.keys()].filter(id => !before.has(id)),
  matchedBefore: counts(before, overlapping), matchedAfter: counts(after, overlapping),
  allAfter: counts(after, [...after.keys()]), dirty, originalFlags,
  changedOutcomes: overlapping.flatMap(id => {
    const previous = beforeOutcome(before.get(id)), current = afterOutcome(after.get(id));
    return previous.status === current.status ? [] : [{ id, before: previous, after: current }];
  }),
  limitation: "Same-ID development comparison of audit judgments; not a held-out benchmark or evidence that the agent's actual performance changed." };
await writeFile(`${candidate}/comparison.json`, JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(result));
