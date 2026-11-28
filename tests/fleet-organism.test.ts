import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { QMDStore } from "@unblocklabs/qmd";
import { DeepThoughtStore } from "../src/deep-thought-store.js";
import { ExpectationsStore } from "../src/expectations-store.js";
import { readFleetCommonsEntries, resolveFleetCommonsConfig, syncFleetCommons, type FleetCommonsEntry } from "../src/fleet-commons.js";
import { createFleetOrganismHub } from "../src/fleet-organism-hub.js";
import {
  aggregateAbLeaderboard, buildNodeBriefSnapshot, buildNodeTelemetrySnapshot, formatPrometheusMetrics,
  pushNodeSnapshot, renderFleetMorningBrief,
} from "../src/fleet-organism.js";
import { openInsideOutStore } from "../src/inside-out-store.js";
import { MemoryCrystalsStore } from "../src/memory-crystals.js";
import { OutcomeLedgerStore, type OutcomeSubjectKind } from "../src/outcome-ledger.js";
import { PeopleStore } from "../src/people-store.js";
import { reviewSkillProposal, sha256, upsertSkillProposal } from "../src/skill-proposals-store.js";
import { WorkStore } from "../src/work-store.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 27);
const IDS = { nodeId: "charizard", agentId: "main", nowMs: NOW };
const CLIENT = "Acme Confidential";
const PERSON = "Morgan Secretname";
const CHANNEL = "C0123456789";
const PATH = "/home/alice/acme-private.md";
const MESSAGE = "Renewal call was postponed";

function temp(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "fleet-organism-"));
  t.after(() => rmSync(root, { recursive: true }));
  return root;
}

type Exposure = {
  kind: OutcomeSubjectKind; verdict: "helped" | "hurt" | "ignored"; turn?: string;
  delivered?: boolean; opened?: boolean; shortfall?: boolean; at?: number; agentId?: string;
};
function exposures(db: DatabaseSync, recipe: string, rows: readonly Exposure[]) {
  const insert = db.prepare(`INSERT INTO memory_outcomes
    (id,agent_id,subject_kind,subject_id,recipe_hash,verdict,confidence,evidence_turn_id,signals_json,measured_at)
    VALUES (lower(hex(randomblob(16))),?,?,?,?,?,1,?,?,?)`);
  rows.forEach((row, index) => insert.run(
    row.agentId ?? IDS.agentId, row.kind, PATH, recipe, row.verdict, row.turn ?? `turn-${index}`,
    JSON.stringify({
      delivered: row.delivered, opened: row.opened, responseOutcome: row.shortfall ? "reported_shortfall" : undefined,
      citations: [{ path: PATH, quote: MESSAGE }],
    }), row.at ?? NOW - 100,
  ));
}

const SKILL_PATH = "/home/alice/skills/acme-renewals/SKILL.md";
const replay = (recallGainPp: number) => ({ baselineRecall: 0.5, candidateRecall: 0.5 + recallGainPp / 100, recallGainPp,
  baselineFalseActivation: 0, candidateFalseActivation: 0, falseActivationDeltaPp: 0, criticalRegressions: 0, samplesEvaluated: 10 });

/** Real `skill_proposals` rows written through the Step 4A store, with private text in every free-text column. */
function seedSkillProposals(db: DatabaseSync) {
  const live = (skillName: string, title: string, recallGainPp: number) => ({ agentId: "main", kind: "description_update" as const,
    skillName, skillPath: SKILL_PATH, title, rationale: `${PERSON} asked in ${CHANNEL}`, baseSha256: sha256(MESSAGE),
    proposedDescription: `${CLIENT}: ${MESSAGE}`, proposedContent: `---\ndescription: ${MESSAGE}\n---\n`, replayMetrics: replay(recallGainPp),
    evidence: { sourcePath: PATH }, nowMs: NOW - HOUR });
  upsertSkillProposal(db, live("acme-renewals", `${CLIENT} renewal routing`, 12.4));
  upsertSkillProposal(db, { agentId: "main", kind: "new_skill", skillName: "renewal-playbook", skillPath: "renewal-playbook/SKILL.md",
    title: "Write a renewal playbook", rationale: MESSAGE, proposedContent: `# ${CLIENT} playbook\n`, nowMs: NOW - HOUR });
  const approved = upsertSkillProposal(db, { ...live("acme-pitfalls", "Already approved proposal", 5), kind: "pitfall_patch" }).proposal;
  reviewSkillProposal(db, { id: approved.id, agentId: "main", decision: "approved", reviewedBy: PERSON, nowMs: NOW });
  upsertSkillProposal(db, { ...live("other-agent-skill", "Other agent proposal", 50), agentId: "other-agent" });
}

