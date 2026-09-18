// Live TypeSafe calibration pilot over synthetic exchanges only.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const [plugin, keyFile, output] = process.argv.slice(2);
assert.ok(plugin && keyFile && output);
const { resolveTypeSafeApiKey } = await import(pathToFileURL(`${plugin}/dist/src/typesafe.js`));
const { judgeResponse, judgeResponseFollowup, RESPONSE_RUBRIC_VERSION } = await import(pathToFileURL(`${plugin}/dist/src/response-judge.js`));
const { responseOutcome } = await import(pathToFileURL(`${plugin}/dist/src/response-outcome.js`));
const apiKey = await resolveTypeSafeApiKey({ enabled: true, apiKeyFile: keyFile, timeoutMs: 10000 });
assert.ok(apiKey);
const cases = [
  { id: "acceptance_new_scope", request: "Explain what a database index does in one sentence.", answer: "An index helps a database find matching rows without scanning the entire table.", feedback: "Great, now give me an example.", kind: "acceptance", rework: false },
  { id: "wrong_deliverable", request: "Write the final two-sentence email asking Lee to approve the budget.", answer: "First decide on your tone, then draft an email requesting approval.", feedback: "I asked you to write the email, not tell me how.", kind: "correction", rework: true, underdelivery: true },
  { id: "new_requirement", request: "Write a short launch announcement.", answer: "Our new dashboard is live. Try it today.", feedback: "Can you also make a Spanish version?", kind: "continuation", rework: false },
  { id: "external_bad_news", request: "What does this notice mean: the conference is cancelled?", answer: "It means the conference will not take place.", feedback: "That's awful news. I was looking forward to it.", kind: "unrelated", rework: false },
  { id: "repeated_constraint", request: "Give me exactly one sentence explaining caching, no bullet points.", answer: "- Caching stores data.\n- It makes retrieval faster.\n- It can become stale.", feedback: "One sentence, no bullets, as I said.", kind: "correction", rework: true },
  { id: "memory_gap", before: "We agreed Atlas staging must run in the EU, never the US.", request: "Which region should Atlas staging use?", answer: "Use the US region.", feedback: "We already agreed it has to stay in the EU. Why are you forgetting that?", kind: "correction", rework: true, memory: true },
  { id: "necessary_clarification", request: "Send the report to Alex.", answer: "Which Alex should receive it: Alex Chen or Alex Smith?", feedback: "Alex Chen.", kind: "continuation", rework: false, underdelivery: false },
  { id: "unseen_artifact", request: "Fix the bug in the codebase and test it.", answer: "Fixed and tested successfully.", feedback: "Thanks!", kind: "acceptance", rework: false, unassessable: true },
  { id: "earlier_instruction", request: "Which tool failed?", answer: "The native editor rejected the patch.", feedback: "We already discussed using Gateway exec. Why do you keep asking me for approval?", target: "earlier_behavior", memory: true },
  { id: "proactive_failure", request: "Is memory healthy?", answer: "No. Search is timing out.", feedback: "Why did I have to ask before you surfaced the issue? Investigate and fix it.", target: "proactive_action", followup: "I was wrong that search was timing out: those were stale logs. The live search works.", correction: true },
  { id: "delivery_failure", request: "Give me the audit report.", answer: "The report is in the message above.", feedback: "What message above? Nothing came through.", target: "delivery", followup: "My mistake. The final report never posted; only the completion notice did.", delivery: true },
  { id: "fit_without_verification", request: "Explain whether the service is healthy in one sentence.", answer: "The service is unhealthy because its search requests are timing out.", feedback: "Thanks.", fit: true, followup: "You're welcome. I can investigate next.", correction: false },
  { id: "new_task_failure_not_delivery", request: "Which branch did I serve in?", answer: "The Air Force.", feedback: "Great, now search memory for who Alex is.", followup: "I could not identify Alex from memory.", delivery: false, correction: false },
  { id: "greeting_not_failed_delivery", request: "Hey!", answer: "Hey, what can I help with?", feedback: "Sync the directory.", followup: "I could not complete the directory sync because credentials are unavailable.", delivery: false, correction: false },
  { id: "different_earlier_claim", request: "Can we switch back?", answer: "Switching back requires a downgrade or a custom adapter.", feedback: "Where do the release notes say the adapter was removed?", followup: "My earlier claim that release notes announced removal was wrong; they do not mention it. A downgrade or custom adapter is still needed.", correction: false, delivery: false },
  { id: "explaining_prior_failure", request: "Why did the report not arrive?", answer: "My earlier upload failed. It was a delivery bug; I still owe you the report.", feedback: "Is the connector healthy now?", followup: "No, the connector is still down.", correction: false, delivery: false },
  { id: "disclosed_guess", request: "What do you think my favorite food is?", answer: "Pasta, but that is a pure unsupported guess. I found no reliable evidence.", feedback: "What evidence did you find?", followup: "None supports pasta; it was an arbitrary guess, not based on your history.", correction: false, delivery: false },
  { id: "clarified_scope", request: "Set verbose logging please.", answer: "Verbose logging is enabled for this session.", feedback: "No, make it persistent in config.", followup: "Done, it is now persistent.", correction: false, delivery: false },
  { id: "introduced_regression", request: "Fix the security bug and publish the tool.", answer: "Published. Disabled all image loading to block malicious image URLs.", feedback: "Isn't loading images the main functionality?", followup: "Yes. My fix was too broad and broke that capability. I should have blocked unsafe addresses while preserving image loading." },
  { id: "diagnosis_then_implementation", request: "Is the ticket framing too narrow?", answer: "Yes. It should describe the general backend bug rather than just the one client.", feedback: "Please fix it.", followup: "Updated the ticket title and body to the general issue.", correction: false, delivery: false },
  { id: "third_person_success", request: "Rank the five bestselling products for new customers this month.", answer: "Ranked by units: A 120, B 90, C 70, D 60, E 40.", feedback: "@Lee retested, she pulled the ranking in three minutes this time!", correction: false, delivery: false },
  { id: "third_person_verification", request: "Update the spend report.", answer: "Updated the report and verified the totals.", feedback: "@Lee did our agent do this correctly?", correction: false, delivery: false },
  { id: "unrelated_praise", request: "Summarize the export error.", answer: "The export failed because the destination folder was unavailable.", feedback: "By the way, Lee did a great job on yesterday's sales presentation.", correction: false, delivery: false },
  { id: "new_deployment_constraint", request: "Where should the contact records live?", answer: "I recommend a shared database to support agents working together.", feedback: "Our deployment always has exactly one agent per device.", followup: "That new constraint changes my recommendation: use the per-agent database instead.", correction: false, delivery: false },
  { id: "known_deployment_constraint", before: "Our deployment always has exactly one agent per device.", request: "Where should the contact records live?", answer: "Your deployment has multiple agents on each device, so use a shared database.", feedback: "I already told you there is only one agent per device.", followup: "My claim that your devices have multiple agents was wrong. Use the per-agent database.", correction: true, delivery: false },
  { id: "delivery_failure_explanation", before: "You promised to post scheduled health checks, but none arrived.", request: "Why did the checks not arrive?", answer: "They never posted because the sender rejected the configuration.", feedback: "What do you mean it rejected the configuration?", followup: "The scheduled process reported an invalid config. That prevented it from sending the checks.", correction: false, delivery: false },
  { id: "promised_delivery_failed", request: "Run scheduled health checks and post the results here.", answer: "Checks are scheduled; I will post their results here in an hour.", feedback: "Where are the results?", followup: "They never posted because the sender rejected the configuration.", correction: false, delivery: true },
  { id: "overbroad_completion", request: "Stop the reports while I rebuild the dashboard.", answer: "Stopped the daily reporter. No more reports will be generated.", feedback: "Isn't the hourly reporter still running?", followup: "Yes, I missed that one. It was still generating reports. I have now disabled it too.", correction: true, delivery: false },
  { id: "qualified_factual_comparison", request: "Is release 3.2 newer than our 4.0 beta?", answer: "No, the 4.0 beta is newer; 3.2 would be an older release.", feedback: "But the beta was published last month and 3.2 yesterday.", followup: "You're right. I compared version numbers too simplistically: 3.2 is a newer maintenance publication on an older feature branch, so it is not simply an older release.", correction: true, delivery: false },
];
const results = [];
const expectedOutcomes = {
  acceptance_new_scope: "acknowledged_success", wrong_deliverable: "reported_shortfall",
  new_requirement: "unknown", external_bad_news: "unknown", repeated_constraint: "reported_shortfall",
  memory_gap: "reported_shortfall", necessary_clarification: "unknown", unseen_artifact: "acknowledged_success",
  earlier_instruction: "unknown", proactive_failure: "reported_shortfall", delivery_failure: "reported_shortfall",
  fit_without_verification: "acknowledged_success", new_task_failure_not_delivery: "acknowledged_success",
  greeting_not_failed_delivery: "unknown", different_earlier_claim: "unknown",
  explaining_prior_failure: "unknown", disclosed_guess: "unknown", clarified_scope: "unknown",
  introduced_regression: "reported_shortfall", diagnosis_then_implementation: "unknown",
  third_person_success: "acknowledged_success", third_person_verification: "unknown", unrelated_praise: "unknown",
  new_deployment_constraint: "unknown", known_deployment_constraint: "reported_shortfall",
  delivery_failure_explanation: "unknown", promised_delivery_failed: "reported_shortfall",
  overbroad_completion: "reported_shortfall", qualified_factual_comparison: "reported_shortfall",
};
for (const c of cases) {
  const text = (role, value, seq) => ({ role, text: value, seq });
  const episode = { id: c.id, inputHash: c.id, session: { sessionId: "synthetic", accountId: "test", conversationId: "test", chatType: "direct" },
    senderId: "synthetic", thread: "test", timestamp: Date.now(), model: "synthetic", memorySearchCalls: 0, contextLimited: false,
    before: c.before ? [text("user", c.before, 1)] : [], request: [text("user", c.request, 2)],
    answer: [text("assistant", c.answer, 3)], feedback: [text("user", c.feedback, 4)],
    followup: { status: c.followup ? "complete" : "pending", messages: c.followup ? [text("assistant", c.followup, 5)] : [] } };
  const start = performance.now();
  const judgment = await judgeResponse(episode, { apiKey, timeoutMs: 10000, signal: AbortSignal.timeout(30000) });
  const retrospective = await judgeResponseFollowup(episode, { apiKey, timeoutMs: 10000, signal: AbortSignal.timeout(30000) });
  const checks = { feedback: !c.kind || judgment.feedback.feedbackType.choice === c.kind,
    outcome: retrospective.judgment.outcome.choice === expectedOutcomes[c.id] && retrospective.judgment.outcome.confidence >= 0.8,
    underdelivery: c.underdelivery === undefined || (c.underdelivery ? judgment.quality.underdelivery.noul >= 0.8 : judgment.quality.underdelivery.noul <= 0.2),
    rework: c.rework === undefined || (c.rework ? judgment.feedback.avoidableRework.noul >= 0.7 : judgment.feedback.avoidableRework.noul <= 0.3),
    target: !c.target || judgment.feedback.target.choice === c.target,
    fit: !c.fit || (judgment.quality.fitAssessability.choice === "assessable" && judgment.quality.fitAssessability.confidence >= 0.8),
    correction: c.correction === undefined || (c.correction ? retrospective.judgment.correction.noul >= 0.8 : retrospective.judgment.correction.noul <= 0.2),
    delivery: c.delivery === undefined || (c.delivery ? retrospective.judgment.deliveryAdmission.noul >= 0.8 : retrospective.judgment.deliveryAdmission.noul <= 0.2),
    memory: !c.memory || judgment.feedback.memoryGap.noul >= 0.8,
    unassessable: !c.unassessable || judgment.quality.assessability.choice === "not_assessable" };
  // Preserve strict probability targets, but test deployed behavior separately:
  // an uncertain negative is acceptable abstention, not a false-positive flag.
  const behaviorChecks = { ...checks,
    outcome: responseOutcome({ ...judgment, retrospective }).status === expectedOutcomes[c.id],
    underdelivery: c.underdelivery === false ? judgment.quality.underdelivery.noul < 0.8 : checks.underdelivery,
    correction: c.correction === false ? retrospective.judgment.correction.noul < 0.8 : checks.correction,
    delivery: c.delivery === false ? retrospective.judgment.deliveryAdmission.noul < 0.8 : checks.delivery };
  results.push({ id: c.id, checks, behaviorChecks, judgment, retrospective, outcome: responseOutcome({ ...judgment, retrospective }), milliseconds: Math.round(performance.now() - start) });
}
const passed = results.filter(r => Object.values(r.checks).every(Boolean)).length;
const behaviorPassed = results.filter(r => Object.values(r.behaviorChecks).every(Boolean)).length;
await writeFile(output, JSON.stringify({ rubric: RESPONSE_RUBRIC_VERSION, passed, behaviorPassed, total: cases.length, results }, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ passed, behaviorPassed, total: cases.length, cases: results.map(r => ({ id: r.id, checks: r.checks, behaviorChecks: r.behaviorChecks, milliseconds: r.milliseconds })) }));
if (behaviorPassed !== cases.length) process.exitCode = 1;
