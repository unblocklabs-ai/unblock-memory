import { createHash, randomUUID } from "node:crypto";
import { openMemoryDatabase } from "./memory-database.js";
function memoryDigest(text) {
    return createHash("sha256").update(text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "")).digest("hex");
}
export class ExtractionStore {
    db;
    constructor(path) {
        this.db = openMemoryDatabase(path);
        try {
            const version = this.db.prepare("SELECT version FROM memory_schema WHERE component='extraction'").get()?.version;
            if (version !== undefined && version !== 1)
                throw new Error("Unsupported extraction schema");
            this.db.exec(`
      CREATE TABLE IF NOT EXISTS extraction_worker (
        id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        next_run INTEGER NOT NULL DEFAULT 0, live_since INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS extraction_sessions (
        session_id TEXT PRIMARY KEY, metadata TEXT NOT NULL CHECK(json_valid(metadata)), cursor TEXT,
        extract_since INTEGER NOT NULL,
        context TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(context)), updated_at INTEGER NOT NULL,
        error TEXT, complete_revision TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS extracted_memories (
        id TEXT NOT NULL, revision INTEGER NOT NULL, session_id TEXT NOT NULL REFERENCES extraction_sessions(session_id),
        text TEXT NOT NULL, digest TEXT NOT NULL, evidence TEXT NOT NULL CHECK(json_valid(evidence)),
        observed_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','superseded','withdrawn')),
        judgment TEXT NOT NULL CHECK(json_valid(judgment)), prompt_version TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(id,revision)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS extracted_current ON extracted_memories(id) WHERE status='active';
      CREATE UNIQUE INDEX IF NOT EXISTS extracted_duplicate ON extracted_memories(session_id,digest) WHERE status='active';
      INSERT OR IGNORE INTO memory_schema VALUES('extraction',1);
    `);
            if (!this.db.prepare("SELECT 1 FROM pragma_table_info('extraction_sessions') WHERE name='complete_revision'").get()) {
                this.db.exec("ALTER TABLE extraction_sessions ADD COLUMN complete_revision TEXT");
            }
            this.db.prepare("INSERT OR IGNORE INTO extraction_worker(id,live_since) VALUES(1,?)").run(Date.now());
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    close() { this.db.close(); }
    liveSince() { return Number(this.db.prepare("SELECT live_since FROM extraction_worker WHERE id=1").get().live_since); }
    claim(scheduled, intervalMs) {
        const owner = randomUUID(), now = Date.now();
        const result = this.db.prepare(`UPDATE extraction_worker SET owner=?,lease_until=?,next_run=?
      WHERE id=1 AND lease_until<? AND (?=0 OR next_run<=?)`).run(owner, now + 180_000, now + intervalMs, now, Number(scheduled), now);
        return result.changes ? owner : undefined;
    }
    renew(owner) {
        const now = Date.now();
        if (!this.db.prepare("UPDATE extraction_worker SET lease_until=? WHERE id=1 AND owner=? AND lease_until>=?")
            .run(now + 180_000, owner, now).changes)
            throw new Error("Extraction lease lost");
    }
    release(owner) { this.db.prepare("UPDATE extraction_worker SET owner=NULL,lease_until=0 WHERE id=1 AND owner=?").run(owner); }
    checkpoint(session, since) {
        this.db.prepare(`INSERT INTO extraction_sessions(session_id,metadata,updated_at,extract_since) VALUES(?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET metadata=excluded.metadata`).run(session.sessionId, JSON.stringify(session), Date.now(), since ?? this.liveSince());
        const row = this.db.prepare("SELECT cursor,context,extract_since,complete_revision FROM extraction_sessions WHERE session_id=?").get(session.sessionId);
        if (since !== undefined && since < Number(row.extract_since)) {
            // A broader explicitly approved backfill replays this session. Existing facts are
            // supplied to Luna and exact duplicates are ignored; history is never deleted.
            this.db.prepare("UPDATE extraction_sessions SET cursor=NULL,context='[]',complete_revision=NULL,extract_since=? WHERE session_id=?").run(since, session.sessionId);
            return { cursor: null, context: [], since, completeRevision: null };
        }
        return { cursor: row.cursor, context: JSON.parse(String(row.context)), since: Number(row.extract_since),
            completeRevision: row.complete_revision };
    }
    records(sessionId, paths) {
        const keys = paths?.filter(path => /^[a-f0-9-]+\/[1-9]\d*$/.test(path)).map(path => path.split("/"));
        if (keys && !keys.length)
            return [];
        return this.db.prepare(`SELECT m.*,s.metadata FROM extracted_memories m JOIN extraction_sessions s USING(session_id)
      WHERE status='active' ${sessionId === undefined ? "" : "AND session_id=?"}
      ${keys ? `AND (m.id,m.revision) IN (VALUES ${keys.map(() => "(?,?)").join(",")})` : ""}
      ORDER BY observed_at,id`).all(...(sessionId === undefined ? [] : [sessionId]), ...(keys?.flat() ?? []))
            .map(r => ({ id: String(r.id), revision: Number(r.revision), text: String(r.text), sessionId: String(r.session_id),
            observedAt: Number(r.observed_at), evidence: JSON.parse(String(r.evidence)), metadata: JSON.parse(String(r.metadata)), judgment: JSON.parse(String(r.judgment)) }));
    }
    reset(sessionId, cursor, owner) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.renew(owner);
            this.db.prepare("UPDATE extracted_memories SET status='withdrawn' WHERE session_id=? AND status='active'").run(sessionId);
            this.db.prepare("UPDATE extraction_sessions SET cursor=?,context='[]',complete_revision=NULL,error=NULL WHERE session_id=?").run(cursor, sessionId);
            this.db.exec("COMMIT");
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    commit(params) {
        this.db.exec("BEGIN IMMEDIATE");
        let written = 0;
        try {
            this.renew(params.owner);
            const current = this.db.prepare("SELECT cursor FROM extraction_sessions WHERE session_id=?").get(params.session.sessionId);
            if (current?.cursor !== params.expected)
                throw new Error("Extraction checkpoint changed");
            for (const { proposal, observedAt, judgment } of params.accepted) {
                const digest = memoryDigest(proposal.text);
                const duplicate = this.db.prepare("SELECT id FROM extracted_memories WHERE session_id=? AND digest=? AND status='active'")
                    .get(params.session.sessionId, digest);
                if (duplicate)
                    continue;
                let id = randomUUID(), revision = 1;
                if (proposal.replaces) {
                    const previous = this.db.prepare("SELECT revision,observed_at FROM extracted_memories WHERE id=? AND session_id=? AND status='active'")
                        .get(proposal.replaces, params.session.sessionId);
                    if (!previous || Number(previous.observed_at) > observedAt)
                        throw new Error("Invalid or stale memory replacement");
                    id = proposal.replaces;
                    revision = Number(previous.revision) + 1;
                    this.db.prepare("UPDATE extracted_memories SET status='superseded' WHERE id=? AND status='active'").run(id);
                }
                this.db.prepare(`INSERT INTO extracted_memories VALUES(?,?,?,?,?,?,?,'active',?,?,?)`)
                    .run(id, revision, params.session.sessionId, proposal.text.trim(), digest, JSON.stringify(proposal.evidence), observedAt, JSON.stringify(judgment), params.version, Date.now());
                written++;
            }
            this.db.prepare("UPDATE extraction_sessions SET cursor=?,context=?,updated_at=?,complete_revision=?,error=NULL WHERE session_id=?")
                .run(params.cursor, JSON.stringify(params.context), Date.now(), params.completeRevision ?? null, params.session.sessionId);
            this.db.exec("COMMIT");
            return written;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    error(sessionId, code) {
        this.db.prepare("UPDATE extraction_sessions SET error=?,updated_at=? WHERE session_id=?").run(code, Date.now(), sessionId);
    }
    report() {
        return { memories: this.records(), sessions: this.db.prepare("SELECT session_id,updated_at,error,cursor IS NOT NULL AS checkpointed FROM extraction_sessions").all() };
    }
}
