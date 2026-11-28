import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fchmodSync, openSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { SENTIMENT_DRIFT_METRICS } from "./emotion-baselines.js";
import { validateFleetCommonsEntry, type FleetCommonsEntry, type FleetCommonsHygieneOptions } from "./fleet-commons.js";
import {
  aggregateAbLeaderboard, formatPrometheusMetrics, isFleetAlias, isFleetProposalKind, isFleetRecipeHash, renderFleetMorningBrief,
  type NodeBriefSnapshot, type NodeTelemetrySnapshot,
} from "./fleet-organism.js";
import { isRecord } from "./guards.js";

type Check = (value: unknown) => boolean;
const exact = (value: unknown, fields: Record<string, Check>): boolean =>
  isRecord(value) && Object.keys(value).length === Object.keys(fields).length &&
  Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
const shape = (fields: Record<string, Check>): Check => value => exact(value, fields);
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string";
const nullable = (check: Check): Check => value => value === null || check(value);
const rate = (max: number) => nullable(value => nonnegative(value) && value <= max);
const keyed = (keyCheck: (key: string) => boolean, check: Check): Check => value =>
  isRecord(value) && Object.entries(value).every(([key, entry]) => keyCheck(key) && check(entry));

const outcomeFields = {
  total: count, helped: count, ignored: count, hurt: count,
  whisperUsedRate: rate(1), skillOpenRate: rate(1), shortfallsPer100Turns: rate(100),
};
const recipe = shape({
  ...outcomeFields, denominators: shape({ deliveredMemoryHits: count, suggestedSkills: count, turns: count }),
});
const expectation = shape({ kind: text, summary: text, dueAtMs: count });
const driftMetric = (value: unknown) => SENTIMENT_DRIFT_METRICS.some(metric => metric === value);

/** Exact wire shapes; aliases are capped at `maxAliasLength` (0 = unlimited). */
function snapshotValidators(maxAliasLength: number) {
  const alias = (value: unknown) => isFleetAlias(value, maxAliasLength);
  const identity = { schemaVersion: (value: unknown) => value === 1, nodeId: alias, agentId: alias, collectedAtMs: count };
  return {
    telemetry: (value: unknown): value is NodeTelemetrySnapshot => exact(value, {
      ...identity, sinceHours: nonnegative,
      outcomes: shape({ ...outcomeFields, byRecipe: keyed(isFleetRecipeHash, recipe) }),
      crystals: shape({ stm: count, ltm: count, coreMemories: count }),
      expectations: shape({ open: count, kept: count, broken: count, overdue: count }),
      derivedObservations: shape({ fresh: count, stale: count, totalHits: count }),
      skillProposals: shape({ pending: count, byKind: keyed(isFleetProposalKind, count) }),
      sentimentDriftFlaggedCount: count, quarantinedWorkItems: count,
    }),
    brief: (value: unknown): value is NodeBriefSnapshot => exact(value, {
      ...identity, operatorOnly: value => value === true,
      blockers: array(shape({ topic: text, summary: text, capturedAtMs: count })),
      overdueExpectations: array(expectation), dueSoonExpectations: array(expectation),
      sentimentDrift: array(shape({ personId: text, metric: driftMetric, reason: text })),
      skillProposals: array(shape({ kind: text, skillName: text, title: text, recallGainPp: nullable(finite) })),
      quarantinedWorkItems: array(shape({ kind: text, scope: text, strikes: count, lastError: nullable(text) })),
    }),
  };
}

/**
 * Wire contract: POST one `FleetCommonsEntry` (the exact shape `syncFleetCommons` consumes), optionally with
 * `status: "retired"` to withdraw it. Hygiene is `validateFleetCommonsEntry`, the same check every node re-runs on sync.
 * A revision is immutable and retirement is one-way: re-posting the identical revision is idempotent, retiring it is
 * allowed, but reactivating it or changing its content needs a new revision.
 */
type CommonsPost = { entry: FleetCommonsEntry; status: "active" | "retired" } | { reasons: string[] };

function commonsPost(value: unknown, hygiene: FleetCommonsHygieneOptions): CommonsPost {
  if (!isRecord(value)) return { reasons: ["entry must be an object"] };
  const { status = "active", ...entry } = value;
  if (status !== "active" && status !== "retired") return { reasons: ["invalid status"] };
  const checked = validateFleetCommonsEntry(entry, hygiene);
  return checked.ok ? { entry: checked.entry, status } : { reasons: checked.reasons };
}

function send(response: ServerResponse, status: number, value: string, type: string) {
  response.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff" });
  response.end(value);
}

function json(response: ServerResponse, status: number, value: unknown) {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

class InvalidBody extends Error {
  constructor(readonly status: 400 | 413) { super("Invalid request body"); }
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (maxBodyBytes && size > maxBodyBytes) {
      request.resume();
      throw new InvalidBody(413);
    }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new InvalidBody(400); }
}

