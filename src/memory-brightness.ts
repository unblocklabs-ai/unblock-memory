import { DatabaseSync } from "node:sqlite";
import { readPathSalience } from "./emotional-salience.js";
import { readTableColumns } from "./memory-database.js";

export const BRIGHTNESS_RECIPES = ["off", "actr_v1", "outcome_v1", "emotion_v1"] as const;
export type BrightnessRecipe = typeof BRIGHTNESS_RECIPES[number];

export type BrightnessConfig = {
  recipe: BrightnessRecipe;
  weight: number;
  decayRate: number;
  lookbackDays: number;
  maxBoost: number;
  emotionDecayStretch?: number;
  emotionMaxBonus?: number;
};

export const EMOTION_BRIGHTNESS_LIMITS = { emotionDecayStretch: 3, emotionMaxBonus: 0.35 } as const;
export const DEFAULT_BRIGHTNESS_CONFIG: Required<BrightnessConfig> = {
  recipe: "off", weight: 0.08, decayRate: 0.5, lookbackDays: 90, maxBoost: 0.15,
  ...EMOTION_BRIGHTNESS_LIMITS,
};

export type BrightnessScore = {
  score: number;
  normalized: number;
  recipe: BrightnessRecipe;
  samples: number;
};

export function brightnessRecipeHash(recipe: BrightnessRecipe): string {
  return recipe === "off" ? "default" : `brightness:${recipe}`;
}

