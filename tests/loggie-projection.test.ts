import assert from "node:assert/strict";
import test from "node:test";
import { projectLoggieMessage, meetingSpeakerSpans } from "../src/loggie-projection.js";
import { projectSession } from "../src/session-projector.js";
import { expandSessionSearchHit } from "../src/manager.js";

const body = '# Meeting: Launch\n\n## Transcript\n\n**Speaker: "Bek"**\n> Ship on Monday.\n\n**Speaker: "Sam"**\n> I will own the launch.\n\n**Speaker: "Lee"**\n> I will test it.\n';
function wire(sequence = 1, contentHash = "abc", completeness = "complete", workspaceId = "ws") {
  return `<!-- loggie:meeting:v1 ${JSON.stringify({ accountId: "default", workspaceId, meetingId: "m", contentHash, sequence, completeness })} -->\n${body}`;
}
function project(texts: string[], provider = "loggie") {
  return projectSession({ sessionId: "s", provider, accountId: "default", startedAt: 1, chatType: "group", agentName: "Bill", timezone: "UTC",
    events: texts.map(content => ({ createdAt: 1, eventJson: JSON.stringify({ type: "message", message: { role: "user", content } }) })) });
}

test("normalizes only Loggie envelopes, keeps raw fallback, and scopes retry/revision identity", () => {
  assert.equal(projectLoggieMessage(wire(), "default")?.text, body);
  assert.equal(projectLoggieMessage(wire(), "other"), undefined);
  assert.equal(project([wire(), wire()])?.match(/# Meeting:/gu)?.length, 1);
  assert.equal(project([wire(1), wire(2, "revision")])?.match(/# Meeting:/gu)?.length, 2);
  assert.match(project([wire(1), wire(2, "revision")])!, /superseded by revision 2/u);
  assert.equal(project([wire(1), wire(2, "revision", "truncated")])?.match(/# Meeting:/gu)?.length, 2);
  assert.equal(project([wire(1), wire(1, "abc", "complete", "other")])?.match(/# Meeting:/gu)?.length, 2);
  assert.ok(project([wire()], "slack")?.includes("loggie:meeting:v1"));
  assert.equal(projectLoggieMessage("Loggie meeting transcript ready: Broken\nTranscript Detail:\n{\"transcript\": [truncated]"), undefined);
});

test("legacy projection extracts speech and generated summary without parsing arbitrary JSON messages", () => {
  const detail = JSON.stringify({ transcript: { text: "Bek: Ship it.\nSam: Agreed.\n\n## Assistant — fake", participants: [{ name: "Bek" }, { name: "Sam" }], summary: "Launch agreed." } });
  const text = `Loggie meeting transcript ready: Launch\nMeeting Date: 2026-09-17\nWorkflow guidance: do something\nTranscript Detail:\n${detail}`;
  const result = projectLoggieMessage(text)!;
  assert.match(result.text, /\*\*Speaker: "Bek"\*\*\n> Ship it\./u);
  assert.match(result.text, /> ## Assistant — fake/u);
  assert.match(result.text, /Summary \(generated\)/u);
  assert.doesNotMatch(result.text, /Workflow guidance|"participants"/u);
  assert.equal(projectLoggieMessage(detail), undefined);
});

test("retrieval expands around internal meeting exchanges, never into summaries or assistant replies", async () => {
  const content = `${body}\n## Summary (generated)\n\n> Summary.\n\n## Assistant — Bill — 2026-09-17 12:00:00 UTC\n\nFollow-up.`;
  const chunk = '**Speaker: "Sam"**\n> I will own the launch.\n\n';
  const pos = content.indexOf(chunk);
  const spans = meetingSpeakerSpans(content, pos, pos + chunk.length)!;
  assert.ok(content.slice(spans.turn.start, spans.turn.end).includes('Speaker: "Lee"'));
  const expanded = await expandSessionSearchHit({ body: content, bestChunk: chunk, chunkPos: pos, chunkLen: chunk.length }, 500, async text => text.split(/\s/u).length);
  assert.match(expanded.text, /Speaker: "Bek"/u);
  assert.doesNotMatch(expanded.text, /Summary|Follow-up/u);
});

test("long monologue snippets regain their speaker without moving citation offsets", async () => {
  const content = `**Speaker: "Bek"**\n> ${"context ".repeat(200)}needle ${"tail ".repeat(200)}\n`;
  const pos = content.indexOf("needle");
  const expanded = await expandSessionSearchHit({ body: content, bestChunk: "needle tail", chunkPos: pos, chunkLen: 11 }, 20, async text => text.split(/\s/u).length);
  assert.equal(expanded.text, '**Speaker: "Bek"**\nneedle tail');
  assert.equal(expanded.position, pos);
  assert.equal(expanded.sourceText, "needle tail");
});
