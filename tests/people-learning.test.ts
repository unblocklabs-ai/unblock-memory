import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig, OpenClawPluginApi, OpenClawPluginService, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { Value } from "typebox/value";
import { resolveConfig } from "../src/config.js";
import { learningForAgent, PEOPLE_LEARNING_SCHEMA } from "../src/people-learning-config.js";
import { reviewWindow } from "../src/people-learning-time.js";
import { learningSession, reconcilePeopleLearning, type PeopleCron } from "../src/people-learning-cron.js";
import { inventoryPeople, type ReviewManifest } from "../src/people-learning-inventory.js";
import { PeopleLearningStore, verifyLearningCoverage, type LearningReceipt } from "../src/people-learning-store.js";
import { PeopleStores } from "../src/people-store.js";
import { registerPeopleLearning } from "../src/people-learning-runtime.js";
import { createAgentDatabase, insertSession, compressAgentTranscripts } from "./helpers/session-database.js";
import { record } from "../src/guards.js";
import { DatabaseSync } from "node:sqlite";

const enabled = () => resolveConfig({ people: { enabled: true, whisperer: { enabled: true } } });
const cfg: OpenClawConfig = { agents: { defaults: { userTimezone: "Pacific/Auckland" }, entries: { alpha: {}, beta: {} } } };

test("learning defaults follow People Whisperer, preserve analysis approvals, and support independent agent/schedule opt-outs", () => {
  assert.equal(resolveConfig({}).people.learning.enabled, false);
  assert.equal(resolveConfig({ people: { enabled: true } }).people.learning.enabled, false);
  const config = enabled();
  assert.equal(config.people.learning.enabled, true);
  assert.equal(config.people.learning.nightlySchedule, "10 3 * * *");
  assert.equal(config.people.learning.weeklySchedule, "0 4 * * 0");
  assert.equal(config.responseAudit.enabled, false);
  assert.deepEqual(config.peoplePrimer.corpora, []);
  const learning = resolveConfig({ people: { enabled: true, whisperer: { enabled: true },
    learning: { nightly: false, agents: { alpha: { enabled: false }, beta: { weeklySchedule: "30 5 * * 1", timezone: "Asia/Tokyo" } } } } }).people.learning;
  assert.equal(learningForAgent(learning, "alpha").enabled, false);
  assert.equal(learningForAgent(learning, "beta").nightly, false);
  assert.equal(learningForAgent(learning, "beta").weeklySchedule, "30 5 * * 1");
  assert.equal(learningForAgent(learning, "beta").timezone, "Asia/Tokyo");
  assert.equal(resolveConfig({ people: { enabled: true, whisperer: { enabled: true }, learning: { enabled: false } } }).people.learning.enabled, false);
  assert.equal(learningForAgent({ ...config.people.learning, enabled: false, agents: { alpha: { enabled: true } } }, "alpha").enabled,
    false, "the global opt-out remains a stop switch even with an explicit per-agent enable");
  for (const input of [{ enabled: "yes" }, { timezone: "invalid/zone" }, { nightlySchedule: "03:10" }, { agents: { "../other": {} } }]) {
    assert.throws(() => resolveConfig({ people: { learning: input } }));
  }
  assert.equal(Value.Check(PEOPLE_LEARNING_SCHEMA, { agents: { alpha: { weekly: false } } }), true);
});

