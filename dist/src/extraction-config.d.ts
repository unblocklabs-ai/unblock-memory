import type { ChatType, CorpusConfig } from "./config.js";
export type ExtractionConfig = {
    enabled: boolean;
    publish: boolean;
    intervalMinutes: number;
    chatTypes: ChatType[];
    historyMessages: number;
    maxBatches: number;
    minSupport: number;
    minRetention: number;
    minReplacement: number;
};
export declare function resolveExtraction(value: unknown, corpora: readonly CorpusConfig[]): ExtractionConfig;
