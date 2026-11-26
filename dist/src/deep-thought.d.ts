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
    question: Type.TString;
    focus: Type.TOptional<Type.TString>;
    corpora: Type.TOptional<Type.TArray<Type.TString>>;
    maxHops: Type.TOptional<Type.TInteger>;
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
    maxTurns: number;
    maxToolCalls: number;
    timeoutMs: number;
    maxConcurrent?: number;
    maxInputTokens?: number;
    maxToolResultChars?: number;
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
    status: "complete" | "incomplete" | "needs_decision" | "busy" | "timed_out" | "cancelled" | "failed" | "invalid_request" | "unavailable";
    answer?: string;
    confidence?: DeepThoughtResult["confidence"];
    citations: DeepThoughtCitation[];
    openQuestions: string[];
    hopsUsed: number;
    toolCallsUsed: number;
    elapsedMs: number;
    usage?: StewardUsage;
    unverifiedCitationsDropped?: number;
    corpora?: string[];
    error?: string;
};
/** Current process-wide in-flight `deep_thought` investigations (diagnostics/tests). */
export declare function activeDeepThoughts(): number;
/** Tool factory: `api.registerTool((ctx) => createDeepThoughtTool(ctx, deps), { names: ["deep_thought"] })`. */
export declare function createDeepThoughtTool(ctx: OpenClawPluginToolContext, deps: DeepThoughtDeps | undefined): {
    name: string;
    label: string;
    description: string;
    parameters: Type.TObject<{
        question: Type.TString;
        focus: Type.TOptional<Type.TString>;
        corpora: Type.TOptional<Type.TArray<Type.TString>>;
        maxHops: Type.TOptional<Type.TInteger>;
    }>;
    execute(_toolCallId: string, raw: unknown, signal?: AbortSignal): Promise<ReturnType<typeof jsonResult>>;
} | null;
export {};
