import { DatabaseSync } from "node:sqlite";
export const BRIGHTNESS_RECIPES = ["off", "actr_v1", "outcome_v1"];
export const DEFAULT_BRIGHTNESS_CONFIG = {
    recipe: "off", weight: 0.08, decayRate: 0.5, lookbackDays: 90, maxBoost: 0.15,
};
export function brightnessRecipeHash(recipe) {
    return recipe === "off" ? "default" : `brightness:${recipe}`;
}
export function memorySubjectId(_corpus, path) {
    // Outcome Ledger writes recall_hits.source_path verbatim; it does not add a corpus or locator prefix.
    return path;
}
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const OUTCOME_WEIGHTS = { helped: 1, hurt: -1.5, ignored: -0.12 };
// One bound batch parameter, without a SQLite variable-count limit on the number of subjects.
const SUBJECTS = "(SELECT value FROM json_each(:subjects))";
/** Missing or unavailable evidence is neutral. Never initialize or migrate a ledger on the search path. */
export function computeBrightnessMap(dbOrPath, options) {
    const { agentId, recipe, subjects, nowMs = Date.now(), decayRate = DEFAULT_BRIGHTNESS_CONFIG.decayRate, lookbackDays = DEFAULT_BRIGHTNESS_CONFIG.lookbackDays } = options;
    const result = new Map();
    if (recipe === "off" || !subjects.length)
        return result;
    const evidence = new Map();
    const add = (subject, value) => {
        const entry = evidence.get(subject);
        if (entry) {
            entry.total += value;
            entry.samples++;
        }
        else
            evidence.set(subject, { total: value, samples: 1 });
    };
    const keys = new Set(subjects);
    const scope = { agent: agentId, subjects: JSON.stringify([...keys]) };
    const window = { ...scope, since: lookbackDays === 0 ? -Infinity : nowMs - lookbackDays * DAY_MS, now: nowMs };
    try {
        const db = typeof dbOrPath === "string" ? new DatabaseSync(dbOrPath, { readOnly: true }) : dbOrPath;
        try {
            if (typeof dbOrPath === "string")
                db.exec("PRAGMA busy_timeout = 50");
            const tables = new Set(db.prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name IN
        ('recall_reads','recall_hits','recall_queries','memory_outcomes','core_memories','expectations')`).all().map(row => row.name));
            if (recipe === "actr_v1") {
                const hasReads = tables.has("recall_reads");
                const hasHits = tables.has("recall_hits") && tables.has("recall_queries");
                if (!hasReads && !hasHits)
                    return result;
                const activation = (at) => Math.max(1, (nowMs - at) / HOUR_MS) ** -decayRate;
                if (hasReads) {
                    for (const row of db.prepare(`SELECT source_path, read_at_ms FROM recall_reads
            WHERE agent_id=:agent AND status='ok' AND read_at_ms BETWEEN :since AND :now
              AND source_path IN ${SUBJECTS}`).iterate(window)) {
                        add(String(row.source_path), 2 * activation(Number(row.read_at_ms)));
                    }
                }
                if (hasHits) {
                    for (const row of db.prepare(`SELECT h.source_path, h.hit_at_ms FROM recall_hits h JOIN recall_queries q ON q.id=h.query_id
            WHERE q.agent_id=:agent AND h.disposition IN ('emitted','returned')
              AND h.hit_at_ms BETWEEN :since AND :now AND h.source_path IN ${SUBJECTS}`).iterate(window)) {
                        add(String(row.source_path), 0.5 * activation(Number(row.hit_at_ms)));
                    }
                }
            }
            else {
                if (!tables.has("memory_outcomes") && !tables.has("core_memories") && !tables.has("expectations"))
                    return result;
                if (tables.has("memory_outcomes")) {
                    for (const row of db.prepare(`SELECT subject_id, verdict, confidence, measured_at FROM memory_outcomes
            WHERE agent_id=:agent AND subject_kind='memory_hit' AND measured_at BETWEEN :since AND :now
              AND subject_id IN ${SUBJECTS}`).iterate(window)) {
                        const weight = OUTCOME_WEIGHTS[row.verdict];
                        add(String(row.subject_id), weight * Number(row.confidence) * Math.exp(-(nowMs - Number(row.measured_at)) / (30 * DAY_MS)));
                    }
                }
                if (tables.has("core_memories")) {
                    for (const row of db.prepare(`SELECT DISTINCT source_path FROM core_memories
            WHERE agent_id=:agent AND source_path IN ${SUBJECTS}`).iterate(scope)) {
                        add(String(row.source_path), 0.35);
                    }
                }
                if (tables.has("expectations")) {
                    // Only explicit source links contribute; session or text overlap does not establish a link.
                    for (const row of db.prepare(`SELECT json_extract(evidence_json,'$.sourcePath') AS source_path, surprise_score
            FROM expectations WHERE agent_id=:agent AND status!='open' AND resolved_at_ms BETWEEN :since AND :now
              AND surprise_score>=0.5 AND json_extract(evidence_json,'$.sourcePath') IN ${SUBJECTS}`).iterate(window)) {
                        add(String(row.source_path), 0.35 * Number(row.surprise_score));
                    }
                }
            }
        }
        finally {
            if (typeof dbOrPath === "string")
                db.close();
        }
    }
    catch {
        // Missing file, incompatible schema or a busy ledger must not break recall.
        return result;
    }
    for (const subject of keys) {
        const entry = evidence.get(subject);
        const score = !entry ? 0 : recipe === "actr_v1" ? Math.log1p(entry.total) : entry.total;
        result.set(subject, { score, normalized: Math.tanh(score / 3), recipe, samples: entry?.samples ?? 0 });
    }
    return result;
}
