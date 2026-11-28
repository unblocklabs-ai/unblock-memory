import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { deepThoughtAudienceKey, DeepThoughtStore } from "../src/deep-thought-store.js";
import { ensureMemoryCrystalsSchema, listCoreMemories } from "../src/memory-crystals.js";
import { OutcomeLedgerStore } from "../src/outcome-ledger.js";
import { openRecallLedger } from "../src/recall-ledger.js";
import {
  ensureOvernightThinkingSchema, listShortfallPostmortems, listVoltaireShifts, OVERNIGHT_KIND, overnightLocalParts,
  runOvernightThinkingPass, summarizeOvernightThinking, withinQuietHours, type OvernightInvestigateParams,
  type OvernightInvestigateResult, type OvernightThinkingPassOptions, type ShortfallDiagnosis, type VoltaireDiff,
} from "../src/steward-overnight.js";
import type { StewardCompleteRequest, StewardCompleteResult, StewardRunner } from "../src/steward-runner.js";
import { WorkStore } from "../src/work-store.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Wednesday 06:00 UTC. */
const START = Date.parse("2026-11-25T06:00:00Z");
const AGENT = "main";
const CHANNEL_SESSION = "agent:main:slack:channel:c0ffee";
const AUDIENCE = deepThoughtAudienceKey({ agentId: AGENT, sessionKey: CHANNEL_SESSION, provider: "slack", accountId: "default" })!;
const QUESTION = "What shoes does Bek wear?";

type Call = { purpose: string; payload: Record<string, unknown> };
type Responders = {
  voltaire?: (payload: Record<string, unknown>) => VoltaireDiff;
  postmortem?: (payload: Record<string, unknown>) => ShortfallDiagnosis;
};

function fakeRunner(responders: Responders) {
  const calls: Call[] = [];
  const runner: Pick<StewardRunner, "complete"> = {
    async complete<T>(req: StewardCompleteRequest<T>): Promise<StewardCompleteResult<T>> {
      const payload = JSON.parse(req.userPrompt) as Record<string, unknown>;
      calls.push({ purpose: req.purpose, payload });
      const respond = req.purpose === "overnight_voltaire" ? responders.voltaire : responders.postmortem;
      if (!respond) return { ok: false, code: "provider_error", error: "no responder", retryable: false, usage: { requests: 1 } };
      return { ok: true, data: respond(payload) as T, usage: { requests: 1, inputTokens: 10, outputTokens: 5 }, backend: "responses_api" };
    },
  };
  return { runner, calls };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "steward-overnight-"));
  const dbPath = join(root, "memory.sqlite");
  const workStore = new WorkStore(dbPath);
  const recallDb = openRecallLedger(dbPath);
  const deepThought = new DeepThoughtStore(workStore.db);
  let time = START;
  let eventSeq = 0;
  t.after(() => { recallDb.close(); workStore.close(); rmSync(root, { recursive: true, force: true }); });
  const recallQuery = (question: string, atMs: number, overrides: { sessionKey?: string; chatType?: string; senderId?: string;
    corpora?: string[] } = {}) => {
    recallDb.prepare(`INSERT INTO recall_queries (event_key, created_at_ms, agent_id, source, session_key, provider, account_id, sender_id,
      chat_type, vec_query, corpora_json, ranking_mode, outcome) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`evt-${++eventSeq}`, atMs, AGENT, "whisperer", overrides.sessionKey ?? CHANNEL_SESSION, "slack", "default",
        overrides.senderId ?? "U1", overrides.chatType ?? "channel", question, JSON.stringify(overrides.corpora ?? ["notes"]),
        "decision", "emitted");
    return `evt-${eventSeq}`;
  };
  const observe = (question: string, answer: string, generation: number, atMs = START - 10 * DAY, audienceKey = AUDIENCE) =>
    deepThought.saveDerivedObservation({ agentId: AGENT, question, audienceKey, corpora: ["notes"],
      collectionGenerations: { notes: generation }, answer, confidence: "high",
      citations: [{ source: "notes:people/bek.md", quote: answer }], nowMs: atMs });
  const options = (overrides: Partial<OvernightThinkingPassOptions> & Pick<OvernightThinkingPassOptions, "runner">): OvernightThinkingPassOptions => ({
    agentId: AGENT, owner: "test-owner", workStore, timezone: "UTC", now: () => time, heartbeatMs: 60_000, ...overrides,
  });
  return {
    root, dbPath, workStore, recallQuery, observe, options,
    setTime: (value: number) => { time = value; },
    advance: (ms: number) => { time += ms; },
  };
}

function investigator(answerFor: (params: OvernightInvestigateParams) => Partial<OvernightInvestigateResult> & { answer: string }) {
  const calls: OvernightInvestigateParams[] = [];
  const investigate = async (params: OvernightInvestigateParams): Promise<OvernightInvestigateResult> => {
    calls.push(params);
    const value = answerFor(params);
    return { status: "complete", confidence: "high", citations: [{ corpus: "notes", path: "people/bek.md", quote: value.answer }], ...value };
  };
  return { investigate, calls };
}

/* ───────────────────────────── Schema & read-only helpers ───────────────────────────── */

test("plain Node loads the overnight steward without OpenClaw and registers STRICT schema v1", () => {
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { registerHooks } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "openclaw" || specifier.startsWith("openclaw/") || specifier.startsWith("@openclaw/")) {
        throw new Error("Unexpected host SDK import");
      }
      return nextResolve(specifier, context);
    } });
    const { ensureOvernightThinkingSchema, OVERNIGHT_KIND } = await import(${JSON.stringify(new URL("../src/steward-overnight.ts", import.meta.url).href)});
    if (OVERNIGHT_KIND !== "overnight_thinking") throw new Error("kind");
    const db = new DatabaseSync(":memory:");
    ensureOvernightThinkingSchema(db);
    db.close();
  `]);
  const db = new DatabaseSync(":memory:");
  try {
    ensureOvernightThinkingSchema(db);
    ensureOvernightThinkingSchema(db); // idempotent
    db.exec("BEGIN IMMEDIATE");
    ensureOvernightThinkingSchema(db); // safe inside an open transaction
    db.exec("COMMIT");
    assert.equal(OVERNIGHT_KIND, "overnight_thinking");
    assert.equal(db.prepare("SELECT version FROM memory_schema WHERE component='overnight_thinking'").get()?.version, 1);
    for (const table of ["voltaire_shifts", "shortfall_postmortems"]) {
      assert.equal(db.prepare("SELECT strict FROM pragma_table_list WHERE name=?").get(table)?.strict, 1, `${table} is STRICT`);
    }
    assert.deepEqual(db.prepare("PRAGMA table_info(voltaire_shifts)").all().map(row => row.name), ["id", "agent_id", "question",
      "question_hash", "audience_key", "prior_observation_id", "new_observation_id", "shift_type", "confidence", "prior_truth",
      "new_truth", "summary", "citations_json", "detected_at_ms"]);
    assert.deepEqual(db.prepare("PRAGMA table_info(shortfall_postmortems)").all().map(row => row.name), ["id", "agent_id", "outcome_id",
      "evidence_turn_id", "subject_kind", "subject_id", "root_cause", "diagnosis", "recommended_fix", "confidence", "analyzed_at_ms"]);
    assert.throws(() => db.exec(`INSERT INTO voltaire_shifts VALUES ('s','main','q','h','a',NULL,NULL,'vibes','high','p','n','s','[]',0)`),
      /CHECK constraint/);
    assert.throws(() => db.exec(`INSERT INTO voltaire_shifts VALUES ('s','main','q','h','a',NULL,NULL,'updated','high','p','n','s','nope',0)`),
      /CHECK constraint/);
    assert.throws(() => db.exec(`INSERT INTO shortfall_postmortems VALUES ('p','main','o','t','skill','s','gremlins','d','f','high',0)`),
      /CHECK constraint/);
    db.exec(`INSERT INTO shortfall_postmortems VALUES ('p','main','o','t','skill','s','other','d','f','high',0)`);
    assert.throws(() => db.exec(`INSERT INTO shortfall_postmortems VALUES ('p2','main','o','t','skill','s','other','d','f','high',0)`),
      /UNIQUE constraint/);
    db.exec("UPDATE memory_schema SET version=2 WHERE component='overnight_thinking'");
    assert.throws(() => ensureOvernightThinkingSchema(db), /Unsupported overnight_thinking schema version/);
  } finally { db.close(); }
});

