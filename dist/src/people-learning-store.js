import { Type } from "typebox";
import { Value } from "typebox/value";
import { openMemoryDatabase, immediateTransaction } from "./memory-database.js";
import { jsonHash } from "./json-hash.js";
import { reviewWindow, shiftDate } from "./people-learning-time.js";
const text = Type.String({ pattern: "\\S" });
const verification = { reason: text, sourceRefs: Type.Array(text), reviewedAt: text };
export const LEARNING_RECEIPT_SCHEMA = Type.Object({
    manifestRevision: Type.Optional(text),
    peopleReviews: Type.Array(Type.Object({ personId: text, status: Type.Enum(["reviewed", "no_interactions", "unresolved"]),
        sessionIds: Type.Array(text), ...verification }, { additionalProperties: false })),
    assertionReviews: Type.Array(Type.Object({ assertionId: text,
        disposition: Type.Enum(["revalidated", "corrected", "retired", "unresolved"]),
        correctionsCheckedAt: Type.Optional(text), ...verification }, { additionalProperties: false })),
    sourceGapReviews: Type.Array(Type.Object({ sourceGapId: text, status: Type.Enum(["resolved", "unresolved"]),
        ...verification }, { additionalProperties: false })),
    analysis: Type.Object({ status: Type.Enum(["complete", "not_approved", "unresolved"]), reason: text }, { additionalProperties: false }),
    changes: Type.Array(Type.Object({ personId: text, changeId: text }, { additionalProperties: false })),
    executionFollowups: Type.Array(text),
}, { additionalProperties: false });
export function manifestRevision(manifest) {
    return jsonHash(manifest);
}
export function verifyLearningCoverage(manifest, receipt, now = Date.now()) {
    const missing = [], errors = [], unresolved = [];
    const manifestCreatedAt = Date.parse(manifest.createdAt);
    const currentRevision = manifestRevision(manifest);
    if (receipt.manifestRevision !== undefined && receipt.manifestRevision !== currentRevision) {
        errors.push(`Stale manifest revision: expected ${currentRevision}, got ${receipt.manifestRevision}`);
    }
    if (manifest.inventoryPending)
        missing.push("inventory");
    const indexBy = (items, key, known) => {
        const result = new Map();
        for (const item of items) {
            const id = key(item);
            if (result.has(id))
                errors.push(`Duplicate disposition: ${id}`);
            if (!known.has(id))
                errors.push(`Unknown disposition: ${id}`);
            result.set(id, item);
        }
        return result;
    };
    const verified = (value, id) => {
        const date = Date.parse(value.reviewedAt);
        if (!value.reason.trim() || !value.sourceRefs.length || value.sourceRefs.some(s => !s.trim()) ||
            !Number.isFinite(date) || date < manifestCreatedAt || date > now) {
            errors.push(`Missing actual source verification: ${id}`);
        }
    };
    const gaps = indexBy(receipt.sourceGapReviews, r => r.sourceGapId, new Set(manifest.sourceGaps.map(g => g.id)));
    let hasUnresolvedGaps = false;
    for (const gap of manifest.sourceGaps) {
        const review = gaps.get(gap.id);
        if (review?.status === "resolved")
            verified(review, gap.id);
        else {
            hasUnresolvedGaps = true;
            unresolved.push(`source:${gap.id}`);
        }
    }
    const people = indexBy(receipt.peopleReviews, r => r.personId, new Set(manifest.roster.map(p => p.personId)));
    if (manifest.kind === "nightly")
        for (const person of manifest.roster) {
            const review = people.get(person.personId);
            if (!review) {
                missing.push(`person:${person.personId}`);
                continue;
            }
            if (review.status === "unresolved") {
                unresolved.push(`person:${person.personId}`);
                continue;
            }
            if (review.status === "no_interactions") {
                if (person.sessionIds.length)
                    errors.push(`Skipped interactions: ${person.personId}`);
                if (hasUnresolvedGaps)
                    unresolved.push(`activity-unknown:${person.personId}`);
            }
            else {
                verified(review, person.personId);
                const reviewedSessions = new Set(review.sessionIds);
                const expectedSessions = new Set(person.sessionIds);
                for (const id of person.sessionIds)
                    if (!reviewedSessions.has(id))
                        missing.push(`session:${person.personId}:${id}`);
                if (review.sessionIds.some(id => !expectedSessions.has(id)))
                    errors.push(`Wrong session attribution: ${person.personId}`);
            }
        }
    const assertions = indexBy(receipt.assertionReviews, r => r.assertionId, new Set(manifest.assertions.map(a => a.id)));
    for (const assertion of manifest.assertions) {
        const review = assertions.get(assertion.id);
        if (!review) {
            missing.push(`assertion:${assertion.id}`);
            continue;
        }
        if (review.disposition === "unresolved") {
            unresolved.push(`assertion:${assertion.id}`);
            continue;
        }
        verified(review, assertion.id);
        const corrected = Date.parse(review.correctionsCheckedAt ?? "");
        if (!Number.isFinite(corrected) || corrected < manifestCreatedAt || corrected > now) {
            errors.push(`Missing newer-correction research: ${assertion.id}`);
        }
    }
    if (receipt.analysis.status === "unresolved")
        unresolved.push("analysis");
    return {
        status: errors.length ? "invalid" : missing.length || unresolved.length ? "partial" : "complete",
        expectedPeople: manifest.kind === "nightly" ? manifest.roster.length : 0,
        expectedSessions: manifest.sessions.length,
        expectedAssertions: manifest.assertions.length,
        missing,
        errors,
        unresolved,
    };
}
export class PeopleLearningStore {
    agentId;
    #db;
    constructor(path, agentId) {
        this.agentId = agentId;
        this.#db = openMemoryDatabase(path);
        this.#db.exec(`CREATE TABLE IF NOT EXISTS people_learning_owner (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), agent_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS people_learning_runs (
        id TEXT PRIMARY KEY, manifest TEXT NOT NULL, receipt TEXT, status TEXT NOT NULL, coverage TEXT NOT NULL,
        reopened_revision TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS people_learning_receipts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, receipt TEXT NOT NULL, coverage TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS people_learning_inventories (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, manifest TEXT NOT NULL, captured_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS people_learning_analysis (
        run_id TEXT PRIMARY KEY, status TEXT NOT NULL, result TEXT NOT NULL, checked_at TEXT NOT NULL
      ) STRICT;`);
        const columns = this.#db.prepare("PRAGMA table_info(people_learning_runs)").all();
        if (!columns.some(col => col.name === "reopened_revision")) {
            this.#db.exec("ALTER TABLE people_learning_runs ADD COLUMN reopened_revision TEXT");
        }
        this.#db.prepare("INSERT OR IGNORE INTO people_learning_owner VALUES (1,?)").run(agentId);
        const owner = this.#db.prepare("SELECT agent_id FROM people_learning_owner").get();
        if (owner && owner.agent_id !== agentId) {
            this.#db.close();
            throw new Error("People learning state belongs to another agent");
        }
    }
    close() { this.#db.close(); }
    recordAnalysis(id, status, result, basis, options = {}) {
        return immediateTransaction(this.#db, () => {
            const run = this.#getRunRow(id);
            if (!run)
                throw new Error("Unknown review run");
            if (options.expectedManifestRevision !== undefined && run.manifestRevision !== options.expectedManifestRevision) {
                return { recorded: false, reason: "manifest_changed" };
            }
            const recordedAt = options.recordedAt ?? Date.now();
            const startedAt = options.startedAt ?? recordedAt;
            const existing = this.#db.prepare(`SELECT status, checked_at,
        json_extract(result,'$.basis') basis,
        json_extract(result,'$.manifestRevision') manifestRevision,
        json_extract(result,'$.startedAt') startedAt,
        json_extract(result,'$.generation') generation,
        json_extract(result,'$.sequence') sequence,
        json_extract(result,'$.instanceId') instanceId
        FROM people_learning_analysis WHERE run_id=?`).get(id);
            if (existing) {
                const existingManifestRevision = typeof existing.manifestRevision === "string" ? existing.manifestRevision : undefined;
                const existingStillCurrent = existingManifestRevision === undefined || existingManifestRevision === run.manifestRevision;
                if (existingStillCurrent) {
                    const sameInstance = typeof options.instanceId === "string" && options.instanceId === existing.instanceId;
                    const existingGen = typeof existing.generation === "number" ? existing.generation : undefined;
                    const existingSeq = typeof existing.sequence === "number" ? existing.sequence : undefined;
                    const existingStartedAt = typeof existing.startedAt === "number"
                        ? existing.startedAt
                        : Date.parse(String(existing.checked_at));
                    if (sameInstance && options.generation !== undefined && existingGen !== undefined && options.generation !== existingGen) {
                        if (options.generation < existingGen)
                            return { recorded: false, reason: "superseded" };
                    }
                    else if (Number.isFinite(existingStartedAt) && startedAt !== existingStartedAt) {
                        if (startedAt < existingStartedAt)
                            return { recorded: false, reason: "superseded" };
                    }
                    else if (sameInstance && options.sequence !== undefined && existingSeq !== undefined && options.sequence < existingSeq) {
                        return { recorded: false, reason: "superseded" };
                    }
                    else if (existing.basis === basis && existing.status === "complete" && status !== "complete") {
                        return { recorded: false, reason: "superseded" };
                    }
                }
            }
            this.#db.prepare(`INSERT INTO people_learning_analysis VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
        status=excluded.status,result=excluded.result,checked_at=excluded.checked_at`)
                .run(id, status, JSON.stringify({
                basis,
                manifestRevision: run.manifestRevision,
                startedAt,
                ...(options.generation !== undefined ? { generation: options.generation } : {}),
                ...(options.sequence !== undefined ? { sequence: options.sequence } : {}),
                ...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {}),
                result,
            }), new Date(recordedAt).toISOString());
            return { recorded: true };
        });
    }
    analysis(id) {
        return this.#db.prepare("SELECT status,checked_at,json_extract(result,'$.basis') basis FROM people_learning_analysis WHERE run_id=?").get(id);
    }
    #rememberInventory(snapshot) {
        this.#db.prepare("INSERT OR IGNORE INTO people_learning_inventories VALUES (?,?,?,?)")
            .run(jsonHash(snapshot), snapshot.id, JSON.stringify(snapshot), snapshot.refreshedAt ?? snapshot.createdAt);
    }
    begin(manifest, beforeCommit) {
        if (manifest.agentId !== this.agentId)
            throw new Error("Cross-agent review manifest");
        return immediateTransaction(this.#db, () => {
            const previous = this.#getRunRow(manifest.id);
            if (previous && !manifest.inventoryPending) {
                const prior = previous.manifest;
                if (prior.kind !== manifest.kind || JSON.stringify(prior.window) !== JSON.stringify(manifest.window))
                    throw new Error("Review window changed");
                const incomingSessionIds = new Set(manifest.sessions.map(s => s.sessionId));
                const missingSessions = prior.sessions.filter(s => !incomingSessionIds.has(s.sessionId));
                const sessions = [...manifest.sessions, ...missingSessions];
                const sourceGaps = [...manifest.sourceGaps, ...missingSessions.map(s => ({
                        id: jsonHash(["missing-session", s.sessionId]), sessionId: s.sessionId,
                        reason: "Previously inventoried session is no longer readable; preserve original export and verify source",
                    }))];
                const priorRosterById = new Map(prior.roster.map(p => [p.personId, p]));
                const roster = [...new Map([...prior.roster, ...manifest.roster].map(person => {
                        const old = priorRosterById.get(person.personId);
                        return [person.personId, { ...person, sessionIds: [...new Set([...(old?.sessionIds ?? []), ...person.sessionIds])] }];
                    })).values()];
                const assertions = [...new Map([...prior.assertions, ...manifest.assertions].map(a => [a.id, a])).values()];
                const { refreshedAt: _incomingRefresh, ...incoming } = manifest;
                const next = {
                    ...incoming,
                    createdAt: prior.createdAt,
                    fullValidation: prior.fullValidation || manifest.fullValidation,
                    roster,
                    sessions,
                    sourceGaps,
                    assertions,
                };
                const { refreshedAt: _oldRefresh, ...oldComparable } = prior;
                if (jsonHash(next) === jsonHash(oldComparable)) {
                    beforeCommit?.(previous.manifest);
                    this.#rememberInventory(previous.manifest);
                    return this.#toPublicRun(previous);
                }
                const sourcesChanged = jsonHash([prior.sessions, prior.sourceGaps, prior.roster]) !== jsonHash([sessions, sourceGaps, roster]);
                const nextManifest = { ...next, refreshedAt: new Date(Date.now()).toISOString() };
                const nextRevision = manifestRevision(nextManifest);
                // Publish the manifest artifact BEFORE committing the ledger/run row pointing to it.
                beforeCommit?.(nextManifest);
                this.#rememberInventory(previous.manifest);
                const gapIds = new Set(sourceGaps.map(g => g.id));
                const receipt = previous.receipt ? {
                    ...previous.receipt,
                    manifestRevision: sourcesChanged
                        ? undefined
                        : previous.receipt.manifestRevision !== undefined ? nextRevision : undefined,
                    peopleReviews: sourcesChanged ? [] : previous.receipt.peopleReviews,
                    assertionReviews: sourcesChanged ? [] : previous.receipt.assertionReviews,
                    sourceGapReviews: sourcesChanged ? [] : previous.receipt.sourceGapReviews.filter(r => gapIds.has(r.sourceGapId)),
                    analysis: sourcesChanged ? { status: "unresolved", reason: "Source inventory changed; recheck analysis" } : previous.receipt.analysis,
                } : undefined;
                // Record reopened_revision whenever a run's manifest refreshes (even before
                // any receipt was saved) so an unversioned receipt for an earlier export
                // can never mark the refreshed manifest complete.
                const reopenedRevision = nextRevision;
                if (sourcesChanged)
                    this.#db.prepare("DELETE FROM people_learning_analysis WHERE run_id=?").run(nextManifest.id);
                this.#db.prepare("UPDATE people_learning_runs SET manifest=?,receipt=?,status='partial',coverage=?,reopened_revision=? WHERE id=?")
                    .run(JSON.stringify(nextManifest), receipt ? JSON.stringify(receipt) : null, JSON.stringify(receipt ? verifyLearningCoverage(nextManifest, receipt) : { missing: ["receipt"] }), reopenedRevision, nextManifest.id);
                this.#rememberInventory(nextManifest);
            }
            else if (!previous) {
                // Publish the manifest artifact BEFORE committing the ledger/run row pointing to it.
                beforeCommit?.(manifest);
                this.#db.prepare("INSERT INTO people_learning_runs (id,manifest,receipt,status,coverage,reopened_revision) VALUES (?,?,NULL,'partial',?,NULL)")
                    .run(manifest.id, JSON.stringify(manifest), JSON.stringify({ missing: ["receipt"], unresolved: manifest.sourceGaps.map(g => g.id) }));
                this.#rememberInventory(manifest);
            }
            else {
                this.#rememberInventory(previous.manifest);
                this.#rememberInventory(manifest);
            }
            return this.get(manifest.id);
        });
    }
    planMissedWindows(manifest) {
        const last = this.#db.prepare("SELECT id FROM people_learning_runs WHERE id LIKE ? ORDER BY id DESC LIMIT 1").get(`${manifest.kind}:%`);
        if (!last)
            return;
        const step = manifest.kind === "nightly" ? 1 : 7;
        const createdAt = Date.parse(manifest.createdAt);
        let day = shiftDate(String(last.id).slice(manifest.kind.length + 1), step);
        while (day < manifest.window.localDay) {
            this.begin({
                ...manifest, id: `${manifest.kind}:${day}`, inventoryPending: true,
                window: reviewWindow(createdAt, manifest.window.timezone, manifest.kind, day),
                roster: [], assertions: [], sessions: [],
                sourceGaps: [{ id: `inventory:${day}`, reason: "Missed scheduled window; inventory and review still required" }],
            });
            day = shiftDate(day, step);
        }
    }
    #getRunRow(id) {
        const row = this.#db.prepare("SELECT id,manifest,receipt,status,coverage,reopened_revision FROM people_learning_runs WHERE id=?").get(id);
        if (!row)
            return undefined;
        const manifest = JSON.parse(String(row.manifest));
        return {
            manifest,
            manifestRevision: manifestRevision(manifest),
            receipt: row.receipt ? Value.Parse(LEARNING_RECEIPT_SCHEMA, JSON.parse(String(row.receipt))) : undefined,
            status: String(row.status),
            coverage: JSON.parse(String(row.coverage)),
            reopenedRevision: typeof row.reopened_revision === "string" ? row.reopened_revision : null,
        };
    }
    #toPublicRun(row) {
        return {
            manifest: row.manifest,
            manifestRevision: row.manifestRevision,
            receipt: row.receipt,
            status: row.status,
            coverage: row.coverage,
        };
    }
    get(id) {
        const row = this.#getRunRow(id);
        return row ? this.#toPublicRun(row) : undefined;
    }
    backlog() {
        return this.#db.prepare("SELECT id,status,coverage FROM people_learning_runs WHERE status!='complete' ORDER BY id").all()
            .map(row => ({ id: String(row.id), status: String(row.status), coverage: JSON.parse(String(row.coverage)) }));
    }
    #mergeReceipt(prior, patch, expectedManifestRevision) {
        const merge = (previous, next, key) => {
            if (new Set(next.map(key)).size !== next.length)
                throw new Error("Duplicate review disposition");
            return [...new Map([...previous, ...next].map(row => [key(row), row])).values()];
        };
        const mergedRevision = patch.manifestRevision ?? expectedManifestRevision ?? prior?.manifestRevision;
        return {
            ...patch,
            ...(mergedRevision !== undefined ? { manifestRevision: mergedRevision } : {}),
            peopleReviews: merge(prior?.peopleReviews ?? [], patch.peopleReviews, r => r.personId),
            assertionReviews: merge(prior?.assertionReviews ?? [], patch.assertionReviews, r => r.assertionId),
            sourceGapReviews: merge(prior?.sourceGapReviews ?? [], patch.sourceGapReviews, r => r.sourceGapId),
            changes: merge(prior?.changes ?? [], patch.changes, r => r.changeId),
            executionFollowups: [...new Set([...(prior?.executionFollowups ?? []), ...patch.executionFollowups])],
        };
    }
    #publishFinalized(id, pending, manifest, result, finalize) {
        // Run staged-revision freshness check, ALL dossier verification writes (on this.#db),
        // and final completion UPDATE inside ONE atomic SQLite transaction. If the staged
        // revision changed or any person's verification fails, the entire transaction rolls
        // back and zero newly verified dossiers become visible.
        const { receiptId: _pendingId, manifestRevision: revision, backlog: _backlog, ...pendingCoverage } = result;
        const coverage = { ...pendingCoverage, status: "complete", unresolved: result.unresolved.filter(r => r !== "dossier-verification") };
        const receiptId = jsonHash([result.receiptId, "verified"]);
        let published = false;
        try {
            published = immediateTransaction(this.#db, () => {
                const current = this.#db.prepare("SELECT 1 FROM people_learning_runs WHERE id=? AND manifest=? AND receipt=? AND coverage=? AND status='partial'").get(id, pending.manifest, pending.receipt, pending.coverage);
                if (!current)
                    return false;
                finalize(result.receiptId, this.#db, manifest);
                const updated = this.#db.prepare("UPDATE people_learning_runs SET status='complete',coverage=? WHERE id=? AND manifest=? AND receipt=? AND coverage=? AND status='partial'").run(JSON.stringify(coverage), id, pending.manifest, pending.receipt, pending.coverage);
                if (!updated.changes)
                    throw new Error("Staged checkpoint changed during finalization");
                this.#db.prepare("INSERT INTO people_learning_receipts VALUES (?,?,?,?,?)")
                    .run(receiptId, id, pending.receipt, JSON.stringify(coverage), new Date(Date.now()).toISOString());
                return true;
            });
        }
        catch {
            return { ...result, backlog: this.backlog() };
        }
        return published ? { ...coverage, receiptId, manifestRevision: revision, backlog: this.backlog() } : { ...result, backlog: this.backlog() };
    }
    checkpoint(id, input, now = Date.now(), checkSaves, finalize, expectedManifestRevision, options) {
        const patch = Value.Parse(LEARNING_RECEIPT_SCHEMA, input);
        let staged;
        let stagedManifest;
        const result = immediateTransaction(this.#db, () => {
            let run = this.#getRunRow(id);
            if (!run)
                throw new Error("Unknown review run");
            if (run.manifest.inventoryPending)
                throw new Error("Inventory the missed window before checkpointing it");
            const revisionErrors = [];
            if (expectedManifestRevision !== undefined && patch.manifestRevision !== undefined &&
                expectedManifestRevision !== patch.manifestRevision) {
                revisionErrors.push(`Conflicting manifest revision: ${expectedManifestRevision} vs ${patch.manifestRevision}`);
            }
            const suppliedRevision = expectedManifestRevision ?? patch.manifestRevision;
            if (suppliedRevision !== undefined && suppliedRevision !== run.manifestRevision) {
                revisionErrors.push(`Stale manifest revision: expected ${run.manifestRevision}, got ${suppliedRevision}`);
            }
            else if (suppliedRevision === undefined && run.reopenedRevision !== null) {
                revisionErrors.push(`Manifest was refreshed; provide current manifestRevision ${run.manifestRevision}`);
            }
            if (revisionErrors.length) {
                const coverage = {
                    status: "invalid",
                    expectedPeople: run.manifest.kind === "nightly" ? run.manifest.roster.length : 0,
                    expectedSessions: run.manifest.sessions.length,
                    expectedAssertions: run.manifest.assertions.length,
                    missing: [],
                    errors: revisionErrors,
                    unresolved: [],
                };
                const receiptId = jsonHash([id, patch, now]);
                this.#db.prepare("INSERT INTO people_learning_receipts VALUES (?,?,?,?,?)")
                    .run(receiptId, id, JSON.stringify(patch), JSON.stringify(coverage), new Date(now).toISOString());
                return { receiptId, manifestRevision: run.manifestRevision, ...coverage, backlog: this.backlog() };
            }
            // Revision is CAS-verified inside BEGIN IMMEDIATE. Only now expand newly
            // acquired dossier assertions — never touching sessions, roster, or sourceGaps.
            let assertionsExpanded = false;
            if (options?.collectAssertions) {
                const discovered = options.collectAssertions(run.manifest);
                const mergedAssertions = [...new Map([...run.manifest.assertions, ...discovered].map(a => [a.id, a])).values()];
                if (jsonHash(mergedAssertions) !== jsonHash(run.manifest.assertions)) {
                    assertionsExpanded = true;
                    const nextManifest = {
                        ...run.manifest,
                        assertions: mergedAssertions,
                        refreshedAt: new Date(now).toISOString(),
                    };
                    const nextRevision = manifestRevision(nextManifest);
                    options.beforeManifestCommit?.(nextManifest);
                    this.#rememberInventory(run.manifest);
                    const updatedPriorReceipt = run.receipt ? {
                        ...run.receipt,
                        manifestRevision: run.receipt.manifestRevision !== undefined ? nextRevision : undefined,
                    } : undefined;
                    this.#db.prepare("UPDATE people_learning_runs SET manifest=?,receipt=?,status='partial',coverage=?,reopened_revision=? WHERE id=?")
                        .run(JSON.stringify(nextManifest), updatedPriorReceipt ? JSON.stringify(updatedPriorReceipt) : null, JSON.stringify(updatedPriorReceipt ? verifyLearningCoverage(nextManifest, updatedPriorReceipt, now) : { missing: ["receipt"] }), nextRevision, id);
                    this.#rememberInventory(nextManifest);
                    run = {
                        ...run,
                        manifest: nextManifest,
                        manifestRevision: nextRevision,
                        receipt: updatedPriorReceipt,
                        status: "partial",
                        reopenedRevision: nextRevision,
                    };
                }
            }
            const patchForMerge = assertionsExpanded && patch.manifestRevision !== undefined
                ? { ...patch, manifestRevision: run.manifestRevision }
                : patch;
            const mergedExpectedRevision = assertionsExpanded
                ? (expectedManifestRevision !== undefined ? run.manifestRevision : undefined)
                : expectedManifestRevision;
            const receipt = this.#mergeReceipt(run.receipt, patchForMerge, mergedExpectedRevision);
            const coverage = verifyLearningCoverage(run.manifest, receipt, now);
            coverage.errors.push(...checkSaves?.(receipt, run.manifest) ?? []);
            if (coverage.errors.length)
                coverage.status = "invalid";
            const needsFinalize = Boolean(finalize && (options?.shouldFinalize ? options.shouldFinalize(run.manifest) : true));
            if (coverage.status === "complete" && needsFinalize) {
                coverage.status = "partial";
                coverage.unresolved.push("dossier-verification");
            }
            const receiptId = jsonHash([id, receipt, now]);
            this.#db.prepare("INSERT INTO people_learning_receipts VALUES (?,?,?,?,?)")
                .run(receiptId, id, JSON.stringify(receipt), JSON.stringify(coverage), new Date(now).toISOString());
            if (coverage.status !== "invalid") {
                this.#db.prepare("UPDATE people_learning_runs SET receipt=?,status=?,coverage=? WHERE id=?")
                    .run(JSON.stringify(receipt), coverage.status, JSON.stringify(coverage), id);
            }
            if (coverage.unresolved.includes("dossier-verification")) {
                staged = {
                    manifest: JSON.stringify(run.manifest), receipt: JSON.stringify(receipt), coverage: JSON.stringify(coverage),
                };
                stagedManifest = run.manifest;
            }
            return { receiptId, manifestRevision: run.manifestRevision, ...coverage, backlog: this.backlog() };
        });
        if (!finalize || !staged || !stagedManifest || !result.unresolved.includes("dossier-verification"))
            return result;
        return this.#publishFinalized(id, staged, stagedManifest, result, finalize);
    }
}
