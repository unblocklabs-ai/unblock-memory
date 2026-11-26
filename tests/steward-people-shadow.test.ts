import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { immediateTransaction, openMemoryDatabase } from "../src/memory-database.js";
import { dossierAssertions, privateJson, type ReviewAssertion, type ReviewManifest } from "../src/people-learning-inventory.js";
import { PeopleLearningStore, type LearningReceipt } from "../src/people-learning-store.js";
import { reviewWindow } from "../src/people-learning-time.js";
import { PeopleStore, type PersonDossier } from "../src/people-store.js";
import { jsonHash } from "../src/json-hash.js";
import {
  buildPeopleShadowReport,
  PEOPLE_SHADOW_KIND,
  PEOPLE_SHADOW_PROPOSAL_SCHEMA,
  runPeopleShadowPass,
  type PeopleShadowArtifact,
  type PeopleShadowProposal,
} from "../src/steward-people-shadow.js";
import {
  activeBackgroundStewards,
  registerStewardRuntime,
  tryAcquireBackgroundSlot,
  type StewardCompleteRequest,
  type StewardCompleteResult,
  type StewardRunnerLike,
  type WorkItemLike,
  type WorkRef,
  type WorkStatus,
  type WorkStoreLike,
} from "../src/steward-runtime.js";

/* ───────────── Plan-schema WorkStore double (B1 lands the real one) ───────────── */

class WorkFenceLostError extends Error {}

