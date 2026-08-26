import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatType } from "./config.js";
import {
  projectSession,
  sessionDocumentPath,
  type SessionMetadata,
  type SessionProjectionInput,
} from "./session-projector.js";

const MANIFEST_VERSION = 1;
const PROJECTOR_VERSION = 2;
const SUPPORTED_SCHEMA_VERSION = 17;

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

type IndexedSession = SessionMetadata & {
  sourceGeneration: string;
  maxSeq: number;
  activeEventCount: number;
  sizeBytes: number;
  projectionHash: string;
  documentPath: string;
  projectorVersion: number;
};

export type SessionManifest = {
  version: number;
  lastSuccessfulSyncAt?: number;
  sessions: Record<string, IndexedSession>;
};

export type SessionSyncResult = {
  scanned: number;
  unchanged: number;
  updated: number;
  removed: number;
  skipped: number;
  failed: number;
  embedded: number;
  lastSuccessfulSyncAt: number;
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
};

type EventRow = { sessionId: string; eventJson: string; createdAt: number };

function projectionPath(outputDir: string, documentPath: string): string {
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

function assertSchema(db: DatabaseSync, expectedAgentId: string): void {
  const pragma = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  if (pragma?.user_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `unsupported OpenClaw agent database schema: expected ${SUPPORTED_SCHEMA_VERSION}, ` +
      `found ${String(pragma?.user_version ?? "unknown")}`,
    );
  }
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name));
    const missing = required.find((column) => !columns.has(column));
    if (missing) throw new Error(`unsupported OpenClaw agent database: missing ${table}.${missing}`);
  }
  const meta = db.prepare(
    "SELECT role, schema_version AS schemaVersion, agent_id AS agentId " +
    "FROM schema_meta WHERE meta_key = 'primary' LIMIT 1",
  ).get() as { role?: unknown; schemaVersion?: unknown; agentId?: unknown } | undefined;
  if (meta?.role !== "agent" || meta.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error("unsupported OpenClaw agent database primary schema metadata");
  }
  if (meta.agentId !== expectedAgentId) {
    throw new Error(`OpenClaw agent database belongs to ${String(meta.agentId)}, not ${expectedAgentId}`);
  }
}

