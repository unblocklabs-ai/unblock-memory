import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { dossierAssertions, privateJson, type ReviewAssertion, type ReviewManifest } from "../src/people-learning-inventory.js";
import { PeopleLearningStore, type LearningReceipt } from "../src/people-learning-store.js";
import { reviewWindow } from "../src/people-learning-time.js";
import { PeopleStore, type PersonDossier } from "../src/people-store.js";
import { jsonHash } from "../src/json-hash.js";
import {
  buildPeopleShadowReport,
  PEOPLE_INTERACTION_SCHEMA,
  PEOPLE_INTERACTIONS_KIND,
  PEOPLE_SHADOW_KIND,
  PEOPLE_SHADOW_PROPOSAL_SCHEMA,
  runPeopleShadowPass,
  type PeopleInteractionArtifact,
  type PeopleInteractionResult,
  type PeopleShadowArtifact,
  type PeopleShadowProposal,
} from "../src/steward-people-shadow.js";
import { resolveStewardConfig } from "../src/steward-config.js";
import type { StewardCompleteRequest, StewardCompleteResult, StewardRunner } from "../src/steward-runner.js";
import { activeBackgroundStewards, registerStewardRuntime, tryAcquireBackgroundSlot } from "../src/steward-runtime.js";
import { WorkStore } from "../src/work-store.js";

type CompleteRunner = Pick<StewardRunner, "complete">;

/** The real fenced WorkStore, recording graceful interrupts so tests can assert their ordering. */
class RecordingWorkStore extends WorkStore {
  readonly interrupts: string[] = [];
  constructor(path: string, readonly onInterrupt?: () => void) { super(path); }
  override interruptOwner(owner: string, now?: number): number {
    this.interrupts.push(owner);
    this.onInterrupt?.();
    return super.interruptOwner(owner, now);
  }
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

async function fixture(options: { sessionIds?: string[]; withoutAssertions?: boolean; secondPerson?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "people-shadow-"));
  const state = join(root, "agents", "main", "unblock-memory");
  mkdirSync(state, { recursive: true });
  const dbPath = join(state, "unblock-memory.sqlite");
  const exportRoot = join(state, "people-learning", "exports");
  const people = new PeopleStore(dbPath, { maxOpenTodos: 10, maxBlurbChars: 1200 });
  const mira = people.upsertIdentity({ provider: "slack", accountScope: "acct-a", externalId: "U1", displayName: "Mira" }).person;
  people.replaceDossier(mira.id, "Seed dossier", DOSSIER);
  const dossier = people.getDossier(mira.id)!.dossier;
  const bo = options.secondPerson
    ? people.upsertIdentity({ provider: "slack", accountScope: "acct-a", externalId: "U2", displayName: "Bo" }).person : undefined;
  if (bo) people.replaceDossier(bo.id, "Seed dossier", { schemaVersion: 1, blurb: "Bo runs QA.", sections: [] });
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

  const s4 = bo ? exported("s4", "acct-a", [
    { seq: 1, role: "user", personId: bo.id, accountScope: "acct-a", timestamp: now - 30 * 60_000, text: "SECRET-BO: I want release notes in bullets." },
  ]) : undefined;
  const sessionIds = options.sessionIds ?? ["s1", "s2", "s3"];
  const manifest: ReviewManifest = {
    id: `nightly:${window.localDay}`, agentId: "main", kind: "nightly", createdAt, window, fullValidation: true,
    roster: [{ personId: mira.id, name: "Mira", status: "active", injectionEnabled: true,
      identities: [{ provider: "slack", accountScope: "acct-a", externalId: "U1" }], sessionIds },
      ...(bo ? [{ personId: bo.id, name: "Bo", status: "active", injectionEnabled: true,
        identities: [{ provider: "slack", accountScope: "acct-a", externalId: "U2" }], sessionIds: ["s4"] }] : [])],
    assertions: options.withoutAssertions ? [] : assertions, sourceGaps: [],
    sessions: [...[s1, s2, s3].filter(s => sessionIds.includes(s.sessionId)), ...(s4 ? [s4] : [])],
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
  return { root, dbPath, exportRoot, mira, bo, assertions, manifest, revision, ledger, review, checkpoint, now,
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
type Learn = (prompt: string, handles: string[]) => PeopleInteractionResult;
const NO_NEWS: Learn = () => ({ status: "no_new_claims", proposals: [], summary: "Nothing durable and new" });

/** Assertion prompts go to `decide` (recorded in `prompts`); interaction-learning prompts go to `learn` (`learnPrompts`). */
function scriptedRunner(decide: Decide, learn: Learn = NO_NEWS) {
  const prompts: string[] = [];
  const learnPrompts: string[] = [];
  const runner: CompleteRunner = {
    async complete<T>(request: StewardCompleteRequest<T>): Promise<StewardCompleteResult<T>> {
      const prompt = request.userPrompt;
      const handles = [...prompt.matchAll(/\[(ev_\d+)\]/gu)].map(match => match[1]!);
      if (request.schema === PEOPLE_INTERACTION_SCHEMA) {
        learnPrompts.push(prompt);
        return { ok: true, data: learn(prompt, handles) as T, backend: "responses_api",
          usage: { requests: 1, inputTokens: 300, outputTokens: 60 } };
      }
      assert.equal(request.schema, PEOPLE_SHADOW_PROPOSAL_SCHEMA);
      prompts.push(prompt);
      return { ok: true, data: decide(prompt, handles) as T, backend: "responses_api",
        usage: { requests: 1, inputTokens: 200, outputTokens: 40 } };
    },
  };
  return { runner, prompts, learnPrompts };
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
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const result = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "steward:test",
    skipCronResolved: true, maxStrikes: 1 });

  // Manifest read and enqueue: blurb skipped (cron-resolved), four item rows keyed by (manifest, person, assertion).
  assert.deepEqual(result.manifests, [{ manifestId: f.manifest.id, manifestRevision: f.revision, assertions: 4 }]);
  assert.equal(result.enqueued, 4);
  assert.equal(result.attempted, 4);
  assert.equal(result.completed, 3);
  assert.equal(result.rejected, 1);
  assert.equal(result.usage.requests, 4);
  assert.equal(result.usage.inputTokens, 800);
  const items = store.list(PEOPLE_SHADOW_KIND);
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
    skipCronResolved: true, maxStrikes: 1 });
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
  assert.equal(report.usageTotals.requests, 4, "usage of every attempt, including the rejected one");
  assert.equal(report.usageTotals.outputTokens, 160);
  assert.deepEqual(buildPeopleShadowReport(f.dbPath, "weekly:none").manifests, [], "manifest filter is exact");
});

test("no approved evidence: host stages unresolved without a model call; cross-agent manifests are never read", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  // Break every export: s1 file tampered (revision mismatch) → no approved evidence anywhere.
  const tampered = f.manifest.sessions[0]!;
  writeFileSync(tampered.file, JSON.stringify({ sessionId: "s1", accountId: "acct-a", provider: "slack", messages: [] }));
  let calls = 0;
  const runner: CompleteRunner = { complete: async () => { calls += 1; throw new Error("must not be called"); } };
  const store = new WorkStore(f.dbPath);
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
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const failing: CompleteRunner = {
    complete: async () => ({ ok: false, code: "transient_provider", error: "Temporary provider failure", retryable: true,
      usage: { requests: 1 } }),
  };
  const failed = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner: failing, owner: "o",
    maxItems: 1, maxStrikes: 1 });
  assert.equal(failed.failed, 1);
  const first = store.list().find(item => item.lastError)!;
  assert.equal(first.status, "pending", "rate limits never quarantine");
  assert.equal(first.strikes, 0);

  // Simulate a crash after staging: claim + stage, never commit.
  const ref = store.claim({ kind: PEOPLE_SHADOW_KIND, scope: first.scope, owner: "crashed", leaseMs: 1, now: 0, ignoreDueAt: true })!;
  const staged: PeopleShadowArtifact = { schemaVersion: 1, manifestId: f.manifest.id, manifestRevision: f.revision,
    personId: f.mira.id, assertionId: first.scope.split(":").at(-1)!, source: "model", evidence: [], proposedAt: new Date().toISOString(),
    proposal: { disposition: "unresolved", reason: "staged before crash", citedHandles: [], confidence: "low" } };
  store.stageArtifact(ref, { stage: "proposal", artifactJson: JSON.stringify(staged), usageJson: JSON.stringify({ requests: 1 }), now: 0 });
  let calls = 0;
  const { runner } = scriptedRunner((_prompt, handles) => { calls += 1; return { disposition: "revalidated", reason: "ok",
    citedHandles: [handles[0]!], confidence: "medium" }; });
  const resumed = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o2" });
  assert.equal(resumed.items.find(i => i.scope === first.scope)?.outcome, "resumed");
  assert.equal(calls, 4, "the staged item did not spend another model call");
  assert.equal(JSON.parse(store.get(PEOPLE_SHADOW_KIND, first.scope)!.artifactJson!).proposal.reason, "staged before crash");
  assert.equal(store.get(PEOPLE_SHADOW_KIND, first.scope)!.status, "completed");
});

