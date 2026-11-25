import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig, OpenClawPluginApi, OpenClawPluginService, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { Value } from "typebox/value";
import { resolveConfig } from "../src/config.js";
import { learningForAgent, PEOPLE_LEARNING_SCHEMA } from "../src/people-learning-config.js";
import { reviewWindow } from "../src/people-learning-time.js";
import { learningSession, reconcilePeopleLearning, type PeopleCron } from "../src/people-learning-cron.js";
import { inventoryPeople, privateJson, type ReviewManifest } from "../src/people-learning-inventory.js";
import { manifestRevision, PeopleLearningStore, verifyLearningCoverage, type LearningReceipt } from "../src/people-learning-store.js";
import { PeopleStores } from "../src/people-store.js";
import { registerPeopleLearning } from "../src/people-learning-runtime.js";
import { createAgentDatabase, insertSession, compressAgentTranscripts } from "./helpers/session-database.js";
import { record } from "../src/guards.js";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

// SDK-backed fixtures keep cron mutation and persisted message shapes honest.
// These private imports are test-only and requalified with the pinned host SDK.
const sdkDist = fileURLToPath(new URL("../", import.meta.resolve("openclaw/plugin-sdk/plugin-entry")));
const sdkJobsFile = readdirSync(sdkDist).find(name => /^jobs-.*\.mjs$/u.test(name) &&
  readFileSync(join(sdkDist, name), "utf8").includes("function applyJobPatch("))!;
const sdkJobs = await import(pathToFileURL(join(sdkDist, sdkJobsFile)).href) as {
  n(job: Job, patch: Parameters<PeopleCron["update"]>[1]): void;
};
const sdkUserFile = readdirSync(sdkDist).find(name => /^session-transcript-rewrite-effects-.*\.mjs$/u.test(name))!;
const sdkUser = await import(pathToFileURL(join(sdkDist, sdkUserFile)).href) as {
  o(params: Record<string, unknown>): Record<string, unknown>;
};

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
      sdkJobs.n(job, structuredClone(patch));
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
  const externalUser = (content: string, { senderId = "U1", accountId = "workspace", withAttachment = false } = {}) => sdkUser.o({
    text: content, provenance: { kind: "external_user" }, sender: { id: senderId, identity: { id: senderId, senderKind: "human" } },
    transport: { channel: "slack", accountId, conversationRef: "conversation-dm" },
    ...(withAttachment ? { media: [{ path: "/private/requirements.pdf", contentType: "application/pdf", kind: "document" }] } : {}),
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
  const withImageRun = ledger.begin(f.inventory());
  const withImage = withImageRun.manifest, receipt = receiptFor(withImage);
  receipt.manifestRevision = withImageRun.manifestRevision;
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
    const response = await tool.execute("checkpoint", { action: "checkpoint", runId: runManifest.id, manifestRevision: result.manifestRevision, receipt });
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
  const incomplete = await call({ action: "checkpoint", runId: manifest.id, manifestRevision: initial.manifestRevision, receipt: receiptFor(manifest) });
  assert.equal(incomplete.status, "partial");
  assert.equal(incomplete.expectedAssertions, 2);
  assert.notEqual(incomplete.manifestRevision, initial.manifestRevision);
  const changedTimezone = { ...hostConfig, agents: { ...hostConfig.agents, defaults: { workspace, userTimezone: "America/New_York" } } };
  await hooks.get("cron_reconciled")!({}, { config: changedTimezone });
  const refreshed = await call({ action: "inspect", runId: manifest.id });
  assert.equal(refreshed.run.manifest.window.timezone, "UTC");
  assert.equal(refreshed.manifestRevision, refreshed.run.manifestRevision);
  const receipt = receiptFor(refreshed.run.manifest);
  receipt.peopleReviews = [];
  const completed = await call({ action: "checkpoint", runId: manifest.id, manifestRevision: refreshed.manifestRevision, receipt });
  assert.equal(completed.status, "complete");
  assert.equal(f.people.isDossierVerified(f.a), true);
  const manualConfig = { people: { enabled: true, whisperer: { enabled: true } },
    decisionModel: { enabled: true, apiKey: "fake" }, responseAudit: { enabled: true, senderIds: ["U1"], intervalMinutes: 0 } };
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
  const wrongCohort = await call({ action: "checkpoint", runId: manifest.id, manifestRevision: refreshed.manifestRevision,
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

test("startup inspection deferral coalesces boot hooks quietly, retries quickly, and escalates persistent errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "people-learning-startup-"));
  const stores = new PeopleStores({ stateRoot: root, maxOpenTodos: 10, maxBlurbChars: 1200 });
  const hostConfig: OpenClawConfig = { agents: { defaults: { userTimezone: "UTC" }, entries: { alpha: {} } } };
  const h = hostCron();
  let mode: "prep" | "ok" | "fatal" = "prep";
  let listCalls = 0;
  let releaseFirst: (() => void) | undefined;
  const firstEntered = new Promise<void>(resolve => {
    const baseList = h.cron.list.bind(h.cron);
    h.cron.list = async (input) => {
      listCalls++;
      if (listCalls === 1) {
        resolve();
        await new Promise<void>(done => { releaseFirst = done; });
      }
      if (mode === "prep") throw new Error("Agent main has not completed startup inspection and preparation. Inspection and writable admission continue after the Gateway listener binds.");
      if (mode === "fatal") throw new Error("cron storage corrupt");
      return baseList(input);
    };
  });
  let service: OpenClawPluginService | undefined;
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const infos: string[] = [], warns: string[] = [];
  const scheduled: { id: string; delayMs: number; run: () => Promise<void> | void; cancelled: boolean }[] = [];
  let schedulerClosed = false;
  const api = {
    config: hostConfig,
    pluginConfig: { people: { enabled: true, whisperer: { enabled: true } } },
    logger: { info(m: string) { infos.push(m); }, warn(m: string) { warns.push(m); } },
    registerService(value: OpenClawPluginService) { service = value; },
    registerTool() {},
    on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, handler); },
  } as unknown as OpenClawPluginApi;
  registerPeopleLearning(api, enabled(), stores);
  await service!.start({
    config: hostConfig, stateDir: root, logger: api.logger,
    getCron: () => ({ ...h.cron, remove: async () => ({}), removeStaleJobFamily: async () => 0 }),
    scheduler: {
      schedule(task: { id: string; delayMs: number; run: () => Promise<void> | void }) {
        if (schedulerClosed) throw new Error("Plugin service scheduler is closed");
        const entry = { ...task, cancelled: false };
        scheduled.push(entry);
        return { cancel() { entry.cancelled = true; } };
      },
    },
  } as unknown as Parameters<OpenClawPluginService["start"]>[0]);
  await firstEntered;
  // Concurrent boot triggers coalesce rather than chaining duplicate warnings.
  const gw = hooks.get("gateway_start")!({}, {});
  const cr = hooks.get("cron_reconciled")!({ reason: "boot" }, {});
  releaseFirst!();
  await Promise.all([gw, cr]);
  assert.equal(listCalls, 1, "same-generation boot hooks defer to the scheduled retry instead of hammering immediately");
  assert.equal(warns.length, 0);
  assert.equal(infos.length, 1);
  assert.equal(scheduled.at(-1)?.delayMs, 5_000);

  // Recovery on retry registers jobs cleanly, cancels pending timer, and resets quiet retry budget.
  const firstTimer = scheduled.at(-1)!;
  mode = "ok";
  await firstTimer.run();
  assert.equal(warns.length, 0);
  assert.equal(h.jobs.length, 2);
  assert.equal(firstTimer.cancelled, true);

  // Persistent startup-prep failures escalate to warn + 60s backoff after the quiet budget.
  mode = "prep";
  for (let i = 0; i < 8; i++) {
    await hooks.get("gateway_start")!({}, {});
    assert.equal(warns.length, 0);
    assert.equal(scheduled.at(-1)?.delayMs, 5_000);
  }
  await hooks.get("gateway_start")!({}, {});
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /startup inspection and preparation/);
  assert.equal(scheduled.at(-1)?.delayMs, 60_000);

  // Genuine non-startup errors warn immediately with 60s backoff.
  mode = "ok";
  await hooks.get("gateway_start")!({}, {});
  mode = "fatal";
  await hooks.get("gateway_start")!({}, {});
  assert.equal(warns.length, 2);
  assert.match(warns[1]!, /cron storage corrupt/);
  assert.equal(scheduled.at(-1)?.delayMs, 60_000);

  // Closed scheduler during shutdown/reload never rejects reconcile() or crashes stop().
  schedulerClosed = true;
  await hooks.get("gateway_start")!({}, {});
  assert.equal(warns.length, 3);
  await service!.stop!({ config: hostConfig, stateDir: root, logger: api.logger });
  stores.closeAll();
});

