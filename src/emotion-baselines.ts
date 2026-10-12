import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

export const INSIDE_OUT_EMOTIONS = ["joy", "sadness", "fear", "anger", "disgust", "surprise"] as const;
type Emotion = typeof INSIDE_OUT_EMOTIONS[number];
type Row = Record<string, SQLOutputValue>;
const WEEK = 7 * 86400_000;
const MONDAY = Date.UTC(1970, 0, 5);
const VERSION = "personal-deviation-v1";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const weekStart = (time: number) => MONDAY + Math.floor((time - MONDAY) / WEEK) * WEEK;
const tableExists = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));

type Statistics = { count: number; mean: number | null; min: number | null; p10: number | null;
  median: number | null; p90: number | null; max: number | null; distribution: [number, number][] };
type Summary = Record<Emotion, Statistics>;
type Deviation = { delta: number; percentile: number; unusualness: number };
type Comparison = { status: "ok" | "insufficient_history"; count: number; emotions: Record<Emotion, Deviation> | null };
type PersonalDeviation = { version: string; status: "ok" | "insufficient_history" | "unlinked_person" | "missing_time" | "future_time" | "grade_failed";
  personId: string | null; baselineId: string | null; baselineEnd: number | null; assessedAt: number;
  minInteractions: number; cumulative: Comparison | null; weekly: Comparison | null };

