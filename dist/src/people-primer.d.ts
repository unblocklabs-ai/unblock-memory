import type { CorpusMemorySearchResult, CorpusSearchOptions } from "./contracts.js";
import type { PeoplePrimerConfig } from "./people-primer-config.js";
import type { PeopleStore } from "./people-store.js";
/** Evidence preparation only. Search is local; approved excerpts go to TypeSafe.
 * No identity inference, generated claims, dossier writes or automatic injection. */
export declare function primePersonDossier(params: {
    personId: string;
    agentName: string;
    store: Pick<PeopleStore, "getPerson" | "listIdentities" | "getPrimerJudgment" | "cachePrimerJudgment">;
    search: (query: string, options: CorpusSearchOptions) => Promise<CorpusMemorySearchResult[]>;
    config: PeoplePrimerConfig;
    apiKey: string;
    signal: AbortSignal;
}): Promise<{
    status: "disabled";
    reason?: undefined;
    personId?: undefined;
    name?: undefined;
    version?: undefined;
    advisory?: undefined;
    stats?: undefined;
    questions?: undefined;
    evidence?: undefined;
} | {
    status: "not_found";
    reason?: undefined;
    personId?: undefined;
    name?: undefined;
    version?: undefined;
    advisory?: undefined;
    stats?: undefined;
    questions?: undefined;
    evidence?: undefined;
} | {
    status: "unavailable";
    reason: string;
    personId?: undefined;
    name?: undefined;
    version?: undefined;
    advisory?: undefined;
    stats?: undefined;
    questions?: undefined;
    evidence?: undefined;
} | {
    status: "ok" | "partial";
    personId: string;
    name: string;
    version: string;
    advisory: string;
    stats: {
        uniqueCandidates: number;
        requests: number;
        cached: number;
        failed: number;
        elapsedMs: number;
    };
    questions: {
        graded: number;
        qualifying: number;
        coverage: "unknown" | "evidence_found" | "uncertain";
        evidence: {
            evidenceId: string;
            vectorScore: number;
            usefulness: number;
            aboutPerson: number;
            explicitBackground: number;
            enduring: number;
            recognition: number;
        }[];
        review: {
            evidenceId: string;
            vectorScore: number;
            usefulness: number;
            aboutPerson: number;
            explicitBackground: number;
            enduring: number;
            recognition: number;
        }[];
        retrieved?: number | undefined;
        eligible?: number | undefined;
        oversized?: number | undefined;
        id: string;
        question: string;
    }[];
    evidence: {
        id: string;
        path: string;
        from: number;
        lines: number;
        excerpt: string;
        corpus: string;
    }[];
    reason?: undefined;
}>;
