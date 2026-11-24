import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { openMemoryDatabase, immediateTransaction } from "./memory-database.js";
import type { ReviewManifest } from "./people-learning-inventory.js";
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
export type LearningReceipt = Static<typeof LEARNING_RECEIPT_SCHEMA>;

export type RecordAnalysisOptions = {
  expectedManifestRevision?: string;
  startedAt?: number;
  recordedAt?: number;
  generation?: number;
  sequence?: number;
  instanceId?: string;
};

type CoverageResult = ReturnType<typeof verifyLearningCoverage>;
type StagedCheckpoint = { manifest: string; receipt: string; coverage: string };
type StoredRunRow = {
  manifest: ReviewManifest;
  manifestRevision: string;
  receipt: LearningReceipt | undefined;
  status: string;
  coverage: unknown;
  reopenedRevision: string | null;
};

export function manifestRevision(manifest: ReviewManifest): string {
  return jsonHash(manifest);
}

export function verifyLearningCoverage(manifest: ReviewManifest, receipt: LearningReceipt, now = Date.now()) {
  const missing: string[] = [], errors: string[] = [], unresolved: string[] = [];
  const manifestCreatedAt = Date.parse(manifest.createdAt);
  const currentRevision = manifestRevision(manifest);
  if (receipt.manifestRevision !== undefined && receipt.manifestRevision !== currentRevision) {
    errors.push(`Stale manifest revision: expected ${currentRevision}, got ${receipt.manifestRevision}`);
  }
  if (manifest.inventoryPending) missing.push("inventory");
  const indexBy = <T>(items: T[], key: (item: T) => string, known: Set<string>) => {
    const result = new Map<string, T>();
    for (const item of items) {
      const id = key(item);
      if (result.has(id)) errors.push(`Duplicate disposition: ${id}`);
      if (!known.has(id)) errors.push(`Unknown disposition: ${id}`);
      result.set(id, item);
    }
    return result;
  };
  const verified = (value: { reason: string; sourceRefs: string[]; reviewedAt: string }, id: string) => {
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
    if (review?.status === "resolved") verified(review, gap.id);
    else {
      hasUnresolvedGaps = true;
      unresolved.push(`source:${gap.id}`);
    }
  }
  const people = indexBy(receipt.peopleReviews, r => r.personId, new Set(manifest.roster.map(p => p.personId)));
  if (manifest.kind === "nightly") for (const person of manifest.roster) {
    const review = people.get(person.personId);
    if (!review) { missing.push(`person:${person.personId}`); continue; }
    if (review.status === "unresolved") { unresolved.push(`person:${person.personId}`); continue; }
    if (review.status === "no_interactions") {
      if (person.sessionIds.length) errors.push(`Skipped interactions: ${person.personId}`);
      if (hasUnresolvedGaps) unresolved.push(`activity-unknown:${person.personId}`);
    } else {
      verified(review, person.personId);
      const reviewedSessions = new Set(review.sessionIds);
      const expectedSessions = new Set(person.sessionIds);
      for (const id of person.sessionIds) if (!reviewedSessions.has(id)) missing.push(`session:${person.personId}:${id}`);
      if (review.sessionIds.some(id => !expectedSessions.has(id))) errors.push(`Wrong session attribution: ${person.personId}`);
    }
  }
  const assertions = indexBy(receipt.assertionReviews, r => r.assertionId, new Set(manifest.assertions.map(a => a.id)));
  for (const assertion of manifest.assertions) {
    const review = assertions.get(assertion.id);
    if (!review) { missing.push(`assertion:${assertion.id}`); continue; }
    if (review.disposition === "unresolved") { unresolved.push(`assertion:${assertion.id}`); continue; }
    verified(review, assertion.id);
    const corrected = Date.parse(review.correctionsCheckedAt ?? "");
    if (!Number.isFinite(corrected) || corrected < manifestCreatedAt || corrected > now) {
      errors.push(`Missing newer-correction research: ${assertion.id}`);
    }
  }
  if (receipt.analysis.status === "unresolved") unresolved.push("analysis");
  return {
    status: errors.length ? "invalid" as const : missing.length || unresolved.length ? "partial" as const : "complete" as const,
    expectedPeople: manifest.kind === "nightly" ? manifest.roster.length : 0,
    expectedSessions: manifest.sessions.length,
    expectedAssertions: manifest.assertions.length,
    missing,
    errors,
    unresolved,
  };
}

