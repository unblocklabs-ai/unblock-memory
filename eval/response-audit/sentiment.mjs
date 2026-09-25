// Bounded live check using invented text only. Never reads user transcripts.
// Usage: node sentiment.mjs PLUGIN KEYFILE OUTPUT
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const [plugin, keyFile, output] = process.argv.slice(2);
assert.ok(plugin && keyFile && output);
const { resolveTypeSafeApiKey } = await import(pathToFileURL(`${plugin}/dist/src/typesafe-client.js`));
const { judgeResponse, RESPONSE_RUBRIC_VERSION } = await import(pathToFileURL(`${plugin}/dist/src/response-judge.js`));
const apiKey = await resolveTypeSafeApiKey({ enabled: true, apiKeyFile: keyFile, timeoutMs: 10000 });
assert.ok(apiKey, "TypeSafe key unavailable");
const cases = [
  { id: "neutral_correction", feedback: "The total is 42, not 43. Please update it.", annoyed: false, frustrated: false, polarity: "neutral" },
  { id: "brief_followup", feedback: "Shorter please.", annoyed: false, frustrated: false, polarity: "neutral" },
  { id: "external_frustration", feedback: "Thanks for the correct explanation. I'm so frustrated with the vendor's outage, not with you.", annoyed: false, frustrated: false },
  { id: "pointed_annoyance", feedback: "Stop repeating that same explanation. It's irritating.", annoyed: true },
  { id: "repeated_effort", feedback: "This is the fourth time I've explained what I need. You keep ignoring it and I'm frustrated that we're getting nowhere.", frustrated: true },
  { id: "mixed_praise_complaint", feedback: "The summary is great, but I'm annoyed that you ignored my format instructions again.", annoyed: true, polarity: "mixed" },
  { id: "sarcasm", feedback: "Fantastic, you ignored the instructions AGAIN. What a waste of my time.", annoyed: true },
  { id: "loss_of_trust", feedback: "Your answers are useless. I'm done relying on you; I don't trust your work anymore.", intensityAtLeast: 2.5 },
  { id: "praise", feedback: "Perfect, exactly what I needed. Thank you!", annoyed: false, frustrated: false, polarity: "satisfied" },
];
const results = [];
for (const c of cases) {
  const text = (role, value, seq) => ({ role, text: value, seq });
  const episode = { id: c.id, inputHash: c.id, session: { sessionId: "synthetic", accountId: "test", conversationId: "test", chatType: "direct" },
    senderId: "synthetic", thread: "test", timestamp: Date.now(), model: "synthetic", memorySearchCalls: 0, contextLimited: false,
    before: [], request: [text("user", "Explain the report total in one sentence.", 1)],
    answer: [text("assistant", "The report total is 43 because it sums all included entries.", 2)],
    feedback: [text("user", c.feedback, 3)], followup: { status: "pending", messages: [] } };
  const result = await judgeResponse(episode, { apiKey, timeoutMs: 10000, signal: AbortSignal.timeout(30000) });
  const f = result.feedback;
  const checks = {
    annoyance: c.annoyed === undefined || (c.annoyed ? f.annoyance.noul >= 0.8 : f.annoyance.noul <= 0.2),
    frustration: c.frustrated === undefined || (c.frustrated ? f.frustration.noul >= 0.8 : f.frustration.noul <= 0.2),
    polarity: !c.polarity || (f.sentiment.choice === c.polarity && f.sentiment.confidence >= 0.8),
    intensity: c.intensityAtLeast === undefined || (f.dissatisfactionIntensity.score >= c.intensityAtLeast && f.dissatisfactionIntensity.confidence >= 0.8),
  };
  const behaviorChecks = { ...checks,
    annoyance: c.annoyed === false ? f.annoyance.noul < 0.8 : checks.annoyance,
    frustration: c.frustrated === false ? f.frustration.noul < 0.8 : checks.frustration };
  results.push({ id: c.id, checks, behaviorChecks, feedback: f });
  console.log(JSON.stringify({ id: c.id, checks, sentiment: f.sentiment.choice, annoyance: f.annoyance.noul,
    frustration: f.frustration.noul, intensity: f.dissatisfactionIntensity.score, intensityConfidence: f.dissatisfactionIntensity.confidence }));
}
const passed = results.filter(r => Object.values(r.checks).every(Boolean)).length;
const behaviorPassed = results.filter(r => Object.values(r.behaviorChecks).every(Boolean)).length;
await writeFile(output, JSON.stringify({ rubric: RESPONSE_RUBRIC_VERSION, passed, behaviorPassed, total: cases.length, results }, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ passed, behaviorPassed, total: cases.length }));
if (behaviorPassed !== cases.length) process.exitCode = 1;