class TestWorkStore implements WorkStoreLike {
  readonly db: DatabaseSync;
  readonly interrupts: string[] = [];
  constructor(path: string, readonly maxStrikes = 3, readonly onInterrupt?: () => void) {
    this.db = openMemoryDatabase(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS work_items (
      kind TEXT NOT NULL, scope TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('run','item')),
      status TEXT NOT NULL CHECK(status IN ('pending','running','staged','completed','quarantined')),
      attempt INTEGER NOT NULL DEFAULT 0, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL DEFAULT 0,
      input_revision TEXT, recipe_hash TEXT, stage TEXT,
      artifact_json TEXT CHECK(artifact_json IS NULL OR json_valid(artifact_json)),
      usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
      strikes INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY (kind, scope)) STRICT`);
  }
  close() { this.db.close(); }
  enqueue(input: { kind: string; scope: string; mode: "run" | "item"; inputRevision?: string; recipeHash?: string; requeue?: boolean }) {
    const existing = this.get(input.kind, input.scope);
    const now = Date.now();
    if (!existing) {
      this.db.prepare(`INSERT INTO work_items (kind,scope,mode,status,input_revision,recipe_hash,updated_at) VALUES (?,?,?,'pending',?,?,?)`)
        .run(input.kind, input.scope, input.mode, input.inputRevision ?? null, input.recipeHash ?? null, now);
    } else if (input.requeue || existing.inputRevision !== (input.inputRevision ?? null) || existing.recipeHash !== (input.recipeHash ?? null)) {
      this.db.prepare(`UPDATE work_items SET status='pending',stage=NULL,artifact_json=NULL,usage_json=NULL,strikes=0,owner=NULL,
        input_revision=?,recipe_hash=?,updated_at=? WHERE kind=? AND scope=?`)
        .run(input.inputRevision ?? null, input.recipeHash ?? null, now, input.kind, input.scope);
    }
    return this.get(input.kind, input.scope);
  }
  claim(input: { kind: string; scope?: string; owner: string; leaseMs: number; now?: number }): WorkRef | undefined {
    const now = input.now ?? Date.now();
    return immediateTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT attempt FROM work_items WHERE kind=? AND scope=? AND
        (status IN ('pending','staged') OR (status='running' AND lease_until<?))`).get(input.kind, input.scope!, now);
      if (!row) return undefined;
      const attempt = Number(row.attempt) + 1;
      this.db.prepare(`UPDATE work_items SET attempt=?,owner=?,lease_until=?,status='running',updated_at=? WHERE kind=? AND scope=?`)
        .run(attempt, input.owner, now + input.leaseMs, now, input.kind, input.scope!);
      return { kind: input.kind, scope: input.scope!, attempt, owner: input.owner };
    });
  }
  renew(ref: WorkRef, leaseMs: number) {
    return this.db.prepare("UPDATE work_items SET lease_until=? WHERE kind=? AND scope=? AND attempt=? AND status='running'")
      .run(Date.now() + leaseMs, ref.kind, ref.scope, ref.attempt).changes > 0;
  }
  stageArtifact(ref: WorkRef, stage: string, artifactJson: string, usageJson?: string) {
    const changes = this.db.prepare(`UPDATE work_items SET status='staged',stage=?,artifact_json=?,usage_json=?,strikes=0,updated_at=?
      WHERE kind=? AND scope=? AND attempt=? AND status='running'`)
      .run(stage, artifactJson, usageJson ?? null, Date.now(), ref.kind, ref.scope, ref.attempt).changes;
    if (!changes) throw new WorkFenceLostError("fence lost");
  }
  commitWithDomain<T>(db: DatabaseSync, ref: WorkRef, fn: () => T): T {
    assert.equal(db, this.db, "domain commit must share the WorkStore connection");
    return immediateTransaction(db, () => {
      const result = fn();
      const changes = db.prepare(`UPDATE work_items SET status='completed',owner=NULL,lease_until=0,updated_at=?
        WHERE kind=? AND scope=? AND attempt=? AND status IN ('running','staged')`).run(Date.now(), ref.kind, ref.scope, ref.attempt).changes;
      if (!changes) throw new WorkFenceLostError("fence lost");
      return result;
    });
  }
  fail(ref: WorkRef, error: string, options?: { strike?: boolean }) {
    const row = this.get(ref.kind, ref.scope);
    if (!row || row.attempt !== ref.attempt || row.status !== "running") throw new WorkFenceLostError("fence lost");
    const strikes = row.strikes + (options?.strike ? 1 : 0);
    const status: WorkStatus = row.mode === "item" && strikes >= this.maxStrikes ? "quarantined" : "pending";
    this.db.prepare("UPDATE work_items SET status=?,strikes=?,last_error=?,owner=NULL,lease_until=0,updated_at=? WHERE kind=? AND scope=?")
      .run(status, strikes, error, Date.now(), ref.kind, ref.scope);
  }
  interruptOwner(owner: string) {
    this.interrupts.push(owner);
    this.onInterrupt?.();
    return Number(this.db.prepare(`UPDATE work_items SET status=CASE WHEN stage IS NULL THEN 'pending' ELSE 'staged' END,
      owner=NULL,lease_until=0 WHERE owner=? AND status='running'`).run(owner).changes);
  }
  list(filter?: { kind?: string }) {
    return this.db.prepare("SELECT * FROM work_items WHERE (? IS NULL OR kind=?) ORDER BY kind, scope")
      .all(filter?.kind ?? null, filter?.kind ?? null).map(toItem);
  }
  get(kind: string, scope: string) {
    const row = this.db.prepare("SELECT * FROM work_items WHERE kind=? AND scope=?").get(kind, scope);
    return row ? toItem(row) : undefined;
  }
}

function toItem(row: Record<string, unknown>): WorkItemLike {
  const text = (value: unknown) => typeof value === "string" ? value : null;
  return {
    kind: String(row.kind), scope: String(row.scope), mode: row.mode as "item", status: row.status as WorkStatus,
    attempt: Number(row.attempt), owner: text(row.owner), leaseUntil: Number(row.lease_until), dueAt: Number(row.due_at),
    inputRevision: text(row.input_revision), recipeHash: text(row.recipe_hash), stage: text(row.stage),
    artifactJson: text(row.artifact_json), usageJson: text(row.usage_json), strikes: Number(row.strikes),
    lastError: text(row.last_error), updatedAt: Number(row.updated_at),
  };
}

/* ───────────── Fixture: real People + People Learning state ───────────── */

const claim = (statement: string, scope: string) => ({ statement, scope, reviewedAt: "2026-11-16T12:00:00Z",
  epistemicType: "reported" as const, evidence: [{ source: "manual" as const, locator: "/private/raw/locator/should-not-leak.json" }] });