function richDb(t: TestContext) {
  const path = join(temp(t), "memory.sqlite");
  const people = new PeopleStore(path, { maxOpenTodos: 10, maxBlurbChars: 1_000 });
  const { person: { id: personId } } = people.upsertIdentity({
    provider: "slack", accountScope: CLIENT, externalId: "U0987654321", displayName: PERSON,
  });
  people.close();
  const db = openInsideOutStore(path);
  try {
    new OutcomeLedgerStore(db).close();
    new MemoryCrystalsStore(db).close();
    new DeepThoughtStore(db).close();
    new WorkStore(db).close();
    const expectations = new ExpectationsStore(db);
    for (const [dedupKey, summary, dueAtMs] of [
      ["late", `${CLIENT}: Review the renewal`, NOW - 1],
      ["soon", "Ship the revised plan", NOW + 2 * HOUR],
      ["tomorrow", "Check the handoff", NOW + 20 * HOUR],
      ["later", "Book the next review", NOW + 26 * HOUR],
      ["kept", "Resolved access request", NOW - HOUR],
      ["broken", "Missed the check-in", NOW - HOUR],
    ] as const) {
      const row = expectations.upsertExpectation({
        agentId: "main", kind: "commitment", sourceKind: "manual", sourceRef: PATH, audienceKey: "workspace",
        chatType: "workspace", summary, expectedState: MESSAGE, subjectPersonId: personId, subjectLabel: PERSON,
        channel: CHANNEL, dueAtMs, nowMs: NOW - 2 * HOUR, dedupKey,
      }).expectation;
      if (dedupKey === "kept" || dedupKey === "broken") {
        expectations.resolveExpectation({ id: row.id, agentId: "main", status: dedupKey, resolvedAtMs: NOW });
      }
    }
    const grade = db.prepare(`INSERT INTO inside_out
      (interaction_id,rubric,session_id,message_id,assistant_id,human_key,sender_id,channel,source,
       target_at,reviewed_at,model,context_trimmed,joy,sadness,fear,anger,disgust,surprise,person_id)
      VALUES (?,'presence','session',?,'main',?,'U0987654321',?,?,?,?,'model',0,0.2,0.1,0.1,0.8,0.1,0.1,?)`);
    for (let i = 1; i <= 3; i++) grade.run(`interaction-${i}`, MESSAGE, PERSON, CHANNEL, PATH, NOW - i, NOW - i, personId);
    db.exec(`CREATE TABLE captains_log_entries (
      id TEXT PRIMARY KEY, agent_id TEXT, captured_at_ms INTEGER, section_hash TEXT, ordinal INTEGER,
      topic TEXT, summary TEXT, blocked INTEGER, resolved_at_ms INTEGER);`);
    const blocker = db.prepare("INSERT INTO captains_log_entries VALUES (?, 'main', ?, 'section', 0, ?, ?, 1, ?)");
    blocker.run("open", NOW - 1, `${CLIENT} approval`, MESSAGE, null);
    blocker.run("closed", NOW - 2, "Already fixed blocker", MESSAGE, NOW);
    seedSkillProposals(db);
    db.prepare(`INSERT INTO work_items (kind,scope,mode,status,strikes,last_error,updated_at)
      VALUES ('crystals',?,'item','quarantined',3,?,?)`).run(PATH, MESSAGE, NOW);
    db.prepare(`INSERT INTO memory_crystals (id,agent_id,tier,title,summary,audience_key,corpora_json,status,input_digest,created_ms,verified_ms)
      VALUES ('one','main','stm',?,?,?,'[]','active','digest',?,?), ('two','main','ltm',?,?,?,'[]','active','digest',?,?)`)
      .run(CLIENT, MESSAGE, CHANNEL, NOW, NOW, PERSON, MESSAGE, CHANNEL, NOW, NOW);
    db.prepare(`INSERT INTO core_memories VALUES ('core','main','crystal_revision','one','memory',?,NULL,?, ?,?)`)
      .run(PATH, MESSAGE, CLIENT, NOW);
    const derived = db.prepare(`INSERT INTO derived_observations
      (id,agent_id,question,question_hash,audience_key,corpora_json,collection_generations_json,answer,confidence,citations_json,
       open_questions_json,status,hit_count,created_at) VALUES (?,'main',?, 'hash',?,'[]','{}',?,'high',?,'[]',?,?,?)`);
    for (const [status, hits] of [["fresh", 3], ["stale", 5]] as const) {
      derived.run(status, CLIENT, CHANNEL, MESSAGE, JSON.stringify([{ source: PATH, quote: MESSAGE }]), status, hits, NOW);
    }
    exposures(db, "actr_v1", [
      { kind: "memory_hit", verdict: "helped", delivered: true },
      { kind: "skill", verdict: "hurt", opened: true, shortfall: true },
      { kind: "memory_hit", verdict: "ignored", at: NOW - 2 * HOUR },
      { kind: "skill", verdict: "helped", agentId: "other-agent" },
      { kind: "skill", verdict: "helped", at: NOW },
    ]);
    exposures(db, `Recipe copied from ${PATH}`, [{ kind: "person_whisper", verdict: "ignored" }]);
  } finally {
    db.close();
  }
  return { path, personId };
}

