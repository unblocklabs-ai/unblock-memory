import type { ChatType } from "./config.js";
import { type SessionMetadata, type SessionProjectionInput } from "./session-projector.js";
export declare const PROJECTOR_VERSION = 6;
type IndexedSession = SessionMetadata & {
    sourceGeneration: string;
    maxSeq: number;
    activeEventCount: number;
    sizeBytes: number;
    projectionHash: string;
    documentPath: string;
    projectorVersion: number;
    sourceFingerprint?: string;
};
export type SessionManifest = {
    version: number;
    lastSuccessfulSyncAt?: number;
    lastIndexedAt?: number;
    projectionKey?: string;
    indexSignature?: string;
    ignoredSessions?: Record<string, string>;
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
    lastCheckedAt?: number;
    lastIndexedAt?: number;
    skipReason?: "no_changes" | "no_indexable_changes";
    diagnostics?: NonNullable<SessionProjectionInput["diagnostics"]>;
};
type ProjectionOptions = {
    databasePath: string;
    outputDir: string;
    manifestPath: string;
    agentId: string;
    agentName: string;
    timezone: string;
    chatTypes: readonly ChatType[];
};
export declare function unchangedSessionSync(params: ProjectionOptions, indexPath: string): Promise<SessionSyncResult | undefined>;
export declare function readSessionManifest(path: string): Promise<SessionManifest>;
export declare function sessionMetadataByPath(manifest: SessionManifest): Map<string, SessionMetadata>;
export declare function syncSessionProjections(params: ProjectionOptions & {
    force?: boolean;
    indexPath?: string;
    indexReady?: () => Promise<boolean>;
    index?: () => Promise<number>;
}): Promise<{
    result: SessionSyncResult;
    manifest: SessionManifest;
}>;
export {};