const DOSSIER: PersonDossier = {
  schemaVersion: 1, blurb: "Mira leads launch planning at ExampleCo.", sections: [
    { category: "preferences", claims: [
      claim("Give the recommendation first.", "Status updates"),
      claim("Prefers async written updates.", "Weekly sync"),
      claim("Wants weekly Friday digests.", "Reporting"),
    ] },
    { category: "workingStyle", claims: [{ ...claim("Offer one next step when blocked.", "Blocked requests"),
      epistemicType: "agent_assessment" as const, expiresAt: "2026-11-23T12:00:00Z" }] },
  ],
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "people-shadow-"));
  const state = join(root, "agents", "main", "unblock-memory");
  mkdirSync(state, { recursive: true });
  const dbPath = join(state, "unblock-memory.sqlite");
  const exportRoot = join(state, "people-learning", "exports");
  const people = new PeopleStore(dbPath, { maxOpenTodos: 10, maxBlurbChars: 1200 });
  const mira = people.upsertIdentity({ provider: "slack", accountScope: "acct-a", externalId: "U1", displayName: "Mira" }).person;
  people.replaceDossier(mira.id, "Seed dossier", DOSSIER);
  const dossier = people.getDossier(mira.id)!.dossier;
  people.close();
  const assertions = dossierAssertions(mira.id, dossier);
  assert.equal(assertions.length, 5);

  const now = Date.now();
  const createdAt = new Date(now - 60 * 60_000).toISOString();
  const window = reviewWindow(now, "UTC", "nightly");
  const exported = (sessionId: string, accountId: string, messages: unknown[]) => {
    const value = { sessionId, sessionKey: `agent:main:slack:direct:${sessionId}`, conversationId: "D1", accountId, provider: "slack",
      chatType: "direct", window, messages, sourceRevision: jsonHash(messages) };
    const revision = jsonHash(value);
    return { sessionId, revision, file: privateJson(exportRoot, `${revision}.json`, value) };
  };
  const s1 = exported("s1", "acct-a", [
    { seq: 1, role: "user", personId: mira.id, accountScope: "acct-a", timestamp: now - 50 * 60_000, text: "Please always lead with the recommendation." },
    { seq: 2, role: "assistant", timestamp: now - 49 * 60_000, text: "Recommendation: ship Friday." },
    { seq: 3, role: "user", personId: "someone-else", accountScope: "acct-a", timestamp: now - 48 * 60_000, text: "SECRET-OTHER-PERSON" },
    { seq: 4, role: "assistant", timestamp: now - 47 * 60_000, text: "SECRET-OTHER-REPLY" },
    { seq: 5, role: "boundary", timestamp: now - 46 * 60_000 },
    { seq: 6, role: "user", personId: mira.id, accountScope: "acct-a", timestamp: now - 45 * 60_000, text: "Actually I now prefer live syncs over async updates." },
  ]);
  // Same person id but a different account: must never reach the model.
  const s2 = exported("s2", "acct-b", [
    { seq: 1, role: "user", personId: mira.id, accountScope: "acct-b", timestamp: now - 40 * 60_000, text: "SECRET-ACCT-B" },
  ]);
  // Outside the approved export root.
  const outsideDir = join(root, "elsewhere");
  mkdirSync(outsideDir);
  const outsideValue = { sessionId: "s3", accountId: "acct-a", provider: "slack", messages: [
    { seq: 1, role: "user", personId: mira.id, accountScope: "acct-a", text: "SECRET-OUTSIDE-ROOT" }] };
  const outsideFile = join(outsideDir, "s3.json");
  writeFileSync(outsideFile, JSON.stringify(outsideValue));
  const s3 = { sessionId: "s3", revision: jsonHash(outsideValue), file: outsideFile };

  const manifest: ReviewManifest = {
    id: `nightly:${window.localDay}`, agentId: "main", kind: "nightly", createdAt, window, fullValidation: true,
    roster: [{ personId: mira.id, name: "Mira", status: "active", injectionEnabled: true,
      identities: [{ provider: "slack", accountScope: "acct-a", externalId: "U1" }], sessionIds: ["s1", "s2", "s3"] }],
    assertions, sourceGaps: [], sessions: [s1, s2, s3],
  };
  const ledger = new PeopleLearningStore(dbPath, "main");
  const run = ledger.begin(manifest);
  const revision = run.manifestRevision;
  const review = (assertion: ReviewAssertion, disposition: "revalidated" | "corrected" | "retired" | "unresolved") => ({
    assertionId: assertion.id, disposition, reason: "Checked export", sourceRefs: ["s1"],
    reviewedAt: new Date(now - 30 * 60_000).toISOString(), correctionsCheckedAt: new Date(now - 30 * 60_000).toISOString(),
  });
  const checkpoint = (reviews: LearningReceipt["assertionReviews"]) => ledger.checkpoint(manifest.id, {
    manifestRevision: revision, peopleReviews: [], assertionReviews: reviews, sourceGapReviews: [],
    analysis: { status: "not_approved", reason: "test" }, changes: [], executionFollowups: [],
  } satisfies LearningReceipt, now, undefined, undefined, revision);
  return { root, dbPath, exportRoot, mira, assertions, manifest, revision, ledger, review, checkpoint, now,
    cleanup: () => { try { ledger.close(); } catch {} rmSync(root, { recursive: true, force: true }); } };
}

