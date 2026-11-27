import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { PROJECTOR_VERSION, syncSessionProjections, unchangedSessionSync } from "../src/session-sync.js";
import { MEMORY_DATABASE } from "../src/memory-database.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";
import { fakeSessionIndex, listFiles, sqliteSessionState } from "./helpers/session-index.js";

async function harness(prefix: string, legacy = false) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const sqlite = sqliteSessionState(join(root, MEMORY_DATABASE), "main", legacy ? root : undefined);
  const fake = fakeSessionIndex();
  return { root, ...sqlite, fake };
}

test("refresh retains compressed active history and preserves projections when history goes cold or corrupt", async (t) => {
  const h = await harness("unblock-memory-storage-evolution-");
  t.after(h.close);
  const databasePath = join(h.root, "agent.sqlite");
  const params = { databasePath, state: h.store, index: h.fake.index,
    agentId: "main", agentName: "Theo", timezone: "UTC", chatTypes: ["channel"] as const };
  const db = createAgentDatabase(databasePath, "main", "2026.9.2", 19);
  const eventJson = JSON.stringify({ type: "message", message: { role: "user", content: "Keep this compressed history 🦉" } });
  insertSession(db, { sessionId: "evolved", chatType: "channel", message: JSON.parse(eventJson) });
  const original = await syncSessionProjections(params);
  const path = original.manifest.sessions.evolved!.documentPath;
  const text = h.fake.content(path);
  assert.ok(text);
  db.exec(`PRAGMA user_version=24; UPDATE schema_meta SET schema_version=24;
    ALTER TABLE transcript_events ADD COLUMN event_zstd BLOB;
    ALTER TABLE transcript_events ADD COLUMN event_utf8_bytes INTEGER;
    CREATE TABLE session_transcript_cold_archives (session_id TEXT PRIMARY KEY);`);
  db.prepare("UPDATE transcript_events SET event_json=NULL,event_zstd=?,event_utf8_bytes=?")
    .run(zstdCompressSync(Buffer.from(eventJson)), Buffer.byteLength(eventJson));
  const compressed = await syncSessionProjections({ ...params, force: true });
  assert.equal(compressed.result.failed, 0);
  assert.equal(h.fake.content(path), text);
  // A storage transition must invalidate the incremental fast path even without a rewrite.
  db.prepare("INSERT INTO session_transcript_cold_archives VALUES ('evolved')").run();
  db.exec("DELETE FROM transcript_events; DELETE FROM session_transcript_active_events;");
  const cold = await syncSessionProjections(params);
  assert.equal(cold.result.failed, 1);
  assert.equal(cold.result.removed, 0);
  assert.equal(h.fake.content(path), text);
  assert.deepEqual(cold.manifest.sessions.evolved, compressed.manifest.sessions.evolved);
  assert.equal(typeof cold.manifest.failedSessions?.evolved, "string");
  db.exec("DELETE FROM session_transcript_cold_archives");
  db.prepare("INSERT INTO transcript_events VALUES ('evolved',1,NULL,3000,?,?)")
    .run(zstdCompressSync(Buffer.from(eventJson)), Buffer.byteLength(eventJson) + 1);
  db.exec("INSERT INTO session_transcript_active_events VALUES ('evolved',0,1,0)");
  const corrupt = await syncSessionProjections({ ...params, force: true });
  assert.equal(corrupt.result.failed, 1);
  assert.equal(corrupt.result.removed, 0);
  assert.equal(h.fake.content(path), text);
  assert.equal(typeof corrupt.manifest.failedSessions?.evolved, "string");
  db.close();
});