export class PeopleLearningStore {
  readonly #db;
  constructor(path: string, readonly agentId: string) {
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
    if (owner && owner.agent_id !== agentId) { this.#db.close(); throw new Error("People learning state belongs to another agent"); }
  }
  close() { this.#db.close(); }

  recordAnalysis(
    id: string,
    status: "complete" | "unresolved",
    result: unknown,
    basis: string,
    options: RecordAnalysisOptions = {},
  ): { recorded: boolean; reason?: "manifest_changed" | "superseded" } {
    return immediateTransaction(this.#db, () => {
      const run = this.#getRunRow(id);
      if (!run) throw new Error("Unknown review run");
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
            if (options.generation < existingGen) return { recorded: false, reason: "superseded" };
          } else if (Number.isFinite(existingStartedAt) && startedAt !== existingStartedAt) {
            if (startedAt < existingStartedAt) return { recorded: false, reason: "superseded" };
          } else if (sameInstance && options.sequence !== undefined && existingSeq !== undefined && options.sequence < existingSeq) {
            return { recorded: false, reason: "superseded" };
          } else if (existing.basis === basis && existing.status === "complete" && status !== "complete") {
            return { recorded: false, reason: "superseded" };
          }
        }
      }
      this.#db.prepare(`INSERT INTO people_learning_analysis VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
        status=excluded.status,result=excluded.result,checked_at=excluded.checked_at`)
        .run(
          id,
          status,
          JSON.stringify({
            basis,
            manifestRevision: run.manifestRevision,
            startedAt,
            ...(options.generation !== undefined ? { generation: options.generation } : {}),
            ...(options.sequence !== undefined ? { sequence: options.sequence } : {}),
            ...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {}),
            result,
          }),
          new Date(recordedAt).toISOString(),
        );
      return { recorded: true };
    });
  }

  analysis(id: string) {
    return this.#db.prepare("SELECT status,checked_at,json_extract(result,'$.basis') basis FROM people_learning_analysis WHERE run_id=?").get(id);
  }

  begin(manifest: ReviewManifest, beforeCommit?: (manifest: ReviewManifest) => void) {
    if (manifest.agentId !== this.agentId) throw new Error("Cross-agent review manifest");
    return immediateTransaction(this.#db, () => {
      const previous = this.#getRunRow(manifest.id);
      const remember = (snapshot: ReviewManifest) => this.#db.prepare("INSERT OR IGNORE INTO people_learning_inventories VALUES (?,?,?,?)")
        .run(jsonHash(snapshot), snapshot.id, JSON.stringify(snapshot), snapshot.refreshedAt ?? snapshot.createdAt);
      if (previous && !manifest.inventoryPending) {
        const prior = previous.manifest;
        if (prior.kind !== manifest.kind || JSON.stringify(prior.window) !== JSON.stringify(manifest.window)) throw new Error("Review window changed");
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
          remember(previous.manifest);
          return this.#toPublicRun(previous);
        }
        const sourcesChanged = jsonHash([prior.sessions, prior.sourceGaps, prior.roster]) !== jsonHash([sessions, sourceGaps, roster]);
        const nextManifest: ReviewManifest = { ...next, refreshedAt: new Date(Date.now()).toISOString() };
        const nextRevision = manifestRevision(nextManifest);
        // Publish the manifest artifact BEFORE committing the ledger/run row pointing to it.
        beforeCommit?.(nextManifest);
        remember(previous.manifest);
        const gapIds = new Set(sourceGaps.map(g => g.id));
        const receipt = previous.receipt ? {
          ...previous.receipt,
          manifestRevision: sourcesChanged
            ? undefined
            : previous.receipt.manifestRevision !== undefined ? nextRevision : undefined,
          peopleReviews: sourcesChanged ? [] : previous.receipt.peopleReviews,
          assertionReviews: sourcesChanged ? [] : previous.receipt.assertionReviews,
          sourceGapReviews: sourcesChanged ? [] : previous.receipt.sourceGapReviews.filter(r => gapIds.has(r.sourceGapId)),
          analysis: sourcesChanged ? { status: "unresolved" as const, reason: "Source inventory changed; recheck analysis" } : previous.receipt.analysis,
        } : undefined;
        const reopenedRevision = sourcesChanged && previous.receipt ? nextRevision : previous.reopenedRevision;
        if (sourcesChanged) this.#db.prepare("DELETE FROM people_learning_analysis WHERE run_id=?").run(nextManifest.id);
        this.#db.prepare("UPDATE people_learning_runs SET manifest=?,receipt=?,status='partial',coverage=?,reopened_revision=? WHERE id=?")
          .run(
            JSON.stringify(nextManifest),
            receipt ? JSON.stringify(receipt) : null,
            JSON.stringify(receipt ? verifyLearningCoverage(nextManifest, receipt) : { missing: ["receipt"] }),
            reopenedRevision,
            nextManifest.id,
          );
        remember(nextManifest);
      } else if (!previous) {
        // Publish the manifest artifact BEFORE committing the ledger/run row pointing to it.
        beforeCommit?.(manifest);
        this.#db.prepare("INSERT INTO people_learning_runs (id,manifest,receipt,status,coverage,reopened_revision) VALUES (?,?,NULL,'partial',?,NULL)")
          .run(manifest.id, JSON.stringify(manifest), JSON.stringify({ missing: ["receipt"], unresolved: manifest.sourceGaps.map(g => g.id) }));
        remember(manifest);
      } else {
        remember(previous.manifest);
        remember(manifest);
      }
      return this.get(manifest.id)!;
    });
  }

  planMissedWindows(manifest: ReviewManifest) {
    const last = this.#db.prepare("SELECT id FROM people_learning_runs WHERE id LIKE ? ORDER BY id DESC LIMIT 1").get(`${manifest.kind}:%`);
    if (!last) return;
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

  #getRunRow(id: string): StoredRunRow | undefined {
    const row = this.#db.prepare("SELECT id,manifest,receipt,status,coverage,reopened_revision FROM people_learning_runs WHERE id=?").get(id);
    if (!row) return undefined;
    const manifest = JSON.parse(String(row.manifest)) as ReviewManifest;
    return {
      manifest,
      manifestRevision: manifestRevision(manifest),
      receipt: row.receipt ? Value.Parse(LEARNING_RECEIPT_SCHEMA, JSON.parse(String(row.receipt))) : undefined,
      status: String(row.status),
      coverage: JSON.parse(String(row.coverage)) as unknown,
      reopenedRevision: typeof row.reopened_revision === "string" ? row.reopened_revision : null,
    };
  }

  #toPublicRun(row: StoredRunRow) {
    return {
      manifest: row.manifest,
      manifestRevision: row.manifestRevision,
      receipt: row.receipt,
      status: row.status,
      coverage: row.coverage,
    };
  }

  matchesRevision(id: string, expectedRevision?: string): boolean {
    const row = this.#getRunRow(id);
    if (!row) return false;
    if (expectedRevision !== undefined) return expectedRevision === row.manifestRevision;
    return row.reopenedRevision === null;
  }

  get(id: string) {
    const row = this.#getRunRow(id);
    return row ? this.#toPublicRun(row) : undefined;
  }

  backlog() {
    return this.#db.prepare("SELECT id,status,coverage FROM people_learning_runs WHERE status!='complete' ORDER BY id").all()
      .map(row => ({ id: String(row.id), status: String(row.status), coverage: JSON.parse(String(row.coverage)) as unknown }));
  }

  #mergeReceipt(prior: LearningReceipt | undefined, patch: LearningReceipt, expectedManifestRevision?: string): LearningReceipt {
    const merge = <T>(previous: T[], next: T[], key: (row: T) => string) => {
      if (new Set(next.map(key)).size !== next.length) throw new Error("Duplicate review disposition");
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

  #publishFinalized(
    id: string,
    pending: StagedCheckpoint,
    result: { receiptId: string; manifestRevision: string; backlog: ReturnType<PeopleLearningStore["backlog"]> } & CoverageResult,
    finalize: (receiptId: string) => void,
  ) {
    // PeopleStore uses a separate connection to this database. Persist pending
    // work before releasing our transaction; publish complete only after its
    // verification writes succeed. A crash/failure leaves resumable backlog.
    try { finalize(result.receiptId); }
    catch { return result; }
    const { receiptId: _pendingId, manifestRevision: revision, backlog: _backlog, ...pendingCoverage } = result;
    const coverage = { ...pendingCoverage, status: "complete" as const, unresolved: result.unresolved.filter(r => r !== "dossier-verification") };
    const receiptId = jsonHash([result.receiptId, "verified"]);
    const published = immediateTransaction(this.#db, () => {
      const updated = this.#db.prepare("UPDATE people_learning_runs SET status='complete',coverage=? WHERE id=? AND manifest=? AND receipt=? AND coverage=? AND status='partial'")
        .run(JSON.stringify(coverage), id, pending.manifest, pending.receipt, pending.coverage);
      if (!updated.changes) return false;
      this.#db.prepare("INSERT INTO people_learning_receipts VALUES (?,?,?,?,?)")
        .run(receiptId, id, pending.receipt, JSON.stringify(coverage), new Date(Date.now()).toISOString());
      return true;
    });
    return published ? { ...coverage, receiptId, manifestRevision: revision, backlog: this.backlog() } : { ...result, backlog: this.backlog() };
  }

  checkpoint(
    id: string,
    input: unknown,
    now = Date.now(),
    checkSaves?: (receipt: LearningReceipt) => string[],
    finalize?: (receiptId: string) => void,
    expectedManifestRevision?: string,
  ) {
    const patch = Value.Parse(LEARNING_RECEIPT_SCHEMA, input);
    let staged: StagedCheckpoint | undefined;
    const result = immediateTransaction(this.#db, () => {
      const run = this.#getRunRow(id);
      if (!run) throw new Error("Unknown review run");
      if (run.manifest.inventoryPending) throw new Error("Inventory the missed window before checkpointing it");
      const revisionErrors: string[] = [];
      if (expectedManifestRevision !== undefined && patch.manifestRevision !== undefined &&
          expectedManifestRevision !== patch.manifestRevision) {
        revisionErrors.push(`Conflicting manifest revision: ${expectedManifestRevision} vs ${patch.manifestRevision}`);
      }
      const suppliedRevision = expectedManifestRevision ?? patch.manifestRevision;
      if (suppliedRevision !== undefined && suppliedRevision !== run.manifestRevision) {
        revisionErrors.push(`Stale manifest revision: expected ${run.manifestRevision}, got ${suppliedRevision}`);
      } else if (suppliedRevision === undefined && run.reopenedRevision !== null) {
        revisionErrors.push(`Manifest was refreshed after prior checkpoint; provide current manifestRevision ${run.manifestRevision}`);
      }
      if (revisionErrors.length) {
        const coverage: CoverageResult = {
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
      const receipt = this.#mergeReceipt(run.receipt, patch, expectedManifestRevision);
      const coverage = verifyLearningCoverage(run.manifest, receipt, now);
      coverage.errors.push(...checkSaves?.(receipt) ?? []);
      if (coverage.errors.length) coverage.status = "invalid";
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
      if (coverage.unresolved.includes("dossier-verification")) staged = {
        manifest: JSON.stringify(run.manifest), receipt: JSON.stringify(receipt), coverage: JSON.stringify(coverage),
      };
      return { receiptId, manifestRevision: run.manifestRevision, ...coverage, backlog: this.backlog() };
    });
    if (!finalize || !staged || !result.unresolved.includes("dossier-verification")) return result;
    return this.#publishFinalized(id, staged, result, finalize);
  }
}
