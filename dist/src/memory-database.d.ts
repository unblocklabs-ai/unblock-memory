import { DatabaseSync } from "node:sqlite";
export declare const MEMORY_DATABASE = "unblock-memory.sqlite";
/** Separate domain stores share settings, not a monolithic data-access API. */
export declare function openMemoryDatabase(path: string): DatabaseSync;
/** Runs synchronous writes atomically; never pass an async callback. */
export declare function immediateTransaction<T>(db: DatabaseSync, fn: () => T): T;
export declare function tableExists(db: DatabaseSync, name: string): boolean;
/** File existence no longer tells us which feature has initialized its tables. */
export declare function hasMemoryTable(path: string, table: string): boolean;
