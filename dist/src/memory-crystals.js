import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canonicalCorpora, derivedObservationTokens } from "./deep-thought-store.js";
import { redactSecrets } from "./expectations-store.js";
import { immediateTransaction, openMemoryDatabase, tableExists } from "./memory-database.js";
// Loaded by plain-Node workers (Steward crystallizer) and the Memory Whisperer hot path: keep this module free of `openclaw`.
/**
 * Memory Crystals: durable, citation-anchored syntheses of many memory chunks.
 *
 * - `memory_crystals`: one row per crystal. `stm` crystals may go stale (`stale_after_ms`); `ltm` crystals never do.
 *   `audience_key` is fixed by the first write: a later revision can never widen who may see a crystal.
 * - `memory_crystal_members`: the exact evidence chunks (doc hash + chunk span + quote sha256) the current revision
 *   was synthesized from. Replaced wholesale on every revision.
 * - `core_memories`: retroactive anchors. "A memory is core if and only if it changed a durable structure": when a
 *   crystal's title/summary changes, the evidence that was new to that revision is recorded here. Dedup per
 *   `(agent_id, source_kind, target_id, corpus, source_path, doc_hash)` so retries never duplicate.
 *
 * Read helpers never create or migrate a database; they return empty results for a missing file or table.
 */
