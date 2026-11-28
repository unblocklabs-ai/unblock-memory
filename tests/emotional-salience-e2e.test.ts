import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Static } from "typebox";
import { openInsideOutStore } from "../src/inside-out-store.js";
import { computeBrightnessMap } from "../src/memory-brightness.js";
import { OutcomeLedgerStore, runOutcomeLedgerPass, summarizeOutcomeMetrics } from "../src/outcome-ledger.js";
import { writeRecallBatch, type RecallHitRecord, type RecallLedgerEvent } from "../src/recall-ledger.js";
import { CAPTAINS_LOG_SCHEMA, listCaptainsLogEntries, runCaptainsLogPass } from "../src/steward-captains-log.js";
import { resolveStewardConfig } from "../src/steward-config.js";
import { createStewardRunner } from "../src/steward-runner.js";
import { WorkStore } from "../src/work-store.js";
import { createAgentDatabase, insertSession } from "./helpers/session-database.js";

// One plugin database end to end: Inside Out grades (with 0..3 intensity) -> Captain's Log cues, captures and ranks them ->
// Outcome Ledger keeps the grief turn out of `hurt` -> emotion_v1 Brightness boosts and slows decay for both memories.

const MINUTE = 60_000, DAY = 86_400_000;
const START = Date.parse("2026-11-27T04:30:00Z"); // 23:30 America/New_York on 2026-11-26
const EXPOSURE = START - 10 * MINUTE;
const agentId = "main";
const human = JSON.stringify(["slack", "workspace", "sender"]);
type Completion = Static<typeof CAPTAINS_LOG_SCHEMA>;
type Prompt = { sessions: { ref: string; messages: { role: string; text: string; ref?: string; salience?: string }[] }[] };

