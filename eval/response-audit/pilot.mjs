// Operator-invoked on-host pilot. Raw conversations and the existing key stay on-host.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
const [plugin, stateRoot, output, senderId, mode = "dry-run", days = "30", batches = "1"] = process.argv.slice(2);
assert.ok(plugin && stateRoot && output && senderId && ["dry-run", "live", "cached"].includes(mode));
if (mode === "cached") globalThis.fetch = async () => { throw new Error("Cached verification must never call TypeSafe"); };
const lookbackDays = Number(days), maxBatches = Number(batches);
assert.ok(Number.isInteger(lookbackDays) && lookbackDays >= 1 && lookbackDays <= 90);
assert.ok(Number.isInteger(maxBatches) && maxBatches >= 1 && maxBatches <= 3);
const imp = file => import(pathToFileURL(`${plugin}/dist/src/${file}.js`));
const { resolveConfig } = await imp("config");
const { resolveSources } = await imp("sources");
const { auditResponses, responseCohort } = await imp("response-audit");
const { ResponseAuditStore } = await imp("response-store");
const { ResponseTranscriptReader } = await imp("response-episodes");
const raw = await readFile(`${stateRoot}/openclaw.json`, "utf8");
const host = JSON.parse(raw);
const config = resolveConfig({ ...host.plugins.entries["unblock-memory"].config,
  typesafe: { ...host.plugins.entries["unblock-memory"].config.typesafe, timeoutMs: 10000 },
  responseAudit: { enabled: true, senderIds: [senderId], chatTypes: ["direct", "channel"], lookbackDays,
    historyMessages: 6, maxEpisodes: 100, intervalMinutes: 0, memoryCorpora: ["memory", "knowledge"] } });
const options = { agentId: "main", config, databasePath: `${stateRoot}/agents/main/agent/openclaw-agent.sqlite`,
  storePath: `${output}/agents/main/unblock-memory/response-audit.sqlite`, indexPath: `${stateRoot}/agents/main/unblock-memory/index.sqlite`,
  peoplePath: `${stateRoot}/agents/main/unblock-memory/people.sqlite`,
  sources: resolveSources(host.agents.defaults.workspace, config.corpora.filter(c => c.kind === "files" && config.responseAudit.memoryCorpora.includes(c.name))) };
