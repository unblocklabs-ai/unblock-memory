import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { abortable } from "./abortable.js";
import { isRecord, nonBlank } from "./guards.js";
import { jsonHash } from "./json-hash.js";
import { ensureSchemaUnderWriteLock, immediateTransaction, openMemoryDatabase, tableExists } from "./memory-database.js";
export const FLEET_COMMONS_COLLECTION = "unblock-fleet";
export const FLEET_COMMONS_PREFIX = `qmd://${FLEET_COMMONS_COLLECTION}/`;
const FLEET_COMMONS_CATEGORIES = ["tool_pitfall", "api_workaround", "platform_outage", "procedure"];
const FLEET_COMMONS_SEVERITIES = ["info", "warn", "critical"];
const DEFAULT_TITLE_CHARS = 1024;
const DEFAULT_BODY_CHARS = 65_536;
const DEFAULT_FLEET_COMMONS_CONFIG = Object.freeze({
    enabled: false, syncIntervalMinutes: 15, timeoutMs: 10_000, maxEntries: 0, maxFeedBytes: 5 * 1024 * 1024, allowExpired: false,
});
const configKeys = new Set([...Object.keys(DEFAULT_FLEET_COMMONS_CONFIG),
    "endpoint", "feedPath", "apiKey", "apiKeyFile", "maxTitleChars", "maxBodyChars"]);
