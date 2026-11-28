import { DEFAULTS } from "./defaults.js";
import { createHash } from "node:crypto";
import { immediateTransaction, readTableColumns, tableExists } from "./memory-database.js";
import { jsonHash } from "./json-hash.js";
export const INSIDE_OUT_EMOTIONS = ["joy", "sadness", "fear", "anger", "disgust", "surprise"];
/** Derived signed valence: joy against the strongest negative emotion, in -1..1. */
export const INSIDE_OUT_VALENCE_SQL = "joy-max(sadness,fear,anger,disgust)";
/** Stored valence where that column exists (NULL on grades written before it), else the derived formula. */
export const insideOutValenceSql = (storedColumn) => storedColumn ? `coalesce(valence,${INSIDE_OUT_VALENCE_SQL})` : INSIDE_OUT_VALENCE_SQL;
/** Float tolerance for midrank ties between stored expected scores. */
export const MIDRANK_TIE_EPSILON = 1e-9;
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
const BATCH = DEFAULTS.insideOut.batchSize;
const PAGE = DEFAULTS.insideOut.readPageSize;
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
    if (schemaVersion(db) === 2 && tableExists(db, "inside_out_person_generations"))
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
    CREATE TABLE IF NOT EXISTS inside_out_person_generations (
      person_id TEXT PRIMARY KEY, generation INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS inside_out_deviations_interaction ON inside_out_deviations(interaction_id,rubric);
    CREATE INDEX IF NOT EXISTS inside_out_deviations_person ON inside_out_deviations(person_id);
    INSERT OR REPLACE INTO memory_schema VALUES ('emotion-baselines',2);`);
    });
}
/** Identity of one grade's inputs; an `inside_out_deviations` row describes a grade only while signatures match. */
export function gradeSignature(row) {
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
const EMPTY_POPULATION_DIGEST = createHash("sha256").digest("hex");
function readSnapshot(db, fn) {
    db.exec("BEGIN");
    try {
        const result = fn();
        db.exec("COMMIT");
        return result;
    }
    catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}
/** Queue writes and commit them in short IMMEDIATE transactions. Only call between completed reads. */
function batches(db) {
    const pending = [];
    const flush = () => {
        if (!pending.length)
            return;
        const tx = { populationDigests: new Map(), personGenerations: new Map() };
        immediateTransaction(db, () => { for (const write of pending)
            write(tx); });
        pending.length = 0;
    };
    return { write(change) { pending.push(change); if (pending.length >= BATCH)
            flush(); }, flush };
}
function loadPersonGenerations(db) {
    const generations = new Map();
    for (const row of db.prepare("SELECT person_id,generation FROM inside_out_person_generations").iterate()) {
        generations.set(String(row.person_id), Number(row.generation));
    }
    return generations;
}
function getPersonGeneration(tx, readGeneration, personId) {
    let cached = tx.personGenerations.get(personId);
    if (cached === undefined) {
        const row = readGeneration.get(personId);
        cached = row === undefined ? 0 : Number(row.generation);
        tx.personGenerations.set(personId, cached);
    }
    return cached;
}
function loadPopulationDigests(db, person, rubric, model, now) {
    if (!tableExists(db, "people"))
        return { totalRows: 0, checkpoints: [] };
    const rows = db.prepare(`SELECT ${GRADE} FROM inside_out e JOIN people p ON p.id=e.person_id
    WHERE e.person_id=? AND e.rubric=? AND e.model=? AND ${COMPARABLE}
    ORDER BY e.target_at,e.interaction_id`).iterate(person, rubric, model, now, now);
    const digest = createHash("sha256");
    const checkpoints = [];
    let totalRows = 0;
    let currentEnd;
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
function getPopulationDigests(tx, db, person, rubric, model, now) {
    const key = JSON.stringify([person, rubric, model]);
    let cached = tx.populationDigests.get(key);
    if (!cached) {
        cached = loadPopulationDigests(db, person, rubric, model, now);
        tx.populationDigests.set(key, cached);
    }
    return cached;
}
function populationPrefixDigest(tx, db, person, rubric, model, now, end) {
    const cached = getPopulationDigests(tx, db, person, rubric, model, now);
    if (cached.totalRows === 0)
        return end === Infinity ? EMPTY_POPULATION_DIGEST : null;
    let match = null;
    for (const checkpoint of cached.checkpoints) {
        if (checkpoint.end <= end)
            match = checkpoint.digest;
        else
            break;
    }
    return match;
}
function createGradeAssessor(db, queue, options, personGenerationMatches, onComparison) {
    const { now, minimum, recompare } = options;
    const prior = db.prepare(`SELECT id,result_json,json_extract(result_json,'$.status') status FROM inside_out_deviations
    WHERE interaction_id=? AND rubric=? AND grade_signature=? ORDER BY assessed_at DESC,rowid DESC LIMIT 1`);
    const save = db.prepare("INSERT OR IGNORE INTO inside_out_deviations VALUES (?,?,?,?,?,?,?,?)");
    const grade = db.prepare(`SELECT ${GRADE} FROM inside_out WHERE interaction_id=? AND rubric=?`);
    return (row, signature, decide, fence) => {
        const previous = prior.get(row.interaction_id, row.rubric, signature);
        // An existing assessment stands for its grade, except future_time: that only described the clock.
        if (!recompare && previous && previous.status !== "future_time")
            return;
        const personId = row.person_id === null ? null : String(row.person_id);
        const result = { version: VERSION, status: "insufficient_history", personId,
            baselineId: null, baselineEnd: null, assessedAt: now, minInteractions: minimum, cumulative: null, weekly: null };
        decide(result);
        const key = (assessment) => jsonHash([assessment.version, signature, assessment.baselineId, assessment.status, assessment.minInteractions]);
        if (previous && key(JSON.parse(String(previous.result_json))) === key(result))
            return;
        // Chaining records permits an explicit return to an earlier baseline without
        // selecting an obsolete intervening assessment or losing either observation.
        const id = jsonHash([key(result), previous?.id ?? null]);
        queue.write(tx => {
            // Rechecked under the write lock: a purge, regrade, relink, or population-prefix change wins.
            if (personId !== null && !personGenerationMatches(tx, personId))
                return;
            if (fence && !fence(tx))
                return;
            const current = grade.get(row.interaction_id, row.rubric);
            if (!current || gradeSignature(current) !== signature)
                return;
            onComparison(Number(save.run(id, row.interaction_id, row.rubric, signature, now, result.baselineId, result.personId, JSON.stringify(result)).changes));
        });
    };
}
function* iterateComparableGrades(page, person, rubric, model, now) {
    let last;
    for (;;) {
        const batch = page.all(person, rubric, model, now, now, last?.target_at ?? null, last?.target_at ?? null, last?.target_at ?? null, last?.interaction_id ?? null, PAGE);
        yield* batch;
        if (batch.length < PAGE)
            return;
        last = batch.at(-1);
    }
}
function refreshPopulation(db, queue, assess, statements, group, options, personGenerationMatches, onSnapshot) {
    const { person, rubric, model } = group;
    const personId = String(person);
    const { now, cutoff, minimum } = options;
    /** Whether this population's committed grades up to `end` still hash to what this pass read. */
    const prefixMatches = (tx, end, expected) => populationPrefixDigest(tx, db, person, rubric, model, now, end) === expected;
    const existing = new Map(statements.stored.all(person, rubric, model).map(row => [Number(row.week_start), String(row.id)]));
    const source = iterateComparableGrades(statements.page, person, rubric, model, now);
    let next = source.next(), previous;
    const cumulative = histograms(), current = new Set();
    const seenDigest = createHash("sha256");
    let seenCount = 0;
    for (let start = next.done ? cutoff : weekStart(Number(next.value.target_at)); !next.done || start < cutoff; start += WEEK) {
        const end = start + WEEK, weekly = histograms(), signatures = [];
        const previousEnd = previous ? previous.end : start;
        const previousExpectedPrefix = previous ? previous.expectedPrefix : null;
        const prefixFence = tx => prefixMatches(tx, previousEnd, previousExpectedPrefix);
        // Grades compare only with completed weeks before their own; this week joins afterwards.
        let frozen;
        while (!next.done && Number(next.value.target_at) < end) {
            const row = next.value, signature = gradeSignature(row);
            seenDigest.update(`|${signature}`);
            seenCount++;
            assess(row, signature, result => {
                if (!previous)
                    return;
                frozen ??= { cumulative: ranks(cumulative), weekly: ranks(previous.weekly) };
                result.baselineId = previous.id;
                result.baselineEnd = previous.end;
                result.cumulative = compare(row, frozen.cumulative, minimum);
                result.weekly = compare(row, frozen.weekly, minimum);
                result.status = result.cumulative.status;
            }, prefixFence);
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
        const expectedPrefix = seenDigest.copy().digest("hex");
        current.add(start);
        if (existing.get(start) !== id) {
            const hasSeenGrades = seenCount > 0;
            queue.write(tx => {
                // Fence against concurrent purges, relinks, regrades, or new grades affecting this week's prefix.
                if (hasSeenGrades &&
                    personGenerationMatches(tx, personId) &&
                    prefixMatches(tx, end, expectedPrefix)) {
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
                if (personGenerationMatches(tx, personId) &&
                    prefixMatches(tx, Infinity, expectedFull)) {
                    statements.remove.run(person, rubric, model, start, id);
                }
            });
        }
    }
}
function assessNonComparableGrades(db, queue, assess, options) {
    const { people, now } = options;
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
    const expectedGenerations = options.expectedGenerations ?? loadPersonGenerations(db);
    const readGeneration = db.prepare("SELECT generation FROM inside_out_person_generations WHERE person_id=?");
    const personGenerationMatches = (tx, personId) => getPersonGeneration(tx, readGeneration, personId) === (expectedGenerations.get(personId) ?? 0);
    let snapshots = 0, comparisons = 0;
    const queue = batches(db), people = tableExists(db, "people");
    const assess = createGradeAssessor(db, queue, { now, minimum, recompare: options.recompare }, personGenerationMatches, changes => { comparisons += changes; });
    const populations = new Set();
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
                if (personGenerationMatches(tx, personId) &&
                    getPopulationDigests(tx, db, row.person_id, row.rubric, row.model, now).totalRows === 0) {
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
    return readSnapshot(db, () => readBaselineHistory(db, options, limit));
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
function computeBaselineInputSnapshot(db, options) {
    const digest = createHash("sha256").update(JSON.stringify([VERSION, weekStart(options.now), options.minInteractions]));
    if (tableExists(db, "people")) {
        let count = 0;
        digest.update("|people:");
        for (const row of db.prepare("SELECT id FROM people ORDER BY id").iterate()) {
            digest.update(`${JSON.stringify(row.id)},`);
            count++;
        }
        digest.update(`#${count}`);
    }
    else {
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
    }
    else {
        digest.update("|identities:-1");
    }
    if (tableExists(db, "inside_out")) {
        const timing = db.prepare("SELECT count(*) n,sum(target_at<=?) due,sum(reviewed_at<=?) reviewed FROM inside_out").get(options.now, options.now);
        digest.update(`|grades:${timing.n},${timing.due},${timing.reviewed}`);
        // Regrades rewrite reviewed_at; links, time edits and purges rewrite person_id, target_at and error.
        for (const row of db.prepare("SELECT rowid,person_id,target_at,reviewed_at,error FROM inside_out ORDER BY rowid").iterate()) {
            digest.update(`|${JSON.stringify([row.rowid, row.person_id, row.target_at, row.reviewed_at, row.error])}`);
        }
    }
    else {
        digest.update("|grades:-1");
    }
    const personGenerations = new Map();
    digest.update("|generations:");
    let generationCount = 0;
    if (tableExists(db, "inside_out_person_generations")) {
        for (const row of db.prepare("SELECT person_id,generation FROM inside_out_person_generations ORDER BY person_id").iterate()) {
            const personId = String(row.person_id);
            const generation = Number(row.generation);
            personGenerations.set(personId, generation);
            digest.update(`${JSON.stringify([personId, generation])},`);
            generationCount++;
        }
    }
    digest.update(`#${generationCount}`);
    return { inputFingerprint: digest.digest("hex"), personGenerations };
}
function computeBaselineFingerprintFromInput(db, inputFingerprint) {
    const digest = createHash("sha256").update(JSON.stringify([inputFingerprint, schemaVersion(db) ?? null]));
    for (const table of ["person_emotion_baselines", "inside_out_deviations"]) {
        digest.update(`|${tableExists(db, table) ? Number(db.prepare(`SELECT count(*) n FROM ${table}`).get().n) : -1}`);
    }
    return digest.digest("hex");
}
/**
 * Snapshot of refresh inputs only (settings, current week, People tables, grades, and purge generations).
 * Captures input fingerprint and per-person purge generations in one read snapshot so purges committing
 * after the pre-pass snapshot are fenced out before refreshEmotionBaselines runs.
 */
