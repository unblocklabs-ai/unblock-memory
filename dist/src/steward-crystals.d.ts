import { Type, type Static } from "typebox";
import type { MemoryAnalysisSummary, MemoryClusterDetail, MemoryClusterList, MemoryClusterSort } from "./analysis.js";
import type { StewardRunner, StewardUsage } from "./steward-runner.js";
import type { WorkStore } from "./work-store.js";
export declare const CRYSTALS_KIND = "memory_crystals";
export declare const CRYSTALS_DEFAULTS: {
    readonly intervalMinutes: 360;
    readonly reclusterMinIntervalMinutes: 720;
    readonly autoRecluster: true;
    readonly minClusterSize: 3;
    readonly maxClustersPerRun: 0;
    readonly maxMembersPerCluster: 12;
    readonly stmStaleAfterMinutes: 20160;
    readonly ltmPromoteMinHelped: 3;
    readonly ltmPromoteMinHits: 5;
    readonly allowedCorpora: readonly ["memory", "knowledge"];
    readonly timeoutMs: 0;
    readonly prioritizeEmotionalSalience: true;
};
declare const CRYSTAL_SYNTHESIS_SCHEMA: Type.TObject<{
    shouldCrystallize: Type.TBoolean;
    title: Type.TString;
    summary: Type.TString;
    citedHandles: Type.TArray<Type.TString>;
    skipReason: Type.TOptional<Type.TString>;
}>;
export type CrystalSynthesis = Static<typeof CRYSTAL_SYNTHESIS_SCHEMA>;
type NativeAnalysisMember = NonNullable<MemoryClusterDetail["members"]>[number];
type MemberLocator = "chunkPos" | "chunkLen" | "sourceCollections";
/**
 * Native analysis (`readCluster`) returns the indexed UTF-16 span (`chunkPos`/`chunkLen`) and EVERY active collection
 * holding the hash (`sourceCollections`). Lighter adapters may omit them: without a span only a complete, hash-proven
 * document is citable, and without `sourceCollections` the (display-capped) `sourcePaths` are the only ACL input.
 */
type CrystalAnalysisMember = Omit<NativeAnalysisMember, MemberLocator> & Partial<Pick<NativeAnalysisMember, MemberLocator>>;
export type CrystalsAnalysis = {
    listClusters(limit?: number): Promise<MemoryClusterList>;
    fetchCluster(params: {
        clusterId: string;
        memberLimit?: number;
        sort?: MemoryClusterSort;
        offset?: number;
    }): Promise<Omit<MemoryClusterDetail, "members"> & {
        members?: CrystalAnalysisMember[];
    }>;
    /** Omit when analysis.executable is not configured. */
    recluster?(signal?: AbortSignal): Promise<MemoryAnalysisSummary>;
};
export type CrystalsPassOptions = {
    agentId: string;
    owner: string;
    workStore: WorkStore;
    analysis: CrystalsAnalysis;
    runner?: Pick<StewardRunner, "complete">;
    /** Maps native QMD collection IDs to trusted corpus names; unresolved IDs are ineligible. */
    corpusForCollection?: (collection: string) => string | undefined;
    /** Limit passed to the analysis list API, independent of the per-pass synthesis budget. */
    maxClusters?: number;
    intervalMinutes?: number;
    reclusterMinIntervalMinutes?: number;
    autoRecluster?: boolean;
    minClusterSize?: number;
    maxClustersPerRun?: number;
    maxMembersPerCluster?: number;
    stmStaleAfterMinutes?: number;
    ltmPromoteMinHelped?: number;
    ltmPromoteMinHits?: number;
    allowedCorpora?: readonly string[];
    timeoutMs?: number;
    /**
     * Let high-salience (Flashbulb) evidence take a bounded share of member slots and nudge the synthesis order. Off: the
     * representative sample only, and no salience is read.
     */
    prioritizeEmotionalSalience?: boolean;
    /** Prior intensity grades a person needs before relative intensity counts (`insideOut.baselineMinInteractions`). */
    baselineMinInteractions?: number;
    /** Operator run (`memory-steward crystals --run`): start before the schedule (never steals a live lease). */
    ignoreDueAt?: boolean;
    signal?: AbortSignal;
    leaseMs?: number;
    heartbeatMs?: number;
    now?: () => number;
};
type Counts = {
    created: number;
    revised: number;
    skippedUnchanged: number;
    skippedAudience: number;
    promoted: number;
    retired: number;
    /** Synthesis model calls actually made (the unit `maxClustersPerRun` caps). */
    synthesized: number;
};
type Outcome = {
    status: "ok" | "aborted" | "already_running" | "not_due";
} | {
    status: "failed";
    reason: string;
};
export type CrystalsPassResult = Outcome & Counts & {
    reclustered: boolean;
    nextDueAt?: number;
    usage?: StewardUsage;
    /** Per-cluster model failures (`<clusterId>:<code>`) that did not stop the pass: the rest still published and decayed. */
    errors: string[];
};
/** Run one per-agent scheduled pass. Publication, decay and re-arming share the WorkStore commit fence. */
export declare function runCrystalsPass(options: CrystalsPassOptions): Promise<CrystalsPassResult>;
export {};
