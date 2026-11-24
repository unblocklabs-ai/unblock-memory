import { createHash, type Hash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { immediateTransaction, tableExists } from "./memory-database.js";
import { jsonHash } from "./json-hash.js";

export const INSIDE_OUT_EMOTIONS = ["joy", "sadness", "fear", "anger", "disgust", "surprise"] as const;
/** Erased by an operator purge: never retried, linked, aggregated or compared. */
export const PURGED_GRADE = "Purged by operator";
type Emotion = typeof INSIDE_OUT_EMOTIONS[number];
/** Builds a per-emotion record in canonical emotion order, so serialized key order is stable. */
const perEmotion = <T>(f: (emotion: Emotion) => T) =>
  Object.fromEntries(INSIDE_OUT_EMOTIONS.map(emotion => [emotion, f(emotion)])) as Record<Emotion, T>;
type Row = Record<string, SQLOutputValue>;
const WEEK = 7 * 86400_000;
const MONDAY = Date.UTC(1970, 0, 5);
const VERSION = "personal-deviation-v2";
// 0.01-wide bins bound each stored distribution to 101 values per emotion, however long the history.
const STEPS = 100;
// Writers on the shared store wait for at most one short batch, never a whole refresh.
const BATCH = 500;
const PAGE = 2000;
const weekStart = (time: number) => MONDAY + Math.floor((time - MONDAY) / WEEK) * WEEK;
const bin = (value: number) => Math.round(value * STEPS);
const GRADE = `interaction_id,rubric,model,person_id,target_at,reviewed_at,error,${INSIDE_OUT_EMOTIONS.join(",")}`;
const VALID = INSIDE_OUT_EMOTIONS.map(e => `e.${e} BETWEEN 0 AND 1`).join(" AND ");
// Comparable grades: successful, timed, not after `now`. Callers add the People join.
const COMPARABLE = `e.reviewed_at<=? AND e.error IS NULL AND e.target_at IS NOT NULL AND e.target_at<=? AND ${VALID}`;

type Histogram = { count: number; sum: number; carry: number; min: number; max: number; bins: number[] };
type Histograms = Record<Emotion, Histogram>;
type Statistics = { count: number; mean: number | null; min: number | null; p10: number | null;
  median: number | null; p90: number | null; max: number | null; distribution: [number, number][] };
type Summary = Record<Emotion, Statistics>;
type Ranks = Record<Emotion, { count: number; mean: number; prefix: number[] }>;
type Deviation = { delta: number; percentile: number; unusualness: number };
type Comparison = { status: "ok" | "insufficient_history"; count: number; emotions: Record<Emotion, Deviation> | null };
type PersonalDeviation = { version: string; status: "ok" | "insufficient_history" | "unlinked_person" | "missing_time" | "future_time" | "grade_failed";
  personId: string | null; baselineId: string | null; baselineEnd: number | null; assessedAt: number;
  minInteractions: number; cumulative: Comparison | null; weekly: Comparison | null };

function schemaVersion(db: DatabaseSync) {
  if (!tableExists(db, "memory_schema")) return undefined;
  const version = db.prepare("SELECT version FROM memory_schema WHERE component='emotion-baselines'").get()?.version;
  return version === undefined ? undefined : Number(version);
}

/** Separate analytics tables: never dossier fields or prompt-injection state. */
function initializeEmotionBaselines(db: DatabaseSync) {
  if (schemaVersion(db) === 2 && tableExists(db, "inside_out_person_generations")) return;
  immediateTransaction(db, () => {
    const version = schemaVersion(db);
    if (version !== undefined && version !== 1 && version !== 2) throw new Error("Unsupported Inside Out baseline storage version");
    // Unreleased v1 kept every raw-value revision. Both tables are derived and rebuild from grades.
    if (version === 1) db.exec("DROP TABLE IF EXISTS inside_out_deviations; DROP TABLE IF EXISTS person_emotion_baselines;");
    db.exec(`CREATE TABLE IF NOT EXISTS person_emotion_baselines (
      person_id TEXT NOT NULL, rubric TEXT NOT NULL, model TEXT NOT NULL, week_start INTEGER NOT NULL,
      id TEXT NOT NULL, version TEXT NOT NULL, week_end INTEGER NOT NULL, computed_at INTEGER NOT NULL, weekly_json TEXT NOT NULL,
      PRIMARY KEY(person_id,rubric,model,week_start)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS inside_out_deviations (
      id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL, rubric TEXT NOT NULL, grade_signature TEXT NOT NULL,
      assessed_at INTEGER NOT NULL, baseline_id TEXT, person_id TEXT, result_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS inside_out_person_generations (
      person_id TEXT PRIMARY KEY, generation INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS inside_out_deviations_interaction ON inside_out_deviations(interaction_id,rubric);
    CREATE INDEX IF NOT EXISTS inside_out_deviations_person ON inside_out_deviations(person_id);
    INSERT OR REPLACE INTO memory_schema VALUES ('emotion-baselines',2);`);
  });
}

function gradeSignature(row: Row) {
  return jsonHash([row.interaction_id, row.rubric, row.model, row.person_id ?? null, row.target_at,
    row.reviewed_at, row.error, ...INSIDE_OUT_EMOTIONS.map(e => row[e])]);
}

function histograms(): Histograms {
  const empty = (): Histogram => ({ count: 0, sum: 0, carry: 0, min: Infinity, max: -Infinity, bins: new Array<number>(STEPS + 1).fill(0) });
  return perEmotion(empty);
}

// Neumaier summation keeps means exact for repeated values: twenty 0.8s average to 0.8.
function accumulate(target: Histogram, value: number, count: number, min: number, max: number) {
  const total = target.sum + value;
  target.carry += Math.abs(target.sum) >= Math.abs(value) ? target.sum - total + value : value - total + target.sum;
  target.sum = total; target.count += count;
  target.min = Math.min(target.min, min); target.max = Math.max(target.max, max);
}

function add(target: Histograms, row: Row) {
  for (const emotion of INSIDE_OUT_EMOTIONS) {
    const value = Number(row[emotion]);
    accumulate(target[emotion], value, 1, value, value);
    target[emotion].bins[bin(value)]!++;
  }
}

function merge(target: Histograms, source: Histograms) {
  for (const emotion of INSIDE_OUT_EMOTIONS) {
    const from = source[emotion], to = target[emotion];
    accumulate(to, from.sum + from.carry, from.count, from.min, from.max);
    from.bins.forEach((n, i) => { to.bins[i]! += n; });
  }
}

const distribution = (histogram: Histogram) => histogram.bins.flatMap((n, i): [number, number][] => n ? [[i / STEPS, n]] : []);

/** Stored form: exact count, sum, min and max with sparse bins, so quiet weeks stay tiny. */
function encode(week: Histograms) {
  return JSON.stringify(Object.fromEntries(INSIDE_OUT_EMOTIONS.map(emotion => {
    const h = week[emotion];
    return [emotion, { count: h.count, sum: h.sum + h.carry, min: h.count ? h.min : null, max: h.count ? h.max : null, bins: distribution(h) }];
  })));
}

function decode(json: string): Histograms {
  const stored = JSON.parse(json) as Record<Emotion, { count: number; sum: number; min: number | null; max: number | null; bins: [number, number][] }>;
  const week = histograms();
  for (const emotion of INSIDE_OUT_EMOTIONS) {
    const s = stored[emotion], h = week[emotion];
    Object.assign(h, { count: s.count, sum: s.sum, min: s.min ?? Infinity, max: s.max ?? -Infinity });
    for (const [value, n] of s.bins) h.bins[bin(value)] = n;
  }
  return week;
}

function summarize(week: Histograms): Summary {
  const statistics = (h: Histogram): Statistics => {
    const values = distribution(h);
    const at = (rank: number) => {
      let seen = 0;
      for (const [value, frequency] of values) { seen += frequency; if (rank < seen) return value; }
      return values.at(-1)![0];
    };
    // Bin centres can sit just outside the exact extremes; quantiles never do.
    const quantile = (p: number) => {
      if (!h.count) return null;
      const position = (h.count - 1) * p, lower = Math.floor(position);
      return Math.min(h.max, Math.max(h.min, at(lower) + (at(Math.ceil(position)) - at(lower)) * (position - lower)));
    };
    return { count: h.count, mean: h.count ? (h.sum + h.carry) / h.count : null, min: h.count ? h.min : null,
      p10: quantile(0.1), median: quantile(0.5), p90: quantile(0.9), max: h.count ? h.max : null, distribution: values };
  };
  return perEmotion(emotion => statistics(week[emotion]));
}

/** Freeze a population's rank prefixes before later grades join it. */
function ranks(population: Histograms): Ranks {
  const freeze = (h: Histogram) => {
    const prefix = [0];
    for (const n of h.bins) prefix.push(prefix.at(-1)! + n);
    return { count: h.count, mean: (h.sum + h.carry) / h.count, prefix };
  };
  return perEmotion(emotion => freeze(population[emotion]));
}

function compare(row: Row, population: Ranks, minimum: number): Comparison {
  const count = population.joy.count;
  if (count < minimum) return { status: "insufficient_history", count, emotions: null };
  const deviation = (emotion: Emotion): Deviation => {
    const score = Number(row[emotion]), { mean, prefix } = population[emotion], b = bin(score);
    // Midrank keeps a tied, constant baseline at 0.5 rather than treating every tie as extreme.
    const percentile = (prefix[b]! + (prefix[b + 1]! - prefix[b]!) / 2) / count;
    return { delta: score - mean, percentile, unusualness: Math.abs(2 * percentile - 1) };
  };
  return { status: "ok", count, emotions: perEmotion(deviation) };
}

type PopulationDigests = { totalRows: number; checkpoints: { end: number; digest: string }[] };
type BatchTx = { populationDigests: Map<string, PopulationDigests>; personGenerations: Map<string, number> };
type BatchFence = (tx: BatchTx) => boolean;
type BatchWrite = (tx: BatchTx) => void;
type BatchQueue = ReturnType<typeof batches>;
type GradeAssessor = ReturnType<typeof createGradeAssessor>;
type PreparedStatement = ReturnType<DatabaseSync["prepare"]>;

const EMPTY_POPULATION_DIGEST = createHash("sha256").digest("hex");

function readSnapshot<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Queue writes and commit them in short IMMEDIATE transactions. Only call between completed reads. */
function batches(db: DatabaseSync) {
  const pending: BatchWrite[] = [];
  const flush = () => {
    if (!pending.length) return;
    const tx: BatchTx = { populationDigests: new Map(), personGenerations: new Map() };
    immediateTransaction(db, () => { for (const write of pending) write(tx); });
    pending.length = 0;
  };
  return { write(change: BatchWrite) { pending.push(change); if (pending.length >= BATCH) flush(); }, flush };
}

function loadPersonGenerations(db: DatabaseSync): Map<string, number> {
  const generations = new Map<string, number>();
  for (const row of db.prepare("SELECT person_id,generation FROM inside_out_person_generations").iterate()) {
    generations.set(String(row.person_id), Number(row.generation));
  }
  return generations;
}

function getPersonGeneration(tx: BatchTx, readGeneration: PreparedStatement, personId: string): number {
  let cached = tx.personGenerations.get(personId);
  if (cached === undefined) {
    const row = readGeneration.get(personId);
    cached = row === undefined ? 0 : Number(row.generation);
    tx.personGenerations.set(personId, cached);
  }
  return cached;
}

function loadPopulationDigests(
  db: DatabaseSync,
  person: SQLOutputValue,
  rubric: SQLOutputValue,
  model: SQLOutputValue,
  now: number,
): PopulationDigests {
  if (!tableExists(db, "people")) return { totalRows: 0, checkpoints: [] };
  const rows = db.prepare(`SELECT ${GRADE} FROM inside_out e JOIN people p ON p.id=e.person_id
    WHERE e.person_id=? AND e.rubric=? AND e.model=? AND ${COMPARABLE}
    ORDER BY e.target_at,e.interaction_id`).iterate(person, rubric, model, now, now);
  const digest = createHash("sha256");
  const checkpoints: { end: number; digest: string }[] = [];
  let totalRows = 0;
  let currentEnd: number | undefined;
  for (const row of rows) {
    const rowEnd = weekStart(Number(row.target_at)) + WEEK;
    if (currentEnd !== undefined && rowEnd !== currentEnd) {
      checkpoints.push({ end: currentEnd, digest: digest.copy().digest("hex") });
    }
    currentEnd = rowEnd;
    digest.update(`|${gradeSignature(row)}`);
    totalRows++;
  }
  if (currentEnd !== undefined) {
    checkpoints.push({ end: currentEnd, digest: digest.digest("hex") });
  }
  return { totalRows, checkpoints };
}

function getPopulationDigests(
  tx: BatchTx,
  db: DatabaseSync,
  person: SQLOutputValue,
  rubric: SQLOutputValue,
  model: SQLOutputValue,
  now: number,
): PopulationDigests {
  const key = JSON.stringify([person, rubric, model]);
  let cached = tx.populationDigests.get(key);
  if (!cached) {
    cached = loadPopulationDigests(db, person, rubric, model, now);
    tx.populationDigests.set(key, cached);
  }
  return cached;
}

function populationPrefixDigest(
  tx: BatchTx,
  db: DatabaseSync,
  person: SQLOutputValue,
  rubric: SQLOutputValue,
  model: SQLOutputValue,
  now: number,
  end: number,
): string | null {
  const cached = getPopulationDigests(tx, db, person, rubric, model, now);
  if (cached.totalRows === 0) return end === Infinity ? EMPTY_POPULATION_DIGEST : null;
  let match: string | null = null;
  for (const checkpoint of cached.checkpoints) {
    if (checkpoint.end <= end) match = checkpoint.digest;
    else break;
  }
  return match;
}

function createGradeAssessor(
  db: DatabaseSync,
  queue: BatchQueue,
  options: { now: number; minimum: number; recompare?: boolean },
  personGenerationMatches: (tx: BatchTx, personId: string) => boolean,
  onComparison: (changes: number) => void,
) {
  const { now, minimum, recompare } = options;
  const prior = db.prepare(`SELECT id,result_json,json_extract(result_json,'$.status') status FROM inside_out_deviations
    WHERE interaction_id=? AND rubric=? AND grade_signature=? ORDER BY assessed_at DESC,rowid DESC LIMIT 1`);
  const save = db.prepare("INSERT OR IGNORE INTO inside_out_deviations VALUES (?,?,?,?,?,?,?,?)");
  const grade = db.prepare(`SELECT ${GRADE} FROM inside_out WHERE interaction_id=? AND rubric=?`);
  return (row: Row, signature: string, decide: (result: PersonalDeviation) => void, fence?: BatchFence) => {
    const previous = prior.get(row.interaction_id, row.rubric, signature);
    // An existing assessment stands for its grade, except future_time: that only described the clock.
    if (!recompare && previous && previous.status !== "future_time") return;
    const personId = row.person_id === null ? null : String(row.person_id);
    const result: PersonalDeviation = { version: VERSION, status: "insufficient_history", personId,
      baselineId: null, baselineEnd: null, assessedAt: now, minInteractions: minimum, cumulative: null, weekly: null };
    decide(result);
    const key = (assessment: PersonalDeviation) => jsonHash([assessment.version, signature, assessment.baselineId, assessment.status, assessment.minInteractions]);
    if (previous && key(JSON.parse(String(previous.result_json))) === key(result)) return;
    // Chaining records permits an explicit return to an earlier baseline without
    // selecting an obsolete intervening assessment or losing either observation.
    const id = jsonHash([key(result), previous?.id ?? null]);
    queue.write(tx => {
      // Rechecked under the write lock: a purge, regrade, relink, or population-prefix change wins.
      if (personId !== null && !personGenerationMatches(tx, personId)) return;
      if (fence && !fence(tx)) return;
      const current = grade.get(row.interaction_id, row.rubric);
      if (!current || gradeSignature(current) !== signature) return;
      onComparison(Number(save.run(id, row.interaction_id, row.rubric, signature, now, result.baselineId, result.personId, JSON.stringify(result)).changes));
    });
  };
}

function* iterateComparableGrades(
  page: PreparedStatement,
  person: SQLOutputValue,
  rubric: SQLOutputValue,
  model: SQLOutputValue,
  now: number,
) {
  let last: Row | undefined;
  for (;;) {
    const batch = page.all(person, rubric, model, now, now, last?.target_at ?? null, last?.target_at ?? null,
      last?.target_at ?? null, last?.interaction_id ?? null, PAGE);
    yield* batch;
    if (batch.length < PAGE) return;
    last = batch.at(-1);
  }
}

function refreshPopulation(
  db: DatabaseSync,
  queue: BatchQueue,
  assess: GradeAssessor,
  statements: { stored: PreparedStatement; upsert: PreparedStatement; remove: PreparedStatement; page: PreparedStatement },
  group: { person: SQLOutputValue; rubric: SQLOutputValue; model: SQLOutputValue },
  options: { now: number; cutoff: number; minimum: number },
  personGenerationMatches: (tx: BatchTx, personId: string) => boolean,
  onSnapshot: (changes: number) => void,
) {
  const { person, rubric, model } = group;
  const personId = String(person);
  const { now, cutoff, minimum } = options;
  const existing = new Map(statements.stored.all(person, rubric, model).map(row => [Number(row.week_start), String(row.id)]));
  const source = iterateComparableGrades(statements.page, person, rubric, model, now);
  let next = source.next(), previous: { id: string; end: number; weekly: Histograms; expectedPrefix: string } | undefined;
  const cumulative = histograms(), current = new Set<number>();
  const seenDigest: Hash = createHash("sha256");
  let seenCount = 0;
  for (let start = next.done ? cutoff : weekStart(Number(next.value.target_at)); !next.done || start < cutoff; start += WEEK) {
    const end = start + WEEK, weekly = histograms(), signatures: string[] = [];
    const previousEnd = previous ? previous.end : start;
    const previousExpectedPrefix = previous ? previous.expectedPrefix : null;
    const prefixFence: BatchFence = tx =>
      populationPrefixDigest(tx, db, person, rubric, model, now, previousEnd) === previousExpectedPrefix;
    // Grades compare only with completed weeks before their own; this week joins afterwards.
    let frozen: { cumulative: Ranks; weekly: Ranks } | undefined;
    while (!next.done && Number(next.value.target_at) < end) {
      const row = next.value, signature = gradeSignature(row);
      seenDigest.update(`|${signature}`);
      seenCount++;
      assess(row, signature, result => {
        if (!previous) return;
        frozen ??= { cumulative: ranks(cumulative), weekly: ranks(previous.weekly) };
        result.baselineId = previous.id; result.baselineEnd = previous.end;
        result.cumulative = compare(row, frozen.cumulative, minimum);
        result.weekly = compare(row, frozen.weekly, minimum);
        result.status = result.cumulative.status;
      }, prefixFence);
      if (start < cutoff) { signatures.push(signature); add(weekly, row); }
      next = source.next();
    }
    if (start >= cutoff) continue;
    merge(cumulative, weekly);
    // Chained ids address the whole cumulative population without rehashing earlier weeks.
    // Empty weeks are kept: a weekly comparison always means the preceding calendar week.
    const id = jsonHash([VERSION, person, rubric, model, start, previous?.id ?? null, signatures]), json = encode(weekly);
    const expectedPrefix = seenDigest.copy().digest("hex");
    current.add(start);
    if (existing.get(start) !== id) {
      const hasSeenGrades = seenCount > 0;
      queue.write(tx => {
        // Fence against concurrent purges, relinks, regrades, or new grades affecting this week's prefix.
        if (
          hasSeenGrades &&
          personGenerationMatches(tx, personId) &&
          populationPrefixDigest(tx, db, person, rubric, model, now, end) === expectedPrefix
        ) {
          onSnapshot(Number(statements.upsert.run(person, rubric, model, start, id, VERSION, end, now, json).changes));
        }
      });
    }
    previous = { id, end, weekly, expectedPrefix };
  }
  const expectedFull = seenDigest.digest("hex");
  // Weeks no longer backed by linked grades are replaced, not retained as revisions.
  for (const [start, id] of existing) {
    if (!current.has(start)) {
      queue.write(tx => {
        if (
          personGenerationMatches(tx, personId) &&
          populationPrefixDigest(tx, db, person, rubric, model, now, Infinity) === expectedFull
        ) {
          statements.remove.run(person, rubric, model, start, id);
        }
      });
    }
  }
}

function assessNonComparableGrades(
  db: DatabaseSync,
  queue: BatchQueue,
  assess: GradeAssessor,
  options: { people: boolean; now: number },
) {
  const { people, now } = options;
  // Everything not comparable records an explicit status, never a neutral score.
  const comparable = people ? `coalesce(${COMPARABLE} AND EXISTS (SELECT 1 FROM people p WHERE p.id=e.person_id),0)` : "0";
  const linked = people ? db.prepare("SELECT 1 FROM people WHERE id=?") : undefined;
  const others = db.prepare(`SELECT rowid AS _rowid,* FROM inside_out e WHERE e.reviewed_at<=? AND e.rowid>?
    AND (e.error IS NULL OR e.error<>?) AND NOT ${comparable} ORDER BY e.rowid LIMIT ?`);
  for (let last = -Infinity; ;) {
    const batch = others.all(now, last, PURGED_GRADE, ...(people ? [now, now] : []), PAGE);
    for (const row of batch) {
      assess(row, gradeSignature(row), result => {
        if (row.error !== null || !INSIDE_OUT_EMOTIONS.every(e => typeof row[e] === "number" && Number.isFinite(row[e]) && row[e] >= 0 && row[e] <= 1)) result.status = "grade_failed";
        else if (!row.person_id || !linked?.get(row.person_id)) result.status = "unlinked_person";
        else if (row.target_at === null) result.status = "missing_time";
        else result.status = "future_time";
      });
    }
    if (batch.length < PAGE) break;
    last = Number(batch.at(-1)!._rowid);
    queue.flush();
  }
}

/**
 * One current, content-addressed snapshot per person, rubric, model and completed week.
 * Reads finish before each batch commits, so the shared store is never held for a whole pass.
 * No inference and no changes to raw grades.
 */
export function refreshEmotionBaselines(db: DatabaseSync, options: { minInteractions: number; now?: number; recompare?: boolean }) {
  const now = options.now ?? Date.now(), cutoff = weekStart(now), minimum = options.minInteractions;
  if (!Number.isFinite(now) || !Number.isInteger(minimum) || minimum < 1) throw new Error("Invalid baseline settings");
  initializeEmotionBaselines(db);
  const expectedGenerations = loadPersonGenerations(db);
  const readGeneration = db.prepare("SELECT generation FROM inside_out_person_generations WHERE person_id=?");
  const personGenerationMatches = (tx: BatchTx, personId: string) =>
    getPersonGeneration(tx, readGeneration, personId) === (expectedGenerations.get(personId) ?? 0);
  let snapshots = 0, comparisons = 0;
  const queue = batches(db), people = tableExists(db, "people");
  const assess = createGradeAssessor(db, queue, { now, minimum, recompare: options.recompare }, personGenerationMatches, changes => { comparisons += changes; });

  const populations = new Set<string>();
  if (people) {
    const statements = {
      stored: db.prepare("SELECT week_start,id FROM person_emotion_baselines WHERE person_id=? AND rubric=? AND model=?"),
      upsert: db.prepare(`INSERT INTO person_emotion_baselines VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(person_id,rubric,model,week_start) DO UPDATE SET id=excluded.id,version=excluded.version,
        week_end=excluded.week_end,computed_at=excluded.computed_at,weekly_json=excluded.weekly_json`),
      remove: db.prepare("DELETE FROM person_emotion_baselines WHERE person_id=? AND rubric=? AND model=? AND week_start=? AND id=?"),
      page: db.prepare(`SELECT ${GRADE} FROM inside_out e WHERE e.person_id=? AND e.rubric=? AND e.model=? AND ${COMPARABLE}
        AND (? IS NULL OR e.target_at>? OR (e.target_at=? AND e.interaction_id>?)) ORDER BY e.target_at,e.interaction_id LIMIT ?`),
    };
    const groups = db.prepare(`SELECT DISTINCT e.person_id,e.rubric,e.model FROM inside_out e JOIN people p ON p.id=e.person_id
      WHERE ${COMPARABLE}`).all(now, now);
    for (const group of groups) {
      const { person_id: person, rubric, model } = group;
      populations.add(JSON.stringify([person, rubric, model]));
      refreshPopulation(db, queue, assess, statements, { person, rubric, model }, { now, cutoff, minimum }, personGenerationMatches, changes => { snapshots += changes; });
    }
  }
  // Populations without linked grades (removed identity or person) lose their snapshots.
  const drop = db.prepare("DELETE FROM person_emotion_baselines WHERE person_id=? AND rubric=? AND model=?");
  for (const row of db.prepare("SELECT DISTINCT person_id,rubric,model FROM person_emotion_baselines").all()) {
    if (!populations.has(JSON.stringify([row.person_id, row.rubric, row.model]))) {
      const personId = String(row.person_id);
      queue.write(tx => {
        // Fence against concurrent purges, links, or new grades populating this person since the scan.
        if (
          personGenerationMatches(tx, personId) &&
          getPopulationDigests(tx, db, row.person_id, row.rubric, row.model, now).totalRows === 0
        ) {
          drop.run(row.person_id, row.rubric, row.model);
        }
      });
    }
  }

  assessNonComparableGrades(db, queue, assess, { people, now });
  queue.flush();
  return { snapshots, comparisons };
}

/** Prepared once per export, not per row. */
export function deviationReader(db: DatabaseSync) {
  const entries = schemaVersion(db) === 2 ? db.prepare(`SELECT grade_signature,result_json FROM inside_out_deviations
    WHERE interaction_id=? AND rubric=? ORDER BY assessed_at DESC,rowid DESC`) : undefined;
  return (row: Row, history = false) => {
    if (!entries) return { status: "not_compared" };
    const all = entries.all(row.interaction_id, row.rubric);
    const signature = gradeSignature(row), latest = all.find(entry => entry.grade_signature === signature);
    const current: PersonalDeviation | { status: "not_compared" } = latest ? JSON.parse(String(latest.result_json)) : { status: "not_compared" };
    return history ? { ...current, history: all.map(entry => {
      const result: PersonalDeviation = JSON.parse(String(entry.result_json));
      return { ...result, currentGrade: entry.grade_signature === signature };
    }) } : current;
  };
}

/**
 * Weekly snapshots, newest first; cumulative statistics are prefix sums of each population's stored weeks.
 * `since` keeps weeks whose last day is on or after that UTC date (`week_end` is the exclusive next Monday).
 */
export function emotionBaselineHistory(db: DatabaseSync, options: { personId?: string; since?: number; limit?: number } = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Baseline limit must be between 1 and 1000");
  if (schemaVersion(db) !== 2) return [];
  // One read snapshot: a concurrent refresh may replace or drop weeks between the two queries.
  return readSnapshot(db, () => readBaselineHistory(db, options, limit));
}

function readBaselineHistory(db: DatabaseSync, options: { personId?: string; since?: number }, limit: number) {
  const selected = db.prepare(`SELECT person_id,rubric,model,week_start FROM person_emotion_baselines
    WHERE (? IS NULL OR person_id=?) AND (? IS NULL OR week_end>?) ORDER BY week_end DESC,person_id,rubric,model LIMIT ?`)
    .all(options.personId ?? null, options.personId ?? null, options.since ?? null, options.since ?? null, limit);
  const wanted = new Map<string, Set<number>>();
  for (const row of selected) {
    const population = JSON.stringify([row.person_id, row.rubric, row.model]);
    wanted.set(population, (wanted.get(population) ?? new Set()).add(Number(row.week_start)));
  }
  const weeks = db.prepare("SELECT * FROM person_emotion_baselines WHERE person_id=? AND rubric=? AND model=? ORDER BY week_start");
  const snapshots = new Map<string, ReturnType<typeof snapshot>>();
  const snapshot = (row: Row, weekly: Histograms, cumulative: Histograms) => ({ id: String(row.id), person_id: String(row.person_id),
    rubric: String(row.rubric), model: String(row.model), version: String(row.version), week_start: Number(row.week_start),
    week_end: Number(row.week_end), computed_at: Number(row.computed_at), weekly: summarize(weekly), cumulative: summarize(cumulative) });
  for (const [population, starts] of wanted) {
    const cumulative = histograms(), latest = Math.max(...starts);
    for (const row of weeks.all(...JSON.parse(population) as string[])) {
      const weekly = decode(String(row.weekly_json));
      merge(cumulative, weekly);
      if (starts.has(Number(row.week_start))) snapshots.set(JSON.stringify([population, row.week_start]), snapshot(row, weekly, cumulative));
      if (Number(row.week_start) >= latest) break;
    }
  }
  return selected.map(row => snapshots.get(JSON.stringify([JSON.stringify([row.person_id, row.rubric, row.model]), row.week_start]))!);
}

function computeBaselineInputFingerprint(db: DatabaseSync, options: { minInteractions: number; now: number }) {
  const digest = createHash("sha256").update(JSON.stringify([VERSION, weekStart(options.now), options.minInteractions]));
  if (tableExists(db, "people")) {
    let count = 0;
    digest.update("|people:");
    for (const row of db.prepare("SELECT id FROM people ORDER BY id").iterate()) {
      digest.update(`${JSON.stringify(row.id)},`);
      count++;
    }
    digest.update(`#${count}`);
  } else {
    digest.update("|people:-1");
  }
  if (tableExists(db, "person_identities")) {
    let count = 0;
    digest.update("|identities:");
    for (const row of db.prepare("SELECT rowid,person_id,provider,account_scope,external_id FROM person_identities ORDER BY rowid").iterate()) {
      digest.update(`${JSON.stringify([row.rowid, row.person_id, row.provider, row.account_scope, row.external_id])},`);
      count++;
    }
    digest.update(`#${count}`);
  } else {
    digest.update("|identities:-1");
  }
  if (tableExists(db, "inside_out")) {
    const timing = db.prepare("SELECT count(*) n,sum(target_at<=?) due,sum(reviewed_at<=?) reviewed FROM inside_out").get(options.now, options.now)!;
    digest.update(`|grades:${timing.n},${timing.due},${timing.reviewed}`);
    // Regrades rewrite reviewed_at; links, time edits and purges rewrite person_id, target_at and error.
    for (const row of db.prepare("SELECT rowid,person_id,target_at,reviewed_at,error FROM inside_out ORDER BY rowid").iterate()) {
      digest.update(`|${JSON.stringify([row.rowid, row.person_id, row.target_at, row.reviewed_at, row.error])}`);
    }
  } else {
    digest.update("|grades:-1");
  }
  digest.update("|generations:");
  let generationCount = 0;
  if (tableExists(db, "inside_out_person_generations")) {
    for (const row of db.prepare("SELECT person_id,generation FROM inside_out_person_generations ORDER BY person_id").iterate()) {
      digest.update(`${JSON.stringify([row.person_id, row.generation])},`);
      generationCount++;
    }
  }
  digest.update(`#${generationCount}`);
  return digest.digest("hex");
}

function computeBaselineFingerprintFromInput(db: DatabaseSync, inputFingerprint: string) {
  const digest = createHash("sha256").update(JSON.stringify([inputFingerprint, schemaVersion(db) ?? null]));
  for (const table of ["person_emotion_baselines", "inside_out_deviations"]) {
    digest.update(`|${tableExists(db, table) ? Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n) : -1}`);
  }
  return digest.digest("hex");
}

/**
 * Fingerprint of refresh inputs only (settings, current week, People tables, grades, and purge generations).
 * Excludes derived output tables so a refresh can verify inputs stayed stable across a pass
 * before certifying its post-pass fingerprint.
 */
export function baselineInputFingerprint(db: DatabaseSync, options: { minInteractions: number; now: number }) {
  return readSnapshot(db, () => computeBaselineInputFingerprint(db, options));
}

/**
 * Computes both input and full fingerprints inside one consistent SQLite read snapshot so
 * post-pass certification never rescans inputs or mixes pre- and post-commit state.
 */
export function baselineFingerprints(db: DatabaseSync, options: { minInteractions: number; now: number }) {
  return readSnapshot(db, () => {
    const inputFingerprint = computeBaselineInputFingerprint(db, options);
    return { inputFingerprint, fullFingerprint: computeBaselineFingerprintFromInput(db, inputFingerprint) };
  });
}

/**
 * Changes whenever a refresh input could: grades, links, people, purge generations, stored results,
 * the current week, grades crossing `now`, or settings. Equal fingerprints mean a refresh would write nothing.
 */
export function baselineFingerprint(db: DatabaseSync, options: { minInteractions: number; now: number }) {
  return baselineFingerprints(db, options).fullFingerprint;
}

/**
 * Delete one person's baselines and assessment history. With `grades`, also erase their six
 * probabilities and person link, keeping a tombstone so the reply is never sent to Jev again.
 */
export function purgeEmotionProfile(db: DatabaseSync, personId: string, options: { grades?: boolean } = {}) {
  const counts = { baselines: 0, assessments: 0, grades: 0 };
  if (!tableExists(db, "inside_out")) return counts;
  initializeEmotionBaselines(db);
  return immediateTransaction(db, () => {
    db.prepare(`INSERT INTO inside_out_person_generations (person_id, generation) VALUES (?, 1)
      ON CONFLICT(person_id) DO UPDATE SET generation = generation + 1`).run(personId);
    if (options.grades) {
      counts.assessments += Number(db.prepare(`DELETE FROM inside_out_deviations WHERE (interaction_id,rubric) IN
        (SELECT interaction_id,rubric FROM inside_out WHERE person_id=?)`).run(personId).changes);
      counts.grades = Number(db.prepare(`UPDATE inside_out SET ${INSIDE_OUT_EMOTIONS.map(e => `${e}=NULL`).join(",")},
        error=?,person_id=NULL WHERE person_id=?`).run(PURGED_GRADE, personId).changes);
    }
    counts.assessments += Number(db.prepare("DELETE FROM inside_out_deviations WHERE person_id=?").run(personId).changes);
    counts.baselines = Number(db.prepare("DELETE FROM person_emotion_baselines WHERE person_id=?").run(personId).changes);
    return counts;
  });
}