test("incrementally projects only configured active sessions straight into QMD", async (t) => {
  const h = await harness("unblock-memory-sessions-");
  t.after(h.close);
  const databasePath = join(h.root, "openclaw-agent.sqlite");
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

  const run = (force = false) => syncSessionProjections({
    databasePath, state: h.store, index: h.fake.index,
    agentId: "main", agentName: "Bill", timezone: "UTC", chatTypes: ["channel", "group"], force,
  });

  const first = await run();
  assert.deepEqual({
    scanned: first.result.scanned,
    updated: first.result.updated,
    skipped: first.result.skipped,
    embedded: first.result.embedded,
  }, { scanned: 2, updated: 1, skipped: 1, embedded: 1 });
  // The first sync has no committed generation, so it reconciles the whole collection atomically.
  assert.deepEqual(h.fake.stats, { upserts: 0, retracts: 0, replaces: 1, embeds: 1 });
  const [session] = Object.values(first.manifest.sessions);
  assert.ok(session);
  assert.equal(session.chatType, "channel");
  assert.equal(session.provider, "slack");
  assert.equal(session.conversationId, "native-channel-1");
  const indexed = h.fake.documents.get(session.documentPath)!;
  const document = indexed.content;
  assert.match(document, /## User — Bek — .*\n\nHello memory/u);
  assert.doesNotMatch(document, /Private DM/);
  assert.doesNotMatch(document, /Abandoned branch/);
  assert.equal(session.projectorVersion, PROJECTOR_VERSION);
  assert.deepEqual(session.messages, [{ type: "user", name: "Bek", timestamp: "2026-08-25 14:32:09 UTC",
    timestampMs: Date.UTC(2026, 7, 25, 14, 32, 9),
    start: document.indexOf("## User"), bodyStart: document.indexOf("Hello memory"), end: document.length - 1 }]);
  // Session chronology: QMD dates match the session start, as the file-era mtime did.
  assert.equal(indexed.modifiedAt, new Date(session.startedAt).toISOString());
  assert.equal(indexed.createdAt, new Date(session.startedAt).toISOString());
  assert.equal(first.manifest.generation, await h.fake.index.generation());
  assert.deepEqual(h.state.readManifest(), first.manifest);

  const second = await run();
  assert.equal(second.result.unchanged, 2); // Includes the checkpointed empty session.
  assert.equal(second.result.updated, 0);
  assert.equal(second.result.embedded, 1); // No index file to certify, so embedding re-runs (incrementally).
  assert.equal(h.fake.stats.replaces, 1, "a matching generation never reconciles again");
  assert.equal(h.fake.stats.upserts, 0);

  const oldProjectorManifest = structuredClone(second.manifest);
  oldProjectorManifest.sessions["channel-1"]!.projectorVersion = PROJECTOR_VERSION - 1;
  delete oldProjectorManifest.sessions["channel-1"]!.messages;
  h.state.writeManifest(oldProjectorManifest);
  const migrated = await run();
  assert.equal(migrated.result.updated, 1);
  assert.equal(migrated.manifest.sessions["channel-1"]!.projectorVersion, PROJECTOR_VERSION);
  assert.deepEqual(migrated.manifest.sessions["channel-1"]!.messages, session.messages);
  assert.equal(h.fake.content(session.documentPath), document);

  const changed = new DatabaseSync(databasePath);
  changed.prepare("UPDATE transcript_rewrite_watermarks SET generation = 'generation-2' WHERE session_id = 'channel-1'").run();
  changed.prepare("INSERT INTO transcript_events VALUES ('channel-1', 2, ?, 4000)").run(JSON.stringify({
    type: "message", timestamp: "2026-08-25T14:33:00Z",
    message: { role: "assistant", content: [{ type: "text", text: "Indexed response" }] },
  }));
  changed.prepare("INSERT INTO session_transcript_active_events VALUES ('channel-1', 1, 2, 1)").run();
  changed.close();

  const generationBefore = await h.fake.index.generation();
  const third = await run();
  assert.equal(third.result.updated, 1);
  assert.equal(await h.fake.index.generation(), generationBefore + 1, "one upsert, one generation bump");
  assert.match(h.fake.content(third.manifest.sessions["channel-1"]!.documentPath)!,
    /## Assistant — Bill — .*\n\nIndexed response/u);

  const removed = new DatabaseSync(databasePath);
  removed.prepare("DELETE FROM session_transcript_active_events WHERE session_id = 'channel-1'").run();
  removed.prepare("DELETE FROM transcript_events WHERE session_id = 'channel-1'").run();
  removed.prepare("DELETE FROM transcript_rewrite_watermarks WHERE session_id = 'channel-1'").run();
  removed.prepare("DELETE FROM session_windows WHERE session_id = 'channel-1'").run();
  removed.close();
  const swept = await run();
  assert.equal(swept.result.removed, 1);
  assert.equal(Object.keys(swept.manifest.sessions).length, 0);
  assert.equal(h.fake.documents.size, 0, "retracted from QMD");
  assert.equal(h.fake.stats.retracts, 1);
});

test("never writes Markdown transport, manifest, lock or status sidecars", async (t) => {
  const h = await harness("unblock-memory-no-sidecars-");
  t.after(h.close);
  const databasePath = join(h.root, "openclaw-agent.sqlite");
  const db = createAgentDatabase(databasePath);
  insertSession(db, { sessionId: "s", chatType: "channel",
    message: { type: "message", message: { role: "user", content: "Only QMD holds this" } } });
  db.close();
  const before = listFiles(h.root);
  const params = { databasePath, state: h.store, index: h.fake.index,
    agentId: "main", agentName: "Agent", timezone: "UTC", chatTypes: ["channel"] as const };
  await syncSessionProjections(params);
  await syncSessionProjections({ ...params, force: true });
  assert.deepEqual(listFiles(h.root), before);
  assert.ok(!listFiles(h.root).some(file => file.endsWith(".md") || file.endsWith(".json") || file.includes("session-sync")));
  assert.equal(existsSync(join(h.root, "sessions")), false);
  assert.equal(h.fake.documents.size, 1);
});

test("imports a legacy sessions-manifest.json once, then reconciles the collection via a full replace", async (t) => {
  const h = await harness("unblock-memory-legacy-import-", true);
  t.after(h.close);
  const databasePath = join(h.root, "openclaw-agent.sqlite");
  const db = createAgentDatabase(databasePath);
  insertSession(db, { sessionId: "kept", chatType: "channel",
    message: { type: "message", message: { role: "user", content: "Carried over" } } });
  db.close();
  const params = { databasePath, state: h.store, index: h.fake.index,
    agentId: "main", agentName: "Agent", timezone: "UTC", chatTypes: ["channel"] as const };
  // Produce a realistic v8 manifest, then model the pre-0.18 sidecar (no generation) left on disk.
  const scratch = fakeSessionIndex();
  const legacyState = sqliteSessionState(join(h.root, "scratch.sqlite"));
  const produced = await syncSessionProjections({ ...params, state: legacyState.store, index: scratch.index });
  legacyState.close();
  const legacy = { ...structuredClone(produced.manifest), generation: undefined, indexSignature: "file-era" };
  legacy.sessions.gone = { ...legacy.sessions.kept!, sessionId: "gone", documentPath: "slack/channel/w/gone.md" };
  await writeFile(join(h.root, "sessions-manifest.json"), JSON.stringify(legacy));
  // The upgraded index still holds the file-era documents (including a stray for a vanished session).
  for (const document of scratch.documents.values()) await h.fake.index.upsert(document);
  await h.fake.index.upsert({ path: "slack/channel/w/gone.md", content: "stale", createdAt: "x", modifiedAt: "x" });

  assert.equal(h.state.revision(), 0);
  const imported = h.state.readManifest();
  assert.equal(h.state.revision(), 1, "imported into SQLite");
  assert.equal(imported.generation, undefined);
  assert.ok(imported.sessions.gone);
  await writeFile(join(h.root, "sessions-manifest.json"), "{ corrupt after import");
  assert.deepEqual(h.state.readManifest(), imported, "the legacy file is never read again");

  const upgraded = await syncSessionProjections(params);
  assert.equal(h.fake.stats.replaces, 1, "legacy manifests reconcile through syncProjectedCollection");
  assert.deepEqual([...h.fake.documents.keys()], [produced.manifest.sessions.kept!.documentPath]);
  assert.equal(upgraded.result.removed, 1);
  assert.equal(upgraded.result.updated, 0, "identical content is not re-counted");
  assert.equal(upgraded.manifest.generation, await h.fake.index.generation());
  assert.equal(await unchangedSessionSync({ ...params }, join(h.root, "missing-index.sqlite")), undefined);

  await syncSessionProjections(params);
  assert.equal(h.fake.stats.replaces, 1, "incremental once the generation is committed");
});

test("a collection changed behind the manifest reconciles and restores retracted documents", async (t) => {
  const h = await harness("unblock-memory-reconcile-");
  t.after(h.close);
  const databasePath = join(h.root, "openclaw-agent.sqlite");
  const db = createAgentDatabase(databasePath);
  insertSession(db, { sessionId: "s", chatType: "channel",
    message: { type: "message", message: { role: "user", content: "Restore me" } } });
  db.close();
  const params = { databasePath, state: h.store, index: h.fake.index,
    agentId: "main", agentName: "Agent", timezone: "UTC", chatTypes: ["channel"] as const };
  const first = await syncSessionProjections(params);
  h.fake.documents.clear();
  h.fake.externalChange();
  const repaired = await syncSessionProjections(params);
  assert.equal(h.fake.stats.replaces, 2);
  assert.ok(h.fake.content(first.manifest.sessions.s!.documentPath)?.includes("Restore me"));
  assert.equal(repaired.manifest.generation, await h.fake.index.generation());
});

test("upgrading a v5 projection reindexes cleaned content without editing raw events", async (t) => {
  const h = await harness("unblock-memory-noise-migration-");
  t.after(h.close);
  const databasePath = join(h.root, "openclaw-agent.sqlite");
  const body = '<file name="decision.txt" mime="text/plain">\n\n<<<EXTERNAL_UNTRUSTED_CONTENT id="abc123">>>\nSource: External\nDecision: ship Friday.\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="abc123">>>\n</file>';
  const event = { type: "message", message: { role: "user", content: body } };
  const db = createAgentDatabase(databasePath);
  insertSession(db, { sessionId: "upgrade", chatType: "channel", message: event });
  db.close();
  const params = { databasePath, state: h.store, index: h.fake.index, agentId: "main", agentName: "Pearl",
    timezone: "UTC", chatTypes: ["channel"] as const, force: false };
  const first = await syncSessionProjections(params);
  const entry = first.manifest.sessions.upgrade!;
  const clean = h.fake.content(entry.documentPath)!;
  assert.match(clean, /Attachment \(untrusted\).*decision.txt/);
  assert.doesNotMatch(clean, /EXTERNAL_UNTRUSTED_CONTENT/);
  // Model the previous release's indexed projection plus manifest without modifying its source event.
  const legacy = clean.slice(0, clean.indexOf("Attachment (untrusted)")) + body + "\n";
  await h.fake.index.upsert({ ...h.fake.documents.get(entry.documentPath)!, content: legacy });
  entry.projectorVersion = 5;
  h.state.writeManifest({ ...first.manifest, generation: await h.fake.index.generation() });
  let indexed = false;
  h.fake.hooks.embed = () => {
    assert.equal(h.fake.content(entry.documentPath), clean);
    indexed = true;
    return 1;
  };
  const upgraded = await syncSessionProjections(params);
  assert.equal(upgraded.result.updated, 1);
  assert.equal(upgraded.manifest.sessions.upgrade!.projectorVersion, PROJECTOR_VERSION);
  assert.ok(indexed);
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try { assert.equal(source.prepare("SELECT event_json FROM transcript_events").get()!.event_json, JSON.stringify(event)); }
  finally { source.close(); }
});

test("rejects manifest document paths that are not collection-relative", async (t) => {
  const h = await harness("unblock-memory-session-path-");
  t.after(h.close);
  const databasePath = join(h.root, "openclaw-agent.sqlite");
  createAgentDatabase(databasePath).close();
  h.state.writeManifest({ version: 1, sessions: { stale: {
    sessionId: "stale", chatType: "channel", startedAt: 1, sourceGeneration: "generation", maxSeq: 1,
    activeEventCount: 1, sizeBytes: 8, projectionHash: "hash", documentPath: "../outside.md", projectorVersion: 1,
  } } });
  await assert.rejects(syncSessionProjections({
    databasePath, state: h.store, index: h.fake.index,
    agentId: "main", agentName: "Agent", timezone: "UTC", chatTypes: ["channel", "group"],
  }), /invalid unblock-memory session document path/);
  assert.deepEqual(h.fake.stats, { upserts: 0, retracts: 0, replaces: 0, embeds: 0 });
});

test("accepts the tested OpenClaw schema 17 through 19 contract", async () => {
  for (const { appVersion, schemaVersion } of [
    { appVersion: "2026.8.1-beta.3", schemaVersion: 17 },
    { appVersion: "2026.8.1", schemaVersion: 18 },
    { appVersion: "2026.8.1", schemaVersion: 19 },
  ]) {
    const h = await harness("unblock-memory-session-schema-");
    const databasePath = join(h.root, "openclaw-agent.sqlite");
    createAgentDatabase(databasePath, "main", appVersion, schemaVersion).close();
    try {
      const synced = await syncSessionProjections({
        databasePath, state: h.store, index: h.fake.index,
        agentId: "main", agentName: "Agent", timezone: "UTC", chatTypes: ["channel", "group"],
      });
      assert.equal(synced.result.scanned, 0);
    } finally { h.close(); }
  }
});

test("schema and malformed-event failures preserve prior projections", async (t) => {
  const h = await harness("unblock-memory-session-errors-");
  t.after(h.close);
  const databasePath = join(h.root, "openclaw-agent.sqlite");
  const db = createAgentDatabase(databasePath);
  insertSession(db, {
    sessionId: "session-1",
    chatType: "group",
    message: { type: "message", message: { role: "user", content: "Keep this" } },
  });
  db.close();
  const params = {
    databasePath, state: h.store, index: h.fake.index,
    agentId: "main", agentName: "Agent", timezone: "UTC", chatTypes: ["group"] as const,
  };
  const first = await syncSessionProjections(params);
  const projectedPath = first.manifest.sessions["session-1"]!.documentPath;
  const original = h.fake.content(projectedPath);
  const originalManifest = h.state.readManifest();
  h.fake.hooks.embed = () => { throw new Error("embedding failed"); };
  await assert.rejects(syncSessionProjections({ ...params, force: true }), /embedding failed/);
  assert.deepEqual(h.state.readManifest(), originalManifest, "manifest only commits after QMD accepted the run");
  delete h.fake.hooks.embed;

  const malformed = new DatabaseSync(databasePath);
  malformed.prepare("UPDATE transcript_rewrite_watermarks SET generation = 'changed' WHERE session_id = 'session-1'").run();
  malformed.prepare("UPDATE transcript_events SET event_json = '{broken' WHERE session_id = 'session-1'").run();
  malformed.close();
  const partial = await syncSessionProjections(params);
  assert.equal(partial.result.failed, 1);
  assert.equal(partial.result.updated, 0);
  assert.equal(h.fake.content(projectedPath), original);

  const unsupported = new DatabaseSync(databasePath);
  unsupported.exec("PRAGMA user_version = 16");
  await assert.rejects(syncSessionProjections(params), /unsupported.*schema.*found 16/);
  unsupported.exec("PRAGMA user_version = 20");
  unsupported.prepare("UPDATE schema_meta SET schema_version = 20 WHERE meta_key = 'primary'").run();
  unsupported.close();
  await assert.rejects(syncSessionProjections(params), /Unsupported transcript cold-storage capabilities/);
  assert.equal(h.fake.content(projectedPath), original);
});

test("recovered cold window reprojects after a projection config change and partial runs do not advance lastSuccessfulSyncAt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-partial-config-change-"));
  const indexPath = join(root, "index.sqlite");
  const sqlite = sqliteSessionState(join(root, MEMORY_DATABASE));
  t.after(sqlite.close);
  const fake = fakeSessionIndex({ path: indexPath });
  const databasePath = join(root, "agent.sqlite");
  const db = createAgentDatabase(databasePath, "main", "2026.9.2", 19);
  insertSession(db, {
    sessionId: "stable",
    chatType: "channel",
    message: {
      type: "message",
      timestamp: "2026-08-25T14:32:09Z",
      message: { role: "assistant", content: "Stable window reply" },
    },
  });
  insertSession(db, {
    sessionId: "cold-window",
    chatType: "channel",
    message: {
      type: "message",
      timestamp: "2026-08-25T15:00:00Z",
      message: { role: "assistant", content: "Cold window reply" },
    },
  });
  db.exec(`
    PRAGMA user_version=24;
    UPDATE schema_meta SET schema_version=24;
    ALTER TABLE transcript_events ADD COLUMN event_zstd BLOB;
    ALTER TABLE transcript_events ADD COLUMN event_utf8_bytes INTEGER;
    CREATE TABLE session_transcript_cold_archives (session_id TEXT PRIMARY KEY);
  `);
  const baseParams = { databasePath, state: sqlite.store, index: fake.index, agentId: "main", chatTypes: ["channel"] as const };
  const utcParams = { ...baseParams, agentName: "Theo", timezone: "UTC" };
  const nyParams = { ...baseParams, agentName: "Bill", timezone: "America/New_York" };

  try {
    const first = await syncSessionProjections(utcParams);
    assert.equal(first.result.failed, 0);
    assert.equal(first.result.updated, 2);
    assert.ok(first.manifest.lastSuccessfulSyncAt);
    assert.ok(first.manifest.indexSignature);
    const coldDocPath = first.manifest.sessions["cold-window"]!.documentPath;
    assert.match(fake.content(coldDocPath)!, /## Assistant — Theo — 2026-08-25 15:00:00 UTC/u);

    // A v1 manifest without per-entry projectionKey before config change + cold failure.
    const legacyManifest = structuredClone(first.manifest);
    delete legacyManifest.sessions.stable!.projectionKey;
    delete legacyManifest.sessions["cold-window"]!.projectionKey;
    sqlite.state.writeManifest(legacyManifest);

    db.prepare("INSERT INTO session_transcript_cold_archives VALUES ('cold-window')").run();
    const partial = await syncSessionProjections(nyParams);
    assert.equal(partial.result.failed, 1);
    assert.equal(partial.result.updated, 1);
    assert.equal(partial.manifest.lastSuccessfulSyncAt, first.manifest.lastSuccessfulSyncAt);
    assert.equal(partial.result.lastSuccessfulSyncAt, first.result.lastSuccessfulSyncAt);
    assert.equal(partial.manifest.projectionKey, first.manifest.projectionKey);
    assert.equal(partial.manifest.indexSignature, undefined);
    assert.equal(typeof partial.manifest.failedSessions?.["cold-window"], "string");
    assert.equal(partial.manifest.sessions["cold-window"]!.projectionKey, first.manifest.projectionKey);
    assert.notEqual(partial.manifest.sessions.stable!.projectionKey, first.manifest.projectionKey);
    assert.match(fake.content(coldDocPath)!, /## Assistant — Theo — 2026-08-25 15:00:00 UTC/u);

    db.exec("DELETE FROM session_transcript_cold_archives");
    assert.equal(await unchangedSessionSync(nyParams, indexPath), undefined);

    const recovered = await syncSessionProjections(nyParams);
    assert.equal(recovered.result.failed, 0);
    assert.equal(recovered.result.updated, 1);
    assert.equal(recovered.result.unchanged, 1);
    assert.equal(recovered.manifest.failedSessions, undefined);
    assert.match(fake.content(coldDocPath)!, /## Assistant — Bill — 2026-08-25 11:00:00 EDT/u);
    assert.notEqual(recovered.manifest.projectionKey, first.manifest.projectionKey);
    assert.ok(recovered.manifest.indexSignature);
    assert.ok((recovered.manifest.lastSuccessfulSyncAt ?? 0) >= (first.manifest.lastSuccessfulSyncAt ?? 0));
    assert.equal((await unchangedSessionSync(nyParams, indexPath))?.skipReason, "no_changes");
  } finally {
    db.close();
  }
});

test("records brand-new failed/unavailable windows in failedSessions and clears them once healthy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-failed-sessions-"));
  const indexPath = join(root, "index.sqlite");
  const sqlite = sqliteSessionState(join(root, MEMORY_DATABASE));
  t.after(sqlite.close);
  const fake = fakeSessionIndex({ path: indexPath });
  const databasePath = join(root, "agent.sqlite");
  const db = createAgentDatabase(databasePath, "main", "2026.9.2", 19);
  insertSession(db, {
    sessionId: "healthy",
    chatType: "channel",
    message: { type: "message", message: { role: "user", content: "Healthy window" } },
  });
  insertSession(db, {
    sessionId: "cold-new",
    chatType: "channel",
    message: { type: "message", message: { role: "user", content: "Cold new window" } },
  });
  db.exec(`
    PRAGMA user_version=24;
    UPDATE schema_meta SET schema_version=24;
    ALTER TABLE transcript_events ADD COLUMN event_zstd BLOB;
    ALTER TABLE transcript_events ADD COLUMN event_utf8_bytes INTEGER;
    CREATE TABLE session_transcript_cold_archives (session_id TEXT PRIMARY KEY);
    INSERT INTO session_transcript_cold_archives VALUES ('cold-new');
  `);
  const params = { databasePath, state: sqlite.store, index: fake.index,
    agentId: "main", agentName: "Theo", timezone: "UTC", chatTypes: ["channel"] as const };
  try {
    const first = await syncSessionProjections(params);
    assert.equal(first.result.failed, 1);
    assert.equal(first.result.updated, 1);
    assert.equal(first.manifest.sessions["cold-new"], undefined);
    assert.equal(typeof first.manifest.failedSessions?.["cold-new"], "string");
    assert.ok(first.manifest.failedSessions!["cold-new"]!.length > 0);
    assert.equal(first.manifest.generation, await fake.index.generation(), "a partial reconcile still certifies its generation");

    assert.deepEqual(sqlite.state.readManifest().failedSessions, first.manifest.failedSessions);
    assert.equal(await unchangedSessionSync(params, indexPath), undefined);

    db.exec("DELETE FROM session_transcript_cold_archives");
    const recovered = await syncSessionProjections(params);
    assert.equal(recovered.result.failed, 0);
    assert.equal(recovered.result.updated, 1);
    assert.ok(recovered.manifest.sessions["cold-new"]);
    assert.equal(recovered.manifest.failedSessions, undefined);
    assert.equal(sqlite.state.readManifest().failedSessions, undefined);
    assert.equal((await unchangedSessionSync(params, indexPath))?.skipReason, "no_changes");
  } finally {
    db.close();
  }
});

