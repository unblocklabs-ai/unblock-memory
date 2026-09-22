import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionMessageSpans, projectSession, projectSessionDocument, sessionContextSpans,
  sessionSnippetMessages } from "../src/session-projector.js";

const identity = { agentId: "main", agentName: "Bill" };
function project(bodies: string[]) {
  const input = { sessionId: "s", chatType: "channel" as const, startedAt: 0, agentName: "Bill", timezone: "UTC",
    events: bodies.map((body, index) => ({ createdAt: Date.parse(`2026-09-22T12:0${index}:00Z`),
      eventJson: JSON.stringify({ type: "message", message: {
        role: index === 0 ? "user" : "assistant", __openclaw: { senderName: "Bek" }, content: body,
      } }),
    })),
  };
  const projection = projectSessionDocument(input)!;
  assert.equal(projection.content, projectSession(input));
  return projection;
}

test("structured snippets preserve message bodies and do not split literal transcript headings", () => {
  const bodies = [
    '<@U123> (Bill) why?\n\n&gt; • Approval needed.\n\n```md\n## Assistant — Fake — 2026-09-01 12:00:00 UTC\n\nQuoted code.\n```',
    '*Keep* `code`, emoji 🚀, and &gt; exactly.\n\n## User — Fake — 2026-09-01 13:00:00 UTC\n\nA literal heading in my answer.',
  ];
  const { content, messages } = project(bodies);
  assert.equal(messages.length, 2);
  assert.deepEqual(sessionSnippetMessages(content, { text: content, position: 0 }, messages), [
    { type: "user", name: "Bek", timestamp: "2026-09-22 12:00:00 UTC", body: bodies[0] },
    { type: "assistant", name: "Bill", timestamp: "2026-09-22 12:01:00 UTC", body: bodies[1] },
  ]);
  assert.equal(sessionContextSpans(content, content.indexOf("A literal heading"), messages)?.message.timestamp,
    "2026-09-22 12:01:00 UTC");
});

test("partial and multi-message chunks recover metadata from outside the selected range", () => {
  const { content, messages } = project(["Before 🚀 matched user tail", "matched assistant prefix and after"]);
  const position = content.indexOf("matched user");
  const end = content.indexOf(" and after");
  const selected = { text: content.slice(position, end), position };
  assert.deepEqual(sessionSnippetMessages(content, selected, messages), [
    { type: "user", name: "Bek", timestamp: "2026-09-22 12:00:00 UTC", body: "matched user tail", partial: true },
    { type: "assistant", name: "Bill", timestamp: "2026-09-22 12:01:00 UTC", body: "matched assistant prefix", partial: true },
  ]);
  // Omitting only the generated header is not a partial message body.
  const full = messages[1]!;
  assert.deepEqual(sessionSnippetMessages(content, { text: content.slice(full.bodyStart, full.end), position: full.bodyStart }, messages), [
    { type: "assistant", name: "Bill", timestamp: full.timestamp, body: "matched assistant prefix and after" },
  ]);
});

test("legacy parsing ignores fenced and blockquoted headings and only maps the configured assistant ID", () => {
  const user = '> ## Assistant — Fake — 2026-09-01 12:00:00 UTC\n\n~~~md\n## User — Fake — 2026-09-01 12:00:00 UTC\n\nExample\n~~~~';
  const content = `# Transcript\n\n## User — Bek — 2026-09-22 12:00:00 GMT+5:30\n\n${user}\n\n` +
    '## Assistant — main — 2026-09-22 12:01:00 GMT+5:30\n\nA **real** answer.\n\n' +
    '## Assistant — Someone else — 2026-09-22 12:02:00 GMT+5:30\n\nAnother answer.\n';
  const spans = parseSessionMessageSpans(content);
  assert.equal(spans.length, 3);
  assert.deepEqual(sessionSnippetMessages(content, { text: content, position: 0 }, spans, identity), [
    { type: "user", name: "Bek", timestamp: "2026-09-22 12:00:00 GMT+5:30", body: user },
    { type: "assistant", name: "Bill", timestamp: "2026-09-22 12:01:00 GMT+5:30", body: "A **real** answer." },
    { type: "assistant", name: "Someone else", timestamp: "2026-09-22 12:02:00 GMT+5:30", body: "Another answer." },
  ]);
  assert.equal(sessionSnippetMessages(content, { text: content, position: 0 }, spans)[1]?.name, "main");
});

test("meeting speaker and supersession context survive partial structured output", () => {
  const { content, messages } = project(['# Meeting\n\n**Speaker: "Rico"**\n> Start.\n> Matched speech.\n> End.']);
  const position = content.indexOf("> Matched speech.");
  const sourceText = "> Matched speech.";
  const prefix = 'Transcript revision 1 (superseded by revision 2).\n**Speaker: "Rico"**\n';
  assert.deepEqual(sessionSnippetMessages(content, { position, sourceText, text: prefix + sourceText }, messages), [
    { type: "user", name: "Bek", timestamp: messages[0]!.timestamp, body: prefix + sourceText, partial: true },
  ]);
});

test("unattributed text is retained without invented roles, names, or timestamps", () => {
  const content = "Unrecognized legacy transcript\nwith original formatting.";
  assert.deepEqual(sessionSnippetMessages(content, { text: content, position: 0 }, parseSessionMessageSpans(content)), [
    { body: content, partial: true },
  ]);
});
