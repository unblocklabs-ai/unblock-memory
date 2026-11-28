import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { ensureMemoryCrystalsSchema } from "../src/memory-crystals.js";
import { OutcomeLedgerStore } from "../src/outcome-ledger.js";
import { openRecallLedger } from "../src/recall-ledger.js";
import { listSkillProposals, readSkillDescription, sha256 } from "../src/skill-proposals-store.js";
import { ensureOvernightThinkingSchema } from "../src/steward-overnight.js";
import type { StewardCompleteRequest, StewardCompleteResult, StewardRunner } from "../src/steward-runner.js";
import {
  replayGateFailure, replaySkillDescription, runStewardSkillsPass, SKILLS_DEFAULTS, SKILLS_WORK_KIND,
  type ReplayExample, type SkillCatalogScorer, type StewardSkillsPassOptions,
} from "../src/steward-skills.js";
import { WorkStore } from "../src/work-store.js";

const AGENT = "main";
const START = Date.parse("2026-11-27T19:00:00Z");
const MINUTE = 60_000;
const GATES = { minRecallGainPp: SKILLS_DEFAULTS.minRecallGainPp, maxFalseActivationPp: SKILLS_DEFAULTS.maxFalseActivationPp,
  maxCriticalRegressions: SKILLS_DEFAULTS.maxCriticalRegressions, minPositivesEvaluated: SKILLS_DEFAULTS.minPositivesEvaluated,
  minNegativesEvaluated: SKILLS_DEFAULTS.minNegativesEvaluated, minSamplesEvaluated: SKILLS_DEFAULTS.minSamplesPerSkill,
  maxReplayFailureRate: SKILLS_DEFAULTS.maxReplayFailureRate };
/** Positive-only replays: the recall gates alone, with the negative minimum switched off. */
const RECALL_ONLY = { ...GATES, minNegativesEvaluated: 0 };
const DECISION = { apiKey: "test-key" };

/* ───────────────────────────── Replay gate (pure) ───────────────────────────── */

/** Scorer seam: a description activates exactly for the prompts listed for it. */
function tableScorer(table: Record<string, ReadonlySet<string>>): SkillCatalogScorer & { calls: number } {
  const scorer = async (params: Parameters<SkillCatalogScorer>[0]) => {
    scorer.calls++;
    assert.equal(params.candidates.length, 1, "each replay judgment isolates one candidate");
    const active = table[params.candidates[0]!.description]?.has(params.currentRequest) ?? false;
    return active ? [{ index: 0, score: 0.95 }] : [];
  };
  scorer.calls = 0;
  return scorer;
}

const range = (prefix: string, from: number, to: number) => Array.from({ length: to - from }, (_, i) => `${prefix}${from + i}`);
const examples = (positives: string[], negatives: string[]): ReplayExample[] => [
  ...positives.map(prompt => ({ prompt, label: "positive" as const, source: `open:${prompt}` })),
  ...negatives.map(prompt => ({ prompt, label: "negative" as const, source: `route:${prompt}` })),
];
async function replay(table: Record<string, ReadonlySet<string>>, set: ReplayExample[]) {
  return replaySkillDescription({ skillName: "deploy", baselineDescription: "base", candidateDescription: "cand", examples: set,
    scoreCatalog: tableScorer(table), decision: DECISION, timeoutMs: 1000, minUsefulness: 0.7 });
}

test("replay gate rejects a description that regresses a previously-passing positive", async () => {
  const positives = range("p", 0, 10);
  const { metrics } = await replay({ base: new Set(range("p", 0, 5)), cand: new Set(range("p", 1, 10)) }, examples(positives, []));
  assert.equal(metrics.recallGainPp, 40);
  assert.equal(metrics.criticalRegressions, 1);
  assert.equal(replayGateFailure(metrics, RECALL_ONLY), "critical_regressions");
});

test("replay gate rejects insufficient recall gain (+1pp < +3pp)", async () => {
  const positives = range("p", 0, 100);
  const { metrics } = await replay({ base: new Set(range("p", 0, 50)), cand: new Set(range("p", 0, 51)) }, examples(positives, []));
  assert.equal(metrics.recallGainPp, 1);
  assert.equal(metrics.criticalRegressions, 0);
  assert.equal(replayGateFailure(metrics, RECALL_ONLY), "insufficient_recall_gain");
});

test("replay gate rejects excessive false activations (+5pp > +1pp)", async () => {
  const positives = range("p", 0, 10), negatives = range("n", 0, 20);
  const { metrics } = await replay({ base: new Set(range("p", 0, 5)), cand: new Set([...positives, "n0"]) }, examples(positives, negatives));
  assert.equal(metrics.recallGainPp, 50);
  assert.equal(metrics.falseActivationDeltaPp, 5);
  assert.equal(replayGateFailure(metrics, GATES), "excessive_false_activation");
});

