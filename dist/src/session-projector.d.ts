import type { ChatType } from "./config.js";
export type SessionMetadata = {
    sessionId: string;
    provider?: string;
    chatType: ChatType;
    accountId?: string;
    conversationId?: string;
    startedAt: number;
};
export type SessionProjectionInput = SessionMetadata & {
    label?: string;
    agentName: string;
    timezone: string;
    events: readonly {
        eventJson: string;
        createdAt: number;
    }[];
    /** Optional counters for this projection pass; never contains source text. */
    diagnostics?: {
        internalMessagesCleaned: number;
        attachmentsCleaned: number;
        attachmentBudgetSkipped: number;
    };
};
export type SessionSnippetMessage = {
    type?: "user" | "assistant";
    name?: string;
    timestamp?: string;
    body: string;
    partial?: true;
};
/** Character offsets in the exact indexed projection; end excludes message separators. */
export type SessionMessageSpan = {
    type: "user" | "assistant";
    name: string;
    timestamp: string;
    start: number;
    bodyStart: number;
    end: number;
};
export type SessionContextSpans = {
    message: {
        start: number;
        end: number;
        timestamp: string;
    };
    turn: {
        start: number;
        end: number;
    };
};
export declare function projectSession(input: SessionProjectionInput): string | undefined;
export declare function projectSessionDocument(input: SessionProjectionInput): {
    content: string;
    messages: SessionMessageSpan[];
} | undefined;
/** Legacy fallback only. New projections retain exact boundaries before rendering Markdown. */
export declare function parseSessionMessageSpans(content: string): SessionMessageSpan[];
export declare function sessionContextSpans(content: string, position: number, markers?: SessionMessageSpan[]): SessionContextSpans | undefined;
export declare function sessionSnippetMessages(content: string, selected: {
    text: string;
    position: number;
    sourceText?: string;
}, spans: readonly SessionMessageSpan[], identity?: {
    agentId: string;
    agentName: string;
}): SessionSnippetMessage[];
export declare function sessionDocumentPath(metadata: SessionMetadata): string;
export declare function resolveTimezone(configured?: string): string;
