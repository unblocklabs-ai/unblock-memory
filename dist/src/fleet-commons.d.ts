import type { QMDStore } from "@unblocklabs/qmd";
import { DatabaseSync } from "node:sqlite";
import type { CorpusMemorySearchResult } from "./contracts.js";
export declare const FLEET_COMMONS_COLLECTION = "unblock-fleet";
export declare const FLEET_COMMONS_PREFIX = "qmd://unblock-fleet/";
declare const FLEET_COMMONS_CATEGORIES: readonly ["tool_pitfall", "api_workaround", "platform_outage", "procedure"];
declare const FLEET_COMMONS_SEVERITIES: readonly ["info", "warn", "critical"];
type FleetCommonsCategory = typeof FLEET_COMMONS_CATEGORIES[number];
type FleetCommonsSeverity = typeof FLEET_COMMONS_SEVERITIES[number];
export type FleetCommonsEntry = {
    id: string;
    revision: number;
    category: FleetCommonsCategory;
    title: string;
    body: string;
    tags: string[];
    severity: FleetCommonsSeverity;
    updatedAt: number;
    expiresAt?: number | null;
    source?: string;
};
export type FleetCommonsConfig = {
    enabled: boolean;
    endpoint?: string;
    feedPath?: string;
    apiKey?: string;
    apiKeyFile?: string;
    syncIntervalMinutes: number;
    timeoutMs: number;
    maxEntries: number;
    /** Feed bytes read before JSON parsing; a larger feed fails the sync and keeps the last good cache. `0` = unlimited. */
    maxFeedBytes: number;
    allowExpired: boolean;
};
export declare function resolveFleetCommonsConfig(value?: unknown): FleetCommonsConfig;
/** The publisher must sanitize its feed. Local patterns cannot recognize arbitrary names in prose. */
export type FleetCommonsHygieneOptions = {
    forbiddenTerms?: readonly string[];
};
export type FleetCommonsValidation = {
    ok: true;
    entry: FleetCommonsEntry;
} | {
    ok: false;
    reasons: string[];
};
export declare function validateFleetCommonsEntry(value: unknown, options?: FleetCommonsHygieneOptions): FleetCommonsValidation;
export declare function readFleetCommonsEntries(storePath: string): FleetCommonsEntry[];
export declare function getFleetCommonsEntry(storePath: string, id: string, revision?: number): FleetCommonsEntry | undefined;
export type FleetCommonsSummary = {
    count: number;
    lastSyncAt?: number;
    feedDigest?: string;
};
export declare function summarizeFleetCommons(storePath: string): FleetCommonsSummary;
export declare function fleetCommonsPath(entry: FleetCommonsEntry): string;
export declare function fleetCommonsUri(entry: FleetCommonsEntry): string;
/** The exact `memory_get` document for an entry: title, blank line, body, then provenance. Hit line numbers index it. */
export declare function fleetCommonsDocument(entry: FleetCommonsEntry): string;
/**
 * A search hit over `entry`. The whole body when it fits `maxSnippetChars` (or no budget is set); otherwise the matched
 * passage, bounded to the budget, so long entries are never dropped. Lines are those of `fleetCommonsDocument`.
 */
export declare function fleetCommonsHit(entry: FleetCommonsEntry, score: number, maxSnippetChars?: number, passage?: {
    text: string;
    start: number;
}): CorpusMemorySearchResult;
/**
 * A long-lived read-only view of the cache for search and reads: rows are re-read only after some connection commits
 * (`PRAGMA data_version`), and expiry is checked in memory, so a search never reopens SQLite.
 */
export declare class FleetCommonsReader {
    #private;
    constructor(path: string);
    /** Cached entries servable at `nowMs` (expired ones drop out between syncs unless `allowExpired`). */
    current(allowExpired: boolean, nowMs?: number): FleetCommonsEntry[];
    close(): void;
}
/**
 * Whether every Fleet Commons entry cited in `sources` is still cached at that revision and unexpired at `nowMs` (unless
 * the last sync ran with `allowExpired`). Expiry never moves a collection generation, so cached syntheses check this too.
 */
export declare function fleetCitationsActive(db: DatabaseSync, sources: readonly string[], nowMs: number): boolean;
type FleetCommonsProjectionStore = Pick<QMDStore, "syncProjectedCollection"> & Partial<Pick<QMDStore, "listCollections">>;
export type FleetCommonsSyncOptions = FleetCommonsHygieneOptions & {
    config: FleetCommonsConfig;
    storePath: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
} & ({
    store: FleetCommonsProjectionStore;
} | {
    /**
     * Runs only the SQLite replace and QMD projection (e.g. inside a manager's write queue). The feed fetch and its
     * validation complete before `commit` is called, so a slow feed never holds the caller's queue.
     */
    commit: (apply: (store: FleetCommonsProjectionStore) => Promise<FleetCommonsSyncResult>) => Promise<FleetCommonsSyncResult>;
});
export type FleetCommonsSyncResult = {
    status: "disabled";
} | {
    status: "synced" | "not_modified";
    count: number;
    changed: boolean;
    rejected: Array<{
        id: string;
        reasons: string[];
    }>;
};
/** The caller owns scheduling and the projected QMD store; serialize syncs for each cache within this process. */
export declare function syncFleetCommons(options: FleetCommonsSyncOptions): Promise<FleetCommonsSyncResult>;
export {};