test("heartbeat keeps a slow model call's lease alive; a lost fence aborts the call instead of publishing", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const store = new WorkStore(f.dbPath);
  const rival = new WorkStore(f.dbPath);
  t.after(() => { store.close(); rival.close(); });
  const running = () => store.list(PEOPLE_SHADOW_KIND).find(item => item.status === "running")!;

  // Slow call outlives the 60ms lease several times over; renewals keep a rival owner out.
  const slow: CompleteRunner = {
    async complete<T>(request: StewardCompleteRequest<T>): Promise<StewardCompleteResult<T>> {
      const handle = /\[(ev_\d+)\]/u.exec(request.userPrompt)![1]!;
      const scope = running().scope;
      for (let i = 0; i < 4; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(rival.claim({ kind: PEOPLE_SHADOW_KIND, scope, owner: "rival", leaseMs: 60_000 }), undefined, "lease still live");
      }
      return { ok: true, backend: "host_llm", usage: { requests: 1 },
        data: { disposition: "revalidated", reason: "ok", citedHandles: [handle], confidence: "medium" } as T };
    },
  };
  const kept = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner: slow, owner: "o",
    maxItems: 1, leaseMs: 60, heartbeatMs: 10 });
  assert.equal(kept.completed, 1);
  assert.equal(kept.items.find(item => item.outcome === "completed")?.outcome, "completed");

  // A newer input revision resets the row mid-call: the heartbeat loses its fence and aborts the model call.
  let aborted = false;
  const reset: CompleteRunner = {
    complete: request => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("expected fence-lost abort")), 5_000);
      request.signal!.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        aborted = true;
        reject(request.signal!.reason);
      }, { once: true });
      const item = running();
      rival.enqueue({ kind: item.kind, scope: item.scope, mode: "item", inputRevision: "newer", recipeHash: item.recipeHash });
    }),
  };
  const lost = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner: reset, owner: "o",
    maxItems: 1, leaseMs: 60_000, heartbeatMs: 5 });
  assert.equal(aborted, true);
  assert.equal(lost.failed, 1);
  assert.ok(lost.items.some(item => item.outcome === "failed" && item.detail === "fence_lost"));
  assert.equal(store.list(PEOPLE_SHADOW_KIND).filter(item => item.inputRevision === "newer" && item.status === "pending").length, 1,
    "the fenced-out attempt published nothing over the reset row");
});

test("runner failures: invalid output strikes toward quarantine, missing credentials stop the pass without strikes", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  let calls = 0;
  const failWith = (code: "invalid_output" | "missing_credentials" | "auth_denied" | "transient_provider" | "lifecycle_reload" | "timeout"): CompleteRunner => ({
    complete: async () => { calls += 1; return { ok: false, code, error: code, retryable: false, usage: { requests: code === "invalid_output" ? 1 : 0 } }; },
  });
  const invalid = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner: failWith("invalid_output"),
    owner: "o", maxStrikes: 1 });
  assert.equal(invalid.failed, 5);
  assert.ok(store.list(PEOPLE_SHADOW_KIND).every(item => item.status === "quarantined" && item.strikes === 1));

  for (const item of store.list(PEOPLE_SHADOW_KIND)) assert.equal(store.requeue(item.kind, item.scope), true);
  calls = 0;
  const missing = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner: failWith("missing_credentials"),
    owner: "o", maxStrikes: 1 });
  assert.equal(calls, 1, "a systemic failure stops the pass after the first item");
  assert.equal(missing.failed, 1);
  assert.ok(store.list(PEOPLE_SHADOW_KIND).every(item => item.status === "pending" && item.strikes === 0));

  // Auth denial, rate limits/outages (after the runner's own retries) and host reloads stop the pass too.
  for (const code of ["auth_denied", "transient_provider", "lifecycle_reload"] as const) {
    calls = 0;
    const stopped = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner: failWith(code),
      owner: "o", maxStrikes: 1, maxItems: 10 });
    assert.equal(calls, 1, `${code} stops the pass instead of burning maxItems`);
    assert.equal(stopped.failed, 1);
    assert.ok(store.list(PEOPLE_SHADOW_KIND).every(item => item.strikes === 0), `${code} adds no strike`);
  }

  // A packet that keeps timing out is the item's problem: it strikes toward quarantine instead of looping forever.
  calls = 0;
  const slow = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner: failWith("timeout"),
    owner: "o", maxStrikes: 1 });
  assert.equal(calls, 5);
  assert.equal(slow.failed, 5);
  assert.ok(store.list(PEOPLE_SHADOW_KIND).every(item => item.status === "quarantined" && item.strikes === 1));
});

test("usage accumulates on the row across failed and successful attempts", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const failing: CompleteRunner = { complete: async () => ({ ok: false, code: "context_overflow", error: "too big", retryable: false,
    usage: { requests: 1, inputTokens: 50, outputTokens: 5 } }) };
  await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner: failing, owner: "o", maxItems: 1 });
  const scope = store.list(PEOPLE_SHADOW_KIND).find(item => item.lastError)!.scope;
  assert.deepEqual(JSON.parse(store.get(PEOPLE_SHADOW_KIND, scope)!.usageJson!), { requests: 1, inputTokens: 50, outputTokens: 5 },
    "a failed attempt's tokens are recorded");
  const { runner } = scriptedRunner((_prompt, handles) => ({ disposition: "revalidated", reason: "ok", citedHandles: [handles[0]!],
    confidence: "medium" }));
  await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o", maxItems: 1 });
  const row = store.get(PEOPLE_SHADOW_KIND, scope)!;
  assert.equal(row.status, "completed");
  assert.deepEqual(JSON.parse(row.usageJson!), { requests: 2, inputTokens: 250, outputTokens: 45 }, "both attempts are billed");
  const report = buildPeopleShadowReport(f.dbPath, f.manifest.id);
  assert.equal(report.usageTotals.requests, 2);
});

test("revision binding: claims, resumes and the report only use artifacts for the exact manifest revision", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  // The row's inputs advance between the pass reading it and claiming it: the bound claim refuses it.
  class RacingStore extends WorkStore {
    target?: string;
    override get(kind: string, scope: string) {
      const row = super.get(kind, scope);
      if (row && !this.target && row.status === "pending") {
        this.target = scope;
        this.enqueue({ kind, scope, mode: "item", inputRevision: "advanced", recipeHash: row.recipeHash });
      }
      return row;
    }
  }
  const racing = new RacingStore(f.dbPath);
  t.after(() => racing.close());
  const seen: string[] = [];
  const { runner } = scriptedRunner((prompt, handles) => { seen.push(prompt); return { disposition: "revalidated", reason: "ok",
    citedHandles: [handles[0]!], confidence: "medium" }; });
  const raced = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: racing, runner, owner: "o", maxItems: 1 });
  assert.equal(raced.items[0]?.scope, racing.target);
  assert.equal(raced.items[0]?.outcome, "busy", "a row whose revision advanced after it was read is never claimed");
  assert.equal(racing.get(PEOPLE_SHADOW_KIND, racing.target!)?.status, "pending");
  assert.equal(racing.get(PEOPLE_SHADOW_KIND, racing.target!)?.inputRevision, "advanced");

  // A staged artifact proposed against another revision is not resumed: the model re-adjudicates this revision.
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const scope = store.list(PEOPLE_SHADOW_KIND).find(item => item.inputRevision === f.revision && item.status === "completed")!.scope;
  assert.equal(store.requeue(PEOPLE_SHADOW_KIND, scope), true);
  const ref = store.claim({ kind: PEOPLE_SHADOW_KIND, scope, owner: "crashed", leaseMs: 1, now: 0, ignoreDueAt: true })!;
  const foreign: PeopleShadowArtifact = { schemaVersion: 1, manifestId: f.manifest.id, manifestRevision: "some-other-revision",
    personId: f.mira.id, assertionId: scope.split(":").at(-1)!, source: "model", evidence: [], proposedAt: new Date().toISOString(),
    proposal: { disposition: "retired", reason: "foreign revision", citedHandles: [], confidence: "low" } };
  store.stageArtifact(ref, { stage: "proposal", artifactJson: JSON.stringify(foreign), now: 0 });
  store.interruptOwner("crashed");
  const calls = seen.length;
  const resumed = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o2" });
  assert.notEqual(resumed.items.find(i => i.scope === scope)?.outcome, "resumed");
  assert.ok(seen.length > calls);
  const artifact = JSON.parse(store.get(PEOPLE_SHADOW_KIND, scope)!.artifactJson!) as PeopleShadowArtifact;
  assert.equal(artifact.manifestRevision, f.revision);
  assert.equal(artifact.proposal.disposition, "revalidated");

  // The report never compares an artifact whose embedded revision differs from the row's.
  const before = buildPeopleShadowReport(f.dbPath, f.manifest.id);
  store.db.prepare("UPDATE work_items SET artifact_json=json_set(artifact_json,'$.manifestRevision','tampered') WHERE kind=? AND scope=?")
    .run(PEOPLE_SHADOW_KIND, scope);
  const after = buildPeopleShadowReport(f.dbPath, f.manifest.id);
  assert.equal(after.pending, before.pending + 1);
  assert.equal(after.shadowOnly + after.matched + after.diverged, before.shadowOnly + before.matched + before.diverged - 1);
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
  const blocking: CompleteRunner = {
    complete: request => new Promise((_resolve, reject) => {
      request.signal!.addEventListener("abort", () => { order.push("abort"); reject(request.signal!.reason); }, { once: true });
      entered();
    }),
  };
  const stores: RecordingWorkStore[] = [];
  const runtime = registerStewardRuntime(api, {
    config: resolveStewardConfig({ enabled: true, peopleShadow: { enabled: true, mode: "shadow" }, captainsLog: { enabled: false } }),
    createRunner: () => blocking,
    openWorkStore: path => { const store = new RecordingWorkStore(path, () => order.push("interrupt")); stores.push(store); return store; },
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
  // Abort and interruptOwner happen in one synchronous step: the pass only observes the abort afterwards, so its
  // late fail() is fenced out and adds no strike, and shutdown never waits on the release.
  assert.deepEqual(order.slice(0, 2), ["abort", "interrupt"], "in-flight calls are aborted alongside interruptOwner");
  assert.equal(stores[0]!.interrupts[0], runtime.owner);
  assert.equal(activeBackgroundStewards(), 0);
  const result = runtime.lastResults().get("main")!;
  assert.equal(result.interrupted, true);
  // Inspect persisted rows through a fresh connection: graceful stop added zero strikes and nothing quarantined.
  const check = new WorkStore(f.dbPath);
  t.after(() => check.close());
  const rows = check.list(PEOPLE_SHADOW_KIND);
  assert.equal(rows.length, 5);
  assert.ok(rows.every(row => row.strikes === 0 && row.status === "pending" && row.owner === null));
  assert.ok(!order.some(entry => entry.startsWith("warn:")), "graceful stop is not logged as a failure");
});

