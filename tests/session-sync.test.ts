import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { syncSessionProjections } from "../src/session-sync.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

function writeStaleManifest(path: string, documentPath: string): Promise<void> {
  return writeFile(path, JSON.stringify({
    version: 1,
    sessions: {
      stale: {
        sessionId: "stale",
        chatType: "channel",
        startedAt: 1,
        sourceGeneration: "generation",
        maxSeq: 1,
        activeEventCount: 1,
        sizeBytes: 8,
        projectionHash: "hash",
        documentPath,
        projectorVersion: 1,
      },
    },
  }));
}

test("incrementally projects only configured active sessions and indexes changed documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-sessions-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const outputDir = join(root, "sessions");
  const manifestPath = join(root, "sessions-manifest.json");
  const db = createAgentDatabase(databasePath);
  insertSession(db, {
    sessionId: "channel-1",
    chatType: "channel",
    message: {
      type: "message",
      timestamp: "2026-08-25T14:32:09Z",
      message: { role: "user", content: "Hello memory", __openclaw: { senderName: "Bek" } },
    },
  });
  db.prepare("INSERT INTO transcript_events VALUES ('channel-1', 99, ?, 3500)").run(JSON.stringify({
    type: "message", message: { role: "user", content: "Abandoned branch" },
  }));
  insertSession(db, {
    sessionId: "direct-1",
    chatType: "direct",
    message: { type: "message", message: { role: "user", content: "Private DM" } },
  });
  insertSession(db, { sessionId: "empty-1", chatType: "group" });
  db.close();

  let indexRuns = 0;
  const run = (force = false) => syncSessionProjections({
    databasePath,
    outputDir,
    manifestPath,
    agentId: "main",
    agentName: "Bill",
    timezone: "UTC",
    chatTypes: ["channel", "group"],
    force,
    index: async () => { indexRuns += 1; return 3; },
  });

  const first = await run();
  assert.deepEqual({
    scanned: first.result.scanned,
    updated: first.result.updated,
    skipped: first.result.skipped,
    embedded: first.result.embedded,
  }, { scanned: 2, updated: 1, skipped: 1, embedded: 3 });
  assert.equal(indexRuns, 1);
  const [session] = Object.values(first.manifest.sessions);
  assert.ok(session);
  assert.equal(session.chatType, "channel");
  assert.equal(session.provider, "slack");
  assert.equal(session.conversationId, "native-channel-1");
  const document = await readFile(join(outputDir, session.documentPath), "utf8");
  assert.match(document, /## User — Bek — .*\n\nHello memory/u);
  assert.doesNotMatch(document, /Private DM/);
  assert.doesNotMatch(document, /Abandoned branch/);
  assert.equal(session.projectorVersion, 6);
  assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(outputDir, session.documentPath))).mode & 0o777, 0o600);
  const firstModifiedAt = (await stat(join(outputDir, session.documentPath))).mtimeMs;
  assert.equal(Math.round(firstModifiedAt), session.startedAt);

  const second = await run();
  assert.equal(second.result.unchanged, 1);
  assert.equal(second.result.updated, 0);
  assert.equal(second.result.embedded, 3);
  assert.equal(indexRuns, 2);
  assert.equal((await stat(join(outputDir, session.documentPath))).mtimeMs, firstModifiedAt);

  const oldProjectorManifest = structuredClone(second.manifest);
  oldProjectorManifest.sessions["channel-1"]!.projectorVersion = 5;
  await writeFile(manifestPath, JSON.stringify(oldProjectorManifest));
  const migrated = await run();
  assert.equal(migrated.result.updated, 1);
  assert.equal(migrated.manifest.sessions["channel-1"]!.projectorVersion, 6);
  assert.equal(indexRuns, 3);

  const changed = new DatabaseSync(databasePath);
  changed.prepare("UPDATE transcript_rewrite_watermarks SET generation = 'generation-2' WHERE session_id = 'channel-1'").run();
  changed.prepare("INSERT INTO transcript_events VALUES ('channel-1', 2, ?, 4000)").run(JSON.stringify({
    type: "message", timestamp: "2026-08-25T14:33:00Z",
    message: { role: "assistant", content: [{ type: "text", text: "Indexed response" }] },
  }));
  changed.prepare("INSERT INTO session_transcript_active_events VALUES ('channel-1', 1, 2, 1)").run();
  changed.close();

  const third = await run();
  assert.equal(third.result.updated, 1);
  assert.equal(indexRuns, 4);
  assert.match(
    await readFile(join(outputDir, third.manifest.sessions["channel-1"]!.documentPath), "utf8"),
    /## Assistant — Bill — .*\n\nIndexed response/u,
  );

  const removed = new DatabaseSync(databasePath);
  removed.prepare("DELETE FROM session_transcript_active_events WHERE session_id = 'channel-1'").run();
  removed.prepare("DELETE FROM transcript_events WHERE session_id = 'channel-1'").run();
  removed.prepare("DELETE FROM transcript_rewrite_watermarks WHERE session_id = 'channel-1'").run();
  removed.prepare("DELETE FROM session_windows WHERE session_id = 'channel-1'").run();
  removed.close();
  const swept = await run();
  assert.equal(swept.result.removed, 1);
  assert.equal(Object.keys(swept.manifest.sessions).length, 0);
  assert.equal(indexRuns, 5);
});

