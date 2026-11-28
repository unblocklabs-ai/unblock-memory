import { DatabaseSync } from "node:sqlite";
export declare const MEMORY_DATABASE = "unblock-memory.sqlite";
/** Separate domain stores share settings, not a monolithic data-access API. */
export declare function openMemoryDatabase(path: string, { busyTimeoutMs }?: {
    busyTimeoutMs?: number | undefined;
}): DatabaseSync;
/** Runs synchronous writes atomically; never pass an async callback. */
export declare function immediateTransaction<T>(db: DatabaseSync, fn: () => T): T;
/**
 * Double-checked schema install: `ready()` first runs lock-free (avoiding the write lock on every open),
 * then again under `BEGIN IMMEDIATE` before `install()` runs in that same transaction.
 */
export declare function ensureSchemaUnderWriteLock(db: DatabaseSync, ready: () => boolean, install: () => void): void;
export declare function tableExists(db: DatabaseSync, name: string): boolean;
export declare function readTableColumns(db: DatabaseSync, name: string): ReadonlySet<string>;
/** File existence no longer tells us which feature has initialized its tables. */
export declare function hasMemoryTable(path: string, table: string): boolean;
