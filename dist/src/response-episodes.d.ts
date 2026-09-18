import type { ResponseAuditConfig } from "./response-config.js";
export declare const RESPONSE_EXTRACTOR_VERSION = 5;
type Row = {
    seq: number;
    eventJson: string;
    createdAt: number;
};
export type ResponseSession = {
    sessionId: string;
    accountId: string;
    chatType: string;
    conversationId: string;
};
type Text = {
    seq: number;
    role: "user" | "assistant";
    text: string;
};
export type ResponseEpisode = {
    id: string;
    inputHash: string;
    session: ResponseSession;
    senderId: string;
    thread: string;
    timestamp: number;
    model: string;
    before: Text[];
    request: Text[];
    answer: Text[];
    feedback: Text[];
    followup: {
        status: "pending" | "complete" | "partial" | "unavailable" | "oversized";
        messages: Text[];
    };
    memorySearchCalls: number;
    contextLimited: boolean;
};
type ResponseCoverage = {
    completedResponses: number;
    eligible: number;
    noFeedback: number;
    pendingFeedback: number;
    oversized: number;
    filteredEvents: number;
};
/** Never deduce human identity from text or the user role alone. */
export declare function responseEpisodes(session: ResponseSession, rows: readonly Row[], config: ResponseAuditConfig): {
    episodes: ResponseEpisode[];
    coverage: ResponseCoverage;
};
/** Bounded, read-only active transcript snapshot; archived/deleted branches are excluded. */
export declare class ResponseTranscriptReader {
    #private;
    constructor(path: string, agentId: string);
    sessions(config: ResponseAuditConfig, now: number, after?: string): ResponseSession[];
    /** null = confirmed absent/ineligible; undefined = over budget, not evidence of deletion. */
    read(input: ResponseSession | string, config: ResponseAuditConfig): (ReturnType<typeof responseEpisodes> & {
        revision: string;
    }) | null | undefined;
    read(input: ResponseSession | string, config: ResponseAuditConfig, previousRevision: string | undefined): (ReturnType<typeof responseEpisodes> & {
        revision: string;
    }) | {
        unchanged: true;
        revision: string;
    } | null | undefined;
    close(): void;
}
export {};