test("disabled runtime registers only the CLI", () => {
  const events: string[] = [];
  const api = { registrationMode: "full", config: {}, logger: { warn() {} },
    on: (event: string) => events.push(event), registerCli: () => {} } as unknown as OpenClawPluginApi;
  const runtime = registerStewardRuntime(api, { config: resolveStewardConfig({ enabled: true, peopleShadow: { enabled: false }, captainsLog: { enabled: false },
    outcomeLedger: { enabled: false }, expectations: { enabled: false }, crystals: { enabled: false }, overnight: { enabled: false },
    skills: { enabled: false } }),
    createRunner: () => undefined, openWorkStore: () => { throw new Error("unused"); } });
  assert.equal(runtime.enabled, false);
  assert.deepEqual(events, []);
});

/* ───────────── Publish mode ───────────── */

const PUBLISH_DEFAULTS = { mode: "publish" as const, analysisApproved: false };

function dossierChanges(dbPath: string, personId: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT id, reason, before_dossier_json, after_dossier_json FROM person_dossier_changes WHERE person_id=? ORDER BY rowid")
      .all(personId) as { id: string; reason: string; before_dossier_json: string | null; after_dossier_json: string | null }[];
  } finally { db.close(); }
}

function readPeople(dbPath: string) {
  return new PeopleStore(dbPath, { maxOpenTodos: 10, maxBlurbChars: 1200 });
}

test("publish mode applies revalidated/corrected/retired to the dossier and checkpoints a LearningReceipt; unresolved and hallucinated stay untouched", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const [blurb, recFirst, asyncUpdates, fridayDigest, workingStyle] = f.assertions;
  const baseline = dossierChanges(f.dbPath, f.mira.id).length;
  const { runner } = scriptedRunner((prompt, handles) => {
    if (prompt.includes(recFirst!.statement)) return { disposition: "revalidated", reason: "Mira asked for it directly",
      citedHandles: [handleFor(prompt, "lead with the recommendation")], confidence: "high" };
    if (prompt.includes(asyncUpdates!.statement)) return { disposition: "corrected", proposedClaim: "Prefers live syncs over async updates.",
      reason: "Newer statement reverses it", citedHandles: [handleFor(prompt, "live syncs")], confidence: "medium" };
    if (prompt.includes(fridayDigest!.statement)) return { disposition: "retired", reason: "Digest request was withdrawn",
      citedHandles: [handles[0]!], confidence: "high" };
    if (prompt.includes(workingStyle!.statement)) return { disposition: "retired", reason: "trust me", citedHandles: ["ev_99"], confidence: "high" };
    return { disposition: "unresolved", reason: "Blurb is not addressed by the evidence", citedHandles: [], confidence: "low" };
  });
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const result = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store, runner,
    owner: "steward:publish", maxStrikes: 1 });
  assert.equal(result.mode, "publish");
  assert.deepEqual(result.published, { applied: 3, recorded: 0, skipped: 0, unresolved: 1 });
  assert.equal(result.rejected, 1, "hallucinated handle never publishes");

  // Dossier: exactly the three target claims changed; blurb, the hallucinated target and every other field preserved.
  const people = readPeople(f.dbPath);
  t.after(() => people.close());
  const dossier = people.getDossier(f.mira.id)!.dossier;
  assert.equal(dossier.blurb, DOSSIER.blurb);
  const preferences = dossier.sections.find(s => s.category === "preferences")!.claims;
  assert.deepEqual(preferences.map(c => c.statement), ["Give the recommendation first.", "Prefers live syncs over async updates."]);
  assert.notEqual(preferences[0]!.reviewedAt, DOSSIER.sections[0]!.claims[0]!.reviewedAt, "revalidation re-stamps reviewedAt");
  assert.deepEqual(preferences[0]!.evidence, DOSSIER.sections[0]!.claims[0]!.evidence, "revalidation keeps evidence (stable assertion id)");
  assert.equal(preferences[1]!.scope, "Weekly sync");
  assert.deepEqual(preferences[1]!.evidence.map(e => [e.source, e.locator]), [["session", "session:s1#6"]],
    "corrected claim cites exactly the verified handle's source");
  assert.deepEqual(dossier.sections.find(s => s.category === "workingStyle"), DOSSIER.sections[1], "rejected proposal: claim untouched");
  const changes = dossierChanges(f.dbPath, f.mira.id).slice(baseline);
  assert.equal(changes.length, 3);
  for (const change of changes) {
    assert.match(change.reason, /^Steward People Learning (revalidated|corrected|retired)/u);
    assert.match(change.reason, /sources: session:s1#\d+/u);
    assert.ok(!change.reason.includes(f.root), "audit reason carries no filesystem paths");
  }
  assert.equal(people.isDossierVerified(f.mira.id), false, "an unverified dossier is never marked verified by a partial review");

  // Receipt: live Steward completion in people_learning_runs, exact revision, dispositions, refs and change ids.
  assert.equal(result.checkpoints.length, 1);
  assert.equal(result.checkpoints[0]!.status, "partial");
  assert.deepEqual(result.checkpoints[0]!.errors, []);
  const run = f.ledger.get(f.manifest.id)!;
  assert.equal(run.status, "partial");
  const reviews = new Map(run.receipt!.assertionReviews.map(r => [r.assertionId, r]));
  assert.equal(reviews.get(blurb!.id)?.disposition, "unresolved");
  assert.equal(reviews.get(recFirst!.id)?.disposition, "revalidated");
  assert.equal(reviews.get(asyncUpdates!.id)?.disposition, "corrected");
  assert.deepEqual(reviews.get(asyncUpdates!.id)?.sourceRefs, ["session:s1#6"]);
  assert.ok(reviews.get(asyncUpdates!.id)?.correctionsCheckedAt);
  assert.equal(reviews.get(fridayDigest!.id)?.disposition, "retired");
  assert.equal(reviews.has(workingStyle!.id), false, "rejected proposals are never receipted");
  assert.deepEqual(new Set(run.receipt!.changes.map(c => c.changeId)), new Set(changes.map(c => c.id)));
  assert.equal(run.receipt!.analysis.status, "not_approved");
  // Interaction learning ran (no new claims), but s2 (other account) and s3 (outside the export root) were never
  // readable, so Steward never claims a complete interaction review it did not do.
  const miraReview = run.receipt!.peopleReviews.find(p => p.personId === f.mira.id)!;
  assert.equal(miraReview.status, "unresolved");
  assert.match(miraReview.reason, /no approved export for session\(s\) s2, s3/u);
  assert.deepEqual(result.learned, { applied: 0, recorded: 1, skipped: 0, unresolved: 0, claimsAdded: 0 });

  // Report shows live published status.
  const report = buildPeopleShadowReport(f.dbPath, f.manifest.id);
  assert.deepEqual(report.published, { applied: 3, recorded: 0, skipped: 0, unresolved: 1 });
  assert.equal(report.publishedItems.filter(i => i.changeId).length, 3);
  assert.deepEqual(report.runs.map(r => [r.manifestId, r.status]), [[f.manifest.id, "partial"]]);

  // Re-running never re-publishes resolved assertions or double-applies an edit.
  const quiet = scriptedRunner(() => ({ disposition: "unresolved", reason: "nothing new", citedHandles: [], confidence: "low" }));
  const again = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store,
    runner: quiet.runner, owner: "steward:publish", maxStrikes: 1 });
  assert.equal(again.published.applied, 0);
  for (const prompt of quiet.prompts) {
    for (const resolved of [recFirst, asyncUpdates, fridayDigest]) assert.ok(!prompt.includes(`Assertion: ${resolved!.statement}`));
  }
  assert.equal(dossierChanges(f.dbPath, f.mira.id).length - baseline, 3, "no second dossier revision");
  const after = f.ledger.get(f.manifest.id)!;
  assert.equal(new Map(after.receipt!.assertionReviews.map(r => [r.assertionId, r])).get(asyncUpdates!.id)?.disposition, "corrected",
    "a later unresolved pass never downgrades a resolved review");
});

