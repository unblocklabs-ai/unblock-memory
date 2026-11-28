import { existsSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { DEFAULTS } from "./defaults.js";
import { gradeSignature } from "./emotion-baselines.js";
import { readTableColumns, tableExists } from "./memory-database.js";

// Plain-Node, read-only reader shared by Captain's Log, Crystals and Brightness (`emotion_v1`). Keep it free of `openclaw`,
// never create or migrate a table here, and treat every missing, locked or mid-migration table, column or grade as
// "no signal" rather than an error.

/**
 * Strong memories track high *relative* emotion: joy at a launch or birth, grief or stress at a major failure. The score
 * is symmetric over valence, so positive and negative peaks are equally salient.
 */
export type EmotionalSalienceSignal = {
  sessionId: string;
  messageId: string;
  /** Inside Out `intensity` (0..3) when graded; null on legacy rows without the column or value. */
  absoluteIntensity: number | null;
  /**
   * Mid-rank percentile (0..1) of this event against the person's own history, when a baseline exists: the person's
   * prior `intensity` grades (same presence rubric, model and `intensity_rubric`) first, else the hottest emotion's
   * `inside_out_deviations` percentile.
   */
  relativeIntensityPercentile: number | null;
  /** Largest one-sided (upper-tail) per-emotion unusualness, 0..1, from `inside_out_deviations`. */
  maxEmotionUnusualness: number | null;
  /** Inside Out `valence` when graded; null on legacy rows. */
  valence: number | null;
  dominantEmotion: string | null;
  /** 0..1, comparable across new and legacy rows (legacy rows are discounted by `legacyConfidence`). */
  salienceScore: number;
  highSalience: boolean;
  /** Neutral, prompt-safe cue such as `joy/milestone` or `stress/setback`; never a raw number. */
  label: string;
};

export type EmotionalSalienceOptions = {
  /** `highSalience` when `salienceScore >= minSalienceScore`. Default 0.7. */
  minSalienceScore?: number;
  /** `highSalience` whenever absolute intensity (0..3) reaches this, regardless of history. Default 2.2. */
  minAbsoluteIntensity?: number;
  /** Relative spikes only count from this absolute intensity (0..3) up, so a rare-but-trivial blip stays quiet. Default 1.5. */
  minRelativeIntensity?: number;
  /** Weight (0..1) of the relative upper tail against normalized absolute intensity. Default 0.6. */
  relativeWeight?: number;
  /** Multiplier (0..1) applied to legacy NULL-intensity scores, which are less certain. Default 0.85. */
  legacyConfidence?: number;
  /** Two opposite-valence emotions at or above this (0..1) are labelled mixed. Default 0.5. */
  mixedEmotionThreshold?: number;
  /** Prior intensity grades a person needs before relative intensity counts. Default `insideOut.baselineMinInteractions`'s default. */
  baselineMinInteractions?: number;
  /** SQLite busy timeout when opening by path. Default the plugin's main busy timeout. */
  busyTimeoutMs?: number;
  /** Upper bound (epoch ms) on a grade's observation time; set with or without `lookbackDays`. Default unbounded. */
  nowMs?: number;
  /** Only grades observed within this many days before `nowMs` count (`0` = no lower bound). Default unbounded. */
  lookbackDays?: number;
};
type ReaderOnly = "busyTimeoutMs" | "nowMs" | "lookbackDays";

export const DEFAULT_EMOTIONAL_SALIENCE_OPTIONS = {
  minSalienceScore: 0.7, minAbsoluteIntensity: 2.2, minRelativeIntensity: 1.5, relativeWeight: 0.6,
  legacyConfidence: 0.85, mixedEmotionThreshold: 0.5,
  baselineMinInteractions: DEFAULTS.insideOut.defaultBaselineMinInteractions,
} as const satisfies Required<Omit<EmotionalSalienceOptions, ReaderOnly>>;

export type PathSalience = {
  salienceScore: number;
  /** The same `highSalience` gate Captain's Log cues on; Crystals only prioritize these. */
  highSalience: boolean;
  absoluteIntensity: number | null;
  relativePercentile: number | null;
  observedAtMs: number | null;
};

const EMOTIONS = ["joy", "sadness", "fear", "anger", "disgust", "surprise"] as const;
type Emotion = typeof EMOTIONS[number];
const NEGATIVE = new Set<string>(["sadness", "fear", "anger", "disgust"]);
const MAX_INTENSITY = 3;
/** One bound JSON parameter, so batch size never hits SQLite's variable limit. */
const IDS = "(SELECT value FROM json_each(?))";

export const salienceKey = (sessionId: string, messageId: string) => `${sessionId}\0${messageId}`;

type Db = DatabaseSync;
export type ResolvedEmotionalSalienceOptions = Required<Omit<EmotionalSalienceOptions, ReaderOnly>>;

/** Merges defaults and validates; throws `RangeError` on a misconfigured threshold or weight. */
export function resolveEmotionalSalienceOptions(options: EmotionalSalienceOptions = {}): ResolvedEmotionalSalienceOptions {
  const { busyTimeoutMs: _busy, nowMs: _now, lookbackDays: _lookback, ...thresholds } = options;
  const merged = { ...DEFAULT_EMOTIONAL_SALIENCE_OPTIONS, ...stripUndefined(thresholds) } as ResolvedEmotionalSalienceOptions;
  for (const name of ["minSalienceScore", "relativeWeight", "legacyConfidence", "mixedEmotionThreshold"] as const) {
    const value = merged[name];
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
  }
  for (const name of ["minAbsoluteIntensity", "minRelativeIntensity"] as const) {
    const value = merged[name];
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative number`);
  }
  if (!Number.isSafeInteger(merged.baselineMinInteractions) || merged.baselineMinInteractions < 1) {
    throw new RangeError("baselineMinInteractions must be an integer >= 1");
  }
  return merged;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Runs `use` on a caller's connection, or on a short-lived read-only one. A missing file, and any locked, busy or
 * mid-migration read, is simply empty: salience is optional evidence and never fails its caller.
 */
function withDb<T>(dbOrPath: Db | string, empty: T, busyTimeoutMs: number | undefined, use: (db: Db) => T): T {
  if (typeof dbOrPath !== "string") return optional(empty, () => use(dbOrPath));
  if (!existsSync(dbOrPath)) return empty;
  let db: Db;
  try { db = new DatabaseSync(dbOrPath, { readOnly: true }); } catch { return empty; }
  try {
    return optional(empty, () => {
      db.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${busyTimeoutMs ?? DEFAULTS.sqlite.mainBusyTimeoutMs}`);
      return use(db);
    });
  } finally { db.close(); }
}