test("review windows use completed local days across DST, week boundaries, and distant timezones", () => {
  const spring = reviewWindow(Date.parse("2026-03-09T08:00:00Z"), "America/New_York", "nightly");
  assert.equal(spring.localDay, "2026-03-08");
  assert.equal(new Date(spring.since).toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(new Date(spring.until).toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal((spring.until - spring.since) / 3600_000, 23);
  const fall = reviewWindow(Date.parse("2026-11-02T09:00:00Z"), "America/New_York", "nightly");
  assert.equal((fall.until - fall.since) / 3600_000, 25);
  const week = reviewWindow(Date.parse("2026-03-15T08:00:00Z"), "America/New_York", "weekly");
  assert.equal((week.until - week.since) / 3600_000, 167);
  const tokyo = reviewWindow(Date.parse("2026-11-15T18:10:00Z"), "Asia/Tokyo", "nightly");
  assert.equal(tokyo.localDay, "2026-11-15");
  assert.equal(new Date(tokyo.since).toISOString(), "2026-11-14T15:00:00.000Z");
  assert.throws(() => reviewWindow(Date.now(), "UTC", "nightly", "2026-02-30"));
});

type Job = Awaited<ReturnType<PeopleCron["list"]>>[number];
function hostCron(seed: Job[] = []) {
  const jobs: Job[] = seed.map(job => ({ schedule: { kind: "cron", expr: "0 4 * * 0" },
    sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "Legacy review" },
    delivery: { mode: "none" }, state: {}, ...job }));
  const writes: string[] = [];
  let loseNextAddReply = false;
  const cron: PeopleCron = {
    async list() { return structuredClone(jobs); },
    async add(input) {
      assert.equal(input.schedule.kind, "cron");
      const job = { ...structuredClone(input), schedule: { ...input.schedule, kind: "cron" as const }, id: `job-${jobs.length}`, state: {} };
      jobs.push(job); writes.push(`add:${job.id}`);
      if (loseNextAddReply) { loseNextAddReply = false; throw new Error("Reply lost after commit"); }
      return job;
    },
    async update(id, patch) {
      const job = jobs.find(j => j.id === id);
      assert.ok(job, "update must target an existing job");
      assert.ok(!("declarationKey" in patch), "declaration keys are set at creation");
      Object.assign(job, structuredClone(patch));
      writes.push(`update:${id}`);
      return job;
    },
  };
  return { cron, jobs, writes, loseReply() { loseNextAddReply = true; } };
}

test("startup/reload reconciliation replaces exact legacy jobs, preserves their history, and honors opt-outs", async () => {
  const state = { lastRunAtMs: 123, lastRunStatus: "ok" as const };
  const h = hostCron([
    { id: "old", agentId: "alpha", name: "People Whisperer — full weekly statement validation", enabled: true, state },
    { id: "duplicate", agentId: "alpha", name: "People Whisperer — full weekly statement validation", enabled: true, state },
    { id: "unrelated", agentId: "other", name: "People Whisperer — full weekly statement validation", enabled: true, state },
    { id: "unowned", agentId: "alpha", name: "Billing maintenance", enabled: true, state },
  ]);
  const options = { ...enabled().people.learning, agents: { beta: { enabled: false } } };
  const first = await reconcilePeopleLearning(h.cron, cfg, options);
  assert.equal(first.length, 2);
  const old = h.jobs.find(j => j.id === "old")!;
  assert.deepEqual(old.state, state);
  assert.equal(old.enabled, false);
  const migrated = h.jobs.find(j => j.id === first.find(job => job.kind === "weekly")!.id)!;
  assert.equal(migrated.declarationKey, "unblock-memory:people-learning:alpha:weekly");
  assert.equal(record(migrated.schedule)?.tz, "Pacific/Auckland");
  assert.equal(record(migrated.schedule)?.staggerMs, 0);
  assert.equal(record(migrated.payload)?.kind, "agentTurn");
  assert.equal(record(record(migrated)?.delivery)?.mode, "none");
  assert.equal(h.jobs.find(j => j.id === "duplicate")!.enabled, false);
  assert.deepEqual(h.jobs.find(j => j.id === "duplicate")!.state, state);
  assert.equal(h.jobs.find(j => j.id === "unrelated")!.enabled, true);
  assert.equal(h.jobs.find(j => j.id === "unowned")!.enabled, true);
  const count = h.writes.length;
  await reconcilePeopleLearning(h.cron, cfg, options);
  assert.equal(h.writes.length, count, "unchanged reload performs no scheduler mutations");
  await reconcilePeopleLearning(h.cron, cfg, { ...options, enabled: false });
  assert.ok(first.every(j => h.jobs.find(stored => stored.id === j.id)?.enabled === false));
  assert.equal(h.jobs.find(j => j.id === "unowned")!.enabled, true);
  await reconcilePeopleLearning(h.cron, cfg, options);
  assert.ok(first.every(j => h.jobs.find(stored => stored.id === j.id)?.enabled === true), "off/on must not be mistaken for legacy pause");
  await reconcilePeopleLearning(h.cron, { agents: { entries: { beta: {} } } }, options);
  assert.ok(first.every(j => h.jobs.find(stored => stored.id === j.id)?.enabled === false), "removed agents leave no active migrated jobs");
  const nightly = first.find(j => j.kind === "nightly")!;
  assert.equal(learningSession(`agent:alpha:cron:${nightly.id}:run:123`, first)?.agentId, "alpha");
  assert.equal(learningSession(`agent:beta:cron:${nightly.id}:run:123`, first), undefined);
  assert.equal(learningSession(`agent:alpha:cron:${nightly.id}-fake`, first), undefined);
});

test("a lost scheduler response and previously paused legacy job do not create duplicate jobs or reactivate work", async () => {
  const h = hostCron([{ id: "paused", agentId: "alpha", enabled: false,
    name: "People Whisperer — full weekly statement validation" }]);
  const settings = { ...enabled().people.learning, agents: { beta: { enabled: false } } };
  h.loseReply();
  await assert.rejects(reconcilePeopleLearning(h.cron, cfg, settings), /Reply lost/);
  await reconcilePeopleLearning(h.cron, cfg, settings);
  await reconcilePeopleLearning(h.cron, cfg, settings);
  assert.equal(h.jobs.length, 3);
  assert.equal(h.jobs.find(j => j.id === "paused")!.enabled, false);
  assert.equal(h.jobs.find(j => j.declarationKey?.endsWith(":weekly"))!.enabled, false);
  await reconcilePeopleLearning(h.cron, cfg, { ...settings, agents: { ...settings.agents, alpha: { enabled: true } } });
  assert.equal(h.jobs.find(j => j.declarationKey?.endsWith(":weekly"))!.enabled, true);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "people-learning-"));
  const stores = new PeopleStores({ stateRoot: root, maxOpenTodos: 10, maxBlurbChars: 1200 });
  const people = stores.get("alpha");
  const a = people.upsertIdentity({ provider: "slack", accountScope: "workspace", externalId: "U1", displayName: "Same Name", isBot: false });
  const b = people.upsertIdentity({ provider: "slack", accountScope: "other", externalId: "U1", displayName: "Same Name", isBot: false });
  const inactive = people.upsertIdentity({ provider: "slack", accountScope: "workspace", externalId: "U2", displayName: "Paused", isBot: false });
  const dossier = { schemaVersion: 1, blurb: "Team lead. Works with the agent.", sections: [
    { category: "preferences", claims: [{ statement: "Explain before editing", epistemicType: "reported", scope: "Question-only requests",
      reviewedAt: "2026-11-14T12:00:00Z", evidence: [{ source: "session", locator: "slack:workspace:U1:original" }] }] },
  ] };
  people.replaceDossier(a.person.id, "Verified exact human instruction", dossier);
  people.replaceDossier(b.person.id, "Verified independent account", { ...dossier, sections: [] });
  people.replaceDossier(inactive.person.id, "Verified before pause", { ...dossier, sections: [] });
  for (const person of [a.person, b.person, inactive.person]) people.recordDossierVerification(person.id,
    people.getDossierRevision(person.id)!, "Fixture: all original assertions source-verified");
  people.setInjection(inactive.person.id, false);
  const path = join(root, "openclaw-agent.sqlite"), db = createAgentDatabase(path, "alpha");
  const since = Date.parse("2026-11-15T12:00:00Z");
  const add = (id: string, account: string, chatType: "direct" | "group" | "channel", sender = "U1") => {
    insertSession(db, { sessionId: id, chatType });
    db.prepare("UPDATE session_windows SET account_id=?,session_key=? WHERE session_id=?").run(account, `agent:alpha:${id}`, id);
    db.prepare("UPDATE conversations SET account_id=? WHERE conversation_id=?").run(account, `conversation-${id}`);
    const messages = [
      { role: "user", content: "Please explain, no edits.", __openclaw: { senderId: sender, senderIdentity: { senderKind: "human" }, transport: { channel: "slack", accountId: account, conversationRef: `conversation-${id}` } } },
      { role: "assistant", content: "I edited it.", stopReason: "stop" },
      { role: "user", content: "I asked for an explanation.", __openclaw: { senderId: sender, senderIdentity: { senderKind: "human" }, transport: { channel: "slack", accountId: account, conversationRef: `conversation-${id}` } } },
      { role: "assistant", content: "Here is the explanation and repair.", stopReason: "stop" },
    ];
    for (const [i, message] of messages.entries()) {
      db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run(id, i + 1, JSON.stringify({ type: "message", message }), since + i * 1000);
      db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run(id, i, i + 1, i);
    }
  };
  const inventory = (kind: "nightly" | "weekly" = "nightly") => inventoryPeople({ agentId: "alpha", kind, timezone: "UTC",
    now: Date.parse("2026-11-16T03:10:00Z"), people, databasePath: path, exportRoot: join(root, "private/exports") });
  return { root, stores, people, a: a.person.id, b: b.person.id, inactive: inactive.person.id, db, path, add, inventory };
}