export function baselineInputSnapshot(db, options) {
    return readSnapshot(db, () => computeBaselineInputSnapshot(db, options));
}
/**
 * Computes input fingerprint, full fingerprint, and purge generations inside one consistent SQLite
 * read snapshot so pre-pass fencing and post-pass certification never mix pre- and post-commit state.
 */
export function baselineFingerprints(db, options) {
    return readSnapshot(db, () => {
        const { inputFingerprint, personGenerations } = computeBaselineInputSnapshot(db, options);
        return {
            inputFingerprint,
            fullFingerprint: computeBaselineFingerprintFromInput(db, inputFingerprint),
            personGenerations,
        };
    });
}
/**
 * Changes whenever a refresh input could: grades, links, people, purge generations, stored results,
 * the current week, grades crossing `now`, or settings. Equal fingerprints mean a refresh would write nothing.
 */
export function baselineFingerprint(db, options) {
    return baselineFingerprints(db, options).fullFingerprint;
}
/**
 * Delete one person's baselines and assessment history. With `grades`, also erase their six
 * probabilities and person link, keeping a tombstone so the reply is never sent to the decision model again, and scrub
 * the emotion values other ledgers derived from those grades: Captain's Log salience grounded on a purged message
 * (the log text stays) and Inside Out signals on Outcome Ledger rows in a purged session (verdicts stay).
 */