export function resolveFleetCommonsConfig(value = undefined) {
    if (value === undefined)
        return { ...DEFAULT_FLEET_COMMONS_CONFIG };
    if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new Error("fleetCommons must be an object");
    }
    if (Object.keys(value).some(key => !configKeys.has(key)))
        throw new Error("Unknown fleetCommons config key");
    const { enabled, syncIntervalMinutes, timeoutMs, maxEntries, maxFeedBytes, maxTitleChars, maxBodyChars, allowExpired } = { ...DEFAULT_FLEET_COMMONS_CONFIG, ...value };
    if (typeof enabled !== "boolean")
        throw new Error("fleetCommons.enabled must be a boolean");
    if (typeof allowExpired !== "boolean")
        throw new Error("fleetCommons.allowExpired must be a boolean");
    if (typeof syncIntervalMinutes !== "number" || !Number.isFinite(syncIntervalMinutes) || syncIntervalMinutes <= 0) {
        throw new Error("fleetCommons.syncIntervalMinutes must be positive and finite");
    }
    // Node timers overflow at 2^31 ms and silently fire after 1 ms instead.
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) {
        throw new Error("fleetCommons.timeoutMs must be a positive integer supported by Node timers");
    }
    if (typeof maxEntries !== "number" || !Number.isSafeInteger(maxEntries) || maxEntries < 0) {
        throw new Error("fleetCommons.maxEntries must be a non-negative integer");
    }
    if (typeof maxFeedBytes !== "number" || !Number.isSafeInteger(maxFeedBytes) || maxFeedBytes < 0) {
        throw new Error("fleetCommons.maxFeedBytes must be a non-negative integer");
    }
    if (maxTitleChars !== undefined && !validLimit(maxTitleChars))
        throw new Error("fleetCommons.maxTitleChars must be a non-negative safe integer");
    if (maxBodyChars !== undefined && !validLimit(maxBodyChars))
        throw new Error("fleetCommons.maxBodyChars must be a non-negative safe integer");
    const endpoint = nonBlank(value.endpoint);
    if (value.endpoint !== undefined) {
        // Mirrors the manifest pattern: `@` may appear in the path, never in the authority (embedded credentials).
        const url = endpoint && /^(?:https:\/\/[^\s\\@/?#]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?)(?:[/?#][^\s\\]*)?$/iu.test(endpoint)
            && URL.parse(endpoint);
        if (!url || url.username || url.password ||
            (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
            throw new Error("fleetCommons.endpoint must be an HTTPS (or loopback HTTP) URL without embedded credentials");
        }
    }
    const feedPath = nonBlank(value.feedPath), apiKeyFile = nonBlank(value.apiKeyFile), apiKey = nonBlank(value.apiKey);
    if (value.feedPath !== undefined && (!feedPath || !isAbsolute(feedPath))) {
        throw new Error("fleetCommons.feedPath must be an absolute path");
    }
    if (value.apiKeyFile !== undefined && (!apiKeyFile || !isAbsolute(apiKeyFile))) {
        throw new Error("fleetCommons.apiKeyFile must be an absolute path");
    }
    if (value.apiKey !== undefined && (!apiKey || /[^\x21-\x7e]/u.test(apiKey))) {
        throw new Error("fleetCommons.apiKey must be a non-empty token");
    }
    if (enabled && !endpoint && !feedPath)
        throw new Error("Enabled fleetCommons requires endpoint or feedPath");
    return { enabled, syncIntervalMinutes, timeoutMs, maxEntries, maxFeedBytes, allowExpired,
        ...(maxTitleChars !== undefined ? { maxTitleChars } : {}), ...(maxBodyChars !== undefined ? { maxBodyChars } : {}),
        ...(endpoint ? { endpoint } : {}), ...(feedPath ? { feedPath } : {}),
        ...(apiKey ? { apiKey } : {}), ...(apiKeyFile ? { apiKeyFile } : {}) };
}
const entryKeys = new Set(["id", "revision", "category", "title", "body", "tags", "severity", "updatedAt", "expiresAt", "source"]);
const safeSlug = (value) => typeof value === "string" &&
    /^[a-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const validLimit = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const categoryValue = (value) => FLEET_COMMONS_CATEGORIES.some(category => category === value);
const severityValue = (value) => FLEET_COMMONS_SEVERITIES.some(severity => severity === value);
// A credential value: a token-alphabet run holding a digit, a long opaque run, or a quoted literal. Prose ("token: must be
// refreshed") and placeholders ("Bearer <token>", "${TOKEN}") are not credentials.
const credentialValue = String.raw `(?:["'][^\s"'<>]{8,}["']|(?=[^\s"'<>]{0,255}\d)[^\s"'<>]{6}|[A-Za-z0-9+/=_]{24})`;
/**
 * Provider `sk-` keys: Anthropic (`sk-ant-api03-…`, setup `sk-ant-oat01-…`, admin `sk-ant-admin01-…`), OpenAI admin /
 * project / service-account / `sk-None-` / OpenRouter keys, a legacy opaque 20+ alphanumeric run, or any 20+ key-alphabet
 * run holding a digit. A short or all-letter word name (`sk-utilities`, `sk-learn-style-helpers`) is not a key.
 */
const providerKey = String.raw `sk-(?:ant-[a-z]+\d{2}-[a-z0-9_-]{20,}|(?:admin|proj|svcacct|none|or-v\d+)-[a-z0-9_-]{20,}|[a-z0-9]{20,}|` +
    String.raw `(?=[a-z_-]{0,255}\d)[a-z0-9_-]{20,})`;
const bearerValue = String.raw `(?:(?=[\w.~+/-]{0,255}\d)[\w.~+/-]{8}|[\w.~+/-]{24})`;
const hygieneRules = [
    ["secret or credential", new RegExp(String.raw `(?<![a-z0-9])(?:${providerKey}|(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-)[a-z0-9_-]+)|\bhooks\.slack\.com/services/\S|` +
            String.raw `\bBearer\s+${bearerValue}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]+|\b(?:api[_ -]?key|(?:access[_ -]?)?token|password|(?:client[_ -]?)?secret)\s*[:=]\s*${credentialValue}|\b(?:api[_ -]?key|password|(?:client[_ -]?)?secret)\s*=\s*[^\s"'<>$\x60]`, "iu")],
    ["AWS credential", /(?<![a-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![a-z0-9])/iu],
    // International (`+` and 8-15 digits) or North American grouped (3-3-4) numbers; status-code lists, dates, versions and
    // bare epoch timestamps are not phone numbers.
    ["phone number", /(?<![\p{L}\p{N}+.])(?:\+(?:[\p{Zs}().-]*\d){8,15}|(?:\(\d{3}\)[\p{Zs}.-]?|\d{3}[\p{Zs}.-])\d{3}[\p{Zs}.-]\d{4})(?![\p{L}\p{N}]|[.-]\d)/u],
    // Slack IDs have a digit immediately after the type prefix; pure-hex digests are not IDs.
    ["Slack ID", /(?<![A-Za-z0-9])(?![\da-fA-F]+(?![A-Za-z0-9]))(?:[CUDGWB]\d[A-Z0-9]{7,}|[cudgwb]0[a-z0-9]{7,})(?![A-Za-z0-9])/u],
    ["client or personal identifier", /\b(?:client|customer|patient|employee)[ _-]+(?:name|id)\s*[:=]\s*\S/iu],
];
function hasEmail(text) {
    // Start at actual @ signs. One local-part character suffices; a DNS name is at most 253 characters.
    for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
        if (/[\p{L}\p{N}._%+-]$/u.test(text.slice(Math.max(0, at - 2), at)) &&
            /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u.test(text.slice(at + 1, at + 254)))
            return true;
    }
    return false;
}
function hasLocalPath(text) {
    const prose = text.replace(/\bhttps?:\/\/[^\s<>"']+/giu, "");
    return /\/(?:Users|home|root|Volumes|mnt|workspaces?|(?:private\/)?tmp|(?:private\/)?var\/folders)\//u.test(prose) ||
        /(?<![a-zA-Z0-9])[a-zA-Z]:[\\/]|~[\\/]|\.openclaw[\\/]workspace|file:\/\//u.test(text);
}
function normalizedText(value) {
    return value.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "");
}
// Known names should match in prose, slug IDs and tags alike.
function termText(value) { return value.toLowerCase().replace(/[\s._-]+/gu, "-"); }
function forbiddenTerms(options) {
    return [...new Set(options?.forbiddenTerms?.map(term => termText(normalizedText(term).trim())).filter(Boolean))].sort();
}
function hygieneReasons(value, terms) {
    const text = normalizedText(value);
    // Detect encoded URLs/paths as well as the raw text. Decode runs independently of stray percent signs.
    const decoded = normalizedText(text.replace(/(?:%[\da-f]{2})+/giu, run => {
        try {
            return decodeURIComponent(run);
        }
        catch {
            return run;
        }
    }));
    const reasons = hygieneRules.filter(([, pattern]) => pattern.test(text) || pattern.test(decoded)).map(([reason]) => reason);
    if (hasEmail(text) || hasEmail(decoded))
        reasons.push("email address");
    if (hasLocalPath(text) || hasLocalPath(decoded))
        reasons.push("local filesystem path");
    if (terms.length) {
        const rawTerms = termText(text), decodedTerms = termText(decoded);
        if (terms.some(term => rawTerms.includes(term) || decodedTerms.includes(term)))
            reasons.push("forbidden term");
    }
    return reasons;
}
export function validateFleetCommonsEntry(value, options) {
    return validateEntry(value, forbiddenTerms(options), options);
}
function validateEntry(value, terms, { maxTitleChars = DEFAULT_TITLE_CHARS, maxBodyChars = DEFAULT_BODY_CHARS, } = {}) {
    if (!isRecord(value))
        return { ok: false, reasons: ["entry must be an object"] };
    if (Object.keys(value).some(key => !entryKeys.has(key)))
        return { ok: false, reasons: ["unknown entry field"] };
    const { id, revision, category, title, body, tags, severity, updatedAt, expiresAt, source } = value;
    if (!safeSlug(id))
        return { ok: false, reasons: ["invalid id"] };
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)
        return { ok: false, reasons: ["invalid revision"] };
    if (!categoryValue(category))
        return { ok: false, reasons: ["invalid category"] };
    if (!severityValue(severity))
        return { ok: false, reasons: ["invalid severity"] };
    if (typeof title !== "string" || (maxTitleChars && title.length > maxTitleChars) || /[\r\n]/u.test(title) || !title.trim()) {
        return { ok: false, reasons: ["invalid title: expected one nonblank line within maxTitleChars"] };
    }
    if (typeof body !== "string" || (maxBodyChars && body.length > maxBodyChars) || !body.trim()) {
        return { ok: false, reasons: ["invalid body: expected nonblank text within maxBodyChars"] };
    }
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string"))
        return { ok: false, reasons: ["invalid tags"] };
    if (!finiteNumber(updatedAt) || !Number.isFinite(new Date(updatedAt).getTime()))
        return { ok: false, reasons: ["invalid updatedAt"] };
    if (expiresAt !== undefined && expiresAt !== null && !finiteNumber(expiresAt))
        return { ok: false, reasons: ["invalid expiresAt"] };
    if (source !== undefined && typeof source !== "string")
        return { ok: false, reasons: ["invalid source"] };
    const fields = { id, title, body, tags: tags.join("\n"), source };
    const reasons = Object.entries(fields).flatMap(([field, text]) => text === undefined ? [] :
        hygieneReasons(text, terms).map(reason => `${field}: ${reason}`));
    if (reasons.length)
        return { ok: false, reasons };
    return { ok: true, entry: { id, revision, category, title, body, tags: [...tags], severity, updatedAt,
            ...(expiresAt !== undefined ? { expiresAt } : {}), ...(source !== undefined ? { source } : {}) } };
}
function ensureFleetCommonsSchema(db) {
    ensureSchemaUnderWriteLock(db, () => tableExists(db, "fleet_commons_entries") && tableExists(db, "fleet_commons_meta"), () => {
        db.exec(`CREATE TABLE IF NOT EXISTS fleet_commons_entries (
      id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, tags_json TEXT NOT NULL CHECK(json_valid(tags_json)),
      updated_at_ms INTEGER NOT NULL, expires_at_ms INTEGER, source TEXT,
      content_sha256 TEXT NOT NULL, synced_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fleet_commons_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`);
    });
}
class FleetCommonsStore {
    db;
    constructor(path) {
        this.db = openMemoryDatabase(path);
        try {
            ensureFleetCommonsSchema(this.db);
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    close() { this.db.close(); }
}
function decodeEntry(row) {
    return {
        id: String(row.id), revision: Number(row.revision), category: row.category,
        title: String(row.title), body: String(row.body), tags: JSON.parse(String(row.tags_json)),
        severity: row.severity, updatedAt: Number(row.updated_at_ms),
        ...(row.expires_at_ms !== null ? { expiresAt: Number(row.expires_at_ms) } : {}),
        ...(row.source !== null ? { source: String(row.source) } : {}),
    };
}
function withReadDb(path, fallback, read) {
    if (!existsSync(path))
        return fallback;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        return read(db);
    }
    finally {
        db.close();
    }
}
function entriesFrom(db) {
    return db.prepare("SELECT * FROM fleet_commons_entries ORDER BY id").all().map(decodeEntry);
}
export function readFleetCommonsEntries(storePath) {
    return withReadDb(storePath, [], db => tableExists(db, "fleet_commons_entries") ? entriesFrom(db) : []);
}
export function getFleetCommonsEntry(storePath, id, revision) {
    return withReadDb(storePath, undefined, db => {
        if (!tableExists(db, "fleet_commons_entries"))
            return undefined;
        const row = db.prepare("SELECT * FROM fleet_commons_entries WHERE id=?").get(id);
        return row && (revision === undefined || row.revision === revision) ? decodeEntry(row) : undefined;
    });
}
function readMeta(db, key) {
    const value = db.prepare("SELECT value FROM fleet_commons_meta WHERE key=?").get(key)?.value;
    return typeof value === "string" ? value : undefined;
}
function writeMeta(db, key, value) {
    if (value === undefined)
        db.prepare("DELETE FROM fleet_commons_meta WHERE key=?").run(key);
    else
        db.prepare("INSERT OR REPLACE INTO fleet_commons_meta(key,value) VALUES(?,?)").run(key, value);
}
export function summarizeFleetCommons(storePath) {
    return withReadDb(storePath, { count: 0 }, db => {
        const count = tableExists(db, "fleet_commons_entries") ?
            Number(db.prepare("SELECT count(*) AS count FROM fleet_commons_entries").get()?.count) : 0;
        if (!tableExists(db, "fleet_commons_meta"))
            return { count };
        const lastSyncAt = readMeta(db, "last_sync_at_ms"), feedDigest = readMeta(db, "feed_digest");
        return { count, ...(lastSyncAt !== undefined ? { lastSyncAt: Number(lastSyncAt) } : {}), ...(feedDigest ? { feedDigest } : {}) };
    });
}
export function fleetCommonsPath(entry) { return `${entry.id}/${entry.revision}`; }
export function fleetCommonsUri(entry) { return `${FLEET_COMMONS_PREFIX}${fleetCommonsPath(entry)}`; }
const fleetCommonsCitation = (entry) => `fleet:${entry.id}@r${entry.revision}`;
/** The exact `memory_get` document for an entry: title, blank line, body, then provenance. Hit line numbers index it. */
export function fleetCommonsDocument(entry) {
    return `${entry.title}\n\n${entry.body}\nUpdated: ${new Date(entry.updatedAt).toISOString()}\nSource: ${fleetCommonsCitation(entry)}`;
}
/** `fleetCommonsDocument` line holding the body's first line. */
const BODY_FIRST_LINE = 3;
const newlines = (text) => text.split("\n").length - 1;
/**
 * A search hit over `entry`. The whole body when it fits `maxSnippetChars` (or no budget is set); otherwise the matched
 * passage, bounded to the budget, so long entries are never dropped. Lines are those of `fleetCommonsDocument`.
 */
export function fleetCommonsHit(entry, score, maxSnippetChars, passage) {
    const { body } = entry;
    let start = 0, snippet = body;
    if (maxSnippetChars !== undefined && maxSnippetChars > 0 && body.length > maxSnippetChars) {
        const located = !passage?.text ? -1 : body.startsWith(passage.text, passage.start) ? passage.start : body.indexOf(passage.text);
        start = Math.max(0, located);
        let end = Math.min(body.length, start + Math.min(located < 0 ? body.length : passage.text.length, maxSnippetChars));
        // Never split a surrogate pair at the budget boundary.
        if (end < body.length && end > start && /[\uD800-\uDBFF]/u.test(body[end - 1]))
            end -= 1;
        snippet = body.slice(start, end);
    }
    const startLine = BODY_FIRST_LINE + newlines(body.slice(0, start));
    return { path: fleetCommonsUri(entry), startLine, endLine: startLine + newlines(snippet.replace(/\n$/u, "")), score,
        snippet, corpus: "fleet", source: "memory", citation: fleetCommonsCitation(entry) };
}
/**
 * A long-lived read-only view of the cache for search and reads: rows are re-read only after some connection commits
 * (`PRAGMA data_version`), and expiry is checked in memory, so a search never reopens SQLite.
 */
export class FleetCommonsReader {
    #path;
    #db;
    #version;
    #seen;
    #entries = [];
    constructor(path) { this.#path = path; }
    /** Cached entries servable at `nowMs` (expired ones drop out between syncs unless `allowExpired`). */
    current(allowExpired, nowMs = Date.now()) {
        const entries = this.#load();
        return allowExpired ? entries : entries.filter(entry => entry.expiresAt == null || entry.expiresAt > nowMs);
    }
    #load() {
        if (!this.#db) {
            if (!existsSync(this.#path))
                return [];
            this.#db = new DatabaseSync(this.#path, { readOnly: true });
            this.#version = this.#db.prepare("PRAGMA data_version");
        }
        const version = this.#version.get()?.data_version;
        if (version !== this.#seen) {
            this.#entries = tableExists(this.#db, "fleet_commons_entries") ? entriesFrom(this.#db) : [];
            this.#seen = version;
        }
        return this.#entries;
    }
    close() {
        this.#db?.close();
        this.#db = this.#version = this.#seen = undefined;
        this.#entries = [];
    }
}
/** `{ id, revision }` of a Fleet Commons citation (`fleet:<id>@r<n>` or `qmd://unblock-fleet/<id>/<n>[#…]`). */
function citedFleetEntry(source) {
    const trimmed = source.trim();
    const match = trimmed.startsWith(FLEET_COMMONS_PREFIX)
        ? /^([a-z0-9._-]+)\/(\d+)(?:#.*)?$/u.exec(trimmed.slice(FLEET_COMMONS_PREFIX.length))
        : /^fleet:([a-z0-9._-]+)@r(\d+)$/u.exec(trimmed);
    return match ? { id: match[1], revision: Number(match[2]) } : undefined;
}
/**
 * Whether every Fleet Commons entry cited in `sources` is still cached at that revision and unexpired at `nowMs` (unless
 * the last sync ran with `allowExpired`). Expiry never moves a collection generation, so cached syntheses check this too.
 */
export function fleetCitationsActive(db, sources, nowMs, allowExpired) {
    const cited = sources.flatMap(source => citedFleetEntry(source) ?? []);
    if (!cited.length)
        return true;
    if (!tableExists(db, "fleet_commons_entries"))
        return false;
    allowExpired ??= tableExists(db, "fleet_commons_meta") && readMeta(db, "allow_expired") === "1";
    const lookup = db.prepare("SELECT expires_at_ms FROM fleet_commons_entries WHERE id=? AND revision=?");
    return cited.every(({ id, revision }) => {
        const row = lookup.get(id, revision);
        return row !== undefined && (allowExpired || row.expires_at_ms === null || Number(row.expires_at_ms) > nowMs);
    });
}
/** Recheck selected syntheses at delivery, using the running plugin's policy rather than the previous sync's. */
export function filterActiveFleetCitations(path, items, sources, allowExpired) {
    const candidates = items.map(item => ({ item, sources: sources(item) }));
    const nonFleet = () => candidates.filter(candidate => !candidate.sources.some(citedFleetEntry)).map(({ item }) => item);
    if (!candidates.some(candidate => candidate.sources.some(citedFleetEntry)))
        return [...items];
    const now = Date.now();
    try {
        return withReadDb(path, nonFleet(), db => candidates.filter(candidate => fleetCitationsActive(db, candidate.sources, now, allowExpired)).map(({ item }) => item));
    }
    catch {
        // A cache that cannot be verified must not suppress unrelated syntheses.
        return nonFleet();
    }
}
function feedEntries(value) {
    const entries = isRecord(value) ? value.entries : value;
    if (!Array.isArray(entries))
        throw new Error("Invalid Fleet Commons feed: expected an entries array");
    return entries;
}
const feedTooLarge = (maxBytes) => new Error(`Fleet Commons feed exceeds fleetCommons.maxFeedBytes (${maxBytes})`);
/** Streams at most `maxBytes` (`0` = unlimited) before decoding; a larger feed fails without buffering the rest. */
async function readBounded(stream, maxBytes, signal, failure) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            let next;
            try {
                next = await abortable(reader.read(), signal);
            }
            catch {
                signal.throwIfAborted();
                throw new Error(failure);
            }
            if (next.done)
                break;
            total += next.value.byteLength;
            if (maxBytes > 0 && total > maxBytes)
                throw feedTooLarge(maxBytes);
            chunks.push(next.value);
        }
    }
    finally {
        void reader.cancel().catch(() => { });
    }
    return Buffer.concat(chunks).toString("utf8");
}
function parseFeed(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        throw new Error("Invalid Fleet Commons feed JSON");
    }
    return feedEntries(value);
}
async function readFeed({ config, fetchImpl = fetch, signal: callerSignal }, db, blocked) {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
    signal.throwIfAborted();
    if (config.feedPath) {
        const stream = Readable.toWeb(createReadStream(config.feedPath, { signal }));
        const text = await readBounded(stream, config.maxFeedBytes, signal, "Fleet Commons feed file could not be read");
        return { status: "synced", entries: parseFeed(text), terms: blocked };
    }
    if (!config.endpoint)
        throw new Error("Enabled fleetCommons requires endpoint or feedPath");
    let token = config.apiKey;
    if (token === undefined && config.apiKeyFile) {
        try {
            token = (await abortable(readFile(config.apiKeyFile, { encoding: "utf8", signal }), signal)).trim();
        }
        catch {
            signal.throwIfAborted();
            throw new Error("Fleet Commons credential file could not be read");
        }
    }
    if (token !== undefined && (!token || /[^\x21-\x7e]/u.test(token)))
        throw new Error("Invalid Fleet Commons credential");
    const scope = jsonHash([config.endpoint, token, config.allowExpired, config.maxEntries,
        config.maxTitleChars ?? DEFAULT_TITLE_CHARS, config.maxBodyChars ?? DEFAULT_BODY_CHARS, blocked]);
    const terms = token ? [...blocked, termText(normalizedText(token))] : blocked;
    // If a bounded snapshot lost a row to expiry, a fresh feed can fill the vacated slot.
    const needsRefill = config.maxEntries > 0 && !config.allowExpired && Boolean(db.prepare("SELECT 1 FROM fleet_commons_entries WHERE expires_at_ms<=? LIMIT 1").get(Date.now()));
    const etag = !needsRefill && scope === readMeta(db, "etag_scope") ? readMeta(db, "etag") : undefined;
    const headers = new Headers({ Accept: "application/json" });
    if (token)
        headers.set("Authorization", `Bearer ${token}`);
    if (etag)
        headers.set("If-None-Match", etag);
    let response;
    try {
        response = await abortable(fetchImpl(config.endpoint, { headers, redirect: "error", signal }), signal);
    }
    catch {
        signal.throwIfAborted();
        throw new Error("Fleet Commons feed request failed");
    }
    if (response.status === 304) {
        if (!etag)
            throw new Error("Unexpected Fleet Commons 304 without a cached ETag");
        return { status: "not_modified", terms };
    }
    if (!response.ok) {
        void response.body?.cancel().catch(() => { });
        throw new Error(`Fleet Commons feed HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (config.maxFeedBytes > 0 && declared > config.maxFeedBytes) {
        void response.body?.cancel().catch(() => { });
        throw feedTooLarge(config.maxFeedBytes);
    }
    const text = response.body ? await readBounded(response.body, config.maxFeedBytes, signal, "Invalid Fleet Commons feed JSON") : "";
    const receivedTag = response.headers.get("etag");
    const safeTag = receivedTag && /^(?:W\/)?"[\x21\x23-\x7e]*"$/u.test(receivedTag) &&
        !hygieneReasons(receivedTag, terms).length ? receivedTag : undefined;
    return { status: "synced", entries: parseFeed(text), etag: safeTag, scope, terms };
}
function replaceEntries(db, entries, now) {
    db.exec("DELETE FROM fleet_commons_entries");
    const insert = db.prepare(`INSERT INTO fleet_commons_entries
    (id,revision,category,severity,title,body,tags_json,updated_at_ms,expires_at_ms,source,content_sha256,synced_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const entry of entries)
        insert.run(entry.id, entry.revision, entry.category, entry.severity, entry.title, entry.body, JSON.stringify(entry.tags), entry.updatedAt, entry.expiresAt ?? null, entry.source ?? null, createHash("sha256").update(entry.body).digest("hex"), now);
}
const severityRank = (entry) => FLEET_COMMONS_SEVERITIES.indexOf(entry.severity);
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
/** `maxEntries` keeps the most severe, then most recently updated entries, independent of feed order. */
const byPriority = (a, b) => severityRank(b) - severityRank(a) || b.updatedAt - a.updatedAt || byId(a, b);
/** Fetch and validate (no writes): everything a sync does before it touches the cache or the projection. */
async function prepareSync(options, db) {
    const feed = await readFeed(options, db, forbiddenTerms(options));
    options.signal?.throwIfAborted();
    const now = Date.now();
    const latest = new Map();
    const rejected = [];
    const incoming = feed.status === "not_modified" ? entriesFrom(db) : feed.entries;
    for (const [index, candidate] of incoming.entries()) {
        const checked = validateEntry(candidate, feed.terms, options.config);
        if (!checked.ok) {
            const id = isRecord(candidate) ? candidate.id : undefined;
            rejected.push({ id: safeSlug(id) && !hygieneReasons(id, feed.terms).length ? id : `#${index + 1}`, reasons: checked.reasons });
            continue;
        }
        const { entry } = checked;
        const previous = latest.get(entry.id);
        if (!previous || entry.revision > previous.revision)
            latest.set(entry.id, entry);
    }
    const eligible = [...latest.values()].filter(entry => options.config.allowExpired || entry.expiresAt == null || entry.expiresAt > now);
    const { maxEntries } = options.config;
    const entries = (maxEntries ? eligible.sort(byPriority).slice(0, maxEntries) : eligible).sort(byId);
    return { status: feed.status, entries, rejected, now,
        ...(feed.status === "synced" ? { etag: { value: feed.etag, scope: feed.scope } } : {}) };
}
/** Serialize the cache + QMD write phase across processes without locking unrelated curation writes during embedding. */
async function withProjectionLock(path, signal, apply) {
    const lock = new DatabaseSync(path + ".fleet-projection-lock");
    try {
        for (;;) {
            signal?.throwIfAborted();
            try {
                lock.exec("BEGIN IMMEDIATE");
                break;
            }
            catch (error) {
                if (!(error instanceof Error) || !("errcode" in error) || error.errcode !== 5)
                    throw error;
                await delay(25, undefined, { signal });
            }
        }
        return await apply();
    }
    finally {
        lock.close();
    }
}
async function commitSync(options, db, prepared, store, generation) {
    options.signal?.throwIfAborted();
    const { entries, now } = prepared;
    const digest = jsonHash(entries.map(entry => ({ ...entry, expiresAt: entry.expiresAt ?? null })));
    const collection = (await store.listCollections?.())?.find(candidate => candidate.name === FLEET_COMMONS_COLLECTION);
    const register = Boolean(store.addCollection) && !collection?.projected;
    options.signal?.throwIfAborted();
    const commit = immediateTransaction(db, () => {
        // Our fetch took place before acquiring the lock. Never overwrite a cache committed in that interval.
        if (readMeta(db, "sync_generation") !== generation) {
            const count = Number(db.prepare("SELECT count(*) AS count FROM fleet_commons_entries").get()?.count);
            return { fenced: true, count };
        }
        const changed = digest !== readMeta(db, "feed_digest");
        const project = changed || register || (Boolean(store.listCollections) && collection?.active_count !== entries.length);
        if (changed)
            replaceEntries(db, entries, now);
        // Invalidate the acknowledgement even for a same-digest repair: QMD commits rows before embedding.
        if (project)
            writeMeta(db, "feed_digest", undefined);
        writeMeta(db, "sync_generation", randomUUID());
        if (prepared.etag) {
            writeMeta(db, "etag", prepared.etag.value);
            writeMeta(db, "etag_scope", prepared.etag.value ? prepared.etag.scope : undefined);
        }
        // Cached syntheses citing an expired entry stay servable only while expired entries are (`fleetCitationsActive`).
        writeMeta(db, "allow_expired", options.config.allowExpired ? "1" : "0");
        return { fenced: false, project };
    });
    if (commit.fenced)
        return { status: "not_modified", count: commit.count, changed: false, rejected: [] };
    if (commit.project) {
        if (register)
            await store.addCollection?.(FLEET_COMMONS_COLLECTION, { projected: true, includeByDefault: false });
        const documents = entries.map(entry => {
            const date = new Date(entry.updatedAt).toISOString();
            return { path: fleetCommonsPath(entry), title: entry.title, content: entry.body, createdAt: date, modifiedAt: date };
        });
        await store.syncProjectedCollection(FLEET_COMMONS_COLLECTION, documents, {
            embed: true, chunkStrategy: "semantic", cleanup: true, ...(options.signal ? { signal: options.signal } : {}),
        });
        options.signal?.throwIfAborted();
    }
    immediateTransaction(db, () => {
        if (commit.project)
            writeMeta(db, "feed_digest", digest);
        writeMeta(db, "last_sync_at_ms", String(now));
    });
    return { status: prepared.status, count: entries.length, changed: commit.project, rejected: prepared.rejected };
}
async function syncOnce(options, path) {
    const cache = new FleetCommonsStore(path);
    try {
        const generation = readMeta(cache.db, "sync_generation");
        const prepared = await prepareSync(options, cache.db);
        const apply = (store) => withProjectionLock(path, options.signal, () => commitSync(options, cache.db, prepared, store, generation));
        return await ("commit" in options ? options.commit(apply) : apply(options.store));
    }
    finally {
        cache.close();
    }
}
const pendingSyncs = new Map();
/** The caller owns scheduling and the projected QMD store; serialize syncs for each cache within this process. */
export async function syncFleetCommons(options) {
    if (!options.config.enabled)
        return { status: "disabled" };
    const path = resolve(options.storePath);
    const pending = pendingSyncs.get(path);
    const run = (async () => {
        if (pending)
            await pending.catch(() => { });
        options.signal?.throwIfAborted();
        return syncOnce(options, path);
    })();
    pendingSyncs.set(path, run);
    try {
        return await run;
    }
    finally {
        if (pendingSyncs.get(path) === run)
            pendingSyncs.delete(path);
    }
}
