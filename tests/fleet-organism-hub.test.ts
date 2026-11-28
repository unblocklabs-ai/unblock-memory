import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { FleetCommonsEntry } from "../src/fleet-commons.js";
import { createFleetOrganismHub } from "../src/fleet-organism-hub.js";
import {
  aggregateAbLeaderboard, buildNodeBriefSnapshot, buildNodeTelemetrySnapshot, isFleetAlias, pushNodeSnapshot,
  renderFleetMorningBrief, type NodeTelemetrySnapshot,
} from "../src/fleet-organism.js";
import { OutcomeLedgerStore } from "../src/outcome-ledger.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 27);
const IDS = { nodeId: "charizard", agentId: "main", nowMs: NOW };

/** A real snapshot with one measured `actr_v1` outcome, built through the ledger and the snapshot reader. */
function measured(overrides: { nodeId?: string; nowMs?: number; sinceHours?: number } = {}): NodeTelemetrySnapshot {
  const db = new DatabaseSync(":memory:");
  try {
    new OutcomeLedgerStore(db).close();
    const at = (overrides.nowMs ?? NOW) - 100;
    db.prepare(`INSERT INTO memory_outcomes
      (id,agent_id,subject_kind,subject_id,recipe_hash,verdict,confidence,evidence_turn_id,signals_json,measured_at)
      VALUES ('one','main','memory_hit','subject','actr_v1','helped',1,'turn','{"delivered":true}',?)`).run(at);
    return buildNodeTelemetrySnapshot(db, { ...IDS, ...overrides });
  } finally {
    db.close();
  }
}

function brief(nodeId = IDS.nodeId) {
  const db = new DatabaseSync(":memory:");
  try { return buildNodeBriefSnapshot(db, { ...IDS, nodeId }); }
  finally { db.close(); }
}
const ENTRY: FleetCommonsEntry = { id: "recall-practice", revision: 2, category: "procedure", title: "Recall practice",
  body: "Deduplicate before reranking.", tags: ["retrieval"], severity: "info", updatedAt: NOW };

async function startHub(t: TestContext, options: Omit<Parameters<typeof createFleetOrganismHub>[0], "dbPath">) {
  const hub = createFleetOrganismHub({ dbPath: ":memory:", ...options });
  hub.listen(0, "127.0.0.1");
  await once(hub, "listening");
  t.after(() => new Promise<void>(resolve => hub.close(() => resolve())));
  const address = hub.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const bearer = (token?: string): Record<string, string> => token ? { Authorization: `Bearer ${token}` } : {};
  return {
    base,
    get: (route: string, token?: string) => fetch(base + route, { headers: bearer(token) }),
    post: (route: string, body: unknown, token?: string, type: string | null = "application/json") => fetch(base + route, {
      method: "POST", body: JSON.stringify(body), headers: { ...bearer(token), ...(type === null ? {} : { "Content-Type": type }) },
    }),
  };
}

test("hub roles are separated: each role's token is rejected on every other role's endpoint", async t => {
  const hub = await startHub(t, { readToken: "read-token", ingestToken: "ingest-token", operatorToken: "operator-token",
    publicMetrics: false, now: () => NOW });
  const endpoints = [
    { role: "read-token", call: (token?: string) => hub.get("/api/v1/commons", token) },
    { role: "read-token", call: (token?: string) => hub.get("/metrics", token) },
    { role: "ingest-token", call: (token?: string) => hub.post("/api/v1/telemetry", measured(), token) },
    { role: "ingest-token", call: (token?: string) => hub.post("/api/v1/brief", brief(), token) },
    { role: "operator-token", call: (token?: string) => hub.post("/api/v1/commons", ENTRY, token) },
    { role: "operator-token", call: (token?: string) => hub.get("/api/v1/brief", token) },
    { role: "operator-token", call: (token?: string) => hub.get("/api/v1/ab-leaderboard", token) },
  ];
  for (const [index, { role, call }] of endpoints.entries()) {
    for (const token of [undefined, "read-token", "ingest-token", "operator-token"]) {
      if (token === role) continue;
      const response = await call(token);
      assert.equal(response.status, 401, `endpoint ${index} with ${token ?? "no token"}`);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
    }
    assert.equal((await call(role)).status, 200, `endpoint ${index} with its own ${role}`);
  }
  assert.equal((await hub.get("/healthz")).status, 200, "health stays public");
  assert.equal((await hub.get("/api/v1/unknown", "operator-token")).status, 404);
});