/** Records every write to production people tables made after installation. */
function installWriteAudit(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS shadow_write_audit (tbl TEXT NOT NULL, op TEXT NOT NULL)");
  for (const table of ["person_dossiers", "person_dossier_changes", "people_learning_runs", "people_learning_receipts",
    "people_learning_inventories", "people_learning_analysis", "people"]) {
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS audit_${table}_${op} AFTER ${op} ON ${table} BEGIN
        INSERT INTO shadow_write_audit VALUES ('${table}','${op}'); END`);
    }
  }
  const snapshot = () => jsonHash(["person_dossiers", "people_learning_runs", "people_learning_receipts"]
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  return {
    writes: () => db.prepare("SELECT tbl, op FROM shadow_write_audit").all(),
    snapshot,
    close: () => { if (db.isOpen) db.close(); },
  };
}

type Decide = (prompt: string, handles: string[]) => PeopleShadowProposal;

function scriptedRunner(decide: Decide) {
  const prompts: string[] = [];
  const runner: StewardRunnerLike = {
    async complete<T>(request: StewardCompleteRequest): Promise<StewardCompleteResult<T>> {
      assert.equal(request.schema, PEOPLE_SHADOW_PROPOSAL_SCHEMA);
      const prompt = request.messages.map(m => m.content).join("\n");
      prompts.push(prompt);
      const handles = [...prompt.matchAll(/\[(ev_\d+)\]/gu)].map(match => match[1]!);
      return { value: decide(prompt, handles) as T, usage: { requests: 1, inputTokens: 200, outputTokens: 40 } };
    },
    async run() { throw new Error("people shadow uses complete only"); },
  };
  return { runner, prompts };
}

function handleFor(prompt: string, needle: string): string {
  const line = prompt.split("\n").find(l => l.includes(needle));
  assert.ok(line, `evidence containing ${needle}`);
  return /\[(ev_\d+)\]/u.exec(line)![1]!;
}

/* ───────────── Tests ───────────── */

test("shadow pass: opaque handles, rejected hallucinations, work_items-only writes, exact report vs cron", async t => {
  const f: Fixture = await fixture();
  t.after(f.cleanup);
  const [blurb, recFirst, asyncUpdates, fridayDigest, workingStyle] = f.assertions;
  // Cron already resolved the blurb before the shadow ran.
  f.checkpoint([f.review(blurb!, "revalidated")]);
  const audit = installWriteAudit(f.dbPath);
  t.after(audit.close);
  const before = audit.snapshot();

  const { runner, prompts } = scriptedRunner((prompt, handles) => {
    if (prompt.includes(recFirst!.statement)) return { disposition: "revalidated", reason: "Mira asked for it directly",
      citedHandles: [handleFor(prompt, "lead with the recommendation")], confidence: "high" };
    if (prompt.includes(asyncUpdates!.statement)) return { disposition: "corrected", proposedClaim: "Prefers live syncs over async updates.",
      reason: "Newer statement reverses it", citedHandles: [handleFor(prompt, "live syncs")], confidence: "medium" };
    if (prompt.includes(fridayDigest!.statement)) return { disposition: "retired", reason: "No longer referenced",
      citedHandles: [handles[0]!, handles[0]!], confidence: "low" };
    return { disposition: "revalidated", reason: "trust me", citedHandles: ["ev_99", "/etc/passwd"], confidence: "high" };
  });
  const store = new TestWorkStore(f.dbPath, 1);
  t.after(() => store.close());
  const result = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "steward:test",
    skipCronResolved: true });

  // Manifest read and enqueue: blurb skipped (cron-resolved), four item rows keyed by (manifest, person, assertion).
  assert.deepEqual(result.manifests, [{ manifestId: f.manifest.id, manifestRevision: f.revision, assertions: 4 }]);
  assert.equal(result.enqueued, 4);
  assert.equal(result.attempted, 4);
  assert.equal(result.completed, 3);
  assert.equal(result.rejected, 1);
  assert.equal(result.usage.requests, 4);
  assert.equal(result.usage.inputTokens, 800);
  const items = store.list({ kind: PEOPLE_SHADOW_KIND });
  assert.deepEqual(items.map(i => i.scope).sort(), [recFirst, asyncUpdates, fridayDigest, workingStyle]
    .map(a => `${f.manifest.id}:${f.mira.id}:${a!.id}`).sort());
  for (const item of items) {
    assert.equal(item.mode, "item");
    assert.equal(item.inputRevision, f.revision);
  }

  // Evidence packet: opaque handles only — no raw paths, other people, other accounts or outside-root files.
  assert.equal(prompts.length, 4);
  for (const prompt of prompts) {
    assert.match(prompt, /\[ev_1\]/u);
    for (const leak of [f.root, f.exportRoot, ".json", "SECRET-OTHER-PERSON", "SECRET-OTHER-REPLY", "SECRET-ACCT-B",
      "SECRET-OUTSIDE-ROOT", "should-not-leak", f.revision]) {
      assert.ok(!prompt.includes(leak), `prompt must not contain ${leak}`);
    }
    assert.equal([...prompt.matchAll(/\[ev_\d+\]/gu)].length, 3, "two Mira requests plus the in-exchange reply");
  }

  // Hallucinated handles rejected → no artifact, struck and (maxStrikes=1) quarantined.
  const rejected = store.get(PEOPLE_SHADOW_KIND, `${f.manifest.id}:${f.mira.id}:${workingStyle!.id}`)!;
  assert.equal(rejected.status, "quarantined");
  assert.equal(rejected.artifactJson, null);
  assert.match(rejected.lastError ?? "", /hallucinated_handles: ev_99, \/etc\/passwd/u);

  // Verified proposal lives ONLY in work_items.artifact_json, without file paths.
  const corrected = store.get(PEOPLE_SHADOW_KIND, `${f.manifest.id}:${f.mira.id}:${asyncUpdates!.id}`)!;
  assert.equal(corrected.status, "completed");
  const artifact = JSON.parse(corrected.artifactJson!) as PeopleShadowArtifact;
  assert.equal(artifact.proposal.disposition, "corrected");
  assert.equal(artifact.proposal.proposedClaim, "Prefers live syncs over async updates.");
  assert.equal(artifact.manifestRevision, f.revision);
  assert.deepEqual(artifact.evidence.map(e => [e.sessionId, e.seq]), [["s1", 6]]);
  assert.ok(!corrected.artifactJson!.includes(f.root), "artifact carries no filesystem paths");
  const retired = JSON.parse(store.get(PEOPLE_SHADOW_KIND, `${f.manifest.id}:${f.mira.id}:${fridayDigest!.id}`)!.artifactJson!) as PeopleShadowArtifact;
  assert.deepEqual(retired.proposal.citedHandles, ["ev_1"], "duplicate handles collapse");

  // Zero production side effects.
  assert.deepEqual(audit.writes(), [], "0 writes to person_dossiers / people_learning_* / people");
  assert.equal(audit.snapshot(), before);

  // Re-running is idempotent: completed/quarantined rows are not re-adjudicated.
  const again = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "steward:test",
    skipCronResolved: true });
  assert.equal(again.attempted, 0);
  assert.equal(prompts.length, 4);

  // Cron later reviews two of the shadowed assertions; compare side by side.
  audit.close();
  f.checkpoint([f.review(recFirst!, "revalidated"), f.review(asyncUpdates!, "revalidated")]);
  const report = buildPeopleShadowReport(f.dbPath, f.manifest.id);
  assert.deepEqual(report.manifests, [{ manifestId: f.manifest.id, manifestRevision: f.revision, cronReceipt: true }]);
  assert.equal(report.matched, 1, "recommendation-first: both revalidated");
  assert.equal(report.diverged, 1, "async updates: shadow corrected vs cron revalidated");
  assert.equal(report.shadowOnly, 1, "Friday digest: only the shadow decided");
  assert.equal(report.cronOnly, 1, "blurb: only the cron decided");
  assert.equal(report.quarantined, 1);
  assert.equal(report.pending, 0);
  assert.equal(report.agreementRate, 0.5);
  assert.deepEqual(report.divergences.map(d => [d.assertionId, d.shadow, d.cron]), [[asyncUpdates!.id, "corrected", "revalidated"]]);
  assert.deepEqual(report.cronOnlyItems.map(i => [i.assertionId, i.personId, i.cron]), [[blurb!.id, f.mira.id, "revalidated"]]);
  assert.equal(report.usageTotals.requests, 3, "usage of staged/completed proposals (rejected attempts store none)");
  assert.equal(report.usageTotals.outputTokens, 120);
  assert.deepEqual(buildPeopleShadowReport(f.dbPath, "weekly:none").manifests, [], "manifest filter is exact");
});

test("no approved evidence: host stages unresolved without a model call; cross-agent manifests are never read", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  // Break every export: s1 file tampered (revision mismatch) → no approved evidence anywhere.
  const tampered = f.manifest.sessions[0]!;
  writeFileSync(tampered.file, JSON.stringify({ sessionId: "s1", accountId: "acct-a", provider: "slack", messages: [] }));
  let calls = 0;
  const runner: StewardRunnerLike = { complete: async () => { calls += 1; throw new Error("must not be called"); },
    run: async () => { throw new Error("unused"); } };
  const store = new TestWorkStore(f.dbPath);
  t.after(() => store.close());
  const result = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o" });
  assert.equal(calls, 0);
  assert.equal(result.completed, 5);
  assert.ok(result.items.every(i => i.outcome === "host_unresolved"));
  const artifact = JSON.parse(store.list()[0]!.artifactJson!) as PeopleShadowArtifact;
  assert.equal(artifact.source, "host");
  assert.equal(artifact.proposal.disposition, "unresolved");

  // Cross-agent manifests are never read.
  const foreign = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "other", workStore: store, runner, owner: "o" });
  assert.equal(foreign.enqueued, 0);
});

test("provider failure adds no strike; staged proposal resumes at publication without re-running the model", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const store = new TestWorkStore(f.dbPath, 1);
  t.after(() => store.close());
  const failing: StewardRunnerLike = {
    complete: async () => { throw Object.assign(new Error("429 rate limited"), { usage: { requests: 1 } }); },
    run: async () => { throw new Error("unused"); },
  };
  const failed = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner: failing, owner: "o", maxItems: 1 });
  assert.equal(failed.failed, 1);
  const first = store.list().find(item => item.lastError)!;
  assert.equal(first.status, "pending", "rate limits never quarantine");
  assert.equal(first.strikes, 0);

  // Simulate a crash after staging: claim + stage, never commit.
  const ref = store.claim({ kind: PEOPLE_SHADOW_KIND, scope: first.scope, owner: "crashed", leaseMs: 1, now: 0 })!;
  const staged: PeopleShadowArtifact = { schemaVersion: 1, manifestId: f.manifest.id, manifestRevision: f.revision,
    personId: f.mira.id, assertionId: first.scope.split(":").at(-1)!, source: "model", evidence: [], proposedAt: new Date().toISOString(),
    proposal: { disposition: "unresolved", reason: "staged before crash", citedHandles: [], confidence: "low" } };
  store.stageArtifact(ref, "proposal", JSON.stringify(staged), JSON.stringify({ requests: 1 }));
  let calls = 0;
  const { runner } = scriptedRunner((_prompt, handles) => { calls += 1; return { disposition: "revalidated", reason: "ok",
    citedHandles: [handles[0]!], confidence: "medium" }; });
  const counted: StewardRunnerLike = runner;
  const resumed = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner: counted, owner: "o2" });
  assert.equal(resumed.items.find(i => i.scope === first.scope)?.outcome, "resumed");
  assert.equal(calls, 4, "the staged item did not spend another model call");
  assert.equal(JSON.parse(store.get(PEOPLE_SHADOW_KIND, first.scope)!.artifactJson!).proposal.reason, "staged before crash");
  assert.equal(store.get(PEOPLE_SHADOW_KIND, first.scope)!.status, "completed");
});

test("background slots are process-wide and single-use releases", () => {
  const release = tryAcquireBackgroundSlot(1)!;
  assert.ok(release);
  assert.equal(tryAcquireBackgroundSlot(1), undefined, "second background steward waits");
  assert.equal(activeBackgroundStewards(), 1);
  release();
  release();
  assert.equal(activeBackgroundStewards(), 0, "double release never underflows");
  const again = tryAcquireBackgroundSlot(1)!;
  again();
});

test("gateway_stop interrupts the owner synchronously before aborting: 0 strikes, slot released, CLI registered", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const order: string[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const cliNames: string[] = [];
  const api = {
    registrationMode: "full",
    config: {},
    logger: { warn: (message: string) => order.push(`warn:${message}`), info: () => {}, error: () => {}, debug: () => {} },
    on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); },
    registerCli: (_register: unknown, options: { descriptors: { name: string }[] }) => { cliNames.push(...options.descriptors.map(d => d.name)); },
  } as unknown as OpenClawPluginApi;
  let entered!: () => void;
  const inFlight = new Promise<void>(resolve => { entered = resolve; });
  const blocking: StewardRunnerLike = {
    complete: request => new Promise((_resolve, reject) => {
      request.signal!.addEventListener("abort", () => { order.push("abort"); reject(request.signal!.reason); }, { once: true });
      entered();
    }),
    run: async () => { throw new Error("unused"); },
  };
  const stores: TestWorkStore[] = [];
  const runtime = registerStewardRuntime(api, {
    config: { enabled: true, peopleShadow: { enabled: true }, intervalMinutes: 60 },
    createRunner: () => blocking,
    openWorkStore: path => { const store = new TestWorkStore(path, 1, () => order.push("interrupt")); stores.push(store); return store; },
    dbPathForAgent: () => f.dbPath,
    listAgents: () => ["main"],
    shutdownGraceMs: 1_000,
  });
  assert.deepEqual(cliNames, ["memory-steward"]);
  assert.ok(handlers.has("gateway_start") && handlers.has("gateway_stop"));
  handlers.get("gateway_start")!();
  await inFlight;
  assert.equal(activeBackgroundStewards(), 1);
  await handlers.get("gateway_stop")!();
  assert.deepEqual(order.slice(0, 2), ["interrupt", "abort"], "interruptOwner runs before in-flight calls are aborted");
  assert.equal(stores[0]!.interrupts[0], runtime.owner);
  assert.equal(activeBackgroundStewards(), 0);
  const result = runtime.lastResults().get("main")!;
  assert.equal(result.interrupted, true);
  // Inspect persisted rows through a fresh connection: graceful stop added zero strikes and nothing quarantined.
  const check = new TestWorkStore(f.dbPath);
  t.after(() => check.close());
  const rows = check.list({ kind: PEOPLE_SHADOW_KIND });
  assert.equal(rows.length, 5);
  assert.ok(rows.every(row => row.strikes === 0 && row.status === "pending" && row.owner === null));
  assert.ok(!order.some(entry => entry.startsWith("warn:")), "graceful stop is not logged as a failure");
});

test("disabled runtime registers only the CLI", () => {
  const events: string[] = [];
  const api = { registrationMode: "full", config: {}, logger: { warn() {} },
    on: (event: string) => events.push(event), registerCli: () => {} } as unknown as OpenClawPluginApi;
  const runtime = registerStewardRuntime(api, { config: { enabled: true, peopleShadow: { enabled: false } },
    createRunner: () => undefined, openWorkStore: () => { throw new Error("unused"); } });
  assert.equal(runtime.enabled, false);
  assert.deepEqual(events, []);
});
