type RequestOptions = {
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
};
/** The source is an indexed snapshot, not proof of current truth or permission to write. */
export declare function reviewTypeSafeClaim(params: RequestOptions & {
    claim: string;
    evidence: readonly string[];
}): Promise<{
    verdict: "supports" | "contradicts" | "insufficient_evidence";
    confidence: number;
    probabilities: {
        supports: number;
        contradicts: number;
        insufficient_evidence: number;
    };
    needsReview: boolean;
}>;
/** Directional coverage, not topic similarity. Bounded at six comparisons of four ranked candidates. */
export declare function reviewMemoryRedundancy(params: RequestOptions & {
    excerpts: readonly string[];
}): Promise<{
    redundant: number;
    earlier: number;
    later: number;
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