const first = await auditResponses({ ...options, dryRun: mode === "dry-run" });
const runs = [first];
let report, repeated, cacheVerified, cliVerified, storageVerified;
if (mode !== "dry-run" && first.status === "ok") {
  for (let batch = 1; batch < maxBatches && (runs.at(-1).coverage.deferredByLimit > 0 || runs.at(-1).coverage.sessionLimitReached); batch++) {
    assert.equal(runs.at(-1).coverage.failed, 0, "Inspect failures before another batch");
    assert.equal(runs.at(-1).coverage.stale, 0, "Inspect changed evidence before another batch");
    const next = await auditResponses(options);
    runs.push(next);
    assert.equal(next.status, "ok", "Audit batch interrupted; inspect before resuming");
  }
  const persisted = () => {
    const db = new DatabaseSync(options.storePath, { readOnly: true });
    try { return db.prepare("SELECT id,session_id,input_hash,attempts,assessed_at FROM response_results WHERE status='ok'").all(); }
    finally { db.close(); }
  };
  const original = persisted();
  // Explicit operator budget only: at most three batches of 100 inputs.
  assert.equal(runs.at(-1).coverage.deferredByLimit, 0, "Pilot cap reached; inspect coverage before expanding");
  assert.ok(runs.every(r => r.coverage.failed === 0 && r.coverage.stale === 0), "Inspect incomplete judgments");
  if (mode === "cached") assert.ok(runs.every(r => r.coverage.attempted === 0 && r.coverage.extractedSessions === 0));
  repeated = await auditResponses(options);
  assert.equal(repeated.coverage?.attempted, 0, "Repeat run unexpectedly made new inference attempts");
  const after = persisted();
  cacheVerified = original.filter(row => after.some(next => next.id === row.id && next.input_hash === row.input_hash &&
    next.attempts === row.attempts && next.assessed_at === row.assessed_at)).length;
  assert.equal(cacheVerified, original.length, "Successful pilot judgments were unexpectedly repeated");
  const store = new ResponseAuditStore(options.storePath);
  try {
    const cohort = responseCohort(config.responseAudit);
    report = store.report(cohort, Date.now() - lookbackDays * 86400_000);
    assert.ok(report.groups.every(g => g.human?.senderId === senderId), "Human attribution missing or mixed");
    assert.equal(repeated.coverage.extractedSessions, 0, "Repeat extracted unchanged sessions");
    assert.equal(repeated.coverage.stageAttempts, 0, "Repeat re-assessed successful stages");
    const tasks = store.reviews.list(cohort), candidate = tasks.find(t => t.evidenceStatus === "current");
    if (candidate) store.reviews.decide(cohort, candidate.id, "deferred", "agent", "Isolated pilot lifecycle check; substantive human review still required.");
    const taskRepeat = await auditResponses(options);
    assert.equal(taskRepeat.coverage.attempted, 0);
    assert.equal(store.reviews.list(cohort).length, tasks.length);
    if (candidate) assert.equal(store.reviews.list(cohort, candidate.id)[0].status, "deferred");
    const human = report.groups[0]?.human;
    if (human) assert.equal(store.report(cohort, 0, undefined, { senderId, accountScope: human.accountScope }).stored,
      report.groups.filter(g => g.human.accountScope === human.accountScope).reduce((n, g) => n + g.evaluated, 0));
    storageVerified = { tasks: tasks.length, decisionPreserved: !!candidate, repeatExtraction: repeated.coverage.extractedSessions,
      identities: [...new Set(report.groups.map(g => g.human.key))], linkedGroups: report.groups.filter(g => g.human.personId).length,
      stageRows: report.stages };
  }
  finally { store.close(); }
  // Exercise the real Commander registration/parser against the sandbox report.
  const require = createRequire(`${plugin}/package.json`);
  const { Command } = require(require.resolve("commander", { paths: [require.resolve("openclaw")] }));
  const { registerResponseAudit } = await imp("response-runtime");
  const previousState = process.env.OPENCLAW_STATE_DIR, log = console.log;
  let cliReport;
  try {
    process.env.OPENCLAW_STATE_DIR = output;
    const runCli = async args => {
      const program = new Command();
      registerResponseAudit({ registrationMode: "cli-metadata", registerCli(register) { register({ program, config: host }); } }, config);
      console.log = text => { cliReport = JSON.parse(text); };
      await program.parseAsync(["node", "openclaw", "memory-responses", ...args]);
      return cliReport;
    };
    await runCli(["report", "--agent", "main"]);
    assert.equal(cliReport.stored, report.stored);
    assert.equal(cliReport.cohort, report.cohort);
    const human = report.groups[0]?.human;
    if (human) {
      const perHuman = await runCli(["report", "--agent", "main", "--sender", senderId, "--account", human.accountScope, "--bucket", "day"]);
      assert.ok(perHuman.groups.every(g => g.human.senderId === senderId && g.human.accountScope === human.accountScope));
      assert.equal(perHuman.bucket, "day");
    }
    const taskReport = await runCli(["tasks", "--agent", "main"]);
    assert.equal(taskReport.tasks.length, storageVerified.tasks);
    const task = taskReport.tasks.find(t => t.evidenceStatus === "current");
    if (task) {
      const decision = await runCli(["review", "--agent", "main", "--id", task.id, "--status", "deferred", "--reviewer", "agent", "--note", "Sandbox CLI validation only; human review still required."]);
      assert.equal(decision[0].status, "deferred");
    }
    const annotation = await runCli(["annotate", "--agent", "main", "--date", "2026-09-18", "--kind", "other", "--note", "Isolated storage pilot, not a production deployment."]);
    assert.ok(annotation.id);
    const retry = await runCli(["retry-failed", "--agent", "main"]);
    assert.equal(retry.stages, 0); assert.equal(retry.episodes, 0);
    await assert.rejects(runCli(["report", "--agent", "main", "--since", "2026-02-31"]), /Dates/);
    cliVerified = true;
  } finally {
    console.log = log;
    if (previousState === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousState;
  }
  // Private review evidence, written only to the approved sandbox.
  const reader = new ResponseTranscriptReader(options.databasePath, "main");
  try {
    const evidence = [];
    for (const s of [...new Set(after.map(row => row.session_id))]) {
      const snapshot = reader.read(s, config.responseAudit);
      if (snapshot) evidence.push(...snapshot.episodes.filter(e => after.some(row => row.id === e.id && row.input_hash === e.inputHash)));
    }
    assert.equal(evidence.length, after.length, "Evidence changed or incomplete; inspect before manual review");
    await writeFile(`${output}/${mode === "cached" ? "cached-evidence" : "evidence"}.json`, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  } finally { reader.close(); }
}
assert.equal(await readFile(`${stateRoot}/openclaw.json`, "utf8"), raw, "Host configuration changed during pilot");
const result = { mode, lookbackDays, maxBatches, first, runs, repeated, report, cacheVerified, cliVerified, storageVerified, configUnchanged: true,
  configHash: createHash("sha256").update(raw).digest("hex"),
  limitation: "Isolated candidate; no Gateway installation or configuration change. Current-index opportunities do not prove historical memory availability." };
await writeFile(`${output}/${mode}-results.json`, JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ mode, lookbackDays, maxBatches, runs, repeated, groups: report?.groups, flaggedExamples: report?.examples.length, cacheVerified, cliVerified, storageVerified, configUnchanged: true }));
if (first.status === "unavailable") process.exitCode = 1;
