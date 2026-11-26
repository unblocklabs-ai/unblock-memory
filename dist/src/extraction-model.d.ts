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
    replaces: null;
    evidence: {
        messageId: string;
        quote: string;
    }[];
};
export declare function extractionOverhead(_existing?: PriorMemory[]): number;
export declare function extractionMessageTokens(message: ExtractionMessage): number;
export declare function extractionMessageBytes(message: ExtractionMessage): number;
export declare function extractionValidationTranscriptBudget(_existing?: PriorMemory[]): number;
type ProposeParams = {
    messages: ExtractionMessage[];
    newIds: string[];
    existing?: PriorMemory[];
    apiKey: string;
    endpoint?: string;
    model?: string;
    signal: AbortSignal;
    timeoutMs?: number;
    minReplacement?: number;
};
export declare function extractWithDecisionModel(params: ProposeParams): Promise<MemoryProposal[]>;
type ValidationThresholds = Pick<ExtractionConfig, "minSupport" | "minRetention">;
type ValidationJudgment = {
    accepted: false;
    reason: "invalid_evidence";
} | {
    accepted: boolean;
    reason: "judged";
    scores: {
        supported: number;
        useful: number;
    };
    thresholds: ValidationThresholds;
};
export declare function validateExtractedMemories(params: {
    proposals: readonly MemoryProposal[];
    messages: ExtractionMessage[];
    newIds: string[];
    existing?: PriorMemory[];
    apiKey: string;
    endpoint?: string;
    model?: string;
    signal: AbortSignal;
    thresholds: ValidationThresholds;
}): Promise<ValidationJudgment[]>;
export {};
