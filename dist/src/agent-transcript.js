import { zstdDecompressSync } from "node:zlib";
/** Identity fence, not a payload-format allowlist. Required capabilities are checked below. */
export function agentTranscriptSchemaVersion(db, errorMessage) {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 17) {
        throw new Error(errorMessage ?? "unsupported OpenClaw agent database schema: expected 17 or newer, " +
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
const ACTIVE_EVENTS_FROM = `FROM session_transcript_active_events a
  JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq`;
const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/**
 * One read-only storage boundary for full-fidelity active transcripts. The public
 * SDK's full reader may restore cold archives; its read-only catalog truncates and
 * redacts content. Neither currently provides the contract these consumers need.
 * Keep payload SQL here until the SDK offers a bounded, full-fidelity read-only API.
 */
export class AgentTranscriptReader {
    db;
    #schemaVersion;
    #compressed;
    #cold;
    #utf8Storage;
    constructor(db, agentId, errorMessage) {
        this.db = db;
        const version = agentTranscriptSchemaVersion(db, errorMessage);
        this.#schemaVersion = version;
        this.#utf8Storage = db.prepare("PRAGMA encoding").get()?.encoding === "UTF-8";
        assertAgentTranscriptIdentity(db, agentId, version, errorMessage);
        const required = {
            transcript_events: ["session_id", "seq", "event_json", "created_at"],
            session_transcript_active_events: ["session_id", "active_position", "event_seq"],
        };
        const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
        for (const [table, names] of Object.entries(required)) {
            const found = columns(table);
            if (names.some(name => !found.has(name)))
                throw new Error(`Unsupported transcript capabilities: ${table}`);
        }
        const payload = columns("transcript_events");
        this.#compressed = payload.has("event_zstd") && payload.has("event_utf8_bytes");
        if ((version >= 23 || payload.has("event_zstd") || payload.has("event_utf8_bytes")) && !this.#compressed) {
            throw new Error("Unsupported transcript compression capabilities");
        }
        this.#cold = columns("session_transcript_cold_archives").has("session_id");
        if (version >= 20 && !this.#cold)
            throw new Error("Unsupported transcript cold-storage capabilities");
    }
    /** Include storage availability in incremental fingerprints, not just hot row counts. */
    coldSql(sessionIdExpression) {
        return this.#cold ? `EXISTS (SELECT 1 FROM session_transcript_cold_archives cold WHERE cold.session_id=${sessionIdExpression})` : "0";
    }
    /** Caller owns a transaction so metadata, cold marker, bounds and rows share one snapshot. */
    read(sessionId, limits = {}) {
        if (!this.db.isTransaction)
            throw new Error("Transcript read requires a snapshot transaction");
        // Long-lived audit/source readers may outlive a host migration. Reopen before
        // trusting cached capabilities; absence of old hot rows is not deletion proof.
        if (this.db.prepare("PRAGMA user_version").get()?.user_version !== this.#schemaVersion)
            return { kind: "unreadable" };
        if (this.#cold && this.db.prepare("SELECT 1 FROM session_transcript_cold_archives WHERE session_id=?").get(sessionId)) {
            return { kind: "cold" };
        }
        const maxEvents = limits.maxEvents ?? 50_000, maxBytes = limits.maxBytes ?? 64 * 1024 * 1024;
        const maxSeq = limits.maxSeq ?? Number.MAX_SAFE_INTEGER;
        // SQLite's BLOB length measures the database encoding, not decoded UTF-8.
        // Non-UTF-8 stores still enforce the byte budget below during bounded iteration.
        const bytes = !this.#utf8Storage ? "0" : this.#compressed
            ? "COALESCE(length(CAST(e.event_json AS BLOB)),e.event_utf8_bytes,0)" : "length(CAST(e.event_json AS BLOB))";
        const size = this.db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(${bytes}),0) bytes
      ${ACTIVE_EVENTS_FROM} WHERE a.session_id=? AND e.seq<=?`).get(sessionId, maxSeq);
        if (Number(size.n) > maxEvents || Number(size.bytes) > maxBytes)
            return { kind: "oversized" };
        const rows = [];
        let totalBytes = 0;
        for (const row of this.db.prepare(`SELECT e.seq,e.event_json eventJson,e.created_at createdAt
      ${this.#compressed ? ",e.event_zstd compressed,e.event_utf8_bytes rawBytes" : ""}
      ${ACTIVE_EVENTS_FROM} WHERE a.session_id=? AND e.seq<=? ORDER BY a.active_position`).iterate(sessionId, maxSeq)) {
            let eventJson;
            if (typeof row.eventJson === "string")
                eventJson = row.eventJson;
            else {
                const compressed = row.compressed, rawBytes = row.rawBytes;
                if (!(compressed instanceof Uint8Array) || !compressed.byteLength || compressed.byteLength > MAX_COMPRESSED_BYTES ||
                    typeof rawBytes !== "number" || !Number.isSafeInteger(rawBytes) || rawBytes <= 0 || rawBytes > MAX_COMPRESSED_BYTES) {
                    return { kind: "unreadable" };
                }
                try {
                    const decoded = zstdDecompressSync(compressed, { maxOutputLength: rawBytes });
                    if (decoded.byteLength !== rawBytes)
                        return { kind: "unreadable" };
                    eventJson = utf8.decode(decoded);
                }
                catch {
                    return { kind: "unreadable" };
                }
            }
            totalBytes += Buffer.byteLength(eventJson);
            if (totalBytes > maxBytes)
                return { kind: "oversized" };
            rows.push({ seq: Number(row.seq), eventJson, createdAt: Number(row.createdAt) });
        }
        return { kind: "ready", rows };
    }
}