export const MEMORY_CRYSTALS_COMPONENT = "memory_crystals";
export const MEMORY_CRYSTALS_SCHEMA_VERSION = 1;
/** Shared contract with Track P1-C (Steward crystallizer). Do not change without bumping the schema version. */
export const MEMORY_CRYSTALS_SCHEMA = `CREATE TABLE IF NOT EXISTS memory_crystals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('stm', 'ltm')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  audience_key TEXT NOT NULL,
  corpora_json TEXT NOT NULL CHECK(json_valid(corpora_json)),
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  cluster_id TEXT,
  input_digest TEXT NOT NULL,
  recipe_hash TEXT NOT NULL DEFAULT 'default',
  brightness REAL NOT NULL DEFAULT 0.5,
  hit_count INTEGER NOT NULL DEFAULT 0 CHECK(hit_count >= 0),
  created_ms INTEGER NOT NULL,
  verified_ms INTEGER NOT NULL,
  stale_after_ms INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS memory_crystal_members (
  crystal_id TEXT NOT NULL REFERENCES memory_crystals(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  corpus TEXT NOT NULL,
  source_path TEXT NOT NULL,
  doc_hash TEXT NOT NULL,
  chunk_pos INTEGER NOT NULL CHECK(chunk_pos >= 0),
  chunk_len INTEGER NOT NULL CHECK(chunk_len > 0),
  quote_sha256 TEXT NOT NULL,
  observed_ms INTEGER,
  PRIMARY KEY (crystal_id, ordinal)
) STRICT;

CREATE TABLE IF NOT EXISTS core_memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('crystal_revision', 'dossier_revision', 'voltaire_shift', 'expectation_surprise')),
  target_id TEXT NOT NULL,
  corpus TEXT NOT NULL,
  source_path TEXT NOT NULL,
  doc_hash TEXT,
  quote_excerpt TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_crystals_agent_status_tier ON memory_crystals(agent_id, status, tier, brightness);
CREATE INDEX IF NOT EXISTS idx_memory_crystals_agent_audience ON memory_crystals(agent_id, status, audience_key);
CREATE INDEX IF NOT EXISTS idx_memory_crystals_agent_digest ON memory_crystals(agent_id, input_digest);
CREATE INDEX IF NOT EXISTS idx_core_memories_agent_time ON core_memories(agent_id, created_ms);
CREATE INDEX IF NOT EXISTS idx_core_memories_agent_source ON core_memories(agent_id, corpus, source_path);`;
const TABLES = ["memory_crystals", "memory_crystal_members", "core_memories"];
export const CRYSTAL_TIERS = ["stm", "ltm"];
export const CRYSTAL_STATUSES = ["active", "retired"];
export const CORE_MEMORY_SOURCE_KINDS = ["crystal_revision", "dossier_revision", "voltaire_shift", "expectation_surprise"];
/** Default `brightness` for a new crystal (schema default). */
export const DEFAULT_CRYSTAL_BRIGHTNESS = 0.5;
/** Default minimum overlap coefficient between the turn and a crystal's `title + summary` tokens. */
export const DEFAULT_CRYSTAL_MATCH_MIN_TOKEN_OVERLAP = 0.35;
/** Default minimum shared meaningful tokens: one shared word is never enough to fire. */
export const DEFAULT_CRYSTAL_MATCH_MIN_SHARED_TOKENS = 2;
/** Default additive rank boost for `ltm` crystals: enough to break ties, too small to beat a clearly better `stm` match. */
export const DEFAULT_CRYSTAL_LTM_RANK_BOOST = 0.01;
/* ───────────────────────────── Validation & mapping ───────────────────────────── */
function requireText(value, field) {
    if (typeof value !== "string" || !value.trim())
        throw new TypeError(`MemoryCrystals ${field} must be a non-empty string`);
    if (value.includes("\0"))
        throw new TypeError(`MemoryCrystals ${field} must not contain NUL characters`);
    return value.trim();
}
function requireEnum(value, allowed, field) {
    if (typeof value !== "string" || !allowed.includes(value))
        throw new TypeError(`MemoryCrystals ${field} must be one of ${allowed.join(", ")}`);
    return value;
}
function requireRedacted(value, field) {
    const text = redactSecrets(requireText(value, field)).trim();
    if (!text)
        throw new TypeError(`MemoryCrystals ${field} must not be blank after redaction`);
    return text;
}
function optionalTime(value, field) {
    if (value === undefined || value === null)
        return null;
    if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`MemoryCrystals ${field} must be a non-negative integer`);
    return value;
}
function requireBrightness(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
        throw new RangeError("MemoryCrystals brightness must be within 0..1");
    return value;
}
function requireLimit(limit, field = "limit") {
    const value = limit ?? 0;
    if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(`MemoryCrystals ${field} must be a non-negative integer (0 = unlimited)`);
    return value;
}
function boundedUnit(value, fallback, field) {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1)
        throw new RangeError(`MemoryCrystals ${field} must be between 0 and 1`);
    return resolved;
}
const SHA256_HEX = /^[0-9a-f]{64}$/u;
function normalizeMembers(members) {
    if (!Array.isArray(members) || !members.length)
        throw new TypeError("MemoryCrystals members must contain at least one member");
    return members.map((raw, index) => {
        if (!raw || typeof raw !== "object")
            throw new TypeError(`MemoryCrystals members[${index}] must be an object`);
        const quoteSha256 = typeof raw.quoteSha256 === "string" ? raw.quoteSha256.trim().toLowerCase() : "";
        if (!SHA256_HEX.test(quoteSha256))
            throw new TypeError(`MemoryCrystals members[${index}].quoteSha256 must be a 64-char hex sha256`);
        const chunkPos = raw.chunkPos, chunkLen = raw.chunkLen;
        if (!Number.isSafeInteger(chunkPos) || chunkPos < 0)
            throw new RangeError(`MemoryCrystals members[${index}].chunkPos must be a non-negative integer`);
        if (!Number.isSafeInteger(chunkLen) || chunkLen <= 0)
            throw new RangeError(`MemoryCrystals members[${index}].chunkLen must be a positive integer`);
        return {
            corpus: requireText(raw.corpus, `members[${index}].corpus`),
            sourcePath: requireText(raw.sourcePath, `members[${index}].sourcePath`),
            docHash: requireText(raw.docHash, `members[${index}].docHash`),
            chunkPos, chunkLen, quoteSha256,
            observedMs: optionalTime(raw.observedMs, `members[${index}].observedMs`),
            ...(typeof raw.quoteExcerpt === "string" && raw.quoteExcerpt.trim() ? { quoteExcerpt: raw.quoteExcerpt } : {}),
        };
    });
}
function parseCorpora(text) {
    if (typeof text !== "string")
        return undefined;
    try {
        const value = JSON.parse(text);
        return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
    }
    catch {
        return undefined;
    }
}
const nullableText = (value) => value === null || value === undefined ? null : String(value);
const nullableNumber = (value) => value === null || value === undefined ? null : Number(value);
function crystal(row) {
    return {
        id: String(row.id), agentId: String(row.agent_id), tier: row.tier, revision: Number(row.revision),
        title: String(row.title), summary: String(row.summary), audienceKey: String(row.audience_key),
        corpora: parseCorpora(row.corpora_json) ?? [], status: row.status, clusterId: nullableText(row.cluster_id),
        inputDigest: String(row.input_digest), recipeHash: String(row.recipe_hash), brightness: Number(row.brightness),
        hitCount: Number(row.hit_count), createdMs: Number(row.created_ms), verifiedMs: Number(row.verified_ms),
        staleAfterMs: nullableNumber(row.stale_after_ms),
    };
}
function member(row) {
    return {
        ordinal: Number(row.ordinal), corpus: String(row.corpus), sourcePath: String(row.source_path), docHash: String(row.doc_hash),
        chunkPos: Number(row.chunk_pos), chunkLen: Number(row.chunk_len), quoteSha256: String(row.quote_sha256),
        observedMs: nullableNumber(row.observed_ms),
    };
}
function coreMemory(row) {
    return {
        id: String(row.id), agentId: String(row.agent_id), sourceKind: row.source_kind,
        targetId: String(row.target_id), corpus: String(row.corpus), sourcePath: String(row.source_path), docHash: nullableText(row.doc_hash),
        quoteExcerpt: String(row.quote_excerpt), reason: String(row.reason), createdMs: Number(row.created_ms),
    };
}
const clampUnit = (value) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
/* ───────────────────────────── Schema & connections ───────────────────────────── */
/** Runs `fn` atomically, joining a caller's open transaction instead of nesting. */
function atomically(db, fn) {
    return db.isTransaction ? fn() : immediateTransaction(db, fn);
}
function hasTables(db, tables = TABLES) {
    try {
        return tables.every(table => tableExists(db, table));
    }
    catch {
        return false;
    }
}
/** Create the three tables + indexes and register `memory_schema('memory_crystals', 1)`. Idempotent; refuses unknown versions. */
export function ensureMemoryCrystalsSchema(db) {
    db.exec("CREATE TABLE IF NOT EXISTS memory_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT");
    const ready = () => {
        const version = db.prepare("SELECT version FROM memory_schema WHERE component=?").get(MEMORY_CRYSTALS_COMPONENT)?.version;
        if (version !== undefined && version !== MEMORY_CRYSTALS_SCHEMA_VERSION)
            throw new Error("Unsupported memory_crystals schema version");
        return version === MEMORY_CRYSTALS_SCHEMA_VERSION && hasTables(db);
    };
    // Fast path avoids taking the write lock on every open.
    if (ready())
        return;
    atomically(db, () => {
        if (ready())
            return;
        db.exec(MEMORY_CRYSTALS_SCHEMA);
        db.prepare("INSERT OR IGNORE INTO memory_schema VALUES (?,?)").run(MEMORY_CRYSTALS_COMPONENT, MEMORY_CRYSTALS_SCHEMA_VERSION);
    });
}
/**
 * Open `path` read-only (never creating or migrating it), run `fn`, and close. A missing/non-regular file or an open
 * failure yields `fallback`; a DB without the tables flows through the read helpers' empty results.
 */