/** Optional evidence may be missing, locked or mid-migration; any failure is simply no signal. */
function optional<T>(empty: T, read: () => T): T {
  try { return read(); } catch { return empty; }
}

const finite = (value: SQLOutputValue | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const unit = (value: number) => Math.min(1, Math.max(0, value));

type Comparison = { percentile: number | null; unusualness: number | null };

/** Prefers the full-history comparison, then the weekly one; only `ok` comparisons carry a signal. */
function parseDeviation(json: string): Comparison {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return { percentile: null, unusualness: null }; }
  const result = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  for (const scope of ["cumulative", "weekly"]) {
    const comparison = result[scope] as { status?: unknown; emotions?: unknown } | null | undefined;
    if (!comparison || comparison.status !== "ok" || !comparison.emotions || typeof comparison.emotions !== "object") continue;
    const emotions = comparison.emotions as Record<string, { percentile?: unknown } | undefined>;
    const percentileOf = (name: string) => {
      const p = emotions[name]?.percentile;
      return typeof p === "number" && Number.isFinite(p) ? unit(p) : null;
    };
    // A graded `intensity` baseline (when present) is the direct relative signal; otherwise the hottest emotion.
    const perEmotion = EMOTIONS.map(percentileOf).filter((p): p is number => p !== null);
    if (!perEmotion.length && percentileOf("intensity") === null) continue;
    const upper = perEmotion.length ? Math.max(...perEmotion) : null;
    // One-sided: an unusually *low* emotion (a quiet day) is not a strong memory.
    return { percentile: percentileOf("intensity") ?? upper, unusualness: upper === null ? null : unit(2 * upper - 1) };
  }
  return { percentile: null, unusualness: null };
}

