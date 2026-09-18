import type { QMDStore } from "@unblocklabs/qmd";
import { type MaintenanceTask } from "./curation.js";
/** Routing hints only: low evidence is not permission to delete. */
export declare function qualityTriage(noise: number, evidence: number, encodingDefect?: boolean): "context_review" | "preserve_evidence_repair" | "inspect_scaffolding";
/**
 * Compare indexed fingerprints only. Missing is not a verified repair and never changes status.
 * Share the cache only within one synchronous listing, never across index mutations.
 */
export declare function qualityTaskPresence(db: QMDStore["internal"]["db"], task: MaintenanceTask, cache?: Map<string, Set<string>>): "present_in_index" | "not_present_in_index" | undefined;