export function memorySubjectId(_corpus: string, path: string): string {
  // Outcome Ledger writes recall_hits.source_path verbatim; it does not add a corpus or locator prefix.
  return path;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const OUTCOME_DECAY_MS = 30 * DAY_MS;
const OUTCOME_WEIGHTS = { helped: 1, hurt: -1.5, ignored: -0.12 } as const;
// One bound batch parameter, without a SQLite variable-count limit on the number of subjects.
const SUBJECTS = "(SELECT value FROM json_each(:subjects))";

/** Grounded emotional salience (0..1) per subject; zero or unknown salience is no Flashbulb signal. */
const salienceScores = (paths: ReadonlyMap<string, { salienceScore: number }>) =>
  new Map([...paths].flatMap(([path, { salienceScore }]) => salienceScore > 0 ? [[path, salienceScore] as const] : []));

/** Missing or unavailable evidence is neutral. Never initialize or migrate a ledger on the search path. */
export function computeBrightnessMap(dbOrPath: DatabaseSync | string, options: Pick<BrightnessConfig, "recipe"> &
  Partial<Pick<BrightnessConfig, "decayRate" | "lookbackDays" | "emotionDecayStretch" | "emotionMaxBonus">> & {
  agentId: string;
  subjects: readonly string[];
  nowMs?: number;
  /** Prior intensity grades a person needs before relative intensity counts (`insideOut.baselineMinInteractions`). */
  baselineMinInteractions?: number;
}): Map<string, BrightnessScore> {
  const { agentId, recipe, subjects, nowMs = Date.now(), decayRate = DEFAULT_BRIGHTNESS_CONFIG.decayRate,
    lookbackDays = DEFAULT_BRIGHTNESS_CONFIG.lookbackDays, emotionDecayStretch = DEFAULT_BRIGHTNESS_CONFIG.emotionDecayStretch,
    emotionMaxBonus = DEFAULT_BRIGHTNESS_CONFIG.emotionMaxBonus } = options;
  const result = new Map<string, BrightnessScore>();
  if (recipe === "off" || !subjects.length) return result;

  const evidence = new Map<string, { total: number; samples: number }>();
  const add = (subject: string, value: number) => {
    const entry = evidence.get(subject);
    if (entry) {
      entry.total += value;
      entry.samples++;
    } else evidence.set(subject, { total: value, samples: 1 });
  };
  const keys = new Set(subjects);
  const scope = { agent: agentId, subjects: JSON.stringify([...keys]) };
  const window = { ...scope, since: lookbackDays === 0 ? -Infinity : nowMs - lookbackDays * DAY_MS, now: nowMs };

  try {
    const db = typeof dbOrPath === "string" ? new DatabaseSync(dbOrPath, { readOnly: true }) : dbOrPath;
    try {
      if (typeof dbOrPath === "string") db.exec("PRAGMA busy_timeout = 50");
      const hasColumns = (table: string, ...required: string[]) => {
        const columns = readTableColumns(db, table);
        return required.every(column => columns.has(column));
      };

      if (recipe === "actr_v1") {
        const hasReads = hasColumns("recall_reads", "source_path", "read_at_ms", "agent_id", "status");
        const hasHits = hasColumns("recall_hits", "source_path", "hit_at_ms", "query_id", "disposition") &&
          hasColumns("recall_queries", "id", "agent_id");
        if (!hasReads && !hasHits) return result;
        const activation = (at: number) => Math.max(1, (nowMs - at) / HOUR_MS) ** -decayRate;
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
      } else {
        // The same evidence window as outcomes: a grade or log entry outside the lookback is no Flashbulb signal.
        const salience = recipe === "emotion_v1" ? salienceScores(readPathSalience(db, agentId, [...keys], {
          nowMs, lookbackDays, ...(options.baselineMinInteractions !== undefined
            ? { baselineMinInteractions: options.baselineMinInteractions } : {}),
        })) : undefined;
        const hasOutcomes = hasColumns("memory_outcomes", "subject_id", "verdict", "confidence", "measured_at", "agent_id", "subject_kind");
        const hasCore = hasColumns("core_memories", "agent_id", "source_path");
        const hasExpectations = hasColumns("expectations", "evidence_json", "surprise_score", "agent_id", "status", "resolved_at_ms");
        if (!hasOutcomes && !hasCore && !hasExpectations && !salience?.size) return result;
        const flashbulb = new Map<string, { decayDelta: number; hurt: boolean }>();
        const stretch = Math.max(0, Math.min(EMOTION_BRIGHTNESS_LIMITS.emotionDecayStretch, emotionDecayStretch));
        const maxBonus = Math.max(0, Math.min(EMOTION_BRIGHTNESS_LIMITS.emotionMaxBonus, emotionMaxBonus));
        if (hasOutcomes) {
          for (const row of db.prepare(`SELECT subject_id, verdict, confidence, measured_at FROM memory_outcomes
            WHERE agent_id=:agent AND subject_kind='memory_hit' AND measured_at BETWEEN :since AND :now
              AND subject_id IN ${SUBJECTS}`).iterate(window)) {
            const weight = OUTCOME_WEIGHTS[row.verdict as keyof typeof OUTCOME_WEIGHTS];
            const subject = String(row.subject_id);
            const value = weight * Number(row.confidence);
            const age = (nowMs - Number(row.measured_at)) / OUTCOME_DECAY_MS;
            const baseline = value * Math.exp(-age);
            add(subject, baseline);
            const emotion = salience?.get(subject);
            if (emotion) {
              const adjustment = flashbulb.get(subject) ?? { decayDelta: 0, hurt: false };
              adjustment.decayDelta += value * Math.exp(-age / (1 + emotion * stretch)) - baseline;
              adjustment.hurt ||= row.verdict === "hurt" && value < 0;
              flashbulb.set(subject, adjustment);
            }
          }
        }
        if (hasCore) {
          for (const row of db.prepare(`SELECT DISTINCT source_path FROM core_memories
            WHERE agent_id=:agent AND source_path IN ${SUBJECTS}`).iterate(scope)) {
            add(String(row.source_path), 0.35);
          }
        }
        if (hasExpectations) {
          // Only explicit source links contribute; session or text overlap does not establish a link.
          for (const row of db.prepare(`SELECT json_extract(evidence_json,'$.sourcePath') AS source_path, surprise_score
            FROM expectations WHERE agent_id=:agent AND status!='open' AND resolved_at_ms BETWEEN :since AND :now
              AND surprise_score>=0.5 AND json_extract(evidence_json,'$.sourcePath') IN ${SUBJECTS}`).iterate(window)) {
            add(String(row.source_path), 0.35 * Number(row.surprise_score));
          }
        }
        for (const [subject, emotion] of salience ?? []) {
          const { decayDelta = 0, hurt = false } = flashbulb.get(subject) ?? {};
          // A confirmed hurt may persist longer, but emotion cannot improve that subject over outcome_v1.
          const adjustment = hurt ? Math.min(0, decayDelta) : decayDelta + maxBonus * emotion;
          if (adjustment) add(subject, adjustment);
        }
      }
    } finally {
      if (typeof dbOrPath === "string") db.close();
    }
  } catch {
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
