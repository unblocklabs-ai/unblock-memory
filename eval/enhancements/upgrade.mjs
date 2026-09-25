// On-host upgrade rehearsal. All writes go to NEW_OUTPUT, never the snapshot or live index.
import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { readFile, writeFile, mkdir, cp, chmod } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const [snapshot, oldPlugin, newPlugin, output, keyFile, analysisExecutable] = process.argv.slice(2);
assert.ok(snapshot && oldPlugin && newPlugin && output && keyFile && analysisExecutable);
await mkdir(output, { mode: 0o700 });
const imp = (root, file) => import(pathToFileURL(`${root}/dist/src/${file}.js`));
const { resolveSources, resolveSessionSource } = await imp(newPlugin, "sources");
const { resolveTypeSafeApiKey } = await imp(newPlugin, "typesafe-client");
const config = JSON.parse(await readFile(`${snapshot}/openclaw.json`, "utf8")).plugins.entries["unblock-memory"].config;
const sourceState = `${snapshot}/agents/main/unblock-memory`;
const sources = resolveSources(`${snapshot}/workspace`, config.corpora.filter(c => c.kind === "files"));
const sessionConfig = config.corpora.find(c => c.kind === "sessions");
const sessionSource = resolveSessionSource(`${sourceState}/sessions`, sessionConfig.chatTypes);
const sessionBase = { agentId: "main", agentName: "Bill", chatTypes: sessionConfig.chatTypes,
  maxExpandedTokens: 500, collection: sessionSource.collection, timezone: "America/New_York",
  databasePath: `${snapshot}/agents/main/agent/openclaw-agent.sqlite` };
