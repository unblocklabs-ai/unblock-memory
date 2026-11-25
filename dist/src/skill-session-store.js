import { immediateTransaction, openMemoryDatabase } from "./memory-database.js";
export class SkillSessionStore {
    #db;
    constructor(dbPath) {
        // This handle also serves prompt hooks; don't block the gateway on a background writer.
        this.#db = openMemoryDatabase(dbPath, { busyTimeoutMs: 100 });
        try {
            this.#db.exec(`CREATE TABLE IF NOT EXISTS skill_whisper_sessions (
        session_scope TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_description TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('whisperer', 'read')),
        score REAL,
        added_turn INTEGER NOT NULL,
        added_at_ms INTEGER NOT NULL,
        last_used_at_ms INTEGER NOT NULL,
        PRIMARY KEY (session_scope, canonical_path)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_whisper_sessions_scope
        ON skill_whisper_sessions(session_scope, added_at_ms ASC);`);
        }
        catch (error) {
            this.#db.close();
            throw error;
        }
    }
    list(scope) {
        return this.#db.prepare(`SELECT canonical_path, skill_name, skill_description, source, score,
        added_turn, added_at_ms, last_used_at_ms
      FROM skill_whisper_sessions WHERE session_scope = ?
      ORDER BY added_at_ms ASC, canonical_path ASC`).all(scope).map(row => ({
            canonicalPath: String(row.canonical_path),
            name: String(row.skill_name),
            description: String(row.skill_description),
            source: row.source,
            score: row.score === null ? undefined : Number(row.score),
            addedTurn: Number(row.added_turn),
            addedAtMs: Number(row.added_at_ms),
            lastUsedAtMs: Number(row.last_used_at_ms),
        }));
    }
    upsert(scope, entries) {
        if (!entries.length)
            return;
        immediateTransaction(this.#db, () => this.#write(scope, entries));
    }
    #write(scope, entries) {
        const statement = this.#db.prepare(`INSERT INTO skill_whisper_sessions (
      session_scope, canonical_path, skill_name, skill_description, source, score,
      added_turn, added_at_ms, last_used_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_scope, canonical_path) DO UPDATE SET
      skill_name = excluded.skill_name,
      skill_description = excluded.skill_description,
      last_used_at_ms = excluded.last_used_at_ms,
      score = coalesce(excluded.score, skill_whisper_sessions.score)`);
        for (const entry of entries) {
            statement.run(scope, entry.canonicalPath, entry.name, entry.description, entry.source, entry.score ?? null, entry.addedTurn, entry.addedAtMs, entry.lastUsedAtMs);
        }
    }
    rebindSession(scopes, successor, entries) {
        immediateTransaction(this.#db, () => {
            this.deleteSession(successor);
            this.#write(successor, entries);
            for (const scope of scopes)
                this.deleteSession(scope);
        });
    }
    pruneMissing(scope, validCanonicalPaths) {
        this.#db.prepare(`DELETE FROM skill_whisper_sessions WHERE session_scope = ?
      AND canonical_path NOT IN (SELECT value FROM json_each(?))`)
            .run(scope, JSON.stringify([...validCanonicalPaths]));
    }
    deleteSession(scope) {
        this.#db.prepare("DELETE FROM skill_whisper_sessions WHERE session_scope = ?").run(scope);
    }
    pruneExpired(cutoffMs) {
        this.#db.prepare("DELETE FROM skill_whisper_sessions WHERE last_used_at_ms < ?").run(cutoffMs);
    }
    close() {
        this.#db.close();
    }
}