test("publish mode: a fenced worker can never double-apply; the staged proposal resumes and publishes exactly once", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const asyncUpdates = f.assertions[2]!;
  const target = `${f.manifest.id}:${f.mira.id}:${asyncUpdates.id}`;
  const baseline = dossierChanges(f.dbPath, f.mira.id).length;
  /** Fences the target right after its proposal is staged, as a reclaim/interrupt would between stage and commit. */
  class FencingStore extends WorkStore {
    fenced?: WorkClaim;
    override stageArtifact(claim: WorkClaim, options: Parameters<WorkStore["stageArtifact"]>[1]) {
      const staged = super.stageArtifact(claim, options);
      if (claim.scope === target && !this.fenced) { this.fenced = staged; this.interruptOwner(claim.owner); }
      return staged;
    }
  }
  type WorkClaim = Parameters<WorkStore["stageArtifact"]>[0];
  const fencing = new FencingStore(f.dbPath);
  t.after(() => fencing.close());
  let calls = 0;
  const { runner } = scriptedRunner((prompt) => {
    calls += 1;
    return prompt.includes(asyncUpdates.statement)
      ? { disposition: "corrected", proposedClaim: "Prefers live syncs over async updates.", reason: "Newer statement",
          citedHandles: [handleFor(prompt, "live syncs")], confidence: "high" }
      : { disposition: "unresolved", reason: "n/a", citedHandles: [], confidence: "low" };
  });
  const first = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: fencing, runner, owner: "w1" });
  assert.deepEqual(first.items.find(i => i.scope === target), { scope: target, outcome: "staged", detail: "commit_fenced" });
  assert.equal(dossierChanges(f.dbPath, f.mira.id).length, baseline, "the fenced worker published nothing");
  assert.equal(fencing.get(PEOPLE_SHADOW_KIND, target)!.status, "staged");

  // The fenced claim stays dead even when replayed directly.
  assert.throws(() => fencing.commitWithDomain(fencing.fenced!, { keepArtifact: true }, () => assert.fail("domain must not run")),
    /fence lost/u);

  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const callsBefore = calls;
  const resumed = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "w2" });
  assert.equal(resumed.items.find(i => i.scope === target)?.outcome, "resumed");
  assert.equal(calls, callsBefore, "resume publishes the staged proposal without another model call");
  assert.equal(resumed.published.applied, 1);
  const changes = dossierChanges(f.dbPath, f.mira.id).slice(baseline);
  assert.equal(changes.length, 1, "published exactly once");
  const row = store.get(PEOPLE_SHADOW_KIND, target)!;
  assert.equal(row.status, "completed");
  const artifact = JSON.parse(row.artifactJson!) as PeopleShadowArtifact;
  assert.equal(artifact.publication?.status, "applied");
  assert.equal(artifact.publication?.changeId, changes[0]!.id, "the completed row records the exact revision it wrote");

  // Replaying the same edit in a later pass is a no-op: the row is completed and the receipt resolved it.
  await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "w3" });
  assert.equal(dossierChanges(f.dbPath, f.mira.id).length - baseline, 1);
});

test("publish mode never overwrites newer edits, skips low confidence and paused people, and records them as unresolved", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const [, recFirst, asyncUpdates, fridayDigest] = f.assertions;
  // A human edits the async-updates claim after the manifest was inventoried.
  const people = readPeople(f.dbPath);
  t.after(() => people.close());
  const edited = structuredClone(DOSSIER);
  edited.sections[0]!.claims[1] = { ...edited.sections[0]!.claims[1]!, statement: "Prefers async updates on Mondays." };
  people.replaceDossier(f.mira.id, "Human edit", edited);
  const humanRevision = people.getDossierRevision(f.mira.id);
  const { runner } = scriptedRunner((prompt, handles) => {
    if (prompt.includes(asyncUpdates!.statement)) return { disposition: "corrected", proposedClaim: "Prefers live syncs.",
      reason: "Newer statement", citedHandles: [handleFor(prompt, "live syncs")], confidence: "high" };
    if (prompt.includes(fridayDigest!.statement)) return { disposition: "retired", reason: "weak signal", citedHandles: [handles[0]!], confidence: "low" };
    if (prompt.includes(recFirst!.statement)) return { disposition: "revalidated", reason: "ok", citedHandles: [handles[0]!], confidence: "high" };
    return { disposition: "unresolved", reason: "n/a", citedHandles: [], confidence: "low" };
  });
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const result = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o",
    manifestIds: [f.manifest.id] });
  assert.equal(result.published.skipped, 2, "stale correction + low-confidence retirement");
  const current = people.getDossier(f.mira.id)!.dossier;
  assert.equal(current.sections[0]!.claims[1]!.statement, "Prefers async updates on Mondays.", "the newer human edit wins");
  assert.ok(current.sections[0]!.claims.some(c => c.statement === "Wants weekly Friday digests."), "low confidence never retires");
  const receipt = new Map(f.ledger.get(f.manifest.id)!.receipt!.assertionReviews.map(r => [r.assertionId, r]));
  assert.equal(receipt.get(asyncUpdates!.id)?.disposition, "unresolved");
  assert.match(receipt.get(asyncUpdates!.id)?.reason ?? "", /newer edits win/u);
  assert.equal(receipt.get(fridayDigest!.id)?.disposition, "unresolved");
  assert.equal(receipt.get(recFirst!.id)?.disposition, "revalidated");
  assert.notEqual(people.getDossierRevision(f.mira.id), humanRevision, "only the revalidation stamp was written on top");

  // Paused people are review-only: nothing is published for them.
  const g = await fixture();
  t.after(g.cleanup);
  const paused = readPeople(g.dbPath);
  paused.setInjection(g.mira.id, false);
  const before = dossierChanges(g.dbPath, g.mira.id).length;
  paused.close();
  const pausedStore = new WorkStore(g.dbPath);
  t.after(() => pausedStore.close());
  const all = scriptedRunner((_prompt, handles) => ({ disposition: "retired", reason: "x", citedHandles: [handles[0]!], confidence: "high" }));
  const skipped = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: g.dbPath, agentId: "main", workStore: pausedStore,
    runner: all.runner, owner: "o" });
  assert.equal(skipped.published.applied, 0);
  assert.equal(skipped.published.skipped, 5);
  assert.equal(dossierChanges(g.dbPath, g.mira.id).length, before);
});

test("shadow mode stays strictly read-only even with inventoryContext; publish mode inventories missing manifests itself", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const workspace = join(f.root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const { resolveConfig } = await import("../src/config.js");
  const inventoryContext = {
    cfg: { agents: { defaults: { workspace, userTimezone: "UTC" }, entries: { main: { workspace } } } },
    config: resolveConfig({ people: { enabled: true, whisperer: { enabled: true } } }),
    stateRoot: f.root,
  };
  const audit = installWriteAudit(f.dbPath);
  t.after(audit.close);
  const before = audit.snapshot();
  const { runner } = scriptedRunner((_prompt, handles) => ({ disposition: "retired", reason: "x", citedHandles: [handles[0]!], confidence: "high" }));
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const shadow = await runPeopleShadowPass({ mode: "shadow", inventoryContext, dbPath: f.dbPath, agentId: "main", workStore: store,
    runner, owner: "o" });
  assert.equal(shadow.mode, "shadow");
  assert.deepEqual(shadow.inventory, [], "shadow mode never inventories");
  assert.deepEqual(shadow.published, { applied: 0, recorded: 0, skipped: 0, unresolved: 0 });
  assert.deepEqual(shadow.checkpoints, []);
  assert.equal(shadow.completed, 5);
  assert.deepEqual(audit.writes(), [], "0 writes to person_dossiers / people_learning_* / people");
  assert.equal(audit.snapshot(), before);
  audit.close();

  // Publish: the current nightly window is fresh, the weekly one is missing → Steward creates it (no cron needed).
  const quiet = scriptedRunner(() => ({ disposition: "unresolved", reason: "n/a", citedHandles: [], confidence: "low" }));
  const published = await runPeopleShadowPass({ mode: "publish", inventoryContext, dbPath: f.dbPath, agentId: "main", workStore: store,
    runner: quiet.runner, owner: "o" });
  const byKind = new Map(published.inventory.map(r => [r.kind, r]));
  assert.equal(byKind.get("nightly")?.status, "fresh");
  assert.equal(byKind.get("nightly")?.runId, f.manifest.id);
  assert.equal(byKind.get("weekly")?.status, "created");
  const weeklyId = byKind.get("weekly")!.runId!;
  assert.match(weeklyId, /^weekly:/u);
  assert.ok(f.ledger.get(weeklyId), "the immutable weekly manifest is in people_learning_runs");
  assert.ok(published.manifests.some(m => m.manifestId === weeklyId && m.assertions > 0), "and its assertions are adjudicated");
  assert.ok(published.checkpoints.some(c => c.manifestId === weeklyId), "with a receipt checkpoint");
  // The shadow-mode rows were re-driven under the publish recipe (a shadow proposal is never mistaken for a publication).
  assert.ok(store.list(PEOPLE_SHADOW_KIND).filter(i => i.scope.startsWith(`${f.manifest.id}:`))
    .every(i => (JSON.parse(i.artifactJson ?? "{}") as PeopleShadowArtifact).mode === "publish"));

  // A second pass finds both windows fresh and inventories nothing new.
  const again = await runPeopleShadowPass({ mode: "publish", inventoryContext, dbPath: f.dbPath, agentId: "main", workStore: store,
    runner: quiet.runner, owner: "o" });
  assert.ok(again.inventory.every(r => r.status === "fresh"));
});

