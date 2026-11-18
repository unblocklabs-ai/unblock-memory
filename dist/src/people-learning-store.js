import { Type } from "typebox";
import { Value } from "typebox/value";
import { openMemoryDatabase, immediateTransaction } from "./memory-database.js";
import { jsonHash } from "./json-hash.js";
import { reviewWindow, shiftDate } from "./people-learning-time.js";
const text = Type.String({ pattern: "\\S" });
const verification = { reason: text, sourceRefs: Type.Array(text), reviewedAt: text };
export const LEARNING_RECEIPT_SCHEMA = Type.Object({
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
export function verifyLearningCoverage(manifest, receipt, now = Date.now()) {
    const missing = [], errors = [], unresolved = [];
    const unresolvedGaps = manifest.sourceGaps.filter(g => !receipt.sourceGapReviews.some(r => r.sourceGapId === g.id && r.status === "resolved"));
    if (manifest.inventoryPending)
        missing.push("inventory");
    const map = (items, key, known) => {
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
            !Number.isFinite(date) || date < Date.parse(manifest.createdAt) || date > now)
            errors.push(`Missing actual source verification: ${id}`);
    };
    const people = map(receipt.peopleReviews, r => r.personId, new Set(manifest.roster.map(p => p.personId)));
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
                if (unresolvedGaps.length)
                    unresolved.push(`activity-unknown:${person.personId}`);
            }
            else {
                verified(review, person.personId);
                for (const id of person.sessionIds)
                    if (!review.sessionIds.includes(id))
                        missing.push(`session:${person.personId}:${id}`);
                if (review.sessionIds.some(id => !person.sessionIds.includes(id)))
                    errors.push(`Wrong session attribution: ${person.personId}`);
            }
        }
    const assertions = map(receipt.assertionReviews, r => r.assertionId, new Set(manifest.assertions.map(a => a.id)));
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
        if (!Number.isFinite(corrected) || corrected < Date.parse(manifest.createdAt) || corrected > now)
            errors.push(`Missing newer-correction research: ${assertion.id}`);
    }
    const gaps = map(receipt.sourceGapReviews, r => r.sourceGapId, new Set(manifest.sourceGaps.map(g => g.id)));
    for (const gap of manifest.sourceGaps) {
        const review = gaps.get(gap.id);
        if (review?.status === "resolved")
            verified(review, gap.id);
        else
            unresolved.push(`source:${gap.id}`);
    }
    if (receipt.analysis.status === "unresolved")
        unresolved.push("analysis");
    return { status: errors.length ? "invalid" : missing.length || unresolved.length ? "partial" : "complete",
        expectedPeople: manifest.kind === "nightly" ? manifest.roster.length : 0,
        expectedSessions: manifest.sessions.length, expectedAssertions: manifest.assertions.length, missing, errors, unresolved };
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
        id TEXT PRIMARY KEY, manifest TEXT NOT NULL, receipt TEXT, status TEXT NOT NULL, coverage TEXT NOT NULL
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
        this.#db.prepare("INSERT OR IGNORE INTO people_learning_owner VALUES (1,?)").run(agentId);
        const owner = this.#db.prepare("SELECT agent_id FROM people_learning_owner").get();
        if (owner && owner.agent_id !== agentId) {
            this.#db.close();
            throw new Error("People learning state belongs to another agent");
        }
    }
    close() { this.#db.close(); }
    recordAnalysis(id, status, result, basis) {
        if (!this.get(id))
            throw new Error("Unknown review run");
        this.#db.prepare(`INSERT INTO people_learning_analysis VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
      status=excluded.status,result=excluded.result,checked_at=excluded.checked_at`)
            .run(id, status, JSON.stringify({ basis, result }), new Date().toISOString());
    }
    analysis(id) { return this.#db.prepare("SELECT status,checked_at,json_extract(result,'$.basis') basis FROM people_learning_analysis WHERE run_id=?").get(id); }
    begin(manifest) {
        if (manifest.agentId !== this.agentId)
            throw new Error("Cross-agent review manifest");
        return immediateTransaction(this.#db, () => {
            const previous = this.get(manifest.id);
            const remember = (snapshot) => this.#db.prepare("INSERT OR IGNORE INTO people_learning_inventories VALUES (?,?,?,?)")
                .run(jsonHash(snapshot), snapshot.id, JSON.stringify(snapshot), snapshot.refreshedAt ?? snapshot.createdAt);
            if (previous)
                remember(previous.manifest);
            if (previous && !manifest.inventoryPending) {
                const prior = previous.manifest;
                if (prior.kind !== manifest.kind || JSON.stringify(prior.window) !== JSON.stringify(manifest.window))
                    throw new Error("Review window changed");
                const missingSessions = prior.sessions.filter(s => !manifest.sessions.some(next => next.sessionId === s.sessionId));
                const sessions = [...manifest.sessions, ...missingSessions];
                const sourceGaps = [...manifest.sourceGaps, ...missingSessions.map(s => ({
                        id: jsonHash(["missing-session", s.sessionId]), sessionId: s.sessionId,
                        reason: "Previously inventoried session is no longer readable; preserve original export and verify source",
                    }))];
                const roster = [...new Map([...prior.roster, ...manifest.roster].map(person => {
                        const old = prior.roster.find(p => p.personId === person.personId);
                        return [person.personId, { ...person, sessionIds: [...new Set([...(old?.sessionIds ?? []), ...person.sessionIds])] }];
                    })).values()];
                const assertions = [...new Map([...prior.assertions, ...manifest.assertions].map(a => [a.id, a])).values()];
                const { refreshedAt: _incomingRefresh, ...incoming } = manifest;
                const next = { ...incoming, createdAt: prior.createdAt, fullValidation: prior.fullValidation || manifest.fullValidation,
                    roster, sessions, sourceGaps, assertions };
                const { refreshedAt: _oldRefresh, ...oldComparable } = prior;
                if (jsonHash(next) === jsonHash(oldComparable))
                    return previous;
                const sourcesChanged = jsonHash([prior.sessions, prior.sourceGaps, prior.roster]) !== jsonHash([sessions, sourceGaps, roster]);
                manifest = { ...next, refreshedAt: new Date(Date.now()).toISOString() };
                const receipt = previous.receipt ? { ...previous.receipt,
                    peopleReviews: sourcesChanged ? [] : previous.receipt.peopleReviews,
                    assertionReviews: sourcesChanged ? [] : previous.receipt.assertionReviews,
                    sourceGapReviews: sourcesChanged ? [] : previous.receipt.sourceGapReviews.filter(r => sourceGaps.some(g => g.id === r.sourceGapId)),
                    analysis: sourcesChanged ? { status: "unresolved", reason: "Source inventory changed; recheck analysis" } : previous.receipt.analysis,
                } : undefined;
                if (sourcesChanged)
                    this.#db.prepare("DELETE FROM people_learning_analysis WHERE run_id=?").run(manifest.id);
                this.#db.prepare("UPDATE people_learning_runs SET manifest=?,receipt=?,status='partial',coverage=? WHERE id=?")
                    .run(JSON.stringify(manifest), receipt ? JSON.stringify(receipt) : null, JSON.stringify(receipt ? verifyLearningCoverage(manifest, receipt) : { missing: ["receipt"] }), manifest.id);
            }
            else if (!previous) {
                this.#db.prepare(`INSERT INTO people_learning_runs VALUES (?,?,NULL,'partial',?)`)
                    .run(manifest.id, JSON.stringify(manifest), JSON.stringify({ missing: ["receipt"], unresolved: manifest.sourceGaps.map(g => g.id) }));
            }
            remember(manifest);
            return this.get(manifest.id);
        });
    }
    planMissedWindows(manifest) {
        const last = this.#db.prepare("SELECT id FROM people_learning_runs WHERE id LIKE ? ORDER BY id DESC LIMIT 1").get(`${manifest.kind}:%`);
        if (!last)
            return;
        const step = manifest.kind === "nightly" ? 1 : 7;
        let day = shiftDate(String(last.id).slice(manifest.kind.length + 1), step);
        while (day < manifest.window.localDay) {
            this.begin({ ...manifest, id: `${manifest.kind}:${day}`, inventoryPending: true,
                window: reviewWindow(Date.parse(manifest.createdAt), manifest.window.timezone, manifest.kind, day),
                roster: [], assertions: [], sessions: [], sourceGaps: [{ id: `inventory:${day}`, reason: "Missed scheduled window; inventory and review still required" }] });
            day = shiftDate(day, step);
        }
    }
    get(id) {
        const row = this.#db.prepare("SELECT * FROM people_learning_runs WHERE id=?").get(id);
        if (!row)
            return undefined;
        return { manifest: JSON.parse(String(row.manifest)),
            receipt: row.receipt ? Value.Parse(LEARNING_RECEIPT_SCHEMA, JSON.parse(String(row.receipt))) : undefined,
            status: String(row.status), coverage: JSON.parse(String(row.coverage)) };
    }
    backlog() {
        return this.#db.prepare("SELECT id,status,coverage FROM people_learning_runs WHERE status!='complete' ORDER BY id").all()
            .map(row => ({ id: String(row.id), status: String(row.status), coverage: JSON.parse(String(row.coverage)) }));
    }
    checkpoint(id, input, now = Date.now(), checkSaves, finalize) {
        const patch = Value.Parse(LEARNING_RECEIPT_SCHEMA, input);
        let staged;
        const result = immediateTransaction(this.#db, () => {
            const run = this.get(id);
            if (!run)
                throw new Error("Unknown review run");
            if (run.manifest.inventoryPending)
                throw new Error("Inventory the missed window before checkpointing it");
            const merge = (previous, next, key) => {
                if (new Set(next.map(key)).size !== next.length)
                    throw new Error("Duplicate review disposition");
                return [...new Map([...previous, ...next].map(row => [key(row), row])).values()];
            };
            const prior = run.receipt;
            const receipt = { ...patch,
                peopleReviews: merge(prior?.peopleReviews ?? [], patch.peopleReviews, r => r.personId),
                assertionReviews: merge(prior?.assertionReviews ?? [], patch.assertionReviews, r => r.assertionId),
                sourceGapReviews: merge(prior?.sourceGapReviews ?? [], patch.sourceGapReviews, r => r.sourceGapId),
                changes: merge(prior?.changes ?? [], patch.changes, r => r.changeId),
                executionFollowups: [...new Set([...(prior?.executionFollowups ?? []), ...patch.executionFollowups])] };
            const coverage = verifyLearningCoverage(run.manifest, receipt, now);
            coverage.errors.push(...checkSaves?.(receipt) ?? []);
            if (coverage.errors.length)
                coverage.status = "invalid";
            if (coverage.status === "complete" && finalize) {
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
            if (coverage.unresolved.includes("dossier-verification"))
                staged = {
                    manifest: JSON.stringify(run.manifest), receipt: JSON.stringify(receipt), coverage: JSON.stringify(coverage),
                };
            return { receiptId, ...coverage, backlog: this.backlog() };
        });
        if (!finalize || !result.unresolved.includes("dossier-verification"))
            return result;
        // PeopleStore uses a separate connection to this database. Persist pending
        // work before releasing our transaction; publish complete only after its
        // verification writes succeed. A crash/failure leaves resumable backlog.
        const pending = staged;
        try {
            finalize(result.receiptId);
        }
        catch {
            return result;
        }
        const { receiptId: _pendingId, backlog: _backlog, ...pendingCoverage } = result;
        const coverage = { ...pendingCoverage, status: "complete", unresolved: result.unresolved.filter(r => r !== "dossier-verification") };
        const receiptId = jsonHash([result.receiptId, "verified"]);
        const published = immediateTransaction(this.#db, () => {
            const updated = this.#db.prepare("UPDATE people_learning_runs SET status='complete',coverage=? WHERE id=? AND manifest=? AND receipt=? AND coverage=? AND status='partial'")
                .run(JSON.stringify(coverage), id, pending.manifest, pending.receipt, pending.coverage);
            if (!updated.changes)
                return false;
            this.#db.prepare("INSERT INTO people_learning_receipts VALUES (?,?,?,?,?)")
                .run(receiptId, id, pending.receipt, JSON.stringify(coverage), new Date(Date.now()).toISOString());
            return true;
        });
        return published ? { ...coverage, receiptId, backlog: this.backlog() } : { ...result, backlog: this.backlog() };
    }
}
