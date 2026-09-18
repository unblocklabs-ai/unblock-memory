// Read-only inspection; only aggregate counts leave the host.
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const [databasePath, projectorPath] = process.argv.slice(2);
assert.ok(databasePath && projectorPath);
const { projectLoggieMessage } = await import(pathToFileURL(projectorPath).href);
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = db.prepare(`SELECT e.event_json AS eventJson, w.session_id AS sessionId, w.account_id AS accountId
    FROM session_windows w JOIN session_transcript_active_events a ON a.session_id=w.session_id
    JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq
    WHERE w.channel='loggie'`).all();
  let userMessages = 0, normalized = 0, fallback = 0, speakerBlocks = 0;
  const sessions = new Set();
  for (const row of rows) {
    const event = JSON.parse(row.eventJson);
    if (event.type !== "message" || event.message?.role !== "user") continue;
    const content = event.message.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
    if (!text) continue;
    userMessages++; sessions.add(row.sessionId);
    const result = projectLoggieMessage(text.trim(), row.accountId ?? undefined);
    if (!result) { fallback++; continue; }
    normalized++;
    speakerBlocks += [...result.text.matchAll(/^\*\*Speaker:/gmu)].length;
    assert.ok(!result.text.includes("Workflow guidance (subject to system rules and user authorization):"));
    const at = text.indexOf("\nTranscript Detail:\n");
    if (at >= 0) {
      const detail = JSON.parse(text.slice(at + "\nTranscript Detail:\n".length));
      const original = detail.transcript.text;
      if (original.trim() === "[No transcript provided]") continue;
      for (const line of original.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)) {
        const label = /^([^:\n]{1,160}):[ \t]+(.*)$/u.exec(line);
        assert.ok(result.text.includes(line) || (label && result.text.includes(JSON.stringify(label[1])) && result.text.includes(label[2])), "Projection lost source speech");
      }
    }
  }
  console.log(JSON.stringify({ sessions: sessions.size, userMessages, normalized, fallback, speakerBlocks, speechCoverage: "passed", readOnly: true }));
} finally { db.close(); }