test("configurable limits: 0 = unlimited for handles, excerpt chars and items; timeoutMs 0 is forwarded", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const timeouts: (number | undefined)[] = [];
  const prompts: string[] = [];
  const runner: CompleteRunner = {
    async complete<T>(request: StewardCompleteRequest<T>): Promise<StewardCompleteResult<T>> {
      timeouts.push(request.timeoutMs);
      prompts.push(request.userPrompt);
      return { ok: true, backend: "host_llm", usage: { requests: 1 },
        data: { disposition: "unresolved", reason: "n/a", citedHandles: [], confidence: "low" } as T };
    },
  };
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const result = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o",
    maxItems: 0, maxHandles: 0, maxExcerptChars: 0, maxExportBytes: 0, timeoutMs: 0 });
  assert.equal(result.attempted, 5, "maxItems 0 = unlimited");
  assert.deepEqual(timeouts, [0, 0, 0, 0, 0], "timeoutMs 0 reaches the runner (unlimited)");
  const g = await fixture();
  t.after(g.cleanup);
  const store2 = new WorkStore(g.dbPath);
  t.after(() => store2.close());
  prompts.length = 0;
  await runPeopleShadowPass({ dbPath: g.dbPath, agentId: "main", workStore: store2, runner, owner: "o", maxHandles: 1, maxExcerptChars: 5 });
  assert.equal([...prompts[0]!.matchAll(/\[ev_\d+\]/gu)].length, 1, "maxHandles bounds the packet when set");
  assert.match(prompts[0]!, /user: Actu…/u, "maxExcerptChars clips when set");
});

test("publish mode completes a full-validation weekly receipt and verifies the dossier at the published revision", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const weekly: ReviewManifest = { ...f.manifest, id: `weekly:${f.manifest.window.localDay}`, kind: "weekly", fullValidation: true };
  const begun = f.ledger.begin(weekly);
  const { runner } = scriptedRunner((_prompt, handles) => ({ disposition: "revalidated", reason: "Consistent with recent requests",
    citedHandles: [handles[0]!], confidence: "high" }));
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const result = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store, runner,
    owner: "o", manifestIds: [weekly.id] });
  // Blurb sentence: recorded. Expired agent lesson: recorded (re-stamping would break the 30-day lesson rule). Claims: applied.
  assert.deepEqual(result.published, { applied: 3, recorded: 2, skipped: 0, unresolved: 0 });
  assert.equal(result.checkpoints[0]?.status, "complete");
  const run = f.ledger.get(weekly.id)!;
  assert.equal(run.status, "complete");
  assert.equal(run.manifestRevision, begun.manifestRevision, "stable assertion ids: revalidation never refreshes the manifest");
  assert.equal(run.receipt!.assertionReviews.length, 5);
  assert.ok(run.receipt!.assertionReviews.every(r => r.disposition === "revalidated" && r.sourceRefs.length > 0));
  const people = readPeople(f.dbPath);
  t.after(() => people.close());
  assert.equal(people.isDossierVerified(f.mira.id), true, "complete source validation binds verification to the current revision");
});

