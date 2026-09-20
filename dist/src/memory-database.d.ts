import { DatabaseSync } from "node:sqlite";
export declare const MEMORY_DATABASE = "unblock-memory.sqlite";
/** Separate domain stores share settings, not a monolithic data-access API. */
export declare function openMemoryDatabase(path: string): DatabaseSync;
/** File existence no longer tells us which feature has initialized its tables. */
export declare function hasMemoryTable(path: string, table: string): boolean;
