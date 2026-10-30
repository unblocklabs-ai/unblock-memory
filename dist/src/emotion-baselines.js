import { createHash } from "node:crypto";
import { immediateTransaction, tableExists } from "./memory-database.js";
import { jsonHash } from "./json-hash.js";
export const INSIDE_OUT_EMOTIONS = ["joy", "sadness", "fear", "anger", "disgust", "surprise"];
/** Erased by an operator purge: never retried, linked, aggregated or compared. */
export const PURGED_GRADE = "Purged by operator";
/** Builds a per-emotion record in canonical emotion order, so serialized key order is stable. */
const perEmotion = (f) => Object.fromEntries(INSIDE_OUT_EMOTIONS.map(emotion => [emotion, f(emotion)]));
const WEEK = 7 * 86400_000;
const MONDAY = Date.UTC(1970, 0, 5);
const VERSION = "personal-deviation-v2";
// 0.01-wide bins bound each stored distribution to 101 values per emotion, however long the history.
const STEPS = 100;
// Writers on the shared store wait for at most one short batch, never a whole refresh.
const BATCH = 500;
const PAGE = 2000;
const weekStart = (time) => MONDAY + Math.floor((time - MONDAY) / WEEK) * WEEK;
const bin = (value) => Math.round(value * STEPS);
const GRADE = `interaction_id,rubric,model,person_id,target_at,reviewed_at,error,${INSIDE_OUT_EMOTIONS.join(",")}`;
const VALID = INSIDE_OUT_EMOTIONS.map(e => `e.${e} BETWEEN 0 AND 1`).join(" AND ");
// Comparable grades: successful, timed, not after `now`. Callers add the People join.
const COMPARABLE = `e.reviewed_at<=? AND e.error IS NULL AND e.target_at IS NOT NULL AND e.target_at<=? AND ${VALID}`;
function schemaVersion(db) {
    if (!tableExists(db, "memory_schema"))
        return undefined;
    const version = db.prepare("SELECT version FROM memory_schema WHERE component='emotion-baselines'").get()?.version;
    return version === undefined ? undefined : Number(version);
}
/** Separate analytics tables: never dossier fields or prompt-injection state. */
function initializeEmotionBaselines(db) {
    if (schemaVersion(db) === 2)
        return;
    immediateTransaction(db, () => {
        const version = schemaVersion(db);
        if (version !== undefined && version !== 1 && version !== 2)
            throw new Error("Unsupported Inside Out baseline storage version");
        // Unreleased v1 kept every raw-value revision. Both tables are derived and rebuild from grades.
        if (version === 1)
            db.exec("DROP TABLE IF EXISTS inside_out_deviations; DROP TABLE IF EXISTS person_emotion_baselines;");
        db.exec(`CREATE TABLE IF NOT EXISTS person_emotion_baselines (
      person_id TEXT NOT NULL, rubric TEXT NOT NULL, model TEXT NOT NULL, week_start INTEGER NOT NULL,
      id TEXT NOT NULL, version TEXT NOT NULL, week_end INTEGER NOT NULL, computed_at INTEGER NOT NULL, weekly_json TEXT NOT NULL,
      PRIMARY KEY(person_id,rubric,model,week_start)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS inside_out_deviations (
      id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL, rubric TEXT NOT NULL, grade_signature TEXT NOT NULL,
      assessed_at INTEGER NOT NULL, baseline_id TEXT, person_id TEXT, result_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS inside_out_deviations_interaction ON inside_out_deviations(interaction_id,rubric);
    CREATE INDEX IF NOT EXISTS inside_out_deviations_person ON inside_out_deviations(person_id);
    INSERT OR REPLACE INTO memory_schema VALUES ('emotion-baselines',2);`);
    });
}
function gradeSignature(row) {
    return jsonHash([row.interaction_id, row.rubric, row.model, row.person_id ?? null, row.target_at,
        row.reviewed_at, row.error, ...INSIDE_OUT_EMOTIONS.map(e => row[e])]);
}
function histograms() {
    const empty = () => ({ count: 0, sum: 0, carry: 0, min: Infinity, max: -Infinity, bins: new Array(STEPS + 1).fill(0) });
    return perEmotion(empty);
}
// Neumaier summation keeps means exact for repeated values: twenty 0.8s average to 0.8.
function accumulate(target, value, count, min, max) {
    const total = target.sum + value;
    target.carry += Math.abs(target.sum) >= Math.abs(value) ? target.sum - total + value : value - total + target.sum;
    target.sum = total;
    target.count += count;
    target.min = Math.min(target.min, min);
    target.max = Math.max(target.max, max);
}
function add(target, row) {
    for (const emotion of INSIDE_OUT_EMOTIONS) {
        const value = Number(row[emotion]);
        accumulate(target[emotion], value, 1, value, value);
        target[emotion].bins[bin(value)]++;
    }
}
function merge(target, source) {
    for (const emotion of INSIDE_OUT_EMOTIONS) {
        const from = source[emotion], to = target[emotion];
        accumulate(to, from.sum + from.carry, from.count, from.min, from.max);
        from.bins.forEach((n, i) => { to.bins[i] += n; });
    }
}
const distribution = (histogram) => histogram.bins.flatMap((n, i) => n ? [[i / STEPS, n]] : []);
/** Stored form: exact count, sum, min and max with sparse bins, so quiet weeks stay tiny. */
function encode(week) {
    return JSON.stringify(Object.fromEntries(INSIDE_OUT_EMOTIONS.map(emotion => {
        const h = week[emotion];
        return [emotion, { count: h.count, sum: h.sum + h.carry, min: h.count ? h.min : null, max: h.count ? h.max : null, bins: distribution(h) }];
    })));
}
function decode(json) {
    const stored = JSON.parse(json);
    const week = histograms();
    for (const emotion of INSIDE_OUT_EMOTIONS) {
        const s = stored[emotion], h = week[emotion];
        Object.assign(h, { count: s.count, sum: s.sum, min: s.min ?? Infinity, max: s.max ?? -Infinity });
        for (const [value, n] of s.bins)
            h.bins[bin(value)] = n;
    }
    return week;
}
function summarize(week) {
    const statistics = (h) => {
        const values = distribution(h);
        const at = (rank) => {
            let seen = 0;
            for (const [value, frequency] of values) {
                seen += frequency;
                if (rank < seen)
                    return value;
            }
            return values.at(-1)[0];
        };
        // Bin centres can sit just outside the exact extremes; quantiles never do.
        const quantile = (p) => {
            if (!h.count)
                return null;
            const position = (h.count - 1) * p, lower = Math.floor(position);
            return Math.min(h.max, Math.max(h.min, at(lower) + (at(Math.ceil(position)) - at(lower)) * (position - lower)));
        };
        return { count: h.count, mean: h.count ? (h.sum + h.carry) / h.count : null, min: h.count ? h.min : null,
            p10: quantile(0.1), median: quantile(0.5), p90: quantile(0.9), max: h.count ? h.max : null, distribution: values };
    };
    return perEmotion(emotion => statistics(week[emotion]));
}
/** Freeze a population's rank prefixes before later grades join it. */
function ranks(population) {
    const freeze = (h) => {
        const prefix = [0];
        for (const n of h.bins)
            prefix.push(prefix.at(-1) + n);
        return { count: h.count, mean: (h.sum + h.carry) / h.count, prefix };
    };
    return perEmotion(emotion => freeze(population[emotion]));
}
function compare(row, population, minimum) {
    const count = population.joy.count;
    if (count < minimum)
        return { status: "insufficient_history", count, emotions: null };
    const deviation = (emotion) => {
        const score = Number(row[emotion]), { mean, prefix } = population[emotion], b = bin(score);
        // Midrank keeps a tied, constant baseline at 0.5 rather than treating every tie as extreme.
        const percentile = (prefix[b] + (prefix[b + 1] - prefix[b]) / 2) / count;
        return { delta: score - mean, percentile, unusualness: Math.abs(2 * percentile - 1) };
    };
    return { status: "ok", count, emotions: perEmotion(deviation) };
}
/** Queue writes and commit them in short IMMEDIATE transactions. Only call between completed reads. */
function batches(db) {
    const pending = [];
    const flush = () => {
        if (!pending.length)
            return;
        immediateTransaction(db, () => { for (const write of pending)
            write(); });
        pending.length = 0;
    };
    return { write(change) { pending.push(change); if (pending.length >= BATCH)
            flush(); }, flush };
}
/**
 * One current, content-addressed snapshot per person, rubric, model and completed week.
 * Reads finish before each batch commits, so the shared store is never held for a whole pass.
 * No inference and no changes to raw grades.
 */
