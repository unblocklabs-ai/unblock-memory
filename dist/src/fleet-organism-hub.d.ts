import { type IncomingMessage, type ServerResponse } from "node:http";
type HubOptions = {
    dbPath: string;
    /** All-roles fallback: used only for a role (read, ingest, operator) given no role-specific credential. */
    token?: string;
    tokenFile?: string;
    /** Read role: `GET /api/v1/commons` (and `/metrics` when it is private). */
    readToken?: string;
    readTokenFile?: string;
    /** Ingest role: `POST /api/v1/telemetry` and `POST /api/v1/brief` for any node. */
    ingestToken?: string;
    ingestTokenFile?: string;
    /** Per-node ingest tokens (node alias -> token); each is accepted only for snapshots carrying that `nodeId`. */
    ingestTokens?: Readonly<Record<string, string>>;
    /** Operator role: `POST /api/v1/commons`, `GET /api/v1/brief`, `GET /api/v1/ab-leaderboard`. */
    operatorToken?: string;
    operatorTokenFile?: string;
    /** Public by default for Prometheus; false puts /metrics behind the read role. */
    publicMetrics?: boolean;
    /** 0 disables the request body limit. */
    maxBodyBytes?: number;
    /** Extra Commons hygiene terms (client names, codenames) rejected on POST, as in `validateFleetCommonsEntry`. */
    forbiddenTerms?: readonly string[];
    /** Snapshots collected further than this in the future are rejected (default 5 minutes; 0 = no check). */
    maxClockSkewMs?: number;
    /** Telemetry older than this leaves /metrics and the leaderboards (default 48 hours; 0 = never). */
    snapshotTtlMs?: number;
    /** Longest accepted node/agent alias (default 64; 0 = unlimited). */
    maxAliasLength?: number;
    /** Clock override for tests. */
    now?: () => number;
};
/** Returns an unbound Node HTTP server. Call listen() and close() to manage its lifetime. */
export declare function createFleetOrganismHub(options: HubOptions): import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
export {};