test("stale receipt patches after manifest refresh are rejected in store, verifier, and runtime tool", async t => {
  let now = Date.parse("2026-11-16T05:00:00Z");
  t.mock.method(Date, "now", () => now);
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  f.add("dm", "workspace", "direct");
  const setImage = (data: string) => {
    const event = JSON.parse(String(f.db.prepare("SELECT event_json FROM transcript_events WHERE session_id='dm' AND seq=1").get()!.event_json));
    event.message.content = [{ type: "text", text: "Use this image" }, { type: "image", mimeType: "image/png", data }];
    f.db.prepare("UPDATE transcript_events SET event_json=? WHERE session_id='dm' AND seq=1").run(JSON.stringify(event));
  };
  setImage("image-v1");

  // Store-level verification: reopening a completed run via source refresh rejects both stale and unversioned late patches.
  const ledgerPath = join(f.root, "revision-binding.sqlite");
  const ledger = new PeopleLearningStore(ledgerPath, "alpha"); t.after(() => ledger.close());
  const firstRun = ledger.begin(f.inventory());
  const rev1 = firstRun.manifestRevision;
  assert.equal(rev1, manifestRevision(firstRun.manifest));
  const receipt1 = receiptFor(firstRun.manifest);
  receipt1.manifestRevision = rev1;
  receipt1.sourceGapReviews = firstRun.manifest.sourceGaps.map(g => ({
    sourceGapId: g.id, status: "resolved", reason: "Verified v1 attachment",
    sourceRefs: ["native:dm:1"], reviewedAt: "2026-11-16T04:00:00Z",
  }));
  assert.equal(ledger.checkpoint(firstRun.manifest.id, receipt1, now).status, "complete");

  now += 60_000;
  setImage("image-v2");
  const refreshedRun = ledger.begin(f.inventory());
  const rev2 = refreshedRun.manifestRevision;
  assert.notEqual(rev2, rev1);
  assert.equal(refreshedRun.status, "partial");

  // Standalone verifier rejects stale manifestRevision while still accepting unversioned offline receipts.
  assert.equal(verifyLearningCoverage(refreshedRun.manifest, receipt1, now).status, "invalid");
  const { manifestRevision: _omitted, ...unversionedReceipt } = receipt1;
  assert.equal(verifyLearningCoverage(refreshedRun.manifest, unversionedReceipt, now).status, "complete");

  // Late patch carrying rev1 (in receipt or explicit parameter) is rejected and cannot reintroduce stale coverage.
  const staleInReceipt = ledger.checkpoint(firstRun.manifest.id, receipt1, now + 1);
  assert.equal(staleInReceipt.status, "invalid");
  assert.ok(staleInReceipt.errors.some(e => e.includes("Stale manifest revision")));
  assert.equal(ledger.get(firstRun.manifest.id)!.status, "partial");
  assert.deepEqual(ledger.get(firstRun.manifest.id)!.receipt!.sourceGapReviews, []);

  const staleInArg = ledger.checkpoint(firstRun.manifest.id, unversionedReceipt, now + 2, undefined, undefined, rev1);
  assert.equal(staleInArg.status, "invalid");
  assert.ok(staleInArg.errors.some(e => e.includes("Stale manifest revision")));
  assert.equal(ledger.get(firstRun.manifest.id)!.status, "partial");

  // Late unversioned patch omitting manifestRevision after a source refresh reopened the run is also rejected.
  const omittedAfterReopen = ledger.checkpoint(firstRun.manifest.id, unversionedReceipt, now + 3);
  assert.equal(omittedAfterReopen.status, "invalid");
  assert.ok(omittedAfterReopen.errors.some(e => e.includes("Manifest was refreshed")));
  assert.equal(ledger.get(firstRun.manifest.id)!.status, "partial");

  // Fresh receipt bound to rev2 succeeds cleanly.
  const completedV2 = ledger.checkpoint(firstRun.manifest.id, { ...unversionedReceipt, manifestRevision: rev2 }, now + 4);
  assert.equal(completedV2.status, "complete");
  assert.equal(completedV2.manifestRevision, rev2);

  // Runtime tool contract: checkpoint propagates manifestRevision and rejects stale or conflicting revisions.
  const workspace = join(f.root, "workspace-rev"); mkdirSync(workspace);
  const hostConfig: OpenClawConfig = { agents: { defaults: { workspace, userTimezone: "UTC" }, entries: { alpha: { workspace, agentDir: f.root } } } };
  const h = hostCron();
  let service: OpenClawPluginService | undefined, factory: OpenClawPluginToolFactory | undefined;
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const api = {
    config: hostConfig, pluginConfig: { people: { enabled: true, whisperer: { enabled: true } } },
    logger: { warn(m: string) { assert.fail(m); } },
    registerService(v: OpenClawPluginService) { service = v; },
    registerTool(v: OpenClawPluginToolFactory) { factory = v; },
    on(name: string, fn: (...args: unknown[]) => unknown) { hooks.set(name, fn); },
  } as unknown as OpenClawPluginApi;
  registerPeopleLearning(api, enabled(), f.stores);
  await service!.start({ config: hostConfig, stateDir: f.root, logger: api.logger,
    getCron: () => ({ ...h.cron, remove: async () => ({}), removeStaleJobFamily: async () => 0 }) });
  await hooks.get("gateway_start")!({}, {});
  const nightlyJob = h.jobs.find(j => String(j.name).endsWith(":nightly"))!;
  const tool = await factory!({ config: hostConfig, agentId: "alpha", sessionKey: `agent:alpha:cron:${nightlyJob.id}:run:r1` });
  assert.ok(tool && !Array.isArray(tool));
  const call = async (params: unknown) => JSON.parse(String(record((await tool.execute("rev", params)).content[0])!.text));

  setImage("tool-v1");
  const inv1 = await call({ action: "inventory", kind: "nightly" });
  now += 60_000;
  const toolReceipt1 = receiptFor(inv1.manifest);
  toolReceipt1.sourceGapReviews = inv1.manifest.sourceGaps.map((g: { id: string }) => ({
    sourceGapId: g.id, status: "resolved", reason: "Verified tool v1",
    sourceRefs: ["native:dm:1"], reviewedAt: new Date(now).toISOString(),
  }));
  const done1 = await call({ action: "checkpoint", runId: inv1.manifest.id, manifestRevision: inv1.manifestRevision, receipt: toolReceipt1 });
  assert.equal(done1.status, "complete");

  now += 60_000;
  setImage("tool-v2");
  const inv2 = await call({ action: "inventory", kind: "nightly" });
  assert.notEqual(inv2.manifestRevision, inv1.manifestRevision);
  assert.equal(inv2.status, "partial");

  const lateToolPatch = await call({ action: "checkpoint", runId: inv1.manifest.id, manifestRevision: inv1.manifestRevision, receipt: toolReceipt1 });
  assert.equal(lateToolPatch.status, "invalid");
  assert.ok(lateToolPatch.errors.some((e: string) => e.includes("Stale manifest revision")));

  const conflictingToolPatch = await call({
    action: "checkpoint", runId: inv1.manifest.id, manifestRevision: inv2.manifestRevision,
    receipt: { ...toolReceipt1, manifestRevision: inv1.manifestRevision },
  });
  assert.equal(conflictingToolPatch.status, "invalid");
  assert.ok(conflictingToolPatch.errors.some((e: string) => e.includes("Conflicting manifest revision")));

  const freshToolPatch = await call({ action: "checkpoint", runId: inv2.manifest.id, manifestRevision: inv2.manifestRevision, receipt: toolReceipt1 });
  assert.equal(freshToolPatch.status, "complete");
  await service!.stop!({ config: hostConfig, stateDir: f.root, logger: api.logger });
});