export function withReadOnlyMemoryCrystals(path, fallback, fn) {
    if (!path || !statSync(path, { throwIfNoEntry: false })?.isFile())
        return fallback;
    let db;
    try {
        db = new DatabaseSync(path, { readOnly: true });
    }
    catch {
        return fallback;
    }
    try {
        db.exec("PRAGMA query_only=ON");
        return fn(db);
    }
    finally {
        db.close();
    }
}
function readWith(source, fallback, fn) {
    if (typeof source === "string")
        return withReadOnlyMemoryCrystals(source, fallback, fn);
    return fn(source instanceof MemoryCrystalsStore ? source.db : source);
}
/* ───────────────────────────── Core memories ───────────────────────────── */
function coreMemoryId(agentId, sourceKind, targetId, corpus, sourcePath, docHash) {
    const key = JSON.stringify([agentId, sourceKind, targetId, corpus, sourcePath, docHash]);
    return `core_${createHash("sha256").update(key).digest("hex")}`;
}
/**
 * Record a retroactive core-memory anchor. Idempotent per `(agent_id, source_kind, target_id, corpus, source_path,
 * doc_hash)`: a retry returns the existing row with `recorded: false`. Creates the schema on first use.
 */
export function recordCoreMemory(db, input) {
    ensureMemoryCrystalsSchema(db);
    const agentId = requireText(input.agentId, "agentId");
    const sourceKind = requireEnum(input.sourceKind, CORE_MEMORY_SOURCE_KINDS, "sourceKind");
    const targetId = requireText(input.targetId, "targetId");
    const corpus = requireText(input.corpus, "corpus");
    const sourcePath = requireText(input.sourcePath, "sourcePath");
    const docHash = input.docHash === undefined || input.docHash === null ? null : requireText(input.docHash, "docHash");
    const quoteExcerpt = requireRedacted(input.quoteExcerpt, "quoteExcerpt");
    const reason = requireRedacted(input.reason, "reason");
    const now = optionalTime(input.nowMs, "nowMs") ?? Date.now();
    return atomically(db, () => {
        const existing = db.prepare(`SELECT * FROM core_memories WHERE agent_id=? AND source_kind=? AND target_id=? AND corpus=?
        AND source_path=? AND doc_hash IS ? ORDER BY created_ms, id LIMIT 1`)
            .get(agentId, sourceKind, targetId, corpus, sourcePath, docHash);
        if (existing)
            return { recorded: false, coreMemory: coreMemory(existing) };
        const id = coreMemoryId(agentId, sourceKind, targetId, corpus, sourcePath, docHash);
        const inserted = Number(db.prepare(`INSERT OR IGNORE INTO core_memories
        (id, agent_id, source_kind, target_id, corpus, source_path, doc_hash, quote_excerpt, reason, created_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(id, agentId, sourceKind, targetId, corpus, sourcePath, docHash, quoteExcerpt, reason, now).changes) > 0;
        return { recorded: inserted, coreMemory: coreMemory(db.prepare("SELECT * FROM core_memories WHERE id=?").get(id)) };
    });
}
/** Newest first. Missing table → `[]`. Safe on read-only connections. */
export function listCoreMemories(db, filter) {
    const limit = requireLimit(filter.limit);
    if (!hasTables(db, ["core_memories"]))
        return [];
    const where = ["agent_id=?"], params = [filter.agentId];
    if (filter.sourceKind !== undefined) {
        where.push("source_kind=?");
        params.push(requireEnum(filter.sourceKind, CORE_MEMORY_SOURCE_KINDS, "sourceKind"));
    }
    if (filter.targetId !== undefined) {
        where.push("target_id=?");
        params.push(filter.targetId);
    }
    return db.prepare(`SELECT * FROM core_memories WHERE ${where.join(" AND ")} ORDER BY created_ms DESC, id LIMIT ?`)
        .all(...params, limit || -1).map(coreMemory);
}
/* ───────────────────────────── Crystals ───────────────────────────── */
function readMembers(db, crystalId) {
    return db.prepare("SELECT * FROM memory_crystal_members WHERE crystal_id=? ORDER BY ordinal").all(crystalId).map(member);
}
function writeMembers(db, crystalId, members) {
    db.prepare("DELETE FROM memory_crystal_members WHERE crystal_id=?").run(crystalId);
    const insert = db.prepare(`INSERT INTO memory_crystal_members
    (crystal_id, ordinal, corpus, source_path, doc_hash, chunk_pos, chunk_len, quote_sha256, observed_ms) VALUES (?,?,?,?,?,?,?,?,?)`);
    members.forEach((item, ordinal) => insert.run(crystalId, ordinal, item.corpus, item.sourcePath, item.docHash, item.chunkPos, item.chunkLen, item.quoteSha256, item.observedMs));
}
/** Crystal with members, or `undefined` when missing, owned by another agent, or the table is absent. */
export function getCrystal(db, id, agentId) {
    if (!hasTables(db, ["memory_crystals", "memory_crystal_members"]))
        return undefined;
    const row = db.prepare("SELECT * FROM memory_crystals WHERE id=? AND agent_id=?").get(id, agentId);
    return row ? { ...crystal(row), members: readMembers(db, String(row.id)) } : undefined;
}
/** Brightest first, then most recently verified. Missing table → `[]`. Safe on read-only connections. */
export function listCrystals(db, filter) {
    const limit = requireLimit(filter.limit);
    if (!hasTables(db, ["memory_crystals"]))
        return [];
    const where = ["agent_id=?"], params = [filter.agentId];
    if (filter.status !== undefined) {
        where.push("status=?");
        params.push(requireEnum(filter.status, CRYSTAL_STATUSES, "status"));
    }
    if (filter.tier !== undefined) {
        where.push("tier=?");
        params.push(requireEnum(filter.tier, CRYSTAL_TIERS, "tier"));
    }
    if (filter.audienceKey !== undefined) {
        where.push("audience_key=?");
        params.push(filter.audienceKey);
    }
    return db.prepare(`SELECT * FROM memory_crystals WHERE ${where.join(" AND ")}
    ORDER BY brightness DESC, verified_ms DESC, id LIMIT ?`).all(...params, limit || -1).map(crystal);
}
/**
 * Create, re-verify, refresh or revise a crystal (see `UpsertCrystalResult.action`). Atomic; joins a caller's open
 * transaction. The audience of an existing crystal is never changed. Creates the schema on first use.
 */
export function upsertCrystal(db, input) {
    ensureMemoryCrystalsSchema(db);
    const id = requireText(input.id, "id");
    const agentId = requireText(input.agentId, "agentId");
    const title = requireRedacted(input.title, "title");
    const summary = requireRedacted(input.summary, "summary");
    const audienceKey = requireText(input.audienceKey, "audienceKey");
    const inputDigest = requireText(input.inputDigest, "inputDigest");
    const members = normalizeMembers(input.members);
    if (!Array.isArray(input.corpora))
        throw new TypeError("MemoryCrystals corpora must be an array");
    const requested = canonicalCorpora(input.corpora);
    if (!requested.length)
        throw new TypeError("MemoryCrystals corpora must contain at least one corpus");
    const corpora = canonicalCorpora([...requested, ...members.map(item => item.corpus)]);
    const tier = requireEnum(input.tier ?? "stm", CRYSTAL_TIERS, "tier");
    const recipeHash = input.recipeHash === undefined ? "default" : requireText(input.recipeHash, "recipeHash");
    const clusterId = input.clusterId === undefined || input.clusterId === null ? null : requireText(input.clusterId, "clusterId");
    const brightness = input.brightness === undefined ? undefined : requireBrightness(input.brightness);
    const staleAfterMs = optionalTime(input.staleAfterMs, "staleAfterMs");
    const now = optionalTime(input.nowMs, "nowMs") ?? Date.now();
    const revisionReason = input.revisionReason === undefined ? undefined : requireRedacted(input.revisionReason, "revisionReason");
    return atomically(db, () => {
        const existingRow = db.prepare("SELECT * FROM memory_crystals WHERE id=?").get(id);
        if (!existingRow) {
            db.prepare(`INSERT INTO memory_crystals (id, agent_id, tier, revision, title, summary, audience_key, corpora_json, status,
          cluster_id, input_digest, recipe_hash, brightness, hit_count, created_ms, verified_ms, stale_after_ms)
          VALUES (?,?,?,1,?,?,?,?,'active',?,?,?,?,0,?,?,?)`)
                .run(id, agentId, tier, title, summary, audienceKey, JSON.stringify(corpora), clusterId, inputDigest, recipeHash, brightness ?? DEFAULT_CRYSTAL_BRIGHTNESS, now, now, tier === "ltm" ? null : staleAfterMs);
            writeMembers(db, id, members);
            return { action: "created", crystal: getCrystal(db, id, agentId), coreMemoriesAdded: [], audienceLocked: false };
        }
        const existing = crystal(existingRow);
        if (existing.agentId !== agentId)
            throw new Error(`MemoryCrystals crystal ${id} belongs to another agent`);
        const audienceLocked = existing.audienceKey !== audienceKey;
        if (existing.status !== "active") {
            return { action: "ignored_retired", crystal: getCrystal(db, id, agentId), coreMemoriesAdded: [], audienceLocked };
        }
        // `stale_after_ms`: LTM never goes stale; omitted keeps the current value; explicit `null` clears it.
        const nextStale = existing.tier === "ltm" ? null : input.staleAfterMs === undefined ? existing.staleAfterMs : staleAfterMs;
        const nextBrightness = brightness ?? existing.brightness;
        if (existing.inputDigest === inputDigest) {
            db.prepare("UPDATE memory_crystals SET verified_ms=MAX(verified_ms, ?), brightness=?, stale_after_ms=? WHERE id=?")
                .run(now, nextBrightness, nextStale, id);
            return { action: "verified", crystal: getCrystal(db, id, agentId), coreMemoriesAdded: [], audienceLocked };
        }
        const contentChanged = existing.title !== title || existing.summary !== summary;
        const previousDocHashes = new Set(readMembers(db, id).map(item => item.docHash));
        db.prepare(`UPDATE memory_crystals SET revision=revision + ?, title=?, summary=?, corpora_json=?, cluster_id=?, input_digest=?,
        recipe_hash=?, brightness=?, verified_ms=MAX(verified_ms, ?), stale_after_ms=? WHERE id=?`)
            .run(contentChanged ? 1 : 0, title, summary, JSON.stringify(corpora), clusterId ?? existing.clusterId, inputDigest, recipeHash, nextBrightness, now, nextStale, id);
        writeMembers(db, id, members);
        if (!contentChanged)
            return { action: "refreshed", crystal: getCrystal(db, id, agentId), coreMemoriesAdded: [], audienceLocked };
        const revision = existing.revision + 1;
        const reason = revisionReason ?? `Crystal "${title}" revised to r${revision}: its title/summary changed on new evidence`;
        const anchors = input.triggeringMembers?.length
            ? [...input.triggeringMembers]
            : members.filter(item => !previousDocHashes.has(item.docHash))
                .map(item => ({ corpus: item.corpus, sourcePath: item.sourcePath, docHash: item.docHash,
                quoteExcerpt: item.quoteExcerpt ?? `[quote sha256:${item.quoteSha256} @${item.chunkPos}+${item.chunkLen}]` }));
        const coreMemoriesAdded = [];
        for (const anchor of anchors) {
            const recorded = recordCoreMemory(db, {
                agentId, sourceKind: "crystal_revision", targetId: id, corpus: anchor.corpus, sourcePath: anchor.sourcePath,
                docHash: anchor.docHash ?? null, quoteExcerpt: anchor.quoteExcerpt?.trim() ? anchor.quoteExcerpt : `[evidence ${anchor.sourcePath}]`,
                reason: anchor.reason?.trim() ? anchor.reason : reason, nowMs: now,
            });
            if (recorded.recorded)
                coreMemoriesAdded.push(recorded.coreMemory);
        }
        return { action: "revised", crystal: getCrystal(db, id, agentId), coreMemoriesAdded, audienceLocked };
    });
}
/** Promote an active `stm` crystal to `ltm` (clears `stale_after_ms`). False when missing, retired, or already `ltm`. */
export function promoteCrystalToLtm(db, id, agentId, nowMs = Date.now()) {
    if (!hasTables(db, ["memory_crystals"]))
        return false;
    return Number(db.prepare(`UPDATE memory_crystals SET tier='ltm', stale_after_ms=NULL, verified_ms=MAX(verified_ms, ?)
    WHERE id=? AND agent_id=? AND status='active' AND tier='stm'`).run(nowMs, id, agentId).changes) > 0;
}
/**
 * Retire an active crystal (it stops matching; members and core memories are kept for provenance). False when missing
 * or already retired. `nowMs` is accepted for API symmetry; the schema has no retirement timestamp column.
 */
export function retireCrystal(db, id, agentId, _nowMs = Date.now()) {
    if (!hasTables(db, ["memory_crystals"]))
        return false;
    return Number(db.prepare("UPDATE memory_crystals SET status='retired' WHERE id=? AND agent_id=? AND status='active'")
        .run(id, agentId).changes) > 0;
}
/** Set a crystal's brightness (`[0, 1]`). False when missing. `nowMs` is accepted for API symmetry. */
export function updateCrystalBrightness(db, id, agentId, brightness, _nowMs = Date.now()) {
    const value = requireBrightness(brightness);
    if (!hasTables(db, ["memory_crystals"]))
        return false;
    return Number(db.prepare("UPDATE memory_crystals SET brightness=? WHERE id=? AND agent_id=?").run(value, id, agentId).changes) > 0;
}
/**
 * Count surfaced hits (call from a writable connection after a whisper actually used the crystal). Best-effort and
 * zero-stall: the write runs with `busy_timeout = 0`, so a busy ledger throws `SQLITE_BUSY` immediately instead of
 * blocking the Gateway event loop. A borrowed connection's own busy timeout is restored afterwards.
 */
export function recordCrystalHits(db, ids, agentId) {
    if (!ids.length || !hasTables(db, ["memory_crystals"]))
        return 0;
    const previous = Number(db.prepare("PRAGMA busy_timeout").get()?.timeout ?? 0);
    db.exec("PRAGMA busy_timeout = 0");
    try {
        return atomically(db, () => {
            const bump = db.prepare("UPDATE memory_crystals SET hit_count=hit_count+1 WHERE id=? AND agent_id=?");
            return [...new Set(ids)].reduce((sum, id) => sum + Number(bump.run(id, agentId).changes), 0);
        });
    }
    finally {
        if (previous > 0)
            db.exec(`PRAGMA busy_timeout = ${Math.floor(previous)}`);
    }
}
/**
 * Hot-path hit counter for the Memory Whisperer: opens an EXISTING database file (never creating or migrating it),
 * bumps `hit_count` for `ids`, and closes. Returns 0 for a missing file/table; a busy or locked ledger throws, so the
 * caller decides whether a lost count matters (the whisperer treats it as best-effort).
 */
export function recordCrystalHitsAtPath(path, ids, agentId) {
    if (!ids.length || !path || !statSync(path, { throwIfNoEntry: false })?.isFile())
        return 0;
    const db = new DatabaseSync(path);
    try {
        return recordCrystalHits(db, ids, agentId);
    }
    finally {
        db.close();
    }
}
function emptySummary() {
    const zeros = (keys) => Object.fromEntries(keys.map(key => [key, 0]));
    return {
        total: 0, byTier: zeros(CRYSTAL_TIERS), byStatus: zeros(CRYSTAL_STATUSES), activeByTier: zeros(CRYSTAL_TIERS),
        coreMemoriesCount: 0, coreMemoriesBySourceKind: zeros(CORE_MEMORY_SOURCE_KINDS),
    };
}
/** Read-only counts by tier and status plus core-memory counts. A path is opened read-only; missing DB/table → zeros. */
export function summarizeCrystals(source, agentId) {
    return readWith(source, emptySummary(), db => {
        const summary = emptySummary();
        if (hasTables(db, ["memory_crystals"])) {
            for (const row of db.prepare("SELECT tier, status, COUNT(*) AS n FROM memory_crystals WHERE agent_id=? GROUP BY tier, status").all(agentId)) {
                const n = Number(row.n), tier = row.tier, status = row.status;
                summary.total += n;
                if (tier in summary.byTier)
                    summary.byTier[tier] += n;
                if (status in summary.byStatus)
                    summary.byStatus[status] += n;
                if (status === "active" && tier in summary.activeByTier)
                    summary.activeByTier[tier] += n;
            }
        }
        if (hasTables(db, ["core_memories"])) {
            for (const row of db.prepare("SELECT source_kind, COUNT(*) AS n FROM core_memories WHERE agent_id=? GROUP BY source_kind").all(agentId)) {
                const n = Number(row.n), kind = row.source_kind;
                summary.coreMemoriesCount += n;
                if (kind in summary.coreMemoriesBySourceKind)
                    summary.coreMemoriesBySourceKind[kind] += n;
            }
        }
        return summary;
    });
}
/** Validates tuning params (throws on caller bugs); `undefined` when the ACL/query can never match anything. */
function resolveMatchQuery(query) {
    const minOverlap = boundedUnit(query.minTokenOverlap, DEFAULT_CRYSTAL_MATCH_MIN_TOKEN_OVERLAP, "minTokenOverlap");
    const minShared = Math.max(1, requireLimit(query.minSharedTokens ?? DEFAULT_CRYSTAL_MATCH_MIN_SHARED_TOKENS, "minSharedTokens"));
    const maxResults = requireLimit(query.maxResults, "maxResults");
    const ltmBoost = query.ltmRankBoost ?? DEFAULT_CRYSTAL_LTM_RANK_BOOST;
    if (!Number.isFinite(ltmBoost) || ltmBoost < 0)
        throw new RangeError("MemoryCrystals ltmRankBoost must be a non-negative number");
    const now = query.nowMs ?? Date.now();
    if (typeof query.agentId !== "string" || !query.agentId.trim())
        return undefined;
    const audiences = [...new Set((query.audienceKeys ?? []).filter(key => typeof key === "string" && key.trim()))];
    const allowed = new Set(canonicalCorpora(query.allowedCorpora ?? []));
    if (!audiences.length || !allowed.size || typeof query.queryText !== "string")
        return undefined;
    const queryTokens = derivedObservationTokens(query.queryText);
    if (!queryTokens.size)
        return undefined;
    return { agentId: query.agentId, queryTokens, audiences, allowed, minOverlap, minShared, maxResults, ltmBoost, now,
        includeMembers: query.includeMembers === true };
}
function matchIn(db, resolved) {
    const { queryTokens, audiences, allowed, minOverlap, minShared, maxResults, ltmBoost, now } = resolved;
    if (!hasTables(db, ["memory_crystals"]))
        return [];
    const rows = db.prepare(`SELECT * FROM memory_crystals WHERE agent_id=? AND status='active'
      AND audience_key IN (${audiences.map(() => "?").join(",")}) AND (stale_after_ms IS NULL OR stale_after_ms > ?)`)
        .all(resolved.agentId, ...audiences, now);
    const matches = [];
    for (const row of rows) {
        const found = crystal(row);
        // Defense in depth on top of the SQL filter: exact agent, allowed audience, live, every corpus allowed.
        if (found.agentId !== resolved.agentId || found.status !== "active" || !audiences.includes(found.audienceKey))
            continue;
        if (found.staleAfterMs !== null && found.staleAfterMs <= now)
            continue;
        // `crystal()` already decoded `corpora_json` (malformed JSON decodes to `[]`, which never matches).
        if (!found.corpora.length || !found.corpora.every(corpus => allowed.has(corpus)))
            continue;
        const stored = derivedObservationTokens(`${found.title} ${found.summary}`);
        if (!stored.size)
            continue;
        let shared = 0;
        for (const token of queryTokens)
            if (stored.has(token))
                shared += 1;
        if (shared < minShared)
            continue;
        const matchScore = shared / Math.min(queryTokens.size, stored.size);
        if (matchScore < minOverlap)
            continue;
        const score = matchScore * (0.7 + 0.3 * clampUnit(found.brightness)) + (found.tier === "ltm" ? ltmBoost : 0);
        matches.push({ crystal: found, score, matchScore, sharedTokens: shared });
    }
    matches.sort((a, b) => b.score - a.score
        || Number(b.crystal.tier === "ltm") - Number(a.crystal.tier === "ltm")
        || b.crystal.brightness - a.crystal.brightness
        || b.crystal.verifiedMs - a.crystal.verifiedMs
        || (a.crystal.id < b.crystal.id ? -1 : a.crystal.id > b.crystal.id ? 1 : 0));
    const limitedMatches = maxResults > 0 ? matches.slice(0, maxResults) : matches;
    if (resolved.includeMembers && hasTables(db, ["memory_crystal_members"])) {
        for (const match of limitedMatches)
            match.crystal.members = readMembers(db, match.crystal.id);
    }
    return limitedMatches;
}
/**
 * Deterministic, zero-LLM crystal lookup for the Memory Whisperer. Never writes; a path is opened read-only and a
 * missing database/table returns `[]` without creating anything.
 *
 * Strict ACL: only `active` crystals of exactly `agentId`, whose `audience_key` is in `audienceKeys`, whose every corpus
 * is in `allowedCorpora`, and that are not past `stale_after_ms`. Matching: meaningful tokens (stop words dropped,
 * simple plurals folded) of the query vs `title + summary`; keeps rows with `>= minSharedTokens` shared tokens and an
 * overlap coefficient `|shared| / min(|query|, |crystal|) >= minTokenOverlap`. Ranked by
 * `matchScore * (0.7 + 0.3 * clamp(brightness, 0, 1))` plus a small `ltm` boost, then `ltm` before `stm`.
 */
export function findMatchingCrystalsReadOnly(source, query) {
    const resolved = resolveMatchQuery(query);
    if (!resolved)
        return [];
    // A path is a hot-path probe: an unreadable/locked/corrupt file fails closed to `[]` instead of breaking the turn.
    if (typeof source === "string") {
        try {
            return readWith(source, [], db => matchIn(db, resolved));
        }
        catch {
            return [];
        }
    }
    return readWith(source, [], db => matchIn(db, resolved));
}
/* ───────────────────────────── Store ───────────────────────────── */
export class MemoryCrystalsStore {
    db;
    #owned;
    /** Pass a path to own a connection, or an open `DatabaseSync` to share one (e.g. inside a fenced Steward commit). */
    constructor(database, options = {}) {
        this.#owned = typeof database === "string";
        this.db = typeof database === "string"
            ? openMemoryDatabase(database, options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs })
            : database;
        try {
            ensureMemoryCrystalsSchema(this.db);
        }
        catch (error) {
            if (this.#owned)
                this.db.close();
            throw error;
        }
    }
    close() { if (this.#owned && this.db.isOpen)
        this.db.close(); }
    upsertCrystal(input) { return upsertCrystal(this.db, input); }
    promoteCrystalToLtm(id, agentId, nowMs) { return promoteCrystalToLtm(this.db, id, agentId, nowMs); }
    retireCrystal(id, agentId, nowMs) { return retireCrystal(this.db, id, agentId, nowMs); }
    updateCrystalBrightness(id, agentId, brightness, nowMs) {
        return updateCrystalBrightness(this.db, id, agentId, brightness, nowMs);
    }
    recordCrystalHits(ids, agentId) { return recordCrystalHits(this.db, ids, agentId); }
    listCrystals(filter) { return listCrystals(this.db, filter); }
    getCrystal(id, agentId) { return getCrystal(this.db, id, agentId); }
    recordCoreMemory(input) { return recordCoreMemory(this.db, input); }
    listCoreMemories(filter) { return listCoreMemories(this.db, filter); }
    summarize(agentId) { return summarizeCrystals(this.db, agentId); }
    findMatchingCrystals(query) { return findMatchingCrystalsReadOnly(this.db, query); }
    // Read-only helpers for consumers that must not create or migrate anything (missing DB/table tolerant).
    static findMatchingCrystalsReadOnly(source, query) { return findMatchingCrystalsReadOnly(source, query); }
    static summarizeCrystals(source, agentId) { return summarizeCrystals(source, agentId); }
    static list(db, filter) { return listCrystals(db, filter); }
    static get(db, id, agentId) { return getCrystal(db, id, agentId); }
    static listCoreMemories(db, filter) { return listCoreMemories(db, filter); }
    static readOnly(path, fallback, fn) { return withReadOnlyMemoryCrystals(path, fallback, fn); }
}
