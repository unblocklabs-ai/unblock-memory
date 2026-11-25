type RequestOptions = {
    apiKey: string;
    endpoint?: string;
    model?: string;
    timeoutMs: number;
    signal: AbortSignal;
};
/** The source is an indexed snapshot, not proof of current truth or permission to write. */
export declare function reviewClaim(params: RequestOptions & {
    claim: string;
    evidence: readonly string[];
    personBackground?: {
        name: string;
        agentName: string;
        kind?: "interaction";
        inferred?: boolean;
    };
}): Promise<{
    verdict: "supports" | "contradicts" | "insufficient_evidence";
    confidence: number;
    probabilities: Record<"supports" | "contradicts" | "insufficient_evidence", number>;
    background: {
        backgroundOnly: number;
        explicitSupport: number;
    };
    needsReview: boolean;
} | {
    verdict: "supports" | "contradicts" | "insufficient_evidence";
    confidence: number;
    probabilities: Record<"supports" | "contradicts" | "insufficient_evidence", number>;
    needsReview: boolean;
    background?: undefined;
}>;
/** Directional coverage, not topic similarity. Bounded at six comparisons of four ranked candidates. */
export declare function reviewMemoryRedundancy(params: RequestOptions & {
    excerpts: readonly string[];
}): Promise<{
    earlier: number;
    later: number;
    redundant: number;
}[]>;
export declare function complementaryIndices(count: number, pairs: readonly {
    earlier: number;
    later: number;
    redundant: number;
}[], limit: number): number[];
/** Classify defects per member. No cluster-wide judgment or generated repair instructions. */
export declare function reviewClusterDefects(params: RequestOptions & {
    excerpts: readonly string[];
}): Promise<{
    defect: "encoding" | "wrapper" | "boilerplate" | "none_or_uncertain";
    confidence: number;
}[]>;
export {};