test("read-only helpers never create or migrate a missing database", t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "steward-overnight-ro-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missing = join(root, "nope.sqlite");
  assert.deepEqual(listVoltaireShifts(missing), []);
  assert.deepEqual(listShortfallPostmortems(missing, { agentId: AGENT }), []);
  assert.deepEqual(summarizeOvernightThinking(missing), { shifts: 0, shiftsByType: {}, postmortems: 0, postmortemsByRootCause: {} });
  assert.equal(existsSync(missing), false, "missing database stays missing");

  const bare = join(root, "bare.sqlite");
  new DatabaseSync(bare).close();
  assert.deepEqual(listVoltaireShifts(bare), []);
  assert.deepEqual(summarizeOvernightThinking(bare).shifts, 0);
  const check = new DatabaseSync(bare, { readOnly: true });
  try { assert.equal(check.prepare("SELECT count(*) n FROM sqlite_schema").get()?.n, 0, "no tables were created"); }
  finally { check.close(); }
  assert.throws(() => listVoltaireShifts(bare, { limit: -1 }), /limit must be an integer/);
});

/* ───────────────────────────── Phase A: Voltaire Drift ───────────────────────────── */

test("Voltaire: unchanged collection generations skip re-investigation entirely", async t => {
  const f = fixture(t);
  f.observe(QUESTION, "Bek loves Adidas.", 3);
  f.recallQuery(QUESTION, START - 5 * DAY);
  f.recallQuery("what shoes does bek wear", START - 2 * DAY);
  const { runner, calls } = fakeRunner({});
  const probe = investigator(() => ({ answer: "unused" }));
  const result = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, postmortemsEnabled: false,
    preAnswerEnabled: false, getCollectionGenerations: () => ({ notes: 3 }) }));
  assert.equal(result.status, "completed");
  assert.equal(result.voltaire.candidates, 1);
  assert.equal(result.voltaire.skippedUnchanged, 1);
  assert.equal(probe.calls.length, 0, "0 wasted investigations");
  assert.equal(calls.length, 0, "0 wasted model calls");
  assert.equal(result.nextDueAt, START + 720 * MINUTE, "re-armed on the 12h default interval");
});

