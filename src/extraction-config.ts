import type { ChatType, CorpusConfig } from "./config.js";

export type ExtractionConfig = { enabled: boolean; publish: boolean; intervalMinutes: number;
  chatTypes: ChatType[]; historyMessages: number; maxBatches: number;
  minSupport: number; minRetention: number; minReplacement: number };
export function resolveExtraction(value: unknown, corpora: readonly CorpusConfig[]): ExtractionConfig {
  const defaults: ExtractionConfig = { enabled: false, publish: false, intervalMinutes: 60,
    chatTypes: [], historyMessages: 6, maxBatches: 5, minSupport: 0.9, minRetention: 0.9, minReplacement: 0.9 };
  if (value === undefined) return defaults;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("extraction must be an object");
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown extraction property: ${key}`);
  const enabled = v.enabled ?? defaults.enabled, publish = v.publish ?? defaults.publish;
  if (typeof enabled !== "boolean" || typeof publish !== "boolean") throw new Error("extraction enabled/publish must be booleans");
  const chatTypes = v.chatTypes ?? [];
  const sessions = corpora.find(c => c.kind === "sessions");
  if (!Array.isArray(chatTypes) || !chatTypes.every((t): t is ChatType =>
    typeof t === "string" && ["direct", "channel", "group"].includes(t) && sessions?.chatTypes.includes(t as ChatType) === true)) {
    throw new Error("extraction.chatTypes must be a subset of configured session chat types");
  }
  if (enabled && !chatTypes.length) throw new Error("extraction requires explicit approved chatTypes");
  if (enabled && corpora.some(c => c.name === "extracted")) throw new Error("extraction reserves the derived corpus name extracted");
  const integer = (key: "intervalMinutes" | "historyMessages" | "maxBatches", min: number, max: number) => {
    const n = v[key] ?? defaults[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid extraction.${key}`);
    return n;
  };
  const probability = (key: "minSupport" | "minRetention" | "minReplacement") => {
    const n = v[key] ?? defaults[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) throw new Error(`Invalid extraction.${key}`);
    return n;
  };
  return { enabled, publish, chatTypes: [...new Set(chatTypes)], intervalMinutes: integer("intervalMinutes", 0, 1440),
    historyMessages: integer("historyMessages", 0, 20), maxBatches: integer("maxBatches", 1, 50),
    minSupport: probability("minSupport"), minRetention: probability("minRetention"), minReplacement: probability("minReplacement") };
}
