import { DatabaseSync } from "node:sqlite";

export function createAgentDatabase(
  path: string,
  agentId = "main",
  appVersion = "2026.8.1-beta.3",
): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA user_version = 17;
    CREATE TABLE schema_meta (
      meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER,
      agent_id TEXT, app_version TEXT
    );
    INSERT INTO schema_meta VALUES ('primary', 'agent', 17, '${agentId}', '${appVersion}');
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