test("Voltaire: a bumped generation re-investigates and an unchanged conclusion records no shift", async t => {
  const f = fixture(t);
  f.observe(QUESTION, "Bek loves Adidas.", 3);
  const { runner, calls } = fakeRunner({ voltaire: () => ({ shifted: false, shiftType: "none", confidence: "high",
    priorTruth: "Bek loves Adidas.", newTruth: "Bek loves Adidas.", summary: "Same conclusion, reworded." }) });
  const probe = investigator(() => ({ answer: "Bek is a big fan of Adidas sneakers.", derivedObservationId: "obs_new" }));
  const result = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, postmortemsEnabled: false,
    preAnswerEnabled: false, getCollectionGenerations: () => ({ notes: 4 }) }));
  assert.equal(result.status, "completed");
  assert.equal(probe.calls.length, 1);
  assert.deepEqual(probe.calls[0], { question: QUESTION, corpora: ["notes"], audienceKey: AUDIENCE, signal: probe.calls[0]!.signal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.purpose, "overnight_voltaire");
  assert.equal(calls[0]!.payload.priorAnswer, "Bek loves Adidas.");
  assert.equal(calls[0]!.payload.newAnswer, "Bek is a big fan of Adidas sneakers.");
  assert.equal(calls[0]!.payload.priorDate, new Date(START - 10 * DAY).toISOString());
  assert.equal(calls[0]!.payload.newDate, new Date(START).toISOString());
  assert.equal(result.voltaire.compared, 1);
  assert.equal(result.voltaire.shifts, 0);
  assert.deepEqual(listVoltaireShifts(f.dbPath), []);
});

test("Voltaire: a real truth shift records an immutable shift, a core_memories anchor and an append-only daily note", async t => {
  const f = fixture(t);
  const prior = f.observe(QUESTION, "Bek loves Adidas.", 3);
  f.workStore.db.exec(`CREATE TABLE core_memories (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_kind TEXT NOT NULL,
    source_ref TEXT, audience_key TEXT NOT NULL, content TEXT NOT NULL, source_path TEXT, quote TEXT, created_at_ms INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0) STRICT`);
  // Make the audience a known shared channel so the daily log may carry it.
  f.recallQuery(QUESTION, START - 3 * DAY);
  const dailyLogDir = join(f.root, "workspace", "memory");
  const hooked: string[] = [];
  const { runner, calls } = fakeRunner({ voltaire: () => ({ shifted: true, shiftType: "contradicted", confidence: "high",
    priorTruth: "Bek loves Adidas.", newTruth: "Bek only wears Yeezys.", summary: "The Nov 20 notes say Bek switched to Yeezys only." }) });
  const probe = investigator(() => ({ answer: "Bek only wears Yeezys now.", derivedObservationId: "obs_yeezy",
    citations: [{ corpus: "notes", path: "2026-11-20.md", quote: "Bek: only Yeezys from now on" }] }));
  const result = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, postmortemsEnabled: false,
    preAnswerEnabled: false, getCollectionGenerations: () => ({ notes: 4 }), dailyLogDir, dailyLogCorpora: ["notes"],
    appendDailyLogNote: note => { hooked.push(note.markdown); } }));
  assert.equal(result.status, "completed");
  assert.equal(probe.calls.length, 1, "one candidate: generation-moved and recurring merge into one key");
  assert.equal(calls.length, 1);
  assert.equal(result.voltaire.shifts, 1);
  assert.equal(result.voltaire.anchors, 1);
  assert.equal(result.voltaire.dailyLogNotes, 1);
  const [shift] = listVoltaireShifts(f.dbPath, { agentId: AGENT });
  assert.ok(shift);
  assert.equal(shift.shiftType, "contradicted");
  assert.equal(shift.confidence, "high");
  assert.equal(shift.audienceKey, AUDIENCE);
  assert.equal(shift.priorObservationId, prior.id);
  assert.equal(shift.newObservationId, "obs_yeezy");
  assert.equal(shift.priorTruth, "Bek loves Adidas.");
  assert.equal(shift.newTruth, "Bek only wears Yeezys.");
  assert.equal(shift.detectedAtMs, START);
  assert.deepEqual(shift.citations, [{ corpus: "notes", path: "2026-11-20.md", quote: "Bek: only Yeezys from now on" }]);
  const anchor = f.workStore.db.prepare("SELECT * FROM core_memories").get();
  assert.equal(anchor?.source_kind, "voltaire_shift");
  assert.equal(anchor?.source_ref, shift.id);
  assert.equal(anchor?.audience_key, AUDIENCE);
  assert.equal(anchor?.source_path, "2026-11-20.md");
  assert.match(String(anchor?.content), /Yeezys.*was: Bek loves Adidas/u);
  const log = readFileSync(join(dailyLogDir, "2026-11-25.md"), "utf8");
  assert.match(log, /❔ As of 2026-11-15: Bek loves Adidas\./u);
  assert.match(log, /✅ As of 2026-11-25: Bek only wears Yeezys\./u);
  assert.equal(hooked.length, 1);
  // The prior observation itself is untouched history.
  assert.equal(new DeepThoughtStore(f.workStore.db).getDerivedObservation(prior.id)?.answer, "Bek loves Adidas.");
  const summary = summarizeOvernightThinking(f.dbPath, { agentId: AGENT });
  assert.equal(summary.shifts, 1);
  assert.deepEqual(summary.shiftsByType, { contradicted: 1 });
});

test("Voltaire: low-confidence shifts are skipped (and DM audiences never reach the shared daily log)", async t => {
  const f = fixture(t);
  f.observe(QUESTION, "Bek loves Adidas.", 3);
  const dailyLogDir = join(f.root, "daily");
  const { runner } = fakeRunner({ voltaire: () => ({ shifted: true, shiftType: "updated", confidence: "low",
    priorTruth: "Bek loves Adidas.", newTruth: "Bek maybe likes Nike?", summary: "Thin evidence." }) });
  const probe = investigator(() => ({ answer: "Bek might like Nike." }));
  const low = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, postmortemsEnabled: false,
    preAnswerEnabled: false, getCollectionGenerations: () => ({ notes: 4 }), dailyLogDir, saveDerivedObservations: false }));
  assert.equal(low.voltaire.compared, 1);
  assert.equal(low.voltaire.lowConfidence, 1);
  assert.equal(low.voltaire.shifts, 0);
  assert.deepEqual(listVoltaireShifts(f.dbPath), []);

  // Opting in to low confidence records it, but an audience never seen as a shared channel stays out of the daily log.
  f.advance(721 * MINUTE);
  const recorded = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, postmortemsEnabled: false,
    preAnswerEnabled: false, getCollectionGenerations: () => ({ notes: 4 }), dailyLogDir, minConfidence: "low" }));
  assert.equal(recorded.voltaire.shifts, 1);
  assert.equal(recorded.savedObservations, 1);
  const [shift] = listVoltaireShifts(f.dbPath);
  assert.equal(new DeepThoughtStore(f.workStore.db).getDerivedObservation(shift!.newObservationId!)?.answer, "Bek might like Nike.",
    "the shift points at the observation the pass persisted");
  assert.equal(recorded.voltaire.dailyLogNotes, 0);
  assert.equal(existsSync(dailyLogDir), false);
});

