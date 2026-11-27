import { DatabaseSync } from "node:sqlite";
import type { SessionMetadata, SessionMessageSpan } from "./session-projector.js";
import type { SessionSyncResult } from "./session-sync.js";
export type IndexedSession = SessionMetadata & {
    sourceGeneration: string;
    maxSeq: number;
    activeEventCount: number;
    sizeBytes: number;
    projectionHash: string;
    documentPath: string;
    projectorVersion: number;
    projectionKey?: string;
    sourceFingerprint?: string;
    messages?: SessionMessageSpan[];
};
export type SessionManifest = {
    version: number;
    lastSuccessfulSyncAt?: number;
    lastIndexedAt?: number;
    projectionKey?: string;
    indexSignature?: string;
    /** QMD projected-collection generation this manifest exactly describes (absent: reconcile on next sync). */
    generation?: number;
    ignoredSessions?: Record<string, string>;
    failedSessions?: Record<string, string>;
    sessions: Record<string, IndexedSession>;
};
export type SessionSyncReceipt = {
    status: "running";
    phase: "queued" | "projecting" | "indexing";
    startedAt: string;
    attempt: number;
} | ({
    status: "completed";
    startedAt: string;
    completedAt: string;
} & SessionSyncResult) | {
    status: "failed";
    startedAt: string;
    completedAt: string;
    error: string;
};
/**
 * Per-agent session manifest and sync receipt on a caller-owned `unblock-memory.sqlite` connection.
 * Writes are single statements, so callers may wrap them in a WorkStore fence (`withFence`/`commitWithDomain`).
 */
export declare class SessionSyncState {
    #private;
    constructor(db: DatabaseSync, agentId: string, legacyDir?: string);
    /** Bumps on every manifest write; 0 before the first manifest exists. */
    revision(): number;
    readManifest(): SessionManifest;
    writeManifest(manifest: SessionManifest): void;
    readReceipt(): SessionSyncReceipt | undefined;
    writeReceipt(receipt: SessionSyncReceipt): void;
    /** Replace a dead attempt's running receipt, unless a newer receipt already superseded it. */
    interruptReceipt(attempt: number, completedAt: string): SessionSyncReceipt | undefined;
}
/** Read-only manifest snapshot for offline tools (never creates tables in a live database). */
export declare function readSessionManifestSnapshot(databasePath: string, agentId: string, legacyDir?: string): SessionManifest;
/**
 * Best-effort removal of retired sidecars once SQLite owns the manifest: the legacy JSON files, the
 * SQLite/PID lock files, and the private `sessions/**\/*.md` projections (plaintext transcripts).
 */
export declare function removeLegacySessionSyncArtifacts(stateDir: string): string[];
