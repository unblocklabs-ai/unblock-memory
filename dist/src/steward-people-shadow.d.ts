import { Type, type Static } from "typebox";
import type { StewardRunner, StewardUsage } from "./steward-runner.js";
import { type WorkStore } from "./work-store.js";
export declare const PEOPLE_SHADOW_KIND = "people_shadow";
declare const DISPOSITIONS: readonly ["revalidated", "corrected", "retired", "unresolved"];
type Disposition = typeof DISPOSITIONS[number];
export declare const PEOPLE_SHADOW_PROPOSAL_SCHEMA: Type.TObject<{
    disposition: Type.TEnum<["revalidated", "corrected", "retired", "unresolved"]>;
    proposedClaim: Type.TOptional<Type.TString>;
    reason: Type.TString;
    citedHandles: Type.TArray<Type.TString>;
    confidence: Type.TUnion<[Type.TLiteral<"high">, Type.TLiteral<"medium">, Type.TLiteral<"low">]>;
}>;
export type PeopleShadowProposal = Static<typeof PEOPLE_SHADOW_PROPOSAL_SCHEMA>;
type ShadowEvidence = {
    handle: string;
    sessionId: string;
    seq: number;
    role: "user" | "assistant";
    timestamp?: string;
    text: string;
};
export type PeopleShadowArtifact = {
    schemaVersion: 1;
    manifestId: string;
    manifestRevision: string;
    personId: string;
    assertionId: string;
    source: "model" | "host";
    proposal: PeopleShadowProposal;
    /** Handle → source coordinates (no filesystem paths). */
    evidence: Omit<ShadowEvidence, "text">[];
    usage?: StewardUsage;
    proposedAt: string;
};
export type PeopleShadowPassOptions = {
    /** Agent state `unblock-memory.sqlite`; opened read-only here. */
    dbPath: string;
    agentId: string;
    /** Must be a connection on `dbPath`; proposals are staged and completed through its fence only. */
    workStore: WorkStore;
    runner: Pick<StewardRunner, "complete">;
    owner: string;
    /** Explicit run ids; default is the latest non-pending nightly and weekly manifests. */
    manifestIds?: string[];
    /** Approved private export root; default `<state>/people-learning/exports`. */
    exportRoot?: string;
    leaseMs?: number;
    /** Lease renewal cadence during a model call; default one third of `leaseMs`. */
    heartbeatMs?: number;
    /** Strikes before a rejected or schema-invalid item quarantines (WorkStore default when omitted). */
    maxStrikes?: number;
    /** Per-proposal model deadline (`steward.peopleShadow.timeoutMs`). */
    timeoutMs?: number;
    /** Maximum model calls this pass. */
    maxItems?: number;
    maxHandles?: number;
    maxExcerptChars?: number;
    /** Skip assertions the cron already resolved for the same manifest revision. */
    skipCronResolved?: boolean;
    signal?: AbortSignal;
    now?: () => number;
};
type PeopleShadowItemOutcome = "staged" | "completed" | "resumed" | "rejected" | "skipped" | "busy" | "failed" | "interrupted" | "host_unresolved";
export type PeopleShadowPassResult = {
    manifests: {
        manifestId: string;
        manifestRevision: string;
        assertions: number;
    }[];
    enqueued: number;
    attempted: number;
    completed: number;
    rejected: number;
    failed: number;
    skipped: number;
    interrupted: boolean;
    usage: UsageTotals;
    items: {
        scope: string;
        outcome: PeopleShadowItemOutcome;
        detail?: string;
    }[];
};
type UsageTotals = {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    costUsd?: number;
    unreportedRequests: number;
};
/**
 * One shadow pass: enqueue one `item` row per manifest assertion, then adjudicate up to `maxItems`
 * of them through `runner.complete`, staging ONLY host-verified proposals into `work_items`.
 */
export declare function runPeopleShadowPass(options: PeopleShadowPassOptions): Promise<PeopleShadowPassResult>;
type PeopleShadowComparison = {
    scope: string;
    manifestId: string;
    manifestRevision: string;
    personId: string;
    assertionId: string;
    shadow?: Disposition;
    cron?: Disposition;
    shadowConfidence?: PeopleShadowProposal["confidence"];
    shadowReason?: string;
};
export type PeopleShadowReport = {
    manifests: {
        manifestId: string;
        manifestRevision: string;
        cronReceipt: boolean;
    }[];
    matched: number;
    diverged: number;
    shadowOnly: number;
    cronOnly: number;
    quarantined: number;
    pending: number;
    agreementRate: number | null;
    usageTotals: UsageTotals;
    divergences: PeopleShadowComparison[];
    shadowOnlyItems: PeopleShadowComparison[];
    cronOnlyItems: PeopleShadowComparison[];
    quarantinedItems: {
        scope: string;
        strikes: number;
        lastError: string | null;
    }[];
};
/** Read-only side-by-side of shadow proposals vs the cron's receipt for the same manifest revision. */
export declare function buildPeopleShadowReport(dbPath: string, manifestId?: string): PeopleShadowReport;
export {};