test("Voltaire: a first answer to a recurring question seeds a derived observation without a diff call", async t => {
  const f = fixture(t);
  f.recallQuery("Who owns the LMNT launch?", START - 4 * DAY);
  f.recallQuery("who owns the lmnt launch", START - DAY);
  f.recallQuery("Asked only once", START - DAY);
  const { runner, calls } = fakeRunner({});
  const probe = investigator(() => ({ answer: "Sage owns the LMNT launch." }));
  const result = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, postmortemsEnabled: false,
    preAnswerEnabled: false, getCollectionGenerations: () => ({ notes: 7 }) }));
  assert.equal(result.voltaire.candidates, 1, "single-ask questions are not recurring");
  assert.equal(probe.calls.length, 1);
  assert.equal(calls.length, 0, "nothing to diff against yet");
  assert.equal(result.savedObservations, 1);
  const [saved] = new DeepThoughtStore(f.workStore.db).listDerivedObservations({ agentId: AGENT, status: "fresh" });
  assert.equal(saved?.answer, "Sage owns the LMNT launch.");
  assert.equal(saved?.audienceKey, AUDIENCE);
  assert.deepEqual(saved?.collectionGenerations, { notes: 7 });
});

/* ───────────────────────────── Phase B: Shortfall Post-Mortems ───────────────────────────── */