test("the single token is an all-roles fallback only for roles without their own token; per-node ingest tokens bind nodeId", async t => {
  const hub = await startHub(t, { token: "shared-token", ingestTokens: { charizard: "charizard-token", blastoise: "blastoise-token" },
    now: () => NOW });
  assert.equal((await hub.get("/api/v1/commons", "shared-token")).status, 200, "read falls back to the shared token");
  assert.equal((await hub.post("/api/v1/commons", ENTRY, "shared-token")).status, 200, "operator falls back to the shared token");
  assert.equal((await hub.post("/api/v1/telemetry", measured(), "shared-token")).status, 401,
    "ingestTokens replace the fallback for the ingest role");
  assert.equal((await hub.post("/api/v1/telemetry", measured(), "charizard-token")).status, 200);
  assert.equal((await hub.post("/api/v1/brief", brief(), "charizard-token")).status, 200);
  const spoofed = await hub.post("/api/v1/telemetry", measured({ nodeId: "blastoise" }), "charizard-token");
  assert.equal(spoofed.status, 403, "a node token never speaks for another node");
  assert.equal((await hub.post("/api/v1/brief", brief("blastoise"), "charizard-token")).status, 403);
  assert.equal((await hub.post("/api/v1/telemetry", measured({ nodeId: "blastoise" }), "blastoise-token")).status, 200);
  assert.equal((await hub.get("/api/v1/commons", "charizard-token")).status, 401, "an ingest token never reads the feed");

  const both = await startHub(t, { ingestToken: "fleet-ingest", ingestTokens: { charizard: "charizard-token" }, now: () => NOW });
  assert.equal((await both.post("/api/v1/telemetry", measured({ nodeId: "venusaur" }), "fleet-ingest")).status, 200,
    "a shared ingest token still ingests for any node alongside per-node tokens");
  assert.throws(() => createFleetOrganismHub({ dbPath: ":memory:", ingestTokens: { "/home/alice": "x" } }), /node alias/u);
  assert.throws(() => createFleetOrganismHub({ dbPath: ":memory:", ingestTokens: { charizard: " " } }), /Empty fleet hub ingest token/u);
  assert.throws(() => createFleetOrganismHub({ dbPath: ":memory:", operatorToken: "" }), /Empty fleet hub operator token/u);
});

test("every POST requires Content-Type: application/json, even on a tokenless loopback hub", async t => {
  const hub = await startHub(t, { now: () => NOW });
  for (const [route, body] of [["/api/v1/telemetry", measured()], ["/api/v1/brief", brief()], ["/api/v1/commons", ENTRY]] as const) {
    for (const type of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp"]) {
      const response = await hub.post(route, body, undefined, type);
      assert.equal(response.status, 415, `${route} as ${type}`);
    }
    assert.equal((await hub.post(route, body, undefined, "Application/JSON; charset=utf-8")).status, 200, route);
  }
  assert.deepEqual(await (await hub.get("/healthz")).json(), { ok: true, nodes: 1, commonsEntries: 1 });
});

test("Commons revisions are immutable and retirement is one-way", async t => {
  const hub = await startHub(t, { operatorToken: "op", now: () => NOW });
  const post = (body: unknown) => hub.post("/api/v1/commons", body, "op");
  const active = async () => ((await (await hub.get("/api/v1/commons")).json()) as { entries: FleetCommonsEntry[] }).entries;
  assert.equal((await post(ENTRY)).status, 200);
  assert.equal((await post(ENTRY)).status, 200, "an identical retry is idempotent");
  const reordered = Object.fromEntries(Object.entries(ENTRY).reverse());
  assert.equal((await post(reordered)).status, 200, "key order is not content");
  const modified = await post({ ...ENTRY, body: "Rerank before deduplicating." });
  assert.equal(modified.status, 409, "changed content at the same revision");
  assert.match(((await modified.json()) as { error: string }).error, /immutable/u);
  assert.equal((await post({ ...ENTRY, status: "retired", tags: ["other"] })).status, 409, "retiring cannot smuggle an edit");
  assert.deepEqual(await active(), [ENTRY]);

  assert.equal((await post({ ...ENTRY, status: "retired" })).status, 200, "active rN -> retired rN");
  assert.equal((await post({ ...ENTRY, status: "retired" })).status, 200, "retiring again is idempotent");
  const revived = await post(ENTRY);
  assert.equal(revived.status, 409, "retired rN -> active rN");
  assert.match(((await revived.json()) as { error: string }).error, /one-way/u);
  assert.deepEqual(await active(), []);

  const next = { ...ENTRY, revision: 3, body: "Deduplicate, then rerank." };
  assert.equal((await post(next)).status, 200, "a new revision may reactivate the id");
  assert.equal((await post({ ...ENTRY, status: "retired" })).status, 409, "revisions never go backwards");
  assert.deepEqual(await active(), [next]);
});

