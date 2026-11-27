import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { immediateTransaction } from "./memory-database.js";
// Session sync bookkeeping lives in `unblock-memory.sqlite`, next to the WorkStore row that fences it.
// Keep this module free of `openclaw`: offline tools and tests open it directly.
const SCHEMA = `CREATE TABLE IF NOT EXISTS session_sync_state (
  agent_id TEXT PRIMARY KEY,
  manifest_json TEXT CHECK(manifest_json IS NULL OR json_valid(manifest_json)),
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) STRICT;`;
const SCHEMA_VERSION = 1;
const MANIFEST_VERSION = 1;
const SESSION_SYNC_INTERRUPTED = "session sync interrupted by Gateway restart";
/** Retired sidecars from the Markdown-transport era (<= 0.17): read once on upgrade, never written again. */
const LEGACY_MANIFEST_FILE = "sessions-manifest.json";
const LEGACY_STATUS_FILE = "session-sync-status.json";
const LEGACY_ARTIFACTS = [
    LEGACY_MANIFEST_FILE, LEGACY_STATUS_FILE, "session-sync.lock", "session-sync.lock.sqlite",
    "session-sync.lock.sqlite-wal", "session-sync.lock.sqlite-shm", "session-sync.lock.sqlite-journal",
];
const LEGACY_PROJECTION_DIR = "sessions";
function record(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function emptySessionManifest() {
    return { version: MANIFEST_VERSION, sessions: {} };
}
function parseSessionManifest(value, label) {
    if (!record(value) || value.version !== MANIFEST_VERSION || !record(value.sessions)) {
        throw new Error(`unsupported unblock-memory session manifest: ${label}`);
    }
    const parsed = { ...value };
    if (value.failedSessions !== undefined) {
        const valid = record(value.failedSessions)
            ? Object.fromEntries(Object.entries(value.failedSessions).filter(([id, fingerprint]) => id.length > 0 && typeof fingerprint === "string"))
            : {};
        if (Object.keys(valid).length)
            parsed.failedSessions = valid;
        else
            delete parsed.failedSessions;
    }
    if (parsed.generation !== undefined && !Number.isSafeInteger(parsed.generation))
        delete parsed.generation;
    return parsed;
}
function readLegacyJson(path) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile())
        return undefined;
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        throw new Error(`invalid unblock-memory session manifest: ${path}`);
    }
}
function legacyReceipt(value) {
    if (!record(value) || typeof value.startedAt !== "string" || !value.startedAt)
        return undefined;
    if (value.status === "running") {
        return { status: "failed", startedAt: value.startedAt, completedAt: new Date().toISOString(), error: SESSION_SYNC_INTERRUPTED };
    }
    if ((value.status !== "completed" && value.status !== "failed") || typeof value.completedAt !== "string")
        return undefined;
    const { pid: _pid, ...receipt } = value;
    return receipt;
}
function ensureSchema(db) {
    const read = () => db.prepare("SELECT version FROM memory_schema WHERE component='session_sync'").get()?.version;
    const ready = (version) => {
        if (version !== undefined && version !== SCHEMA_VERSION)
            throw new Error("Unsupported session sync state schema version");
        return version === SCHEMA_VERSION &&
            Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='session_sync_state'").get());
    };
    if (ready(read()))
        return;
    immediateTransaction(db, () => {
        if (ready(read()))
            return;
        db.exec(SCHEMA);
        db.prepare("INSERT OR IGNORE INTO memory_schema VALUES ('session_sync',?)").run(SCHEMA_VERSION);
    });
}
/**
 * Per-agent session manifest and sync receipt on a caller-owned `unblock-memory.sqlite` connection.
 * Writes are single statements, so callers may wrap them in a WorkStore fence (`withFence`/`commitWithDomain`).
 */
