import type { QMDStore } from "@unblocklabs/qmd";
import { type ResolvedSource } from "./sources.js";
export type EvidenceCitation = {
    path: string;
    from: number;
    lines: number;
};
export declare function readActiveDocument(db: QMDStore["internal"]["db"], collection: string, path: string): {
    hash: string;
    doc: string;
} | undefined;
export declare function reviewIndexedClaim(params: {
    db: QMDStore["internal"]["db"];
    sources: readonly ResolvedSource[];
    claim: string;
    citations: readonly EvidenceCitation[];
    apiKey: string;
    endpoint?: string;
    model?: string;
    timeoutMs: number;
    signal: AbortSignal;
    personBackground?: {
        name: string;
        agentName: string;
        kind?: "interaction";
        inferred?: boolean;
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
    verdict: "supports" | "contradicts" | "insufficient_evidence";
    confidence: number;
    probabilities: Record<"supports" | "contradicts" | "insufficient_evidence", number>;
    background: {
        backgroundOnly: number;
        explicitSupport: number;
    };
    needsReview: boolean;
    status: "ok";
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
    verdict: "supports" | "contradicts" | "insufficient_evidence";
    confidence: number;
    probabilities: Record<"supports" | "contradicts" | "insufficient_evidence", number>;
    needsReview: boolean;
    background?: undefined;
    status: "ok";
}>;
