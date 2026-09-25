/** The OpenClaw agent database versions whose transcript layout we read. */
export function agentTranscriptSchemaVersion(db, errorMessage) {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (typeof version !== "number" || ![17, 18, 19].includes(version)) {
        throw new Error(errorMessage ?? "unsupported OpenClaw agent database schema: expected one of 17, 18, 19, " +
            `found ${String(version ?? "unknown")}`);
    }
    return version;
}
export function assertAgentTranscriptIdentity(db, agentId, version, errorMessage) {
    const fail = (message) => { throw new Error(errorMessage ?? message); };
    const meta = db.prepare("SELECT role, schema_version AS schemaVersion, agent_id AS agentId " +
        "FROM schema_meta WHERE meta_key = 'primary' LIMIT 1").get();
    if (meta?.role !== "agent" || meta.schemaVersion !== version) {
        fail("unsupported OpenClaw agent database primary schema metadata");
    }
    if (meta?.agentId !== agentId) {
        fail(`OpenClaw agent database belongs to ${String(meta?.agentId)}, not ${agentId}`);
    }
}
export function assertAgentTranscriptSchema(db, agentId, errorMessage) {
    assertAgentTranscriptIdentity(db, agentId, agentTranscriptSchemaVersion(db, errorMessage), errorMessage);
}
export const ACTIVE_EVENTS_FROM = `FROM session_transcript_active_events a
  JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq`;
export const ACTIVE_EVENT_COUNT_SQL = `SELECT COUNT(*) n,COALESCE(SUM(length(e.event_json)),0) bytes
  ${ACTIVE_EVENTS_FROM} WHERE a.session_id=?`;
export const ACTIVE_EVENT_ROWS_SQL = `SELECT e.seq,e.event_json eventJson,e.created_at createdAt
  ${ACTIVE_EVENTS_FROM} WHERE a.session_id=? ORDER BY a.active_position`;