test("scheduled publish honors opt-outs: a disabled agent or review kind adjudicates nothing, never stored manifests", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const workspace = join(f.root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const { resolveConfig } = await import("../src/config.js");
  const context = (learning: Record<string, unknown>) => ({
    cfg: { agents: { defaults: { workspace, userTimezone: "UTC" }, entries: { main: { workspace } } } },
    config: resolveConfig({ people: { enabled: true, whisperer: { enabled: true }, learning } }),
    stateRoot: f.root,
  });
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const { runner, prompts } = scriptedRunner((_prompt, handles) =>
    ({ disposition: "retired", reason: "x", citedHandles: [handles[0]!], confidence: "high" }));
  const baseline = dossierChanges(f.dbPath, f.mira.id).length;

  // The whole agent opted out: the stored nightly manifest is NOT a fallback.
  const optedOut = await runPeopleShadowPass({ mode: "publish", inventoryContext: context({ agents: { main: { enabled: false } } }),
    dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o" });
  assert.deepEqual(optedOut.inventory.map(r => r.status), ["disabled", "disabled"]);
  assert.deepEqual(optedOut.manifests, []);
  assert.equal(optedOut.enqueued, 0);
  assert.equal(prompts.length, 0);
  assert.deepEqual(store.list(PEOPLE_SHADOW_KIND), []);
  assert.equal(dossierChanges(f.dbPath, f.mira.id).length, baseline);

  // Only nightly opted out: the weekly run is created and adjudicated, the stored nightly manifest never is.
  const weeklyOnly = await runPeopleShadowPass({ mode: "publish", inventoryContext: context({ nightly: false }),
    dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o" });
  const byKind = new Map(weeklyOnly.inventory.map(r => [r.kind, r]));
  assert.equal(byKind.get("nightly")?.status, "disabled");
  assert.equal(byKind.get("weekly")?.status, "created");
  assert.deepEqual(weeklyOnly.manifests.map(m => m.manifestId), [byKind.get("weekly")!.runId]);
  assert.ok(store.list(PEOPLE_SHADOW_KIND).every(i => !i.scope.startsWith(`${f.manifest.id}:`)));

  // An explicit manual override still adjudicates exactly the requested manifest.
  const manual = await runPeopleShadowPass({ mode: "publish", inventoryContext: context({ agents: { main: { enabled: false } } }),
    dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o", manifestIds: [f.manifest.id] });
  assert.deepEqual(manual.manifests.map(m => m.manifestId), [f.manifest.id]);
});

test("publish mode re-checks the stored manifest revision inside the fenced commit and never applies a stale edit", async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const baseline = dossierChanges(f.dbPath, f.mira.id).length;
  let refreshed = false;
  const { runner } = scriptedRunner((_prompt, handles) => {
    if (!refreshed) {
      // The manifest is refreshed (reopened at a new revision) while the model is adjudicating.
      refreshed = true;
      const db = new DatabaseSync(f.dbPath);
      try {
        db.prepare("UPDATE people_learning_runs SET manifest=json_set(manifest,'$.createdAt',?) WHERE id=?")
          .run(new Date(f.now - 5 * 60_000).toISOString(), f.manifest.id);
      } finally { db.close(); }
    }
    return handles.length
      ? { disposition: "retired", reason: "Withdrawn", citedHandles: [handles[0]!], confidence: "high" }
      : { disposition: "unresolved", reason: "n/a", citedHandles: [], confidence: "low" };
  });
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const result = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store, runner,
    owner: "o", manifestIds: [f.manifest.id] });
  assert.ok(refreshed);
  assert.equal(result.published.applied, 0, "no dossier edit against a refreshed manifest");
  assert.ok(result.published.skipped > 0);
  assert.equal(dossierChanges(f.dbPath, f.mira.id).length, baseline);
  const skipped = store.list(PEOPLE_SHADOW_KIND).map(i => JSON.parse(i.artifactJson ?? "{}") as PeopleShadowArtifact)
    .filter(a => a.publication?.status === "skipped");
  assert.ok(skipped.length > 0);
  for (const artifact of skipped) {
    assert.match(artifact.publication!.reason, /Manifest was refreshed/u);
    assert.equal(artifact.publication!.disposition, "unresolved");
  }
});

/* ───────────── Interaction learning (net-new claims) ───────────── */

const UNRESOLVED: Decide = () => ({ disposition: "unresolved", reason: "n/a", citedHandles: [], confidence: "low" });
const learnScope = (f: Fixture) => `${f.manifest.id}:${f.mira.id}:interactions`;
const NEW_CLAIM = "Prefers live syncs over async updates.";

function learnedClaim(prompt: string, overrides: Partial<PeopleInteractionResult["proposals"][number]> = {}) {
  return { section: "preferences" as const, statement: NEW_CLAIM, scope: "Team syncs", epistemicType: "reported" as const,
    confidence: "high" as const, reason: "Mira said so directly", citedHandles: [handleFor(prompt, "live syncs")], ...overrides };
}

test("interaction learning (publish): a net-new claim is discovered, cited, written, receipted as reviewed — duplicates, low confidence and agent-only grounding are not", async t => {
  const f = await fixture({ sessionIds: ["s1"] });
  t.after(f.cleanup);
  const baseline = dossierChanges(f.dbPath, f.mira.id).length;
  const { runner, learnPrompts } = scriptedRunner(UNRESOLVED, prompt => ({
    status: "learned", summary: "One durable new preference",
    proposals: [
      learnedClaim(prompt),
      // Already in the dossier, re-cased and re-punctuated: suppressed.
      learnedClaim(prompt, { statement: "give the recommendation FIRST!", scope: "Status updates",
        citedHandles: [handleFor(prompt, "lead with the recommendation")] }),
      learnedClaim(prompt, { statement: "Might like Friday launches.", confidence: "low" }),
      // Grounded only in the agent's own words: never a fact about the person.
      learnedClaim(prompt, { statement: "Ships on Fridays.", citedHandles: [handleFor(prompt, "ship Friday")] }),
    ],
  }));
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const result = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store, runner,
    owner: "steward:publish" });

  // Prompt: opaque handles over Mira's own in-account exchanges only, plus the existing dossier for duplicate suppression.
  assert.equal(learnPrompts.length, 1);
  const prompt = learnPrompts[0]!;
  assert.equal([...prompt.matchAll(/\[ev_\d+\]/gu)].length, 3);
  assert.match(prompt, /- \[preferences\] Give the recommendation first\. \(scope: Status updates\)/u);
  assert.match(prompt, /- \[blurb\] Mira leads launch planning at ExampleCo\./u);
  for (const leak of [f.root, f.exportRoot, ".json", "SECRET-OTHER-PERSON", "SECRET-OTHER-REPLY", "should-not-leak", f.revision]) {
    assert.ok(!prompt.includes(leak), `prompt must not contain ${leak}`);
  }

  assert.deepEqual(result.learned, { applied: 1, recorded: 0, skipped: 0, unresolved: 0, claimsAdded: 1 });
  const people = readPeople(f.dbPath);
  t.after(() => people.close());
  const preferences = people.getDossier(f.mira.id)!.dossier.sections.find(s => s.category === "preferences")!.claims;
  assert.deepEqual(preferences.map(c => c.statement), [...DOSSIER.sections[0]!.claims.map(c => c.statement), NEW_CLAIM]);
  const added = preferences.at(-1)!;
  assert.deepEqual(added.evidence.map(e => [e.source, e.locator]), [["session", "session:s1#6"]], "cites exactly the verified handle");
  assert.equal(added.scope, "Team syncs");
  assert.equal(added.epistemicType, "reported");
  assert.equal(added.confidence, "high");
  assert.ok(added.reviewedAt);
  assert.deepEqual(preferences.slice(0, 3), DOSSIER.sections[0]!.claims, "existing claims untouched byte-for-byte");

  const changes = dossierChanges(f.dbPath, f.mira.id).slice(baseline);
  assert.equal(changes.length, 1, "one audited revision for the whole person");
  assert.match(changes[0]!.reason, /^Steward People Learning learned 1 new claim\(s\)/u);
  assert.match(changes[0]!.reason, /sources: session:s1#6/u);
  assert.ok(!changes[0]!.reason.includes(f.root));

  const row = store.get(PEOPLE_INTERACTIONS_KIND, learnScope(f))!;
  assert.equal(row.status, "completed");
  assert.equal(row.mode, "item");
  assert.ok(row.inputRevision, "keyed on the person's evidence");
  assert.notEqual(row.inputRevision, f.revision, "not on the manifest revision, which moves when assertions are appended");
  assert.ok(!row.artifactJson!.includes(f.root), "artifact carries no filesystem paths");
  const artifact = JSON.parse(row.artifactJson!) as PeopleInteractionArtifact;
  assert.equal(artifact.publication?.status, "applied");
  assert.equal(artifact.publication?.changeId, changes[0]!.id, "the completed row records the exact revision it wrote");
  assert.deepEqual(artifact.publication?.claims.map(c => [c.statement, c.outcome, c.reason?.split(" ")[0]]), [
    ["give the recommendation FIRST!", "skipped", "duplicate"],
    ["Might like Friday launches.", "skipped", "confidence"],
    ["Ships on Fridays.", "skipped", "not"],
    [NEW_CLAIM, "applied", undefined],
  ]);

  // Operator report surfaces the interaction outcome next to assertion publications.
  const report = buildPeopleShadowReport(f.dbPath, f.manifest.id);
  assert.deepEqual([report.interactions.learned, report.interactions.claimsProposed, report.interactions.claimsAccepted,
    report.interactions.claimsApplied], [1, 4, 1, 1]);
  assert.equal(report.interactions.items[0]?.changeId, changes[0]!.id);
  assert.equal(report.interactions.usageTotals.requests, 1);

  // Receipt: the person is finally `reviewed` with the manifest's exact sessions and the reviewed excerpts as refs.
  assert.equal(result.checkpoints[0]?.peopleReviews, 1);
  const run = f.ledger.get(f.manifest.id)!;
  const review = run.receipt!.peopleReviews.find(p => p.personId === f.mira.id)!;
  assert.equal(review.status, "reviewed");
  assert.deepEqual(review.sessionIds, ["s1"]);
  assert.deepEqual(review.sourceRefs, ["session:s1#1", "session:s1#2", "session:s1#6"]);
  assert.match(review.reason, /added 1 claim/u);
  assert.ok(run.receipt!.changes.some(c => c.changeId === changes[0]!.id));
  // The new claim is a new assertion: the checkpoint folds it into the manifest so it gets validated too.
  assert.ok(run.manifest.assertions.some(a => a.statement === NEW_CLAIM));
  assert.notEqual(run.manifestRevision, f.revision);

  // Re-running never re-learns a reviewed person or double-adds the claim; the new assertion is adjudicated.
  const again = scriptedRunner(UNRESOLVED, prompt => ({ status: "learned", summary: "again", proposals: [learnedClaim(prompt)] }));
  const second = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store,
    runner: again.runner, owner: "steward:publish" });
  assert.equal(again.learnPrompts.length, 0, "a reviewed person is never re-learned");
  assert.deepEqual([store.get(PEOPLE_INTERACTIONS_KIND, learnScope(f))?.status, store.get(PEOPLE_INTERACTIONS_KIND, learnScope(f))?.inputRevision],
    ["completed", row.inputRevision], "the appended assertion does not re-enqueue interaction learning");
  assert.equal(second.learned.claimsAdded, 0);
  assert.ok(again.prompts.some(p => p.includes(`Assertion: ${NEW_CLAIM}`)), "the learned claim is itself validated next");
  assert.equal(dossierChanges(f.dbPath, f.mira.id).length - baseline, 1);
  assert.equal(f.ledger.get(f.manifest.id)!.receipt!.peopleReviews.find(p => p.personId === f.mira.id)?.status, "reviewed",
    "a later pass never downgrades the people review");
});

test("interaction learning: hallucinated handles strike to quarantine and write nothing; low-only results publish nothing", async t => {
  const f = await fixture({ sessionIds: ["s1"] });
  t.after(f.cleanup);
  const baseline = dossierChanges(f.dbPath, f.mira.id).length;
  const { runner } = scriptedRunner(UNRESOLVED, prompt => ({ status: "learned", summary: "trust me",
    proposals: [learnedClaim(prompt, { citedHandles: [handleFor(prompt, "live syncs"), "ev_99", "/etc/passwd"] })] }));
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const result = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store, runner,
    owner: "o", maxStrikes: 1 });
  const row = store.get(PEOPLE_INTERACTIONS_KIND, learnScope(f))!;
  assert.equal(row.status, "quarantined");
  assert.equal(row.artifactJson, null);
  assert.match(row.lastError ?? "", /hallucinated_handles: ev_99, \/etc\/passwd/u);
  assert.ok(result.items.some(i => i.scope === learnScope(f) && i.outcome === "rejected"));
  assert.equal(dossierChanges(f.dbPath, f.mira.id).length, baseline, "nothing published");
  const review = f.ledger.get(f.manifest.id)!.receipt!.peopleReviews.find(p => p.personId === f.mira.id)!;
  assert.equal(review.status, "unresolved");
  assert.match(review.reason, /has not completed yet/u);

  // Only low-confidence proposals: the person is reviewed, nothing is written.
  const g = await fixture({ sessionIds: ["s1"] });
  t.after(g.cleanup);
  const gBaseline = dossierChanges(g.dbPath, g.mira.id).length;
  const low = scriptedRunner(UNRESOLVED, prompt => ({ status: "learned", summary: "weak", proposals: [learnedClaim(prompt, { confidence: "low" })] }));
  const lowStore = new WorkStore(g.dbPath);
  t.after(() => lowStore.close());
  const lowResult = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: g.dbPath, agentId: "main", workStore: lowStore,
    runner: low.runner, owner: "o", minConfidence: "low" });
  assert.deepEqual(lowResult.learned, { applied: 0, recorded: 1, skipped: 0, unresolved: 0, claimsAdded: 0 },
    "low confidence never publishes, even with minConfidence low");
  assert.equal(dossierChanges(g.dbPath, g.mira.id).length, gBaseline);
  assert.equal(g.ledger.get(g.manifest.id)!.receipt!.peopleReviews.find(p => p.personId === g.mira.id)?.status, "reviewed");
});