type Grade = {
  sessionId: string; messageId: string; emotions: Partial<Record<Emotion, number>>;
  intensity: number | null; valence: number | null; comparison: Comparison; observedAtMs: number | null;
};

function label(grade: Grade, resolved: ResolvedEmotionalSalienceOptions, dominant: string | null): string {
  const ranked = EMOTIONS.flatMap(emotion => grade.emotions[emotion] === undefined ? [] : [[emotion, grade.emotions[emotion]!] as const])
    .sort((a, b) => b[1] - a[1]);
  const positive = ranked.find(([e]) => e === "joy"), negative = ranked.find(([e]) => NEGATIVE.has(e));
  if (positive && negative && positive[1] >= resolved.mixedEmotionThreshold && negative[1] >= resolved.mixedEmotionThreshold) {
    return "mixed/bittersweet";
  }
  const valence = grade.valence;
  const polarity = valence !== null && valence > 0 ? "milestone" : valence !== null && valence < 0 ? "setback"
    : dominant === "joy" ? "milestone" : dominant !== null && NEGATIVE.has(dominant) ? "setback" : "notable";
  const word = dominant === "fear" ? "stress" : dominant === "anger" || dominant === "disgust" ? "frustration"
    : dominant ?? (polarity === "milestone" ? "joy" : polarity === "setback" ? "stress" : "emotion");
  return `${word}/${polarity}`;
}

function score(grade: Grade, resolved: ResolvedEmotionalSalienceOptions): EmotionalSalienceSignal {
  const values = EMOTIONS.flatMap(emotion => grade.emotions[emotion] === undefined ? [] : [[emotion, grade.emotions[emotion]!] as const]);
  const top = values.reduce<readonly [Emotion, number] | null>((best, entry) => !best || entry[1] > best[1] ? entry : best, null);
  const dominantEmotion = top && top[1] > 0 ? top[0] : null;
  const { percentile, unusualness } = grade.comparison;
  const upperTail = percentile === null ? null : unit(2 * percentile - 1);
  const w = resolved.relativeWeight;
  let salienceScore: number;
  if (grade.intensity !== null) {
    const absolute = unit(grade.intensity / MAX_INTENSITY);
    // An objectively huge event scores on its own; a rare spike for a stoic person blends in its upper tail.
    const relative = upperTail !== null && grade.intensity >= resolved.minRelativeIntensity ? absolute * (1 - w) + upperTail * w : 0;
    salienceScore = Math.max(absolute, relative);
  } else {
    // Legacy: the hottest emotion stands in for intensity, discounted for lower confidence.
    const peak = top ? unit(top[1]) : 0;
    const tail = upperTail ?? unusualness;
    const relative = tail !== null && peak * MAX_INTENSITY >= resolved.minRelativeIntensity ? peak * (1 - w) + tail * w : 0;
    salienceScore = resolved.legacyConfidence * Math.max(peak, relative);
  }
  salienceScore = unit(salienceScore);
  const highSalience = salienceScore >= resolved.minSalienceScore ||
    (grade.intensity !== null && grade.intensity >= resolved.minAbsoluteIntensity);
  return {
    sessionId: grade.sessionId, messageId: grade.messageId, absoluteIntensity: grade.intensity,
    relativeIntensityPercentile: percentile, maxEmotionUnusualness: unusualness, valence: grade.valence,
    dominantEmotion, salienceScore, highSalience, label: label(grade, resolved, dominantEmotion),
  };
}

/** Columns the per-person intensity percentile needs; older schemas fall back to deviation percentiles. */
const INTENSITY_HISTORY = ["intensity", "intensity_rubric", "person_id", "rubric", "model", "target_at", "error"] as const;
/** Columns a grade signature hashes; deviations are only trusted for the exact grade they assessed. */
const SIGNATURE = ["interaction_id", "rubric", "model", "person_id", "target_at", "reviewed_at", "error", ...EMOTIONS] as const;
/** Float tolerance for ties between stored expected scores (matches `intensityReader`). */
const INTENSITY_EPSILON = 1e-9;
const DAY_MS = 86_400_000;