test("older in-flight analysis cannot overwrite or regress a newer analysis result or basis", async t => {
  let now = Date.parse("2026-11-16T05:00:00Z");
  t.mock.method(Date, "now", () => now);
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  f.add("dm", "workspace", "direct");

  // Store-level fencing: startedAt, manifest revision, and equal-timestamp status regression checks.
  const ledger = new PeopleLearningStore(join(f.root, "analysis-fence.sqlite"), "alpha"); t.after(() => ledger.close());
  const run = ledger.begin(f.inventory("weekly"));
  assert.deepEqual(
    ledger.recordAnalysis(run.manifest.id, "complete", { v: 2 }, "basis-new", {
      expectedManifestRevision: run.manifestRevision, startedAt: now + 2_000, recordedAt: now + 2_100,
    }),
    { recorded: true },
  );
  assert.deepEqual(
    ledger.recordAnalysis(run.manifest.id, "unresolved", { v: 1 }, "basis-old", {
      expectedManifestRevision: run.manifestRevision, startedAt: now + 1_000, recordedAt: now + 3_000,
    }),
    { recorded: false, reason: "superseded" },
  );
  assert.deepEqual(
    ledger.recordAnalysis(run.manifest.id, "complete", { v: 3 }, "basis-stale-manifest", {
      expectedManifestRevision: "stale-manifest-revision", startedAt: now + 5_000, recordedAt: now + 5_100,
    }),
    { recorded: false, reason: "manifest_changed" },
  );
  assert.deepEqual(
    ledger.recordAnalysis(run.manifest.id, "unresolved", { v: 2 }, "basis-new", {
      expectedManifestRevision: run.manifestRevision, startedAt: now + 2_000, recordedAt: now + 2_200,
    }),
    { recorded: false, reason: "superseded" },
  );
  const stored = ledger.analysis(run.manifest.id);
  assert.equal(stored?.status, "complete");
  assert.equal(stored?.basis, "basis-new");

  // Runtime-level overlapping signals calls: slow older call finishing after a newer cohort call cannot overwrite it.
  const workspace = join(f.root, "workspace-analysis"); mkdirSync(workspace);
  const automaticU1 = {
    people: { enabled: true, whisperer: { enabled: true } },
    decisionModel: { enabled: true, apiKey: "fake" },
    responseAudit: { enabled: true, senderIds: ["U1"], intervalMinutes: 45, lookbackDays: 30 },
  };
  const automaticNoOne = {
    ...automaticU1,
    responseAudit: { ...automaticU1.responseAudit, senderIds: ["NOONE"] },
  };
  const hostConfig: OpenClawConfig = {
    agents: { defaults: { workspace, userTimezone: "UTC" }, entries: { alpha: { workspace, agentDir: f.root } } },
    plugins: { entries: { "unblock-memory": { config: automaticU1 } } },
  };
  const h = hostCron();
  let service: OpenClawPluginService | undefined, factory: OpenClawPluginToolFactory | undefined;
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const api = {
    config: hostConfig, pluginConfig: automaticU1,
    logger: { warn(m: string) { assert.fail(m); } },
    registerService(v: OpenClawPluginService) { service = v; },
    registerTool(v: OpenClawPluginToolFactory) { factory = v; },
    on(name: string, fn: (...args: unknown[]) => unknown) { hooks.set(name, fn); },
  } as unknown as OpenClawPluginApi;
  registerPeopleLearning(api, resolveConfig(automaticU1), f.stores);
  await service!.start({ config: hostConfig, stateDir: f.root, logger: api.logger,
    getCron: () => ({ ...h.cron, remove: async () => ({}), removeStaleJobFamily: async () => 0 }) });
  await hooks.get("gateway_start")!({}, {});
  const weeklyJob = h.jobs.find(j => String(j.name).endsWith(":weekly"))!;
  const tool = await factory!({ config: hostConfig, agentId: "alpha", sessionKey: `agent:alpha:cron:${weeklyJob.id}:run:r1` });
  assert.ok(tool && !Array.isArray(tool));
  const call = async (params: unknown) => JSON.parse(String(record((await tool.execute("sig", params)).content[0])!.text));

  const inv = await call({ action: "inventory", kind: "weekly" });
  let releaseOldFetch: (() => void) | undefined;
  const oldFetchStarted = new Promise<void>(resolve => {
    t.mock.method(globalThis, "fetch", async () => {
      resolve();
      await new Promise<void>(done => { releaseOldFetch = done; });
      return new Response("upstream error", { status: 503 });
    });
  });

  // Start slow older signals call (cohort U1) which blocks inside fetch.
  const slowOlder = call({ action: "signals", runId: inv.manifest.id });
  await oldFetchStarted;

  // Advance past the 180s response-audit lease so a newer signals call after config reload completes first.
  now += 200_000;
  await hooks.get("cron_reconciled")!({ reason: "reload" }, {
    config: { ...hostConfig, plugins: { entries: { "unblock-memory": { config: automaticNoOne } } } },
  });
  const newerSignals = await call({ action: "signals", runId: inv.manifest.id });
  assert.equal(newerSignals.status, "complete");

  // Unblock slow older call; it must be fenced and never overwrite the newer complete analysis.
  releaseOldFetch!();
  const olderSignals = await slowOlder;
  assert.equal(olderSignals.stale, true);
  assert.equal(olderSignals.status, "unresolved");

  const receipt = receiptFor(inv.manifest);
  receipt.peopleReviews = [];
  receipt.analysis = { status: "complete", reason: "Current cohort analysis completed" };
  const verified = await call({ action: "checkpoint", runId: inv.manifest.id, manifestRevision: inv.manifestRevision, receipt });
  assert.equal(verified.status, "complete", "older in-flight analysis must not regress newer analysis basis");
  await service!.stop!({ config: hostConfig, stateDir: f.root, logger: api.logger });
});