/** Separate analytics tables: never dossier fields or prompt-injection state. */
function initializeEmotionBaselines(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS person_emotion_baselines (
    id TEXT PRIMARY KEY, person_id TEXT NOT NULL, rubric TEXT NOT NULL, model TEXT NOT NULL,
    version TEXT NOT NULL, week_start INTEGER NOT NULL, week_end INTEGER NOT NULL, computed_at INTEGER NOT NULL,
    weekly_json TEXT NOT NULL, cumulative_json TEXT NOT NULL, is_current INTEGER NOT NULL CHECK(is_current IN (0,1))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS person_emotion_baselines_period
    ON person_emotion_baselines(person_id,rubric,model,week_end,computed_at);
  CREATE TABLE IF NOT EXISTS inside_out_deviations (
    id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL, rubric TEXT NOT NULL, grade_signature TEXT NOT NULL,
    assessed_at INTEGER NOT NULL, baseline_id TEXT REFERENCES person_emotion_baselines(id), result_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS inside_out_deviations_interaction ON inside_out_deviations(interaction_id,rubric);
  INSERT OR IGNORE INTO memory_schema VALUES ('emotion-baselines',1);`);
}

function gradeSignature(row: Row) {
  return hash([row.interaction_id, row.rubric, row.model, row.person_id ?? null, row.target_at,
    row.reviewed_at, row.error, ...INSIDE_OUT_EMOTIONS.map(e => row[e])]);
}

function summarize(histograms: Record<Emotion, Map<number, number>>): Summary {
  const statistics = (histogram: Map<number, number>): Statistics => {
    const distribution = [...histogram].sort((a, b) => a[0] - b[0]);
    const count = distribution.reduce((n, [, frequency]) => n + frequency, 0);
    const at = (rank: number) => {
      let seen = 0;
      for (const [value, frequency] of distribution) { seen += frequency; if (rank < seen) return value; }
      return distribution.at(-1)![0];
    };
    const quantile = (p: number) => {
      if (!count) return null;
      const position = (count - 1) * p, lower = Math.floor(position);
      return at(lower) + (at(Math.ceil(position)) - at(lower)) * (position - lower);
    };
    return { count, mean: count ? distribution.reduce((sum, [value, n]) => sum + value * n, 0) / count : null,
      min: distribution[0]?.[0] ?? null, p10: quantile(0.1), median: quantile(0.5), p90: quantile(0.9),
      max: distribution.at(-1)?.[0] ?? null, distribution };
  };
  return { joy: statistics(histograms.joy), sadness: statistics(histograms.sadness), fear: statistics(histograms.fear),
    anger: statistics(histograms.anger), disgust: statistics(histograms.disgust), surprise: statistics(histograms.surprise) };
}

function histograms(): Record<Emotion, Map<number, number>> {
  return { joy: new Map(), sadness: new Map(), fear: new Map(), anger: new Map(), disgust: new Map(), surprise: new Map() };
}

function compare(row: Row, summary: Summary, minimum: number, ranks: WeakMap<Statistics, number[]>): Comparison {
  const count = summary.joy.count;
  if (count < minimum) return { status: "insufficient_history", count, emotions: null };
  const deviation = (emotion: Emotion): Deviation => {
    const score = Number(row[emotion]), stats = summary[emotion];
    let prefix = ranks.get(stats);
    if (!prefix) {
      prefix = [0];
      for (const [, n] of stats.distribution) prefix.push(prefix.at(-1)! + n);
      ranks.set(stats, prefix);
    }
    let left = 0, right = stats.distribution.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (stats.distribution[middle]![0] < score) left = middle + 1;
      else right = middle;
    }
    const lower = prefix[left]!, equal = stats.distribution[left]?.[0] === score ? stats.distribution[left]![1] : 0;
    // Midrank keeps a tied, constant baseline at 0.5 rather than treating every tie as extreme.
    const percentile = (lower + equal / 2) / count;
    return { delta: score - stats.mean!, percentile, unusualness: Math.abs(2 * percentile - 1) };
  };
  return { status: "ok", count, emotions: { joy: deviation("joy"), sadness: deviation("sadness"), fear: deviation("fear"),
    anger: deviation("anger"), disgust: deviation("disgust"), surprise: deviation("surprise") } };
}

/** Immutable, content-addressed revisions; no inference and no modifications to raw grades. */
export function refreshEmotionBaselines(db: DatabaseSync, options: { minInteractions: number; now?: number; recompare?: boolean }) {
  const now = options.now ?? Date.now(), cutoff = weekStart(now);
  if (!Number.isFinite(now) || !Number.isInteger(options.minInteractions) || options.minInteractions < 1) throw new Error("Invalid baseline settings");
  initializeEmotionBaselines(db);
  let snapshots = 0, comparisons = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const currentIds = new Set<string>();
    const existingIds = new Set(db.prepare("SELECT id FROM person_emotion_baselines").all().map(row => String(row.id)));
    if (tableExists(db, "people")) {
      const groups = new Map<string, Row[]>();
      for (const row of db.prepare(`SELECT e.* FROM inside_out e JOIN people p ON p.id=e.person_id
        WHERE e.error IS NULL AND e.target_at IS NOT NULL AND e.target_at<? AND e.reviewed_at<=?
        AND ${INSIDE_OUT_EMOTIONS.map(e => `e.${e} BETWEEN 0 AND 1`).join(" AND ")}
        ORDER BY e.person_id,e.rubric,e.model,e.target_at,e.interaction_id`).iterate(cutoff, now)) {
        const key = JSON.stringify([row.person_id, row.rubric, row.model]);
        const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
      }
      const insert = db.prepare("INSERT OR IGNORE INTO person_emotion_baselines VALUES (?,?,?,?,?,?,?,?,?,?,1)");
      for (const rows of groups.values()) {
        const first = rows[0]!, cumulative = histograms(), signatures: string[] = [];
        let index = 0;
        // Keep weekly logs even during inactivity; the weekly comparison always means
        // the immediately preceding week, never the last week with observations.
        for (let start = weekStart(Number(first.target_at)); start < cutoff; start += WEEK) {
          const weekly = histograms(), end = start + WEEK;
          while (index < rows.length && Number(rows[index]!.target_at) < end) {
            const row = rows[index++]!;
            signatures.push(gradeSignature(row));
            for (const emotion of INSIDE_OUT_EMOTIONS) {
              const value = Number(row[emotion]);
              cumulative[emotion].set(value, (cumulative[emotion].get(value) ?? 0) + 1);
              if (Number(row.target_at) >= start) weekly[emotion].set(value, (weekly[emotion].get(value) ?? 0) + 1);
            }
          }
          const id = hash([VERSION, first.person_id, first.rubric, first.model, start, signatures]);
          currentIds.add(id);
          if (existingIds.has(id)) continue;
          snapshots += Number(insert.run(id, first.person_id, first.rubric, first.model, VERSION, start, end, now,
            JSON.stringify(summarize(weekly)), JSON.stringify(summarize(cumulative))).changes);
        }
      }
    }
    // Preserve historical values while selecting only revisions matching the current linked grades.
    const current = db.prepare("UPDATE person_emotion_baselines SET is_current=? WHERE id=?");
    for (const row of db.prepare("SELECT id,is_current FROM person_emotion_baselines").iterate()) {
      const active = Number(currentIds.has(String(row.id)));
      if (row.is_current !== active) current.run(active, row.id);
    }
    const prior = db.prepare(`SELECT id,result_json FROM inside_out_deviations WHERE interaction_id=? AND rubric=? AND grade_signature=?
      ORDER BY assessed_at DESC,rowid DESC LIMIT 1`);
    const baseline = db.prepare(`SELECT id,week_end,weekly_json,cumulative_json FROM person_emotion_baselines WHERE person_id=? AND rubric=? AND model=? AND week_end<=?
      AND is_current=1 AND computed_at<=?
      ORDER BY week_end DESC,computed_at DESC,rowid DESC LIMIT 1`);
    const save = db.prepare("INSERT OR IGNORE INTO inside_out_deviations VALUES (?,?,?,?,?,?,?)");
    const linked = tableExists(db, "people") ? db.prepare("SELECT 1 FROM people WHERE id=?") : undefined;
    // Rows are chronological: retain only the latest queried week per population.
    // Parse each snapshot once and build frequency prefixes once, not per grade.
    const cached = new Map<string, { week: number; snapshot?: { id: string; end: number; cumulative: Summary; weekly: Summary } }>();
    const ranks = new WeakMap<Statistics, number[]>();
    for (const row of db.prepare("SELECT * FROM inside_out WHERE reviewed_at<=? ORDER BY target_at,interaction_id,rubric").iterate(now)) {
      const signature = gradeSignature(row);
      const previous = prior.get(row.interaction_id, row.rubric, signature);
      if (!options.recompare && previous) continue;
      const result: PersonalDeviation = { version: VERSION, status: "insufficient_history", personId: row.person_id === null ? null : String(row.person_id),
        baselineId: null, baselineEnd: null, assessedAt: now, minInteractions: options.minInteractions, cumulative: null, weekly: null };
      if (row.error !== null || !INSIDE_OUT_EMOTIONS.every(e => typeof row[e] === "number" && Number.isFinite(row[e]) && row[e] >= 0 && row[e] <= 1)) result.status = "grade_failed";
      else if (!row.person_id || !linked?.get(row.person_id)) result.status = "unlinked_person";
      else if (row.target_at === null) result.status = "missing_time";
      else if (Number(row.target_at) > now) result.status = "future_time";
      else {
        const key = JSON.stringify([row.person_id, row.rubric, row.model]), week = weekStart(Number(row.target_at));
        let entry = cached.get(key);
        if (!entry || entry.week !== week) {
          const record = baseline.get(row.person_id, row.rubric, row.model, week, now);
          entry = { week, snapshot: record ? { id: String(record.id), end: Number(record.week_end),
            cumulative: JSON.parse(String(record.cumulative_json)), weekly: JSON.parse(String(record.weekly_json)) } : undefined };
          cached.set(key, entry);
        }
        const snapshot = entry.snapshot;
        if (snapshot) {
          result.baselineId = snapshot.id; result.baselineEnd = snapshot.end;
          result.cumulative = compare(row, snapshot.cumulative, options.minInteractions, ranks);
          result.weekly = compare(row, snapshot.weekly, options.minInteractions, ranks);
          result.status = result.cumulative.status;
        }
      }
      const key = (assessment: PersonalDeviation) => hash([assessment.version, signature, assessment.baselineId, assessment.status, assessment.minInteractions]);
      if (previous && key(JSON.parse(String(previous.result_json))) === key(result)) continue;
      // Chaining records permits an explicit return to an earlier baseline without
      // selecting an obsolete intervening assessment or losing either observation.
      const id = hash([key(result), previous?.id ?? null]);
      comparisons += Number(save.run(id, row.interaction_id, row.rubric, signature, now, result.baselineId, JSON.stringify(result)).changes);
    }
    db.exec("COMMIT");
    return { snapshots, comparisons };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function personalDeviation(db: DatabaseSync, row: Row, history = false) {
  if (!tableExists(db, "inside_out_deviations")) return { status: "not_compared" };
  const entries = db.prepare(`SELECT grade_signature,result_json FROM inside_out_deviations
    WHERE interaction_id=? AND rubric=? ORDER BY assessed_at DESC,rowid DESC`).all(row.interaction_id, row.rubric);
  const signature = gradeSignature(row), latest = entries.find(entry => entry.grade_signature === signature);
  const current: PersonalDeviation | { status: "not_compared" } = latest ? JSON.parse(String(latest.result_json)) : { status: "not_compared" };
  return history ? { ...current, history: entries.map(entry => {
    const result: PersonalDeviation = JSON.parse(String(entry.result_json));
    return { ...result, currentGrade: entry.grade_signature === signature };
  }) } : current;
}

export function emotionBaselineHistory(db: DatabaseSync, options: { personId?: string; since?: number; limit?: number } = {}) {
  if (!tableExists(db, "person_emotion_baselines")) return [];
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Baseline limit must be between 1 and 1000");
  return db.prepare(`SELECT * FROM person_emotion_baselines WHERE (? IS NULL OR person_id=?) AND (? IS NULL OR week_end>=?)
    ORDER BY week_end DESC,computed_at DESC,rowid DESC LIMIT ?`).all(options.personId ?? null, options.personId ?? null,
      options.since ?? null, options.since ?? null, limit).map(row => {
      const weekly: Summary = JSON.parse(String(row.weekly_json)), cumulative: Summary = JSON.parse(String(row.cumulative_json));
      return { id: String(row.id), person_id: String(row.person_id), rubric: String(row.rubric), model: String(row.model),
        version: String(row.version), week_start: Number(row.week_start), week_end: Number(row.week_end),
        computed_at: Number(row.computed_at), is_current: Number(row.is_current), weekly, cumulative };
    });
}