test("replay gate accepts a clean +20pp improvement with zero regressions", async () => {
  const positives = range("p", 0, 10), negatives = range("n", 0, 10);
  const { metrics, judgments, failures } = await replay({ base: new Set(range("p", 0, 6)), cand: new Set(range("p", 0, 8)) },
    examples(positives, negatives));
  assert.deepEqual(metrics, { baselineRecall: 0.6, candidateRecall: 0.8, recallGainPp: 20, baselineFalseActivation: 0,
    candidateFalseActivation: 0, falseActivationDeltaPp: 0, criticalRegressions: 0, samplesEvaluated: 20, positives: 10, negatives: 10,
    examplesFailed: 0 });
  assert.equal(judgments, 40);
  assert.equal(failures, 0);
  assert.equal(replayGateFailure(metrics, GATES), undefined);
  // Gates are configuration, not constants.
  assert.equal(replayGateFailure(metrics, { ...GATES, minRecallGainPp: 25 }), "insufficient_recall_gain");
});

/* ───────────────────────────── Pass fixture ───────────────────────────── */

type Handler = (req: StewardCompleteRequest<unknown>) => unknown;
function fakeRunner(handlers: Record<string, Handler>) {
  const calls: StewardCompleteRequest<unknown>[] = [];
  const runner: Pick<StewardRunner, "complete"> = {
    async complete<T>(req: StewardCompleteRequest<T>): Promise<StewardCompleteResult<T>> {
      calls.push(req as StewardCompleteRequest<unknown>);
      const phase = req.purpose.split(":")[1]!;
      const handler = handlers[phase];
      if (!handler) throw new Error(`unexpected model call ${req.purpose}`);
      return { ok: true, data: handler(req as StewardCompleteRequest<unknown>) as T, usage: { requests: 1, inputTokens: 10 }, backend: "responses_api" };
    },
  };
  return { runner, calls };
}

const DEPLOY = `---\nname: deploy\ndescription: Deploy services to staging\n---\n\n# Deploy\n\n1. Run \`make deploy\`.\n2. Watch the canary.\n`;

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "steward-skills-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db: DatabaseSync = openRecallLedger(join(root, "memory.sqlite"));
  t.after(() => db.close());
  new OutcomeLedgerStore(db);
  ensureOvernightThinkingSchema(db);
  ensureMemoryCrystalsSchema(db);
  const workStore = new WorkStore(db);
  const skillPath = join(root, "skills", "deploy", "SKILL.md");
  mkdirSync(join(root, "skills", "deploy"), { recursive: true });
  writeFileSync(skillPath, DEPLOY);
  const catalog = [{ name: "deploy", description: "Deploy services to staging", path: skillPath }];
  let seq = 0;
  const query = (runId: string, prompt: string, chatType: string | null = "channel", at = START - 60 * MINUTE) => {
    db.prepare(`INSERT INTO recall_queries (event_key,created_at_ms,agent_id,source,run_id,session_id,chat_type,vec_query,corpora_json,ranking_mode,outcome)
      VALUES (?,?,?,'whisperer',?,?,?,?,'["memory"]','decision','emitted')`).run(`q${++seq}`, at, AGENT, runId, `s-${runId}`, chatType, prompt);
  };
  const open = (runId: string, path: string, whispered: boolean, at = START - 50 * MINUTE) => {
    db.prepare(`INSERT INTO skill_open_events (created_at_ms,agent_id,session_id,run_id,skill_path,tool_name,was_whispered,was_pinned)
      VALUES (?,?,?,?,?,'read',?,0)`).run(at, AGENT, `s-${runId}`, runId, path, whispered ? 1 : 0);
  };
  const route = (runId: string, eventKey: string, emitted: string[], at = START - 55 * MINUTE) => {
    db.prepare(`INSERT INTO skill_routing_events (event_key,created_at_ms,agent_id,session_id,run_id,mode,candidate_count,emitted_json,scores_json,outcome)
      VALUES (?,?,?,?,?,'direct',1,?,'[]','emitted')`).run(eventKey, at, AGENT, `s-${runId}`, runId, JSON.stringify(emitted));
  };
  const outcome = (id: string, path: string, verdict: "helped" | "ignored" | "hurt", eventKey: string, signals: object = {}, at = START - 40 * MINUTE) => {
    db.prepare(`INSERT INTO memory_outcomes (id,agent_id,subject_kind,subject_id,verdict,confidence,evidence_turn_id,signals_json,measured_at)
      VALUES (?,?,'skill',?,?,0.9,?,?,?)`).run(id, AGENT, path, verdict, `route:${eventKey}`, JSON.stringify(signals), at);
  };
  const crystal = (id: string, patch: { title: string; summary: string; corpora: string[]; tier?: "stm" | "ltm"; audience?: string;
    hitCount?: number; brightness?: number }) => {
    db.prepare(`INSERT INTO memory_crystals (id,agent_id,tier,revision,title,summary,audience_key,corpora_json,status,input_digest,brightness,hit_count,created_ms,verified_ms)
      VALUES (?,?,?,1,?,?,?,?,'active',?,?,?,?,?)`).run(id, AGENT, patch.tier ?? "ltm", patch.title, patch.summary, patch.audience ?? "workspace",
      JSON.stringify(patch.corpora), `digest-${id}`, patch.brightness ?? 0.5, patch.hitCount ?? 0, START - 1000, START - 1000);
    patch.corpora.forEach((corpus, ordinal) => db.prepare(`INSERT INTO memory_crystal_members
      (crystal_id,ordinal,corpus,source_path,doc_hash,chunk_pos,chunk_len,quote_sha256) VALUES (?,?,?,?,?,0,10,?)`)
      .run(id, ordinal, corpus, `qmd://${corpus}/${id}-${ordinal}.md`, sha256(`${id}${ordinal}`), sha256(`q${id}${ordinal}`)));
  };
  const live = () => ({ content: readFileSync(skillPath, "utf8"), mtimeMs: statSync(skillPath).mtimeMs });
  const options = (patch: Partial<StewardSkillsPassOptions>): StewardSkillsPassOptions => ({
    agentId: AGENT, owner: "test-owner", workStore, catalog, decision: DECISION, now: () => START, ignoreDueAt: true,
    enableDescriptionOptimizer: false, enablePitfallPatches: false, enableNewSkills: false, ...patch,
  });
  return { root, db, workStore, skillPath, catalog, query, open, route, outcome, crystal, live, options };
}

