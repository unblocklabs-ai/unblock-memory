import { DEFAULTS } from "./defaults.js";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, lstatSync, openSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { MEMORY_DATABASE } from "./memory-database.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveAgentWorkspaceDir, resolveStateDir, } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listAgentIds, resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import { QmdMemoryManager } from "./manager.js";
import { resolveTimezone } from "./session-projector.js";
import { unchangedSessionSync } from "./session-sync.js";
import { resolveConfiguredSkillPath, resolveSessionSource, resolveSources } from "./sources.js";
import { classifyWorkspaceMemoryPaths } from "./workspace-path-classifier.js";
import { agentStateDir, agentTranscriptDatabase } from "./agent-paths.js";
const SESSION_SYNC_LOCK_FILE = "session-sync.lock.sqlite";
const LEGACY_SESSION_SYNC_LOCK_FILE = "session-sync.lock";
const SESSION_SYNC_STATUS_FILE = "session-sync-status.json";
const LEASE_BUSY_TIMEOUT_MS = DEFAULTS.sqlite.mainBusyTimeoutMs;
const MAX_LEASE_BUSY_RETRIES = 6;
const heldSessionSyncLeaseTokens = new Set();
const LEASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS session_sync_lease (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    pid INTEGER NOT NULL,
    token TEXT NOT NULL,
    started_at TEXT NOT NULL
  )
