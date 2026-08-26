import type { ChatType } from "./config.js";
import { type SessionMetadata } from "./session-projector.js";
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
export declare function readSessionManifest(path: string): Promise<SessionManifest>;
export declare function sessionMetadataByPath(manifest: SessionManifest): Map<string, SessionMetadata>;
export declare function syncSessionProjections(params: {
    databasePath: string;
    outputDir: string;
    manifestPath: string;
    agentId: string;
    agentName: string;
    timezone: string;
    chatTypes: readonly ChatType[];
    force?: boolean;
    index?: () => Promise<number>;
}): Promise<{
    result: SessionSyncResult;
    manifest: SessionManifest;
}>;
export {};
