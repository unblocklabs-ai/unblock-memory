import { DEFAULTS } from "./defaults.js";
import { chunkFingerprint } from "./curation.js";
import { readActiveDocument } from "./evidence-review.js";
/** Routing hints only: low evidence is not permission to delete. */
export function qualityTriage(noise, evidence, encodingDefect = false) {
    if (noise < DEFAULTS.quality.triageNoiseThreshold && !encodingDefect)
        return "context_review";
    if (evidence >= DEFAULTS.quality.triageEvidenceHigh)
        return "preserve_evidence_repair";
    if (evidence <= DEFAULTS.quality.triageEvidenceLow)
        return "inspect_scaffolding";
    return "context_review";
}
/**
 * Compare indexed fingerprints only. Missing is not a verified repair and never changes status.
 * Share the cache only within one synchronous listing, never across index mutations.
 */
export function qualityTaskPresence(db, task, cache = new Map()) {
    if (task.type !== "quality_review")
        return undefined;
    const key = JSON.stringify([task.collection, task.path]);
    let fingerprints = cache.get(key);
    if (!fingerprints) {
        fingerprints = new Set();
        const document = readActiveDocument(db, task.collection, task.path);
        if (document) {
            const chunks = db.prepare("SELECT pos, chunk_len FROM content_vectors WHERE hash = ?")
                .all(document.hash);
            for (const chunk of chunks) {
                // QMD offsets are UTF-16; SQLite substr counts Unicode code points instead.
                fingerprints.add(chunkFingerprint(document.doc.slice(chunk.pos, chunk.pos + chunk.chunk_len)));
            }
        }
        cache.set(key, fingerprints);
    }
    return fingerprints.has(task.contentFingerprint)
        ? "present_in_index" : "not_present_in_index";
}