test("telemetry exports only anonymous aggregates from a rich read-only DB", t => {
  const { path, personId } = richDb(t);
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => db.close());
  const telemetry = buildNodeTelemetrySnapshot(db, { ...IDS, sinceHours: 1 });
  assert.deepEqual(telemetry.crystals, { stm: 1, ltm: 1, coreMemories: 1 });
  assert.deepEqual(telemetry.expectations, { open: 4, kept: 1, broken: 1, overdue: 1 });
  assert.deepEqual(telemetry.derivedObservations, { fresh: 1, stale: 1, totalHits: 8 });
  // Pending only, this agent only, labelled by the store's own kinds.
  assert.deepEqual(telemetry.skillProposals, { pending: 2, byKind: { description_update: 1, new_skill: 1 } });
  assert.equal(telemetry.sentimentDriftFlaggedCount, 2);
  assert.equal(telemetry.quarantinedWorkItems, 1);
  assert.equal(telemetry.outcomes.total, 3);
  const actr = telemetry.outcomes.byRecipe.actr_v1;
  assert.deepEqual([actr.total, actr.helped, actr.ignored, actr.hurt, actr.whisperUsedRate, actr.skillOpenRate, actr.shortfallsPer100Turns],
    [2, 1, 0, 1, 1, 1, 50]);
  assert.ok(Object.keys(telemetry.outcomes.byRecipe).some(key => /^[a-f0-9]{64}$/u.test(key)));
  assert.equal(buildNodeTelemetrySnapshot(path, { ...IDS, sinceHours: 0 }).outcomes.total, 4);
  for (const value of [JSON.stringify(telemetry), formatPrometheusMetrics([telemetry])]) {
    for (const secret of [CLIENT, PERSON, personId, CHANNEL, PATH, SKILL_PATH, MESSAGE, "acme-renewals", "renewal-playbook",
      "sourcePath", "citations", "summary"]) {
      assert.ok(!value.includes(secret), `leaked ${secret}`);
    }
  }
  assert.ok(!formatPrometheusMetrics([{ ...telemetry, agentId: personId }, { ...telemetry, nodeId: PATH }]).includes("node="));
});

test("missing files and tables never create or migrate a source DB", t => {
  const path = join(temp(t), "missing.sqlite");
  const empty = buildNodeTelemetrySnapshot(path, IDS);
  const emptyBrief = buildNodeBriefSnapshot(path, IDS);
  assert.equal(empty.outcomes.total, 0);
  assert.equal(emptyBrief.operatorOnly, true);
  assert.equal(emptyBrief.blockers.length, 0);
  assert.equal(existsSync(path), false);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA query_only=ON");
  assert.deepEqual(buildNodeTelemetrySnapshot(db, IDS), empty);
  assert.deepEqual(buildNodeBriefSnapshot(db, IDS), emptyBrief);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema").all(), []);
});

