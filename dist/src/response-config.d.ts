import type { ChatType, CorpusConfig } from "./config.js";
export type ResponseAuditConfig = {
    enabled: boolean;
    sentimentEnabled: boolean;
    senderIds: string[];
    chatTypes: ChatType[];
    historyMessages: number;
    lookbackDays: number;
    maxEpisodes: number;
    intervalMinutes: number;
    memoryCorpora: string[];
};
export declare function resolveResponseAudit(value: unknown, corpora: readonly CorpusConfig[]): ResponseAuditConfig;