/** Six release prompts the skill was opened for without a whisper (missed activations), four unrelated prompts. */
function seedMissedActivations(f: ReturnType<typeof fixture>, chatType: string | null = "channel") {
  for (let i = 0; i < 6; i++) {
    f.query(`miss-${i}`, `how do I ship release ${i} to production`, chatType);
    f.open(`miss-${i}`, f.skillPath, false);
  }
  for (let i = 0; i < 4; i++) {
    f.query(`other-${i}`, `summarize the weather report ${i}`, chatType);
    f.open(`other-${i}`, "/elsewhere/weather/SKILL.md", true);
  }
}

/** Keyword scorer: activates when the description shares the triggering keyword with the request. */
const keywordScorer: SkillCatalogScorer = async ({ candidates, currentRequest }) => {
  const description = candidates[0]!.description.toLowerCase(), request = currentRequest.toLowerCase();
  const hit = description.includes("anything") || ["release", "deploy", "weather"].some(word => description.includes(word) && request.includes(word));
  return hit ? [{ index: 0, score: 0.9 }] : [];
};

/* ───────────────────────────── Phase 1 ───────────────────────────── */

test("description optimizer proposes a replay-validated description as pending and never touches SKILL.md", async t => {
  const f = fixture(t);
  seedMissedActivations(f);
  const before = f.live();
  const { runner, calls } = fakeRunner({ description: () => ({ shouldPropose: true,
    description: "Ship a release to production and verify the canary", rationale: "Missed release requests" }) });
  const result = await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true }));
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.descriptionUpdates, 1);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.replayJudgments, 20);
  const prompt = JSON.parse(calls[0]!.userPrompt) as { missedRequests: string[] };
  assert.equal(prompt.missedRequests.length, 6);

  const [proposal] = listSkillProposals(f.db, { agentId: AGENT });
  assert.equal(proposal?.status, "pending");
  assert.equal(proposal?.kind, "description_update");
  assert.equal(proposal?.baseSha256, sha256(DEPLOY));
  assert.equal(proposal?.baseDescription, "Deploy services to staging");
  assert.equal(readSkillDescription(proposal!.proposedContent), "Ship a release to production and verify the canary");
  assert.deepEqual(proposal?.replayMetrics, { baselineRecall: 0, candidateRecall: 1, recallGainPp: 100, baselineFalseActivation: 0,
    candidateFalseActivation: 0, falseActivationDeltaPp: 0, criticalRegressions: 0, samplesEvaluated: 10, positives: 6, negatives: 4,
    examplesFailed: 0 });
  assert.deepEqual(f.live(), before, "the live SKILL.md is never modified by the pass");

  // Same evidence on the next pass: no repeat model call, no duplicate proposal.
  const again = await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true }));
  assert.equal(again.status, "ok");
  assert.equal(again.modelCalls, 0);
  assert.equal(listSkillProposals(f.db, { agentId: AGENT }).length, 1);
  assert.equal(f.workStore.get(SKILLS_WORK_KIND, AGENT)?.status, "pending");
});

test("description optimizer drops a candidate that fails the replay gate (false activations)", async t => {
  const f = fixture(t);
  seedMissedActivations(f);
  const before = f.live();
  const { runner } = fakeRunner({ description: () => ({ shouldPropose: true, description: "Use for release work and anything else", rationale: "broad" }) });
  const result = await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true }));
  assert.equal(result.status, "ok");
  assert.equal(result.descriptionUpdates, 0);
  assert.equal(result.rejected[0]?.reason, "excessive_false_activation");
  assert.equal(result.rejected[0]?.replayMetrics?.falseActivationDeltaPp, 100);
  assert.deepEqual(listSkillProposals(f.db, { agentId: AGENT }), []);
  assert.deepEqual(f.live(), before);
});

test("description optimizer needs a replay scorer, minSamplesPerSkill, and allowed chat types", async t => {
  const f = fixture(t);
  seedMissedActivations(f, "direct");
  const { runner, calls } = fakeRunner({ description: () => ({ shouldPropose: true, description: "Ship a release", rationale: "r" }) });
  // No injected scorer and no decision key: the phase is skipped before any model spend.
  const unavailable = await runStewardSkillsPass(f.options({ runner, decision: undefined, enableDescriptionOptimizer: true }));
  assert.deepEqual(unavailable.errors, ["description_update:*:replay_unavailable"]);
  // DM prompts are excluded by default, leaving too few replayable samples.
  const privateByDefault = await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true }));
  assert.equal(privateByDefault.modelCalls, 0);
  assert.equal(calls.length, 0);
  // A 1:1 node opts DMs in via config.
  const optedIn = await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true,
    allowedChatTypes: ["workspace", "channel", "direct"] }));
  assert.equal(optedIn.descriptionUpdates, 1);
});

