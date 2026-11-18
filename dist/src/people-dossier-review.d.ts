import type { UnblockMemoryConfig } from "./config.js";
import type { Person, PersonDossier } from "./people-store.js";
import type { QmdMemoryRuntime } from "./runtime.js";
import type { getContext } from "./tool-context.js";
/** Review every saved assertion against its own evidence, including interaction lessons. */
export declare function reviewPersonDossier(params: {
    config: UnblockMemoryConfig;
    runtime: QmdMemoryRuntime;
    active: NonNullable<ReturnType<typeof getContext>>;
    person: Person;
    dossier: PersonDossier;
    agentName?: string;
    signal?: AbortSignal;
}): Promise<{
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
} | {
    status: "unavailable";
    needsReview: boolean;
    reason: string;
} | {
    status: "ok";
    needsReview: boolean;
    assertionsReviewed: number;
}>;