async function coldCapableDatabase(databasePath: string, sessions: Record<string, string>) {
  const db = createAgentDatabase(databasePath, "main", "2026.9.2", 19);
  for (const [sessionId, content] of Object.entries(sessions)) {
    insertSession(db, { sessionId, chatType: "channel", message: { type: "message", message: { role: "user", content } } });
  }
  db.exec(`PRAGMA user_version=24; UPDATE schema_meta SET schema_version=24;
    ALTER TABLE transcript_events ADD COLUMN event_zstd BLOB;
    ALTER TABLE transcript_events ADD COLUMN event_utf8_bytes INTEGER;
    CREATE TABLE session_transcript_cold_archives (session_id TEXT PRIMARY KEY);`);
  return db;
}

test("a reconcile with a permanently cold window keeps its document, sweeps true strays and stays incremental", async (t) => {
  const h = await harness("unblock-memory-partial-reconcile-");
  t.after(h.close);
  const databasePath = join(h.root, "agent.sqlite");
  const db = await coldCapableDatabase(databasePath, { healthy: "Healthy window", frozen: "Frozen window" });
  t.after(() => db.close());
  const params = { databasePath, state: h.store, index: h.fake.index,
    agentId: "main", agentName: "Theo", timezone: "UTC", chatTypes: ["channel"] as const };
  const first = await syncSessionProjections(params);
  const frozenPath = first.manifest.sessions.frozen!.documentPath;
  const frozenText = h.fake.content(frozenPath);
  assert.ok(frozenText);
  // The window goes permanently cold, and someone else changes the collection (a stray appears): reconcile.
  db.prepare("INSERT INTO session_transcript_cold_archives VALUES ('frozen')").run();
  await h.fake.index.upsert({ path: "slack/channel/w/stray.md", content: "stale stray", createdAt: "x", modifiedAt: "x" });
  const replacesBefore = h.fake.stats.replaces;
  const partial = await syncSessionProjections(params);
  assert.equal(partial.result.failed, 1);
  assert.equal(h.fake.stats.replaces, replacesBefore, "a partial reconcile never replaces the whole collection");
  assert.equal(h.fake.content(frozenPath), frozenText, "the failed window keeps its existing document");
  assert.equal(h.fake.content("slack/channel/w/stray.md"), undefined, "a true stray is retracted");
  assert.ok(h.fake.content(first.manifest.sessions.healthy!.documentPath));
  assert.equal(partial.manifest.generation, await h.fake.index.generation(), "the swept generation is certified");
  assert.equal(typeof partial.manifest.failedSessions?.frozen, "string");

  // Later syncs are incremental: no full reconcile, no re-upsert of healthy windows, the cold window just retried.
  h.fake.writes.length = 0;
  const next = await syncSessionProjections(params);
  assert.equal(next.result.failed, 1);
  assert.equal(next.result.unchanged, 1);
  assert.deepEqual(h.fake.writes, [], "no QMD writes at all");
  assert.equal(next.manifest.generation, await h.fake.index.generation());

  // Once the window recovers it reprojects incrementally, still without a full reconcile.
  db.exec("DELETE FROM session_transcript_cold_archives");
  const recovered = await syncSessionProjections(params);
  assert.equal(recovered.result.failed, 0);
  assert.equal(recovered.manifest.failedSessions, undefined);
  assert.equal(h.fake.stats.replaces, replacesBefore);
});