/* ───────────────────────────── Phase 2 ───────────────────────────── */

test("pitfall patches are grounded in hurt outcomes + shortfall postmortems, redacted, and saved as pending", async t => {
  const f = fixture(t);
  f.query("hurt-1", "deploy the billing service");
  f.route("hurt-1", "rk1", [f.skillPath]);
  f.outcome("o1", f.skillPath, "hurt", "rk1", { note: "token: sk-supersecret123456 leaked", reverted: true });
  f.query("hurt-2", "deploy the auth service");
  f.route("hurt-2", "rk2", [f.skillPath]);
  f.outcome("o2", f.skillPath, "hurt", "rk2", { reverted: true });
  f.outcome("o3", f.skillPath, "helped", "rk2");
  f.db.prepare(`INSERT INTO shortfall_postmortems (id,agent_id,outcome_id,evidence_turn_id,subject_kind,subject_id,root_cause,diagnosis,recommended_fix,confidence,analyzed_at_ms)
    VALUES ('p1',?,'o1','route:rk1','skill',?,'wrong_skill','Deploy ran before migrations','Document running migrations first','high',?)`)
    .run(AGENT, f.skillPath, START - 30 * MINUTE);
  const before = f.live();
  const { runner, calls } = fakeRunner({ pitfall: req => {
    const { evidence } = JSON.parse(req.userPrompt) as { evidence: Array<{ id: string }> };
    assert.deepEqual(evidence.map(item => item.id).sort(), ["outcome:o1", "outcome:o2", "postmortem:p1"]);
    return { shouldPatch: true, rationale: "Two hurt deploys", pitfalls: [
      { text: "Run database migrations before `make deploy`; deploying first breaks the canary.", evidenceIds: ["outcome:o1", "postmortem:p1"] },
      { text: "Invented pitfall with no evidence", evidenceIds: ["outcome:nope"] },
    ] };
  } });
  const result = await runStewardSkillsPass(f.options({ runner, enablePitfallPatches: true }));
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.pitfallPatches, 1);
  assert.doesNotMatch(calls[0]!.userPrompt, /sk-supersecret/u, "evidence is redacted before the model sees it");
  const [proposal] = listSkillProposals(f.db, { agentId: AGENT, kind: "pitfall_patch" });
  assert.equal(proposal?.status, "pending");
  assert.equal(proposal?.baseSha256, sha256(DEPLOY));
  assert.ok(proposal!.proposedContent.startsWith(DEPLOY.trimEnd()));
  assert.match(proposal!.proposedContent, /## Pitfalls\n\n- Run database migrations before `make deploy`; deploying first breaks the canary\.\n$/u);
  assert.doesNotMatch(proposal!.proposedContent, /Invented pitfall/u);
  assert.deepEqual((proposal!.evidence.evidenceIds as string[]).sort(), ["outcome:o1", "postmortem:p1"]);
  assert.deepEqual(f.live(), before, "the live SKILL.md is never modified by the pass");
});

test("pitfall patches wait for minPitfallEvidence", async t => {
  const f = fixture(t);
  f.route("hurt-1", "rk1", [f.skillPath]);
  f.outcome("o1", f.skillPath, "hurt", "rk1");
  const { runner, calls } = fakeRunner({ pitfall: () => ({ shouldPatch: true, rationale: "r", pitfalls: [] }) });
  const result = await runStewardSkillsPass(f.options({ runner, enablePitfallPatches: true }));
  assert.equal(result.modelCalls, 0);
  assert.equal(calls.length, 0);
  const lowered = await runStewardSkillsPass(f.options({ runner, enablePitfallPatches: true, minPitfallEvidence: 1 }));
  assert.equal(lowered.modelCalls, 1);
  assert.equal(lowered.rejected[0]?.reason, "ungrounded");
});

/* ───────────────────────────── Phase 3 ───────────────────────────── */

const RELEASE_DRAFT = (req: StewardCompleteRequest<unknown>) => {
  const { members } = JSON.parse(req.userPrompt) as { members: Array<{ sourcePath: string }> };
  return { shouldDraft: true, name: "invoice-reconciliation", title: "Invoice reconciliation", rationale: "Recurring month-end procedure",
    description: "Reconcile vendor invoices against the ledger at month end", whenToUse: "At month end before closing the books",
    steps: ["Export open invoices", "Match each invoice to a ledger entry", "Flag mismatches to finance"], pitfalls: [],
    citedSources: [members[0]!.sourcePath, "qmd://memory/invented.md"] };
};

