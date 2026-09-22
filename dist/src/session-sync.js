import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectSessionDocument, sessionDocumentPath, } from "./session-projector.js";
const MANIFEST_VERSION = 1;
export const PROJECTOR_VERSION = 7;
const SUPPORTED_SCHEMA_VERSIONS = new Set([17, 18, 19]);
// Source lives in src/, published code in dist/src/. Read our own pinned dependency
// metadata, not QMD internals (which may also be substituted by runtime inspectors).
const sourcePackage = new URL("../package.json", import.meta.url);
const packageMetadata = JSON.parse(readFileSync(existsSync(sourcePackage)
    ? sourcePackage : new URL("../../package.json", import.meta.url), "utf8"));
const indexVersion = [packageMetadata.version, packageMetadata.dependencies["@unblocklabs/qmd"]];
const REQUIRED_COLUMNS = {
    schema_meta: ["meta_key", "role", "schema_version", "agent_id", "app_version"],
    session_windows: [
        "session_id", "session_key", "chat_type", "channel", "account_id",
        "primary_conversation_id", "created_at", "started_at", "ended_at",
    ],
    conversations: [
        "conversation_id", "channel", "account_id", "kind", "peer_id",
        "thread_id", "native_channel_id", "native_direct_user_id", "label",
    ],
    transcript_events: ["session_id", "seq", "event_json", "created_at"],
    session_transcript_active_events: ["session_id", "active_position", "event_seq", "message_position"],
    transcript_rewrite_watermarks: ["session_id", "generation"],
};
function projectionKey(params) {
    return JSON.stringify([PROJECTOR_VERSION, params.databasePath, params.agentId,
        params.agentName, params.timezone, [...params.chatTypes].sort()]);
}
// Conservative proof: any index/WAL write, replacement or QMD upgrade invalidates it.
// This avoids depending on QMD's private embedding schema or opening/loading its store.
function sessionIndexSignature(databasePath) {
    try {
        const fingerprint = (path) => {
            const stat = statSync(path, { bigint: true });
            return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
        };
        let wal = null;
        try {
            wal = fingerprint(`${databasePath}-wal`);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        return JSON.stringify([indexVersion, fingerprint(databasePath), wal]);
    }
    catch {
        return undefined;
    }
}
function projectionPath(outputDir, documentPath) {
    const root = resolve(outputDir);
    const target = resolve(root, documentPath);
    const pathFromRoot = relative(root, target);
    if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
        throw new Error(`invalid unblock-memory session document path: ${documentPath}`);
    }
    let current = root;
    for (const component of ["", ...pathFromRoot.split(sep)]) {
        current = component ? join(current, component) : current;
        try {
            if (lstatSync(current).isSymbolicLink()) {
                throw new Error(`invalid unblock-memory session document path: ${documentPath}`);
            }
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    return target;
}
function assertSchema(db, expectedAgentId) {
    const pragma = db.prepare("PRAGMA user_version").get();
    const schemaVersion = pragma?.user_version;
    if (typeof schemaVersion !== "number" || !SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
        throw new Error("unsupported OpenClaw agent database schema: expected one of 17, 18, 19, " +
            `found ${String(schemaVersion ?? "unknown")}`);
    }
    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
        const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all()
            .map((column) => column.name));
        const missing = required.find((column) => !columns.has(column));
        if (missing)
            throw new Error(`unsupported OpenClaw agent database: missing ${table}.${missing}`);
    }
    const meta = db.prepare("SELECT role, schema_version AS schemaVersion, agent_id AS agentId " +
        "FROM schema_meta WHERE meta_key = 'primary' LIMIT 1").get();
    if (meta?.role !== "agent" || meta.schemaVersion !== schemaVersion) {
        throw new Error("unsupported OpenClaw agent database primary schema metadata");
    }
    if (meta.agentId !== expectedAgentId) {
        throw new Error(`OpenClaw agent database belongs to ${String(meta.agentId)}, not ${expectedAgentId}`);
    }
}
function readSnapshot(params) {
    const db = new DatabaseSync(params.databasePath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN");
        assertSchema(db, params.agentId);
        const placeholders = params.chatTypes.map(() => "?").join(", ");
        const windows = db.prepare(`
      SELECT
        window.session_id AS sessionId,
        window.chat_type AS chatType,
        COALESCE(window.channel, conversation.channel) AS provider,
        COALESCE(window.account_id, conversation.account_id) AS accountId,
        COALESCE(conversation.native_channel_id, conversation.native_direct_user_id,
                 conversation.peer_id, window.primary_conversation_id) AS conversationId,
        conversation.label AS label,
        COALESCE(window.started_at, window.created_at) AS startedAt,
        rewrite.generation AS sourceGeneration,
        MAX(active.event_seq) AS maxSeq,
        COUNT(active.event_seq) AS activeEventCount
      FROM session_windows AS window
      LEFT JOIN conversations AS conversation
        ON conversation.conversation_id = window.primary_conversation_id
      LEFT JOIN transcript_rewrite_watermarks AS rewrite
        ON rewrite.session_id = window.session_id
      LEFT JOIN session_transcript_active_events AS active
        ON active.session_id = window.session_id
      WHERE window.chat_type IN (${placeholders})
      GROUP BY window.session_id
      ORDER BY window.created_at, window.session_id
    `).all(...params.chatTypes);
        const readEvents = db.prepare(`
      SELECT active.session_id AS sessionId, event.event_json AS eventJson,
             event.created_at AS createdAt
      FROM session_transcript_active_events AS active
      JOIN transcript_events AS event
        ON event.session_id = active.session_id AND event.seq = active.event_seq
      WHERE active.session_id = ?
      ORDER BY active.active_position
    `);
        const events = new Map();
        const changed = new Set();
        for (const window of windows) {
            const metadata = {
                sessionId: window.sessionId,
                provider: window.provider ?? undefined,
                chatType: window.chatType,
                accountId: window.accountId ?? undefined,
                conversationId: window.conversationId ?? undefined,
                startedAt: window.startedAt,
            };
            const previous = params.previousManifest.sessions[window.sessionId];
            const documentPath = sessionDocumentPath(metadata);
            const sourceFingerprint = JSON.stringify(window);
            const unchanged = !params.force &&
                (previous ? previous.sourceFingerprint === sourceFingerprint &&
                    previous.projectorVersion === PROJECTOR_VERSION &&
                    previous.documentPath === documentPath &&
                    existsSync(projectionPath(params.outputDir, documentPath)) :
                    params.previousManifest.ignoredSessions?.[window.sessionId] === sourceFingerprint);
            if (!unchanged) {
                changed.add(window.sessionId);
                if (!params.metadataOnly)
                    events.set(window.sessionId, readEvents.all(window.sessionId));
            }
        }
        db.exec("COMMIT");
        return { windows, events, changed };
    }
    catch (error) {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* transaction may not have started */ }
        throw error;
    }
    finally {
        db.close();
    }
}
export async function unchangedSessionSync(params, indexPath) {
    const manifest = await readSessionManifest(params.manifestPath);
    if (!manifest.lastSuccessfulSyncAt || manifest.projectionKey !== projectionKey(params) ||
        !manifest.indexSignature || manifest.indexSignature !== sessionIndexSignature(indexPath))
        return;
    const snapshot = readSnapshot({ ...params, previousManifest: manifest, force: false, metadataOnly: true });
    const ids = new Set(snapshot.windows.map(window => window.sessionId));
    if (snapshot.changed.size || Object.keys(manifest.sessions).some(id => !ids.has(id)) ||
        Object.keys(manifest.ignoredSessions ?? {}).some(id => !ids.has(id)))
        return;
    return { scanned: ids.size, unchanged: ids.size, updated: 0, removed: 0,
        skipped: 0, failed: 0, embedded: 0, lastSuccessfulSyncAt: manifest.lastSuccessfulSyncAt,
        lastCheckedAt: Date.now(), lastIndexedAt: manifest.lastIndexedAt, skipReason: "no_changes" };
}
function emptyManifest() {
    return { version: MANIFEST_VERSION, sessions: {} };
}
export async function readSessionManifest(path) {
    if (!existsSync(path))
        return emptyManifest();
    let value;
    try {
        value = JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        throw new Error(`invalid unblock-memory session manifest: ${path}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`invalid unblock-memory session manifest: ${path}`);
    }
    const manifest = value;
    if (manifest.version !== MANIFEST_VERSION || !manifest.sessions ||
        typeof manifest.sessions !== "object" || Array.isArray(manifest.sessions)) {
        throw new Error(`unsupported unblock-memory session manifest: ${path}`);
    }
    return manifest;
}
async function atomicWrite(path, content, mode) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, content, { encoding: "utf8", mode });
        await rename(temporary, path);
        await chmod(path, mode);
    }
    catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
}
async function remove(path) {
    try {
        await unlink(path);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
function projectionHash(content) {
    return createHash("sha256").update(content).digest("hex");
}
export function sessionMetadataByPath(manifest) {
    return new Map(Object.values(manifest.sessions).map((session) => [session.documentPath, {
            sessionId: session.sessionId,
            provider: session.provider,
            chatType: session.chatType,
            accountId: session.accountId,
            conversationId: session.conversationId,
            startedAt: session.startedAt,
        }]));
}
export async function syncSessionProjections(params) {
    const previousManifest = await readSessionManifest(params.manifestPath);
    const snapshot = readSnapshot({
        ...params,
        force: params.force === true || previousManifest.projectionKey !== projectionKey(params),
        previousManifest,
    });
    const sessions = {};
    const ignoredSessions = {};
    const counts = { unchanged: 0, updated: 0, removed: 0, skipped: 0, failed: 0 };
    const diagnostics = { internalMessagesCleaned: 0, attachmentsCleaned: 0, attachmentBudgetSkipped: 0 };
    await mkdir(params.outputDir, { recursive: true, mode: 0o700 });
    await chmod(params.outputDir, 0o700);
    for (const window of snapshot.windows) {
        const previous = previousManifest.sessions[window.sessionId];
        const events = snapshot.events.get(window.sessionId);
        const metadata = {
            sessionId: window.sessionId,
            provider: window.provider ?? undefined,
            chatType: window.chatType,
            accountId: window.accountId ?? undefined,
            conversationId: window.conversationId ?? undefined,
            startedAt: window.startedAt,
        };
        const documentPath = sessionDocumentPath(metadata);
        if (events === undefined) {
            if (previous)
                sessions[window.sessionId] = previous;
            else
                ignoredSessions[window.sessionId] = JSON.stringify(window);
            counts.unchanged += 1;
            continue;
        }
        if (events.length > 0 && (!window.sourceGeneration || window.maxSeq === null)) {
            counts.failed += 1;
            if (previous)
                sessions[window.sessionId] = previous;
            continue;
        }
        let projection;
        try {
            const input = {
                ...metadata,
                label: window.label ?? undefined,
                agentName: params.agentName,
                timezone: params.timezone,
                events,
                diagnostics,
            };
            projection = projectSessionDocument(input);
        }
        catch {
            counts.failed += 1;
            if (previous)
                sessions[window.sessionId] = previous;
            continue;
        }
        if (!projection) {
            ignoredSessions[window.sessionId] = JSON.stringify(window);
            counts.skipped += 1;
            if (previous) {
                await remove(projectionPath(params.outputDir, previous.documentPath));
                counts.removed += 1;
            }
            continue;
        }
        const { content, messages } = projection;
        const target = projectionPath(params.outputDir, documentPath);
        const hash = projectionHash(content);
        const contentChanged = params.force === true || previous?.projectorVersion !== PROJECTOR_VERSION ||
            previous.projectionHash !== hash || previous.documentPath !== documentPath || !existsSync(target);
        if (contentChanged) {
            await atomicWrite(target, content, 0o600);
            await utimes(target, new Date(), new Date(metadata.startedAt));
        }
        if (previous?.documentPath && previous.documentPath !== documentPath) {
            await remove(projectionPath(params.outputDir, previous.documentPath));
        }
        sessions[window.sessionId] = {
            ...metadata,
            sourceGeneration: window.sourceGeneration,
            maxSeq: window.maxSeq,
            activeEventCount: window.activeEventCount,
            sizeBytes: Buffer.byteLength(content),
            projectionHash: hash,
            documentPath,
            projectorVersion: PROJECTOR_VERSION,
            sourceFingerprint: JSON.stringify(window),
            messages,
        };
        if (contentChanged)
            counts.updated += 1;
        else
            counts.unchanged += 1;
    }
    for (const [sessionId, session] of Object.entries(previousManifest.sessions)) {
        if (sessions[sessionId] || snapshot.windows.some((window) => window.sessionId === sessionId))
            continue;
        await remove(projectionPath(params.outputDir, session.documentPath));
        counts.removed += 1;
    }
    const needsIndex = params.force === true || counts.updated > 0 || counts.removed > 0 ||
        previousManifest.projectionKey !== projectionKey(params) ||
        !previousManifest.indexSignature || !params.indexPath ||
        previousManifest.indexSignature !== sessionIndexSignature(params.indexPath);
    const embedded = needsIndex ? await params.index?.() ?? 0 : 0;
    const lastSuccessfulSyncAt = Date.now();
    const indexed = needsIndex && params.index !== undefined;
    const signature = params.indexPath ? sessionIndexSignature(params.indexPath) : undefined;
    const indexReady = indexed && (await params.indexReady?.() ?? false);
    const lastIndexedAt = indexed ? lastSuccessfulSyncAt : previousManifest.lastIndexedAt;
    const manifest = {
        version: MANIFEST_VERSION,
        lastSuccessfulSyncAt,
        lastIndexedAt,
        projectionKey: projectionKey(params),
        // Never certify an index mutation that happened during a skipped run or readiness check.
        indexSignature: counts.failed > 0 ? undefined : !needsIndex ? previousManifest.indexSignature :
            indexReady && params.indexPath && signature === sessionIndexSignature(params.indexPath) ? signature : undefined,
        ignoredSessions,
        sessions,
    };
    await atomicWrite(params.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    return {
        result: {
            scanned: snapshot.windows.length,
            ...counts,
            embedded,
            lastSuccessfulSyncAt,
            lastCheckedAt: lastSuccessfulSyncAt,
            lastIndexedAt,
            ...(!needsIndex ? { skipReason: "no_indexable_changes" } : {}),
            diagnostics,
        },
        manifest,
    };
}