test("interaction learning: shadow mode stages proposals with 0 production writes; off by default in shadow and opt-out in publish", async t => {
  const f = await fixture({ sessionIds: ["s1"] });
  t.after(f.cleanup);
  const audit = installWriteAudit(f.dbPath);
  t.after(audit.close);
  const before = audit.snapshot();
  const { runner, learnPrompts } = scriptedRunner(UNRESOLVED, prompt => ({ status: "learned", summary: "s", proposals: [learnedClaim(prompt)] }));
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());

  const plain = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o" });
  assert.equal(plain.enqueued, 5, "shadow default: assertion parity only");
  assert.deepEqual(store.list(PEOPLE_INTERACTIONS_KIND), []);

  const shadow = await runPeopleShadowPass({ dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o",
    includeInteractionLearning: true });
  assert.equal(learnPrompts.length, 1);
  assert.deepEqual(shadow.learned, { applied: 0, recorded: 0, skipped: 0, unresolved: 0, claimsAdded: 0 });
  const artifact = JSON.parse(store.get(PEOPLE_INTERACTIONS_KIND, learnScope(f))!.artifactJson!) as PeopleInteractionArtifact;
  assert.equal(artifact.mode, "shadow");
  assert.equal(artifact.publication, undefined);
  assert.deepEqual(artifact.decisions, [{ index: 0, outcome: "accepted" }]);
  assert.equal(artifact.result.proposals[0]!.statement, NEW_CLAIM);
  assert.deepEqual(audit.writes(), [], "0 writes to person_dossiers / people_learning_* / people");
  assert.equal(audit.snapshot(), before);
  audit.close();

  // Publish with interaction learning switched off: assertions only, and the receipt says so.
  const g = await fixture({ sessionIds: ["s1"] });
  t.after(g.cleanup);
  const off = scriptedRunner(UNRESOLVED, prompt => ({ status: "learned", summary: "s", proposals: [learnedClaim(prompt)] }));
  const offStore = new WorkStore(g.dbPath);
  t.after(() => offStore.close());
  await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: g.dbPath, agentId: "main", workStore: offStore, runner: off.runner,
    owner: "o", includeInteractionLearning: false });
  assert.equal(off.learnPrompts.length, 0);
  assert.match(g.ledger.get(g.manifest.id)!.receipt!.peopleReviews[0]!.reason, /assertions only/u);
});

test("interaction learning: paused people are skipped; a dossier edited mid-call is never overwritten and is re-learned next pass", async t => {
  // Paused: no tokens, no rows, honest receipt.
  const p = await fixture({ sessionIds: ["s1"] });
  t.after(p.cleanup);
  const pausing = readPeople(p.dbPath);
  pausing.setInjection(p.mira.id, false);
  pausing.close();
  const paused = scriptedRunner(UNRESOLVED, prompt => ({ status: "learned", summary: "s", proposals: [learnedClaim(prompt)] }));
  const pausedStore = new WorkStore(p.dbPath);
  t.after(() => pausedStore.close());
  await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: p.dbPath, agentId: "main", workStore: pausedStore, runner: paused.runner, owner: "o" });
  assert.equal(paused.learnPrompts.length, 0);
  assert.deepEqual(pausedStore.list(PEOPLE_INTERACTIONS_KIND), []);

  // Stale dossier fence: a human edits the dossier while the model is learning.
  const f = await fixture({ sessionIds: ["s1"] });
  t.after(f.cleanup);
  const people = readPeople(f.dbPath);
  t.after(() => people.close());
  const human = structuredClone(DOSSIER);
  human.sections[0]!.claims.push(claim("Wants a TL;DR on every doc.", "Docs"));
  let edited = false;
  const racing = scriptedRunner(UNRESOLVED, prompt => {
    if (!edited) { edited = true; people.replaceDossier(f.mira.id, "Human edit mid-learning", human); }
    return { status: "learned", summary: "s", proposals: [learnedClaim(prompt)] };
  });
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const first = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store,
    runner: racing.runner, owner: "o" });
  assert.deepEqual(first.items.find(i => i.scope === learnScope(f)), { scope: learnScope(f), outcome: "staged", detail: "stale_dossier" });
  assert.equal(first.learned.claimsAdded, 0);
  assert.deepEqual(people.getDossier(f.mira.id)!.dossier, human, "the newer human edit wins untouched");
  assert.equal(store.get(PEOPLE_INTERACTIONS_KIND, learnScope(f))!.strikes, 0, "a stale context is not the item's fault");

  // Next pass re-learns against the current dossier (the stale proposal is never resumed) and publishes on top of it.
  const second = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store,
    runner: racing.runner, owner: "o" });
  assert.equal(racing.learnPrompts.length, 2);
  assert.match(racing.learnPrompts[1]!, /Wants a TL;DR on every doc\./u, "the re-learn prompt shows the human edit");
  assert.equal(second.learned.claimsAdded, 1);
  const statements = people.getDossier(f.mira.id)!.dossier.sections[0]!.claims.map(c => c.statement);
  assert.deepEqual(statements.slice(-2), ["Wants a TL;DR on every doc.", NEW_CLAIM]);
});

test("interaction learning: refreshed manifest is never published against; maxNewClaimsPerPerson keeps the strongest; response-audit annotations", async t => {
  // Manifest refreshed mid-call: nothing is published inside the fenced commit, and the row is re-learned next pass.
  const f = await fixture({ sessionIds: ["s1"] });
  t.after(f.cleanup);
  const baseline = dossierChanges(f.dbPath, f.mira.id).length;
  const refreshing = scriptedRunner(UNRESOLVED, prompt => {
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare("UPDATE people_learning_runs SET manifest=json_set(manifest,'$.createdAt',?) WHERE id=?")
        .run(new Date(f.now - 5 * 60_000).toISOString(), f.manifest.id);
    } finally { db.close(); }
    return { status: "learned", summary: "s", proposals: [learnedClaim(prompt)] };
  });
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const refreshed = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store,
    runner: refreshing.runner, owner: "o", manifestIds: [f.manifest.id] });
  assert.deepEqual(refreshed.items.find(i => i.scope === learnScope(f)), { scope: learnScope(f), outcome: "staged", detail: "stale_manifest" });
  assert.deepEqual(refreshed.learned, { applied: 0, recorded: 0, skipped: 0, unresolved: 0, claimsAdded: 0 });
  assert.equal(dossierChanges(f.dbPath, f.mira.id).length, baseline);
  const refreshedRow = store.get(PEOPLE_INTERACTIONS_KIND, learnScope(f))!;
  assert.notEqual(refreshedRow.status, "completed", "a fenced-out proposal never completes the row");
  assert.equal(refreshedRow.strikes, 0);
  const relearn = scriptedRunner(UNRESOLVED, prompt => ({ status: "learned", summary: "s", proposals: [learnedClaim(prompt)] }));
  const relearned = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store,
    runner: relearn.runner, owner: "o", manifestIds: [f.manifest.id] });
  assert.equal(relearn.learnPrompts.length, 1, "re-learned against the current manifest revision");
  assert.equal(relearned.learned.claimsAdded, 1);

  // maxNewClaimsPerPerson = 1 keeps the highest-confidence claim; response-audit outcomes annotate the answer excerpt.
  const g = await fixture({ sessionIds: ["s1"] });
  t.after(g.cleanup);
  const audit = new DatabaseSync(g.dbPath);
  audit.exec(`CREATE TABLE IF NOT EXISTS response_results (cohort TEXT, id TEXT, session_id TEXT NOT NULL, input_hash TEXT NOT NULL,
    episode_at INTEGER NOT NULL, active INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    attempted_at INTEGER, assessed_at INTEGER, result TEXT, PRIMARY KEY(cohort,id))`);
  const judged = (personId: string) => JSON.stringify({
    quality: { underdelivery: { noul: 0 }, failureReason: { choice: "none_or_unclear", confidence: 0 } },
    retrospective: { judgment: { correction: { noul: 0 }, deliveryAdmission: { noul: 0 }, regression: { noul: 0 },
      outcome: { choice: "acknowledged_success", confidence: 1 }, scopeClarification: { noul: 0 }, reason: { choice: "none_or_unclear", confidence: 0 } } },
    references: { sessionId: "s1", request: [1], answer: [2], feedback: [], followup: [], inputHash: "h" }, human: { personId },
  });
  audit.prepare("INSERT INTO response_results VALUES ('c','e1','s1','h',1,1,'ok',1,1,1,?)").run(judged(g.mira.id));
  audit.prepare("INSERT INTO response_results VALUES ('c','e2','s1','h',2,1,'ok',1,1,1,?)").run("{not json");
  audit.close();
  const capped = scriptedRunner(UNRESOLVED, prompt => ({ status: "learned", summary: "two", proposals: [
    learnedClaim(prompt, { statement: "Likes Monday planning.", confidence: "medium" }),
    learnedClaim(prompt),
  ] }));
  const cappedStore = new WorkStore(g.dbPath);
  t.after(() => cappedStore.close());
  const cappedResult = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: g.dbPath, agentId: "main", workStore: cappedStore,
    runner: capped.runner, owner: "o", maxNewClaimsPerPerson: 1 });
  assert.match(capped.learnPrompts[0]!, /assistant: Recommendation: ship Friday\. \{response audit: acknowledged_success\}/u);
  assert.equal(cappedResult.learned.claimsAdded, 1);
  const people = readPeople(g.dbPath);
  t.after(() => people.close());
  const statements = people.getDossier(g.mira.id)!.dossier.sections[0]!.claims.map(c => c.statement);
  assert.equal(statements.at(-1), NEW_CLAIM, "the high-confidence claim wins the budget");
  assert.ok(!statements.includes("Likes Monday planning."));
  const cappedArtifact = JSON.parse(cappedStore.get(PEOPLE_INTERACTIONS_KIND, learnScope(g))!.artifactJson!) as PeopleInteractionArtifact;
  assert.match(cappedArtifact.decisions[0]!.reason ?? "", /over maxNewClaimsPerPerson \(1\)/u);

  // 0 = unlimited.
  const h = await fixture({ sessionIds: ["s1"] });
  t.after(h.cleanup);
  const unlimited = scriptedRunner(UNRESOLVED, prompt => ({ status: "learned", summary: "two", proposals: [
    learnedClaim(prompt, { statement: "Likes Monday planning.", confidence: "medium" }), learnedClaim(prompt)] }));
  const hStore = new WorkStore(h.dbPath);
  t.after(() => hStore.close());
  const all = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: h.dbPath, agentId: "main", workStore: hStore,
    runner: unlimited.runner, owner: "o", maxNewClaimsPerPerson: 0 });
  assert.equal(all.learned.claimsAdded, 2);
});

