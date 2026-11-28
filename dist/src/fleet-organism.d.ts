import type { DatabaseSync } from "node:sqlite";
import { type SentimentDriftMetric, type SentimentDriftOptions } from "./emotion-baselines.js";
/** Prometheus label and hub row keys stay short; `maxLength` 0 = unlimited. */
export declare const isFleetAlias: (value: unknown, maxLength?: number) => value is string;
export declare const isFleetRecipeHash: (value: string) => boolean;
export declare const isFleetProposalKind: (value: string) => boolean;
type SnapshotIdentity = {
    schemaVersion: 1;
    nodeId: string;
    agentId: string;
    collectedAtMs: number;
};
type Rates = {
    whisperUsedRate: number | null;
    skillOpenRate: number | null;
    shortfallsPer100Turns: number | null;
};
type OutcomeCounts = {
    total: number;
    helped: number;
    ignored: number;
    hurt: number;
};
type OutcomeMetrics = OutcomeCounts & Rates;
type Denominators = {
    deliveredMemoryHits: number;
    suggestedSkills: number;
    turns: number;
};
type RecipeMetrics = OutcomeMetrics & {
    denominators: Denominators;
};
export type NodeTelemetrySnapshot = SnapshotIdentity & {
    sinceHours: number;
    outcomes: OutcomeMetrics & {
        byRecipe: Record<string, RecipeMetrics>;
    };
    crystals: {
        stm: number;
        ltm: number;
        coreMemories: number;
    };
    expectations: {
        open: number;
        kept: number;
        broken: number;
        overdue: number;
    };
    derivedObservations: {
        fresh: number;
        stale: number;
        totalHits: number;
    };
    skillProposals: {
        pending: number;
        byKind: Record<string, number>;
    };
    sentimentDriftFlaggedCount: number;
    quarantinedWorkItems: number;
};
type BriefExpectation = {
    kind: string;
    summary: string;
    dueAtMs: number;
};
export type NodeBriefSnapshot = SnapshotIdentity & {
    operatorOnly: true;
    blockers: {
        topic: string;
        summary: string;
        capturedAtMs: number;
    }[];
    overdueExpectations: BriefExpectation[];
    dueSoonExpectations: BriefExpectation[];
    sentimentDrift: {
        personId: string;
        metric: SentimentDriftMetric;
        reason: string;
    }[];
    skillProposals: {
        kind: string;
        skillName: string;
        title: string;
        recallGainPp: number | null;
    }[];
    quarantinedWorkItems: {
        kind: string;
        scope: string;
        strikes: number;
        lastError: string | null;
    }[];
};
type SnapshotOptions = {
    /** Operator-assigned infrastructure aliases, not customer, person, or channel identifiers. */
    nodeId: string;
    agentId: string;
    /** Local selection key when it differs from the reporting alias. Never exported. */
    sourceAgentId?: string;
    nowMs?: number;
    drift?: Omit<SentimentDriftOptions, "now">;
};
type Source = DatabaseSync | string;
/** Reads the local store without migrations. A missing file or component contributes zeros. */
export declare function buildNodeTelemetrySnapshot(source: Source, options: SnapshotOptions & {
    /** Outcome lookback; 0 includes all history before collection. */
    sinceHours?: number;
}): NodeTelemetrySnapshot;
/** Private operator channel. Never use these rows as metrics labels or telemetry fields. */
export declare function buildNodeBriefSnapshot(source: Source, options: SnapshotOptions & {
    /** Hours ahead to include; 0 disables due-soon items. */
    dueSoonHours?: number;
    /** Per category, 0 = unlimited. */
    limit?: number;
}): NodeBriefSnapshot;
/**
 * Rolls recipes up per `sinceHours` window: a 24h snapshot and an all-history (`0`) snapshot are different
 * populations, so they never share a row. `coverageFromMs`/`coverageToMs` bound the outcomes the row can include
 * (`coverageFromMs` null = all history).
 */
export declare function aggregateAbLeaderboard(snapshots: readonly NodeTelemetrySnapshot[]): {
    whisperUsedRate: number | null;
    skillOpenRate: number | null;
    shortfallsPer100Turns: number | null;
    nodeCount: number;
    nodes: string[];
    coverageFromMs: number | null;
    coverageToMs: number;
    total: number;
    helped: number;
    ignored: number;
    hurt: number;
    sinceHours: number;
    recipeHash: string;
}[];
export declare function formatPrometheusMetrics(snapshots: readonly NodeTelemetrySnapshot[]): string;
export declare function renderFleetMorningBrief(briefs: readonly NodeBriefSnapshot[], telemetry?: readonly NodeTelemetrySnapshot[]): string;
/** POST to the exact telemetry or brief endpoint. Do not follow redirects with an operator payload. */
export declare function pushNodeSnapshot(snapshot: NodeTelemetrySnapshot | NodeBriefSnapshot, options: {
    endpoint: string | URL;
    apiKey?: string;
    apiKeyFile?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<void>;
export {};