test("upgrading a v5 projection reindexes cleaned content without editing raw events", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-noise-migration-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const outputDir = join(root, "sessions");
  const manifestPath = join(root, "manifest.json");
  const body = '<file name="decision.txt" mime="text/plain">\n\n<<<EXTERNAL_UNTRUSTED_CONTENT id="abc123">>>\nSource: External\nDecision: ship Friday.\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="abc123">>>\n</file>';
  const event = { type: "message", message: { role: "user", content: body } };
  const db = createAgentDatabase(databasePath);
  insertSession(db, { sessionId: "upgrade", chatType: "channel", message: event });
  db.close();
  const params = { databasePath, outputDir, manifestPath, agentId: "main", agentName: "Pearl",
    timezone: "UTC", chatTypes: ["channel"] as const, force: false, index: async () => 0 };
  const first = await syncSessionProjections(params);
  const entry = first.manifest.sessions.upgrade!;
  const documentPath = join(outputDir, entry.documentPath);
  const clean = await readFile(documentPath, "utf8");
  assert.match(clean, /Attachment \(untrusted\).*decision.txt/);
  assert.doesNotMatch(clean, /EXTERNAL_UNTRUSTED_CONTENT/);
  // Model the previous release's projection plus manifest without modifying its source event.
  const legacy = clean.slice(0, clean.indexOf("Attachment (untrusted)")) + body + "\n";
  await writeFile(documentPath, legacy);
  entry.projectorVersion = 5;
  await writeFile(manifestPath, JSON.stringify(first.manifest));
  let indexed = false;
  const upgraded = await syncSessionProjections({ ...params, index: async () => {
    assert.equal(await readFile(documentPath, "utf8"), clean);
    indexed = true;
    return 1;
  } });
  assert.equal(upgraded.result.updated, 1);
  assert.equal(upgraded.manifest.sessions.upgrade!.projectorVersion, 6);
  assert.ok(indexed);
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try { assert.equal(source.prepare("SELECT event_json FROM transcript_events").get()!.event_json, JSON.stringify(event)); }
  finally { source.close(); }
});

test("rejects manifest document paths outside the private projection directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-session-path-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const outputDir = join(root, "sessions");
  const manifestPath = join(root, "sessions-manifest.json");
  const outsidePath = join(root, "outside.md");
  createAgentDatabase(databasePath).close();
  await writeFile(outsidePath, "keep me\n");
  await writeStaleManifest(manifestPath, "../outside.md");

  await assert.rejects(syncSessionProjections({
    databasePath,
    outputDir,
    manifestPath,
    agentId: "main",
    agentName: "Agent",
    timezone: "UTC",
    chatTypes: ["channel", "group"],
  }), /invalid unblock-memory session document path/);
  assert.equal(await readFile(outsidePath, "utf8"), "keep me\n");
});

