import type { QMDStore } from "@unblocklabs/qmd";
import { type ResolvedSource } from "./sources.js";
export type EvidenceCitation = {
    path: string;
    from: number;
    lines: number;
};
export declare function reviewIndexedClaim(params: {
    db: QMDStore["internal"]["db"];
    sources: readonly ResolvedSource[];
    claim: string;
    citations: readonly EvidenceCitation[];
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
    personBackground?: {
        name: string;
        agentName: string;
    };
    read?: <T>(run: () => T) => Promise<T>;
}): Promise<{
    status: "unavailable";
    verdict: "insufficient_evidence";
    needsReview: boolean;
    reason: string;
} | {
    evidence: {
        path: string;
        from: number;
        lines: number;
        documentHash: string;
        excerptHash: string;
    }[];
    policy: string;
    scope: string;
    needsReview: boolean;
    background?: {
        backgroundOnly: number;
        explicitSupport: number;
    } | undefined;
    verdict: "supports" | "contradicts" | "insufficient_evidence";
    confidence: number;
    probabilities: {
        supports: number;
        contradicts: number;
        insufficient_evidence: number;
    };
    status: "ok";
}>;