test("private artifacts publish atomically, replace truncated files, reject symlinks, and precede ledger commits", async t => {
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  const artifactRoot = join(f.root, "private-artifacts");
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });

  // A truncated partial file left from a crash must NEVER be accepted by existence; it is atomically replaced with 0o600 bytes.
  const targetPath = join(artifactRoot, "sample.json");
  writeFileSync(targetPath, "{\"truncated\":", { mode: 0o644 });
  chmodSync(targetPath, 0o644);
  const expected = { hello: "world", count: 42 };
  const published = privateJson(artifactRoot, "sample.json", expected);
  assert.equal(published, targetPath);
  assert.deepEqual(JSON.parse(readFileSync(published, "utf8")), expected);
  assert.equal(statSync(published).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(artifactRoot), ["sample.json"], "no leftover temporary files remain after atomic publish");

  // Pre-existing symlink at artifact target is rejected without touching the symlink target.
  const outsideTarget = join(f.root, "outside-secret.txt");
  writeFileSync(outsideTarget, "DO_NOT_TOUCH", { mode: 0o600 });
  const symlinkPath = join(artifactRoot, "symlinked.json");
  symlinkSync(outsideTarget, symlinkPath);
  assert.throws(() => privateJson(artifactRoot, "symlinked.json", { shouldNotWrite: true }), /regular file, not a symlink/);
  assert.equal(readFileSync(outsideTarget, "utf8"), "DO_NOT_TOUCH");

  // Store-level: if manifest artifact publication fails beforeCommit, the SQLite ledger transaction rolls back cleanly.
  const ledgerPath = join(f.root, "atomic-order.sqlite");
  const ledger = new PeopleLearningStore(ledgerPath, "alpha"); t.after(() => ledger.close());
  const manifest = f.inventory("nightly");
  assert.throws(
    () => ledger.begin(manifest, () => { throw new Error("Simulated manifest write failure"); }),
    /Simulated manifest write failure/,
  );
  assert.equal(ledger.get(manifest.id), undefined, "ledger must not commit a run row before manifest publication succeeds");
  const checkDb = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    assert.equal(checkDb.prepare("SELECT count(*) n FROM people_learning_inventories WHERE run_id=?").get(manifest.id)!.n, 0);
  } finally { checkDb.close(); }

  // Refresh failure also preserves prior run state intact.
  const committed = ledger.begin(manifest);
  const changedManifest = { ...manifest, sourceGaps: [{ id: "gap-new", reason: "New gap" }] };
  assert.throws(
    () => ledger.begin(changedManifest, () => { throw new Error("Disk full during refresh"); }),
    /Disk full during refresh/,
  );
  assert.equal(ledger.get(manifest.id)!.manifestRevision, committed.manifestRevision, "failed refresh publication must not mutate existing run");

  // End-to-end runtime inventory: a blocked manifest path prevents committing the SQLite run row.
  const now = Date.parse("2026-11-16T03:10:00Z");
  t.mock.method(Date, "now", () => now);
  const workspace = join(f.root, "workspace-atomic"); mkdirSync(workspace);
  const hostConfig: OpenClawConfig = { agents: { defaults: { workspace, userTimezone: "UTC" }, entries: { alpha: { workspace, agentDir: f.root } } } };
  const expectedManifest = inventoryPeople({
    agentId: "alpha", kind: "nightly", timezone: "UTC", now,
    people: f.people, databasePath: f.path, exportRoot: join(f.root, "agents/alpha/unblock-memory/people-learning/exports"),
  });
  const learningDir = join(f.root, "agents/alpha/unblock-memory/people-learning");
  mkdirSync(learningDir, { recursive: true, mode: 0o700 });
  symlinkSync(outsideTarget, join(learningDir, `${manifestRevision(expectedManifest)}.manifest.json`));
  const h = hostCron();
  let service: OpenClawPluginService | undefined, factory: OpenClawPluginToolFactory | undefined;
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const api = {
    config: hostConfig, pluginConfig: { people: { enabled: true, whisperer: { enabled: true } } },
    logger: { warn(m: string) { assert.fail(m); } },
    registerService(v: OpenClawPluginService) { service = v; },
    registerTool(v: OpenClawPluginToolFactory) { factory = v; },
    on(name: string, fn: (...args: unknown[]) => unknown) { hooks.set(name, fn); },
  } as unknown as OpenClawPluginApi;
  registerPeopleLearning(api, enabled(), f.stores);
  await service!.start({ config: hostConfig, stateDir: f.root, logger: api.logger,
    getCron: () => ({ ...h.cron, remove: async () => ({}), removeStaleJobFamily: async () => 0 }) });
  await hooks.get("gateway_start")!({}, {});
  const job = h.jobs.find(j => String(j.name).endsWith(":nightly"))!;
  const tool = await factory!({ config: hostConfig, agentId: "alpha", sessionKey: `agent:alpha:cron:${job.id}:run:r1` });
  assert.ok(tool && !Array.isArray(tool));
  await assert.rejects(tool.execute("inv", { action: "inventory", kind: "nightly" }), /regular file, not a symlink/);
  const runtimeLedger = new PeopleLearningStore(join(f.root, "agents/alpha/unblock-memory/unblock-memory.sqlite"), "alpha");
  t.after(() => runtimeLedger.close());
  assert.equal(runtimeLedger.get(expectedManifest.id), undefined, "runtime inventory must not commit ledger row when manifest publication fails");
  await service!.stop!({ config: hostConfig, stateDir: f.root, logger: api.logger });
});

test("missing or throwing getCron schedules retries and transient reconcile failures preserve cron recognition separately from authorization", async t => {
  const root = mkdtempSync(join(tmpdir(), "people-learning-cron-auth-"));
  const stores = new PeopleStores({ stateRoot: root, maxOpenTodos: 10, maxBlurbChars: 1200 });
  t.after(() => stores.closeAll());
  const hostConfig: OpenClawConfig = { agents: { defaults: { userTimezone: "UTC" }, entries: { alpha: {}, beta: {} } } };
  const h = hostCron([{
    id: "durable-alpha-nightly",
    agentId: "alpha",
    declarationKey: "unblock-memory:people-learning:alpha:nightly",
    name: "unblock-memory:people-learning:alpha:nightly",
    enabled: true,
  }]);
  const infos: string[] = [], warns: string[] = [];
  const scheduled: { id: string; delayMs: number; run: () => Promise<void> | void; cancelled: boolean }[] = [];
  let service: OpenClawPluginService | undefined, factory: OpenClawPluginToolFactory | undefined;
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const api = {
    config: hostConfig,
    pluginConfig: { people: { enabled: true, whisperer: { enabled: true } } },
    logger: { info(m: string) { infos.push(m); }, warn(m: string) { warns.push(m); } },
    registerService(v: OpenClawPluginService) { service = v; },
    registerTool(v: OpenClawPluginToolFactory) { factory = v; },
    on(name: string, fn: (...args: unknown[]) => unknown) { hooks.set(name, fn); },
  } as unknown as OpenClawPluginApi;
  registerPeopleLearning(api, enabled(), stores);

  let getCronMode: "missing" | "throw_prep" | "partial_fail" | "list_fail" | "ok" = "missing";
  const baseAdd = h.cron.add.bind(h.cron);
  const baseList = h.cron.list.bind(h.cron);
  h.cron.list = async (input) => {
    if (getCronMode === "list_fail") throw new Error("transient reload cron failure");
    return baseList(input);
  };
  h.cron.add = async (input) => {
    if (getCronMode === "partial_fail" && record(input)?.agentId === "beta") throw new Error("transient beta add failure");
    return baseAdd(input);
  };
  const makeScheduler = () => ({
    schedule(task: { id: string; delayMs: number; run: () => Promise<void> | void }) {
      const entry = { ...task, cancelled: false };
      scheduled.push(entry);
      return { cancel() { entry.cancelled = true; } };
    },
  });

  // 1. Missing getCron warns and schedules a retry instead of silently stopping reconciliation.
  service!.start({
    config: hostConfig, stateDir: root, logger: api.logger,
    getCron: () => {
      if (getCronMode === "missing") return undefined as unknown as ReturnType<NonNullable<Parameters<OpenClawPluginService["start"]>[0]["getCron"]>>;
      if (getCronMode === "throw_prep") throw new Error("Agent main has not completed startup inspection and preparation.");
      return { ...h.cron, remove: async () => ({}), removeStaleJobFamily: async () => 0 };
    },
    scheduler: makeScheduler(),
  } as unknown as Parameters<OpenClawPluginService["start"]>[0]);
  await hooks.get("gateway_start")!({}, {});
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /getCron/);
  assert.equal(scheduled.at(-1)?.delayMs, 60_000, "missing getCron must schedule a retry");

  // 2. Synchronous throw from getCron() is caught inside the rejection handler (quiet startup retry).
  getCronMode = "throw_prep";
  await scheduled.at(-1)!.run();
  assert.equal(warns.length, 1, "startup prep error thrown by getCron() retries quietly without crashing");
  assert.equal(infos.length, 1);
  assert.equal(scheduled.at(-1)?.delayMs, 5_000);

  // 3. Partial reconcile failure still recognizes durably declared jobs discovered from cron.list.
  getCronMode = "partial_fail";
  await scheduled.at(-1)!.run();
  assert.equal(warns.length, 2);
  assert.match(warns[1]!, /transient beta add failure/);
  assert.equal(scheduled.at(-1)?.delayMs, 60_000);
  const alphaSession = { config: hostConfig, agentId: "alpha", sessionKey: "agent:alpha:cron:durable-alpha-nightly:run:r1" };
  assert.equal(record(hooks.get("before_tool_call")!({ toolName: "exec", params: {} }, alphaSession))?.block, true,
    "durably declared job is recognized even when a sibling agent fails reconciliation");
  assert.equal(hooks.get("before_tool_call")!({ toolName: "read", params: {} }, alphaSession), undefined);
  assert.ok(await factory!(alphaSession), "recognized and currently authorized job exposes learning tool");

  // 4. Reload disables alpha while reconcile fails transiently: recognition is preserved while authorization is revoked immediately.
  getCronMode = "list_fail";
  const alphaDisabledCfg: OpenClawConfig = {
    ...hostConfig,
    plugins: { entries: { "unblock-memory": { config: { people: { enabled: true, whisperer: { enabled: true }, learning: { agents: { alpha: { enabled: false } } } } } } } },
  };
  await hooks.get("cron_reconciled")!({ reason: "reload" }, { config: alphaDisabledCfg });
  assert.equal(warns.length, 3);
  const blockedWhenDisabled = record(hooks.get("before_tool_call")!({ toolName: "read", params: {} }, alphaSession));
  assert.equal(blockedWhenDisabled?.block, true, "preserved recognition blocks tool calls when authorization is disabled");
  assert.match(String(blockedWhenDisabled?.blockReason), /disabled/);
  assert.equal(await factory!(alphaSession), null, "disabled agent is no longer authorized to receive the tool");

  // 5. Re-enabling alpha while reconcile recovers restores authorization and clears pending retry timer.
  getCronMode = "ok";
  const retryBeforeOk = scheduled.at(-1)!;
  await hooks.get("cron_reconciled")!({ reason: "reload" }, { config: hostConfig });
  assert.equal(retryBeforeOk.cancelled, true);
  assert.equal(hooks.get("before_tool_call")!({ toolName: "read", params: {} }, alphaSession), undefined);
  assert.ok(await factory!(alphaSession));
  await service!.stop!({ config: hostConfig, stateDir: root, logger: api.logger });
});