test("a fenced-out sync never mutates QMD and the reconcile replace receives the abort signal", async (t) => {
  const h = await harness("unblock-memory-fenced-sync-");
  t.after(h.close);
  const databasePath = join(h.root, "agent.sqlite");
  const db = createAgentDatabase(databasePath);
  insertSession(db, { sessionId: "s", chatType: "channel",
    message: { type: "message", message: { role: "user", content: "Fenced content" } } });
  db.close();
  const params = { databasePath, state: h.store, index: h.fake.index,
    agentId: "main", agentName: "Agent", timezone: "UTC", chatTypes: ["channel"] as const };

  // Fence lost right before the first write: the probe aborts, nothing reaches QMD or the manifest.
  const fenced = new AbortController();
  let probes = 0;
  await assert.rejects(syncSessionProjections({ ...params, signal: fenced.signal,
    beforeWrite: () => { probes += 1; fenced.abort(new Error("fence lost")); } }), /fence lost/u);
  assert.equal(probes, 1);
  assert.deepEqual(h.fake.writes, []);
  assert.equal(h.fake.documents.size, 0);
  assert.equal(h.state.revision(), 0, "no manifest from the fenced attempt");

  // The live attempt hands its signal to QMD's bulk reconcile.
  const live = new AbortController();
  const seen: (AbortSignal | undefined)[] = [];
  const replace = h.fake.index.replace;
  const index = { ...h.fake.index, replace: (documents: Parameters<typeof replace>[0], signal?: AbortSignal) => {
    seen.push(signal);
    return replace(documents, signal);
  } };
  const synced = await syncSessionProjections({ ...params, index, signal: live.signal, beforeWrite: () => { probes += 1; } });
  assert.deepEqual(seen, [live.signal]);
  assert.ok(probes >= 3, "probed before the replace and before embedding");
  assert.equal(synced.result.updated, 1);

  // Incremental writes probe before every upsert/retract: a fence lost mid-batch stops the remaining writes.
  const changed = new DatabaseSync(databasePath);
  insertSession(changed, { sessionId: "t", chatType: "channel",
    message: { type: "message", message: { role: "user", content: "Second" } } });
  changed.prepare("DELETE FROM session_windows WHERE session_id='s'").run();
  changed.close();
  h.fake.writes.length = 0;
  const midway = new AbortController();
  await assert.rejects(syncSessionProjections({ ...params, signal: midway.signal,
    beforeWrite: () => { if (h.fake.writes.length) midway.abort(new Error("fence lost mid-batch")); } }), /mid-batch/u);
  assert.equal(h.fake.writes.length, 1, "exactly one write before the fence loss, none after");
});
