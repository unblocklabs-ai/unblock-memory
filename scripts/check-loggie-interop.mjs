// Cross-package, offline contract check. Safe against installed release artifacts.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [loggieRoot, memoryRoot, qmdRoot] = process.argv.slice(2);
assert.ok(loggieRoot && memoryRoot && qmdRoot, "Pass Loggie, memory and QMD package roots");
const load = (root, path) => import(pathToFileURL(resolve(root, path)).href);
const { formatMeetingContent } = await load(loggieRoot, "dist/src/monitor/meeting-content.js");
const { projectSession } = await load(memoryRoot, "dist/src/session-projector.js");
const { expandSessionSearchHit } = await load(memoryRoot, "dist/src/manager.js");
const { chunkMarkdownSemantically, withSpeakerContext } = await load(qmdRoot, "dist/semantic-chunking.js");
const event = { eventId: "fixture-event", workspaceId: "fixture-workspace", meetingId: "fixture-meeting",
  occurredAt: "2026-09-17T12:00:00Z", sequence: 1, payload: { title: "Offline interop fixture" } };
const detail = { transcript: { text: `Bek Akhmedov: ${"Preserve source citations. ".repeat(400)}\nSam Example: I will test the release.`, summary: "A generated summary." } };
const normalized = formatMeetingContent({ accountId: "default", event, detail, maxChars: null });
const projected = projectSession({ sessionId: "fixture-session", provider: "loggie", accountId: "default",
  chatType: "group", startedAt: 1, timezone: "UTC", agentName: "Bill",
  events: [{ createdAt: 1, eventJson: JSON.stringify({ type: "message", message: { role: "user", content: normalized } }) }] });
assert.ok(projected?.includes('**Speaker: "Bek Akhmedov"**'));
assert.ok(!projected.includes("contentHash"));
const countTokens = async text => text.split(/\s+/u).filter(Boolean).length;
const chunks = await chunkMarkdownSemantically(projected, "fixture.md", { countTokens, embedBatch: async texts => texts.map(() => [1, 0]) });
const continuation = chunks.find(chunk => chunk.text.includes("Preserve source citations.") && !chunk.text.includes("Speaker:"));
assert.ok(continuation, "Fixture must exercise an oversized speaker turn");
for (const chunk of chunks) assert.equal(projected.slice(chunk.pos, chunk.pos + chunk.text.length), chunk.text);
assert.match(withSpeakerContext(projected, continuation.pos, continuation.text), /^\*\*Speaker: "Bek Akhmedov"/u);
const selected = await expandSessionSearchHit({ body: projected, bestChunk: continuation.text, chunkPos: continuation.pos, chunkLen: continuation.text.length }, 500, countTokens);
assert.match(selected.text, /^\*\*Speaker: "Bek Akhmedov"/u);
assert.equal(selected.position, continuation.pos);
assert.equal(selected.sourceText, continuation.text);
console.log(JSON.stringify({ ok: true, chunks: chunks.length, sourceOffsets: "exact", continuationSpeaker: "retained", networkCalls: 0 }));