function readSnapshot(params: {
  databasePath: string;
  agentId: string;
  chatTypes: readonly ChatType[];
  force: boolean;
  outputDir: string;
  previousManifest: SessionManifest;
}): { windows: WindowRow[]; events: Map<string, EventRow[]> } {
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
    `).all(...params.chatTypes) as WindowRow[];
    const readEvents = db.prepare(`
      SELECT active.session_id AS sessionId, event.event_json AS eventJson,
             event.created_at AS createdAt
      FROM session_transcript_active_events AS active
      JOIN transcript_events AS event
        ON event.session_id = active.session_id AND event.seq = active.event_seq
      WHERE active.session_id = ?
      ORDER BY active.active_position
    `);
    const events = new Map<string, EventRow[]>();
    for (const window of windows) {
      const metadata: SessionMetadata = {
        sessionId: window.sessionId,
        provider: window.provider ?? undefined,
        chatType: window.chatType,
        accountId: window.accountId ?? undefined,
        conversationId: window.conversationId ?? undefined,
        startedAt: window.startedAt,
      };
      const previous = params.previousManifest.sessions[window.sessionId];
      const documentPath = sessionDocumentPath(metadata);
      const unchanged = !params.force &&
        previous?.sourceGeneration === window.sourceGeneration &&
        previous.maxSeq === (window.maxSeq ?? 0) &&
        previous.projectorVersion === PROJECTOR_VERSION &&
        previous.documentPath === documentPath &&
        existsSync(projectionPath(params.outputDir, documentPath));
      if (!unchanged) {
        events.set(window.sessionId, readEvents.all(window.sessionId) as EventRow[]);
      }
    }
    db.exec("COMMIT");
    return { windows, events };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may not have started */ }
    throw error;
  } finally {
    db.close();
  }
}

function emptyManifest(): SessionManifest {
  return { version: MANIFEST_VERSION, sessions: {} };
}

export async function readSessionManifest(path: string): Promise<SessionManifest> {
  if (!existsSync(path)) return emptyManifest();
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`invalid unblock-memory session manifest: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid unblock-memory session manifest: ${path}`);
  }
  const manifest = value as Partial<SessionManifest>;
  if (manifest.version !== MANIFEST_VERSION || !manifest.sessions ||
    typeof manifest.sessions !== "object" || Array.isArray(manifest.sessions)) {
    throw new Error(`unsupported unblock-memory session manifest: ${path}`);
  }
  return manifest as SessionManifest;
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode });
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function remove(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function projectionHash(content: string): string {
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

export async function syncSessionProjections(params: {
  databasePath: string;
  outputDir: string;
  manifestPath: string;
  agentId: string;
  agentName: string;
  timezone: string;
  chatTypes: readonly ChatType[];
  force?: boolean;
  index?: () => Promise<number>;
}): Promise<{ result: SessionSyncResult; manifest: SessionManifest }> {
  const previousManifest = await readSessionManifest(params.manifestPath);
  const snapshot = readSnapshot({
    ...params,
    force: params.force === true,
    previousManifest,
  });
  const sessions: Record<string, IndexedSession> = {};
  const counts = { unchanged: 0, updated: 0, removed: 0, skipped: 0, failed: 0 };
  await mkdir(params.outputDir, { recursive: true, mode: 0o700 });
  await chmod(params.outputDir, 0o700);

  for (const window of snapshot.windows) {
    const previous = previousManifest.sessions[window.sessionId];
    const events = snapshot.events.get(window.sessionId);
    const metadata: SessionMetadata = {
      sessionId: window.sessionId,
      provider: window.provider ?? undefined,
      chatType: window.chatType,
      accountId: window.accountId ?? undefined,
      conversationId: window.conversationId ?? undefined,
      startedAt: window.startedAt,
    };
    const documentPath = sessionDocumentPath(metadata);
    if (events === undefined) {
      sessions[window.sessionId] = previous!;
      counts.unchanged += 1;
      continue;
    }
    if (events.length > 0 && (!window.sourceGeneration || window.maxSeq === null)) {
      counts.failed += 1;
      if (previous) sessions[window.sessionId] = previous;
      continue;
    }

    let content: string | undefined;
    try {
      const input: SessionProjectionInput = {
        ...metadata,
        label: window.label ?? undefined,
        agentName: params.agentName,
        timezone: params.timezone,
        events,
      };
      content = projectSession(input);
    } catch {
      counts.failed += 1;
      if (previous) sessions[window.sessionId] = previous;
      continue;
    }
    if (!content) {
      counts.skipped += 1;
      if (previous) {
        await remove(projectionPath(params.outputDir, previous.documentPath));
        counts.removed += 1;
      }
      continue;
    }

    const target = projectionPath(params.outputDir, documentPath);
    await atomicWrite(target, content, 0o600);
    await utimes(target, new Date(), new Date(metadata.startedAt));
    if (previous?.documentPath && previous.documentPath !== documentPath) {
      await remove(projectionPath(params.outputDir, previous.documentPath));
    }
    sessions[window.sessionId] = {
      ...metadata,
      sourceGeneration: window.sourceGeneration!,
      maxSeq: window.maxSeq!,
      activeEventCount: window.activeEventCount,
      sizeBytes: Buffer.byteLength(content),
      projectionHash: projectionHash(content),
      documentPath,
      projectorVersion: PROJECTOR_VERSION,
    };
    counts.updated += 1;
  }

  for (const [sessionId, session] of Object.entries(previousManifest.sessions)) {
    if (sessions[sessionId] || snapshot.windows.some((window) => window.sessionId === sessionId)) continue;
    await remove(projectionPath(params.outputDir, session.documentPath));
    counts.removed += 1;
  }

  const embedded = await params.index?.() ?? 0;
  const lastSuccessfulSyncAt = Date.now();
  const manifest: SessionManifest = {
    version: MANIFEST_VERSION,
    lastSuccessfulSyncAt,
    sessions,
  };
  await atomicWrite(params.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return {
    result: {
      scanned: snapshot.windows.length,
      ...counts,
      embedded,
      lastSuccessfulSyncAt,
    },
    manifest,
  };
}
