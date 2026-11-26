import { immediateTransaction, openMemoryDatabase } from "./memory-database.js";
// Loaded by plain-Node workers and offline tools: keep this module (and its imports) free of `openclaw`.
/**
 * Fenced background work: one row per `(kind, scope)`, guarded by a single monotonic integer `attempt`.
 *
 * - `claim()` increments `attempt`; every later write by that worker is fenced on `status='running'` plus
 *   `attempt`, never on wall-clock time, so a clock jump cannot abort a healthy worker. A reclaim, an
 *   `interruptOwner()` and a `requeue()` all bump `attempt`, so a released worker can never write again,
 *   even before anyone reclaims the row.
 * - Strikes count leases that expired without that attempt saving progress (`progressed_attempt < attempt`),
 *   so a staged row whose resumed attempts keep crashing still quarantines. Graceful stops
 *   (`interruptOwner`) and transient failures add none. Only `mode='item'` rows quarantine; `mode='run'`
 *   singletons never do.
 * - `commitWithDomain()` runs the caller's domain write and the work completion in ONE `BEGIN IMMEDIATE`
 *   on ONE connection, so a fenced-out worker can never publish.
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS work_items (
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('run', 'item')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'staged', 'completed', 'quarantined')),
  attempt INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL DEFAULT 0,
  input_revision TEXT,
  recipe_hash TEXT,
  stage TEXT,
  artifact_json TEXT CHECK(artifact_json IS NULL OR json_valid(artifact_json)),
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  strikes INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  progressed_attempt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, scope)
) STRICT;
CREATE INDEX IF NOT EXISTS work_items_due ON work_items(kind, status, due_at);`;
const SCHEMA_VERSION = 1;
const DEFAULT_MAX_STRIKES = 3;
const HEARTBEAT_BUSY_TIMEOUT_MS = 100;
/** `gateway_stop` must never stall on a held write lock: a busy release lets the lease expire instead. */
const INTERRUPT_BUSY_TIMEOUT_MS = 200;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
export class WorkFenceLostError extends Error {
    kind;
    scope;
    attempt;
    constructor(claim, action) {
        super(`Work fence lost for ${claim.kind}/${claim.scope} attempt ${claim.attempt} during ${action}`);
        this.name = "WorkFenceLostError";
        this.kind = claim.kind;
        this.scope = claim.scope;
        this.attempt = claim.attempt;
    }
}
/** Transient lock contention: the caller may simply try again later. */
export function isSqliteBusy(error) {
    if (!(error instanceof Error) || !("errcode" in error))
        return false;
    // Extended result codes keep the primary code in the low byte.
    const code = Number(error.errcode) & 0xff;
    return code === SQLITE_BUSY || code === SQLITE_LOCKED;
}
function text(value) { return value === null || value === undefined ? null : String(value); }
function item(row) {
    return {
        kind: String(row.kind), scope: String(row.scope), mode: row.mode, status: row.status,
        attempt: Number(row.attempt), owner: text(row.owner), leaseUntil: Number(row.lease_until), dueAt: Number(row.due_at),
        inputRevision: text(row.input_revision), recipeHash: text(row.recipe_hash), stage: text(row.stage),
        artifactJson: text(row.artifact_json), usageJson: text(row.usage_json), strikes: Number(row.strikes),
        lastError: text(row.last_error), updatedAt: Number(row.updated_at), progressedAttempt: Number(row.progressed_attempt ?? 0),
    };
}
function requireJson(value, field) {
    if (value === null || value === undefined)
        return;
    try {
        JSON.parse(value);
    }
    catch {
        throw new Error(`WorkStore ${field} must be valid JSON`);
    }
}
function requireDuration(value, field) {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`WorkStore ${field} must be a positive integer`);
}
function ensureWorkSchema(db) {
    const read = () => db.prepare("SELECT version FROM memory_schema WHERE component='work'").get()?.version;
    // Additive columns keep schema v1 so a rollback still opens the store.
    const hasProgress = () => db.prepare("PRAGMA table_info(work_items)").all().some(row => row.name === "progressed_attempt");
    const ready = (version) => {
        if (version !== undefined && version !== SCHEMA_VERSION)
            throw new Error("Unsupported work store schema version");
        return version === SCHEMA_VERSION && Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='work_items'").get()) &&
            hasProgress();
    };
    // Fast path avoids taking the write lock on every open.
    if (ready(read()))
        return;
    immediateTransaction(db, () => {
        if (ready(read()))
            return;
        db.exec(SCHEMA);
        if (!hasProgress())
            db.exec("ALTER TABLE work_items ADD COLUMN progressed_attempt INTEGER NOT NULL DEFAULT 0");
        db.prepare("INSERT OR IGNORE INTO memory_schema VALUES ('work',?)").run(SCHEMA_VERSION);
    });
}
export class WorkStore {
    db;
    #owned;
    /**
     * Pass an already-open `DatabaseSync` to commit domain writes and work transitions on the exact same
     * connection (required for `commitWithDomain` atomicity), or a path to open a dedicated connection.
     */
    constructor(database, options = {}) {
        this.#owned = typeof database === "string";
        this.db = typeof database === "string"
            ? openMemoryDatabase(database, options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs })
            : database;
        try {
            ensureWorkSchema(this.db);
        }
        catch (error) {
            if (this.#owned)
                this.db.close();
            throw error;
        }
    }
    close() { if (this.#owned)
        this.db.close(); }
    /**
     * Insert a row, or reset it only when its input revision or recipe changed. Resetting supersedes any
     * in-flight attempt: its fenced writes fail because the row is no longer `running`.
     */
    enqueue(options) {
        const now = options.now ?? Date.now();
        const revision = options.inputRevision ?? null, recipe = options.recipeHash ?? null;
        return Number(this.db.prepare(`INSERT INTO work_items
        (kind,scope,mode,status,due_at,input_revision,recipe_hash,updated_at) VALUES (?,?,?,'pending',?,?,?,?)
      ON CONFLICT(kind,scope) DO UPDATE SET
        mode=excluded.mode, status='pending', owner=NULL, lease_until=0, due_at=excluded.due_at,
        input_revision=excluded.input_revision, recipe_hash=excluded.recipe_hash,
        stage=NULL, artifact_json=NULL, strikes=0, last_error=NULL, updated_at=excluded.updated_at
      WHERE work_items.input_revision IS NOT excluded.input_revision OR work_items.recipe_hash IS NOT excluded.recipe_hash`)
            .run(options.kind, options.scope, options.mode, options.dueAt ?? 0, revision, recipe, now).changes) > 0;
    }
    /**
     * Reclaim expired leases, then claim the earliest due `pending`/`staged` row (or the given `scope`).
     * `ignoreDueAt` lets an explicit operator run start before the schedule; it never steals a live lease.
     * `expectedInputRevision`/`expectedRecipeHash` refuse a row whose inputs advanced since the caller read them.
     */
    claim(options) {
        requireDuration(options.leaseMs, "leaseMs");
        if (!options.owner)
            throw new Error("WorkStore owner is required");
        const now = options.now ?? Date.now(), maxStrikes = options.maxStrikes ?? DEFAULT_MAX_STRIKES;
        const scope = options.scope ?? null, mode = options.mode ?? null;
        return immediateTransaction(this.db, () => {
            // A strike means the expired attempt saved no progress of its own (a resumed crash counts too).
            // Released artifacts stay resumable as 'staged'.
            this.db.prepare(`UPDATE work_items SET
          strikes=strikes + (progressed_attempt < attempt),
          status=CASE WHEN mode='item' AND strikes + (progressed_attempt < attempt) >= ? THEN 'quarantined'
            WHEN artifact_json IS NOT NULL THEN 'staged' ELSE 'pending' END,
          owner=NULL, lease_until=0, last_error='lease expired', updated_at=?
        WHERE kind=? AND status='running' AND lease_until<=? AND (? IS NULL OR scope=?)`)
                .run(maxStrikes, now, options.kind, now, scope, scope);
            const revision = options.expectedInputRevision ?? null, recipe = options.expectedRecipeHash ?? null;
            const row = this.db.prepare(`SELECT * FROM work_items
        WHERE kind=? AND status IN ('pending','staged') AND (? OR due_at<=?)
          AND (? IS NULL OR scope=?) AND (? IS NULL OR mode=?)
          AND (? IS NULL OR input_revision=?) AND (? IS NULL OR recipe_hash=?)
        ORDER BY due_at, scope LIMIT 1`)
                .get(options.kind, Number(options.ignoreDueAt ?? false), now, scope, scope, mode, mode, revision, revision, recipe, recipe);
            if (!row)
                return undefined;
            const current = item(row);
            const changed = this.db.prepare(`UPDATE work_items SET attempt=attempt+1, owner=?, lease_until=?, status='running',
          updated_at=? WHERE kind=? AND scope=? AND attempt=? AND status IN ('pending','staged')`)
                .run(options.owner, now + options.leaseMs, now, current.kind, current.scope, current.attempt).changes;
            if (!Number(changed))
                return undefined;
            return {
                kind: current.kind, scope: current.scope, mode: current.mode, attempt: current.attempt + 1, owner: options.owner,
                stage: current.stage, artifactJson: current.artifactJson, inputRevision: current.inputRevision, recipeHash: current.recipeHash,
            };
        });
    }
    /** Extend a live lease. Fenced by `attempt` only: a clock jump past `lease_until` never fails a healthy renew. */
    renew(claim, leaseMs, now, options = {}) {
        requireDuration(leaseMs, "leaseMs");
        const at = now ?? Date.now();
        const run = () => this.db.prepare(`UPDATE work_items SET lease_until=?, updated_at=?
      WHERE kind=? AND scope=? AND status='running' AND attempt=?`)
            .run(at + leaseMs, at, claim.kind, claim.scope, claim.attempt).changes;
        const changed = options.busyTimeoutMs === undefined ? run() : this.#withBusyTimeout(options.busyTimeoutMs, run);
        if (!Number(changed))
            throw new WorkFenceLostError(claim, "renew");
    }
    /** Persist validated progress; a crash after this resumes from the artifact without re-running inference. */
    stageArtifact(claim, options) {
        requireJson(options.artifactJson, "artifactJson");
        requireJson(options.usageJson, "usageJson");
        const now = options.now ?? Date.now();
        const changed = this.db.prepare(`UPDATE work_items SET stage=?, artifact_json=?, usage_json=COALESCE(?, usage_json),
        strikes=0, progressed_attempt=attempt, updated_at=? WHERE kind=? AND scope=? AND status='running' AND attempt=?`)
            .run(options.stage, options.artifactJson, options.usageJson ?? null, now, claim.kind, claim.scope, claim.attempt).changes;
        if (!Number(changed))
            throw new WorkFenceLostError(claim, "stageArtifact");
        return { ...claim, stage: options.stage, artifactJson: options.artifactJson };
    }
    /** Run a fenced domain write without completing the work row (incremental publication by a live attempt). */
    withFence(claim, domainFn) {
        return immediateTransaction(this.db, () => {
            this.#requireFence(claim, "withFence");
            return domainFn(this.db);
        });
    }
    /**
     * Verify the fence, run the caller's synchronous domain write, and complete (or re-arm) the work row,
     * all inside one `BEGIN IMMEDIATE` on this connection. A lost fence throws before `domainFn` runs.
     */
    commitWithDomain(claim, options, domainFn) {
        requireJson(options.usageJson, "usageJson");
        const now = options.now ?? Date.now(), keep = Number(options.keepArtifact ?? false);
        // `preserveDueAt` re-arms at the row's due time as read inside this transaction (manual runs keep the schedule).
        const preserve = Number(options.preserveDueAt ?? false);
        return immediateTransaction(this.db, () => {
            this.#requireFence(claim, "commit");
            const result = domainFn(this.db);
            const changed = this.db.prepare(`UPDATE work_items SET status=?, due_at=CASE WHEN ? THEN due_at ELSE ? END, owner=NULL,
          lease_until=0, strikes=0, last_error=NULL, usage_json=COALESCE(?, usage_json),
          stage=CASE WHEN ? THEN stage ELSE NULL END, artifact_json=CASE WHEN ? THEN artifact_json ELSE NULL END,
          updated_at=? WHERE kind=? AND scope=? AND attempt=? AND status='running'`)
                .run(options.nextDueAt !== undefined || preserve ? "pending" : "completed", preserve, options.nextDueAt ?? 0, options.usageJson ?? null, keep, keep, now, claim.kind, claim.scope, claim.attempt).changes;
            if (!Number(changed))
                throw new WorkFenceLostError(claim, "commit");
            return result;
        });
    }
    /**
     * Release a failed attempt. `addStrike: false` (default) is graceful/transient: requeue with 0 strikes.
     * `addStrike: true` marks a deterministic bad item; `mode='item'` rows quarantine at `maxStrikes`.
     */
    fail(claim, options) {
        requireJson(options.usageJson, "usageJson");
        const now = options.now ?? Date.now(), strike = Number(options.addStrike ?? false), preserve = Number(options.preserveDueAt ?? false);
        return immediateTransaction(this.db, () => {
            const changed = this.db.prepare(`UPDATE work_items SET
          strikes=CASE WHEN ? THEN strikes+1 ELSE 0 END,
          status=CASE WHEN ? AND mode='item' AND strikes+1 >= ? THEN 'quarantined'
            WHEN artifact_json IS NOT NULL THEN 'staged' ELSE 'pending' END,
          due_at=CASE WHEN ? THEN due_at ELSE ? END, owner=NULL, lease_until=0, last_error=?, usage_json=COALESCE(?, usage_json), updated_at=?
        WHERE kind=? AND scope=? AND attempt=? AND status='running'`)
                .run(strike, strike, options.maxStrikes ?? DEFAULT_MAX_STRIKES, preserve, options.retryAt ?? now, options.error.slice(0, 2000), options.usageJson ?? null, now, claim.kind, claim.scope, claim.attempt).changes;
            if (!Number(changed))
                throw new WorkFenceLostError(claim, "fail");
            return this.get(claim.kind, claim.scope).status;
        });
    }
    /**
     * Synchronous graceful release for `gateway_stop` (no strikes). Rows with a saved artifact become `staged`
     * (resumable), others `pending`. Bumps `attempt`, so the released worker is fenced out at once. Waits at most
     * 200ms for a held write lock, then throws `SQLITE_BUSY` (the lease simply expires instead).
     */
    interruptOwner(owner, now) {
        return this.#withBusyTimeout(INTERRUPT_BUSY_TIMEOUT_MS, () => Number(this.db.prepare(`UPDATE work_items SET
        status=CASE WHEN artifact_json IS NOT NULL THEN 'staged' ELSE 'pending' END,
        attempt=attempt+1, owner=NULL, lease_until=0, updated_at=? WHERE owner=? AND status='running'`)
            .run(now ?? Date.now(), owner).changes));
    }
    /** Operator re-drive (including quarantined rows). Never steals a live lease. */
    requeue(kind, scope, dueAt, now) {
        const at = now ?? Date.now();
        return Number(this.db.prepare(`UPDATE work_items SET
        status=CASE WHEN artifact_json IS NOT NULL THEN 'staged' ELSE 'pending' END,
        attempt=attempt+1, due_at=?, strikes=0, owner=NULL, lease_until=0, last_error=NULL, updated_at=?
      WHERE kind=? AND scope=? AND NOT (status='running' AND lease_until>?)`)
            .run(dueAt ?? at, at, kind, scope, at).changes) > 0;
    }
    get(kind, scope) {
        const row = this.db.prepare("SELECT * FROM work_items WHERE kind=? AND scope=?").get(kind, scope);
        return row ? item(row) : undefined;
    }
    list(kind) {
        return this.db.prepare("SELECT * FROM work_items WHERE (? IS NULL OR kind=?) ORDER BY kind, due_at, scope")
            .all(kind ?? null, kind ?? null).map(item);
    }
    #requireFence(claim, action) {
        const live = this.db.prepare(`SELECT 1 FROM work_items WHERE kind=? AND scope=? AND attempt=? AND status='running'`)
            .get(claim.kind, claim.scope, claim.attempt);
        if (!live)
            throw new WorkFenceLostError(claim, action);
    }
    #withBusyTimeout(busyTimeoutMs, fn) {
        const previous = Number(this.db.prepare("PRAGMA busy_timeout").get()?.timeout ?? 0);
        this.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(busyTimeoutMs))}`);
        try {
            return fn();
        }
        finally {
            this.db.exec(`PRAGMA busy_timeout=${previous}`);
        }
    }
}
/**
 * Renew a claim periodically. Transient `SQLITE_BUSY` is a skipped beat; only `WorkFenceLostError`
 * (the row was reclaimed, interrupted, or reset) calls `onFenceLost`, once, and stops the heartbeat.
 */
export function startWorkHeartbeat(store, claim, options) {
    requireDuration(options.intervalMs, "intervalMs");
    requireDuration(options.leaseMs, "leaseMs");
    let stopped = false;
    const timer = setInterval(() => {
        if (stopped)
            return;
        try {
            store.renew(claim, options.leaseMs, options.now?.(), { busyTimeoutMs: HEARTBEAT_BUSY_TIMEOUT_MS });
        }
        catch (error) {
            if (error instanceof WorkFenceLostError) {
                stop();
                options.onFenceLost(error);
                return;
            }
            if (isSqliteBusy(error))
                return;
            options.onError?.(error);
        }
    }, options.intervalMs);
    timer.unref?.();
    const stop = () => { if (!stopped) {
        stopped = true;
        clearInterval(timer);
    } };
    return { stop };
}