test("native inventory covers full reused DM/group/channel exchanges, exact account identities, compressed transcripts and all weekly statements", t => {
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  f.add("dm", "workspace", "direct"); f.add("channel", "workspace", "channel"); f.add("group", "other", "group");
  const failure = { type: "message", message: { role: "toolResult", toolName: "edit", isError: true, content: "Write failed" } };
  f.db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)").run("dm", 5, JSON.stringify(failure), Date.parse("2026-11-15T12:01:00Z"));
  f.db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run("dm", 4, 5, 4);
  compressAgentTranscripts(f.db);
  const nightly = f.inventory();
  assert.equal(nightly.sourceGaps.length, 0);
  assert.deepEqual(nightly.roster.find(p => p.personId === f.a)!.sessionIds, ["channel", "dm"]);
  assert.deepEqual(nightly.roster.find(p => p.personId === f.b)!.sessionIds, ["group"]);
  const exported = JSON.parse(readFileSync(nightly.sessions.find(s => s.sessionId === "dm")!.file, "utf8"));
  assert.equal(exported.messages.length, 5);
  assert.equal(exported.messages[3].text, "Here is the explanation and repair.");
  assert.equal(exported.messages[4].text, "Write failed");
  assert.equal(exported.messages[4].isError, true);
  assert.equal(statSync(nightly.sessions[0]!.file).mode & 0o777, 0o600);
  const weekly = f.inventory("weekly");
  assert.equal(weekly.assertions.length, 5, "two blurb sentences per active person, plus every section claim");
  assert.ok(!weekly.assertions.some(a => a.personId === f.inactive), "inactive person with no activity is not silently reactivated");
  assert.equal(f.people.getPerson(f.inactive)!.injectionEnabled, false);
  const wrongAgent = inventoryPeople({ agentId: "beta", kind: "weekly", timezone: "UTC", people: f.people,
    databasePath: f.path, exportRoot: join(f.root, "beta") });
  assert.ok(wrongAgent.sourceGaps.length);
  assert.equal(wrongAgent.sessions.length, 0);
});

function receiptFor(manifest: ReviewManifest): LearningReceipt {
  const reviewedAt = new Date(Date.parse(manifest.createdAt) + 60_000).toISOString();
  return { peopleReviews: manifest.roster.map(p => ({ personId: p.personId,
    status: p.sessionIds.length ? "reviewed" : "no_interactions", sessionIds: p.sessionIds,
    reason: "Read full attributable requests, responses, neutral corrections and repair", sourceRefs: ["native:session:event"], reviewedAt })),
    assertionReviews: manifest.assertions.map(a => ({ assertionId: a.id, disposition: "revalidated",
      reason: "Verified original evidence and checked newer corrections", sourceRefs: ["original:account:sender:event"], reviewedAt, correctionsCheckedAt: reviewedAt })),
    sourceGapReviews: [], analysis: { status: "not_approved", reason: "No external approval; local review only" }, changes: [], executionFollowups: [] };
}

test("pending or stale native projections stay incomplete until the host rebuilds them", t => {
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  f.add("pending", "workspace", "direct");
  f.db.exec(`CREATE TABLE session_transcript_index_state (session_id TEXT PRIMARY KEY, indexed_seq INTEGER, needs_rebuild INTEGER);
    INSERT INTO session_transcript_index_state VALUES ('pending',4,1);
    DELETE FROM session_transcript_active_events WHERE session_id='pending'`);
  assert.ok(f.inventory().sourceGaps.some(g => g.sessionId === "pending"));
  for (let i = 0; i < 4; i++) f.db.prepare("INSERT INTO session_transcript_active_events VALUES(?,?,?,?)").run("pending", i, i + 1, i);
  f.db.exec("UPDATE session_transcript_index_state SET needs_rebuild=0,indexed_seq=3");
  assert.ok(f.inventory().sourceGaps.some(g => g.sessionId === "pending"));
  f.db.exec("UPDATE session_transcript_index_state SET indexed_seq=4");
  assert.equal(f.inventory().sourceGaps.length, 0);
});

