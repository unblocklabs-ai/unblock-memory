import { DEFAULTS } from "./defaults.js";
import type { QMDStore } from "@unblocklabs/qmd";
import { chunkFingerprint, type MaintenanceTask } from "./curation.js";
import { readActiveDocument } from "./evidence-review.js";

/** Routing hints only: low evidence is not permission to delete. */
export function qualityTriage(noise: number, evidence: number, encodingDefect = false) {
  if (noise < DEFAULTS.quality.triageNoiseThreshold && !encodingDefect) return "context_review" as const;
  if (evidence >= DEFAULTS.quality.triageEvidenceHigh) return "preserve_evidence_repair" as const;
  if (evidence <= DEFAULTS.quality.triageEvidenceLow) return "inspect_scaffolding" as const;
  return "context_review" as const;
}

/**
 * Compare indexed fingerprints only. Missing is not a verified repair and never changes status.
 * Share the cache only within one synchronous listing, never across index mutations.
 */
export function qualityTaskPresence(
  db: QMDStore["internal"]["db"], task: MaintenanceTask,
  cache = new Map<string, Set<string>>(),
) {
  if (task.type !== "quality_review") return undefined;
  const key = JSON.stringify([task.collection, task.path]);
  let fingerprints = cache.get(key);
  if (!fingerprints) {
    fingerprints = new Set<string>();
    const document = readActiveDocument(db, task.collection, task.path);
    if (document) {
      const chunks = db.prepare("SELECT pos, chunk_len FROM content_vectors WHERE hash = ?")
        .all<{ pos: number; chunk_len: number }>(document.hash);
      for (const chunk of chunks) {
        // QMD offsets are UTF-16; SQLite substr counts Unicode code points instead.
        fingerprints.add(chunkFingerprint(document.doc.slice(chunk.pos, chunk.pos + chunk.chunk_len)));
      }
    }
    cache.set(key, fingerprints);
  }
  return fingerprints.has(task.contentFingerprint)
    ? "present_in_index" as const : "not_present_in_index" as const;
}