export function refreshEmotionBaselines(db, options) {
    const now = options.now ?? Date.now(), cutoff = weekStart(now), minimum = options.minInteractions;
    if (!Number.isFinite(now) || !Number.isInteger(minimum) || minimum < 1)
        throw new Error("Invalid baseline settings");
    initializeEmotionBaselines(db);
    let snapshots = 0, comparisons = 0;
    const queue = batches(db), people = tableExists(db, "people");
    const prior = db.prepare(`SELECT id,result_json,json_extract(result_json,'$.status') status FROM inside_out_deviations
    WHERE interaction_id=? AND rubric=? AND grade_signature=? ORDER BY assessed_at DESC,rowid DESC LIMIT 1`);
    const save = db.prepare("INSERT OR IGNORE INTO inside_out_deviations VALUES (?,?,?,?,?,?,?,?)");
    const grade = db.prepare(`SELECT ${GRADE} FROM inside_out WHERE interaction_id=? AND rubric=?`);
    const assess = (row, signature, decide) => {
        const previous = prior.get(row.interaction_id, row.rubric, signature);
        // An existing assessment stands for its grade, except future_time: that only described the clock.
        if (!options.recompare && previous && previous.status !== "future_time")
            return;
        const result = { version: VERSION, status: "insufficient_history", personId: row.person_id === null ? null : String(row.person_id),
            baselineId: null, baselineEnd: null, assessedAt: now, minInteractions: minimum, cumulative: null, weekly: null };
        decide(result);
        const key = (assessment) => jsonHash([assessment.version, signature, assessment.baselineId, assessment.status, assessment.minInteractions]);
        if (previous && key(JSON.parse(String(previous.result_json))) === key(result))
            return;
        // Chaining records permits an explicit return to an earlier baseline without
        // selecting an obsolete intervening assessment or losing either observation.
        const id = jsonHash([key(result), previous?.id ?? null]);
        queue.write(() => {
            // Rechecked under the write lock: a purge, regrade or relink committed since the read wins.
            const current = grade.get(row.interaction_id, row.rubric);
            if (!current || gradeSignature(current) !== signature)
                return;
            comparisons += Number(save.run(id, row.interaction_id, row.rubric, signature, now, result.baselineId, result.personId, JSON.stringify(result)).changes);
        });
    };
    const populations = new Set();
    if (people) {
        const stored = db.prepare("SELECT week_start,id FROM person_emotion_baselines WHERE person_id=? AND rubric=? AND model=?");
        const upsert = db.prepare(`INSERT INTO person_emotion_baselines VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(person_id,rubric,model,week_start) DO UPDATE SET id=excluded.id,version=excluded.version,
      week_end=excluded.week_end,computed_at=excluded.computed_at,weekly_json=excluded.weekly_json`);
        const remove = db.prepare("DELETE FROM person_emotion_baselines WHERE person_id=? AND rubric=? AND model=? AND week_start=? AND id=?");
        const populated = db.prepare("SELECT 1 FROM inside_out WHERE person_id=? AND rubric=? AND model=? LIMIT 1");
        const page = db.prepare(`SELECT ${GRADE} FROM inside_out e WHERE e.person_id=? AND e.rubric=? AND e.model=? AND ${COMPARABLE}
      AND (? IS NULL OR e.target_at>? OR (e.target_at=? AND e.interaction_id>?)) ORDER BY e.target_at,e.interaction_id LIMIT ?`);
        const groups = db.prepare(`SELECT DISTINCT e.person_id,e.rubric,e.model FROM inside_out e JOIN people p ON p.id=e.person_id
      WHERE ${COMPARABLE}`).all(now, now);
        for (const group of groups) {
            const { person_id: person, rubric, model } = group;
            populations.add(JSON.stringify([person, rubric, model]));
            const existing = new Map(stored.all(person, rubric, model).map(row => [Number(row.week_start), String(row.id)]));
            function* rows() {
                let last;
                for (;;) {
                    const batch = page.all(person, rubric, model, now, now, last?.target_at ?? null, last?.target_at ?? null, last?.target_at ?? null, last?.interaction_id ?? null, PAGE);
                    yield* batch;
                    if (batch.length < PAGE)
                        return;
                    last = batch.at(-1);
                }
            }
            const source = rows();
            let next = source.next(), previous;
            const cumulative = histograms(), current = new Set();
            for (let start = next.done ? cutoff : weekStart(Number(next.value.target_at)); !next.done || start < cutoff; start += WEEK) {
                const end = start + WEEK, weekly = histograms(), signatures = [];
                // Grades compare only with completed weeks before their own; this week joins afterwards.
                let frozen;
                while (!next.done && Number(next.value.target_at) < end) {
                    const row = next.value, signature = gradeSignature(row);
                    assess(row, signature, result => {
                        if (!previous)
                            return;
                        frozen ??= { cumulative: ranks(cumulative), weekly: ranks(previous.weekly) };
                        result.baselineId = previous.id;
                        result.baselineEnd = previous.end;
                        result.cumulative = compare(row, frozen.cumulative, minimum);
                        result.weekly = compare(row, frozen.weekly, minimum);
                        result.status = result.cumulative.status;
                    });
                    if (start < cutoff) {
                        signatures.push(signature);
                        add(weekly, row);
                    }
                    next = source.next();
                }
                if (start >= cutoff)
                    continue;
                merge(cumulative, weekly);
                // Chained ids address the whole cumulative population without rehashing earlier weeks.
                // Empty weeks are kept: a weekly comparison always means the preceding calendar week.
                const id = jsonHash([VERSION, person, rubric, model, start, previous?.id ?? null, signatures]), json = encode(weekly);
                current.add(start);
                if (existing.get(start) !== id)
                    queue.write(() => {
                        // A purge of this person since the read leaves no linked grades: never restore their distribution.
                        if (populated.get(person, rubric, model))
                            snapshots += Number(upsert.run(person, rubric, model, start, id, VERSION, end, now, json).changes);
                    });
                previous = { id, end, weekly };
            }
            // Weeks no longer backed by linked grades are replaced, not retained as revisions.
            for (const [start, id] of existing)
                if (!current.has(start))
                    queue.write(() => { remove.run(person, rubric, model, start, id); });
        }
    }
    // Populations without linked grades (removed identity or person) lose their snapshots.
    const drop = db.prepare("DELETE FROM person_emotion_baselines WHERE person_id=? AND rubric=? AND model=?");
    for (const row of db.prepare("SELECT DISTINCT person_id,rubric,model FROM person_emotion_baselines").all()) {
        if (!populations.has(JSON.stringify([row.person_id, row.rubric, row.model])))
            queue.write(() => { drop.run(row.person_id, row.rubric, row.model); });
    }
    // Everything not comparable records an explicit status, never a neutral score.
    const comparable = people ? `coalesce(${COMPARABLE} AND EXISTS (SELECT 1 FROM people p WHERE p.id=e.person_id),0)` : "0";
    const linked = people ? db.prepare("SELECT 1 FROM people WHERE id=?") : undefined;
    const others = db.prepare(`SELECT rowid AS _rowid,* FROM inside_out e WHERE e.reviewed_at<=? AND e.rowid>?
    AND (e.error IS NULL OR e.error<>?) AND NOT ${comparable} ORDER BY e.rowid LIMIT ?`);
    for (let last = -Infinity;;) {
        const batch = others.all(now, last, PURGED_GRADE, ...(people ? [now, now] : []), PAGE);
        for (const row of batch) {
            assess(row, gradeSignature(row), result => {
                if (row.error !== null || !INSIDE_OUT_EMOTIONS.every(e => typeof row[e] === "number" && Number.isFinite(row[e]) && row[e] >= 0 && row[e] <= 1))
                    result.status = "grade_failed";
                else if (!row.person_id || !linked?.get(row.person_id))
                    result.status = "unlinked_person";
                else if (row.target_at === null)
                    result.status = "missing_time";
                else
                    result.status = "future_time";
            });
        }
        if (batch.length < PAGE)
            break;
        last = Number(batch.at(-1)._rowid);
        queue.flush();
    }
    queue.flush();
    return { snapshots, comparisons };
}
/** Prepared once per export, not per row. */
export function deviationReader(db) {
    const entries = schemaVersion(db) === 2 ? db.prepare(`SELECT grade_signature,result_json FROM inside_out_deviations
    WHERE interaction_id=? AND rubric=? ORDER BY assessed_at DESC,rowid DESC`) : undefined;
    return (row, history = false) => {
        if (!entries)
            return { status: "not_compared" };
        const all = entries.all(row.interaction_id, row.rubric);
        const signature = gradeSignature(row), latest = all.find(entry => entry.grade_signature === signature);
        const current = latest ? JSON.parse(String(latest.result_json)) : { status: "not_compared" };
        return history ? { ...current, history: all.map(entry => {
                const result = JSON.parse(String(entry.result_json));
                return { ...result, currentGrade: entry.grade_signature === signature };
            }) } : current;
    };
}
/**
 * Weekly snapshots, newest first; cumulative statistics are prefix sums of each population's stored weeks.
 * `since` keeps weeks whose last day is on or after that UTC date (`week_end` is the exclusive next Monday).
 */