test("multimodal requests retain a source gap rather than pretending their text is the whole request", t => {
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  f.add("image", "workspace", "direct");
  const row = f.db.prepare("SELECT event_json FROM transcript_events WHERE session_id='image' AND seq=1").get()!;
  const event = JSON.parse(String(row.event_json));
  event.message.content = [{ type: "text", text: "Use the constraints in this screenshot" }, { type: "image", data: "not-exported", mimeType: "image/png" }];
  f.db.prepare("UPDATE transcript_events SET event_json=? WHERE session_id='image' AND seq=1").run(JSON.stringify(event));
  const manifest = f.inventory();
  assert.ok(manifest.sourceGaps.some(g => g.sessionId === "image"));
  assert.equal(verifyLearningCoverage(manifest, receiptFor(manifest), Date.parse("2026-11-16T05:00:00Z")).status, "partial");
});

test("stored external-user metadata preserves attachment gaps and fences excluded exchanges", t => {
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); }); f.add("dm", "workspace", "direct");
  const replace = (seq: number, message: unknown) => f.db.prepare("UPDATE transcript_events SET event_json=? WHERE session_id='dm' AND seq=?")
    .run(JSON.stringify({ type: "message", message }), seq);
  const externalUser = (content: string, { senderId = "U1", accountId = "workspace", withAttachment = false } = {}) => ({
    role: "user", content, provenance: { kind: "external_user" },
    __openclaw: { senderId, senderIdentity: { id: senderId, senderKind: "human" },
      transport: { channel: "slack", accountId, conversationRef: "conversation-dm" },
      ...(withAttachment ? { media: [{ path: "/private/requirements.pdf", contentType: "application/pdf", kind: "document" }] } : {}),
    },
  });
  const request = "Follow the attached requirements";
  replace(1, externalUser(request));
  replace(3, externalUser("Thanks"));
  let manifest = f.inventory();
  assert.deepEqual(manifest.roster.find(p => p.personId === f.a)!.sessionIds, ["dm"]);
  assert.equal(manifest.sourceGaps.length, 0);
  replace(1, externalUser(request, { withAttachment: true }));
  manifest = f.inventory();
  assert.ok(manifest.sourceGaps.some(g => g.sessionId === "dm"));
  assert.match(readFileSync(manifest.sessions[0]!.file, "utf8"), /requirements\.pdf/u);
  // The excluded exchange is outside the day; a later valid exchange makes the
  // reused session relevant, but must not carry the excluded account's output.
  replace(1, externalUser(request, { accountId: "other" }));
  replace(2, { role: "assistant", content: "PRIVATE_OTHER_ACCOUNT_REPLY" });
  f.db.prepare("UPDATE transcript_events SET created_at=created_at-86400000 WHERE session_id='dm' AND seq<=2").run();
  manifest = f.inventory();
  const exported = readFileSync(manifest.sessions[0]!.file, "utf8");
  assert.doesNotMatch(exported, /PRIVATE_OTHER_ACCOUNT_REPLY/u);
  replace(2, { role: "toolResult", content: "PRIVATE_OTHER_ACCOUNT_TOOL_RESULT", toolName: "read" });
  manifest = f.inventory();
  assert.doesNotMatch(readFileSync(manifest.sessions[0]!.file, "utf8"), /PRIVATE_OTHER_ACCOUNT_TOOL_RESULT/u);
  replace(4, { role: "assistant", content: [], stopReason: "error", errorMessage: "Provider failed" });
  manifest = f.inventory();
  assert.match(readFileSync(manifest.sessions[0]!.file, "utf8"), /"stopReason": "error"/u);
  replace(4, { role: "assistant", content: "Visible response after network access", __openclaw: { turnTainted: true } });
  manifest = f.inventory();
  assert.ok(manifest.sourceGaps.some(g => g.sessionId === "dm"), "untrusted output cannot silently disappear");
  replace(4, { role: "toolResult", content: "PRIVATE_NETWORK_BODY", __openclaw: { resultContentSource: "network" } });
  manifest = f.inventory();
  assert.ok(manifest.sourceGaps.some(g => g.sessionId === "dm"), "the SDK network-result marker is also untrusted");
  assert.doesNotMatch(readFileSync(manifest.sessions[0]!.file, "utf8"), /PRIVATE_NETWORK_BODY/u);
  replace(4, { role: "assistant", content: [{ type: "thinking", thinking: "HIDDEN_REASONING" }, { type: "text", text: "Repair complete" }] });
  manifest = f.inventory();
  assert.equal(manifest.sourceGaps.length, 0, "hidden reasoning is not an unread visible deliverable");
  assert.doesNotMatch(readFileSync(manifest.sessions[0]!.file, "utf8"), /HIDDEN_REASONING/u);
  replace(4, { role: "assistant", content: [{ type: "text", text: "Model text" }],
    openclawDisplayContent: [{ type: "text", text: "Delivered text" }, { type: "image", mimeType: "image/png", data: "private-image" }],
    openclawDelivery: { mediaUrls: ["/private/delivered-chart.png"] } });
  manifest = f.inventory();
  assert.ok(manifest.sourceGaps.length);
  assert.match(readFileSync(manifest.sessions[0]!.file, "utf8"), /delivered-chart\.png/u);
  replace(4, { role: "assistant", content: "Repair complete" });
  replace(1, externalUser(request, { senderId: "UNKNOWN" }));
  f.db.prepare("UPDATE transcript_events SET created_at=? WHERE session_id='dm' AND seq=2").run(Date.parse("2026-11-15T12:00:00Z"));
  manifest = f.inventory();
  assert.ok(manifest.sourceGaps.some(g => g.reason.includes("Unattributed output")), "an unknown prior-day request cannot hide today's output");
});