export function purgeEmotionProfile(db, personId, options = {}) {
    const counts = { baselines: 0, assessments: 0, grades: 0, captainsLogEntries: 0, outcomes: 0 };
    if (!tableExists(db, "inside_out"))
        return counts;
    initializeEmotionBaselines(db);
    return immediateTransaction(db, () => {
        db.prepare(`INSERT INTO inside_out_person_generations (person_id, generation) VALUES (?, 1)
      ON CONFLICT(person_id) DO UPDATE SET generation = generation + 1`).run(personId);
        if (options.grades) {
            // Collected before the tombstone clears the link: these are the only grades the derived ledgers could cite.
            const purged = db.prepare("SELECT DISTINCT session_id, message_id FROM inside_out WHERE person_id=?").all(personId)
                .map(row => [String(row.session_id), String(row.message_id)]);
            counts.assessments += Number(db.prepare(`DELETE FROM inside_out_deviations WHERE (interaction_id,rubric) IN
        (SELECT interaction_id,rubric FROM inside_out WHERE person_id=?)`).run(personId).changes);
            // Intensity, its distribution and valence are person-scoped emotion data too; drift reads only these columns.
            const present = readTableColumns(db, "inside_out");
            const derived = PURGED_COLUMNS.filter(column => present.has(column));
            counts.grades = Number(db.prepare(`UPDATE inside_out SET ${[...INSIDE_OUT_EMOTIONS, ...derived].map(e => `${e}=NULL`).join(",")},
        error=?,person_id=NULL WHERE person_id=?`).run(PURGED_GRADE, personId).changes);
            if (purged.length)
                Object.assign(counts, scrubDerivedEmotion(db, purged));
        }
        counts.assessments += Number(db.prepare("DELETE FROM inside_out_deviations WHERE person_id=?").run(personId).changes);
        counts.baselines = Number(db.prepare("DELETE FROM person_emotion_baselines WHERE person_id=?").run(personId).changes);
        return counts;
    });
}
const CAPTAINS_LOG_SALIENCE = ["salience_score", "emotional_intensity", "relative_salience", "salience_signals_json"];
const OUTCOME_EMOTION_SIGNALS = ["insideOutValence", "insideOutIntensity", "insideOutDelta", "sharpDrop"];
/** Removes derived emotion values that cite purged `(session_id, message_id)` grades; runs inside the purge transaction. */
function scrubDerivedEmotion(db, purged) {
    const scrubbed = { captainsLogEntries: 0, outcomes: 0 };
    const pairs = JSON.stringify(purged), sessions = JSON.stringify([...new Set(purged.map(([session]) => session))]);
    const logColumns = readTableColumns(db, "captains_log_entries");
    if (logColumns.has("salience_signals_json")) {
        const columns = CAPTAINS_LOG_SALIENCE.filter(column => logColumns.has(column));
        scrubbed.captainsLogEntries = Number(db.prepare(`UPDATE captains_log_entries SET ${columns.map(c => `${c}=NULL`).join(",")}
      WHERE json_valid(salience_signals_json) AND EXISTS (
        SELECT 1 FROM json_each(salience_signals_json,'$.signals') s JOIN json_each(?) p
        ON json_extract(s.value,'$.sessionId')=json_extract(p.value,'$[0]') AND json_extract(s.value,'$.messageId')=json_extract(p.value,'$[1]'))`)
            .run(pairs).changes);
    }
    const outcomeColumns = readTableColumns(db, "memory_outcomes");
    if (["session_id", "signals_json"].every(column => outcomeColumns.has(column))) {
        // Outcome rows record the session, not the graded message: scrub every Inside Out reading in a purged session.
        const paths = OUTCOME_EMOTION_SIGNALS.map(key => `'$.${key}'`).join(",");
        scrubbed.outcomes = Number(db.prepare(`UPDATE memory_outcomes SET signals_json=json_remove(signals_json,${paths})
      WHERE session_id IN (SELECT value FROM json_each(?)) AND json_valid(signals_json)
        AND (${OUTCOME_EMOTION_SIGNALS.map(key => `json_type(signals_json,'$.${key}') IS NOT NULL`).join(" OR ")})`)
            .run(sessions).changes);
    }
    return scrubbed;
}
const PURGED_COLUMNS = ["intensity", "intensity_probs_json", "intensity_rubric", "valence"];
const mean = (values) => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
// ---------------------------------------------------------------------------------------------------------------
// Unsigned intensity: absolute 0..3 level, kept separate from its one-sided person-relative position.
// ---------------------------------------------------------------------------------------------------------------
const INTENSITY_VERSION = "intensity-upper-tail-v1";
/**
 * One-sided upper-tail intensity relative to the person's own earlier grades. Prepared once per export.
 * A stoic person's rare 2 lands near the top of their distribution even though it is only "clear" in absolute terms.
 */