test("new skills are mined from procedural crystals whose corpora are all allowed (sessions excluded by default)", async t => {
  const f = fixture(t);
  f.crystal("c-sessions", { title: "Invoice reconciliation", summary: "Month-end reconcile invoices against the ledger", corpora: ["memory", "sessions"] });
  f.crystal("c-covered", { title: "Deploy services", summary: "Deploy services to staging with make deploy", corpora: ["memory"] });
  f.crystal("c-dim", { title: "Payroll", summary: "Run payroll exports", corpora: ["memory"], tier: "stm", hitCount: 0, brightness: 0.2 });
  const { runner, calls } = fakeRunner({ new_skill: RELEASE_DRAFT });
  const safe = await runStewardSkillsPass(f.options({ runner, enableNewSkills: true }));
  assert.equal(safe.status, "ok");
  assert.equal(calls.length, 0, "sessions-derived, already-covered and dim crystals never reach the model by default");
  assert.equal(safe.newSkills, 0);

  const optedIn = await runStewardSkillsPass(f.options({ runner, enableNewSkills: true, allowedCorpora: ["memory", "knowledge", "sessions"] }));
  assert.equal(optedIn.status, "ok", JSON.stringify(optedIn));
  assert.equal(calls.length, 1);
  assert.equal(optedIn.newSkills, 1);
  const [proposal] = listSkillProposals(f.db, { agentId: AGENT, kind: "new_skill" });
  assert.equal(proposal?.status, "pending");
  assert.equal(proposal?.skillName, "invoice-reconciliation");
  assert.equal(proposal?.skillPath, "invoice-reconciliation/SKILL.md");
  assert.equal(proposal?.baseSha256, null);
  const content = proposal!.proposedContent;
  assert.match(content, /^---\nname: "invoice-reconciliation"\ndescription: "Reconcile vendor invoices against the ledger at month end"\n---\n/u);
  assert.equal(readSkillDescription(content), "Reconcile vendor invoices against the ledger at month end");
  assert.match(content, /## Steps\n\n1\. Export open invoices\n2\. Match each invoice to a ledger entry\n3\. Flag mismatches to finance/u);
  assert.match(content, /## Sources\n\n- `qmd:\/\/memory\/c-sessions-0\.md`\n$/u);
  assert.doesNotMatch(content, /invented/u, "only supplied member sources can be cited");
  assert.deepEqual(proposal!.evidence.corpora, ["memory", "sessions"]);
});

test("new skills honor allowedAudiences and reject invalid or ungrounded drafts", async t => {
  const f = fixture(t);
  f.crystal("c-dm", { title: "Invoice reconciliation", summary: "Month-end reconcile invoices", corpora: ["memory"], audience: "direct:slack:acct:u1" });
  const { runner, calls } = fakeRunner({ new_skill: req => ({ ...RELEASE_DRAFT(req), name: "Bad Name!" }) });
  await runStewardSkillsPass(f.options({ runner, enableNewSkills: true }));
  assert.equal(calls.length, 0, "a DM-audience crystal stays out by default");
  const optedIn = await runStewardSkillsPass(f.options({ runner, enableNewSkills: true, allowedAudiences: ["*"] }));
  assert.equal(calls.length, 1);
  assert.equal(optedIn.rejected[0]?.reason, "invalid_name");
  assert.deepEqual(listSkillProposals(f.db, { agentId: AGENT }), []);
});

/* ───────────────────────────── Whole pass ───────────────────────────── */

test("a full pass with every phase leaves every live SKILL.md byte-for-byte unchanged", async t => {
  const f = fixture(t);
  seedMissedActivations(f);
  f.route("hurt-1", "rk1", [f.skillPath]);
  f.outcome("o1", f.skillPath, "hurt", "rk1");
  f.outcome("o2", f.skillPath, "hurt", "rk1");
  f.crystal("c1", { title: "Invoice reconciliation", summary: "Month-end reconcile invoices against the ledger", corpora: ["knowledge"] });
  const before = f.live();
  const { runner } = fakeRunner({
    description: () => ({ shouldPropose: true, description: "Ship a release to production", rationale: "r" }),
    pitfall: () => ({ shouldPatch: true, rationale: "r", pitfalls: [{ text: "Check migrations first", evidenceIds: ["outcome:o1"] }] }),
    new_skill: RELEASE_DRAFT,
  });
  const result = await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer,
    enableDescriptionOptimizer: true, enablePitfallPatches: true, enableNewSkills: true }));
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.deepEqual([result.descriptionUpdates, result.pitfallPatches, result.newSkills], [1, 1, 1]);
  assert.ok(listSkillProposals(f.db, { agentId: AGENT }).every(proposal => proposal.status === "pending"));
  assert.deepEqual(f.live(), before);
  assert.equal(result.usage?.requests, 3);
});

test("per-phase caps are configurable and 0 means unlimited", async t => {
  const f = fixture(t);
  for (const id of ["c1", "c2", "c3"]) {
    f.crystal(id, { title: `Procedure ${id} reconciliation`, summary: `Month-end steps for ${id}`, corpora: ["memory"] });
  }
  let n = 0;
  const { runner, calls } = fakeRunner({ new_skill: req => ({ ...RELEASE_DRAFT(req), name: `procedure-${++n}` }) });
  const capped = await runStewardSkillsPass(f.options({ runner, enableNewSkills: true, maxNewSkillsPerRun: 1 }));
  assert.equal(capped.newSkills, 1);
  const unlimited = await runStewardSkillsPass(f.options({ runner, enableNewSkills: true, maxNewSkillsPerRun: 0 }));
  assert.equal(unlimited.newSkills, 2, "the remaining crystals are drafted; the already-drafted one is not re-asked");
  assert.equal(calls.length, 3);
});

