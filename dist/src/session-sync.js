import { DEFAULTS } from "./defaults.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AgentTranscriptReader, agentTranscriptSchemaVersion, assertAgentTranscriptIdentity, hostSessionCatalog, inspectTranscriptColumns } from "./agent-transcript.js";
import { projectSessionDocument, sessionDocumentPath, } from "./session-projector.js";
export const PROJECTOR_VERSION = 9;
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
function windowMetadata(window) {
    return {
        sessionId: window.sessionId,
        provider: window.provider ?? undefined,
        chatType: window.chatType,
        accountId: window.accountId ?? undefined,
        conversationId: window.conversationId ?? undefined,
        startedAt: window.startedAt,
    };
}
function projectionKey(params) {
    return JSON.stringify([PROJECTOR_VERSION, params.databasePath, params.agentId,
        params.agentName, params.timezone, [...params.chatTypes].sort(), params.syntheticInput ?? null]);
}
// Conservative proof: any index/WAL write, replacement or QMD upgrade invalidates it.
// This lets the quiet check skip opening QMD (and loading models) entirely.
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
/** QMD's projected-path rule: nonempty collection-relative slash-separated segments, no traversal. */
function assertDocumentPath(documentPath) {
    if (typeof documentPath !== "string" || documentPath.includes("\0") || documentPath.includes("\\") ||
        /^[a-z]:/iu.test(documentPath) || documentPath.split("/").some(part => !part || part === "." || part === "..")) {
        throw new Error(`invalid unblock-memory session document path: ${documentPath}`);
    }
    return documentPath;
}
function assertSchema(db, expectedAgentId, columns) {
    const version = agentTranscriptSchemaVersion(db);
    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
        const found = columns(table);
        const missing = required.find((column) => !found.has(column));
        if (missing)
            throw new Error(`unsupported OpenClaw agent database: missing ${table}.${missing}`);
    }
    assertAgentTranscriptIdentity(db, expectedAgentId, version);
}
function readSnapshot(params) {
    const db = new DatabaseSync(params.databasePath, { readOnly: true });
    try {
        db.exec(`PRAGMA query_only = ON; PRAGMA busy_timeout = ${DEFAULTS.sqlite.mainBusyTimeoutMs}; BEGIN`);
        const columns = inspectTranscriptColumns(db);
        assertSchema(db, params.agentId, columns);
        const transcripts = new AgentTranscriptReader(db, params.agentId, undefined, columns);
        const placeholders = params.chatTypes.map(() => "?").join(", ");
        const windows = db.prepare(`
      SELECT
        w.session_id AS sessionId,
        w.chat_type AS chatType,
        ${hostSessionCatalog.provider} AS provider,
        ${hostSessionCatalog.accountId} AS accountId,
        COALESCE(c.native_channel_id, c.native_direct_user_id, c.peer_id, w.primary_conversation_id) AS conversationId,
        c.label AS label,
        COALESCE(w.started_at, w.created_at) AS startedAt,
        rewrite.generation AS sourceGeneration,
        MAX(active.event_seq) AS maxSeq,
        COUNT(active.event_seq) AS activeEventCount,
        ${transcripts.coldSql("w.session_id")} AS cold
      ${hostSessionCatalog.from}
      LEFT JOIN transcript_rewrite_watermarks AS rewrite
        ON rewrite.session_id = w.session_id
      LEFT JOIN session_transcript_active_events AS active
        ON active.session_id = w.session_id
      WHERE w.chat_type IN (${placeholders})
      GROUP BY w.session_id
      ORDER BY w.created_at, w.session_id
    `).all(...params.chatTypes);
        const snapshot = windows.map((window) => {
            const metadata = windowMetadata(window);
            const previous = params.previousManifest.sessions[window.sessionId];
            const documentPath = sessionDocumentPath(metadata);
            const sourceFingerprint = JSON.stringify(window);
            const entryProjectionKey = previous?.projectionKey ?? params.previousManifest.projectionKey;
            const previouslyFailed = params.previousManifest.failedSessions?.[window.sessionId] !== undefined;
            const unchanged = !window.cold && !params.force && !previouslyFailed &&
                (previous
                    ? entryProjectionKey === params.currentProjectionKey &&
                        previous.sourceFingerprint === sourceFingerprint &&
                        previous.projectorVersion === PROJECTOR_VERSION &&
                        previous.documentPath === documentPath
                    : params.previousManifest.projectionKey === params.currentProjectionKey &&
                        params.previousManifest.ignoredSessions?.[window.sessionId] === sourceFingerprint);
            const entry = (transcript) => ({ row: window, sourceFingerprint, transcript });
            if (unchanged)
                return entry({ state: "unchanged" });
            if (params.metadataOnly)
                return entry({ state: "needs-read" });
            try {
                const read = transcripts.read(window.sessionId);
                return entry(read.kind === "ready" ? { state: "ready", events: read.rows } : { state: "unavailable" });
            }
            catch {
                return entry({ state: "unavailable" });
            }
        });
        db.exec("COMMIT");
        return snapshot;
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
/**
 * Quiet check without opening QMD: proves nothing changed since the last certified sync. Requires a manifest
 * produced by the projected-collection pipeline (a legacy import always reconciles first).
 */
export async function unchangedSessionSync(params, indexPath) {
    const manifest = params.state.read();
    const currentProjectionKey = projectionKey(params);
    if (!manifest.lastSuccessfulSyncAt || manifest.generation === undefined || manifest.projectionKey !== currentProjectionKey ||
        !manifest.indexSignature || manifest.indexSignature !== sessionIndexSignature(indexPath) ||
        Object.keys(manifest.failedSessions ?? {}).length > 0)
        return;
    const snapshot = readSnapshot({
        ...params,
        previousManifest: manifest,
        currentProjectionKey,
        force: false,
        metadataOnly: true,
    });
    const ids = new Set(snapshot.map(window => window.row.sessionId));
    if (snapshot.some(window => window.transcript.state !== "unchanged") || Object.keys(manifest.sessions).some(id => !ids.has(id)) ||
        Object.keys(manifest.ignoredSessions ?? {}).some(id => !ids.has(id)))
        return;
    return { scanned: ids.size, unchanged: ids.size, updated: 0, removed: 0,
        skipped: 0, failed: 0, embedded: 0, lastSuccessfulSyncAt: manifest.lastSuccessfulSyncAt,
        lastCheckedAt: Date.now(), lastIndexedAt: manifest.lastIndexedAt, skipReason: "no_changes" };
}
export function projectionHash(content) {
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
function retainPreviousSession(previous, previousManifestProjectionKey) {
    if (!previous)
        return undefined;
    if (previous.projectionKey !== undefined || previousManifestProjectionKey === undefined) {
        return previous;
    }
    return { ...previous, projectionKey: previousManifestProjectionKey };
}
function syncWindow(params) {
    const { row: window, sourceFingerprint, transcript } = params.window;
    const { previous } = params;
    const metadata = windowMetadata(window);
    const documentPath = assertDocumentPath(sessionDocumentPath(metadata));
    const fail = () => ({
        kind: "failed",
        session: retainPreviousSession(previous, params.previousManifestProjectionKey),
    });
    if (transcript.state === "unavailable")
        return fail();
    if (transcript.state !== "ready") {
        return previous
            ? { kind: "unchanged", session: previous }
            : { kind: "unchanged", ignoredFingerprint: sourceFingerprint };
    }
    const { events } = transcript;
    if (events.length > 0 && (!window.sourceGeneration || window.maxSeq === null)) {
        return fail();
    }
    let projection;
    try {
        const input = {
            ...metadata,
            label: window.label ?? undefined,
            agentName: params.agentName,
            timezone: params.timezone,
            events,
            syntheticInput: params.syntheticInput,
            diagnostics: params.diagnostics,
        };
        projection = projectSessionDocument(input);
    }
    catch {
        return fail();
    }
    if (!projection) {
        return { kind: "skipped", ignoredFingerprint: sourceFingerprint, retract: previous?.documentPath };
    }
    const { content, messages } = projection;
    const hash = projectionHash(content);
    const contentChanged = params.force || previous?.projectorVersion !== PROJECTOR_VERSION ||
        previous.projectionHash !== hash || previous.documentPath !== documentPath;
    // The file-era transport stamped mtime with the session start; QMD keeps the same chronology.
    const startedAt = new Date(metadata.startedAt).toISOString();
    const document = { path: documentPath, content, createdAt: startedAt, modifiedAt: startedAt };
    const session = {
        ...metadata,
        sourceGeneration: window.sourceGeneration,
        maxSeq: window.maxSeq,
        activeEventCount: window.activeEventCount,
        sizeBytes: Buffer.byteLength(content),
        projectionHash: hash,
        documentPath,
        projectorVersion: PROJECTOR_VERSION,
        projectionKey: params.currentProjectionKey,
        sourceFingerprint,
        messages,
    };
    const retract = previous?.documentPath && previous.documentPath !== documentPath ? previous.documentPath : undefined;
    return contentChanged ? { kind: "updated", session, document, retract } : { kind: "unchanged", session, document };
}
async function certifyIndex(index) {
    if (!index.path)
        return undefined;
    // Capture the signature after indexing, before the readiness check, and require it unchanged after.
    const before = sessionIndexSignature(index.path);
    if (!before || !await index.ready())
        return undefined;
    return before === sessionIndexSignature(index.path) ? before : undefined;
}
/**
 * Project changed sessions in memory and write them straight into QMD's projected sessions collection.
 *
 * - Incremental (manifest generation equals QMD's): upsert changed documents, retract removed ones.
 * - Reconcile (force, legacy import, or anyone else changed the collection): re-read every window and, when all
 *   succeed, atomically replace the collection's complete document set (`syncProjectedCollection`). When some windows
 *   fail (cold, unreadable), keep their existing documents, upsert the rest and retract only true strays, then certify
 *   the generation anyway: the failed windows stay in `failedSessions` and are retried incrementally.
 * The manifest is persisted only after QMD accepted the writes; a crash in between reconciles next time.
 * `beforeWrite` runs before every QMD mutation (a fence probe may abort `signal` there), then `signal` is checked.
 */
export async function syncSessionProjections(params) {
    const { index, signal } = params;
    const guardWrite = () => { params.beforeWrite?.(); signal?.throwIfAborted(); };
    signal?.throwIfAborted();
    const previousManifest = params.state.read();
    for (const session of Object.values(previousManifest.sessions))
        assertDocumentPath(session.documentPath);
    const currentProjectionKey = projectionKey(params);
    const generationBefore = await index.generation();
    const reconcile = params.force === true || previousManifest.generation !== generationBefore;
    const snapshot = readSnapshot({
        ...params,
        force: reconcile,
        previousManifest,
        currentProjectionKey,
    });
    const sessions = {};
    const ignoredSessions = {};
    const failedSessions = {};
    const counts = { unchanged: 0, updated: 0, removed: 0, skipped: 0, failed: 0 };
    const diagnostics = { internalMessagesCleaned: 0, attachmentsCleaned: 0, attachmentBudgetSkipped: 0 };
    const documents = [];
    const upserts = [];
    const retractions = new Set();
    // A failed window keeps whatever QMD already holds for it, at its previous or current path.
    const failedPaths = new Set();
    for (const entry of snapshot) {
        const window = entry.row;
        signal?.throwIfAborted();
        const outcome = syncWindow({
            window: entry,
            previous: previousManifest.sessions[window.sessionId],
            force: params.force === true,
            agentName: params.agentName,
            timezone: params.timezone,
            syntheticInput: params.syntheticInput,
            currentProjectionKey,
            previousManifestProjectionKey: previousManifest.projectionKey,
            diagnostics,
        });
        if (outcome.kind === "failed") {
            counts.failed += 1;
            failedSessions[window.sessionId] = entry.sourceFingerprint;
            failedPaths.add(sessionDocumentPath(windowMetadata(window)));
            if (outcome.session)
                sessions[window.sessionId] = outcome.session;
        }
        else if (outcome.kind === "unchanged") {
            counts.unchanged += 1;
            if (outcome.session)
                sessions[window.sessionId] = outcome.session;
            else if (outcome.ignoredFingerprint !== undefined) {
                ignoredSessions[window.sessionId] = outcome.ignoredFingerprint;
            }
            if (outcome.document) {
                documents.push(outcome.document);
                // Reconciling cannot trust QMD to hold even content-identical documents.
                if (reconcile)
                    upserts.push(outcome.document);
            }
        }
        else if (outcome.kind === "skipped") {
            counts.skipped += 1;
            ignoredSessions[window.sessionId] = outcome.ignoredFingerprint;
            if (outcome.retract) {
                retractions.add(outcome.retract);
                counts.removed += 1;
            }
        }
        else {
            counts.updated += 1;
            sessions[window.sessionId] = outcome.session;
            documents.push(outcome.document);
            upserts.push(outcome.document);
            if (outcome.retract)
                retractions.add(outcome.retract);
        }
    }
    const liveIds = new Set(snapshot.map(window => window.row.sessionId));
    for (const [sessionId, session] of Object.entries(previousManifest.sessions)) {
        if (sessions[sessionId] || liveIds.has(sessionId))
            continue;
        retractions.add(session.documentPath);
        counts.removed += 1;
    }
    const kept = new Set([...Object.values(sessions).map(session => session.documentPath), ...failedPaths]);
    for (const path of kept)
        retractions.delete(path);
    signal?.throwIfAborted();
    // Every snapshot window was read, so the desired set is complete: let QMD sweep anything else.
    const replaceAll = reconcile && counts.failed === 0;
    if (reconcile && !replaceAll) {
        // Partial reconcile: sweep true strays explicitly, never a document a failed window may still need.
        for (const document of documents)
            kept.add(document.path);
        for (const path of await index.activePaths())
            if (!kept.has(path))
                retractions.add(path);
    }
    const writes = replaceAll || upserts.length > 0 || retractions.size > 0;
    if (writes)
        params.onIndexing?.();
    let changedDocuments = 0;
    if (replaceAll) {
        guardWrite();
        changedDocuments = await index.replace(documents, signal);
    }
    else {
        for (const document of upserts) {
            guardWrite();
            if (await index.upsert(document))
                changedDocuments += 1;
        }
        for (const path of retractions) {
            guardWrite();
            if (await index.retract(path))
                changedDocuments += 1;
        }
    }
    // The index changed since the last certification (or never was): embedding is incremental, so re-check it.
    const needsIndex = reconcile || changedDocuments > 0 || !previousManifest.indexSignature || !index.path ||
        previousManifest.indexSignature !== sessionIndexSignature(index.path) ||
        previousManifest.projectionKey !== currentProjectionKey;
    if (needsIndex && !writes)
        params.onIndexing?.();
    if (needsIndex)
        guardWrite();
    else
        signal?.throwIfAborted();
    const embedded = needsIndex ? await index.embed() : 0;
    const generationAfter = await index.generation();
    const checkedAt = Date.now();
    // Never certify an index mutation that happened during a failed run or a readiness check.
    const indexSignature = counts.failed > 0 ? undefined : await certifyIndex(index);
    const lastSuccessfulSyncAt = counts.failed === 0 ? checkedAt : previousManifest.lastSuccessfulSyncAt;
    const lastIndexedAt = needsIndex ? checkedAt : previousManifest.lastIndexedAt;
    const manifestProjectionKey = counts.failed === 0
        ? currentProjectionKey
        : previousManifest.projectionKey;
    // Even a partial reconcile swept its strays, so its generation is certified and the next run stays incremental.
    const generation = generationAfter;
    const manifest = {
        version: previousManifest.version,
        lastSuccessfulSyncAt,
        lastIndexedAt,
        projectionKey: manifestProjectionKey,
        ...(indexSignature !== undefined ? { indexSignature } : {}),
        generation,
        ignoredSessions,
        ...(Object.keys(failedSessions).length ? { failedSessions } : {}),
        sessions,
    };
    params.state.write(manifest);
    return {
        result: {
            scanned: snapshot.length,
            ...counts,
            embedded,
            ...(lastSuccessfulSyncAt !== undefined ? { lastSuccessfulSyncAt } : {}),
            lastCheckedAt: checkedAt,
            lastIndexedAt,
            ...(!needsIndex ? { skipReason: "no_indexable_changes" } : {}),
            diagnostics,
        },
        manifest,
    };
}