`;
function heldLeaseKey(lockPath, token) {
    return `${lockPath}\0${token}`;
}
function isLeaseHeldInProcess(lockPath, token) {
    return heldSessionSyncLeaseTokens.has(heldLeaseKey(lockPath, token));
}
function isLeaseActive(lockPath, lease) {
    if (!isProcessAlive(lease.pid))
        return false;
    if (lease.pid === process.pid && !isLeaseHeldInProcess(lockPath, lease.token)) {
        return false;
    }
    return true;
}
function parseLegacySessionSyncLock(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const { pid, token, startedAt } = value;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 ||
        typeof token !== "string" || token.length === 0 ||
        typeof startedAt !== "string" || startedAt.length === 0) {
        return undefined;
    }
    return { pid, token, startedAt };
}
function readLiveLegacySessionSyncLock(directory) {
    const legacyPath = join(directory, LEGACY_SESSION_SYNC_LOCK_FILE);
    try {
        const stat = lstatSync(legacyPath, { throwIfNoEntry: false });
        if (!stat || !stat.isFile())
            return undefined;
        const parsed = parseLegacySessionSyncLock(JSON.parse(readFileSync(legacyPath, "utf8")));
        if (!parsed || !isProcessAlive(parsed.pid))
            return undefined;
        return parsed;
    }
    catch {
        // Missing, unreadable, or invalid legacy lock file does not block SQLite lease acquisition.
        return undefined;
    }
}
async function readJson(path) {
    try {
        return JSON.parse(await fs.readFile(path, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function removeIfPresent(path) {
    try {
        await fs.unlink(path);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
async function atomicWriteJson(path, value) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, path);
    }
    finally {
        await removeIfPresent(temporary);
    }
}
function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = error.code;
        if (code === "EPERM")
            return true;
        if (code === "ESRCH")
            return false;
        throw error;
    }
}
function parseLeaseRow(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const { pid, token, started_at: startedAt } = value;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 ||
        typeof token !== "string" || token.length === 0 ||
        typeof startedAt !== "string" || startedAt.length === 0) {
        return undefined;
    }
    return { pid, token, startedAt };
}
function isSqliteBusy(error) {
    if (!(error instanceof Error))
        return false;
    const errcode = "errcode" in error && typeof error.errcode === "number" ? error.errcode : undefined;
    return errcode !== undefined && (errcode & 0xff) === 5;
}
async function withLeaseBusyRetry(operation) {
    for (let attempt = 0;; attempt += 1) {
        try {
            return operation();
        }
        catch (error) {
            if (!isSqliteBusy(error) || attempt >= MAX_LEASE_BUSY_RETRIES)
                throw error;
            const backoffMs = Math.min(200, 20 * (attempt + 1));
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
    }
}
function ensurePrivateLeaseFile(lockPath) {
    const existing = lstatSync(lockPath, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) {
        throw new Error("Session sync lock database must be a regular file, not a symlink");
    }
    const descriptor = openSync(lockPath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
        fchmodSync(descriptor, 0o600);
    }
    finally {
        closeSync(descriptor);
    }
}
async function withImmediateLeaseTransaction(lockPath, fn) {
    return await withLeaseBusyRetry(() => {
        ensurePrivateLeaseFile(lockPath);
        const db = new DatabaseSync(lockPath);
        let inTransaction = false;
        try {
            db.exec(`PRAGMA busy_timeout = ${LEASE_BUSY_TIMEOUT_MS}; PRAGMA trusted_schema = OFF;`);
            db.exec("BEGIN IMMEDIATE");
            inTransaction = true;
            db.exec(LEASE_SCHEMA_SQL);
            const { commit, value, onCommit } = fn(db);
            db.exec(commit ? "COMMIT" : "ROLLBACK");
            inTransaction = false;
            if (commit)
                onCommit?.();
            return value;
        }
        catch (error) {
            if (inTransaction) {
                try {
                    db.exec("ROLLBACK");
                }
                catch {
                    // Transaction may already be rolled back by SQLite.
                }
            }
            throw error;
        }
        finally {
            db.close();
        }
    });
}
async function readSessionSyncLock(lockPath) {
    const stat = lstatSync(lockPath, { throwIfNoEntry: false });
    if (!stat)
        return { exists: false };
    if (!stat.isFile()) {
        throw new Error("Session sync lock database must be a regular file, not a symlink");
    }
    return await withLeaseBusyRetry(() => {
        const db = new DatabaseSync(lockPath, { readOnly: true });
        try {
            db.exec(`PRAGMA busy_timeout = ${LEASE_BUSY_TIMEOUT_MS}; PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;`);
            const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_sync_lease'").get();
            if (!table)
                return { exists: false };
            const row = db.prepare("SELECT pid, token, started_at FROM session_sync_lease WHERE id = 1").get();
            if (!row)
                return { exists: false };
            return { exists: true, lock: parseLeaseRow(row) };
        }
        finally {
            db.close();
        }
    });
}
async function releaseSessionSyncLock(lockPath, token) {
    heldSessionSyncLeaseTokens.delete(heldLeaseKey(lockPath, token));
    const existing = lstatSync(lockPath, { throwIfNoEntry: false });
    if (!existing)
        return;
    await withImmediateLeaseTransaction(lockPath, (db) => {
        db.prepare("DELETE FROM session_sync_lease WHERE id = 1 AND token = ?").run(token);
        return { commit: true, value: undefined };
    });
}
async function releaseSessionSyncLockSafely(lockPath, token, onError) {
    try {
        await releaseSessionSyncLock(lockPath, token);
    }
    catch (error) {
        if (onError)
            onError(error);
        else
            console.warn(`unblock-memory failed to release session sync lease (${lockPath}): ${String(error)}`);
    }
}
async function clearStaleSessionSyncLease(lockPath) {
    const existing = lstatSync(lockPath, { throwIfNoEntry: false });
    if (!existing)
        return undefined;
    return await withImmediateLeaseTransaction(lockPath, (db) => {
        const row = db.prepare("SELECT pid, token, started_at FROM session_sync_lease WHERE id = 1").get();
        if (!row)
            return { commit: false, value: undefined };
        const current = parseLeaseRow(row);
        if (current && isLeaseActive(lockPath, current)) {
            return { commit: false, value: current };
        }
        db.prepare("DELETE FROM session_sync_lease WHERE id = 1").run();
        return { commit: true, value: undefined };
    });
}
async function acquireSessionSyncLock(directory, startedAt) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const liveLegacyBefore = readLiveLegacySessionSyncLock(directory);
    if (liveLegacyBefore) {
        return { acquired: false, owner: liveLegacyBefore };
    }
    const lockPath = join(directory, SESSION_SYNC_LOCK_FILE);
    const candidate = {
        pid: process.pid,
        token: randomUUID(),
        startedAt,
    };
    return await withImmediateLeaseTransaction(lockPath, (db) => {
        const row = db.prepare("SELECT pid, token, started_at FROM session_sync_lease WHERE id = 1").get();
        const existing = parseLeaseRow(row);
        if (existing && isLeaseActive(lockPath, existing)) {
            return { commit: false, value: { acquired: false, owner: existing } };
        }
        const liveLegacy = readLiveLegacySessionSyncLock(directory);
        if (liveLegacy) {
            return { commit: false, value: { acquired: false, owner: liveLegacy } };
        }
        db.prepare("INSERT OR REPLACE INTO session_sync_lease (id, pid, token, started_at) VALUES (1, ?, ?, ?)").run(candidate.pid, candidate.token, candidate.startedAt);
        return {
            commit: true,
            value: { acquired: true, lock: candidate, lockPath },
            onCommit: () => {
                heldSessionSyncLeaseTokens.add(heldLeaseKey(lockPath, candidate.token));
            },
        };
    });
}
function runningStatusFromReceipt(status, startedAt) {
    return status?.status === "running" && status.startedAt === startedAt
        ? { status: "running", phase: status.phase, startedAt }
        : { status: "running", phase: "queued", startedAt };
}
export async function recoverInterruptedSessionSync(directory, statusPath, stale, onError) {
    const acquired = await acquireSessionSyncLock(directory, stale.startedAt);
    if (!acquired.acquired) {
        const current = await readJson(statusPath);
        return runningStatusFromReceipt(current, acquired.owner.startedAt);
    }
    try {
        const current = await readJson(statusPath);
        if (!current)
            return { status: "idle" };
        if (current.status !== "running")
            return current;
        const failed = {
            status: "failed",
            startedAt: current.startedAt,
            completedAt: new Date().toISOString(),
            error: "session sync interrupted by Gateway restart",
        };
        await atomicWriteJson(statusPath, failed);
        return failed;
    }
    finally {
        await releaseSessionSyncLockSafely(acquired.lockPath, acquired.lock.token, onError);
    }
}
export class QmdMemoryRuntime {
    #corpora;
    #extraction;
    #analysisExecutable;
    #keepEmbeddingModelWarm;
    #stateRoot;
    #onError;
    #recallLedgerEnabled;
    #managers = new Map();
    #closingManagers = new Map();
    #activeSessionSyncs = new Map();
    #pendingSessionSyncStarts = new Set();
    #closing = false;
    #closed = false;
    #reloadFences = 0;
    #closeAllFences = 0;
    #closePromise;
    #sessionSyncTimer;
    #schedule;
    startSessionSyncSchedule(cfg, onError) {
        this.stopSessionSyncSchedule();
        if (this.#closing || this.#closed)
            return;
        const sessions = this.#corpora.find((corpus) => corpus.kind === "sessions");
        if (!sessions?.syncIntervalMinutes)
            return;
        this.#schedule = { cfg, onError };
        if (this.#reloadFences === 0 && this.#closeAllFences === 0) {
            this.#startSessionSyncTimer(sessions.syncIntervalMinutes, cfg, onError);
        }
    }
    stopSessionSyncSchedule() {
        this.#schedule = undefined;
        this.#pauseSessionSyncSchedule();
    }
    #pauseSessionSyncSchedule() {
        if (this.#sessionSyncTimer)
            clearInterval(this.#sessionSyncTimer);
        this.#sessionSyncTimer = undefined;
    }
    #maybeResumeSessionSyncSchedule() {
        if (this.#closing ||
            this.#closed ||
            this.#reloadFences > 0 ||
            this.#closeAllFences > 0 ||
            this.#sessionSyncTimer ||
            !this.#schedule) {
            return;
        }
        const sessions = this.#corpora.find((corpus) => corpus.kind === "sessions");
        if (!sessions?.syncIntervalMinutes)
            return;
        this.#startSessionSyncTimer(sessions.syncIntervalMinutes, this.#schedule.cfg, this.#schedule.onError);
    }
    #startSessionSyncTimer(syncIntervalMinutes, cfg, onError) {
        this.#sessionSyncTimer = setInterval(() => {
            for (const agentId of listAgentIds(cfg)) {
                void this.startSessionSync({ cfg, agentId }).catch(onError);
            }
        }, syncIntervalMinutes * 60_000);
        this.#sessionSyncTimer.unref();
    }
    #admissionBlockedReason() {
        if (this.#closing || this.#closed)
            return "memory runtime is closing";
        if (this.#reloadFences > 0)
            return "memory runtime is reloading";
        if (this.#closeAllFences > 0)
            return "memory runtime is closing";
        return undefined;
    }
    async #releaseLease(lockPath, token) {
        await releaseSessionSyncLockSafely(lockPath, token, this.#onError ?? this.#schedule?.onError);
    }
    constructor(corpora, options = {}) {
        this.#corpora = corpora;
        this.#extraction = options.extraction;
        this.#analysisExecutable = options.analysisExecutable;
        this.#keepEmbeddingModelWarm = options.keepEmbeddingModelWarm ?? true;
        this.#stateRoot = options.stateRoot ?? resolveStateDir();
        this.#recallLedgerEnabled = options.recallLedgerEnabled ?? false;
        this.#onError = options.onError;
    }
    memoryDatabasePath(agentId) {
        return join(this.#stateDir(agentId), MEMORY_DATABASE);
    }
    searchableCorpora() {
        const names = this.#corpora.filter((corpus) => corpus.kind !== "skills").map((corpus) => corpus.name);
        if (this.#extraction?.enabled && this.#extraction.publish && !names.includes("extracted")) {
            names.push("extracted");
        }
        return names;
    }
    async getMemorySearchManager(params) {
        while (true) {
            const blocked = this.#admissionBlockedReason();
            if (blocked) {
                return { manager: null, error: blocked };
            }
            const closing = this.#closingManagers.get(params.agentId);
            if (closing) {
                await closing.catch(() => undefined);
                continue;
            }
            let pending = this.#managers.get(params.agentId);
            if (!pending) {
                pending = this.#createManager(params.cfg, params.agentId);
                this.#managers.set(params.agentId, pending);
            }
            try {
                const manager = await pending;
                const blockedAfter = this.#admissionBlockedReason();
                if (blockedAfter) {
                    return { manager: null, error: blockedAfter };
                }
                if (this.#managers.get(params.agentId) !== pending) {
                    continue;
                }
                return { manager };
            }
            catch (error) {
                if (this.#managers.get(params.agentId) === pending)
                    this.#managers.delete(params.agentId);
                return { manager: null, error: error instanceof Error ? error.message : String(error) };
            }
        }
    }
    resolveMemoryBackendConfig() {
        return { backend: "builtin" };
    }
    classifyWorkspaceMemoryPaths = classifyWorkspaceMemoryPaths;
    startSessionSync(params, force = false) {
        const blocked = this.#admissionBlockedReason();
        if (blocked) {
            return Promise.resolve({
                status: "unavailable",
                error: blocked,
            });
        }
        if (!this.#corpora.some((corpus) => corpus.kind === "sessions")) {
            return Promise.resolve({
                status: "unavailable",
                error: 'memory session sync requires a configured "sessions" corpus',
            });
        }
        const pending = this.#startSessionSync(params, force);
        this.#pendingSessionSyncStarts.add(pending);
        const cleanup = () => {
            this.#pendingSessionSyncStarts.delete(pending);
        };
        pending.then(cleanup, cleanup);
        return pending;
    }
    async #startSessionSync(params, force) {
        const directory = this.#stateDir(params.agentId);
        const statusPath = join(directory, SESSION_SYNC_STATUS_FILE);
        const startedAt = new Date().toISOString();
        const acquired = await acquireSessionSyncLock(directory, startedAt);
        if (!acquired.acquired) {
            return { status: "already_running", startedAt: acquired.owner.startedAt };
        }
        const blockedAfterAcquire = this.#admissionBlockedReason();
        if (blockedAfterAcquire) {
            await this.#releaseLease(acquired.lockPath, acquired.lock.token);
            return { status: "unavailable", error: blockedAfterAcquire };
        }
        try {
            await atomicWriteJson(statusPath, {
                status: "running",
                phase: "queued",
                pid: process.pid,
                startedAt,
            });
        }
        catch (error) {
            await this.#releaseLease(acquired.lockPath, acquired.lock.token);
            throw error;
        }
        const blockedAfterWrite = this.#admissionBlockedReason();
        if (blockedAfterWrite) {
            try {
                await atomicWriteJson(statusPath, {
                    status: "failed",
                    startedAt,
                    completedAt: new Date().toISOString(),
                    error: blockedAfterWrite,
                });
            }
            catch {
                // Best effort: the next status read recovers any remaining running receipt.
            }
            await this.#releaseLease(acquired.lockPath, acquired.lock.token);
            return { status: "unavailable", error: blockedAfterWrite };
        }
        const run = this.#runSessionSync(params, force, {
            directory,
            statusPath,
            lockPath: acquired.lockPath,
            token: acquired.lock.token,
            startedAt,
        });
        this.#activeSessionSyncs.set(directory, run);
        const cleanupRun = () => {
            if (this.#activeSessionSyncs.get(directory) === run) {
                this.#activeSessionSyncs.delete(directory);
            }
        };
        run.then(cleanupRun, cleanupRun);
        return { status: "started", startedAt };
    }
    async #runSessionSync(params, force, run) {
        let statusWrites = Promise.resolve();
        const writePhase = (phase) => {
            statusWrites = statusWrites.then(() => atomicWriteJson(run.statusPath, {
                status: "running",
                phase,
                pid: process.pid,
                startedAt: run.startedAt,
            }));
        };
        try {
            const sessions = this.#sessionConfig(params.cfg, params.agentId);
            let result = !force && sessions
                ? await unchangedSessionSync(sessions, join(run.directory, "index.sqlite"))
                : undefined;
            if (!result) {
                const { manager, error } = await this.getMemorySearchManager(params);
                if (!manager)
                    throw new Error(error ?? "memory unavailable");
                result = await manager.syncSessions(force, writePhase);
            }
            await statusWrites;
            await atomicWriteJson(run.statusPath, {
                status: "completed",
                startedAt: run.startedAt,
                completedAt: new Date().toISOString(),
                ...result,
            });
        }
        catch (error) {
            await statusWrites.catch(() => { });
            try {
                await atomicWriteJson(run.statusPath, {
                    status: "failed",
                    startedAt: run.startedAt,
                    completedAt: new Date().toISOString(),
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            catch {
                // The next status read converts the persisted running state to interrupted.
            }
        }
        finally {
            await this.#releaseLease(run.lockPath, run.token);
        }
    }
    async sessionSyncStatus(agentId) {
        const directory = this.#stateDir(agentId);
        const lockPath = join(directory, SESSION_SYNC_LOCK_FILE);
        const statusPath = join(directory, SESSION_SYNC_STATUS_FILE);
        const onError = this.#onError ?? this.#schedule?.onError;
        const lockState = await readSessionSyncLock(lockPath);
        if (lockState.exists && lockState.lock && isLeaseActive(lockPath, lockState.lock)) {
            const status = await readJson(statusPath);
            return runningStatusFromReceipt(status, lockState.lock.startedAt);
        }
        const legacyOwner = readLiveLegacySessionSyncLock(directory);
        if (legacyOwner) {
            const status = await readJson(statusPath);
            return runningStatusFromReceipt(status, legacyOwner.startedAt);
        }
        const status = await readJson(statusPath);
        if (status?.status === "running") {
            return await recoverInterruptedSessionSync(directory, statusPath, status, onError);
        }
        if (lockState.exists) {
            const liveOwner = await clearStaleSessionSyncLease(lockPath);
            if (liveOwner) {
                const refreshedStatus = await readJson(statusPath);
                return runningStatusFromReceipt(refreshedStatus, liveOwner.startedAt);
            }
            const refreshedStatus = await readJson(statusPath);
            if (refreshedStatus?.status === "running") {
                return await recoverInterruptedSessionSync(directory, statusPath, refreshedStatus, onError);
            }
            return refreshedStatus ?? { status: "idle" };
        }
        return status ?? { status: "idle" };
    }
    async #drainSessionSyncs() {
        while (this.#pendingSessionSyncStarts.size > 0 || this.#activeSessionSyncs.size > 0) {
            await Promise.allSettled([
                ...this.#pendingSessionSyncStarts,
                ...this.#activeSessionSyncs.values(),
            ]);
        }
    }
    prepareReload(change) {
        // QMD embeds locally rather than via host MemoryEmbeddingProviderAdapter instances,
        // so only retiring this runtime affects its managers and session syncs.
        if (!change.retireRuntime) {
            return {
                drain: async () => ({ errors: [] }),
                resume() { },
            };
        }
        this.#reloadFences += 1;
        this.#pauseSessionSyncSchedule();
        let resumed = false;
        let drainPromise;
        return {
            drain: () => {
                if (!drainPromise) {
                    drainPromise = (async () => {
                        const errors = [];
                        if (resumed)
                            return { errors };
                        let ranOnce = false;
                        while (!ranOnce ||
                            (!resumed && (this.#pendingSessionSyncStarts.size > 0 ||
                                this.#activeSessionSyncs.size > 0 ||
                                this.#managers.size > 0 ||
                                this.#closingManagers.size > 0))) {
                            ranOnce = true;
                            await this.#drainSessionSyncs();
                            if (resumed)
                                break;
                            const agentIds = new Set([...this.#managers.keys(), ...this.#closingManagers.keys()]);
                            if (agentIds.size > 0) {
                                const settled = await Promise.allSettled([...agentIds].map((agentId) => this.closeMemorySearchManager({ agentId })));
                                for (const outcome of settled) {
                                    if (outcome.status === "rejected")
                                        errors.push(outcome.reason);
                                }
                            }
                        }
                        return { errors };
                    })();
                }
                return drainPromise;
            },
            resume: () => {
                if (resumed)
                    return;
                resumed = true;
                this.#reloadFences = Math.max(0, this.#reloadFences - 1);
                this.#maybeResumeSessionSyncSchedule();
            },
        };
    }
    async closeMemorySearchManager(params) {
        const { agentId } = params;
        const activeSync = this.#activeSessionSyncs.get(this.#stateDir(agentId));
        if (activeSync)
            await activeSync.catch(() => undefined);
        const previousClose = this.#closingManagers.get(agentId);
        const pending = this.#managers.get(agentId);
        this.#managers.delete(agentId);
        if (!previousClose && !pending)
            return;
        const closing = (async () => {
            let closeError;
            if (previousClose) {
                try {
                    await previousClose;
                }
                catch (error) {
                    closeError = error;
                }
            }
            if (pending) {
                let manager;
                try {
                    manager = await pending;
                }
                catch {
                    // Failed startup already cleaned up its own manager inside #createManager.
                }
                if (manager) {
                    try {
                        await manager.close();
                    }
                    catch (error) {
                        closeError ??= error;
                    }
                }
            }
            if (closeError !== undefined)
                throw closeError;
        })();
        this.#closingManagers.set(agentId, closing);
        try {
            await closing;
        }
        finally {
            if (this.#closingManagers.get(agentId) === closing) {
                this.#closingManagers.delete(agentId);
            }
        }
    }
    async closeAllMemorySearchManagers() {
        this.#closeAllFences += 1;
        this.stopSessionSyncSchedule();
        let firstError;
        let hasError = false;
        try {
            while (this.#pendingSessionSyncStarts.size > 0 ||
                this.#activeSessionSyncs.size > 0 ||
                this.#managers.size > 0 ||
                this.#closingManagers.size > 0) {
                await this.#drainSessionSyncs();
                const agentIds = new Set([...this.#managers.keys(), ...this.#closingManagers.keys()]);
                if (agentIds.size > 0) {
                    const settled = await Promise.allSettled([...agentIds].map((agentId) => this.closeMemorySearchManager({ agentId })));
                    for (const outcome of settled) {
                        if (outcome.status === "rejected" && !hasError) {
                            hasError = true;
                            firstError = outcome.reason;
                        }
                    }
                }
            }
        }
        finally {
            this.#closeAllFences = Math.max(0, this.#closeAllFences - 1);
        }
        if (hasError)
            throw firstError;
    }
    async close() {
        if (this.#closePromise)
            return this.#closePromise;
        this.#closing = true;
        const closing = (async () => {
            try {
                await this.closeAllMemorySearchManagers();
            }
            finally {
                this.#closed = true;
                this.#closing = false;
            }
        })();
        this.#closePromise = closing;
        return closing;
    }
    async searchSkills(params, query, minScore, limit) {
        const { manager, error } = await this.getMemorySearchManager(params);
        if (!manager)
            throw new Error(error ?? "memory unavailable");
        return manager.searchSkills(query, minScore, limit);
    }
    resolveSkillPath(params, path) {
        const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
        const skillCorpora = this.#corpora.filter((corpus) => corpus.kind === "skills");
        return resolveConfiguredSkillPath(workspaceDir, path, resolveSources(workspaceDir, skillCorpora));
    }
    async #createManager(cfg, agentId) {
        const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
        const stateDir = this.#stateDir(agentId);
        const fileCorpora = this.#corpora.filter((corpus) => corpus.kind === "files" || corpus.kind === "skills");
        const sessions = this.#sessionConfig(cfg, agentId);
        const sources = resolveSources(workspaceDir, fileCorpora);
        const sessionSource = sessions
            ? resolveSessionSource(sessions.outputDir, sessions.chatTypes)
            : undefined;
        if (sessionSource)
            sources.push(sessionSource);
        const manager = new QmdMemoryManager({
            workspaceDir,
            dbPath: join(stateDir, "index.sqlite"),
            curationPath: join(stateDir, MEMORY_DATABASE),
            extraction: this.#extraction,
            sources,
            keepModelsWarm: this.#keepEmbeddingModelWarm,
            analysisExecutable: this.#analysisExecutable,
            sessions,
            trackRecallLocators: this.#recallLedgerEnabled,
        });
        try {
            await manager.start();
        }
        catch (error) {
            // The manager is not in the runtime's resolved cache yet, so we own cleanup.
            await manager.close().catch(() => undefined);
            throw error;
        }
        return manager;
    }
    #sessionConfig(cfg, agentId) {
        const corpus = this.#corpora.find(corpus => corpus.kind === "sessions");
        if (!corpus)
            return;
        const stateDir = this.#stateDir(agentId);
        const source = resolveSessionSource(join(stateDir, "sessions"), corpus.chatTypes);
        return {
            agentId, agentName: resolveAgentIdentity(cfg, agentId)?.name?.trim() || agentId,
            chatTypes: corpus.chatTypes, maxExpandedTokens: corpus.maxExpandedTokens,
            collection: source.collection, outputDir: source.root,
            databasePath: agentTranscriptDatabase(cfg, agentId),
            manifestPath: join(stateDir, "sessions-manifest.json"),
            timezone: resolveTimezone(cfg.agents?.defaults?.userTimezone?.trim()),
        };
    }
    #stateDir(agentId) {
        return agentStateDir(agentId, this.#stateRoot);
    }
}