/** Optional observation window: grades outside `[since, until]` are never a signal, even the strongest. */
type GradeWindow = { since: number; until: number } | undefined;

function gradeWindow(options: EmotionalSalienceOptions): GradeWindow {
  const { nowMs, lookbackDays } = options;
  if (nowMs === undefined && lookbackDays === undefined) return undefined;
  const until = nowMs ?? Date.now();
  if (!Number.isFinite(until)) throw new RangeError("nowMs must be a finite number");
  if (lookbackDays !== undefined && (!Number.isFinite(lookbackDays) || lookbackDays < 0)) {
    throw new RangeError("lookbackDays must be a non-negative number");
  }
  return { since: !lookbackDays ? -Infinity : until - lookbackDays * DAY_MS, until };
}

/** Binary search: the first index whose value is `>= value` (`strict`: `> value`). */
function lowerBound(sorted: readonly number[], value: number, strict = false): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (strict ? sorted[mid]! <= value : sorted[mid]! < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

type IntensityTarget = { row: Record<string, SQLOutputValue>; at: number; value: number; percentile?: number };

/**
 * Midrank intensity percentiles against each person's own *earlier* grades (same person, presence rubric, model and
 * intensity rubric), computed in one ordered read per group instead of one aggregate per grade. A Fenwick tree over the
 * group's distinct values keeps every lookup logarithmic, so cost is O((history + grades) log history).
 */
function personalIntensityPercentiles(db: Db, targets: IntensityTarget[], minimum: number): void {
  const groups = new Map<string, IntensityTarget[]>();
  for (const target of targets) {
    const { person_id, rubric, model, intensity_rubric } = target.row;
    const key = JSON.stringify([person_id, rubric, model, intensity_rubric]);
    const list = groups.get(key);
    if (list) list.push(target); else groups.set(key, [target]);
  }
  const history = db.prepare(`SELECT target_at at, intensity value FROM inside_out
    WHERE person_id=? AND rubric IS ? AND model IS ? AND intensity_rubric IS ? AND error IS NULL
      AND intensity IS NOT NULL AND target_at IS NOT NULL AND target_at<? ORDER BY target_at`);
  for (const list of groups.values()) {
    const { person_id, rubric, model, intensity_rubric } = list[0]!.row;
    list.sort((a, b) => a.at - b.at);
    const rows = history.all(person_id ?? null, rubric ?? null, model ?? null, intensity_rubric ?? null, list.at(-1)!.at)
      .flatMap(row => {
        const at = finite(row.at), value = finite(row.value);
        return at === null || value === null ? [] : [{ at, value }];
      });
    if (rows.length < minimum) continue;
    const values = [...new Set(rows.map(row => row.value))].sort((a, b) => a - b);
    const tree = new Array<number>(values.length + 1).fill(0);
    const add = (index: number) => { for (let i = index + 1; i <= values.length; i += i & -i) tree[i] = tree[i]! + 1; };
    const prefix = (end: number) => { let sum = 0; for (let i = end; i > 0; i -= i & -i) sum += tree[i]!; return sum; };
    let next = 0;
    for (const target of list) {
      // Strictly earlier grades only, exactly as the per-grade aggregate counted them.
      while (next < rows.length && rows[next]!.at < target.at) add(lowerBound(values, rows[next++]!.value));
      if (next < minimum) continue;
      const below = prefix(lowerBound(values, target.value - INTENSITY_EPSILON));
      const tied = prefix(lowerBound(values, target.value + INTENSITY_EPSILON, true)) - below;
      target.percentile = (below + tied / 2) / next;
    }
  }
}

/** Latest deviation per `(interaction_id, rubric, grade_signature)`, read in one batch. */
function readDeviations(db: Db, interactions: readonly string[]): Map<string, string> {
  const latest = new Map<string, string>();
  if (!interactions.length) return latest;
  for (const row of db.prepare(`SELECT interaction_id, rubric, grade_signature, result_json FROM inside_out_deviations
    WHERE interaction_id IN ${IDS} ORDER BY assessed_at DESC, rowid DESC`).iterate(JSON.stringify([...new Set(interactions)]))) {
    const key = JSON.stringify([row.interaction_id, row.rubric, row.grade_signature]);
    if (!latest.has(key) && typeof row.result_json === "string") latest.set(key, row.result_json);
  }
  return latest;
}

/**
 * Successful grades for the given sessions, each joined to the latest personal-deviation assessment *of that exact
 * grade* and, where the schema carries graded intensity, ranked against the person's own prior intensity grades.
 * `message_id` is optional so session-level readers (Brightness, Crystals) still work on partial schemas; message-level
 * matching then finds nothing. A `window` drops out-of-range grades before any strongest-grade selection.
 */
function readGrades(db: Db, sessionIds: readonly string[], resolved: ResolvedEmotionalSalienceOptions, window?: GradeWindow): Grade[] {
  const ids = [...new Set(sessionIds)];
  if (!ids.length || !tableExists(db, "inside_out")) return [];
  const have = readTableColumns(db, "inside_out");
  if (!have.has("session_id")) return [];
  const pick = (name: string) => have.has(name) ? `e.${name}` : "NULL";
  const deviationColumns = readTableColumns(db, "inside_out_deviations");
  const deviations = SIGNATURE.every(name => have.has(name)) &&
    ["interaction_id", "rubric", "grade_signature", "assessed_at", "result_json"].every(name => deviationColumns.has(name));
  const observed = `COALESCE(${pick("target_at")}, ${pick("reviewed_at")})`;
  // Failed and operator-purged grades both carry an error and are never a signal.
  const where = [have.has("error") ? "AND e.error IS NULL" : "",
    // A partial legacy schema without any timestamp cannot be placed in time, so it is not excluded by the window.
    window ? `AND (${observed} IS NULL OR ${observed} BETWEEN ? AND ?)` : ""].join(" ");
  const params = [JSON.stringify(ids), ...(window ? [window.since, window.until] : [])];
  const rows = db.prepare(`SELECT e.session_id sessionId, ${pick("message_id")} messageId,
      ${EMOTIONS.map(emotion => `${pick(emotion)} ${emotion}`).join(", ")},
      ${pick("intensity")} intensity, ${pick("valence")} valence, ${pick("intensity_rubric")} intensity_rubric,
      ${pick("interaction_id")} interaction_id, ${pick("person_id")} person_id, ${pick("rubric")} rubric,
      ${pick("model")} model, ${pick("target_at")} target_at, ${pick("reviewed_at")} reviewed_at,
      ${pick("error")} error, ${observed} observedAtMs
    FROM inside_out e WHERE e.session_id IN ${IDS} ${where}`).all(...params);
  const latestDeviation = deviations
    ? optional(new Map<string, string>(), () => readDeviations(db, rows.flatMap(row => typeof row.interaction_id === "string" ? [row.interaction_id] : [])))
    : new Map<string, string>();
  const relative = INTENSITY_HISTORY.every(name => have.has(name));
  const targets: IntensityTarget[] = [];
  const grades = rows.flatMap(row => {
    const emotions: Partial<Record<Emotion, number>> = {};
    for (const emotion of EMOTIONS) {
      const value = finite(row[emotion]);
      if (value !== null) emotions[emotion] = unit(value);
    }
    const intensity = finite(row.intensity);
    if (intensity === null && !Object.keys(emotions).length) return [];
    const json = deviations ? latestDeviation.get(JSON.stringify([row.interaction_id, row.rubric, gradeSignature(row)])) : undefined;
    const comparison = json !== undefined ? parseDeviation(json) : { percentile: null, unusualness: null };
    const at = finite(row.target_at);
    const target: IntensityTarget | undefined = relative && intensity !== null && row.person_id !== null && at !== null &&
      (row.error ?? null) === null ? { row, at, value: intensity } : undefined;
    if (target) targets.push(target);
    return [{ grade: {
      sessionId: String(row.sessionId), messageId: row.messageId === null ? "" : String(row.messageId), emotions,
      intensity: intensity === null ? null : Math.min(MAX_INTENSITY, Math.max(0, intensity)), valence: finite(row.valence),
      comparison, observedAtMs: finite(row.observedAtMs),
    } satisfies Grade, target }];
  });
  if (targets.length) optional(undefined, () => personalIntensityPercentiles(db, targets, resolved.baselineMinInteractions));
  return grades.map(({ grade, target }) => {
    if (target?.percentile !== undefined) grade.comparison.percentile = unit(target.percentile);
    return grade;
  });
}

const stronger = (a: EmotionalSalienceSignal | undefined, b: EmotionalSalienceSignal) =>
  !a || b.salienceScore > a.salienceScore || (b.salienceScore === a.salienceScore && Number(b.highSalience) > Number(a.highSalience));

/**
 * Batch-loads salience keyed by {@link salienceKey}. Multiple rubrics for one message keep the strongest. Missing tables,
 * columns, files or not-yet-graded messages simply produce no entry.
 */
export function readSessionMessageSalience(dbOrPath: Db | string, sessionIds: readonly string[],
  options: EmotionalSalienceOptions = {}): Map<string, EmotionalSalienceSignal> {
  const resolved = resolveEmotionalSalienceOptions(options), window = gradeWindow(options);
  return withDb(dbOrPath, new Map(), options.busyTimeoutMs, db => {
    const result = new Map<string, EmotionalSalienceSignal>();
    for (const grade of readGrades(db, sessionIds, resolved, window)) {
      const signal = score(grade, resolved), key = salienceKey(grade.sessionId, grade.messageId);
      if (stronger(result.get(key), signal)) result.set(key, signal);
    }
    return result;
  });
}

/** The single most salient graded message per session, for Crystals and Brightness. */
export function readSessionMaxSalience(dbOrPath: Db | string, sessionIds: readonly string[],
  options: EmotionalSalienceOptions = {}): Map<string, EmotionalSalienceSignal> {
  const result = new Map<string, EmotionalSalienceSignal>();
  for (const signal of readSessionMessageSalience(dbOrPath, sessionIds, options).values()) {
    if (stronger(result.get(signal.sessionId), signal)) result.set(signal.sessionId, signal);
  }
  return result;
}

/** A daily note anywhere in a memory corpus: `memory/2026-05-05.md`, `qmd://source-…/prior-months/may-2026/2026-05-05.md`. */
const DAILY_PATH = /(?:^|[\\/])(\d{4}-\d{2}-\d{2})\.md$/u;
/** A path inside a session corpus (`sessions/…`, `qmd://sessions/…`): never a daily note, segments may be session ids. */
const SESSION_SCOPE = /(?:^|[\\/])sessions[\\/]/iu;
/** A session projection filename: `<started>--<sessionId>.md`, where `<started>` is `YYYY-MM-DD` with an optional time. */
const PROJECTION_NAME = /(?:^|[\\/])\d{4}-\d{2}-\d{2}(?:T[^\\/]*?)?--([^\\/]+?)\.md$/u;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * Candidate session ids in a memory path. Only session-shaped evidence counts: a projection filename suffix, a UUID,
 * or, inside a session corpus, each path segment (`sessions/…/<sessionId>/transcript.md`). An arbitrary knowledge
 * path (`qmd://knowledge/private/policy.md`) never names a session. Candidates only ever match a stored id exactly.
 */
function sessionCandidates(path: string): string[] {
  const found = new Set<string>();
  const scoped = SESSION_SCOPE.test(path);
  const suffix = path.match(PROJECTION_NAME)?.[1] ?? (scoped ? path.match(/--([^\\/]+?)\.md$/u)?.[1] : undefined);
  if (suffix) found.add(suffix);
  for (const match of path.matchAll(UUID)) found.add(match[0]);
  if (scoped) {
    const segments = path.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "").split(/[\\/]/u);
    for (const segment of segments.slice(segments.findIndex(part => part.toLowerCase() === "sessions") + 1)) {
      const id = segment.replace(/\.md$/u, "");
      if (id) found.add(id);
    }
  }
  return [...found];
}