export function intensityReader(db, options = {}) {
    const minimum = options.minInteractions ?? DEFAULTS.insideOut.defaultBaselineMinInteractions;
    if (!Number.isInteger(minimum) || minimum < 1)
        throw new Error("Invalid intensity minInteractions");
    const columns = readTableColumns(db, "inside_out");
    const available = columns.has("intensity") && columns.has("person_id");
    const prior = available ? db.prepare(`SELECT count(*) n,avg(intensity) mean,
      coalesce(sum(intensity<:value-${MIDRANK_TIE_EPSILON}),0) below,coalesce(sum(abs(intensity-:value)<=${MIDRANK_TIE_EPSILON}),0) tied
    FROM inside_out WHERE person_id=:person AND rubric=:rubric AND model=:model AND intensity_rubric IS :intensityRubric
      AND error IS NULL AND intensity IS NOT NULL AND target_at IS NOT NULL AND target_at<:at`) : undefined;
    return (row) => {
        const value = typeof row.intensity === "number" && Number.isFinite(row.intensity) ? row.intensity : null;
        const result = { version: INTENSITY_VERSION, status: "ok", absoluteIntensity: value, count: 0,
            minInteractions: minimum, intensityMean: null, intensityPercentile: null, intensitySpike: null };
        if (row.error !== null && row.error !== undefined)
            return { ...result, status: "grade_failed" };
        if (value === null)
            return { ...result, status: "unknown_intensity" };
        if (row.person_id === null || row.person_id === undefined)
            return { ...result, status: "unlinked_person" };
        if (row.target_at === null || row.target_at === undefined)
            return { ...result, status: "missing_time" };
        const stats = prior.get({ person: row.person_id, rubric: row.rubric ?? null, model: row.model ?? null,
            intensityRubric: row.intensity_rubric ?? null, at: row.target_at, value });
        const count = Number(stats.n), average = count ? Number(stats.mean) : null;
        if (count < minimum)
            return { ...result, status: "insufficient_history", count, intensityMean: average };
        return { ...result, count, intensityMean: average,
            intensityPercentile: (Number(stats.below) + Number(stats.tied) / 2) / count,
            intensitySpike: Math.max(0, value - average) };
    };
}
/** Per-person absolute intensity distribution (0..3), from grades that carry one. Old NULL rows are excluded, not zero. */
export function intensityProfiles(db, options = {}) {
    const columns = readTableColumns(db, "inside_out");
    if (!columns.has("intensity") || !columns.has("person_id"))
        return [];
    const rows = db.prepare(`SELECT person_id,intensity_rubric,intensity,target_at FROM inside_out
    WHERE person_id IS NOT NULL AND (? IS NULL OR person_id=?) AND error IS NULL AND intensity IS NOT NULL
      AND target_at IS NOT NULL AND target_at<=? ORDER BY person_id,intensity_rubric,intensity`)
        .all(options.personId ?? null, options.personId ?? null, options.now ?? Date.now());
    const groups = new Map();
    for (const row of rows) {
        const key = JSON.stringify([row.person_id, row.intensity_rubric]);
        let group = groups.get(key);
        if (!group)
            groups.set(key, group = { personId: String(row.person_id), intensityRubric: String(row.intensity_rubric ?? ""),
                values: [], firstAt: Infinity, lastAt: -Infinity });
        group.values.push(Number(row.intensity));
        group.firstAt = Math.min(group.firstAt, Number(row.target_at));
        group.lastAt = Math.max(group.lastAt, Number(row.target_at));
    }
    const quantile = (sorted, p) => {
        const position = (sorted.length - 1) * p, lower = Math.floor(position);
        return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
    };
    return [...groups.values()].map(({ values, ...group }) => ({ ...group, count: values.length, mean: mean(values),
        median: quantile(values, 0.5), p90: quantile(values, 0.9), max: values.at(-1) }));
}
// ---------------------------------------------------------------------------------------------------------------
// Boiling-frog drift: recent absolute levels against an anchored early baseline, never a rolling window.
// ---------------------------------------------------------------------------------------------------------------
export const SENTIMENT_DRIFT_METRICS = ["valence", "anger", "agent_frustration", "agent_dissatisfaction"];
/** valence (-1..1) worsens downward; Inside Out anger and Response Audit agent frustration (0..1) and dissatisfaction (0..3) upward. */
const LOWER_IS_WORSE = {
    valence: true, anger: false, agent_frustration: false, agent_dissatisfaction: false,
};
const DEFAULT_SENTIMENT_DRIFT = {
    recentWeeks: 3,
    anchorWeeks: 4,
    minWeeklySamples: 1,
    minAnchorSamples: 5,
    minRecentSamples: 3,
    driftThresholds: { valence: 0.2, anger: 0.15, agent_frustration: 0.15, agent_dissatisfaction: 0.5 },
    levelThresholds: { valence: -0.3, anger: 0.5, agent_frustration: 0.5, agent_dissatisfaction: 1.5 },
};
function positiveInteger(value, name) {
    if (!Number.isInteger(value) || value < 1)
        throw new Error(`Invalid sentiment drift ${name}`);
    return value;
}
function thresholdMap(defaults, overrides, name) {
    const merged = { ...defaults, ...overrides };
    for (const metric of SENTIMENT_DRIFT_METRICS) {
        const value = merged[metric];
        if (value !== null && !Number.isFinite(value))
            throw new Error(`Invalid sentiment drift ${name}.${metric}`);
    }
    return merged;
}
function driftSamples(db, options) {
    const samples = new Map(SENTIMENT_DRIFT_METRICS.map(metric => [metric, []]));
    const columns = readTableColumns(db, "inside_out");
    if (!columns.has("person_id"))
        return samples;
    const person = options.personId ?? null;
    const valence = insideOutValenceSql(columns.has("valence"));
    // One sample per reply: an interaction regraded under several rubrics must not count twice.
    for (const row of db.prepare(`SELECT person_id,min(target_at) at,avg(${valence}) valence,avg(anger) anger FROM inside_out
    WHERE person_id IS NOT NULL AND (? IS NULL OR person_id=?) AND (? IS NULL OR rubric=?) AND error IS NULL
      AND target_at IS NOT NULL AND target_at<=? AND ${INSIDE_OUT_EMOTIONS.map(e => `${e} BETWEEN 0 AND 1`).join(" AND ")}
    GROUP BY interaction_id,person_id`).iterate(person, person, options.rubric ?? null, options.rubric ?? null, options.now)) {
        const base = { personId: String(row.person_id), at: Number(row.at) };
        samples.get("valence").push({ ...base, value: Number(row.valence) });
        samples.get("anger").push({ ...base, value: Number(row.anger) });
    }
    if (!tableExists(db, "response_results"))
        return samples;
    // Response Audit is session-keyed; attribute a session only when its graded replies name exactly one person.
    // Every grade counts, linked or not: a session with any other human, any unlinked reply or any purged reply is
    // never pinned on the one person still linked there (purging Bob must not hand Bob's frustration to Alice).
    const audit = db.prepare(`WITH session_person AS (
      SELECT session_id,min(person_id) person_id FROM inside_out GROUP BY session_id
      HAVING count(DISTINCT human_key)=1 AND count(person_id)=count(*) AND count(DISTINCT person_id)=1
        AND coalesce(sum(error IS '${PURGED_GRADE}'),0)=0
    ), latest AS (
      SELECT r.session_id,r.episode_at,r.result,row_number() OVER (PARTITION BY r.session_id,r.id ORDER BY r.assessed_at DESC,r.cohort) rn
      FROM response_results r WHERE r.status='ok' AND r.active=1 AND r.result IS NOT NULL AND json_valid(r.result)
        AND (? IS NULL OR r.cohort=?) AND r.episode_at<=?
    )
    SELECT sp.person_id,l.episode_at at,
      json_extract(l.result,'$.feedback.annoyance.noul') annoyance,json_extract(l.result,'$.feedback.frustration.noul') frustration,
      json_extract(l.result,'$.feedback.dissatisfactionIntensity.score') dissatisfaction,
      json_extract(l.result,'$.feedback.dissatisfactionIntensity.confidence') confidence
    FROM latest l JOIN session_person sp ON sp.session_id=l.session_id WHERE l.rn=1 AND (? IS NULL OR sp.person_id=?)`);
    const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
    for (const row of audit.iterate(options.responseCohort ?? null, options.responseCohort ?? null, options.now, person, person)) {
        const base = { personId: String(row.person_id), at: Number(row.at) };
        const annoyance = number(row.annoyance), frustration = number(row.frustration), dissatisfaction = number(row.dissatisfaction);
        if (annoyance !== null || frustration !== null) {
            samples.get("agent_frustration").push({ ...base, value: Math.max(annoyance ?? 0, frustration ?? 0) });
        }
        if (dissatisfaction !== null && (number(row.confidence) ?? 0) >= options.minResponseConfidence) {
            samples.get("agent_dissatisfaction").push({ ...base, value: dissatisfaction });
        }
    }
    return samples;
}
/**
 * Long-horizon drift per person and metric. The anchor is the person's earliest stable weeks, so a slow
 * week-over-week creep that a rolling baseline would absorb still shows as distance from where they started.
 * Read-only; derived on demand from grades and audit results, so nothing person-scoped is persisted here.
 */