export class SessionSyncState {
    #db;
    #agentId;
    #legacyDir;
    constructor(db, agentId, legacyDir) {
        ensureSchema(db);
        this.#db = db;
        this.#agentId = agentId;
        this.#legacyDir = legacyDir;
    }
    /** Bumps on every manifest write; 0 before the first manifest exists. */
    revision() {
        const row = this.#db.prepare("SELECT revision, manifest_json FROM session_sync_state WHERE agent_id=?").get(this.#agentId);
        return row?.manifest_json === null || row === undefined ? 0 : Number(row.revision);
    }
    readManifest() {
        const stored = this.#db.prepare("SELECT manifest_json FROM session_sync_state WHERE agent_id=?").get(this.#agentId)?.manifest_json;
        if (typeof stored === "string")
            return parseSessionManifest(JSON.parse(stored), "unblock-memory.sqlite");
        const legacyPath = this.#legacyDir ? join(this.#legacyDir, LEGACY_MANIFEST_FILE) : undefined;
        const legacy = legacyPath ? readLegacyJson(legacyPath) : undefined;
        if (legacy === undefined)
            return emptySessionManifest();
        // One-time upgrade import: never overwrite a manifest a sync committed meanwhile.
        const manifest = parseSessionManifest(legacy, legacyPath);
        delete manifest.generation;
        this.#db.prepare(`INSERT INTO session_sync_state (agent_id, manifest_json, revision, updated_at) VALUES (?,?,1,?)
      ON CONFLICT(agent_id) DO UPDATE SET manifest_json=excluded.manifest_json, revision=revision+1, updated_at=excluded.updated_at
      WHERE session_sync_state.manifest_json IS NULL`).run(this.#agentId, JSON.stringify(manifest), Date.now());
        return this.readManifest();
    }
    writeManifest(manifest) {
        this.#db.prepare(`INSERT INTO session_sync_state (agent_id, manifest_json, revision, updated_at) VALUES (?,?,1,?)
      ON CONFLICT(agent_id) DO UPDATE SET manifest_json=excluded.manifest_json, revision=revision+1, updated_at=excluded.updated_at`)
            .run(this.#agentId, JSON.stringify(manifest), Date.now());
    }
    readReceipt() {
        const stored = this.#db.prepare("SELECT receipt_json FROM session_sync_state WHERE agent_id=?").get(this.#agentId)?.receipt_json;
        if (typeof stored === "string")
            return JSON.parse(stored);
        if (!this.#legacyDir)
            return undefined;
        try {
            return legacyReceipt(readLegacyJson(join(this.#legacyDir, LEGACY_STATUS_FILE)));
        }
        catch {
            return undefined;
        }
    }
    writeReceipt(receipt) {
        this.#db.prepare(`INSERT INTO session_sync_state (agent_id, receipt_json, updated_at) VALUES (?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET receipt_json=excluded.receipt_json, updated_at=excluded.updated_at`)
            .run(this.#agentId, JSON.stringify(receipt), Date.now());
    }
    /** Replace a dead attempt's running receipt, unless a newer receipt already superseded it. */
    interruptReceipt(attempt, completedAt) {
        const current = this.readReceipt();
        if (current?.status !== "running" || current.attempt !== attempt)
            return current;
        const failed = { status: "failed", startedAt: current.startedAt, completedAt, error: SESSION_SYNC_INTERRUPTED };
        this.#db.prepare(`UPDATE session_sync_state SET receipt_json=?, updated_at=?
      WHERE agent_id=? AND json_extract(receipt_json,'$.status')='running' AND json_extract(receipt_json,'$.attempt')=?`)
            .run(JSON.stringify(failed), Date.now(), this.#agentId, attempt);
        return this.readReceipt();
    }
}
/** Read-only manifest snapshot for offline tools (never creates tables in a live database). */
export function readSessionManifestSnapshot(databasePath, agentId, legacyDir) {
    if (lstatSync(databasePath, { throwIfNoEntry: false })) {
        const db = new DatabaseSync(databasePath, { readOnly: true });
        try {
            const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='session_sync_state'").get();
            const stored = table ? db.prepare("SELECT manifest_json FROM session_sync_state WHERE agent_id=?").get(agentId)?.manifest_json : undefined;
            if (typeof stored === "string")
                return parseSessionManifest(JSON.parse(stored), databasePath);
        }
        finally {
            db.close();
        }
    }
    const legacyPath = legacyDir ? join(legacyDir, LEGACY_MANIFEST_FILE) : undefined;
    const legacy = legacyPath ? readLegacyJson(legacyPath) : undefined;
    return legacy === undefined ? emptySessionManifest() : parseSessionManifest(legacy, legacyPath);
}
/**
 * Best-effort removal of retired sidecars once SQLite owns the manifest: the legacy JSON files, the
 * SQLite/PID lock files, and the private `sessions/**\/*.md` projections (plaintext transcripts).
 */
export function removeLegacySessionSyncArtifacts(stateDir) {
    const removed = [];
    for (const name of [...LEGACY_ARTIFACTS, LEGACY_PROJECTION_DIR]) {
        const path = join(stateDir, name);
        if (!lstatSync(path, { throwIfNoEntry: false }))
            continue;
        try {
            rmSync(path, { recursive: name === LEGACY_PROJECTION_DIR, force: true });
            removed.push(name);
        }
        catch { /* A later successful sync retries. */ }
    }
    return removed;
}