export function emotionBaselineHistory(db, options = {}) {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("Baseline limit must be between 1 and 1000");
    if (schemaVersion(db) !== 2)
        return [];
    // One read snapshot: a concurrent refresh may replace or drop weeks between the two queries.
    db.exec("BEGIN");
    try {
        return readBaselineHistory(db, options, limit);
    }
    finally {
        db.exec("COMMIT");
    }
}
function readBaselineHistory(db, options, limit) {
    const selected = db.prepare(`SELECT person_id,rubric,model,week_start FROM person_emotion_baselines
    WHERE (? IS NULL OR person_id=?) AND (? IS NULL OR week_end>?) ORDER BY week_end DESC,person_id,rubric,model LIMIT ?`)
        .all(options.personId ?? null, options.personId ?? null, options.since ?? null, options.since ?? null, limit);
    const wanted = new Map();
    for (const row of selected) {
        const population = JSON.stringify([row.person_id, row.rubric, row.model]);
        wanted.set(population, (wanted.get(population) ?? new Set()).add(Number(row.week_start)));
    }
    const weeks = db.prepare("SELECT * FROM person_emotion_baselines WHERE person_id=? AND rubric=? AND model=? ORDER BY week_start");
    const snapshots = new Map();
    const snapshot = (row, weekly, cumulative) => ({ id: String(row.id), person_id: String(row.person_id),
        rubric: String(row.rubric), model: String(row.model), version: String(row.version), week_start: Number(row.week_start),
        week_end: Number(row.week_end), computed_at: Number(row.computed_at), weekly: summarize(weekly), cumulative: summarize(cumulative) });
    for (const [population, starts] of wanted) {
        const cumulative = histograms(), latest = Math.max(...starts);
        for (const row of weeks.all(...JSON.parse(population))) {
            const weekly = decode(String(row.weekly_json));
            merge(cumulative, weekly);
            if (starts.has(Number(row.week_start)))
                snapshots.set(JSON.stringify([population, row.week_start]), snapshot(row, weekly, cumulative));
            if (Number(row.week_start) >= latest)
                break;
        }
    }
    return selected.map(row => snapshots.get(JSON.stringify([JSON.stringify([row.person_id, row.rubric, row.model]), row.week_start])));
}
/**
 * Changes whenever a refresh input could: grades, links, people, stored results, the current week,
 * grades crossing `now`, or settings. Equal fingerprints mean a refresh would write nothing.
 */