test("service reload (stop -> start) with transient getCron or cron.list failures preserves recognizedJobs", async t => {
  const root = mkdtempSync(join(tmpdir(), "people-learning-stop-retain-"));
  const stores = new PeopleStores({ stateRoot: root, maxOpenTodos: 10, maxBlurbChars: 1200 });
  t.after(() => stores.closeAll());
  const hostConfig: OpenClawConfig = { agents: { defaults: { userTimezone: "UTC" }, entries: { alpha: {} } } };
  const h = hostCron([{
    id: "durable-alpha-nightly",
    agentId: "alpha",
    declarationKey: "unblock-memory:people-learning:alpha:nightly",
    name: "unblock-memory:people-learning:alpha:nightly",
    enabled: true,
  }]);
  const warns: string[] = [];
  let service: OpenClawPluginService | undefined, factory: OpenClawPluginToolFactory | undefined;
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const api = {
    config: hostConfig,
    pluginConfig: { people: { enabled: true, whisperer: { enabled: true } } },
    logger: { warn(m: string) { warns.push(m); } },
    registerService(v: OpenClawPluginService) { service = v; },
    registerTool(v: OpenClawPluginToolFactory) { factory = v; },
    on(name: string, fn: (...args: unknown[]) => unknown) { hooks.set(name, fn); },
  } as unknown as OpenClawPluginApi;
  registerPeopleLearning(api, enabled(), stores);

  let mode: "ok" | "no_cron" | "list_fail" = "ok";
  const baseList = h.cron.list.bind(h.cron);
  h.cron.list = async (input) => {
    if (mode === "list_fail") throw new Error("transient reload cron.list failure");
    return baseList(input);
  };
  const startCtx = (config: OpenClawConfig) => ({
    config,
    stateDir: root,
    logger: api.logger,
    getCron: () => mode === "no_cron"
      ? (undefined as unknown as ReturnType<NonNullable<Parameters<OpenClawPluginService["start"]>[0]["getCron"]>>)
      : { ...h.cron, remove: async () => ({}), removeStaleJobFamily: async () => 0 },
  });

  service!.start(startCtx(hostConfig));
  await hooks.get("gateway_start")!({}, {});
  const alphaSession = { config: hostConfig, agentId: "alpha", sessionKey: "agent:alpha:cron:durable-alpha-nightly:run:r1" };
  assert.equal(record(hooks.get("before_tool_call")!({ toolName: "exec", params: {} }, alphaSession))?.block, true);
  assert.equal(hooks.get("before_tool_call")!({ toolName: "read", params: {} }, alphaSession), undefined);

  // Stop followed by start with missing getCron() must NOT fail open.
  await service!.stop!({ config: hostConfig, stateDir: root, logger: api.logger });
  mode = "no_cron";
  service!.start(startCtx(hostConfig));
  await hooks.get("gateway_start")!({}, {});
  assert.equal(record(hooks.get("before_tool_call")!({ toolName: "exec", params: {} }, alphaSession))?.block, true,
    "stop -> start with missing getCron must keep blocking forbidden tools");
  assert.equal(record(hooks.get("before_tool_call")!({ toolName: "memory_people_update", params: { action: "restore" } }, alphaSession))?.block, true);
  assert.equal(hooks.get("before_tool_call")!({ toolName: "read", params: {} }, alphaSession), undefined);

  // Stop followed by start disabling alpha while cron.list() fails transiently must block disabled-agent calls.
  await service!.stop!({ config: hostConfig, stateDir: root, logger: api.logger });
  mode = "list_fail";
  const disabledCfg: OpenClawConfig = {
    ...hostConfig,
    plugins: { entries: { "unblock-memory": { config: { people: { enabled: true, whisperer: { enabled: true }, learning: { agents: { alpha: { enabled: false } } } } } } } },
  };
  service!.start(startCtx(disabledCfg));
  await hooks.get("gateway_start")!({}, {});
  const blockedDisabled = record(hooks.get("before_tool_call")!({ toolName: "read", params: {} }, alphaSession));
  assert.equal(blockedDisabled?.block, true, "stop -> start disabling agent with transient cron.list failure must still block all tools");
  assert.match(String(blockedDisabled?.blockReason), /disabled/);
  assert.equal(await factory!(alphaSession), null);

  // Recovery with an authoritative full snapshot restores normal enforcement.
  mode = "ok";
  await hooks.get("cron_reconciled")!({ reason: "reload" }, { config: hostConfig });
  assert.equal(hooks.get("before_tool_call")!({ toolName: "read", params: {} }, alphaSession), undefined);
  assert.equal(record(hooks.get("before_tool_call")!({ toolName: "exec", params: {} }, alphaSession))?.block, true);
  assert.ok(await factory!(alphaSession));
  await service!.stop!({ config: hostConfig, stateDir: root, logger: api.logger });
});

