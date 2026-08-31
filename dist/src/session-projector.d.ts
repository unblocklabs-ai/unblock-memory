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
};
export type SessionContextSpans = {
    message: {
        start: number;
        end: number;
    };
    turn: {
        start: number;
        end: number;
    };
};
export declare function projectSession(input: SessionProjectionInput): string | undefined;
export declare function sessionContextSpans(content: string, position: number): SessionContextSpans | undefined;
export declare function sessionDocumentPath(metadata: SessionMetadata): string;
export declare function resolveTimezone(configured?: string): string;