export function baselineFingerprint(db, options) {
    const digest = createHash("sha256").update(JSON.stringify([VERSION, schemaVersion(db) ?? null, weekStart(options.now), options.minInteractions]));
    for (const table of ["people", "person_emotion_baselines", "inside_out_deviations"]) {
        digest.update(`|${tableExists(db, table) ? Number(db.prepare(`SELECT count(*) n FROM ${table}`).get().n) : -1}`);
    }
    if (tableExists(db, "inside_out")) {
        const timing = db.prepare("SELECT count(*) n,sum(target_at<=?) due,sum(reviewed_at<=?) reviewed FROM inside_out").get(options.now, options.now);
        digest.update(`|${timing.n},${timing.due},${timing.reviewed}`);
        // Regrades rewrite reviewed_at; links and purges rewrite person_id and error.
        for (const row of db.prepare("SELECT rowid,person_id,reviewed_at,error IS NULL ok FROM inside_out ORDER BY rowid").iterate()) {
            digest.update(`|${row.rowid},${row.person_id},${row.reviewed_at},${row.ok}`);
        }
    }
    return digest.digest("hex");
}
/**
 * Delete one person's baselines and assessment history. With `grades`, also erase their six
 * probabilities and person link, keeping a tombstone so the reply is never sent to Jev again.
 */
export function purgeEmotionProfile(db, personId, options = {}) {
    const counts = { baselines: 0, assessments: 0, grades: 0 };
    if (!tableExists(db, "inside_out"))
        return counts;
    initializeEmotionBaselines(db);
    return immediateTransaction(db, () => {
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