test("snapshots: future collectedAtMs is 400, a stale overwrite is 409, aliases are capped", async t => {
  const hub = await startHub(t, { now: () => NOW });
  const telemetry = (overrides: Partial<NodeTelemetrySnapshot>) => hub.post("/api/v1/telemetry", { ...measured(), ...overrides });
  const future = await telemetry({ collectedAtMs: NOW + 5 * 60_000 + 1 });
  assert.equal(future.status, 400);
  assert.match(((await future.json()) as { error: string }).error, /future/u);
  assert.equal((await hub.post("/api/v1/brief", { ...brief(), collectedAtMs: NOW + HOUR })).status, 400);
  assert.equal((await telemetry({ collectedAtMs: NOW + 5 * 60_000 })).status, 200, "within the default 5 minute skew");
  const stale = await telemetry({ collectedAtMs: NOW });
  assert.equal(stale.status, 409, "an older snapshot never silently overwrites a newer one");
  assert.equal((await telemetry({ collectedAtMs: NOW + 5 * 60_000 })).status, 200, "an identical retry is accepted");
  assert.equal((await hub.post("/api/v1/brief", brief())).status, 200);
  assert.equal((await hub.post("/api/v1/brief", { ...brief(), collectedAtMs: NOW - 1 })).status, 409);

  const alias64 = "a".repeat(64), alias65 = "a".repeat(65);
  assert.equal(isFleetAlias(alias64), true);
  assert.equal(isFleetAlias(alias65), false);
  assert.equal((await telemetry({ nodeId: alias65 })).status, 400);
  assert.equal((await telemetry({ agentId: alias65 })).status, 400);
  assert.equal((await telemetry({ nodeId: alias64 })).status, 200);
  assert.throws(() => buildNodeTelemetrySnapshot(":memory:", { ...IDS, nodeId: alias65 }), /fleet node and agent aliases/u);

  const lenient = await startHub(t, { now: () => NOW, maxClockSkewMs: 0, maxAliasLength: 0 });
  assert.equal((await lenient.post("/api/v1/telemetry", { ...measured(), nodeId: "a".repeat(500), collectedAtMs: NOW + 365 * 24 * HOUR })).status, 200,
    "maxClockSkewMs 0 and maxAliasLength 0 are unlimited");
  const strict = await startHub(t, { now: () => NOW, maxAliasLength: 8 });
  assert.equal((await strict.post("/api/v1/telemetry", measured())).status, 400, "\"charizard\" exceeds a configured cap of 8");
  for (const invalid of [{ maxClockSkewMs: -1 }, { snapshotTtlMs: 1.5 }, { maxAliasLength: Number.NaN }]) {
    assert.throws(() => createFleetOrganismHub({ dbPath: ":memory:", ...invalid }), RangeError);
  }
});

