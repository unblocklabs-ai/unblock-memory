import type { ChatType } from "./config.js";
import type { ExtractionSession } from "./extraction-store.js";
import type { ExtractionMessage } from "./extraction-model.js";
import { type SessionProjectionInput } from "./session-projector.js";
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
export declare function bindExtractionPageReader({ agentId, agentName, session, signal, readPage }: {
    agentId: string;
    agentName: string;
    session: ExtractionSession;
    signal: AbortSignal;
    readPage?: typeof readExtractionPage;
}): (cursor: string | null) => Promise<ExtractionPage>;
export declare function readExtractionPage(agentId: string, agentName: string, session: ExtractionSession, cursor: string | null, read?: (params: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    cursor?: string;
    maxMessages: number;
    maxBytes: number;
}) => Promise<unknown>, signal?: AbortSignal, syntheticInput?: SessionProjectionInput["syntheticInput"]): Promise<ExtractionPage>;