test("exact agent-scoped legacy cron jobs and duplicates are recognized before any scheduler mutation", async t => {
  const root = mkdtempSync(join(tmpdir(), "people-learning-legacy-recognize-"));
  const stores = new PeopleStores({ stateRoot: root, maxOpenTodos: 10, maxBlurbChars: 1200 });
  t.after(() => stores.closeAll());
  const pluginConfig = {
    people: { enabled: true, whisperer: { enabled: true }, learning: { agents: { alpha: { legacyJobIds: ["legacy-by-id"] } } } },
  };
  const hostConfig: OpenClawConfig = {
    agents: { defaults: { userTimezone: "UTC" }, entries: { alpha: {} } },
    plugins: { entries: { "unblock-memory": { config: pluginConfig } } },
  };
  const h = hostCron([
    { id: "legacy-weekly-orig", agentId: "alpha", name: "People Whisperer — full weekly statement validation", enabled: true },
    { id: "legacy-weekly-dup", agentId: "alpha", name: "People Whisperer — full weekly statement validation", enabled: true },
    {
      id: "legacy-by-id", agentId: "alpha", name: "Custom legacy nightly", enabled: true,
      payload: { kind: "agentTurn", message: "Follow people-nightly-dreaming.md strictly" } as Job["payload"],
    },
    { id: "other-agent-legacy", agentId: "other", name: "People Whisperer — full weekly statement validation", enabled: true },
  ]);
  let failAdd = true;
  let failDuplicateUpdate = false;
  const baseAdd = h.cron.add.bind(h.cron);
  const baseUpdate = h.cron.update.bind(h.cron);
  h.cron.add = async (input) => {
    if (failAdd) throw new Error("transient cron.add failure during legacy migration");
    return baseAdd(input);
  };
  h.cron.update = async (id, patch) => {
    if (failDuplicateUpdate && id === "legacy-weekly-dup") throw new Error("transient duplicate disable failure");
    return baseUpdate(id, patch);
  };

  const warns: string[] = [];
  let service: OpenClawPluginService | undefined;
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const api = {
    config: hostConfig,
    pluginConfig,
    logger: { warn(m: string) { warns.push(m); } },
    registerService(v: OpenClawPluginService) { service = v; },
    registerTool() {},
    on(name: string, fn: (...args: unknown[]) => unknown) { hooks.set(name, fn); },
  } as unknown as OpenClawPluginApi;
  registerPeopleLearning(api, resolveConfig(pluginConfig), stores);
  service!.start({
    config: hostConfig, stateDir: root, logger: api.logger,
    getCron: () => ({ ...h.cron, remove: async () => ({}), removeStaleJobFamily: async () => 0 }),
  });
  await hooks.get("gateway_start")!({}, {});
  assert.ok(warns.some(w => w.includes("transient cron.add failure")));

  // All exact agent-scoped legacy matches are restricted even though cron.add failed before any mutation.
  for (const jobId of ["legacy-weekly-orig", "legacy-weekly-dup", "legacy-by-id"]) {
    const ctx = { config: hostConfig, agentId: "alpha", sessionKey: `agent:alpha:cron:${jobId}:run:r1` };
    assert.equal(record(hooks.get("before_tool_call")!({ toolName: "exec", params: {} }, ctx))?.block, true,
      `active legacy job ${jobId} must block forbidden tools when cron.add throws`);
    assert.equal(hooks.get("before_tool_call")!({ toolName: "read", params: {} }, ctx), undefined);
  }
  // Unconfigured/unrelated agent's legacy job is NOT claimed.
  assert.equal(hooks.get("before_tool_call")!(
    { toolName: "exec", params: {} },
    { config: hostConfig, agentId: "other", sessionKey: "agent:other:cron:other-agent-legacy:run:r1" },
  ), undefined);

  // If cron.add succeeds but disabling a duplicate throws partway through, both primary and duplicate stay restricted.
  failAdd = false;
  failDuplicateUpdate = true;
  await hooks.get("cron_reconciled")!({ reason: "retry" }, { config: hostConfig });
  assert.ok(warns.some(w => w.includes("transient duplicate disable failure")));
  const createdWeekly = h.jobs.find(j => j.declarationKey === "unblock-memory:people-learning:alpha:weekly")!;
  assert.ok(createdWeekly);
  for (const jobId of [createdWeekly.id, "legacy-weekly-orig", "legacy-weekly-dup"]) {
    const ctx = { config: hostConfig, agentId: "alpha", sessionKey: `agent:alpha:cron:${jobId}:run:r2` };
    assert.equal(record(hooks.get("before_tool_call")!({ toolName: "message", params: {} }, ctx))?.block, true,
      `job ${jobId} must stay restricted after partial duplicate disable failure`);
  }

  // Disabling alpha while reconciliation is incomplete immediately blocks even read-only tools on active legacy jobs.
  const disabledCfg: OpenClawConfig = {
    ...hostConfig,
    plugins: { entries: { "unblock-memory": { config: { people: { enabled: true, whisperer: { enabled: true }, learning: { agents: { alpha: { enabled: false, legacyJobIds: ["legacy-by-id"] } } } } } } } },
  };
  await hooks.get("cron_reconciled")!({ reason: "reload" }, { config: disabledCfg });
  const blockedLegacy = record(hooks.get("before_tool_call")!(
    { toolName: "read", params: {} },
    { config: disabledCfg, agentId: "alpha", sessionKey: "agent:alpha:cron:legacy-weekly-dup:run:r3" },
  ));
  assert.equal(blockedLegacy?.block, true);
  assert.match(String(blockedLegacy?.blockReason), /disabled/);

  // Disabling People Whisperer globally must still recognize and disable configured legacyJobIds.
  failDuplicateUpdate = false;
  const whispererDisabledCfg: OpenClawConfig = {
    ...hostConfig,
    plugins: { entries: { "unblock-memory": { config: { people: { enabled: true, whisperer: { enabled: false }, learning: { agents: { alpha: { legacyJobIds: ["legacy-by-id"] } } } } } } } },
  };
  await hooks.get("cron_reconciled")!({ reason: "reload" }, { config: whispererDisabledCfg });
  assert.equal(h.jobs.find(j => j.id === "legacy-by-id")?.enabled, false, "disabling People Whisperer must still disable configured legacyJobIds");
  const blockedLegacyById = record(hooks.get("before_tool_call")!(
    { toolName: "read", params: {} },
    { config: whispererDisabledCfg, agentId: "alpha", sessionKey: "agent:alpha:cron:legacy-by-id:run:r4" },
  ));
  assert.equal(blockedLegacyById?.block, true, "disabling People Whisperer must keep configured legacyJobIds recognized and blocked");
  assert.match(String(blockedLegacyById?.blockReason), /disabled/);
  await service!.stop!({ config: hostConfig, stateDir: root, logger: api.logger });
});

