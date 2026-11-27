import { DEFAULTS } from "./defaults.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AgentTranscriptReader, agentTranscriptSchemaVersion, assertAgentTranscriptIdentity } from "./agent-transcript.js";
import type { ChatType } from "./config.js";
import {
  projectSessionDocument,
  sessionDocumentPath,
  type SessionMetadata,
  type SessionProjectionInput,
} from "./session-projector.js";
import type { IndexedSession, SessionManifest } from "./session-sync-state.js";

export const PROJECTOR_VERSION = 8;
// Source lives in src/, published code in dist/src/. Read our own pinned dependency
// metadata, not QMD internals (which may also be substituted by runtime inspectors).
const sourcePackage = new URL("../package.json", import.meta.url);
const packageMetadata = JSON.parse(readFileSync(existsSync(sourcePackage)
  ? sourcePackage : new URL("../../package.json", import.meta.url), "utf8"));
const indexVersion: unknown[] = [packageMetadata.version, packageMetadata.dependencies["@unblocklabs/qmd"]];

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
} as const;

export type SessionSyncResult = {
  scanned: number;
  unchanged: number;
  updated: number;
  removed: number;
  skipped: number;
  failed: number;
  embedded: number;
  lastSuccessfulSyncAt?: number;
  lastCheckedAt?: number;
  lastIndexedAt?: number;
  skipReason?: "no_changes" | "no_indexable_changes";
  diagnostics?: NonNullable<SessionProjectionInput["diagnostics"]>;
};

type WindowRow = {
  sessionId: string;
  chatType: ChatType;
  provider: string | null;
  accountId: string | null;
  conversationId: string | null;
  label: string | null;
  startedAt: number;
  sourceGeneration: string | null;
  maxSeq: number | null;
  activeEventCount: number;
  cold: number;
};

function windowMetadata(window: WindowRow): SessionMetadata {
  return {
    sessionId: window.sessionId,
    provider: window.provider ?? undefined,
    chatType: window.chatType,
    accountId: window.accountId ?? undefined,
    conversationId: window.conversationId ?? undefined,
    startedAt: window.startedAt,
  };
}

type EventRows = SessionProjectionInput["events"];

type ProjectionOptions = {
  databasePath: string;
  agentId: string;
  agentName: string;
  timezone: string;
  chatTypes: readonly ChatType[];
};

/** A projected session document: QMD stores it directly; nothing is written to disk. */
type SessionDocument = { path: string; content: string; createdAt: string; modifiedAt: string };

/** QMD projected-collection adapter for the sessions collection. */
export type SessionIndex = {
  /** Latest committed collection generation (QMD bumps it on every document change). */
  generation(): Promise<number>;
  upsert(document: SessionDocument): Promise<boolean>;
  retract(path: string): Promise<boolean>;
  /** Reconcile the complete desired set atomically; returns the number of changed documents. */
  replace(documents: readonly SessionDocument[], signal?: AbortSignal): Promise<number>;
  /** Paths of every active document in the collection (for a partial reconcile's explicit stray sweep). */
  activePaths(): Promise<readonly string[]>;
  /** Embed pending chunks; returns the number of chunks embedded. */
  embed(): Promise<number>;
  ready(): Promise<boolean>;
  /** Index file whose stat fingerprint certifies the no-store quiet check. */
  path?: string;
};

/** Durable manifest storage (SQLite); `write` may be fenced by the caller's WorkStore claim. */
export type SessionManifestStore = { read(): SessionManifest; write(manifest: SessionManifest): void };

function projectionKey(params: ProjectionOptions): string {
  return JSON.stringify([PROJECTOR_VERSION, params.databasePath, params.agentId,
    params.agentName, params.timezone, [...params.chatTypes].sort()]);
}