test("rejects manifest paths redirected through a projection-directory symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-session-symlink-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const outputDir = join(root, "sessions");
  const outsideDir = join(root, "outside");
  const outsidePath = join(outsideDir, "outside.md");
  const manifestPath = join(root, "sessions-manifest.json");
  createAgentDatabase(databasePath).close();
  await mkdir(outputDir);
  await mkdir(outsideDir);
  await writeFile(outsidePath, "keep me\n");
  await symlink(outsideDir, join(outputDir, "link"));
  await writeStaleManifest(manifestPath, "link/outside.md");

  await assert.rejects(syncSessionProjections({
    databasePath,
    outputDir,
    manifestPath,
    agentId: "main",
    agentName: "Agent",
    timezone: "UTC",
    chatTypes: ["channel", "group"],
  }), /invalid unblock-memory session document path/);
  assert.equal(await readFile(outsidePath, "utf8"), "keep me\n");
});

test("accepts the tested OpenClaw schema 17 through 19 contract", async () => {
  for (const { appVersion, schemaVersion } of [
    { appVersion: "2026.8.1-beta.3", schemaVersion: 17 },
    { appVersion: "2026.8.1", schemaVersion: 18 },
    { appVersion: "2026.8.1", schemaVersion: 19 },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "unblock-memory-session-schema-"));
    const databasePath = join(root, "openclaw-agent.sqlite");
    createAgentDatabase(databasePath, "main", appVersion, schemaVersion).close();
    const synced = await syncSessionProjections({
      databasePath,
      outputDir: join(root, "sessions"),
      manifestPath: join(root, "sessions-manifest.json"),
      agentId: "main",
      agentName: "Agent",
      timezone: "UTC",
      chatTypes: ["channel", "group"],
    });
    assert.equal(synced.result.scanned, 0);
  }
});

test("schema and malformed-event failures preserve prior projections", async () => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-session-errors-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  const outputDir = join(root, "sessions");
  const manifestPath = join(root, "sessions-manifest.json");
  const db = createAgentDatabase(databasePath);
  insertSession(db, {
    sessionId: "session-1",
    chatType: "group",
    message: { type: "message", message: { role: "user", content: "Keep this" } },
  });
  db.close();
  const params = {
    databasePath,
    outputDir,
    manifestPath,
    agentId: "main",
    agentName: "Agent",
    timezone: "UTC",
    chatTypes: ["group"] as const,
    index: async () => 1,
  };
  const first = await syncSessionProjections(params);
  const projectedPath = join(outputDir, first.manifest.sessions["session-1"]!.documentPath);
  const original = await readFile(projectedPath, "utf8");
  const originalManifest = await readFile(manifestPath, "utf8");
  await assert.rejects(syncSessionProjections({
    ...params,
    index: async () => { throw new Error("embedding failed"); },
  }), /embedding failed/);
  assert.equal(await readFile(manifestPath, "utf8"), originalManifest);

  const malformed = new DatabaseSync(databasePath);
  malformed.prepare("UPDATE transcript_rewrite_watermarks SET generation = 'changed' WHERE session_id = 'session-1'").run();
  malformed.prepare("UPDATE transcript_events SET event_json = '{broken' WHERE session_id = 'session-1'").run();
  malformed.close();
  const partial = await syncSessionProjections(params);
  assert.equal(partial.result.failed, 1);
  assert.equal(partial.result.updated, 0);
  assert.equal(await readFile(projectedPath, "utf8"), original);

  const unsupported = new DatabaseSync(databasePath);
  unsupported.exec("PRAGMA user_version = 16");
  await assert.rejects(syncSessionProjections(params), /expected one of 17, 18, 19, found 16/);
  unsupported.exec("PRAGMA user_version = 20");
  unsupported.prepare("UPDATE schema_meta SET schema_version = 20 WHERE meta_key = 'primary'").run();
  unsupported.close();
  await assert.rejects(syncSessionProjections(params), /expected one of 17, 18, 19, found 20/);
  assert.equal(await readFile(projectedPath, "utf8"), original);
});