test("legacy blurbs without structured preferences still require full bootstrap", t => {
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  const legacy = f.people.upsertIdentity({ provider: "slack", accountScope: "workspace", externalId: "LEGACY", isBot: false }).person;
  f.people.replaceDossier(legacy.id, "Legacy prose", { schemaVersion: 1, blurb: "Pat is a teammate. Always keep updates brief for Pat.", sections: [] });
  const manifest = f.inventory();
  assert.equal(manifest.fullValidation, true);
  assert.equal(manifest.assertions.filter(a => a.personId === legacy.id).length, 2);
});

test("recovered inventories expand the backlog and preserve the original snapshot", t => {
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  f.add("recovered", "workspace", "direct");
  const outage = inventoryPeople({ agentId: "alpha", kind: "nightly", timezone: "UTC", now: Date.parse("2026-11-16T03:10:00Z"),
    people: f.people, databasePath: join(f.root, "absent.sqlite"), exportRoot: join(f.root, "private") });
  const path = join(f.root, "recovery.sqlite"), ledger = new PeopleLearningStore(path, "alpha"); t.after(() => ledger.close());
  ledger.begin(outage);
  const recovered = ledger.begin(f.inventory());
  assert.equal(recovered.manifest.sessions.length, 1);
  assert.equal(recovered.manifest.sourceGaps.length, 0);
  const db = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(db.prepare("SELECT count(*) n FROM people_learning_inventories WHERE run_id=?").get(outage.id)!.n, 2); }
  finally { db.close(); }
  const setImage = (data: string) => {
    const event = JSON.parse(String(f.db.prepare("SELECT event_json FROM transcript_events WHERE session_id='recovered' AND seq=1").get()!.event_json));
    event.message.content = [{ type: "text", text: "Use this image" }, { type: "image", mimeType: "image/png", data }];
    f.db.prepare("UPDATE transcript_events SET event_json=? WHERE session_id='recovered' AND seq=1").run(JSON.stringify(event));
  };
  setImage("first-image");
  const withImage = ledger.begin(f.inventory()).manifest, receipt = receiptFor(withImage);
  receipt.sourceGapReviews = withImage.sourceGaps.map(g => ({ sourceGapId: g.id, status: "resolved", reason: "Verified original attachment",
    sourceRefs: ["native:recovered:1"], reviewedAt: "2026-11-16T04:00:00Z" }));
  assert.equal(ledger.checkpoint(withImage.id, receipt, Date.parse("2026-11-16T05:00:00Z")).status, "complete");
  setImage("changed-image");
  const changed = ledger.begin(f.inventory());
  assert.equal(changed.status, "partial");
  assert.deepEqual(changed.receipt!.sourceGapReviews, [], "a prior gap resolution cannot certify rewritten evidence");
});

test("rejected checkpoint IDs do not poison valid progress or erase rejected-attempt history", t => {
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); }); f.add("dm", "workspace", "direct");
  const manifest = f.inventory("weekly"), receipt = receiptFor(manifest), now = Date.parse("2026-11-16T05:00:00Z");
  const ledger = new PeopleLearningStore(join(f.root, "checkpoint.sqlite"), "alpha"); t.after(() => ledger.close()); ledger.begin(manifest);
  ledger.checkpoint(manifest.id, { ...receipt, assertionReviews: receipt.assertionReviews.slice(0, 1) }, now);
  const invalid = ledger.checkpoint(manifest.id, { ...receipt, assertionReviews: [...receipt.assertionReviews,
    { ...receipt.assertionReviews[0]!, assertionId: "typo" }] }, now + 1);
  assert.equal(invalid.status, "invalid");
  assert.equal(ledger.get(manifest.id)!.receipt!.assertionReviews.length, 1);
  assert.equal(ledger.checkpoint(manifest.id, receipt, now + 2).status, "complete");
  assert.equal(ledger.checkpoint(manifest.id, { ...receipt, assertionReviews: [...receipt.assertionReviews,
    { ...receipt.assertionReviews[0]!, assertionId: "another-typo" }] }, now + 3).status, "invalid");
  assert.equal(ledger.get(manifest.id)!.status, "complete", "rejected attempts cannot reopen an accepted complete review");
});

test("verification failures remain durable backlog until verification succeeds", t => {
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  const ledger = new PeopleLearningStore(join(f.root, "verification.sqlite"), "alpha"); t.after(() => ledger.close());
  const manifest = f.inventory("weekly"); ledger.begin(manifest);
  const receipt = receiptFor(manifest), now = Date.parse("2026-11-16T05:00:00Z");
  const incomplete = ledger.checkpoint(manifest.id, receipt, now, undefined, () => { throw new Error("Verification source unavailable"); });
  assert.equal(incomplete.status, "partial");
  assert.equal(ledger.get(manifest.id)!.status, "partial");
  const complete = ledger.checkpoint(manifest.id, receipt, now + 1, undefined, () => {
    assert.equal(ledger.get(manifest.id)!.status, "partial", "completion is not published before verification writes");
  });
  assert.equal(complete.status, "complete");
  const originalExec = DatabaseSync.prototype.exec;
  let refreshAfterCommit = true;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    const result = originalExec.call(this, sql);
    if (sql === "COMMIT" && refreshAfterCommit) {
      refreshAfterCommit = false;
      ledger.begin({ ...manifest, sourceGaps: [{ id: "concurrent-gap", reason: "Source disappeared during finalization" }] });
    }
    return result;
  });
  const raced = ledger.checkpoint(manifest.id, receipt, now + 2, undefined, () => {});
  assert.equal(raced.status, "partial");
  assert.equal(ledger.get(manifest.id)!.status, "partial", "stale coverage cannot publish a concurrently refreshed manifest");
});

