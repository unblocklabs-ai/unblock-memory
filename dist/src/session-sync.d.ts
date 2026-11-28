import type { ChatType } from "./config.js";
import { type SessionMetadata, type SessionProjectionInput } from "./session-projector.js";
import type { SessionManifest } from "./session-sync-state.js";
export declare const PROJECTOR_VERSION = 9;
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
type ProjectionOptions = {
    databasePath: string;
    agentId: string;
    agentName: string;
    timezone: string;
    chatTypes: readonly ChatType[];
    syntheticInput?: SessionProjectionInput["syntheticInput"];
};
/** A projected session document: QMD stores it directly; nothing is written to disk. */
type SessionDocument = {
    path: string;
    content: string;
    createdAt: string;
    modifiedAt: string;
};
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
export type SessionManifestStore = {
    read(): SessionManifest;
    write(manifest: SessionManifest): void;
};
/**
 * Quiet check without opening QMD: proves nothing changed since the last certified sync. Requires a manifest
 * produced by the projected-collection pipeline (a legacy import always reconciles first).
 */
export declare function unchangedSessionSync(params: ProjectionOptions & {
    state: Pick<SessionManifestStore, "read">;
}, indexPath: string): Promise<SessionSyncResult | undefined>;
export declare function projectionHash(content: string): string;
export declare function sessionMetadataByPath(manifest: SessionManifest): Map<string, SessionMetadata>;
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
export declare function syncSessionProjections(params: ProjectionOptions & {
    state: SessionManifestStore;
    index: SessionIndex;
    force?: boolean;
    signal?: AbortSignal;
    beforeWrite?: () => void;
    onIndexing?: () => void;
}): Promise<{
    result: SessionSyncResult;
    manifest: SessionManifest;
}>;
export {};