test("schedule, abort and validation", async t => {
  const f = fixture(t);
  const scheduled = await runStewardSkillsPass(f.options({ ignoreDueAt: false }));
  assert.equal(scheduled.status, "ok");
  assert.equal(scheduled.nextDueAt, START + SKILLS_DEFAULTS.intervalMinutes * MINUTE);
  const early = await runStewardSkillsPass(f.options({ ignoreDueAt: false }));
  assert.equal(early.status, "not_due");
  const controller = new AbortController();
  controller.abort();
  assert.equal((await runStewardSkillsPass(f.options({ signal: controller.signal }))).status, "aborted");
  await assert.rejects(runStewardSkillsPass(f.options({ maxReplayExamples: -1 })), RangeError);
});

/* ───────────────────────────── Step 4 review fixes ───────────────────────────── */

/** Raw recall_queries row: any source, chat type (or NULL) and session key. */
function rawQuery(f: ReturnType<typeof fixture>, row: { key: string; runId: string; prompt: string; source?: "whisperer" | "tool";
  chatType?: string | null; sessionKey?: string | null; at?: number }) {
  f.db.prepare(`INSERT INTO recall_queries (event_key,created_at_ms,agent_id,source,run_id,session_id,session_key,chat_type,vec_query,corpora_json,ranking_mode,outcome)
    VALUES (?,?,?,?,?,?,?,?,?,'["memory"]','decision','emitted')`).run(row.key, row.at ?? START - 60 * MINUTE, AGENT, row.source ?? "whisperer",
    row.runId, `s-${row.runId}`, row.sessionKey ?? null, row.chatType === undefined ? "channel" : row.chatType, row.prompt);
}

const decline = () => ({ shouldPropose: false, description: "", rationale: "no" });

test("replay prompts are redacted and bounded before both the drafter and the replay scorer see them", async t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) {
    f.query(`miss-${i}`, `ship release ${i} using sk-livesecret${i}abcdefghijkl and token: hunter2 ${"padding ".repeat(80)}`);
    f.open(`miss-${i}`, f.skillPath, false);
  }
  for (let i = 0; i < 4; i++) { f.query(`other-${i}`, `summarize the weather report ${i}`); f.open(`other-${i}`, "/elsewhere/weather/SKILL.md", true); }
  const requests: string[] = [];
  const scorer: SkillCatalogScorer = async params => { requests.push(params.currentRequest); return keywordScorer(params); };
  const { runner, calls } = fakeRunner({ description: () => ({ shouldPropose: true, description: "Ship a release to production", rationale: "r" }) });
  const result = await runStewardSkillsPass(f.options({ runner, scoreCatalog: scorer, enableDescriptionOptimizer: true, maxEvidenceChars: 80 }));
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.ok(requests.length > 0);
  for (const text of [...requests, calls[0]!.userPrompt]) {
    assert.doesNotMatch(text, /sk-livesecret|hunter2/u, "secrets never reach the drafter or the scorer");
  }
  assert.ok(requests.every(request => request.length <= 81), "every replayed prompt is bounded by maxEvidenceChars");
  const { missedRequests } = JSON.parse(calls[0]!.userPrompt) as { missedRequests: string[] };
  assert.ok(missedRequests.every(request => request.length <= 81 && request.includes("[redacted]")));
});

test("a hurt outcome is never a positive, even when the skill was opened in that same run", async t => {
  const f = fixture(t);
  seedMissedActivations(f);
  f.query("hurt-run", "release the hotfix straight to production");
  f.route("hurt-run", "rk-hurt", [f.skillPath]);
  f.open("hurt-run", f.skillPath, false);
  f.outcome("o-hurt", f.skillPath, "hurt", "rk-hurt");
  const { runner, calls } = fakeRunner({ description: () => ({ shouldPropose: true, description: "Ship a release to production", rationale: "r" }) });
  const result = await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true }));
  const prompt = JSON.parse(calls[0]!.userPrompt) as { missedRequests: string[]; falseActivations: string[] };
  assert.equal(prompt.missedRequests.length, 6, "the hurt run is not a missed activation");
  assert.deepEqual(prompt.falseActivations, ["release the hotfix straight to production"]);
  const metrics = result.rejected[0]?.replayMetrics;
  assert.deepEqual([metrics?.positives, metrics?.negatives], [6, 5], "the hurt prompt is replayed as a negative");
  assert.equal(result.rejected[0]?.reason, "excessive_false_activation", "routing the hurt prompt again counts against the candidate");
});

test("the replay gate is indeterminate, never vacuously passing, without enough evaluated positives, negatives or samples", async () => {
  const positivesOnly = (await replay({ base: new Set(), cand: new Set(range("p", 0, 6)) }, examples(range("p", 0, 6), []))).metrics;
  assert.equal(replayGateFailure(positivesOnly, GATES), "indeterminate:insufficient_negatives");
  const negativesOnly = (await replay({ base: new Set(), cand: new Set() }, examples([], range("n", 0, 6)))).metrics;
  assert.equal(replayGateFailure(negativesOnly, { ...GATES, minRecallGainPp: -100 }), "indeterminate:insufficient_positives");
  const tiny = (await replay({ base: new Set(), cand: new Set(["p0"]) }, examples(["p0"], ["n0"]))).metrics;
  assert.equal(replayGateFailure(tiny, GATES), "indeterminate:insufficient_samples");
  assert.equal(replayGateFailure(tiny, { ...GATES, minSamplesEvaluated: 0 }), undefined, "every minimum is configurable");
});