test("verified resolution of all source gaps permits an honest no-interactions disposition", t => {
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  const manifest = inventoryPeople({ agentId: "alpha", kind: "nightly", timezone: "UTC", now: Date.parse("2026-11-16T03:10:00Z"),
    people: f.people, databasePath: join(f.root, "absent.sqlite"), exportRoot: join(f.root, "private") });
  const receipt = receiptFor(manifest);
  receipt.sourceGapReviews = manifest.sourceGaps.map(g => ({ sourceGapId: g.id, status: "resolved", reason: "Checked original sources: no interactions",
    sourceRefs: ["native:original-day-history"], reviewedAt: "2026-11-16T04:00:00Z" }));
  assert.equal(verifyLearningCoverage(manifest, receipt, Date.parse("2026-11-16T05:00:00Z")).status, "complete");
});

test("coverage and durable checkpoints cannot hide omitted assertions, sessions, unknown identities, outages or earlier backlog", t => {
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  f.add("dm", "workspace", "direct");
  const manifest = f.inventory("weekly"), receipt = receiptFor(manifest);
  const now = Date.parse("2026-11-16T05:00:00Z");
  assert.equal(verifyLearningCoverage(manifest, receipt, now).status, "complete");
  assert.equal(verifyLearningCoverage(manifest, { ...receipt, assertionReviews: receipt.assertionReviews.slice(1) }, now).status, "partial");
  assert.equal(verifyLearningCoverage(manifest, { ...receipt, assertionReviews: receipt.assertionReviews.map(r => ({ ...r, sourceRefs: [] })) }, now).status, "invalid");
  const path = join(f.root, "review.sqlite");
  let ledger = new PeopleLearningStore(path, "alpha");
  ledger.begin(manifest);
  const first = { ...receipt, assertionReviews: receipt.assertionReviews.slice(0, 1) };
  assert.equal(ledger.checkpoint(manifest.id, first, now).status, "partial");
  ledger.close(); ledger = new PeopleLearningStore(path, "alpha");
  assert.equal(ledger.backlog().length, 1);
  const later = { ...manifest, id: "nightly:2026-11-16", kind: "nightly" as const, assertions: [] };
  ledger.begin(later); ledger.checkpoint(later.id, { ...receiptFor(later) }, now);
  assert.ok(ledger.backlog().some(r => r.id === manifest.id));
  assert.equal(ledger.checkpoint(manifest.id, { ...receipt, assertionReviews: receipt.assertionReviews.slice(1) }, now).status, "complete");
  const nextWeek = { ...manifest, id: "weekly:2026-12-06", createdAt: "2026-12-07T03:10:00Z", window: { ...manifest.window, localDay: "2026-12-06" } };
  ledger.planMissedWindows(nextWeek);
  assert.ok(ledger.get("weekly:2026-11-22")!.manifest.inventoryPending);
  assert.ok(ledger.get("weekly:2026-11-29")!.manifest.inventoryPending);
  assert.throws(() => ledger.checkpoint("weekly:2026-11-22", receipt, now), /Inventory the missed window/);
  ledger.close();
  assert.throws(() => new PeopleLearningStore(path, "beta"), /another agent/);
  f.add("unknown", "workspace", "group", "UNMAPPED");
  const gaps = f.inventory();
  assert.ok(gaps.sourceGaps.some(g => g.sessionId === "unknown"));
  assert.equal(verifyLearningCoverage(gaps, receiptFor(gaps), now).status, "partial");
  const skipped = receiptFor(gaps); skipped.peopleReviews.find(p => p.personId === f.a)!.sessionIds = [];
  assert.equal(verifyLearningCoverage(gaps, skipped, now).status, "partial");
  const outage = inventoryPeople({ agentId: "alpha", kind: "weekly", timezone: "UTC", now,
    people: f.people, databasePath: join(f.root, "missing.sqlite"), exportRoot: join(f.root, "private") });
  assert.equal(outage.assertions.length, 7, "unknown activity conservatively inventories every dossier, including paused records");
  assert.equal(verifyLearningCoverage(outage, receiptFor(outage), now + 60_000).status, "partial");
});

