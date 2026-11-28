import type { QMDStore } from "@unblocklabs/qmd";
import type { CurationStore, MaintenanceTask } from "./curation.js";
import { type ResolvedSource } from "./sources.js";
import { qualityTriage } from "./quality-triage.js";
export type QualityCursor = {
    documentId: number;
    seq: number;
};
type QualityStructure = "empty" | "encoded_message" | "serialized_message" | "plain_or_structured";
/** A formatting clue, never proof that JSON or structured data is worthless. */
export declare function qualityStructure(text: string): QualityStructure;
export declare function auditQualityPage(params: {
    db: QMDStore["internal"]["db"];
    curation: CurationStore;
    sources: readonly ResolvedSource[];
    apiKey: string;
    endpoint?: string;
    model?: string;
    timeoutMs: number;
    minNoise: number;
    limit?: number;
    after?: QualityCursor;
    signal: AbortSignal;
    isActive: () => boolean;
}): Promise<{
    status: "partial" | "ok";
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
        triage: ReturnType<typeof qualityTriage>;
    }[];
    policy: string;
    scope: string;
} | {
    error: string;
    status: "partial" | "ok";
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
        triage: ReturnType<typeof qualityTriage>;
    }[];
    policy: string;
    scope: string;
}>;
export {};