const db = new DatabaseSync(`${sourceState}/index.sqlite`, { readOnly: true });
const queries = [];
for (const corpus of ["memory", "knowledge", "sessions"]) {
  const collections = (corpus === "sessions" ? [sessionSource] : sources.filter(s => s.corpus === corpus)).map(s => s.collection);
  const rows = db.prepare(`SELECT d.collection,d.path,c.doc FROM documents d JOIN content c ON c.hash=d.hash
    WHERE d.active=1 AND d.collection IN (${collections.map(() => "?").join(",")}) ORDER BY d.path`).all(...collections);
  for (const row of rows) {
    if (queries.filter(q => q.corpus === corpus).length >= 3) break;
    const lines = row.doc.split("\n");
    for (const [index, line] of lines.entries()) {
      if (queries.filter(q => q.corpus === corpus).length >= 3) break;
      if (!/^(?:[-*] )?[A-Za-z]/.test(line) ||
          /source:|EXTERNAL_|sourceSession|This content|This context|Action:|Instruction:|Stats:|runtime-generated|session_key|Convert the result/.test(line)) continue;
      const sentence = line.split(/(?<=[.!?])\s+/).find(text => text.length >= 60 && text.length <= 240);
      if (!sentence || queries.some(probe => probe.query === sentence)) continue;
      queries.push({ corpus, query: sentence, path: `qmd://${row.collection}/${row.path}`, from: index + 1 });
    }
  }
}
assert.equal(queries.length, 9, "Need three retrieval probes per corpus");
const report = { basis: "Indexed corpus snapshot; isolated upgrade; real local tokenizer and embedding model", queries, before: [], after: [] };
const digest = value => createHash("sha256").update(value).digest("hex");
for (const [name, plugin] of [["before", oldPlugin], ["after", newPlugin]]) {
  const stage = `${output}/${name}`;
  await mkdir(stage, { mode: 0o700 });
  await backup(db, `${stage}/index.sqlite`);
  await chmod(`${stage}/index.sqlite`, 0o600);
  await cp(`${sourceState}/sessions-manifest.json`, `${stage}/manifest.json`, { errorOnExist: true, force: false });
  const oldCuration = new DatabaseSync(`${sourceState}/curation.sqlite`, { readOnly: true });
  try { await backup(oldCuration, `${stage}/curation.sqlite`); } finally { oldCuration.close(); }
  await chmod(`${stage}/curation.sqlite`, 0o600);
  await cp(`${sourceState}/sessions`, `${stage}/sessions`, { recursive: true, errorOnExist: true, force: false });
  const { QmdMemoryManager } = await imp(plugin, "manager");
  const manager = new QmdMemoryManager({ dbPath: `${stage}/index.sqlite`, curationPath: `${stage}/curation.sqlite`,
    workspaceDir: `${snapshot}/workspace`, keepModelsWarm: true, analysisExecutable,
    sources: [...sources, { ...sessionSource, root: `${stage}/sessions`, watchPath: `${stage}/sessions`, configuredPath: `${stage}/sessions` }],
    sessions: { ...sessionBase, manifestPath: `${stage}/manifest.json`, outputDir: `${stage}/sessions` },
  });
  try {
    if (name === "after") {
      console.log("stage: migration and real embedding");
      report.preMigration = await manager.diagnostics();
      const started = performance.now();
      report.sync = await manager.syncSessions(false, phase => console.log(`stage: ${phase}`));
      await manager.sync({ reason: "release-validation" });
      report.migrationMilliseconds = Math.round(performance.now() - started);
      report.postMigration = await manager.diagnostics();
      assert.equal(report.sync.failed, 0);
      assert.equal(report.postMigration.needsEmbedding, 0);
      assert.equal(report.postMigration.sessionsNeedingProjection, 0);
      assert.equal(report.postMigration.semanticChunkingVersion, 7);
    }
    console.log(`stage: ${name} real retrieval`);
    for (const probe of queries) {
      const hits = await manager.search(probe.query, { corpora: [probe.corpus], maxResults: 5, minScore: -1 });
      const rank = hits.findIndex(hit => hit.path === probe.path);
      let citationValid = false;
      if (rank >= 0) {
        const hit = hits[rank];
        const read = await manager.readFile({ relPath: hit.path, from: hit.startLine, lines: hit.endLine - hit.startLine + 1 });
        citationValid = read.status === "ok" && read.text.includes(probe.query);
      }
      report[name].push({ corpus: probe.corpus, path: probe.path, rank: rank < 0 ? null : rank + 1, citationValid,
        queryFingerprint: digest(probe.query) });
    }
    if (name === "after") {
      console.log("stage: on-host TypeSafe tools and cluster review");
      const apiKey = await resolveTypeSafeApiKey({ enabled: true, apiKeyFile: keyFile, timeoutMs: 10000 });
      assert.ok(apiKey);
      const options = { apiKey, timeoutMs: 10000, signal: AbortSignal.timeout(120000), corpora: config.qualityAudit.corpora };
      report.audit = await manager.auditQuality({ ...options, minNoise: 0.8, limit: 20 });
      assert.equal(report.audit.status, "ok");
      const probe = queries.find(q => q.corpus === "knowledge");
      report.claim = await manager.reviewClaim({ ...options, claim: probe.query, citations: [{ path: probe.path, from: probe.from, lines: 1 }] });
      assert.equal(report.claim.status, "ok");
      report.tasks = await manager.listMaintenanceTasks({ limit: 10 });
      console.log("stage: isolated reclustering");
      report.analysis = await manager.recluster({ seed: 42 }, AbortSignal.timeout(300000));
      const listed = await manager.listClusters(5);
      assert.ok(listed.clusters?.length);
      report.cluster = await manager.reviewCluster({ ...options, signal: AbortSignal.timeout(30000), clusterId: listed.clusters[0].clusterId });
      assert.equal(report.cluster.status, "ok");
    }
  } finally { await manager.close(); }
}
db.close();
report.retrievalRegressions = report.before.flatMap((item, i) => item.citationValid && !report.after[i].citationValid ? [i] : []);
await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ beforeRecallAt5: report.before.filter(item => item.citationValid).length,
  afterRecallAt5: report.after.filter(item => item.citationValid).length, queries: queries.length,
  retrievalRegressions: report.retrievalRegressions, sync: report.sync, postMigration: report.postMigration,
  clusterSampled: report.cluster?.sampled, output }));
assert.equal(report.retrievalRegressions.length, 0, "Inspect retrieval regressions");