test("registered service reconciles after startup/reload and only exposes private review tools in exact owned cron sessions", async t => {
  const root = mkdtempSync(join(tmpdir(), "people-service-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const legacyRoot = join(workspace, "logs/people-reflection"); mkdirSync(legacyRoot, { recursive: true });
  writeFileSync(join(legacyRoot, "backlog.json"), JSON.stringify({ bootstrapRequired: true, unresolved: ["Original evidence outage"] }));
  const hostConfig: OpenClawConfig = { agents: { defaults: { workspace }, entries: { alpha: { workspace } } } };
  const stores = new PeopleStores({ stateRoot: root, maxOpenTodos: 10, maxBlurbChars: 1200 }); t.after(() => stores.closeAll());
  const person = stores.get("alpha").upsertIdentity({ provider: "slack", accountScope: "workspace", externalId: "U1", isBot: false }).person;
  stores.get("alpha").replaceDossier(person.id, "Original verified source", { schemaVersion: 1, blurb: "Team lead.", sections: [] });
  const h = hostCron();
  let service: OpenClawPluginService | undefined, factory: OpenClawPluginToolFactory | undefined;
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const api = { config: hostConfig, pluginConfig: { people: { enabled: true, whisperer: { enabled: true } } },
    logger: { warn(message: string) { assert.fail(message); } },
    registerService(value: OpenClawPluginService) { service = value; },
    registerTool(value: OpenClawPluginToolFactory) { factory = value; },
    on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, handler); },
  } as unknown as OpenClawPluginApi;
  registerPeopleLearning(api, enabled(), stores);
  let cronVersion = 0;
  await service!.start({ config: hostConfig, stateDir: root, logger: api.logger, getCron: () => {
    const captured = cronVersion;
    return { ...h.cron, async list(input) {
      if (captured !== cronVersion) throw new Error("Plugin service cron scheduler was replaced");
      return h.cron.list(input);
    }, remove: async () => ({}), removeStaleJobFamily: async () => 0 };
  } });
  await hooks.get("gateway_start")!({}, {});
  const count = h.writes.length;
  cronVersion++;
  await hooks.get("cron_reconciled")!({ reason: "reload" }, { config: hostConfig });
  assert.equal(h.writes.length, count);
  const job = h.jobs.find(j => String(j.name).endsWith(":nightly"))!;
  const context = { config: hostConfig, agentId: "alpha", sessionKey: `agent:alpha:cron:${job.id}:run:r1` };
  assert.equal(await factory!({ ...context, sessionKey: "agent:alpha:slack:channel:C1" }), null);
  const tool = await factory!(context); assert.ok(tool);
  assert.ok(!Array.isArray(tool));
  const inventory = await tool.execute("inventory", { action: "inventory", kind: "nightly" });
  assert.equal(inventory.content[0]!.type, "text");
  const result = JSON.parse(String(record(inventory.content[0])!.text));
  assert.equal(result.manifest.agentId, "alpha");
  assert.equal(result.status, "partial", "missing native source must never count as complete");
  assert.ok(result.backlog.length);
  assert.ok(result.backlog.some((r: { id: string }) => r.id.startsWith("legacy:")));
  assert.equal(result.manifest.assertions.length, 1, "legacy bootstrap includes full dossiers even without available activity");
  const nextKind = await tool.execute("weekly", { action: "inventory", kind: "weekly" });
  assert.equal(JSON.parse(String(record(nextKind.content[0])!.text)).manifest.kind, "weekly", "unchanged legacy imports cannot block the next review kind");
  const runManifest = result.manifest as ReviewManifest;
  const proposed = receiptFor(runManifest);
  const checkedAt = new Date().toISOString();
  proposed.peopleReviews = [];
  proposed.assertionReviews = proposed.assertionReviews.map(r => ({ ...r, disposition: "retired", reviewedAt: checkedAt, correctionsCheckedAt: checkedAt }));
  const checkpoint = async (receipt: LearningReceipt) => {
    const response = await tool.execute("checkpoint", { action: "checkpoint", runId: runManifest.id, receipt });
    return JSON.parse(String(record(response.content[0])!.text));
  };
  const unsaved = await checkpoint(proposed);
  assert.equal(unsaved.status, "invalid");
  assert.ok(unsaved.errors.some((e: string) => e.includes("not saved")));
  stores.get("alpha").deleteDossier(person.id, "Checked original source: role was superseded");
  proposed.changes = [{ personId: person.id, changeId: stores.get("alpha").getDossierRevision(person.id)! }];
  const saved = await checkpoint(proposed);
  assert.equal(saved.status, "partial", "real deletion resolves invalid save but source and legacy gaps remain");
  assert.deepEqual(saved.errors, []);
  for (const toolName of ["message", "exec", "cron", "sessions_spawn", "write"]) {
    const blocked = hooks.get("before_tool_call")!({ toolName, params: {} }, context);
    assert.equal(record(blocked)?.block, true, toolName);
  }
  assert.equal(record(hooks.get("before_tool_call")!({ toolName: "memory_people_update", params: { action: "restore" } }, context))?.block, true);
  assert.equal(hooks.get("before_tool_call")!({ toolName: "message" }, { ...context, sessionKey: "agent:alpha:slack:channel:C1" }), undefined);
  await hooks.get("cron_reconciled")!({ reason: "reload" }, { config: { ...hostConfig,
    plugins: { entries: { "unblock-memory": { config: { people: { enabled: false } } } } } } });
  assert.ok(h.jobs.every(job => !job.enabled), "disabling PeopleSQL retires owned schedules");
  const disabled = await tool.execute("disabled", { action: "inspect", runId: result.manifest.id });
  assert.equal(JSON.parse(String(record(disabled.content[0])!.text)).status, "disabled");
  await hooks.get("cron_reconciled")!({ reason: "reload" }, { config: hostConfig });
  assert.ok(h.jobs.every(job => job.enabled));
  await hooks.get("cron_reconciled")!({ reason: "reload" }, { config: { ...hostConfig,
    plugins: { entries: { "unblock-memory": { enabled: true } } } } });
  assert.ok(h.jobs.every(job => !job.enabled), "removing feature config must not resurrect the initial options");
  await service!.stop!({ config: hostConfig, stateDir: root, logger: api.logger });
  const stopped = await tool.execute("stopped", { action: "inspect", runId: result.manifest.id });
  assert.equal(JSON.parse(String(record(stopped.content[0])!.text)).status, "unavailable");
});