test("a pass with no replayable negatives proposes nothing (no vacuous false-activation pass)", async t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) { f.query(`miss-${i}`, `how do I ship release ${i}`); f.open(`miss-${i}`, f.skillPath, false); }
  const { runner } = fakeRunner({ description: () => ({ shouldPropose: true, description: "Ship a release to production", rationale: "r" }) });
  const result = await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true }));
  assert.equal(result.descriptionUpdates, 0);
  assert.equal(result.rejected[0]?.reason, "indeterminate:insufficient_negatives");
});

test("a scorer outage is indeterminate and leaves the watermark unattempted, so the next pass retries", async t => {
  const f = fixture(t);
  seedMissedActivations(f);
  const { runner, calls } = fakeRunner({ description: () => ({ shouldPropose: true, description: "Ship a release to production", rationale: "r" }) });
  const outage: SkillCatalogScorer = async () => { throw new Error("503 from the decision model"); };
  const down = await runStewardSkillsPass(f.options({ runner, scoreCatalog: outage, enableDescriptionOptimizer: true }));
  assert.equal(down.status, "ok");
  assert.equal(down.rejected[0]?.reason, "indeterminate:scorer_failures");
  assert.equal(down.rejected[0]?.replayMetrics?.examplesFailed, 10);
  assert.deepEqual(listSkillProposals(f.db, { agentId: AGENT }), []);
  const recovered = await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true }));
  assert.equal(calls.length, 2, "the same input is drafted again once the scorer is back");
  assert.equal(recovered.descriptionUpdates, 1);
  // A partial outage under maxReplayFailureRate still decides; above it, it is indeterminate.
  let n = 0;
  const flaky: SkillCatalogScorer = async params => { if (++n % 4 === 0) throw new Error("flaky"); return keywordScorer(params); };
  const metrics = (await replaySkillDescription({ skillName: "deploy", baselineDescription: "Deploy services", candidateDescription: "Ship a release",
    examples: examples(range("release ", 0, 10), range("weather ", 0, 10)), scoreCatalog: flaky, decision: DECISION, timeoutMs: 1000,
    minUsefulness: 0.7, concurrency: 1 })).metrics;
  assert.ok(metrics.examplesFailed! > 0);
  assert.equal(replayGateFailure(metrics, { ...GATES, maxReplayFailureRate: 1 }), undefined);
  assert.equal(replayGateFailure(metrics, { ...GATES, maxReplayFailureRate: 0 }), "indeterminate:scorer_failures");
});

test("description digests cover each skill's own evidence, so new unrelated prompts never starve lower-ranked skills", async t => {
  const f = fixture(t);
  seedMissedActivations(f);
  const rollback = join(f.root, "skills", "rollback", "SKILL.md");
  mkdirSync(join(f.root, "skills", "rollback"), { recursive: true });
  writeFileSync(rollback, "---\nname: rollback\ndescription: Roll back releases\n---\n\n# Rollback\n");
  for (let i = 0; i < 5; i++) { f.query(`rb-${i}`, `undo deploy ${i}`); f.open(`rb-${i}`, rollback, false); }
  const catalog = [...f.catalog, { name: "rollback", description: "Roll back releases", path: rollback }];
  const drafted: string[] = [];
  const { runner } = fakeRunner({ description: req => { drafted.push((JSON.parse(req.userPrompt) as { skill: { name: string } }).skill.name); return decline(); } });
  const pass = () => runStewardSkillsPass(f.options({ runner, catalog, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true,
    maxDescriptionsPerRun: 1 }));
  await pass();
  assert.deepEqual(drafted, ["deploy"], "the top-ranked skill goes first");
  // A brand-new unrelated prompt changes the shared negative pool, not either skill's own evidence.
  f.query("new-other", "plan the team offsite");
  f.open("new-other", "/elsewhere/offsite/SKILL.md", true);
  await pass();
  assert.deepEqual(drafted, ["deploy", "rollback"], "the next pass reaches the lower-ranked skill");
  await pass();
  assert.deepEqual(drafted, ["deploy", "rollback"], "nothing is re-asked without new evidence of its own");
});

test("each pass loads replay prompts with ONE grouped recall_queries query (no per-run N+1)", async t => {
  const f = fixture(t);
  seedMissedActivations(f);
  f.route("hurt-1", "rk1", [f.skillPath]);
  f.outcome("o1", f.skillPath, "hurt", "rk1");
  f.outcome("o2", f.skillPath, "hurt", "rk1");
  const prepare = f.db.prepare.bind(f.db);
  // Count executions (not just prepares): a per-run `.get()` on one prepared statement is still N+1.
  const executions: string[] = [];
  Object.assign(f.db, { prepare: (sql: string) => {
    const statement = prepare(sql);
    if (!/FROM recall_queries/u.test(sql)) return statement;
    for (const method of ["get", "all", "iterate"] as const) {
      const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      Object.assign(statement, { [method]: (...args: unknown[]) => { executions.push(sql); return original(...args); } });
    }
    return statement;
  } });
  t.after(() => { Object.assign(f.db, { prepare }); });
  const { runner } = fakeRunner({ description: decline, pitfall: () => ({ shouldPatch: false, rationale: "r", pitfalls: [] }) });
  const result = await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true, enablePitfallPatches: true }));
  assert.equal(result.modelCalls, 2);
  assert.equal(executions.length, 1, executions.join("\n---\n"));
});