export function detectSentimentDrift(db, options = {}) {
    const now = options.now ?? Date.now();
    if (!Number.isFinite(now))
        throw new Error("Invalid sentiment drift now");
    const recentWeeks = options.recentWeeks ?? DEFAULT_SENTIMENT_DRIFT.recentWeeks;
    if (!Number.isFinite(recentWeeks) || recentWeeks <= 0)
        throw new Error("Invalid sentiment drift recentWeeks");
    const anchorWeeks = positiveInteger(options.anchorWeeks ?? DEFAULT_SENTIMENT_DRIFT.anchorWeeks, "anchorWeeks");
    const minWeekly = positiveInteger(options.minWeeklySamples ?? DEFAULT_SENTIMENT_DRIFT.minWeeklySamples, "minWeeklySamples");
    const minAnchor = positiveInteger(options.minAnchorSamples ?? DEFAULT_SENTIMENT_DRIFT.minAnchorSamples, "minAnchorSamples");
    const minRecent = positiveInteger(options.minRecentSamples ?? DEFAULT_SENTIMENT_DRIFT.minRecentSamples, "minRecentSamples");
    const minResponseConfidence = options.minResponseConfidence ?? DEFAULTS.responseAudit.scoreHigh;
    if (!Number.isFinite(minResponseConfidence) || minResponseConfidence < 0 || minResponseConfidence > 1) {
        throw new Error("Invalid sentiment drift minResponseConfidence");
    }
    const drift = thresholdMap(DEFAULT_SENTIMENT_DRIFT.driftThresholds, options.driftThresholds, "driftThresholds");
    const level = thresholdMap(DEFAULT_SENTIMENT_DRIFT.levelThresholds, options.levelThresholds, "levelThresholds");
    const recentStart = now - recentWeeks * WEEK;
    const samples = readSnapshot(db, () => driftSamples(db, { now, personId: options.personId, rubric: options.rubric,
        responseCohort: options.responseCohort, minResponseConfidence }));
    const reports = [];
    const windows = { recentStart, anchorWeeks, minWeekly, minAnchor, minRecent };
    for (const metric of SENTIMENT_DRIFT_METRICS) {
        const byPerson = new Map();
        for (const sample of samples.get(metric)) {
            const list = byPerson.get(sample.personId);
            if (list)
                list.push(sample);
            else
                byPerson.set(sample.personId, [sample]);
        }
        for (const [personId, personSamples] of [...byPerson].sort(([a], [b]) => a.localeCompare(b))) {
            reports.push(driftReport(personId, metric, personSamples, { ...windows, driftLimit: drift[metric], levelLimit: level[metric] }));
        }
    }
    return reports;
}
const fmt = (value) => Number(value.toFixed(3));
/** Pure drift report for one person's samples of one metric. */
function driftReport(personId, metric, personSamples, settings) {
    const { recentStart, anchorWeeks, minWeekly, minAnchor, minRecent, driftLimit, levelLimit } = settings;
    const lowerIsWorse = LOWER_IS_WORSE[metric], sign = lowerIsWorse ? -1 : 1;
    const weeks = new Map();
    for (const { at, value } of personSamples) {
        const list = weeks.get(weekStart(at));
        if (list)
            list.push(value);
        else
            weeks.set(weekStart(at), [value]);
    }
    const ordered = [...weeks].sort(([a], [b]) => a - b);
    // Anchor: earliest stable weeks that finish before the recent window, so the two never overlap.
    const anchor = ordered.filter(([start, values]) => start + WEEK <= recentStart && values.length >= minWeekly).slice(0, anchorWeeks);
    const anchorValues = anchor.flatMap(([, values]) => values);
    const recentValues = personSamples.filter(sample => sample.at >= recentStart).map(sample => sample.value);
    const stable = ordered.filter(([, values]) => values.length >= minWeekly);
    const [previousWeek, lastWeek] = stable.slice(-2);
    const anchoredMean = anchorValues.length >= minAnchor ? mean(anchorValues) : null;
    const recentMean = recentValues.length >= minRecent ? mean(recentValues) : null;
    const absoluteDelta = anchoredMean !== null && recentMean !== null ? recentMean - anchoredMean : null;
    const worsening = absoluteDelta === null ? null : sign * absoluteDelta;
    const reasons = [];
    let flagged = false;
    if (recentMean === null)
        reasons.push(`insufficient_recent_samples (${recentValues.length} < ${minRecent})`);
    else {
        if (anchoredMean === null)
            reasons.push(`insufficient_anchor_history (${anchorValues.length} < ${minAnchor})`);
        else if (driftLimit !== null && worsening >= driftLimit) {
            flagged = true;
            reasons.push(`anchored_drift: ${metric} ${lowerIsWorse ? "fell" : "rose"} ${fmt(Math.abs(absoluteDelta))} from the anchored baseline ${fmt(anchoredMean)} to ${fmt(recentMean)} (threshold ${driftLimit})`);
        }
        if (levelLimit !== null && sign * (recentMean - levelLimit) >= 0) {
            flagged = true;
            reasons.push(`sustained_level: recent ${metric} ${fmt(recentMean)} is ${lowerIsWorse ? "at or below" : "at or above"} ${levelLimit}`);
        }
        if (!reasons.length)
            reasons.push("stable");
    }
    return {
        personId, metric, direction: lowerIsWorse ? "lower_is_worse" : "higher_is_worse",
        anchoredMean, anchorStart: anchor[0]?.[0] ?? null, anchorEnd: anchor.length ? anchor.at(-1)[0] + WEEK : null,
        anchorSamples: anchorValues.length, recentMean, recentStart, recentSamples: recentValues.length,
        absoluteDelta, worsening, recentAbsoluteLevel: recentMean,
        rollingWeeklyDelta: previousWeek && lastWeek ? mean(lastWeek[1]) - mean(previousWeek[1]) : null,
        weeksObserved: weeks.size, flagged, reason: reasons.join("; "),
    };
}
/** Compact view for `memory-emotions baselines`: flagged entries plus counts. */
export function summarizeSentimentDrift(reports) {
    return {
        people: new Set(reports.map(report => report.personId)).size,
        evaluated: reports.filter(report => report.recentMean !== null).length,
        flagged: reports.filter(report => report.flagged),
    };
}