test("pre-checkpoint manifest refresh rejects stale/unversioned receipts and concurrent refresh before assertion expansion preserves new sessions without bogus sourceGaps", async t => {
  let now = Date.parse("2026-11-16T05:00:00Z");
  t.mock.method(Date, "now", () => now);
  const f = fixture(); t.after(() => { f.db.close(); f.stores.closeAll(); });
  f.add("dm", "workspace", "direct");
  const setImage = (data: string) => {
    const event = JSON.parse(String(f.db.prepare("SELECT event_json FROM transcript_events WHERE session_id='dm' AND seq=1").get()!.event_json));
    event.message.content = [{ type: "text", text: "Use this image" }, { type: "image", mimeType: "image/png", data }];
    f.db.prepare("UPDATE transcript_events SET event_json=? WHERE session_id='dm' AND seq=1").run(JSON.stringify(event));
  };

  // (a) Store-level: refresh from export A to export B BEFORE any checkpoint was saved.
  setImage("export-A");
  const ledger = new PeopleLearningStore(join(f.root, "pre-first-checkpoint.sqlite"), "alpha"); t.after(() => ledger.close());
  const runA = ledger.begin(f.inventory("nightly"));
  const receiptA = receiptFor(runA.manifest);
  receiptA.sourceGapReviews = runA.manifest.sourceGaps.map(g => ({
    sourceGapId: g.id, status: "resolved", reason: "Verified export A",
    sourceRefs: ["native:dm:1"], reviewedAt: new Date(now).toISOString(),
  }));

  now += 60_000;
  setImage("export-B");
  const runB = ledger.begin(f.inventory("nightly"));
  assert.notEqual(runB.manifestRevision, runA.manifestRevision);
  assert.equal(runB.receipt, undefined, "no receipt has been saved yet");

  // Unversioned receipt citing export A must NOT complete export B.
  const unversionedA = ledger.checkpoint(runA.manifest.id, receiptA, now);
  assert.equal(unversionedA.status, "invalid");
  assert.ok(unversionedA.errors.some(e => e.includes("Manifest was refreshed")));
  assert.equal(ledger.get(runA.manifest.id)!.status, "partial");

  // Stale versioned receipt citing export A is also rejected.
  const staleA = ledger.checkpoint(runA.manifest.id, { ...receiptA, manifestRevision: runA.manifestRevision }, now + 1);
  assert.equal(staleA.status, "invalid");
  assert.ok(staleA.errors.some(e => e.includes("Stale manifest revision")));
  assert.equal(ledger.get(runA.manifest.id)!.status, "partial");

  // Receipt bound to export B succeeds.
  const validB = ledger.checkpoint(runA.manifest.id, { ...receiptA, manifestRevision: runB.manifestRevision }, now + 2);
  assert.equal(validB.status, "complete");

  // (b) Runtime-level: live checkpoint requires manifestRevision, and a concurrent refresh
  // landing before checkpoint assertion expansion cannot be overwritten with bogus sourceGaps.
  f.people.deleteDossier(f.a, "Start weekly without dossier for alpha participant");
  f.people.deleteDossier(f.b, "Start weekly without dossier for beta participant");
  // Reset dm back to clean text (no image gap) so sourceGaps starts empty.
  const cleanMsg = {
    role: "user", content: "Please explain, no edits.",
    __openclaw: { senderId: "U1", senderIdentity: { senderKind: "human" }, transport: { channel: "slack", accountId: "workspace", conversationRef: "conversation-dm" } },
  };
  f.db.prepare("UPDATE transcript_events SET event_json=? WHERE session_id='dm' AND seq=1").run(JSON.stringify({ type: "message", message: cleanMsg }));

  const workspace = join(f.root, "workspace-toctou"); mkdirSync(workspace);
  const hostConfig: OpenClawConfig = { agents: { defaults: { workspace, userTimezone: "UTC" }, entries: { alpha: { workspace, agentDir: f.root } } } };
  const h = hostCron();
  let service: OpenClawPluginService | undefined, factory: OpenClawPluginToolFactory | undefined;
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const api = {
    config: hostConfig, pluginConfig: { people: { enabled: true, whisperer: { enabled: true } } },
    logger: { warn(m: string) { assert.fail(m); } },
    registerService(v: OpenClawPluginService) { service = v; },
    registerTool(v: OpenClawPluginToolFactory) { factory = v; },
    on(name: string, fn: (...args: unknown[]) => unknown) { hooks.set(name, fn); },
  } as unknown as OpenClawPluginApi;
  registerPeopleLearning(api, enabled(), f.stores);
  service!.start({ config: hostConfig, stateDir: f.root, logger: api.logger,
    getCron: () => ({ ...h.cron, remove: async () => ({}), removeStaleJobFamily: async () => 0 }) });
  await hooks.get("gateway_start")!({}, {});
  const weeklyJob = h.jobs.find(j => String(j.name).endsWith(":weekly"))!;
  const tool = await factory!({ config: hostConfig, agentId: "alpha", sessionKey: `agent:alpha:cron:${weeklyJob.id}:run:r1` });
  assert.ok(tool && !Array.isArray(tool));
  const call = async (params: unknown) => JSON.parse(String(record((await tool.execute("toctou", params)).content[0])!.text));

  const inv1 = await call({ action: "inventory", kind: "weekly" });
  assert.deepEqual(inv1.manifest.sessions.map((s: { sessionId: string }) => s.sessionId), ["dm"]);
  assert.deepEqual(inv1.manifest.sourceGaps, []);
  assert.equal(inv1.manifest.assertions.length, 0);

  // Live checkpoint omitting manifestRevision is rejected at the schema boundary.
  await assert.rejects(
    tool.execute("missing-rev", { action: "checkpoint", runId: inv1.manifest.id, receipt: receiptFor(inv1.manifest) }),
  );

  // Concurrent refresh adds a new session (dm2) while participant f.a also acquires a new dossier.
  now += 60_000;
  f.add("dm2", "other", "group");
  f.people.replaceDossier(f.a, "New dossier acquired before concurrent refresh", { schemaVersion: 1, blurb: "Leads delivery.", sections: [] });
  const inv2 = await call({ action: "inventory", kind: "weekly" });
  assert.notEqual(inv2.manifestRevision, inv1.manifestRevision);
  assert.deepEqual(inv2.manifest.sessions.map((s: { sessionId: string }) => s.sessionId).sort(), ["dm", "dm2"]);
  assert.deepEqual(inv2.manifest.sourceGaps, []);
  const assertionsAfterInv2 = inv2.manifest.assertions.map((a: { id: string }) => a.id);

  // Also give f.b a dossier right before the stale checkpoint to verify stale checkpoint never expands assertions either.
  f.people.replaceDossier(f.b, "New dossier for second participant", { schemaVersion: 1, blurb: "Owns ops.", sections: [] });

  // Stale checkpoint citing inv1.manifestRevision must reject cleanly WITHOUT calling begin()
  // or introducing bogus missing-session sourceGaps or mutating assertions.
  const staleReceipt = receiptFor(inv1.manifest);
  staleReceipt.peopleReviews = [];
  const rejected = await call({
    action: "checkpoint",
    runId: inv1.manifest.id,
    manifestRevision: inv1.manifestRevision,
    receipt: staleReceipt,
  });
  assert.equal(rejected.status, "invalid");
  assert.ok(rejected.errors.some((e: string) => e.includes("Stale manifest revision")));

  const ledgerCheck = new PeopleLearningStore(join(f.root, "agents/alpha/unblock-memory/unblock-memory.sqlite"), "alpha");
  t.after(() => ledgerCheck.close());
  const storedAfterReject = ledgerCheck.get(inv1.manifest.id)!;
  assert.equal(storedAfterReject.manifestRevision, inv2.manifestRevision, "stale checkpoint must not mutate manifest revision");
  assert.deepEqual(storedAfterReject.manifest.sessions.map(s => s.sessionId).sort(), ["dm", "dm2"],
    "new session from concurrent refresh must remain intact");
  assert.deepEqual(storedAfterReject.manifest.sourceGaps, [],
    "stale checkpoint must not inject bogus missing-session sourceGaps");
  assert.deepEqual(storedAfterReject.manifest.assertions.map(a => a.id), assertionsAfterInv2,
    "stale checkpoint must not mutate assertions");

  // Current checkpoint citing inv2.manifestRevision expands ONLY f.b's newly acquired assertions
  // while keeping sessions and sourceGaps intact.
  const currentReceipt = receiptFor(inv2.manifest);
  currentReceipt.peopleReviews = [];
  const expanded = await call({
    action: "checkpoint",
    runId: inv2.manifest.id,
    manifestRevision: inv2.manifestRevision,
    receipt: currentReceipt,
  });
  assert.equal(expanded.status, "partial");
  assert.notEqual(expanded.manifestRevision, inv2.manifestRevision);
  assert.equal(expanded.expectedAssertions, assertionsAfterInv2.length + 1);
  const storedAfterExpand = ledgerCheck.get(inv2.manifest.id)!;
  assert.deepEqual(storedAfterExpand.manifest.sessions.map(s => s.sessionId).sort(), ["dm", "dm2"]);
  assert.deepEqual(storedAfterExpand.manifest.sourceGaps, []);
  await service!.stop!({ config: hostConfig, stateDir: f.root, logger: api.logger });
});