test("post-mortems: each hurt outcome is diagnosed once and stored; re-runs are idempotent", async t => {
  const f = fixture(t);
  new OutcomeLedgerStore(f.workStore.db).close();
  const evidence = f.recallQuery("When is the Perelel review?", START - DAY);
  const insert = f.workStore.db.prepare(`INSERT INTO memory_outcomes (id, agent_id, subject_kind, subject_id, verdict, confidence,
    evidence_turn_id, signals_json, measured_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  insert.run("out-hurt", AGENT, "memory_hit", "memory/2026-10-01.md", "hurt", 0.8, `query:${evidence}`,
    JSON.stringify({ correction: true, note: "user said token=abc123 is wrong date" }), START - DAY);
  insert.run("out-helped", AGENT, "skill", "skills/x/SKILL.md", "helped", 0.9, "route:r1", "{}", START - DAY);
  insert.run("out-other-agent", "theo", "skill", "skills/y/SKILL.md", "hurt", 0.9, "route:r2", "{}", START - DAY);
  const { runner, calls } = fakeRunner({ postmortem: () => ({ rootCause: "stale_memory", confidence: "high",
    diagnosis: "An October daily note with the old review date was surfaced.",
    recommendedFix: "Annotate memory/2026-10-01.md as superseded by the November schedule." }) });
  const first = await runOvernightThinkingPass(f.options({ runner, voltaireEnabled: false, preAnswerEnabled: false }));
  assert.equal(first.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.purpose, "overnight_postmortem");
  assert.equal(calls[0]!.payload.subjectKind, "memory_hit");
  assert.equal(calls[0]!.payload.recallQuery, "When is the Perelel review?");
  assert.doesNotMatch(JSON.stringify(calls[0]!.payload), /abc123/u, "signals are redacted");
  assert.equal(first.postmortems.analyzed, 1);
  const [pm] = listShortfallPostmortems(f.dbPath, { agentId: AGENT });
  assert.equal(pm?.outcomeId, "out-hurt");
  assert.equal(pm?.rootCause, "stale_memory");
  assert.equal(pm?.evidenceTurnId, `query:${evidence}`);
  assert.equal(pm?.subjectId, "memory/2026-10-01.md");
  assert.match(pm?.recommendedFix ?? "", /superseded/u);
  assert.equal(summarizeOvernightThinking(f.dbPath, { agentId: AGENT }).pendingHurtOutcomes, 0);

  f.advance(721 * MINUTE);
  const second = await runOvernightThinkingPass(f.options({ runner, voltaireEnabled: false, preAnswerEnabled: false }));
  assert.equal(second.status, "empty");
  assert.equal(calls.length, 1, "0 duplicate calls");
  assert.equal(listShortfallPostmortems(f.dbPath).length, 1);
});

test("post-mortems: a missing Outcome Ledger table is skipped gracefully", async t => {
  const f = fixture(t);
  const { runner, calls } = fakeRunner({});
  const result = await runOvernightThinkingPass(f.options({ runner, voltaireEnabled: false, preAnswerEnabled: false }));
  assert.equal(result.status, "empty");
  assert.equal(calls.length, 0);
});

/* ───────────────────────────── Phase C: Anticipatory Pre-Answering ───────────────────────────── */

test("pre-answering: weekday/hour rhythms and upcoming topics are investigated ahead of time, skipping fresh answers", async t => {
  const f = fixture(t);
  assert.deepEqual(overnightLocalParts(START, "UTC"), { dateKey: "2026-11-25", weekday: 3, hour: 6 });
  const wed = (daysAgo: number, hour: number) => START - daysAgo * DAY + (hour - 6) * 60 * MINUTE;
  // Rhythm: Wednesday 09:xx on two distinct Wednesdays.
  f.recallQuery("What is on the FGA standup agenda?", wed(7, 9) + 5 * MINUTE);
  f.recallQuery("what is on the fga standup agenda", wed(14, 9) + 20 * MINUTE);
  // Same slot twice on ONE day is not a rhythm.
  f.recallQuery("Sakara inventory status?", wed(7, 10));
  f.recallQuery("Sakara inventory status", wed(7, 10) + 10 * MINUTE);
  // A rhythm outside the 12h lookahead (Wednesday 20:00) is not upcoming.
  f.recallQuery("Evening revenue recap?", wed(7, 20));
  f.recallQuery("Evening revenue recap?", wed(14, 20));
  // A rhythm whose answer is already fresh at the current generation is skipped.
  f.recallQuery("Who is on call?", wed(7, 11));
  f.recallQuery("Who is on call?", wed(14, 11));
  f.observe("Who is on call?", "Fred is on call.", 9);
  const otherAudience = "caller:dm-only";
  const topics: unknown[] = [];
  const { runner, calls } = fakeRunner({});
  const probe = investigator(params => ({ answer: `Prepared answer for ${params.question}` }));
  const result = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, voltaireEnabled: false,
    postmortemsEnabled: false, getCollectionGenerations: () => ({ notes: 9 }),
    upcomingTopics: async params => {
      topics.push(params);
      return [{ topic: "Thesis board prep", corpora: ["notes"], audienceKey: otherAudience }, { topic: "No audience anywhere" }];
    } }));
  assert.equal(result.status, "completed");
  assert.deepEqual(topics, [{ agentId: AGENT, nowMs: START, lookaheadMinutes: 720, signal: (topics[0] as { signal: unknown }).signal }]);
  assert.deepEqual(probe.calls.map(call => [call.question, call.audienceKey]).sort(), [
    ["Thesis board prep", otherAudience],
    ["What is on the FGA standup agenda?", AUDIENCE], // the most recent phrasing
  ]);
  assert.equal(result.preAnswers.skippedFresh, 1);
  assert.equal(result.preAnswers.answered, 2);
  assert.equal(calls.length, 0, "pre-answering needs no diff calls");
  const fresh = new DeepThoughtStore(f.workStore.db);
  const standup = fresh.findFreshDerivedObservation({ agentId: AGENT, question: "What is on the FGA standup agenda?",
    audienceKey: AUDIENCE, corpora: ["notes"], currentGenerations: { notes: 9 } });
  assert.match(standup?.answer ?? "", /Prepared answer/u, "the answer is already waiting for the whisperer");
  assert.equal(fresh.findFreshDerivedObservation({ agentId: AGENT, question: "Thesis board prep", audienceKey: AUDIENCE,
    corpora: ["notes"], currentGenerations: { notes: 9 } }), undefined, "never lands in another audience");

  // `maxPreAnswersPerRun` caps investigations (0 = unlimited).
  f.advance(721 * MINUTE);
  f.setTime(START + 7 * DAY);
  const capped = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, voltaireEnabled: false,
    postmortemsEnabled: false, getCollectionGenerations: () => ({ notes: 10 }), maxPreAnswersPerRun: 1 }));
  assert.equal(capped.preAnswers.investigated, 1);
});

/* ───────────────────────────── Gating & fencing ───────────────────────────── */

test("quiet hours gate the pass, including a midnight wrap 22..6", async t => {
  assert.equal(withinQuietHours(12, undefined, undefined), true);
  assert.equal(withinQuietHours(23, 22, 6), true);
  assert.equal(withinQuietHours(0, 22, 6), true);
  assert.equal(withinQuietHours(5, 22, 6), true);
  assert.equal(withinQuietHours(6, 22, 6), false);
  assert.equal(withinQuietHours(21, 22, 6), false);
  assert.equal(withinQuietHours(2, 1, 5), true);
  assert.equal(withinQuietHours(5, 1, 5), false);
  assert.throws(() => withinQuietHours(3, 22, undefined), /must be set together/);

  const f = fixture(t);
  const { runner } = fakeRunner({});
  f.setTime(Date.parse("2026-11-25T12:00:00Z"));
  const midday = await runOvernightThinkingPass(f.options({ runner, quietHoursStartHour: 22, quietHoursEndHour: 6 }));
  assert.equal(midday.status, "outside_quiet_hours");
  assert.equal(f.workStore.get(OVERNIGHT_KIND, AGENT), undefined, "never claimed outside the window");
  f.setTime(Date.parse("2026-11-25T23:30:00Z"));
  const night = await runOvernightThinkingPass(f.options({ runner, quietHoursStartHour: 22, quietHoursEndHour: 6 }));
  assert.equal(night.status, "empty");
  f.setTime(Date.parse("2026-11-26T03:00:00Z"));
  const early = await runOvernightThinkingPass(f.options({ runner, quietHoursStartHour: 22, quietHoursEndHour: 6 }));
  assert.equal(early.status, "not_due", "inside the window, but the 12h interval still applies");
  await assert.rejects(runOvernightThinkingPass(f.options({ runner, quietHoursStartHour: 24, quietHoursEndHour: 6 })), /0\.\.23/);
});

test("a lost fence publishes nothing", async t => {
  const f = fixture(t);
  f.observe(QUESTION, "Bek loves Adidas.", 3);
  new OutcomeLedgerStore(f.workStore.db).close();
  f.workStore.db.prepare(`INSERT INTO memory_outcomes (id, agent_id, subject_kind, subject_id, verdict, confidence, evidence_turn_id,
    signals_json, measured_at) VALUES ('o1', ?, 'skill', 'skills/a/SKILL.md', 'hurt', 0.7, 'route:r', '{}', ?)`).run(AGENT, START - DAY);
  const { runner, calls } = fakeRunner({
    voltaire: () => ({ shifted: true, shiftType: "updated", confidence: "high", priorTruth: "Adidas", newTruth: "Yeezys", summary: "moved" }),
    postmortem: () => ({ rootCause: "wrong_skill", confidence: "medium", diagnosis: "d", recommendedFix: "f" }),
  });
  const probe = investigator(() => {
    // Another worker takes over mid-investigation.
    f.workStore.interruptOwner("test-owner", START);
    return { answer: "Bek only wears Yeezys." };
  });
  const result = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate,
    getCollectionGenerations: () => ({ notes: 4 }) }));
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "fence_lost");
  assert.equal(result.voltaire.shifts, 0);
  assert.equal(result.postmortems.analyzed, 0);
  assert.ok(calls.length <= 2);
  assert.deepEqual(listVoltaireShifts(f.dbPath), []);
  assert.deepEqual(listShortfallPostmortems(f.dbPath), []);
  assert.equal(new DeepThoughtStore(f.workStore.db).listDerivedObservations({ agentId: AGENT }).length, 1, "no fallback save either");
  assert.equal(new DeepThoughtStore(f.workStore.db).listDerivedObservations({ agentId: AGENT })[0]?.status, "fresh",
    "a lost fence never supersedes the prior conclusion");
});

test("caps and options are validated, with 0 meaning unlimited", async t => {
  const f = fixture(t);
  const { runner } = fakeRunner({});
  await assert.rejects(runOvernightThinkingPass(f.options({ runner, maxVoltairePerRun: -1 })), /maxVoltairePerRun/);
  await assert.rejects(runOvernightThinkingPass(f.options({ runner, intervalMinutes: 0 })), /intervalMinutes/);
  const disabled = await runOvernightThinkingPass(f.options({ runner, voltaireEnabled: false, postmortemsEnabled: false,
    preAnswerEnabled: false }));
  assert.equal(disabled.status, "disabled");
  const unlimited = await runOvernightThinkingPass(f.options({ runner, maxVoltairePerRun: 0, maxPostmortemsPerRun: 0,
    maxPreAnswersPerRun: 0, lookbackDays: 0, lookaheadMinutes: 0, timeoutMs: 0 }));
  assert.equal(unlimited.status, "empty");
});

test("Voltaire: on the Memory Crystals core_memories table, shared shifts anchor through recordCoreMemory; DMs never do", async t => {
  const f = fixture(t);
  ensureMemoryCrystalsSchema(f.workStore.db);
  f.observe(QUESTION, "Bek loves Adidas.", 3);
  f.recallQuery(QUESTION, START - 3 * DAY); // a shared channel audience
  const dmSession = "agent:main:slack:direct:u1";
  const dmAudience = deepThoughtAudienceKey({ agentId: AGENT, sessionKey: dmSession, provider: "slack", accountId: "default", senderId: "U1" })!;
  f.observe(QUESTION, "Bek loves Adidas.", 3, START - 10 * DAY, dmAudience);
  f.recallQuery(QUESTION, START - 3 * DAY, { sessionKey: dmSession, chatType: "direct" });
  const { runner } = fakeRunner({ voltaire: () => ({ shifted: true, shiftType: "updated", confidence: "high",
    priorTruth: "Bek loves Adidas.", newTruth: "Bek only wears Yeezys.", summary: "The Nov 20 notes say so." }) });
  const probe = investigator(() => ({ answer: "Bek only wears Yeezys now.",
    citations: [{ source: "qmd://source-abc123/2026-11-20.md", corpus: "notes", quote: "Bek: only Yeezys from now on" }] }));
  const result = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, postmortemsEnabled: false,
    preAnswerEnabled: false, getCollectionGenerations: () => ({ notes: 4 }), recallChatTypes: ["channel", "direct"],
    dailyLogCorpora: ["notes"] }));
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.voltaire.shifts, 2, "both audiences shifted independently");
  assert.equal(result.voltaire.anchors, 1, "only the shared audience is anchored on the audience-less table");
  const shared = listVoltaireShifts(f.dbPath, { agentId: AGENT, audienceKey: AUDIENCE })[0]!;
  const anchors = listCoreMemories(f.workStore.db, { agentId: AGENT });
  assert.deepEqual(anchors.map(({ sourceKind, targetId, corpus, sourcePath, docHash, quoteExcerpt }) =>
    ({ sourceKind, targetId, corpus, sourcePath, docHash, quoteExcerpt })), [{
    sourceKind: "voltaire_shift", targetId: shared.id, corpus: "notes", sourcePath: "qmd://source-abc123/2026-11-20.md", docHash: null,
    quoteExcerpt: "Bek: only Yeezys from now on",
  }]);
  assert.match(anchors[0]!.reason, /^Voltaire updated: Bek only wears Yeezys\. \(was: Bek loves Adidas\.\)$/u);
});

/* ───────────────────────────── v0.21.0 regressions ───────────────────────────── */

const SHIFTED: VoltaireDiff = { shifted: true, shiftType: "updated", confidence: "high", priorTruth: "Bek loves Adidas.",
  newTruth: "Bek only wears Yeezys.", summary: "The Nov 20 notes say so." };

/** Six audience/corpora combinations that shift at once; the daily-log settings decide which reach the log. */
async function dailyLogMatrix(t: TestContext, overrides: Partial<OvernightThinkingPassOptions>) {
  const f = fixture(t);
  ensureMemoryCrystalsSchema(f.workStore.db);
  const store = new DeepThoughtStore(f.workStore.db);
  const audienceOf = (sessionKey: string) =>
    deepThoughtAudienceKey({ agentId: AGENT, sessionKey, provider: "slack", accountId: "default", senderId: "U1" })!;
  const sessions = { group: "agent:main:slack:group:g0mpdm", direct: "agent:main:slack:direct:u1",
    channel: "agent:main:slack:channel:c0public" };
  const audiences = { group: audienceOf(sessions.group), direct: audienceOf(sessions.direct), channel: audienceOf(sessions.channel),
    workspace: "workspace" };
  const seed = (kind: keyof typeof audiences, corpora: string[]) => {
    store.saveDerivedObservation({ agentId: AGENT, question: QUESTION, audienceKey: audiences[kind], corpora,
      collectionGenerations: Object.fromEntries(corpora.map(corpus => [corpus, 3])), answer: "Bek loves Adidas.", confidence: "high",
      citations: [{ source: `${corpora[0]}:people/bek.md`, quote: "Adidas" }], nowMs: START - 10 * DAY });
    // The `workspace` audience is recognized by its key; every other audience by the chat types it was recalled in.
    if (kind !== "workspace") f.recallQuery(QUESTION, START - 3 * DAY, { sessionKey: sessions[kind], chatType: kind, corpora });
  };
  seed("workspace", ["knowledge"]);
  seed("group", ["memory"]);
  seed("direct", ["memory"]);
  seed("channel", ["sessions"]);
  seed("channel", ["extracted", "memory"]);
  seed("channel", ["memory"]); // the shared channel over curated corpora: eligible under the safe defaults
  const dailyLogDir = join(f.root, "workspace", "memory");
  const logged: Array<{ audience: string; corpora: string }> = [];
  const { runner } = fakeRunner({ voltaire: () => SHIFTED });
  const probe = investigator(params => ({ answer: "Bek only wears Yeezys now.",
    citations: [{ corpus: params.corpora[0]!, path: "2026-11-20.md", quote: "only Yeezys" }] }));
  const result = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, postmortemsEnabled: false,
    preAnswerEnabled: false, getCollectionGenerations: corpora => Object.fromEntries(corpora.map(corpus => [corpus, 4])), dailyLogDir,
    recallChatTypes: ["channel", "group", "direct"], maxVoltairePerRun: 0,
    appendDailyLogNote: note => {
      const kind = Object.entries(audiences).find(([, key]) => key === note.shift.audienceKey)![0];
      logged.push({ audience: kind, corpora: note.shift.citations[0]!.corpus! });
    }, ...overrides }));
  const anchors = listCoreMemories(f.workStore.db, { agentId: AGENT }).map(anchor => anchor.corpus).sort();
  return { f, result, logged: logged.map(entry => `${entry.audience}:${entry.corpora}`).sort(), anchors, dailyLogDir };
}

test("Voltaire daily log, safe defaults: group (MPDM), direct and sessions/extracted-derived shifts reach neither the log nor audience-less core_memories", async t => {
  const { result, logged, anchors, dailyLogDir } = await dailyLogMatrix(t, {});
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.voltaire.shifts, 6, "every audience still records its own shift");
  assert.deepEqual(logged, ["channel:memory", "workspace:knowledge"], "only workspace/channel over memory/knowledge reach the log");
  assert.equal(result.voltaire.dailyLogNotes, 2);
  assert.deepEqual(anchors, ["knowledge", "memory"]);
  assert.equal(readFileSync(join(dailyLogDir, "2026-11-25.md"), "utf8").match(/Voltaire Shift/gu)?.length, 2);
});

test("Voltaire daily log, explicit opt-in: listed group/direct chat types and sessions/extracted corpora are honored (nothing is hardcoded)", async t => {
  const { result, logged, anchors } = await dailyLogMatrix(t, {
    dailyLogChatTypes: ["workspace", "channel", "group", "direct"], dailyLogCorpora: ["memory", "knowledge", "sessions", "extracted"] });
  assert.equal(result.voltaire.shifts, 6);
  assert.deepEqual(logged, ["channel:extracted", "channel:memory", "channel:sessions", "direct:memory", "group:memory",
    "workspace:knowledge"]);
  assert.equal(result.voltaire.dailyLogNotes, 6);
  assert.deepEqual(anchors, ["extracted", "knowledge", "memory", "memory", "memory", "sessions"]);

  // Each list gates independently: opting in a chat type does not opt in a corpus, and vice versa.
  const groupOnly = await dailyLogMatrix(t, { dailyLogChatTypes: ["workspace", "channel", "group"] });
  assert.deepEqual(groupOnly.logged, ["channel:memory", "group:memory", "workspace:knowledge"]);
  const sessionsOnly = await dailyLogMatrix(t, { dailyLogCorpora: ["memory", "knowledge", "sessions"] });
  assert.deepEqual(sessionsOnly.logged, ["channel:memory", "channel:sessions", "workspace:knowledge"]);
  const channelOnly = await dailyLogMatrix(t, { dailyLogChatTypes: ["channel"] });
  assert.deepEqual(channelOnly.logged, ["channel:memory"], "dropping \"workspace\" opts the workspace audience out");
  const nothing = await dailyLogMatrix(t, { dailyLogChatTypes: [] });
  assert.deepEqual(nothing.logged, [], "an empty list opts every audience out");
});

test("Voltaire: an answer with ANY unverified citation (or none at all) is never saved, diffed or published", async t => {
  const f = fixture(t);
  const prior = f.observe(QUESTION, "Bek loves Adidas.", 3);
  f.recallQuery(QUESTION, START - 3 * DAY);
  const { runner, calls } = fakeRunner({ voltaire: () => SHIFTED });
  const cases: Array<[string, Partial<OvernightInvestigateResult>]> = [
    ["dropped", { unverifiedCitationsDropped: 1 }],
    ["uncited", { citations: [] }],
  ];
  for (const [label, patch] of cases) {
    const probe = investigator(() => ({ answer: "Bek only wears Yeezys now.", ...patch }));
    const result = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, postmortemsEnabled: false,
      preAnswerEnabled: false, getCollectionGenerations: () => ({ notes: 4 }), dailyLogCorpora: ["notes"], ignoreDueAt: true }));
    assert.equal(probe.calls.length, 1, label);
    assert.equal(result.voltaire.investigated, 0, label);
    assert.equal(result.voltaire.shifts, 0, label);
    assert.equal(result.savedObservations, 0, label);
    assert.ok(result.errors.includes("voltaire:unverified_citations"), `${label}: ${JSON.stringify(result.errors)}`);
  }
  assert.equal(calls.length, 0, "no diff call");
  assert.deepEqual(listVoltaireShifts(f.dbPath), []);
  assert.equal(new DeepThoughtStore(f.workStore.db).getDerivedObservation(prior.id)?.status, "fresh");
  assert.equal(new DeepThoughtStore(f.workStore.db).listDerivedObservations({ agentId: AGENT }).length, 1);
});

test("Voltaire: the new observation supersedes the prior one only inside the fenced commit", async t => {
  const f = fixture(t);
  const prior = f.observe(QUESTION, "Bek loves Adidas.", 3);
  f.recallQuery(QUESTION, START - 3 * DAY);
  const { runner } = fakeRunner({ voltaire: () => SHIFTED });
  const store = new DeepThoughtStore(f.workStore.db);
  const statuses: string[] = [];
  const probe = investigator(() => {
    statuses.push(store.getDerivedObservation(prior.id)!.status);
    return { answer: "Bek only wears Yeezys now.", collectionGenerations: { notes: 4 } };
  });
  const result = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, postmortemsEnabled: false,
    preAnswerEnabled: false, getCollectionGenerations: () => ({ notes: 5 }), dailyLogCorpora: ["notes"] }));
  assert.equal(result.voltaire.shifts, 1);
  assert.equal(result.savedObservations, 1);
  assert.deepEqual(statuses, ["fresh"]);
  assert.equal(store.getDerivedObservation(prior.id)?.status, "superseded");
  const [shift] = listVoltaireShifts(f.dbPath);
  const saved = store.getDerivedObservation(shift!.newObservationId!)!;
  assert.equal(saved.status, "fresh");
  assert.deepEqual(saved.collectionGenerations, { notes: 4 }, "the investigation's own pre-run snapshot keys the saved answer");
});

test("Voltaire: focused derived_observations are skipped, so a focus never produces a repeated false shift", async t => {
  const f = fixture(t);
  new DeepThoughtStore(f.workStore.db).saveDerivedObservation({ agentId: AGENT, question: QUESTION, focus: "running shoes only",
    audienceKey: AUDIENCE, corpora: ["notes"], collectionGenerations: { notes: 3 }, answer: "Bek runs in Asics.", confidence: "high",
    citations: [{ source: "notes:people/bek.md", quote: "Asics" }], nowMs: START - 10 * DAY });
  const { runner, calls } = fakeRunner({ voltaire: () => SHIFTED });
  const probe = investigator(() => ({ answer: "Bek only wears Yeezys now." }));
  const result = await runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate, postmortemsEnabled: false,
    preAnswerEnabled: false, getCollectionGenerations: () => ({ notes: 4 }) }));
  assert.equal(result.voltaire.candidates, 0);
  assert.equal(probe.calls.length, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(listVoltaireShifts(f.dbPath), []);
});

test("recall rows stored without a chat_type infer it from the session key (agent:<id>:main = direct; cron stays skipped)", async t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.dbPath);
  t.after(() => db.close());
  const insert = db.prepare(`INSERT INTO recall_queries (event_key, created_at_ms, agent_id, source, session_key, provider, account_id,
    sender_id, chat_type, vec_query, corpora_json, ranking_mode, outcome) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?)`);
  let seq = 0;
  for (const sessionKey of ["agent:main:main", "agent:main:cron:nightly"]) {
    for (const at of [START - 3 * DAY, START - DAY]) {
      insert.run(`legacy-${++seq}`, at, AGENT, "whisperer", sessionKey, "slack", "default", "U1", "Who owns the LMNT launch?",
        JSON.stringify(["notes"]), "decision", "emitted");
    }
  }
  const { runner } = fakeRunner({});
  const probe = investigator(() => ({ answer: "Sage owns the LMNT launch." }));
  const run = (recallChatTypes: string[]) => runOvernightThinkingPass(f.options({ runner, investigate: probe.investigate,
    postmortemsEnabled: false, preAnswerEnabled: false, getCollectionGenerations: () => ({ notes: 7 }), recallChatTypes, ignoreDueAt: true }));
  const channelOnly = await run(["channel", "group"]);
  assert.equal(channelOnly.voltaire.candidates, 0, "inferred DMs are still excluded by the default recallChatTypes");
  const withDirect = await run(["channel", "group", "direct"]);
  assert.equal(withDirect.voltaire.candidates, 1, "historical agent:main:main rows are no longer silently dropped");
  assert.equal(probe.calls.length, 1);
  assert.equal(probe.calls[0]!.audienceKey, deepThoughtAudienceKey({ agentId: AGENT, sessionKey: "agent:main:main", provider: "slack",
    accountId: "default", senderId: "U1" }), "the inferred DM keeps its own per-sender audience");
});