/** Requiring a JSON media type keeps POSTs out of reach of simple (no-preflight) cross-origin browser forms. */
const isJsonRequest = (request: IncomingMessage) =>
  request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() === "application/json";

/** Key-order-independent JSON, so a revision's identity survives re-serialization. */
const canonical = (value: unknown) => JSON.stringify(value, (_key, inner: unknown) => isRecord(inner)
  ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : inner);

function etagMatches(header: string | undefined, tag: string): boolean {
  return header?.split(",").some(value => {
    const trimmed = value.trim();
    return trimmed === "*" || trimmed.replace(/^W\//u, "") === tag;
  }) ?? false;
}

type HubOptions = FleetCommonsHygieneOptions & {
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
  /** Snapshots collected further than this in the future are rejected (default 5 minutes; 0 = no check). */
  maxClockSkewMs?: number;
  /** Snapshots older than this leave metrics, leaderboards and briefs (default 48 hours; 0 = never). */
  snapshotTtlMs?: number;
  /** Longest accepted node/agent alias (default 64; 0 = unlimited). */
  maxAliasLength?: number;
  /** Clock override for tests. */
  now?: () => number;
};

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new RangeError(`Invalid ${name}`);
  return resolved;
}

function secret(value: string | undefined, file: string | undefined, name: string): string | undefined {
  if (value === undefined && file === undefined) return undefined;
  const resolved = (value ?? readFileSync(file!, "utf8")).trim();
  if (!resolved) throw new Error(`Empty fleet hub ${name}`);
  if (/[^\x21-\x7e]/u.test(resolved)) throw new Error(`Invalid fleet hub ${name}: expected a single bearer token`);
  return resolved;
}

type Credential = { digest: Buffer; nodeId?: string };

function openHubDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    // The DB may contain private briefs. Use owner-only permissions and refuse symlinks.
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try { fchmodSync(fd, 0o600); }
    finally { closeSync(fd); }
  }
  return new DatabaseSync(path);
}

