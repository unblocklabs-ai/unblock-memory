import type { DatabaseSync } from "node:sqlite";
/** The OpenClaw agent database versions whose transcript layout we read. */
export declare function agentTranscriptSchemaVersion(db: DatabaseSync, errorMessage?: string): number;
export declare function assertAgentTranscriptIdentity(db: DatabaseSync, agentId: string, version: number, errorMessage?: string): void;
export declare function assertAgentTranscriptSchema(db: DatabaseSync, agentId: string, errorMessage?: string): void;
export declare const ACTIVE_EVENTS_FROM = "FROM session_transcript_active_events a\n  JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq";
export declare const ACTIVE_EVENT_COUNT_SQL = "SELECT COUNT(*) n,COALESCE(SUM(length(e.event_json)),0) bytes\n  FROM session_transcript_active_events a\n  JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq WHERE a.session_id=?";
export declare const ACTIVE_EVENT_ROWS_SQL = "SELECT e.seq,e.event_json eventJson,e.created_at createdAt\n  FROM session_transcript_active_events a\n  JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq WHERE a.session_id=? ORDER BY a.active_position";
