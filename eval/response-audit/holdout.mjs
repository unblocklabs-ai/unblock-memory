// On-host blind calibration: freeze new-session evidence, label BEFORE inference,
// then score once. Never call agent-reviewed labels human ground truth.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
const [mode, plugin, stateRoot, directory, baseline, senderId] = process.argv.slice(2);
assert.ok(["prepare", "score"].includes(mode) && plugin && stateRoot && directory && baseline && senderId);
const load = path => readFile(path, "utf8").then(JSON.parse);
const imp = name => import(pathToFileURL(`${plugin}/dist/src/${name}.js`));
const { resolveConfig } = await imp("config");
const host = await load(`${stateRoot}/openclaw.json`);
const config = resolveConfig({ ...host.plugins.entries["unblock-memory"].config,
  responseAudit: { enabled: true, senderIds: [senderId], chatTypes: ["direct", "channel"], historyMessages: 6, lookbackDays: 90 } });
const evidencePath = `${directory}/holdout-evidence.json`;
if (mode === "prepare") {
  const known = await load(`${baseline}/evidence.json`);
  const excludedSessions = new Set(known.map(e => e.session.sessionId));
  const { ResponseTranscriptReader } = await imp("response-episodes");
  const path = `${stateRoot}/agents/main/agent/openclaw-agent.sqlite`;
  const db = new DatabaseSync(path, { readOnly: true });
  const since = Date.now() - 90 * 86400_000;
  const ids = db.prepare(`SELECT w.session_id FROM session_windows w
    JOIN conversations c ON c.conversation_id=w.primary_conversation_id
    WHERE COALESCE(w.channel,c.channel)='slack' AND w.chat_type IN ('direct','channel')
    AND EXISTS (SELECT 1 FROM transcript_events e JOIN session_transcript_active_events a
      ON a.session_id=e.session_id AND a.event_seq=e.seq WHERE e.session_id=w.session_id
      AND e.created_at>=? AND json_extract(e.event_json,'$.message.role')='user'
      AND json_extract(e.event_json,'$.message.__openclaw.senderId')=?)
    ORDER BY w.session_id LIMIT 500`).all(since, senderId);
  db.close();
  const reader = new ResponseTranscriptReader(path, "main"), candidates = [];
  let inspected = 0;
  try {
    for (const row of ids) {
      if (excludedSessions.has(row.session_id)) continue;
      if (++inspected > 200) break;
      const snapshot = reader.read(String(row.session_id), config.responseAudit);
      candidates.push(...(snapshot?.episodes ?? []).filter(e => e.timestamp >= since));
    }
  } finally { reader.close(); }
  // Sample independent sessions deterministically, without looking at model scores.
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  const selected = [], selectedSessions = new Set();
  for (const e of candidates) {
    if (selectedSessions.has(e.session.sessionId)) continue;
    selected.push(e); selectedSessions.add(e.session.sessionId);
    if (selected.length === 12) break;
  }
  assert.ok(selected.length, "No fresh eligible sessions; do not relabel development examples as held out");
  await writeFile(evidencePath, JSON.stringify(selected, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ selected: selected.length, candidates: candidates.length, inspected, excludedSessions: excludedSessions.size }));
} else {
  const raw = await readFile(evidencePath, "utf8"), evidence = JSON.parse(raw);
  const labels = await load(`${directory}/holdout-labels.json`);
  assert.equal(labels.evidenceSha256, createHash("sha256").update(raw).digest("hex"));
  assert.ok(["human", "agent"].includes(labels.reviewerType));
  assert.equal(labels.rows.length, evidence.length);
  assert.equal(new Set(labels.rows.map(r => r.id)).size, evidence.length);
  const excluded = new Set((await load(`${baseline}/evidence.json`)).map(e => e.session.sessionId));
  assert.ok(evidence.every(e => !excluded.has(e.session.sessionId)), "Holdout overlaps development sessions");
  for (const e of evidence) {
    const label = labels.rows.find(r => r.id === e.id);
    assert.ok(label && label.inputHash === e.inputHash && label.note && ["reported_shortfall", "acknowledged_success", "unknown"].includes(label.expected));
  }
  const { judgeResponse, judgeResponseFollowup, RESPONSE_RUBRIC_VERSION } = await imp("response-judge");
  const { responseOutcome, RESPONSE_REPORT_VERSION } = await imp("response-outcome");
  const { resolveTypeSafeApiKey } = await imp("typesafe");
  const apiKey = await resolveTypeSafeApiKey(config.typesafe); assert.ok(apiKey);
  const results = [];
  for (const e of evidence) {
    const label = labels.rows.find(r => r.id === e.id);
    const params = { apiKey, timeoutMs: 10000, signal: AbortSignal.timeout(30000) };
    const judgment = await judgeResponse(e, params), retrospective = await judgeResponseFollowup(e, params);
    const outcome = responseOutcome({ ...judgment, retrospective });
    results.push({ id: e.id, inputHash: e.inputHash, expected: label.expected, outcome, judgment, retrospective });
  }
  const positives = results.filter(r => r.expected === "reported_shortfall");
  const negatives = results.filter(r => r.expected !== "reported_shortfall");
  const summary = { rubric: RESPONSE_RUBRIC_VERSION, reportVersion: RESPONSE_REPORT_VERSION, reviewerType: labels.reviewerType,
    evidenceSha256: labels.evidenceSha256, total: results.length, exact: results.filter(r => r.expected === r.outcome.status).length,
    positiveExamples: positives.length, negativeExamples: negatives.length,
    falseFlags: negatives.filter(r => r.outcome.status === "reported_shortfall").length,
    missedShortfalls: positives.filter(r => r.outcome.status !== "reported_shortfall").length,
    shortfallRecall: positives.length ? positives.filter(r => r.outcome.status === "reported_shortfall").length / positives.length : null,
    falseFlagRate: negatives.length ? negatives.filter(r => r.outcome.status === "reported_shortfall").length / negatives.length : null,
    classified: results.filter(r => r.outcome.status !== "unknown").length,
    limitation: "Small frozen sample; agent labels are not human ground truth. Missing positive examples cannot establish recall. No threshold tuning on this holdout." };
  await writeFile(`${directory}/holdout-results.json`, JSON.stringify({ ...summary, results }, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(summary));
}