test("rows without a chat_type infer it from the session key; untyped keys stay unknown (excluded by default)", async t => {
  const f = fixture(t);
  const seed = (sessionKey: string | null, prefix: string) => {
    for (let i = 0; i < 6; i++) {
      rawQuery(f, { key: `${prefix}-q${i}`, runId: `${prefix}-${i}`, prompt: `ship release ${prefix} ${i}`, chatType: null, sessionKey });
      f.open(`${prefix}-${i}`, f.skillPath, false);
    }
    for (let i = 0; i < 4; i++) {
      rawQuery(f, { key: `${prefix}-w${i}`, runId: `${prefix}-w${i}`, prompt: `weather ${prefix} ${i}`, chatType: null, sessionKey });
      f.open(`${prefix}-w${i}`, "/elsewhere/weather/SKILL.md", true);
    }
  };
  seed(null, "untyped");
  const { runner, calls } = fakeRunner({ description: decline });
  await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true }));
  assert.equal(calls.length, 0, "no chat type and no session key = unknown, which is not allowed by default");
  seed("agent:main:slack:channel:c123", "channel");
  await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true }));
  const { missedRequests } = JSON.parse(calls[0]!.userPrompt) as { missedRequests: string[] };
  assert.ok(missedRequests.length === 6 && missedRequests.every(request => request.includes("channel")));
  seed("agent:main:main", "dm");
  await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true, lookbackDays: 0 }));
  assert.ok(calls.every(call => !call.userPrompt.includes("release dm")), "the untyped main session infers direct, excluded by default");
});

test("stale STM crystals are skipped in new-skill mining; fresh STM and LTM crystals still qualify", async t => {
  const f = fixture(t);
  f.crystal("c-stale", { title: "Invoice reconciliation", summary: "Month-end reconcile invoices", corpora: ["memory"], tier: "stm", hitCount: 9 });
  f.db.prepare("UPDATE memory_crystals SET stale_after_ms=? WHERE id='c-stale'").run(START);
  const { runner, calls } = fakeRunner({ new_skill: RELEASE_DRAFT });
  await runStewardSkillsPass(f.options({ runner, enableNewSkills: true }));
  assert.equal(calls.length, 0, "a crystal whose stale_after_ms has passed never reaches the model");
  f.db.prepare("UPDATE memory_crystals SET stale_after_ms=? WHERE id='c-stale'").run(START + 1);
  const fresh = await runStewardSkillsPass(f.options({ runner, enableNewSkills: true }));
  assert.equal(calls.length, 1);
  assert.equal(fresh.newSkills, 1);
});

test("catalog skills outside the configured skills sources are skipped before any model spend", async t => {
  const f = fixture(t);
  seedMissedActivations(f);
  mkdirSync(join(f.root, "other-skills"));
  const { runner, calls } = fakeRunner({ description: decline });
  const outside = await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true,
    allowedSkillSources: [{ root: join(f.root, "other-skills"), pattern: "**/SKILL.md" }] }));
  assert.equal(calls.length, 0);
  assert.deepEqual(outside.errors, ["catalog:deploy:outside_skill_sources"]);
  await runStewardSkillsPass(f.options({ runner, scoreCatalog: keywordScorer, enableDescriptionOptimizer: true,
    allowedSkillSources: [{ root: join(f.root, "skills"), pattern: "**/SKILL.md" }] }));
  assert.equal(calls.length, 1, "inside its source, the same skill is considered");
});

test("pitfall evidence carries the failing turn's bounded, redacted query context, and only from allowed chat types", async t => {
  const f = fixture(t);
  rawQuery(f, { key: "h1", runId: "hurt-1", prompt: "deploy billing with sk-billingsecret123456" });
  rawQuery(f, { key: "h1-tool", runId: "hurt-1", prompt: "billing migration order password=letmein", source: "tool", at: START - 59 * MINUTE });
  f.route("hurt-1", "rk1", [f.skillPath]);
  f.outcome("o1", f.skillPath, "hurt", "rk1");
  rawQuery(f, { key: "h2", runId: "hurt-2", prompt: "private dm deploy question", chatType: "direct" });
  f.route("hurt-2", "rk2", [f.skillPath]);
  f.outcome("o2", f.skillPath, "hurt", "rk2");
  let evidence: Array<{ id: string; text: string }> = [];
  const { runner } = fakeRunner({ pitfall: req => {
    ({ evidence } = JSON.parse(req.userPrompt) as { evidence: Array<{ id: string; text: string }> });
    return { shouldPatch: false, rationale: "r", pitfalls: [] };
  } });
  await runStewardSkillsPass(f.options({ runner, enablePitfallPatches: true, maxEvidenceChars: 400 }));
  const byId = Object.fromEntries(evidence.map(item => [item.id, JSON.parse(item.text.replace(/…$/u, "")) as Record<string, unknown>]));
  assert.equal(byId["outcome:o1"]?.request, "deploy billing with [redacted]");
  assert.deepEqual(byId["outcome:o1"]?.turnQueries, ["billing migration order password=[redacted]"]);
  assert.equal(byId["outcome:o2"]?.request, undefined, "a DM turn is never quoted under the default allowedChatTypes");
  assert.doesNotMatch(JSON.stringify(evidence), /sk-billingsecret|letmein|private dm/u);
  assert.ok(evidence.every(item => item.text.length <= 401));
});