// Conservative proof: any index/WAL write, replacement or QMD upgrade invalidates it.
// This lets the quiet check skip opening QMD (and loading models) entirely.
function sessionIndexSignature(databasePath: string): string | undefined {
  try {
    const fingerprint = (path: string) => {
      const stat = statSync(path, { bigint: true });
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    };
    let wal: string[] | null = null;
    try { wal = fingerprint(`${databasePath}-wal`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return JSON.stringify([indexVersion, fingerprint(databasePath), wal]);
  } catch { return undefined; }
}

/** QMD's projected-path rule: nonempty collection-relative slash-separated segments, no traversal. */
function assertDocumentPath(documentPath: string): string {
  if (typeof documentPath !== "string" || documentPath.includes("\0") || documentPath.includes("\\") ||
    /^[a-z]:/iu.test(documentPath) || documentPath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`invalid unblock-memory session document path: ${documentPath}`);
  }
  return documentPath;
}

function assertSchema(db: DatabaseSync, expectedAgentId: string): void {
  const version = agentTranscriptSchemaVersion(db);
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name));
    const missing = required.find((column) => !columns.has(column));
    if (missing) throw new Error(`unsupported OpenClaw agent database: missing ${table}.${missing}`);
  }
  assertAgentTranscriptIdentity(db, expectedAgentId, version);
}

