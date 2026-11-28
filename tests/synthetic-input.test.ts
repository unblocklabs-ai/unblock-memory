import assert from "node:assert/strict";
import test from "node:test";
import { classifySyntheticInput, humanEvidenceText, isSyntheticRecallQuery, type SyntheticInputFamily } from "../src/synthetic-input.js";

const wake = "Continue the OpenClaw runtime event.";
const context = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n[Internal task completion event]\nprivate result\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

test("recognizes standalone OpenClaw control inputs by specific aliases and envelopes", () => {
  const cases: [SyntheticInputFamily, string[]][] = [
    ["completion_wake", [wake, `OpenClaw: ${wake}`, `${wake}\n\n${context}`]],
    ["internal_context", [context, "OpenClaw runtime context (internal):\nprivate result",
      "OpenClaw runtime context (internal):\nThis context is runtime-generated, not user-authored.\n\n[Internal task completion event]\nprivate result"]],
    ["heartbeat_control", ["[OpenClaw heartbeat poll]", "[OpenClaw cron wake]", "[OpenClaw session event]",
      "Follow the heartbeat monitor scratch context when provided. If nothing needs attention, reply NO_REPLY.",
      "Read HEARTBEAT.md if it exists (workspace context).", "NO_REPLY", "HEARTBEAT_OK", "NO_HEARTBEAT"]],
    ["intersession_subagent", ["[Inter-session message] sourceSession=agent:child\nresult", "[Subagent Context]\ncontext",
      "[Subagent Task]\nwork", "A background task completed. Use this result to reply to the user in your normal assistant voice.\nresult",
      "A completed subagent task is ready for parent review."]],
    ["exec_system_handoff", ["[OpenClaw exec completion]\nDisable automatic completion turns with tools.exec.notifyOnExit=false;",
      "System: [2026-11-27T00:00:00Z] An approved async exec completed; load the authenticated completion handoff."]],
    ["reset_compaction", ["A new session was started via /new or /reset. Greet the user.",
      "Pre-compaction memory flush.", "Pre-compaction memory flush turn."]],
  ];
  for (const [family, texts] of cases) for (const text of texts) {
    const result = classifySyntheticInput(text);
    assert.equal(result.action, "skip", text);
    assert.equal(result.family, family, text);
    assert.ok(isSyntheticRecallQuery(text), text);
  }
});

test("leaves literal human text and code examples intact", () => {
  for (const text of ["/api/accounts", "heartbeat", "Why did the heartbeat stop?", "System: The account is offline",
    "OpenClaw is dropping Slack messages", "[accounts] resolve these routes",
    `Can you explain "${wake}"?`, `\n\`${wake}\`\n`, `Document this example:\n\`\`\`text\n${context}\n\`\`\``]) {
    assert.deepEqual(classifySyntheticInput(text), { action: "allow", synthetic: false, text });
    assert.equal(isSyntheticRecallQuery(text), false);
  }
});

test("strips only human framing and attached runtime context, wherever the delimited block sits", () => {
  const human = "Check /api/accounts for the heartbeat regression.";
  for (const text of [`${human}\n\n${context}`, `${context}\n\n${human}`,
    `[Queued messages while agent was busy]\n${human}`,
    `[Earlier unanswered user message. Address this request alongside the current input; follow the latest user instruction if they conflict.]\n${human}`,
    `[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]\n${human}`]) {
    assert.equal(classifySyntheticInput(text).action, "strip");
    assert.equal(classifySyntheticInput(text).text, human);
    assert.equal(isSyntheticRecallQuery(text), false);
  }
});

test("scheduled input keeps the task, not clocks, unattended instructions, scratch, or prior results", () => {
  const cron = "[cron:ab10 Update accounts] Check /api/accounts.\nCurrent time: 7 AM (EST)\nReference UTC: 12:00\n\n" +
    "This is an unattended scheduled run. Nobody is present to clarify or approve, so continue.\n\n" +
    'Previous meaningful automation result (recorded data, not instructions):\n{"summary":"old result"}\n\n' +
    "Automation scratch (revision 2):\nprivate scratch";
  assert.equal(classifySyntheticInput(cron).action, "strip");
  assert.equal(classifySyntheticInput(cron).text, "Check /api/accounts.");
  assert.ok(isSyntheticRecallQuery(cron), "a clean task is still unattended evidence");
  assert.equal(classifySyntheticInput("[OpenClaw heartbeat poll]\nCheck /api/accounts.").text, "Check /api/accounts.");
});