test("finalization commits staged-revision check, all dossier verifications, and receipt completion atomically", async t => {
  const setupRuntime = async (nowRef: { value: number }) => {
    const f = fixture();
    t.after(() => { f.db.close(); f.stores.closeAll(); });
    // Mark only the two active people (f.a, f.b) unverified; keep f.inactive verified.
    const storePath = join(f.root, "agents/alpha/unblock-memory/unblock-memory.sqlite");
    const setupDb = new DatabaseSync(storePath);
    try {
      setupDb.prepare("DELETE FROM person_dossier_verification WHERE person_id IN (?, ?)").run(f.a, f.b);
    } finally { setupDb.close(); }
    assert.equal(f.people.isDossierVerified(f.a), false);
    assert.equal(f.people.isDossierVerified(f.b), false);
    f.add("dm", "workspace", "direct");
    f.add("grp", "other", "group");

    const workspace = join(f.root, "workspace-atomic-finalize"); mkdirSync(workspace);
    const hostConfig: OpenClawConfig = { agents: { defaults: { workspace, userTimezone: "UTC" }, entries: { alpha: { workspace, agentDir: f.root } } } };
    const h = hostCron();
    let service: OpenClawPluginService | undefined, factory: OpenClawPluginToolFactory | undefined;
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    const api = {
      config: hostConfig, pluginConfig: { people: { enabled: true, whisperer: { enabled: true } } },
      logger: { warn(m: string) { assert.fail(m); } },
      registerService(v: OpenClawPluginService) { service = v; },
      registerTool(v: OpenClawPluginToolFactory) { factory = v; },
      on(name: string, fn: (...args: unknown[]) => unknown) { hooks.set(name, fn); },
    } as unknown as OpenClawPluginApi;
    registerPeopleLearning(api, enabled(), f.stores);
    service!.start({ config: hostConfig, stateDir: f.root, logger: api.logger,
      getCron: () => ({ ...h.cron, remove: async () => ({}), removeStaleJobFamily: async () => 0 }) });
    await hooks.get("gateway_start")!({}, {});
    const weeklyJob = h.jobs.find(j => String(j.name).endsWith(":weekly"))!;
    const tool = await factory!({ config: hostConfig, agentId: "alpha", sessionKey: `agent:alpha:cron:${weeklyJob.id}:run:r1` });
    assert.ok(tool && !Array.isArray(tool));
    const call = async (params: unknown) => JSON.parse(String(record((await tool.execute("fin", params)).content[0])!.text));
    t.after(async () => { await service!.stop!({ config: hostConfig, stateDir: f.root, logger: api.logger }); });
    void nowRef;
    return { f, storePath, call };
  };

  // (a) Concurrent inventory refresh racing finalization leaves ZERO newly verified dossiers.
  {
    const nowRef = { value: Date.parse("2026-11-16T05:00:00Z") };
    const dateMock = t.mock.method(Date, "now", () => nowRef.value);
    const { f, storePath, call } = await setupRuntime(nowRef);
    const inv = await call({ action: "inventory", kind: "weekly" });
    const preV4Db = new DatabaseSync(storePath);
    try { preV4Db.prepare("DELETE FROM person_dossier_changes WHERE person_id=?").run(f.a); }
    finally { preV4Db.close(); }
    assert.equal(f.people.getDossierRevision(f.a), null);
    const receipt = receiptFor(inv.manifest);
    receipt.peopleReviews = [];
    nowRef.value += 120_000;

    const originalExec = DatabaseSync.prototype.exec;
    let triggerConcurrentRefresh = true;
    const execMock = t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
      const result = originalExec.call(this, sql);
      if (sql === "COMMIT" && triggerConcurrentRefresh) {
        triggerConcurrentRefresh = false;
        const concurrent = new PeopleLearningStore(storePath, "alpha");
        try {
          concurrent.begin({
            ...inv.manifest,
            sourceGaps: [{ id: "concurrent-refresh-gap", reason: "Concurrent inventory refresh landed before finalization" }],
          });
        } finally { concurrent.close(); }
      }
      return result;
    });

    const raced = await call({ action: "checkpoint", runId: inv.manifest.id, manifestRevision: inv.manifestRevision, receipt });
    execMock.mock.restore();
    dateMock.mock.restore();

    assert.equal(raced.status, "partial");
    assert.equal(f.people.isDossierVerified(f.a), false, "concurrent refresh racing finalization must leave person #1 unverified");
    assert.equal(f.people.isDossierVerified(f.b), false, "concurrent refresh racing finalization must leave person #2 unverified");
    assert.equal(f.people.getDossierRevision(f.a), null, "concurrent refresh racing finalization must not insert legacy baseline change");
    const checkLedger = new PeopleLearningStore(storePath, "alpha");
    t.after(() => checkLedger.close());
    assert.equal(checkLedger.get(inv.manifest.id)!.status, "partial");
  }

  // (b) Verification failure on person #2 rolls back person #1's verification cleanly.
  {
    const nowRef = { value: Date.parse("2026-11-16T05:00:00Z") };
    const dateMock = t.mock.method(Date, "now", () => nowRef.value);
    const { f, storePath, call } = await setupRuntime(nowRef);
    const inv = await call({ action: "inventory", kind: "weekly" });
    const assertionPeople = [...new Set((inv.manifest as ReviewManifest).assertions.map(a => a.personId))];
    assert.equal(assertionPeople.length, 2, "exactly two active unverified people are queued for verification");
    const [firstPersonId, secondPersonId] = assertionPeople as [string, string];
    // Make person #1 (processed FIRST) a pre-v4 null-revision dossier so we prove BOTH
    // its baseline change insert AND its verification row roll back when person #2 fails.
    const preV4Db = new DatabaseSync(storePath);
    try { preV4Db.prepare("DELETE FROM person_dossier_changes WHERE person_id=?").run(firstPersonId); }
    finally { preV4Db.close(); }
    assert.equal(f.people.getDossierRevision(firstPersonId), null);
    const secondOriginalDossier = f.people.getDossier(secondPersonId)!.dossier;
    const receipt = receiptFor(inv.manifest);
    receipt.peopleReviews = [];
    nowRef.value += 120_000;

    const originalExec = DatabaseSync.prototype.exec;
    let mutateSecondPerson = true;
    const execMock = t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
      const result = originalExec.call(this, sql);
      if (sql === "COMMIT" && mutateSecondPerson) {
        mutateSecondPerson = false;
        // Mutate person #2's dossier between staging and atomic finalization so person #1 succeeds
        // inside Transaction 2 and person #2 then throws DossierConflictError, forcing full rollback.
        f.people.replaceDossier(secondPersonId, "Concurrent edit right before finalization", secondOriginalDossier);
      }
      return result;
    });

    const failedFinalize = await call({ action: "checkpoint", runId: inv.manifest.id, manifestRevision: inv.manifestRevision, receipt });
    execMock.mock.restore();

    assert.equal(failedFinalize.status, "partial");
    assert.ok(failedFinalize.unresolved.includes("dossier-verification"));
    assert.equal(f.people.isDossierVerified(firstPersonId), false, "person #1 verification must roll back when person #2 fails");
    assert.equal(f.people.getDossierRevision(firstPersonId), null, "person #1 pre-v4 baseline change must also roll back cleanly");
    assert.equal(f.people.isDossierVerified(secondPersonId), false, "person #2 remains unverified");
    const checkLedger = new PeopleLearningStore(storePath, "alpha");
    t.after(() => checkLedger.close());
    assert.equal(checkLedger.get(inv.manifest.id)!.status, "partial");

    // Retrying cleanly commits both person #1 and person #2 verifications together with completion.
    nowRef.value += 60_000;
    const retryReceipt = {
      ...receipt,
      changes: [{ personId: secondPersonId, changeId: f.people.getDossierRevision(secondPersonId)! }],
    };
    const completed = await call({ action: "checkpoint", runId: inv.manifest.id, manifestRevision: inv.manifestRevision, receipt: retryReceipt });
    dateMock.mock.restore();
    assert.equal(completed.status, "complete");
    assert.equal(f.people.isDossierVerified(firstPersonId), true);
    assert.equal(f.people.isDossierVerified(secondPersonId), true);
    assert.equal(checkLedger.get(inv.manifest.id)!.status, "complete");
  }
});
