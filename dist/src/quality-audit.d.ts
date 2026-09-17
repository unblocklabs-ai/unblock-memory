import type { QMDStore } from "@unblocklabs/qmd";
import type { CurationStore, MaintenanceTask } from "./curation.js";
import { type ResolvedSource } from "./sources.js";
export type QualityCursor = {
    documentId: number;
    seq: number;
};
/** A formatting clue, never proof that JSON or structured data is worthless. */
export declare function qualityStructure(text: string): "empty" | "encoded_message" | "serialized_message" | "plain_or_structured";
export declare function auditQualityPage(params: {
    db: QMDStore["internal"]["db"];
    curation: CurationStore;
    sources: readonly ResolvedSource[];
    apiKey: string;
    timeoutMs: number;
    minNoise: number;
    limit?: number;
    after?: QualityCursor;
    signal: AbortSignal;
    isActive: () => boolean;
}): Promise<{
    status: "ok" | "partial";
    done: boolean;
    next: QualityCursor | undefined;
    scanned: number;
    judged: number;
    cached: number;
    skippedOversized: number;
    skippedStale: number;
    flagged: number;
    groups: {
        corpus: string;
        source: string;
        reason: string;
        pending: number;
        examples: MaintenanceTask[];
    }[];
    policy: string;
    scope: string;
} | {
    error: string;
    status: "ok" | "partial";
    done: boolean;
    next: QualityCursor | undefined;
    scanned: number;
    judged: number;
    cached: number;
    skippedOversized: number;
    skippedStale: number;
    flagged: number;
    groups: {
        corpus: string;
        source: string;
        reason: string;
        pending: number;
        examples: MaintenanceTask[];
    }[];
    policy: string;
    scope: string;
}>;