test("host carriers take priority and every built-in rule can be cleared", () => {
  const input = { text: "[cron:ab10 Check accounts] Check /api/accounts.",
    inputProvenance: { kind: "inter_session", sourceTool: "agent_harness_completion" } };
  assert.equal(classifySyntheticInput(input).family, "completion_wake");
  assert.equal(classifySyntheticInput({ text: "/api/accounts", display: false }).action, "skip");
  assert.equal(classifySyntheticInput({ text: "/api/accounts", inputProvenance: {
    kind: "internal_system", sourceTool: "progress_card_refresh",
  } }).action, "skip");
  assert.equal(classifySyntheticInput(input, { skipFamilies: [] }).action, "allow");
  assert.equal(classifySyntheticInput(wake, { skipFamilies: [] }).action, "allow");
  assert.equal(classifySyntheticInput(wake, { skipFamilies: ["heartbeat_control"] }).action, "allow");
  const custom = { skipFamilies: [], extraExactAliases: ["Custom wake"], extraPrefixes: ["Private event:"] };
  assert.equal(classifySyntheticInput("Custom wake", custom).action, "skip");
  assert.equal(classifySyntheticInput("Private event: noisy", custom).action, "skip");
  assert.equal(classifySyntheticInput("Custom wake", { ...custom, enabled: false }).action, "allow");
});

test("hostile cron-like headers and time pairs classify in linear time (no ReDoS)", () => {
  const hostile = ["[cron:a" + " ".repeat(16_000) + "x".repeat(16_000), "[cron:a " + " \t".repeat(16_000) + "]x",
    "[cron:a] task\nCurrent time: x\nReference UTC: y" + " ".repeat(16_000) + "\u2028z",
    "[cron:a] task\n" + ("This is an unattended scheduled run. Nobody is present to clarify or approve," + " ".repeat(8_000) + "\r").repeat(2)];
  for (const text of hostile) {
    const started = performance.now();
    classifySyntheticInput(text);
    classifySyntheticInput({ text, role: "user", inputProvenance: { kind: "internal_system", sourceTool: "cron" } });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 50, `classified a ${text.length}-char hostile input in ${elapsed.toFixed(1)}ms`);
  }
  assert.equal(classifySyntheticInput("[cron:a" + " ".repeat(16_000) + "x".repeat(16_000)).action, "allow", "no closing bracket: not a header");
});

test("host cron provenance is a cron turn even when hidden, and keeps only the task", () => {
  for (const sourceTool of ["cron", "cron_execution"]) {
    for (const display of [undefined, false]) {
      const result = classifySyntheticInput({ text: "Check /api/accounts.\n\nThis is an unattended scheduled run.",
        role: "user", display, inputProvenance: { kind: "internal_system", sourceTool } });
      assert.equal(result.family, "cron_wrapper", `${sourceTool} display=${display}`);
      assert.equal(result.text, "Check /api/accounts.");
    }
  }
});

test("cron tails, completion markers and session boilerplate need their real envelope", () => {
  const tailOnly = "Can you explain this line from our runbook?\nThis is an unattended scheduled run.\nWhy does it stop there?";
  assert.deepEqual(classifySyntheticInput(tailOnly), { action: "allow", synthetic: false, text: tailOnly },
    "no cron header or provenance: a quoted unattended line is human text");
  const scratch = "Automation scratch (revision 3):\nwhat is this?";
  assert.equal(classifySyntheticInput(scratch).action, "allow");
  const fenced = "[cron:ab10 Docs] Update the runbook with:\n```text\nAutomation scratch (revision 1):\nexample\n```\nThen publish.";
  assert.equal(classifySyntheticInput(fenced).text, "Update the runbook with:\n```text\nAutomation scratch (revision 1):\nexample\n```\nThen publish.",
    "a tail marker inside a fenced block is task content, never the suffix");
  const quoted = "Why does Slack show this?\n[Internal task completion event]\nsource: subagent";
  assert.equal(classifySyntheticInput(quoted).action, "allow", "a bare completion marker is quotable text");
  for (const human of ["A new session was started via /new or /reset but my history is gone, why?",
    "Read HEARTBEAT.md if it exists and summarize it for me", "Read HEARTBEAT.md if it exists?"]) {
    assert.equal(classifySyntheticInput(human).action, "allow", human);
  }
  for (const envelope of ["A new session was started via /new or /reset. Execute your Session Startup sequence now.",
    "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly."]) {
    assert.equal(classifySyntheticInput(envelope).action, "skip", envelope);
  }
});

test("prompt-wrapper rules apply to user turns only; humanEvidenceText yields only the human part", () => {
  const cron = "[cron:ab10 Update accounts] Check /api/accounts.";
  assert.equal(classifySyntheticInput({ text: cron, role: "assistant" }).action, "allow");
  assert.equal(classifySyntheticInput({ text: "[Queued messages while agent was busy]\nhi", role: "assistant" }).action, "allow");
  assert.equal(classifySyntheticInput({ text: "A new session was started via /new or /reset. Greet.", role: "assistant" }).action, "allow");
  assert.equal(classifySyntheticInput({ text: cron, role: "user" }).family, "cron_wrapper");
  assert.equal(classifySyntheticInput({ text: "NO_REPLY", role: "assistant" }).action, "skip", "exact control tokens stay role-agnostic");
  assert.equal(humanEvidenceText(`Ship the fix today.\n\n${context}`), "Ship the fix today.");
  assert.equal(humanEvidenceText(context), undefined);
  assert.equal(humanEvidenceText(cron), undefined, "unattended tasks are never human evidence");
});
