import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

/** The schema-23 storage transition: preserve logical events, move their UTF-8 JSON into Zstd. */
export function compressAgentTranscripts(db: DatabaseSync): void {
  // Real pre-23 stores require the same nullable-TEXT table rebuild as the host
  // migration. Preserve their event rows; this only operates on test fixtures.
  if (db.prepare("PRAGMA table_info(transcript_events)").all().some(c => c.name === "event_json" && c.notnull === 1)) {
    const schema = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='transcript_events'").get()!.sql);
    const nullable = schema.replace(/\bevent_json TEXT NOT NULL\b/i, "event_json TEXT")
      .replace(/\btranscript_events\b/, "transcript_events_compressed");
    const foreignKeys = db.prepare("PRAGMA foreign_keys").get()!.foreign_keys;
    db.exec("PRAGMA foreign_keys=OFF; BEGIN");
    try {
      db.exec(nullable);
      db.exec(`INSERT INTO transcript_events_compressed SELECT * FROM transcript_events;
        DROP TABLE transcript_events;
        ALTER TABLE transcript_events_compressed RENAME TO transcript_events;
        COMMIT;`);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    finally { db.exec(`PRAGMA foreign_keys=${Number(foreignKeys)}`); }
  }
  db.exec(`PRAGMA user_version=24; UPDATE schema_meta SET schema_version=24;
    ALTER TABLE transcript_events ADD COLUMN event_zstd BLOB;
    ALTER TABLE transcript_events ADD COLUMN event_utf8_bytes INTEGER;
    CREATE TABLE session_transcript_cold_archives (session_id TEXT PRIMARY KEY);`);
  const update = db.prepare("UPDATE transcript_events SET event_json=NULL,event_zstd=?,event_utf8_bytes=? WHERE session_id=? AND seq=?");
  for (const row of db.prepare("SELECT session_id,seq,event_json FROM transcript_events").all()) {
    const bytes = Buffer.from(String(row.event_json));
    update.run(zstdCompressSync(bytes), bytes.byteLength, row.session_id!, row.seq!);
  }
}

export function createAgentDatabase(
  path: string,
  agentId = "main",
  appVersion = "2026.8.1-beta.3",
  schemaVersion = 17,
  encoding: "UTF-8" | "UTF-16le" = "UTF-8",
): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA encoding = '${encoding}';
    PRAGMA user_version = ${schemaVersion};
    CREATE TABLE schema_meta (
      meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER,
      agent_id TEXT, app_version TEXT
    );
    INSERT INTO schema_meta VALUES ('primary', 'agent', ${schemaVersion}, '${agentId}', '${appVersion}');
    CREATE TABLE session_windows (
      session_id TEXT PRIMARY KEY, session_key TEXT, chat_type TEXT, channel TEXT,
      account_id TEXT, primary_conversation_id TEXT, created_at INTEGER,
      started_at INTEGER, ended_at INTEGER
    );
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY, channel TEXT, account_id TEXT, kind TEXT,
      peer_id TEXT, thread_id TEXT, native_channel_id TEXT,
      native_direct_user_id TEXT, label TEXT
    );
    CREATE TABLE transcript_events (
      session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE session_transcript_active_events (
      session_id TEXT, active_position INTEGER, event_seq INTEGER,
      message_position INTEGER, PRIMARY KEY (session_id, active_position)
    );
    CREATE TABLE transcript_rewrite_watermarks (
      session_id TEXT PRIMARY KEY, generation TEXT
    );
  `);
  return db;
}

export function insertSession(db: DatabaseSync, params: {
  sessionId: string;
  chatType: "channel" | "group" | "direct";
  message?: unknown;
}): void {
  const conversationId = `conversation-${params.sessionId}`;
  db.prepare("INSERT INTO conversations VALUES (?, 'slack', 'workspace', ?, ?, NULL, ?, NULL, ?)")
    .run(conversationId, params.chatType, `peer-${params.sessionId}`, `native-${params.sessionId}`, `label-${params.sessionId}`);
  db.prepare("INSERT INTO session_windows VALUES (?, ?, ?, 'slack', 'workspace', ?, 1000, 2000, NULL)")
    .run(params.sessionId, `agent:main:${params.sessionId}`, params.chatType, conversationId);
  if (params.message === undefined) return;
  db.prepare("INSERT INTO transcript_rewrite_watermarks VALUES (?, ?)").run(params.sessionId, `generation-${params.sessionId}`);
  db.prepare("INSERT INTO transcript_events VALUES (?, 1, ?, 3000)")
    .run(params.sessionId, JSON.stringify(params.message));
  db.prepare("INSERT INTO session_transcript_active_events VALUES (?, 0, 1, 0)")
    .run(params.sessionId);
}