test("interaction learning: an unresolved person whose claim was published is not re-learned over identical evidence", async t => {
  // s3 has no approved export, so Mira's review stays unresolved even though a claim is published.
  const f = await fixture({ sessionIds: ["s1", "s3"] });
  t.after(f.cleanup);
  const baseline = dossierChanges(f.dbPath, f.mira.id).length;
  const { runner, learnPrompts } = scriptedRunner(UNRESOLVED, prompt => ({ status: "learned", summary: "s", proposals: [learnedClaim(prompt)] }));
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const first = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o" });
  assert.equal(first.learned.claimsAdded, 1);
  const run = f.ledger.get(f.manifest.id)!;
  const review = run.receipt!.peopleReviews.find(p => p.personId === f.mira.id)!;
  assert.equal(review.status, "unresolved");
  assert.match(review.reason, /no approved export for session\(s\) s3/u);
  assert.notEqual(run.manifestRevision, f.revision, "the published claim was appended as an assertion");

  for (let pass = 0; pass < 2; pass += 1) {
    const next = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o" });
    assert.equal(next.learned.claimsAdded, 0);
    assert.ok(next.items.some(i => i.scope === learnScope(f) && i.outcome === "skipped" && i.detail === "completed"));
  }
  assert.equal(learnPrompts.length, 1, "identical evidence is never re-learned, however often the manifest revision moves");
  assert.equal(dossierChanges(f.dbPath, f.mira.id).length - baseline, 1);
  assert.equal(f.ledger.get(f.manifest.id)!.receipt!.peopleReviews.find(p => p.personId === f.mira.id)?.status, "unresolved");
});

test("interaction learning: an interaction-only person's verified assertions are never reopened by the checkpoint", async t => {
  // Nightly manifests omit verified dossiers' assertions: Mira is in the roster only.
  const f = await fixture({ sessionIds: ["s1"], withoutAssertions: true });
  t.after(f.cleanup);
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const quiet = scriptedRunner(UNRESOLVED);
  const result = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store,
    runner: quiet.runner, owner: "o" });
  assert.equal(result.learned.recorded, 1, "no_new_claims");
  const run = f.ledger.get(f.manifest.id)!;
  assert.equal(run.receipt!.peopleReviews.find(p => p.personId === f.mira.id)?.status, "reviewed");
  assert.deepEqual(run.manifest.assertions, [], "no_new_claims adds no assertions");
  assert.equal(run.manifestRevision, f.revision, "the manifest is not reopened");
  assert.equal(quiet.prompts.length, 0, "no verified assertion is re-adjudicated");

  // A published claim adds exactly that claim, on this and every later checkpoint.
  const g = await fixture({ sessionIds: ["s1"], withoutAssertions: true });
  t.after(g.cleanup);
  const gStore = new WorkStore(g.dbPath);
  t.after(() => gStore.close());
  const learning = scriptedRunner(UNRESOLVED, prompt => ({ status: "learned", summary: "s", proposals: [learnedClaim(prompt)] }));
  await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: g.dbPath, agentId: "main", workStore: gStore, runner: learning.runner, owner: "o" });
  assert.deepEqual(g.ledger.get(g.manifest.id)!.manifest.assertions.map(a => a.statement), [NEW_CLAIM]);
  await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: g.dbPath, agentId: "main", workStore: gStore, runner: learning.runner, owner: "o" });
  assert.ok(learning.prompts.some(p => p.includes(`Assertion: ${NEW_CLAIM}`)), "the learned claim is adjudicated");
  assert.deepEqual(g.ledger.get(g.manifest.id)!.manifest.assertions.map(a => a.statement), [NEW_CLAIM],
    "later checkpoints still never pull in the verified dossier");
  assert.equal(learning.prompts.length, 1);
});

test("interaction learning: clipped excerpts are incomplete coverage, never a reviewed person", async t => {
  const f = await fixture({ sessionIds: ["s1"] });
  t.after(f.cleanup);
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const { runner, learnPrompts } = scriptedRunner(UNRESOLVED);
  const result = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store,
    runner, owner: "o", maxExcerptChars: 20 });
  assert.equal(learnPrompts.length, 1);
  assert.match(learnPrompts[0]!, /user: Actually I now pref…/u);
  assert.equal(result.learned.recorded, 1);
  const artifact = JSON.parse(store.get(PEOPLE_INTERACTIONS_KIND, learnScope(f))!.artifactJson!) as PeopleInteractionArtifact;
  assert.ok(artifact.coverage.clippedExcerpts > 0);
  const review = f.ledger.get(f.manifest.id)!.receipt!.peopleReviews.find(p => p.personId === f.mira.id)!;
  assert.equal(review.status, "unresolved");
  assert.match(review.reason, /excerpt\(s\) clipped by maxExcerptChars/u);
  assert.deepEqual(review.sessionIds, []);
});

test("interaction learning: a person paused mid-pass is rechecked live and never dispatched to the model", async t => {
  const f = await fixture({ sessionIds: ["s1"], secondPerson: true });
  t.after(f.cleanup);
  const people = readPeople(f.dbPath);
  t.after(() => people.close());
  const { runner, learnPrompts } = scriptedRunner(UNRESOLVED, prompt => {
    // While Mira is being reviewed, an operator pauses Bo.
    if (prompt.startsWith("Person: Mira")) people.setInjection(f.bo!.id, false);
    return { status: "no_new_claims", proposals: [], summary: "Nothing durable and new" };
  });
  const store = new WorkStore(f.dbPath);
  t.after(() => store.close());
  const result = await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o" });
  const boScope = `${f.manifest.id}:${f.bo!.id}:interactions`;
  assert.equal(learnPrompts.length, 1, "only Mira's packet reached the model");
  assert.ok(learnPrompts.every(p => !p.includes("SECRET-BO") && !p.includes("Bo runs QA.")), "Bo's excerpts and dossier never left");
  assert.deepEqual(result.items.find(i => i.scope === boScope), { scope: boScope, outcome: "skipped", detail: "paused" });
  const row = store.get(PEOPLE_INTERACTIONS_KIND, boScope)!;
  assert.notEqual(row.status, "completed", "a paused person is released, not completed, so un-pausing resumes learning");
  assert.equal(row.strikes, 0);
  assert.equal(f.ledger.get(f.manifest.id)!.receipt!.peopleReviews.find(p => p.personId === f.bo!.id)?.status, "unresolved");

  // Un-paused: the next pass learns Bo.
  people.setInjection(f.bo!.id, true);
  await runPeopleShadowPass({ ...PUBLISH_DEFAULTS, dbPath: f.dbPath, agentId: "main", workStore: store, runner, owner: "o" });
  assert.equal(learnPrompts.length, 2);
  assert.match(learnPrompts[1]!, /SECRET-BO/u);
});