test("Prometheus groups each family once and escapes quotes, slashes and newlines", t => {
  const { path } = richDb(t);
  const first = buildNodeTelemetrySnapshot(path, IDS);
  const second = { ...first, nodeId: 'two"\\\nthree', agentId: "another" };
  const output = formatPrometheusMetrics([first, second]);
  assert.match(output, /\{node="two\\"\\\\\\nthree",agent="another",tier="stm"\} 1\n/u);
  assert.ok(output.endsWith("\n"));
  const helps = new Set<string>(), types = new Set<string>(), closed = new Set<string>();
  let family = "";
  for (const line of output.trimEnd().split("\n")) {
    const help = /^# HELP (\w+) (.+)$/u.exec(line);
    if (help) {
      assert.ok(!helps.has(help[1]));
      helps.add(help[1]);
      continue;
    }
    const type = /^# TYPE (\w+) gauge$/u.exec(line);
    if (type) {
      assert.ok(helps.has(type[1]) && !types.has(type[1]));
      types.add(type[1]);
      continue;
    }
    const sample = /^(\w+)\{[a-z]+="(?:[^"\\\n]|\\["\\n])*"(?:,[a-z]+="(?:[^"\\\n]|\\["\\n])*")*\} \d+(?:\.\d+)?$/u.exec(line);
    assert.ok(sample, line);
    assert.ok(types.has(sample[1]) && !closed.has(sample[1]), line);
    if (sample[1] !== family) { closed.add(family); family = sample[1]; }
  }
  assert.equal(types.size, 11);
});

test("three reporting nodes roll up A/B arms using KPI-specific populations", () => {
  const node = (nodeId: string, recipes: Record<string, Exposure[]>) => {
    const db = new DatabaseSync(":memory:");
    try {
      new OutcomeLedgerStore(db).close();
      for (const [recipe, rows] of Object.entries(recipes)) exposures(db, recipe, rows);
      return buildNodeTelemetrySnapshot(db, { ...IDS, nodeId });
    } finally {
      db.close();
    }
  };
  const snapshots = [
    node("charizard", { actr_v1: [
      { kind: "memory_hit", verdict: "helped", delivered: true, turn: "a", shortfall: true },
      { kind: "skill", verdict: "helped", opened: true, turn: "a" },
      { kind: "person_whisper", verdict: "ignored", turn: "a" },
    ] }),
    node("blastoise", { actr_v1: [
      { kind: "memory_hit", verdict: "ignored", delivered: true },
      { kind: "memory_hit", verdict: "ignored", delivered: true },
      { kind: "memory_hit", verdict: "ignored", delivered: true },
      { kind: "skill", verdict: "ignored", opened: false },
    ], outcome_v1: [{ kind: "skill", verdict: "hurt", opened: true }] }),
    node("venusaur", { emotion_v1: [{ kind: "memory_hit", verdict: "helped", delivered: true }] }),
  ];
  const [actr, emotion, outcome] = aggregateAbLeaderboard(snapshots);
  assert.deepEqual(actr, {
    sinceHours: 24, recipeHash: "actr_v1", total: 7, helped: 2, ignored: 5, hurt: 0,
    whisperUsedRate: 0.25, skillOpenRate: 0.5, shortfallsPer100Turns: 20, nodeCount: 2, nodes: ["blastoise", "charizard"],
    coverageFromMs: NOW - 24 * HOUR, coverageToMs: NOW,
  });
  assert.deepEqual([emotion.recipeHash, emotion.whisperUsedRate, emotion.skillOpenRate, emotion.nodeCount], ["emotion_v1", 1, null, 1]);
  assert.deepEqual([outcome.recipeHash, outcome.whisperUsedRate, outcome.skillOpenRate, outcome.nodeCount], ["outcome_v1", null, 1, 1]);
});

test("operator brief surfaces only active items, honors due window and limits, and renders all sections", t => {
  const { path, personId } = richDb(t);
  const brief = buildNodeBriefSnapshot(path, { ...IDS, dueSoonHours: 3 });
  assert.equal(brief.operatorOnly, true);
  assert.equal(brief.blockers.length, 1);
  assert.equal(brief.overdueExpectations.length, 1);
  assert.deepEqual(brief.dueSoonExpectations.map(item => item.summary), ["Ship the revised plan"]);
  assert.equal(brief.sentimentDrift.length, 2);
  assert.ok(brief.sentimentDrift.every(item => item.personId === personId));
  // Replay-validated first (recall gain from replay_metrics_json), then unmeasured; approved and other-agent rows never appear.
  assert.deepEqual(brief.skillProposals, [
    { kind: "description_update", skillName: "acme-renewals", title: `${CLIENT} renewal routing`, recallGainPp: 12.4 },
    { kind: "new_skill", skillName: "renewal-playbook", title: "Write a renewal playbook", recallGainPp: null },
  ]);
  assert.deepEqual(brief.quarantinedWorkItems[0], { kind: "crystals", scope: PATH, strikes: 3, lastError: MESSAGE });
  assert.equal(buildNodeBriefSnapshot(path, IDS).dueSoonExpectations.length, 2);
  assert.equal(buildNodeBriefSnapshot(path, { ...IDS, limit: 1 }).skillProposals.length, 1);
  const output = renderFleetMorningBrief([brief], [buildNodeTelemetrySnapshot(path, IDS)]);
  assert.match(output, /1 node reporting.*1 blocker.*1 overdue.*2 drift alerts.*1 quarantined.*2 pending skill approvals/u);
  assert.deepEqual(output.match(/^## .+$/gmu), [
    "## Red Flags", "## Active [BLOCKED] Items by Node", "## Pending Self-Writing Skill Proposals", "## Brightness A/B Lab Leaderboard",
  ]);
  assert.match(output, /Internal · operator only/u);
  assert.match(output, /Quarantined.*3 strikes/u);
  assert.match(output, /Overdue.*Review the renewal/u);
  assert.match(output, /Drift.*recent anger 0\.8/u);
  assert.match(output, /\*\*Acme Confidential approval:/u);
  assert.match(output, /Acme Confidential renewal routing \(description\\_update · acme-renewals\) — 12\.4 pp recall/u);
  assert.match(output, /Write a renewal playbook \(new\\_skill · renewal-playbook\)\n/u);
  assert.match(output, /\| 24h \| actr\\_v1 \| 1 \| 3 \|/u);
  assert.doesNotMatch(output, /Already (fixed|approved)|Other agent proposal|Check the handoff|Book the next review/u);
});

test("real hub authenticates, validates and persists telemetry, Commons, and the separate operator brief", async t => {
  const { path } = richDb(t);
  const telemetry = buildNodeTelemetrySnapshot(path, IDS), brief = buildNodeBriefSnapshot(path, IDS);
  const root = temp(t);
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, "test-hub-token\n");
  const hub = createFleetOrganismHub({ dbPath: join(root, "hub.sqlite"), tokenFile, now: () => NOW });
  hub.listen(0, "127.0.0.1");
  await once(hub, "listening");
  t.after(async () => { await new Promise<void>((resolve, reject) => hub.close(error => error ? reject(error) : resolve())); });
  const address = hub.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`, telemetryUrl = `${base}/api/v1/telemetry`;
  const auth = { Authorization: "Bearer test-hub-token" };
  const post = (route: string, body: unknown, headers: Record<string, string> = auth) => fetch(base + route, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const get = (route: string, headers = auth) => fetch(base + route, { headers });
  assert.deepEqual(await (await fetch(base + "/healthz")).json(), { ok: true, nodes: 0, commonsEntries: 0 });
  assert.equal((await post("/api/v1/telemetry", telemetry, {})).status, 401);
  assert.equal((await get("/api/v1/ab-leaderboard", { Authorization: "Bearer same-lengthxx" })).status, 401);
  await pushNodeSnapshot(telemetry, { endpoint: telemetryUrl, apiKeyFile: tokenFile });
  for (const invalid of [
    { ...telemetry, personId: "forbidden" },
    { ...telemetry, nodeId: "/home/alice/node" },
    { ...telemetry, outcomes: { ...telemetry.outcomes, byRecipe: { [CLIENT]: telemetry.outcomes.byRecipe.actr_v1 } } },
    { ...telemetry, crystals: { ...telemetry.crystals, summary: MESSAGE } },
    { ...telemetry, skillProposals: { pending: 1, byKind: { [CHANNEL]: 1 } } },
    brief,
  ]) assert.equal((await post("/api/v1/telemetry", invalid)).status, 400);
  await pushNodeSnapshot({ ...telemetry, collectedAtMs: NOW + 1, quarantinedWorkItems: 2 }, { endpoint: telemetryUrl, apiKey: "test-hub-token" });
  await assert.rejects(pushNodeSnapshot(telemetry, { endpoint: telemetryUrl, apiKeyFile: tokenFile }), /HTTP 409/u,
    "an older snapshot never overwrites a newer one, and says so");
  const metrics = await fetch(base + "/metrics");
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers.get("content-type") ?? "", /text\/plain; version=0\.0\.4/u);
  const scrape = await metrics.text();
  assert.match(scrape, /unblock_memory_quarantined_work_items\{node="charizard",agent="main"\} 2/u);
  const leaderboard = await get("/api/v1/ab-leaderboard");
  assert.equal(leaderboard.status, 200);
  assert.partialDeepStrictEqual(await leaderboard.json(), [{ recipeHash: "actr_v1", nodes: ["charizard"] }]);

  // Commons speaks the Step 4B FleetCommonsEntry contract, hygiene-checked by validateFleetCommonsEntry.
  const entry: FleetCommonsEntry = { id: "recall-practice", revision: 2, category: "procedure", title: "Recall practice",
    body: "Deduplicate before reranking.", tags: ["retrieval"], severity: "info", updatedAt: NOW };
  assert.equal((await post("/api/v1/commons", entry)).status, 200);
  for (const body of ["token = 'synthetic-secret'", "Do not include <@U0123456789>", "reader@example.test", "/Users/alice/workspace"]) {
    const rejected = await post("/api/v1/commons", { ...entry, body });
    assert.equal(rejected.status, 400, body);
    assert.ok(((await rejected.json()) as { reasons: string[] }).reasons.every(reason => reason.startsWith("body: ")), body);
  }
  for (const invalid of [{ ...entry, kind: "practice" }, { ...entry, category: "gossip" }, { ...entry, status: "deleted" }, { ...entry, revision: 0 }]) {
    assert.equal((await post("/api/v1/commons", invalid)).status, 400, JSON.stringify(invalid));
  }
  assert.equal((await post("/api/v1/commons", { ...entry, revision: 1, body: "Older advice." })).status, 409, "revisions never go backwards");
  const commons = await get("/api/v1/commons");
  assert.equal(commons.status, 200);
  assert.deepEqual(await commons.json(), { entries: [entry] });
  const tag = commons.headers.get("etag");
  assert.ok(tag);
  const cached = await fetch(base + "/api/v1/commons", { headers: { ...auth, "If-None-Match": `"old-value", W/${tag}` } });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");

  // End to end: a node's syncFleetCommons consumes the hub feed verbatim (bearer auth + ETag) into its cache and projection.
  const nodeCache = join(root, "node.sqlite");
  const projections: string[][] = [];
  const store = { async syncProjectedCollection(_collection: string, docs: Iterable<{ path: string }>) {
    projections.push([...docs].map(doc => doc.path));
    return { upserted: 1, unchanged: 0, retracted: 0, embedded: 0, generation: 1 };
  } } as Pick<QMDStore, "syncProjectedCollection">;
  const nodeConfig = { ...resolveFleetCommonsConfig(undefined), enabled: true, endpoint: `${base}/api/v1/commons`, apiKeyFile: tokenFile };
  assert.partialDeepStrictEqual(await syncFleetCommons({ config: nodeConfig, storePath: nodeCache, store }),
    { status: "synced", count: 1, changed: true, rejected: [] });
  assert.deepEqual(readFleetCommonsEntries(nodeCache), [entry]);
  assert.deepEqual(projections, [["recall-practice/2"]]);
  assert.partialDeepStrictEqual(await syncFleetCommons({ config: nodeConfig, storePath: nodeCache, store }),
    { status: "not_modified", changed: false });

  assert.equal((await post("/api/v1/commons", { ...entry, status: "retired" })).status, 200);
  const updated = await fetch(base + "/api/v1/commons", { headers: { ...auth, "If-None-Match": tag } });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { entries: [] });
  assert.partialDeepStrictEqual(await syncFleetCommons({ config: nodeConfig, storePath: nodeCache, store }),
    { status: "synced", count: 0, changed: true });
  assert.deepEqual(readFleetCommonsEntries(nodeCache), [], "a retired hub entry leaves every node on its next sync");

  const briefUrl = `${base}/api/v1/brief`;
  const abort = new AbortController();
  abort.abort(new Error("cancel before POST"));
  await assert.rejects(pushNodeSnapshot(brief, { endpoint: briefUrl, apiKeyFile: tokenFile, signal: abort.signal }), /cancel before POST/u);
  await pushNodeSnapshot(brief, { endpoint: briefUrl, apiKeyFile: tokenFile });
  assert.equal((await fetch(briefUrl)).status, 401);
  const markdown = await get("/api/v1/brief?format=markdown");
  assert.equal(markdown.status, 200);
  assert.equal(markdown.headers.get("cache-control"), "no-store");
  assert.match(await markdown.text(), /Fleet Morning Brief[\s\S]*Acme Confidential approval[\s\S]*Brightness A\/B Lab Leaderboard/u);
  assert.partialDeepStrictEqual(await (await get("/api/v1/brief")).json(), { operatorOnly: true, briefs: [brief] });
  assert.deepEqual(await (await fetch(base + "/healthz")).json(), { ok: true, nodes: 1, commonsEntries: 0 });
  const publicScrape = await (await fetch(base + "/metrics")).text();
  for (const secret of [CLIENT, MESSAGE, PATH]) assert.ok(!publicScrape.includes(secret));
});