test("telemetry past snapshotTtlMs leaves /metrics and the leaderboards; 0 keeps it forever", async t => {
  let now = NOW;
  const hub = await startHub(t, { now: () => now });
  const forever = await startHub(t, { now: () => now, snapshotTtlMs: 0 });
  for (const target of [hub, forever]) assert.equal((await target.post("/api/v1/telemetry", measured())).status, 200);
  now = NOW + 47 * HOUR;
  for (const target of [hub, forever]) {
    assert.equal((await target.post("/api/v1/telemetry", measured({ nodeId: "blastoise", nowMs: now }))).status, 200);
  }
  const view = async (target: typeof hub) => ({
    metrics: [...(await (await target.get("/metrics")).text()).matchAll(/^unblock_memory_core_memories_total\{node="(\w+)"/gmu)].map(m => m[1]),
    leaderboard: ((await (await target.get("/api/v1/ab-leaderboard")).json()) as Array<{ nodes: string[] }>).flatMap(row => row.nodes),
    brief: ((await (await target.get("/api/v1/brief")).json()) as { leaderboard: Array<{ nodes: string[] }> }).leaderboard.flatMap(row => row.nodes),
  });
  assert.deepEqual(await view(hub), { metrics: ["blastoise", "charizard"], leaderboard: ["blastoise", "charizard"], brief: ["blastoise", "charizard"] });
  now = NOW + 48 * HOUR + 1;
  assert.deepEqual(await view(hub), { metrics: ["blastoise"], leaderboard: ["blastoise"], brief: ["blastoise"] }, "charizard expired after 48h");
  assert.match(await (await hub.get("/api/v1/brief?format=markdown")).text(), /\| 24h \| actr\\_v1 \| 1 \| 1 \|/u);
  assert.deepEqual(await view(forever), { metrics: ["blastoise", "charizard"], leaderboard: ["blastoise", "charizard"], brief: ["blastoise", "charizard"] });
});

test("the A/B leaderboard groups by sinceHours window and reports coverage", () => {
  const rows = aggregateAbLeaderboard([
    measured({ nodeId: "charizard", sinceHours: 24 }),
    measured({ nodeId: "blastoise", sinceHours: 24, nowMs: NOW - HOUR }),
    measured({ nodeId: "venusaur", sinceHours: 0 }),
    measured({ nodeId: "pikachu", sinceHours: 1 }),
  ]);
  assert.deepEqual(rows.map(row => [row.sinceHours, row.recipeHash, row.total, row.nodes, row.coverageFromMs, row.coverageToMs]), [
    [1, "actr_v1", 1, ["pikachu"], NOW - HOUR, NOW],
    [24, "actr_v1", 2, ["blastoise", "charizard"], NOW - 25 * HOUR, NOW],
    [0, "actr_v1", 1, ["venusaur"], null, NOW],
  ], "a 24h window and all history are never summed into one row");
  const markdown = renderFleetMorningBrief([], [measured({ sinceHours: 24 }), measured({ nodeId: "venusaur", sinceHours: 0 })]);
  assert.match(markdown, /^\| Window \| Recipe \|/mu);
  assert.match(markdown, /^\| 24h \| actr\\_v1 \| 1 \| 1 \|/mu);
  assert.match(markdown, /^\| all \| actr\\_v1 \| 1 \| 1 \|/mu);
});

test("pushNodeSnapshot refuses plain http:// beyond loopback before reading the key or sending anything", async t => {
  const missingKey = join(tmpdir(), "fleet-push-missing-key");
  for (const endpoint of ["http://fleet-hub.example.test/api/v1/telemetry", "http://10.0.0.5:8787/api/v1/telemetry",
    "http://127.0.0.1.example.test/api/v1/telemetry", "ftp://fleet-hub.example.test/telemetry"]) {
    await assert.rejects(pushNodeSnapshot(measured(), { endpoint, apiKeyFile: missingKey }), /must use https:\/\//u, endpoint);
  }
  const hub = await startHub(t, { now: () => NOW });
  const port = new URL(hub.base).port;
  await pushNodeSnapshot(measured(), { endpoint: `http://127.0.0.1:${port}/api/v1/telemetry` });
  await pushNodeSnapshot(measured(), { endpoint: new URL(`http://localhost:${port}/api/v1/telemetry`) });
});

test("hub CLI requires a credential for every role beyond loopback and validates limit flags", async t => {
  const root = mkdtempSync(join(tmpdir(), "fleet-hub-cli-"));
  t.after(() => rmSync(root, { recursive: true }));
  const token = join(root, "token");
  writeFileSync(token, "x\n");
  const script = join(import.meta.dirname, "..", "scripts", "fleet-organism-hub.mjs");
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [script, "--db", join(root, "hub.sqlite"), ...args]);
  await assert.rejects(run("--host", "0.0.0.0"), /Every role needs a token/u);
  await assert.rejects(run("--host", "0.0.0.0", "--read-token-file", token, "--ingest-tokens-file", token), /Every role needs a token/u);
  await assert.rejects(run("--private-metrics", "--operator-token-file", token), /--private-metrics requires/u);
  for (const flag of ["--max-clock-skew-ms", "--snapshot-ttl-ms", "--max-alias-length", "--max-body-bytes"]) {
    await assert.rejects(run(flag, "-5"), /Invalid|argument/u, flag);
    await assert.rejects(run(flag, "1.5"), new RegExp(`Invalid ${flag}`, "u"), flag);
  }
});
