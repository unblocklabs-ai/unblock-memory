import { Type, type Static } from "typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { PeopleManifestEnsureResult } from "./people-learning-runtime.js";
import type { StewardRunner, StewardUsage } from "./steward-runner.js";
import { type WorkStore } from "./work-store.js";
export declare const PEOPLE_SHADOW_KIND = "people_shadow";
/** Interaction-learning work kind; scope `<manifestId>:<personId>:interactions`. */
export declare const PEOPLE_INTERACTIONS_KIND = "people_interactions";
type PeopleLearningMode = "publish" | "shadow";
type Confidence = "low" | "medium" | "high";
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
export declare const PEOPLE_INTERACTION_SCHEMA: Type.TObject<{
    status: Type.TEnum<["learned", "no_new_claims", "unresolved"]>;
    proposals: Type.TArray<Type.TObject<{
        section: Type.TEnum<["role", "relationship", "preferences", "workingStyle"]>;
        statement: Type.TString;
        /** Where the claim applies (required by the People store for preference/workingStyle claims). */
        scope: Type.TString;
        epistemicType: Type.TEnum<["reported", "observed"]>;
        confidence: Type.TUnion<[Type.TLiteral<"high">, Type.TLiteral<"medium">, Type.TLiteral<"low">]>;
        reason: Type.TString;
        citedHandles: Type.TArray<Type.TString>;
    }>>;
    summary: Type.TString;
}>;
export type PeopleInteractionResult = Static<typeof PEOPLE_INTERACTION_SCHEMA>;
type ShadowEvidence = {
    handle: string;
    sessionId: string;
    seq: number;
    role: "user" | "assistant";
    timestamp?: string;
    text: string;
    /** Optional response-audit outcome annotation (interaction learning only; never persisted). */
    signal?: string;
};
type EvidenceCoordinates = Omit<ShadowEvidence, "text" | "signal">;
/** Host screening outcome per model proposal (shadow and publish alike). */
type ClaimDecision = {
    index: number;
    outcome: "accepted" | "skipped";
    reason?: string;
};
/** What the fenced interaction commit did, recorded on the work row in the same transaction. */
type InteractionPublication = {
    /** applied: new claims written; recorded: reviewed with nothing new to write; skipped: not applied (stale manifest,
     *  paused, no dossier, every accepted claim broke dossier rules); unresolved: the model could not tell. */
    status: "applied" | "recorded" | "skipped" | "unresolved";
    reason: string;
    /** Source refs of every excerpt shown to the model (the reviewed evidence), never filesystem paths. */
    sourceRefs: string[];
    claims: {
        section: string;
        statement: string;
        outcome: "applied" | "skipped";
        reason?: string;
    }[];
    changeId?: string;
    verified?: boolean;
    publishedAt: string;
};
export type PeopleInteractionArtifact = {
    schemaVersion: 1;
    kind: "interactions";
    mode: PeopleLearningMode;
    manifestId: string;
    manifestRevision: string;
    personId: string;
    /** The dossier revision (latest change id) the prompt showed; the publish fence refuses any other. */
    dossierRevision: string | null;
    source: "model" | "host";
    result: PeopleInteractionResult;
    /** Every excerpt shown to the model (handle → source coordinates, no paths). */
    evidence: EvidenceCoordinates[];
    /** Honest review coverage: `reviewed` is only receipted when nothing was unreadable or dropped. */
    coverage: {
        sessionIds: string[];
        unreadableSessionIds: string[];
        droppedExcerpts: number;
        clippedExcerpts: number;
    };
    decisions: ClaimDecision[];
    usage?: StewardUsage;
    proposedAt: string;
    publication?: InteractionPublication;
};
/** What a publish-mode commit did to the dossier, recorded on the work row in the same transaction. */
type PeoplePublication = {
    /** applied: dossier revision written; recorded: verified without a dossier write; skipped: not applied (stale, inactive,
     *  below confidence, rule violation); unresolved: the proposal itself was unresolved. */
    status: "applied" | "recorded" | "skipped" | "unresolved";
    /** Disposition the receipt records (skipped publications are honestly `unresolved`). */
    disposition: Disposition;
    reason: string;
    /** Verified handle source refs (`session:<sessionId>#<seq>`), never filesystem paths. */
    sourceRefs: string[];
    changeId?: string;
    /** The written revision is bound to dossier verification (only when the prior revision was verified). */
    verified?: boolean;
    publishedAt: string;
};
export type PeopleShadowArtifact = {
    schemaVersion: 1;
    /** Absent on proposals written before publish mode existed (always shadow). */
    mode?: PeopleLearningMode;
    manifestId: string;
    manifestRevision: string;
    personId: string;
    assertionId: string;
    source: "model" | "host";
    proposal: PeopleShadowProposal;
    /** Handle → source coordinates (no filesystem paths). */
    evidence: EvidenceCoordinates[];
    usage?: StewardUsage;
    proposedAt: string;
    publication?: PeoplePublication;
};
/** Host context that lets a publish pass create missing manifests itself (no People Learning cron needed). */
export type PeopleInventoryContext = {
    cfg: OpenClawConfig;
    config: UnblockMemoryConfig;
    stateRoot?: string;
};
export type PeopleShadowPassOptions = {
    /** `"shadow"` (default when omitted) is strictly read-only outside work_items; `"publish"` applies verified proposals. */
    mode?: PeopleLearningMode;
    /** Publish mode only: inventory missing nightly/weekly manifests for the current review window before adjudicating. */
    inventoryContext?: PeopleInventoryContext;
    /** Publish mode only: lowest proposal confidence that may mutate/verify a dossier (default `"medium"`). */
    minConfidence?: Confidence;
    /** Publish mode only: whether external analysis is approved (default: derived from `inventoryContext.config`, else unknown → unresolved). */
    analysisApproved?: boolean;
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
    /** Per-proposal model deadline (`steward.peopleShadow.timeoutMs`); `0` = unlimited, omitted = runner default. */
    timeoutMs?: number;
    /** Maximum model calls this pass; `0` or omitted = unlimited. */
    maxItems?: number;
    /** Evidence handles per packet (most recent kept); `0` = unlimited. Default 16. */
    maxHandles?: number;
    /** Characters per excerpt; `0` = unlimited. Default 800. */
    maxExcerptChars?: number;
    /** Largest approved export file read; `0` = unlimited. Default 4 MiB. */
    maxExportBytes?: number;
    /** Skip assertions the cron already resolved for the same manifest revision. */
    skipCronResolved?: boolean;
    /**
     * Interaction learning (net-new claims from nightly sessions). Default: ON in publish mode, OFF in shadow mode
     * (shadow passes stay assertion-parity reports unless explicitly opted in).
     */
    includeInteractionLearning?: boolean;
    /** New claims published per person per manifest (highest confidence first); `0` or omitted = unlimited. */
    maxNewClaimsPerPerson?: number;
    /**
     * Evidence handles per interaction packet; `0` or omitted = unlimited. A packet that drops excerpts is never
     * receipted as a complete interaction review (the person stays `unresolved`), so the default reads everything.
     */
    maxInteractionHandles?: number;
    /** Annotate excerpts with response-audit outcome signals when that table exists (default `true`). */
    includeResponseAudit?: boolean;
    signal?: AbortSignal;
    now?: () => number;
};
type PeopleShadowItemOutcome = "staged" | "completed" | "resumed" | "rejected" | "skipped" | "busy" | "failed" | "interrupted" | "host_unresolved";
type PeopleCheckpointResult = {
    manifestId: string;
    manifestRevision: string;
    status: "complete" | "partial" | "invalid" | "stale" | "error";
    receiptId?: string;
    assertionReviews: number;
    /** Interaction-learning people reviews newly receipted by this checkpoint. */
    peopleReviews: number;
    changes: number;
    errors: string[];
};
export type PeopleShadowPassResult = {
    mode: PeopleLearningMode;
    manifests: {
        manifestId: string;
        manifestRevision: string;
        assertions: number;
    }[];
    /** Publish mode with `inventoryContext`: what the self-sufficient inventory step did. */
    inventory: PeopleManifestEnsureResult[];
    /** Publish mode: dossier publications this pass. */
    published: {
        applied: number;
        recorded: number;
        skipped: number;
        unresolved: number;
    };
    /** Publish mode: LearningReceipt checkpoints written this pass. */
    checkpoints: PeopleCheckpointResult[];
    /** Interaction learning commits this pass (`claimsAdded` counts dossier claims actually written). */
    learned: {
        applied: number;
        recorded: number;
        skipped: number;
        unresolved: number;
        claimsAdded: number;
    };
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
 * One pass: enqueue one `item` row per manifest assertion (and, with interaction learning, one per active nightly
 * roster person with sessions), then adjudicate up to `maxItems` of them through `runner.complete`, staging ONLY
 * host-verified proposals into `work_items`. In publish mode each verified proposal is applied in its fenced commit
 * and the run's `LearningReceipt` is checkpointed afterwards.
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
    /** Publish mode: what Steward actually published (from the completed rows' publication outcomes). */
    published: {
        applied: number;
        recorded: number;
        skipped: number;
        unresolved: number;
    };
    publishedItems: {
        scope: string;
        assertionId: string;
        personId: string;
        status: PeoplePublication["status"];
        disposition: Disposition;
        changeId?: string;
        publishedAt: string;
    }[];
    /** Live people_learning_runs status for every reported manifest (`missing` when the run row is gone). */
    runs: {
        manifestId: string;
        status: string;
        manifestRevision?: string;
    }[];
    /** Interaction learning (net-new claims) rows, in shadow or publish mode. */
    interactions: {
        learned: number;
        noNewClaims: number;
        unresolved: number;
        quarantined: number;
        pending: number;
        claimsProposed: number;
        claimsAccepted: number;
        claimsApplied: number;
        usageTotals: UsageTotals;
        items: {
            scope: string;
            personId: string;
            manifestId: string;
            mode?: PeopleLearningMode;
            status: string;
            result?: PeopleInteractionResult["status"];
            publication?: InteractionPublication["status"];
            changeId?: string;
            claims: {
                section: string;
                statement: string;
                outcome: string;
                reason?: string;
            }[];
        }[];
    };
};
/** Read-only side-by-side of shadow proposals vs the cron's receipt for the same manifest revision. */
export declare function buildPeopleShadowReport(dbPath: string, manifestId?: string): PeopleShadowReport;
export {};
