import type { ChatType } from "./config.js";
import type { ExtractionSession } from "./extraction-store.js";
import type { ExtractionMessage } from "./extraction-model.js";
export declare function extractionSessions(databasePath: string, agentId: string, chatTypes: ChatType[]): ExtractionSession[];
export type ExtractionPage = {
    kind: "page";
    cursor: string;
    hasMore: boolean;
    messages: ExtractionMessage[];
    entryCount: number;
} | {
    kind: "reset";
    cursor: string;
} | {
    kind: "missing";
} | {
    kind: "unavailable";
};
export declare function readExtractionPage(agentId: string, agentName: string, session: ExtractionSession, cursor: string | null, read?: (params: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    cursor?: string;
    maxMessages: number;
    maxBytes: number;
}) => Promise<unknown>): Promise<ExtractionPage>;
