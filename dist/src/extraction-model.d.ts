import { Type, type Static } from "typebox";
import type { ExtractionConfig } from "./extraction-config.js";
export declare const EXTRACTION_VERSION = "lasting-facts-v11";
export declare const EXTRACTION_INPUT_TARGET = 24000;
export declare const EXTRACTION_INPUT_LIMIT = 28000;
export type ExtractionMessage = {
    id: string;
    speaker: string;
    role: "user" | "assistant";
    text: string;
    timestamp: number;
    sourceMessageId?: string;
    textOffset?: number;
};
export type PriorMemory = {
    id: string;
    text: string;
    observedAt?: number;
};
declare const proposalSchema: Type.TObject<{
    memories: Type.TArray<Type.TObject<{
        text: Type.TString;
        replaces: Type.TUnion<[Type.TNull, Type.TString]>;
        evidence: Type.TArray<Type.TObject<{
            messageId: Type.TString;
            quote: Type.TString;
        }>>;
    }>>;
}>;
export type MemoryProposal = Static<typeof proposalSchema>["memories"][number];
export declare function extractionOverhead(existing: PriorMemory[]): number;
export declare function extractionMessageTokens(message: ExtractionMessage): number;
/** A narrow capability boundary keeps this optional feature inert on older hosts. */
export declare function extractWithLuna(runtime: unknown, agentId: string, messages: ExtractionMessage[], newIds: string[], existing: PriorMemory[], signal: AbortSignal): Promise<MemoryProposal[]>;
export declare function validateExtractedMemory(params: {
    proposal: MemoryProposal;
    messages: ExtractionMessage[];
    newIds: string[];
    existing: PriorMemory[];
    apiKey: string;
    signal: AbortSignal;
    thresholds: Pick<ExtractionConfig, "minSupport" | "minRetention" | "minReplacement">;
}): Promise<{
    accepted: boolean;
    reason: "invalid_evidence";
    scores?: undefined;
    thresholds?: undefined;
} | {
    accepted: boolean;
    reason: "judged";
    scores: {
        supported: number;
        useful: number;
        replacement: number;
    };
    thresholds: Pick<ExtractionConfig, "minSupport" | "minRetention" | "minReplacement">;
}>;
export {};