test("joy and grief with intensity flow from Inside Out through Captain's Log, Outcome Ledger and emotion_v1 Brightness", async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "emotional-salience-e2e-"));
  const dbPath = join(root, "unblock-memory.sqlite"), workspaceDir = join(root, "workspace");
  mkdirSync(workspaceDir);
  const ledger = new OutcomeLedgerStore(dbPath);
  const workStore = new WorkStore(ledger.db);
  const transcripts = createAgentDatabase(join(root, "agent.sqlite"));
  t.after(() => { transcripts.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const db = ledger.db;

  // 1. Transcripts: a launch, a quietly stated bereavement, and routine work, each a human message with a stable id.
  const say = (sessionId: string, messageId: string, at: number, text: string) => {
    insertSession(transcripts, { sessionId, chatType: "channel" });
    const event = { type: "message", id: messageId, message: { role: "user", content: [{ type: "text", text }] } };
    transcripts.prepare("INSERT INTO transcript_events VALUES (?, 1, ?, ?)").run(sessionId, JSON.stringify(event), at);
    transcripts.prepare("INSERT INTO session_transcript_active_events VALUES (?, 0, 1, 0)").run(sessionId);
  };
  say("launch", "msg-joy", START - 20 * MINUTE, "We shipped the Atlas launch to every customer today!");
  say("loss", "msg-grief", EXPOSURE + 40, "My father passed away last night. I'll be offline this week.");
  say("routine", "msg-routine", START - 5 * MINUTE, "Bumped the lint config.");

  // 2. Inside Out grades on the real (migrated) schema: unsigned 0..3 intensity, its rubric, and stored valence.
  openInsideOutStore(dbPath).close();
  const grade = (id: string, session: string, message: string, at: number, joy: number, sadness: number, intensity: number) =>
    db.prepare(`INSERT INTO inside_out (interaction_id,rubric,session_id,message_id,assistant_id,human_key,sender_id,channel,source,
        target_at,reviewed_at,model,context_trimmed,joy,sadness,fear,anger,disgust,surprise,error,person_id,
        intensity,intensity_rubric,valence)
      VALUES (?,'v1',?,?,'assistant',?,'sender','slack','transcript',?,?,'model',0,?,?,0,0,0,0,NULL,'dana',?,'emotion-intensity-v1',?)`)
      .run(id, session, message, human, at, at + 10, joy, sadness, intensity, joy - sadness);
  // A calm personal history, so the person-relative intensity percentile (not just the absolute level) is available.
  for (const hours of [30, 20, 10]) grade(`history/${hours}`, "history", `msg-h${hours}`, START - hours * 60 * MINUTE, 0.8, 0.05, 0.5);
  grade("launch/reply", "launch", "msg-joy", START - 20 * MINUTE, 0.97, 0.02, 2.7);
  grade("loss/reply", "loss", "msg-grief", EXPOSURE + 40, 0.02, 0.97, 3);
  grade("routine/reply", "routine", "msg-routine", START - 5 * MINUTE, 0.1, 0.05, 0.2);

  // 3. Captain's Log, tuned only through the resolved steward config (no hardcoded thresholds).
  const config = resolveStewardConfig(undefined);
  const prompts: Prompt[] = [];
  const runner = createStewardRunner({ config, resolveApiKey: async () => "test-credential", fetch: async (_url, init) => {
    const prompt: Prompt = JSON.parse(JSON.parse(String(init?.body)).input[0].content);
    prompts.push(prompt);
    const ref = (text: string) => prompt.sessions.flatMap(session => session.messages).find(message => message.text.includes(text))!.ref!;
    const completion: Completion = { shouldAppend: true, entries: [
      { topic: "Lint", summary: "Bumped the lint config.", sessionRefs: ["s3"] },
      { topic: "Atlas launch", summary: "Shipped Atlas to every customer.", messageRefs: [ref("Atlas launch")] },
      { topic: "Bereavement leave", summary: "Dana is offline this week after a death in the family.", messageRefs: [ref("passed away")] },
    ] };
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(completion) }] }] });
  } });
  const cl = config.captainsLog;
  const captured = await runCaptainsLogPass({
    agentId, owner: "e2e", databasePath: join(root, "agent.sqlite"), workspaceDir, timezone: "America/New_York",
    workStore, runner, now: () => START, excludeChatTypes: cl.excludeChatTypes,
    includeEmotionalSalience: cl.includeEmotionalSalience, minSalienceScore: cl.minSalienceScore,
    minAbsoluteIntensity: cl.minAbsoluteIntensity, minRelativeIntensity: cl.minRelativeIntensity, baselineMinInteractions: 3,
  });
  assert.equal(captured.status, "appended");
  const cues = Object.fromEntries(prompts[0]!.sessions.flatMap(session => session.messages).map(message => [message.text, message.salience]));
  assert.equal(cues["We shipped the Atlas launch to every customer today!"], "high — joy/milestone");
  assert.equal(cues["My father passed away last night. I'll be offline this week."], "high — sadness/setback");
  assert.equal(cues["Bumped the lint config."], undefined, "a routine grade carries no cue");

  const entries = listCaptainsLogEntries(db, { agentId });
  assert.deepEqual(entries.map(entry => entry.topic), ["Bereavement leave", "Atlas launch", "Lint"],
    "grief and joy rank ahead of routine work, strongest first");
  const [grief, joy, routine] = entries;
  assert.deepEqual([grief!.emotionalIntensity, grief!.salienceScore, grief!.relativeSalience], [3, 1, 1]);
  assert.equal(joy!.emotionalIntensity, 2.7);
  assert.equal(joy!.relativeSalience, 1, "relative salience is the person's own intensity percentile");
  assert.ok(Math.abs(joy!.salienceScore! - (0.4 * 0.9 + 0.6)) < 1e-9, "absolute 2.7/3 blended with the upper tail");
  assert.equal(routine!.salienceScore, undefined);
  const daily = readFileSync(join(workspaceDir, "memory", "2026-11-26.md"), "utf8");
  assert.doesNotMatch(daily, /salience|intensity|valence|sadness|joy\/|\b[0-3]\.\d/iu, "no emotion analytics reach Markdown");

  // 4. Outcome Ledger: memories recalled and read in the grief session. The grief reply is a sharp valence drop with
  // intensity 3, which is the human's own emotion and never blames the recalled memories.
  const dailyPath = "qmd://memory/2026-11-26.md";
  const joyPath = "qmd://sessions/slack/channel/workspace/C1/2026-11-27T04-10-00Z--launch.md";
  const mundanePath = "qmd://memory/guide.md";
  const hit = (sourcePath: string, rank: number): RecallHitRecord => ({ sourcePath, corpus: "memory", rawLeafId: `${sourcePath}:5`,
    passageId: `${sourcePath}:5`, startLine: 5, endLine: 7, observedAtBasis: "unknown", retrievalRank: rank, disposition: "emitted" });
  const read = (sourcePath: string): RecallLedgerEvent => ({ kind: "read", record: { agentId, eventKey: `grief/${sourcePath}`,
    sessionId: "loss", runId: "grief", readAtMs: EXPOSURE + 5, sourcePath, startLine: 5, lineCount: 2, status: "ok" } });
  writeRecallBatch(dbPath, [
    { kind: "query", record: { agentId, eventKey: "grief", sessionId: "loss", runId: "grief", createdAtMs: EXPOSURE, source: "whisperer",
      provider: "slack", accountId: "workspace", senderId: "sender", queryFallback: false, corpora: ["memory"],
      rankingMode: "decision", outcome: "emitted", hits: [hit(dailyPath, 1), hit(joyPath, 2), hit(mundanePath, 3)] } },
    read(dailyPath), read(joyPath), read(mundanePath),
  ]);
  const scoredAt = EXPOSURE + 1_000;
  assert.equal((await runOutcomeLedgerPass({ agentId, owner: "e2e", workStore, intervalMinutes: 1, lookbackMs: 5 * DAY,
    matchWindowMs: 100, leaseMs: 500, heartbeatMs: 100, baselineMinInteractions: 3, now: () => scoredAt })).status, "ok");
  const outcomes = db.prepare("SELECT subject_id, verdict, signals_json FROM memory_outcomes ORDER BY subject_id").all();
  assert.equal(outcomes.length, 3);
  for (const row of outcomes) {
    const signals = JSON.parse(String(row.signals_json));
    assert.equal(row.verdict, "helped", `${String(row.subject_id)} was read; grief never turns it into hurt`);
    assert.equal(signals.sharpDrop, true);
    assert.equal(signals.insideOutIntensity, 3);
    assert.equal(signals.negative, false);
  }
  assert.deepEqual(summarizeOutcomeMetrics(db, { agentId }).byVerdict, { helped: 3, ignored: 0, hurt: 0 });
  assert.equal(summarizeOutcomeMetrics(db, { agentId }).shortfallsPer100Turns, 0);

  // 5. emotion_v1 Brightness over those real outcomes: the Captain's Log day (grief) and the launch session (joy) get a
  // bounded boost and decay more slowly than the mundane memory, which scores exactly as outcome_v1.
  const subjects = [dailyPath, joyPath, mundanePath];
  const brightness = (recipe: "outcome_v1" | "emotion_v1", nowMs: number) => computeBrightnessMap(db as DatabaseSync, { agentId, recipe, subjects, nowMs });
  const now = START, later = START + 60 * DAY;
  const [emotionNow, emotionLater] = [brightness("emotion_v1", now), brightness("emotion_v1", later)];
  const [outcomeNow, outcomeLater] = [brightness("outcome_v1", now), brightness("outcome_v1", later)];
  assert.equal(emotionNow.get(mundanePath)!.score, outcomeNow.get(mundanePath)!.score, "no salience, no change");
  assert.equal(emotionLater.get(mundanePath)!.score, outcomeLater.get(mundanePath)!.score);
  const retained = (map: typeof emotionNow, from: typeof emotionNow, path: string) => map.get(path)!.score / from.get(path)!.score;
  for (const path of [dailyPath, joyPath]) {
    assert.ok(emotionNow.get(path)!.score > outcomeNow.get(path)!.score, `${path} is boosted`);
    assert.ok(emotionLater.get(path)!.score > outcomeLater.get(path)!.score, `${path} stays brighter after 60 days`);
    assert.ok(retained(emotionLater, emotionNow, path) > retained(emotionLater, emotionNow, mundanePath), `${path} decays more slowly`);
    assert.ok(emotionLater.get(path)!.normalized > emotionLater.get(mundanePath)!.normalized);
  }
});
