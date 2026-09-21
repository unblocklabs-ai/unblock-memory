import type { CorpusMemorySearchResult, SessionSearchFilter } from "./contracts.js";
export declare const XSEARCH_MAX_EXCERPT_CHARS = 12000;
declare function judgeHit(query: string, hit: CorpusMemorySearchResult, options: {
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
}, timeContext: {
    asOf: string;
    sessionStartedFrom?: string;
    sessionStartedTo?: string;
}): Promise<{
    score: number;
    confidence: number;
    probabilities: {
        "0": number;
        "1": number;
        "2": number;
        "3": number;
    };
}>;
type RankedHit = CorpusMemorySearchResult & {
    rerank: Awaited<ReturnType<typeof judgeHit>> & {
        policy: string;
    };
    retrievalMethods: Array<"vector" | "bm25">;
    aliases?: Array<{
        path: string;
        startLine: number;
        endLine: number;
        citation?: string;
    }>;
};
type XsearchResult = {
    status: "ok" | "partial";
    results: RankedHit[];
    ranking: "typesafe";
    policy: string;
    asOf: string;
    candidates: {
        vector: number;
        bm25: number;
        deduplicated: number;
        duplicates: number;
        oversized: number;
        scored: number;
        failed: number;
    };
    rerankMs: number;
};
/** Rank independent query/excerpt pairs. No candidate can influence another's score. */
export declare function rerankXsearch(params: {
    query: string;
    sessionFilter?: Pick<SessionSearchFilter, "startedFrom" | "startedTo">;
    vector: readonly CorpusMemorySearchResult[];
    lexical: readonly CorpusMemorySearchResult[];
    maxResults: number;
    minScore: number;
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
}): Promise<XsearchResult>;
export {};
