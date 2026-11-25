import type { ExtractionConfig } from "./extraction-config.js";
export declare const EXTRACTION_VERSION: string;
export declare const EXTRACTION_INPUT_TARGET: number;
export declare const EXTRACTION_INPUT_LIMIT: number;
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
export type MemoryProposal = {
    text: string;
    replaces: string | null;
    evidence: {
        messageId: string;
        quote: string;
    }[];
};
export declare function extractionOverhead(existing: PriorMemory[]): number;
export declare function extractionMessageTokens(message: ExtractionMessage): number;
type ProposeParams = {
    messages: ExtractionMessage[];
    newIds: string[];
    existing: PriorMemory[];
    apiKey: string;
    endpoint?: string;
    model?: string;
    signal: AbortSignal;
    timeoutMs?: number;
    minReplacement?: number;
};
export declare function extractWithDecisionModel(params: ProposeParams): Promise<MemoryProposal[]>;
export declare function validateExtractedMemory(params: {
    proposal: MemoryProposal;
    messages: ExtractionMessage[];
    newIds: string[];
    existing: PriorMemory[];
    apiKey: string;
    endpoint?: string;
    model?: string;
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
