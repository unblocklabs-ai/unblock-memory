import { Type, type Static } from "typebox";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { MemoryReadCursor, MemoryReadResult, MemoryRequestContext } from "./contracts.js";
import { type MemoryCandidateManager } from "./memory-search.js";
import { getContext } from "./tool-context.js";
import type { StewardConfig } from "./steward-config.js";
import type { StewardRunner, StewardUsage } from "./steward-runner.js";
/** The curator's final answer (wrapped by the runner's `submit_result` with a status). */
export declare const DEEP_THOUGHT_RESULT_SCHEMA: Type.TObject<{
    answer: Type.TString;
    confidence: Type.TUnion<[Type.TLiteral<"high">, Type.TLiteral<"medium">, Type.TLiteral<"low">]>;
    citations: Type.TArray<Type.TObject<{
        source: Type.TString;
        lines: Type.TOptional<Type.TString>;
        date: Type.TOptional<Type.TString>;
        quote: Type.TString;
    }>>;
    openQuestions: Type.TOptional<Type.TArray<Type.TString>>;
}>;
export type DeepThoughtResult = Static<typeof DEEP_THOUGHT_RESULT_SCHEMA>;
declare const deepThoughtParameters: Type.TObject<{
    question: Type.TOptional<Type.TString>;
    focus: Type.TOptional<Type.TString>;
    corpora: Type.TOptional<Type.TArray<Type.TString>>;
    maxHops: Type.TOptional<Type.TInteger>;
    jobId: Type.TOptional<Type.TString>;
    cancel: Type.TOptional<Type.TBoolean>;
}>;
export type DeepThoughtParams = Static<typeof deepThoughtParameters>;
type DeepThoughtManager = MemoryCandidateManager & {
    readFile(params: {
        relPath: string;
        from?: number;
        lines?: number;
        cursor?: MemoryReadCursor;
        requestContext?: MemoryRequestContext;
    }): Promise<MemoryReadResult>;
};
/** Structural subset of `QmdMemoryRuntime` the curator needs. */
export type DeepThoughtRuntime = {
    searchableCorpora(): string[];
    getMemorySearchManager(params: NonNullable<ReturnType<typeof getContext>>): Promise<{
        manager: DeepThoughtManager | null;
        error?: string;
    }>;
};
type PersonLike = {
    id: string;
    displayName: string;
    preferredName: string | null;
    status: string;
    injectionEnabled?: boolean;
};
type IdentityLike = {
    personId: string;
    provider: string;
    accountScope: string;
    externalId: string;
    displayName: string | null;
    realName: string | null;
    handle: string | null;
    title: string | null;
    isBot: boolean | null;
    isDeactivated: boolean;
};
type ClaimLike = {
    statement: string;
    epistemicType: string;
    confidence?: string;
    scope?: string;
    reviewedAt?: string;
    expiresAt?: string;
};
type DossierLike = {
    blurb: string;
    sections: {
        category: string;
        claims: ClaimLike[];
    }[];
};
/** Read-only structural subset of `PeopleStores`; `lookup_person` never writes. */
type DeepThoughtPeopleSource = {
    get(agentId: string): {
        listActivePeople(limit?: number, offset?: number, includeInactive?: boolean): PersonLike[];
        listIdentities(personId: string): IdentityLike[];
        getVerifiedDossier(personId: string): {
            dossier: DossierLike;
            reviewedAt: string;
        } | undefined;
    };
};
export type DeepThoughtConfig = {
    enabled: boolean;
    /** Maximum investigation turns (`0` = unlimited). */
    maxTurns: number;
    /** Maximum tool calls per investigation (`0` = unlimited). */
    maxToolCalls: number;
    /** Wall-clock timeout in ms (`0` = unlimited). */
    timeoutMs: number;
    /** Sync fast-path wait window in ms before handing off a running `jobId` (`0` = wait until completion). */
    syncWaitMs?: number;
    /** How long finished background jobs remain collectible in ms (`0` = until process exit). */
    jobRetentionMs?: number;
    /** Reserve ms for forced wrap-up when `timeoutMs > 0` (`0` = disabled). */
    wrapUpReserveMs?: number;
    /** Maximum concurrent deep_thought calls (`0` = unlimited). */
    maxConcurrent?: number;
    /** Maximum client-side input tokens per model turn (`0` = unlimited). */
    maxInputTokens?: number;
    /** Maximum characters returned per tool result (`0` = unlimited). */
    maxToolResultChars?: number;
    /** Search ranking inside deep_thought: local hybrid retrieval (`"retrieval"`) or decision model (`"decision"`). */
    searchRanking?: "retrieval" | "decision";
    /** Minimum decision-model usefulness (0..1) when `searchRanking === "decision"`. */
    searchMinUsefulness?: number;
    /** Default results per `search_memory` call when the curator omits `maxResults`. */
    defaultSearchResults?: number;
    /** Maximum characters per `search_memory` snippet (`0` = unlimited). */
    maxSnippetChars?: number;
    /** Maximum characters per citation quote (`0` = unlimited). */
    maxQuoteChars?: number;
    /** Maximum people returned by `lookup_person` (`0` = unlimited). */
    maxPeopleMatches?: number;
    model?: string;
    reasoning?: StewardConfig["reasoning"];
};
export type DeepThoughtDeps = {
    runtime: DeepThoughtRuntime;
    runner: Pick<StewardRunner, "run">;
    config: DeepThoughtConfig;
    decisionModel: Pick<UnblockMemoryConfig["decisionModel"], "enabled" | "apiKey" | "apiKeyFile" | "endpoint" | "model" | "timeoutMs">;
    people?: {
        enabled: boolean;
        stores: DeepThoughtPeopleSource;
    };
    /** Test seam; defaults to the plugin's origin-bound decision credential resolver. */
    resolveCredential?: () => Promise<string | undefined>;
    now?: () => number;
};
type DeepThoughtCitation = DeepThoughtResult["citations"][number];
export type DeepThoughtOutcome = {
    status: "complete" | "incomplete" | "needs_decision" | "running" | "busy" | "timed_out" | "cancelled" | "failed" | "invalid_request" | "unavailable";
    jobId?: string;
    answer?: string;
    confidence?: DeepThoughtResult["confidence"];
    citations: DeepThoughtCitation[];
    openQuestions: string[];
    hopsUsed: number;
    toolCallsUsed: number;
    elapsedMs: number;
    lastTool?: string;
    note?: string;
    usage?: StewardUsage;
    unverifiedCitationsDropped?: number;
    corpora?: string[];
    error?: string;
};
/** Current process-wide in-flight `deep_thought` investigations (diagnostics/tests). */
export declare function activeDeepThoughts(): number;
/** Abort and clear any background `deep_thought` jobs on Gateway stop (or test cleanup). */
export declare function cancelAllDeepThoughtJobs(): void;
/** Tool factory: `api.registerTool((ctx) => createDeepThoughtTool(ctx, deps), { names: ["deep_thought"] })`. */
export declare function createDeepThoughtTool(ctx: OpenClawPluginToolContext, deps: DeepThoughtDeps | undefined): {
    name: string;
    label: string;
    description: string;
    parameters: Type.TObject<{
        question: Type.TOptional<Type.TString>;
        focus: Type.TOptional<Type.TString>;
        corpora: Type.TOptional<Type.TArray<Type.TString>>;
        maxHops: Type.TOptional<Type.TInteger>;
        jobId: Type.TOptional<Type.TString>;
        cancel: Type.TOptional<Type.TBoolean>;
    }>;
    execute(_toolCallId: string, raw: unknown, signal?: AbortSignal): Promise<ReturnType<typeof jsonResult>>;
} | null;
export {};