/** Returns an unbound Node HTTP server. Call listen() and close() to manage its lifetime. */
export function createFleetOrganismHub(options: HubOptions) {
  const maxBodyBytes = nonNegativeInteger(options.maxBodyBytes, 1_048_576, "maxBodyBytes");
  const maxClockSkewMs = nonNegativeInteger(options.maxClockSkewMs, 5 * 60_000, "maxClockSkewMs");
  const snapshotTtlMs = nonNegativeInteger(options.snapshotTtlMs, 48 * 3_600_000, "snapshotTtlMs");
  const maxAliasLength = nonNegativeInteger(options.maxAliasLength, 64, "maxAliasLength");
  const now = options.now ?? Date.now;
  const hygiene: FleetCommonsHygieneOptions = {
    forbiddenTerms: options.forbiddenTerms,
    maxTitleChars: options.maxTitleChars === undefined ? undefined : nonNegativeInteger(options.maxTitleChars, 0, "maxTitleChars"),
    maxBodyChars: options.maxBodyChars === undefined ? undefined : nonNegativeInteger(options.maxBodyChars, 0, "maxBodyChars"),
  };
  const digest = (data: string) => createHash("sha256").update(data).digest();
  const credential = (token: string | undefined, nodeId?: string): Credential[] =>
    token ? [{ digest: digest(token), ...(nodeId === undefined ? {} : { nodeId }) }] : [];

  const fallback = secret(options.token, options.tokenFile, "token");
  const perNode = Object.entries(options.ingestTokens ?? {}).flatMap(([nodeId, token]) => {
    if (!isFleetAlias(nodeId, maxAliasLength)) throw new TypeError("Invalid ingestTokens node alias");
    return credential(secret(token, undefined, `ingest token for ${nodeId}`), nodeId);
  });
  const ingestShared = secret(options.ingestToken, options.ingestTokenFile, "ingest token");
  const roles = {
    read: credential(secret(options.readToken, options.readTokenFile, "read token") ?? fallback),
    ingest: [...credential(ingestShared ?? (perNode.length ? undefined : fallback)), ...perNode],
    operator: credential(secret(options.operatorToken, options.operatorTokenFile, "operator token") ?? fallback),
  };
  if (options.ingestTokens !== undefined && !roles.ingest.length) throw new Error("Empty fleet hub ingestTokens without an ingest token");
  if (options.publicMetrics === false && !roles.read.length) throw new Error("Private fleet hub metrics require a read token");
  const loopbackOnly = Object.values(roles).some(role => !role.length);
  /** A role with no credential is open (loopback development); otherwise the bearer's matching credentials. */
  const open: Credential[] = [{ digest: Buffer.alloc(0) }];
  const authorize = (role: keyof typeof roles, header?: string): Credential[] | undefined => {
    const accepted = roles[role];
    if (!accepted.length) return open;
    const bearer = /^Bearer ([^\s]+)$/iu.exec(header ?? "")?.[1];
    const presented = digest(bearer ?? "");
    const matches = accepted.filter(candidate => timingSafeEqual(candidate.digest, presented));
    return bearer !== undefined && matches.length ? matches : undefined;
  };
  const { telemetry, brief } = snapshotValidators(maxAliasLength);

  const db = openHubDatabase(options.dbPath);
  try {
    for (const table of ["hub_telemetry", "hub_briefs"] as const) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        node_id TEXT NOT NULL, agent_id TEXT NOT NULL, collected_at_ms INTEGER NOT NULL,
        snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), PRIMARY KEY (node_id, agent_id)
      ) STRICT;`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS hub_commons_entries (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','retired')),
      entry TEXT NOT NULL CHECK(json_valid(entry))
    ) STRICT;`);

    function snapshotTable<T extends NodeTelemetrySnapshot | NodeBriefSnapshot>(
      table: "hub_telemetry" | "hub_briefs", valid: (value: unknown) => value is T,
    ) {
      const upsert = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?)
        ON CONFLICT(node_id,agent_id) DO UPDATE SET collected_at_ms=excluded.collected_at_ms,snapshot=excluded.snapshot
        WHERE excluded.collected_at_ms>=${table}.collected_at_ms`);
      const select = db.prepare(`SELECT snapshot FROM ${table} WHERE collected_at_ms>=? ORDER BY node_id,agent_id`);
      return {
        valid,
        /** False when a newer snapshot for the same node/agent is already stored. */
        put(value: T): boolean {
          return upsert.run(value.nodeId, value.agentId, value.collectedAtMs, JSON.stringify(value)).changes > 0;
        },
        /** Rows that no longer pass the current wire contract (e.g. a lowered alias cap) are never served. */
        list(sinceMs = Number.MIN_SAFE_INTEGER): T[] {
          return select.all(sinceMs).flatMap(row => {
            const value: unknown = JSON.parse(String(row.snapshot));
            return valid(value) ? [value] : [];
          });
        },
      };
    }
    const telemetryStore = snapshotTable("hub_telemetry", telemetry);
    const briefStore = snapshotTable("hub_briefs", brief);
    const snapshotCutoff = () => snapshotTtlMs ? now() - snapshotTtlMs : undefined;
    const liveTelemetry = () => telemetryStore.list(snapshotCutoff());
    const readCommons = db.prepare("SELECT revision,status,entry FROM hub_commons_entries WHERE id=?");
    const writeCommons = db.prepare(`INSERT INTO hub_commons_entries VALUES (?, ?, ?, ?) ON CONFLICT(id)
      DO UPDATE SET revision=excluded.revision,status=excluded.status,entry=excluded.entry`);
    const activeCommons = db.prepare("SELECT entry FROM hub_commons_entries WHERE status='active' ORDER BY id");
    const nodeCount = db.prepare("SELECT count(*) n FROM (SELECT node_id FROM hub_telemetry UNION SELECT node_id FROM hub_briefs)");
    const commonsCount = db.prepare("SELECT count(*) n FROM hub_commons_entries WHERE status='active'");

    /** Revisions never go backwards, are immutable once stored, and retire one way. Returns a conflict message or undefined. */
    function commonsConflict(entry: FleetCommonsEntry, status: "active" | "retired"): string | undefined {
      const stored = readCommons.get(entry.id);
      if (!stored || entry.revision > Number(stored.revision)) return undefined;
      if (entry.revision < Number(stored.revision)) return "Stale Commons revision";
      if (canonical(JSON.parse(String(stored.entry))) !== canonical(entry)) {
        return "Commons revision content is immutable; post a new revision";
      }
      if (stored.status === "retired" && status === "active") return "Commons retirement is one-way; post a new revision to reactivate";
      return undefined;
    }

    function putCommons(entry: FleetCommonsEntry, status: "active" | "retired"): string | undefined {
      db.exec("BEGIN IMMEDIATE");
      try {
        const conflict = commonsConflict(entry, status);
        if (!conflict) writeCommons.run(entry.id, entry.revision, status, JSON.stringify(entry));
        db.exec("COMMIT");
        return conflict;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    function ingest<T extends NodeTelemetrySnapshot | NodeBriefSnapshot>(
      store: ReturnType<typeof snapshotTable<T>>, body: unknown, credentials: readonly Credential[], response: ServerResponse,
    ) {
      if (!store.valid(body)) return json(response, 400, { error: "Invalid snapshot" });
      // A per-node ingest token only speaks for its own node; a shared ingest token speaks for any node.
      if (!credentials.some(match => match.nodeId === undefined || match.nodeId === body.nodeId)) {
        return json(response, 403, { error: "Ingest token is not bound to this nodeId" });
      }
      if (maxClockSkewMs && body.collectedAtMs > now() + maxClockSkewMs) {
        return json(response, 400, { error: "Snapshot collectedAtMs is in the future" });
      }
      return store.put(body) ? json(response, 200, { ok: true })
        : json(response, 409, { error: "A newer snapshot for this node and agent is already stored" });
    }

    const ROUTES: Record<string, keyof typeof roles> = {
      "GET /api/v1/commons": "read",
      "POST /api/v1/telemetry": "ingest", "POST /api/v1/brief": "ingest",
      "POST /api/v1/commons": "operator", "GET /api/v1/brief": "operator", "GET /api/v1/ab-leaderboard": "operator",
    };

    async function route(request: IncomingMessage, response: ServerResponse) {
      const hosts = request.headersDistinct.host;
      if (loopbackOnly && (hosts?.length !== 1 || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/iu.test(hosts[0] ?? ""))) {
        return json(response, 403, { error: "Loopback Host required when any role has no token" });
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const { pathname } = url;
      if (request.method === "GET" && pathname === "/healthz") {
        return json(response, 200, { ok: true, nodes: nodeCount.get()?.n, commonsEntries: commonsCount.get()?.n });
      }
      const metricsRequest = request.method === "GET" && pathname === "/metrics";
      const role = metricsRequest ? options.publicMetrics === false ? "read" : undefined : ROUTES[`${request.method} ${pathname}`];
      if (!metricsRequest && !role) return json(response, 404, { error: "Not found" });
      const credentials = role ? authorize(role, request.headers.authorization) : [];
      if (!credentials) {
        response.setHeader("WWW-Authenticate", "Bearer");
        return json(response, 401, { error: "Unauthorized" });
      }
      if (metricsRequest) {
        return send(response, 200, formatPrometheusMetrics(liveTelemetry()), "text/plain; version=0.0.4; charset=utf-8");
      }
      if (pathname === "/api/v1/brief") response.setHeader("Cache-Control", "no-store");
      if (request.method === "POST") {
        if (!isJsonRequest(request)) return json(response, 415, { error: "Content-Type must be application/json" });
        const body = await readJson(request, maxBodyBytes);
        if (pathname === "/api/v1/commons") {
          const posted = commonsPost(body, hygiene);
          if ("reasons" in posted) return json(response, 400, { error: "Invalid Commons entry", reasons: posted.reasons });
          const conflict = putCommons(posted.entry, posted.status);
          return conflict ? json(response, 409, { error: conflict }) : json(response, 200, { ok: true });
        }
        return pathname === "/api/v1/telemetry"
          ? ingest(telemetryStore, body, credentials, response) : ingest(briefStore, body, credentials, response);
      }
      switch (pathname) {
        case "/api/v1/ab-leaderboard": return json(response, 200, aggregateAbLeaderboard(liveTelemetry()));
        case "/api/v1/brief": {
          const format = url.searchParams.get("format") ?? "json";
          if (format !== "json" && format !== "markdown") return json(response, 400, { error: "Invalid brief format" });
          const cutoff = snapshotCutoff();
          const briefs = briefStore.list(cutoff), telemetry = telemetryStore.list(cutoff);
          if (format === "markdown") return send(response, 200, renderFleetMorningBrief(briefs, telemetry), "text/markdown; charset=utf-8");
          return json(response, 200, { operatorOnly: true, briefs, leaderboard: aggregateAbLeaderboard(telemetry) });
        }
        default: {
          const entries = activeCommons.all().flatMap(row => {
            const checked = validateFleetCommonsEntry(JSON.parse(String(row.entry)), hygiene);
            return checked.ok ? [checked.entry] : [];
          });
          const body = JSON.stringify({ entries });
          const tag = `"${digest(body).toString("hex")}"`;
          response.setHeader("ETag", tag);
          response.setHeader("Cache-Control", "private, no-cache");
          if (etagMatches(request.headers["if-none-match"], tag)) {
            response.writeHead(304).end();
            return;
          }
          return send(response, 200, body, "application/json; charset=utf-8");
        }
      }
    }

    const server = createServer({ requireHostHeader: !loopbackOnly }, (request, response) => {
      void route(request, response).catch(error => {
        if (response.destroyed) return;
        if (response.headersSent) { response.destroy(); return; }
        if (error instanceof InvalidBody) {
          if (error.status === 413) response.setHeader("Connection", "close");
          json(response, error.status, { error: error.status === 413 ? "Request body too large" : "Invalid JSON" });
        } else {
          json(response, 500, { error: "Internal server error" });
        }
      });
    });
    server.once("close", () => db.close());
    return server;
  } catch (error) {
    db.close();
    throw error;
  }
}