function readSnapshot(params: {
  databasePath: string;
  agentId: string;
  chatTypes: readonly ChatType[];
  force: boolean;
  previousManifest: SessionManifest;
  currentProjectionKey: string;
  metadataOnly?: boolean;
}): {
  windows: WindowRow[];
  fingerprints: Map<string, string>;
  events: Map<string, EventRows>;
  changed: Set<string>;
  unavailable: Set<string>;
} {
  const db = new DatabaseSync(params.databasePath, { readOnly: true });
  try {
    db.exec(`PRAGMA query_only = ON; PRAGMA busy_timeout = ${DEFAULTS.sqlite.mainBusyTimeoutMs}; BEGIN`);
    assertSchema(db, params.agentId);
    const transcripts = new AgentTranscriptReader(db, params.agentId);
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
        COUNT(active.event_seq) AS activeEventCount,
        ${transcripts.coldSql("window.session_id")} AS cold
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
    `).all(...params.chatTypes) as WindowRow[];
    const fingerprints = new Map<string, string>();
    const events = new Map<string, EventRows>();
    const changed = new Set<string>();
    const unavailable = new Set<string>();
    for (const window of windows) {
      const metadata = windowMetadata(window);
      const previous = params.previousManifest.sessions[window.sessionId];
      const documentPath = sessionDocumentPath(metadata);
      const sourceFingerprint = JSON.stringify(window);
      fingerprints.set(window.sessionId, sourceFingerprint);
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
      if (!unchanged) {
        changed.add(window.sessionId);
        if (!params.metadataOnly) {
          try {
            const snapshot = transcripts.read(window.sessionId);
            if (snapshot.kind === "ready") events.set(window.sessionId, snapshot.rows);
            else unavailable.add(window.sessionId);
          } catch { unavailable.add(window.sessionId); }
        }
      }
    }
    db.exec("COMMIT");
    return { windows, fingerprints, events, changed, unavailable };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may not have started */ }
    throw error;
  } finally {
    db.close();
  }
}

/**
 * Quiet check without opening QMD: proves nothing changed since the last certified sync. Requires a manifest
 * produced by the projected-collection pipeline (a legacy import always reconciles first).
 */
export async function unchangedSessionSync(
  params: ProjectionOptions & { state: Pick<SessionManifestStore, "read"> },
  indexPath: string,
): Promise<SessionSyncResult | undefined> {
  const manifest = params.state.read();
  const currentProjectionKey = projectionKey(params);
  if (!manifest.lastSuccessfulSyncAt || manifest.generation === undefined || manifest.projectionKey !== currentProjectionKey ||
    !manifest.indexSignature || manifest.indexSignature !== sessionIndexSignature(indexPath) ||
    Object.keys(manifest.failedSessions ?? {}).length > 0) return;
  const snapshot = readSnapshot({
    ...params,
    previousManifest: manifest,
    currentProjectionKey,
    force: false,
    metadataOnly: true,
  });
  const ids = new Set(snapshot.windows.map(window => window.sessionId));
  if (snapshot.changed.size || Object.keys(manifest.sessions).some(id => !ids.has(id)) ||
    Object.keys(manifest.ignoredSessions ?? {}).some(id => !ids.has(id))) return;
  return { scanned: ids.size, unchanged: ids.size, updated: 0, removed: 0,
    skipped: 0, failed: 0, embedded: 0, lastSuccessfulSyncAt: manifest.lastSuccessfulSyncAt,
    lastCheckedAt: Date.now(), lastIndexedAt: manifest.lastIndexedAt, skipReason: "no_changes" };
}

export function projectionHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function sessionMetadataByPath(manifest: SessionManifest): Map<string, SessionMetadata> {
  return new Map(Object.values(manifest.sessions).map((session) => [session.documentPath, {
    sessionId: session.sessionId,
    provider: session.provider,
    chatType: session.chatType,
    accountId: session.accountId,
    conversationId: session.conversationId,
    startedAt: session.startedAt,
  }]));
}

type WindowSyncOutcome =
  | { kind: "failed"; session?: IndexedSession }
  | { kind: "unchanged"; session?: IndexedSession; ignoredFingerprint?: string; document?: SessionDocument }
  | { kind: "skipped"; ignoredFingerprint: string; retract?: string }
  | { kind: "updated"; session: IndexedSession; document: SessionDocument; retract?: string };

function retainPreviousSession(
  previous: IndexedSession | undefined,
  previousManifestProjectionKey: string | undefined,
): IndexedSession | undefined {
  if (!previous) return undefined;
  if (previous.projectionKey !== undefined || previousManifestProjectionKey === undefined) {
    return previous;
  }
  return { ...previous, projectionKey: previousManifestProjectionKey };
}

function syncWindow(params: {
  window: WindowRow;
  sourceFingerprint: string;
  previous?: IndexedSession;
  events?: EventRows;
  unavailable: boolean;
  force: boolean;
  agentName: string;
  timezone: string;
  currentProjectionKey: string;
  previousManifestProjectionKey?: string;
  diagnostics: NonNullable<SessionProjectionInput["diagnostics"]>;
}): WindowSyncOutcome {
  const { window, sourceFingerprint, previous, events } = params;
  const metadata = windowMetadata(window);
  const documentPath = assertDocumentPath(sessionDocumentPath(metadata));
  const fail = (): WindowSyncOutcome => ({
    kind: "failed",
    session: retainPreviousSession(previous, params.previousManifestProjectionKey),
  });

  if (params.unavailable) return fail();
  if (events === undefined) {
    return previous
      ? { kind: "unchanged", session: previous }
      : { kind: "unchanged", ignoredFingerprint: sourceFingerprint };
  }
  if (events.length > 0 && (!window.sourceGeneration || window.maxSeq === null)) {
    return fail();
  }

  let projection: ReturnType<typeof projectSessionDocument>;
  try {
    const input: SessionProjectionInput = {
      ...metadata,
      label: window.label ?? undefined,
      agentName: params.agentName,
      timezone: params.timezone,
      events,
      diagnostics: params.diagnostics,
    };
    projection = projectSessionDocument(input);
  } catch {
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
  const document: SessionDocument = { path: documentPath, content, createdAt: startedAt, modifiedAt: startedAt };
  const session: IndexedSession = {
    ...metadata,
    sourceGeneration: window.sourceGeneration!,
    maxSeq: window.maxSeq!,
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

async function certifyIndex(index: SessionIndex): Promise<string | undefined> {
  if (!index.path) return undefined;
  // Capture the signature after indexing, before the readiness check, and require it unchanged after.
  const before = sessionIndexSignature(index.path);
  if (!before || !await index.ready()) return undefined;
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
export async function syncSessionProjections(params: ProjectionOptions & {
  state: SessionManifestStore;
  index: SessionIndex;
  force?: boolean;
  signal?: AbortSignal;
  beforeWrite?: () => void;
  onIndexing?: () => void;
}): Promise<{ result: SessionSyncResult; manifest: SessionManifest }> {
  const { index, signal } = params;
  const guardWrite = () => { params.beforeWrite?.(); signal?.throwIfAborted(); };
  signal?.throwIfAborted();
  const previousManifest = params.state.read();
  for (const session of Object.values(previousManifest.sessions)) assertDocumentPath(session.documentPath);
  const currentProjectionKey = projectionKey(params);
  const generationBefore = await index.generation();
  const reconcile = params.force === true || previousManifest.generation !== generationBefore;
  const snapshot = readSnapshot({
    ...params,
    force: reconcile,
    previousManifest,
    currentProjectionKey,
  });
  const sessions: Record<string, IndexedSession> = {};
  const ignoredSessions: Record<string, string> = {};
  const failedSessions: Record<string, string> = {};
  const counts = { unchanged: 0, updated: 0, removed: 0, skipped: 0, failed: 0 };
  const diagnostics = { internalMessagesCleaned: 0, attachmentsCleaned: 0, attachmentBudgetSkipped: 0 };
  const documents: SessionDocument[] = [];
  const upserts: SessionDocument[] = [];
  const retractions = new Set<string>();
  // A failed window keeps whatever QMD already holds for it, at its previous or current path.
  const failedPaths = new Set<string>();

  for (const window of snapshot.windows) {
    signal?.throwIfAborted();
    const outcome = syncWindow({
      window,
      sourceFingerprint: snapshot.fingerprints.get(window.sessionId)!,
      previous: previousManifest.sessions[window.sessionId],
      events: snapshot.events.get(window.sessionId),
      unavailable: snapshot.unavailable.has(window.sessionId),
      force: params.force === true,
      agentName: params.agentName,
      timezone: params.timezone,
      currentProjectionKey,
      previousManifestProjectionKey: previousManifest.projectionKey,
      diagnostics,
    });
    if (outcome.kind === "failed") {
      counts.failed += 1;
      failedSessions[window.sessionId] = snapshot.fingerprints.get(window.sessionId)!;
      failedPaths.add(sessionDocumentPath(windowMetadata(window)));
      if (outcome.session) sessions[window.sessionId] = outcome.session;
    } else if (outcome.kind === "unchanged") {
      counts.unchanged += 1;
      if (outcome.session) sessions[window.sessionId] = outcome.session;
      else if (outcome.ignoredFingerprint !== undefined) {
        ignoredSessions[window.sessionId] = outcome.ignoredFingerprint;
      }
      if (outcome.document) {
        documents.push(outcome.document);
        // Reconciling cannot trust QMD to hold even content-identical documents.
        if (reconcile) upserts.push(outcome.document);
      }
    } else if (outcome.kind === "skipped") {
      counts.skipped += 1;
      ignoredSessions[window.sessionId] = outcome.ignoredFingerprint;
      if (outcome.retract) { retractions.add(outcome.retract); counts.removed += 1; }
    } else {
      counts.updated += 1;
      sessions[window.sessionId] = outcome.session;
      documents.push(outcome.document);
      upserts.push(outcome.document);
      if (outcome.retract) retractions.add(outcome.retract);
    }
  }

  const liveIds = new Set(snapshot.windows.map(window => window.sessionId));
  for (const [sessionId, session] of Object.entries(previousManifest.sessions)) {
    if (sessions[sessionId] || liveIds.has(sessionId)) continue;
    retractions.add(session.documentPath);
    counts.removed += 1;
  }
  const kept = new Set([...Object.values(sessions).map(session => session.documentPath), ...failedPaths]);
  for (const path of kept) retractions.delete(path);

  signal?.throwIfAborted();
  // Every snapshot window was read, so the desired set is complete: let QMD sweep anything else.
  const replaceAll = reconcile && counts.failed === 0;
  if (reconcile && !replaceAll) {
    // Partial reconcile: sweep true strays explicitly, never a document a failed window may still need.
    for (const document of documents) kept.add(document.path);
    for (const path of await index.activePaths()) if (!kept.has(path)) retractions.add(path);
  }
  const writes = replaceAll || upserts.length > 0 || retractions.size > 0;
  if (writes) params.onIndexing?.();
  let changedDocuments = 0;
  if (replaceAll) {
    guardWrite();
    changedDocuments = await index.replace(documents, signal);
  } else {
    for (const document of upserts) {
      guardWrite();
      if (await index.upsert(document)) changedDocuments += 1;
    }
    for (const path of retractions) {
      guardWrite();
      if (await index.retract(path)) changedDocuments += 1;
    }
  }
  // The index changed since the last certification (or never was): embedding is incremental, so re-check it.
  const needsIndex = reconcile || changedDocuments > 0 || !previousManifest.indexSignature || !index.path ||
    previousManifest.indexSignature !== sessionIndexSignature(index.path) ||
    previousManifest.projectionKey !== currentProjectionKey;
  if (needsIndex && !writes) params.onIndexing?.();
  if (needsIndex) guardWrite(); else signal?.throwIfAborted();
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
  const manifest: SessionManifest = {
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
      scanned: snapshot.windows.length,
      ...counts,
      embedded,
      ...(lastSuccessfulSyncAt !== undefined ? { lastSuccessfulSyncAt } : {}),
      lastCheckedAt: checkedAt,
      lastIndexedAt,
      ...(!needsIndex ? { skipReason: "no_indexable_changes" as const } : {}),
      diagnostics,
    },
    manifest,
  };
}