/**
 * Read-only salience for memory paths: daily notes (`…/YYYY-MM-DD.md` outside a session corpus) take the strongest
 * Captain's Log entry for that day, session projections take the session's strongest graded message. Unknown paths
 * are omitted. With `nowMs` / `lookbackDays`, out-of-window Captain's Log entries and grades never count.
 */
export function readPathSalience(dbOrPath: Db | string, agentId: string, paths: readonly string[],
  options: EmotionalSalienceOptions = {}): Map<string, PathSalience> {
  const resolved = resolveEmotionalSalienceOptions(options), window = gradeWindow(options);
  return withDb(dbOrPath, new Map(), options.busyTimeoutMs, db => {
    const result = new Map<string, PathSalience>();
    const days = new Map<string, string[]>(), sessions = new Map<string, string[]>();
    for (const path of new Set(paths)) {
      const day = SESSION_SCOPE.test(path) ? undefined : path.match(DAILY_PATH)?.[1];
      if (day) { days.set(day, [...days.get(day) ?? [], path]); continue; }
      for (const id of sessionCandidates(path)) sessions.set(id, [...sessions.get(id) ?? [], path]);
    }
    const have = days.size ? optional(new Set<string>(), () => readTableColumns(db, "captains_log_entries")) : new Set<string>();
    if (["agent_id", "day", "salience_score"].every(name => have.has(name))) {
      const pick = (name: string) => have.has(name) ? name : "NULL";
      const high = have.has("salience_signals_json")
        ? "CASE WHEN json_valid(salience_signals_json) THEN json_extract(salience_signals_json,'$.highSalience') END" : "NULL";
      const bounded = window && have.has("captured_at_ms") ? "AND (captured_at_ms IS NULL OR captured_at_ms BETWEEN ? AND ?)" : "";
      // A locked or unreadable Captain's Log never suppresses Inside Out.
      for (const row of optional([], () => db.prepare(`SELECT day, salience_score score, ${pick("emotional_intensity")} intensity,
          ${pick("relative_salience")} relative, ${pick("captured_at_ms")} at, ${high} high
        FROM captains_log_entries WHERE agent_id=? AND salience_score IS NOT NULL AND day IN ${IDS} ${bounded}
        ORDER BY salience_score DESC${have.has("captured_at_ms") ? ", captured_at_ms DESC" : ""}`)
        .all(agentId, JSON.stringify([...days.keys()]), ...(bounded ? [window!.since, window!.until] : [])))) {
        for (const path of days.get(String(row.day)) ?? []) {
          if (result.has(path)) continue;
          const salienceScore = unit(finite(row.score) ?? 0);
          // Entries persisted before the flag existed fall back to the configured score threshold.
          const highSalience = row.high === null || row.high === undefined ? salienceScore >= resolved.minSalienceScore : Boolean(row.high);
          result.set(path, { salienceScore, highSalience, absoluteIntensity: finite(row.intensity),
            relativePercentile: finite(row.relative), observedAtMs: finite(row.at) });
        }
      }
    }
    if (sessions.size) {
      const grades = optional([], () => readGrades(db, [...sessions.keys()], resolved, window));
      const best = new Map<string, { signal: EmotionalSalienceSignal; at: number | null }>();
      for (const grade of grades) {
        const signal = score(grade, resolved), prior = best.get(grade.sessionId);
        if (!prior || stronger(prior.signal, signal)) best.set(grade.sessionId, { signal, at: grade.observedAtMs });
      }
      for (const [sessionId, { signal, at }] of best) {
        for (const path of sessions.get(sessionId) ?? []) {
          const prior = result.get(path);
          if (prior && prior.salienceScore >= signal.salienceScore) continue;
          result.set(path, { salienceScore: signal.salienceScore, highSalience: signal.highSalience,
            absoluteIntensity: signal.absoluteIntensity, relativePercentile: signal.relativeIntensityPercentile, observedAtMs: at });
        }
      }
    }
    return result;
  });
}