test("weekly checkpoints discover every statement in a newly saved participant dossier", async t => {
  let now = Date.parse("2026-11-16T05:00:00Z");
  t.mock.method(Date, "now", () => now);
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  f.add("dm", "workspace", "direct");
  f.people.deleteDossier(f.a, "No saved dossier when weekly review begins");
  const workspace = join(f.root, "workspace"); mkdirSync(workspace);
  const hostConfig: OpenClawConfig = { agents: { defaults: { workspace, userTimezone: "UTC" }, entries: { alpha: { workspace, agentDir: f.root } } } };
  const h = hostCron();
  let service: OpenClawPluginService | undefined, factory: OpenClawPluginToolFactory | undefined;
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const api = { config: hostConfig, pluginConfig: { people: { enabled: true, whisperer: { enabled: true } } },
    logger: { warn(message: string) { assert.fail(message); } },
    registerService(value: OpenClawPluginService) { service = value; },
    registerTool(value: OpenClawPluginToolFactory) { factory = value; },
    on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, handler); },
  } as unknown as OpenClawPluginApi;
  registerPeopleLearning(api, enabled(), f.stores);
  await service!.start({ config: hostConfig, stateDir: f.root, logger: api.logger,
    getCron: () => ({ ...h.cron, remove: async () => ({}), removeStaleJobFamily: async () => 0 }) });
  await hooks.get("gateway_start")!({}, {});
  const job = h.jobs.find(j => String(j.name).endsWith(":weekly"))!;
  const tool = await factory!({ config: hostConfig, agentId: "alpha", sessionKey: `agent:alpha:cron:${job.id}:run:r1` });
  assert.ok(tool && !Array.isArray(tool));
  const call = async (params: unknown) => {
    const result = await tool.execute("review", params);
    return JSON.parse(String(record(result.content[0])!.text));
  };
  const initial = await call({ action: "inventory", kind: "weekly" });
  const manifest = initial.manifest as ReviewManifest;
  assert.equal(manifest.assertions.length, 0);
  now += 300_000;
  f.people.replaceDossier(f.a, "Verified newly discovered source", { schemaVersion: 1, blurb: "Leads the team.", sections: [
    { category: "role", claims: [{ statement: "Coordinates delivery", epistemicType: "reported", evidence: [{ source: "manual", locator: "Original role statement" }] }] },
  ] });
  const legacyDb = new DatabaseSync(join(f.root, "agents/alpha/unblock-memory/unblock-memory.sqlite"));
  legacyDb.prepare("DELETE FROM person_dossier_changes WHERE person_id=?").run(f.a);
  legacyDb.close();
  assert.equal(f.people.getDossierRevision(f.a), null, "pre-v4 state has no change revision");
  const incomplete = await call({ action: "checkpoint", runId: manifest.id, receipt: receiptFor(manifest) });
  assert.equal(incomplete.status, "partial");
  assert.equal(incomplete.expectedAssertions, 2);
  const changedTimezone = { ...hostConfig, agents: { ...hostConfig.agents, defaults: { workspace, userTimezone: "America/New_York" } } };
  await hooks.get("cron_reconciled")!({}, { config: changedTimezone });
  const refreshed = await call({ action: "inspect", runId: manifest.id });
  assert.equal(refreshed.run.manifest.window.timezone, "UTC");
  const receipt = receiptFor(refreshed.run.manifest);
  receipt.peopleReviews = [];
  const completed = await call({ action: "checkpoint", runId: manifest.id, receipt });
  assert.equal(completed.status, "complete");
  assert.equal(f.people.isDossierVerified(f.a), true);
  const manualConfig = { people: { enabled: true, whisperer: { enabled: true } },
    typesafe: { enabled: true, apiKey: "fake" }, responseAudit: { enabled: true, senderIds: ["U1"], intervalMinutes: 0 } };
  await hooks.get("cron_reconciled")!({}, { config: { ...hostConfig, plugins: { entries: { "unblock-memory": { config: manualConfig } } } } });
  t.mock.method(globalThis, "fetch", () => { assert.fail("Scheduled review must not start manual-only provider calls"); });
  const signals = await call({ action: "signals", runId: manifest.id });
  assert.equal(signals.status, "not_approved");
  const automatic = { ...manualConfig, responseAudit: { enabled: true, senderIds: ["NOONE"], intervalMinutes: 45, lookbackDays: 30 } };
  await hooks.get("cron_reconciled")!({}, { config: { ...hostConfig, plugins: { entries: { "unblock-memory": { config: automatic } } } } });
  const oldSignals = await call({ action: "signals", runId: manifest.id });
  assert.equal(oldSignals.status, "complete");
  await hooks.get("cron_reconciled")!({}, { config: { ...hostConfig, plugins: { entries: { "unblock-memory": {
    config: { ...automatic, responseAudit: { ...automatic.responseAudit, senderIds: ["U1"] } },
  } } } } });
  const wrongCohort = await call({ action: "checkpoint", runId: manifest.id,
    receipt: { ...receipt, analysis: { status: "complete", reason: "Previously completed analysis" } } });
  assert.equal(wrongCohort.status, "invalid", "a prior approval cohort cannot certify newly approved work");
  const legacyRoot = join(workspace, "logs/people-reflection"); mkdirSync(legacyRoot, { recursive: true });
  writeFileSync(join(legacyRoot, "backlog.json"), JSON.stringify({ privateMarker: "ALPHA_PRIVATE_BACKLOG" }));
  const sharedConfig = { ...hostConfig, agents: { defaults: { workspace, userTimezone: "UTC" },
    entries: { alpha: { workspace, agentDir: f.root }, beta: { workspace } } } };
  await hooks.get("cron_reconciled")!({}, { config: sharedConfig });
  const betaJob = h.jobs.find(j => j.agentId === "beta" && String(j.name).endsWith(":nightly"))!;
  const betaTool = await factory!({ config: sharedConfig, agentId: "beta", sessionKey: `agent:beta:cron:${betaJob.id}:run:r2` });
  assert.ok(betaTool && !Array.isArray(betaTool));
  const betaInventory = await betaTool.execute("review", { action: "inventory", kind: "nightly" });
  const betaResult = JSON.parse(String(record(betaInventory.content[0])!.text));
  assert.ok(!betaResult.backlog.some((run: { id: string }) => run.id.startsWith("legacy:")));
  assert.doesNotMatch(JSON.stringify(betaResult), /ALPHA_PRIVATE_BACKLOG/u);
  assert.ok(betaResult.manifest.sourceGaps.some((gap: { reason: string }) => gap.reason.includes("ownership")));
  writeFileSync(join(legacyRoot, "backlog.json"), JSON.stringify({ agentId: "alpha", privateMarker: "ALPHA_PRIVATE_BACKLOG" }));
  const ownedSource = await betaTool.execute("review", { action: "inventory", kind: "weekly" });
  assert.doesNotMatch(JSON.stringify(ownedSource), /ALPHA_PRIVATE_BACKLOG/u);
  await service!.stop!({ config: hostConfig, stateDir: f.root, logger: api.logger });
});
