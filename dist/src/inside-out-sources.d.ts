type InsideOutEvent = {
    type: string;
    seq: number;
    id?: string;
    parentId?: string | null;
    targetId?: string | null;
    timestamp?: string;
    message?: {
        role: string;
        content?: unknown;
        timestamp?: number;
        channel?: string;
        provider?: string;
        model?: string;
        sourceChannel?: string;
        senderId?: string;
        openclawDeliveryMirror?: unknown;
        openclawMessageToolMirror?: unknown;
        provenance?: {
            kind?: string;
        };
        __openclaw?: {
            senderId?: string;
            senderIsOwner?: boolean;
            senderIdentity?: {
                id?: string;
                senderKind?: string;
                type?: string;
                pluginId?: string;
                accountId?: string;
            };
            transport?: {
                channel?: string;
                threadId?: string | number;
            };
        };
    };
};
/**
 * The message identity Inside Out stores as `message_id` for a live transcript row: the event id, or the hash of the
 * event exactly as {@link liveTranscriptEvent} builds it. Captain's Log joins grades on this, so ID-less events match.
 */
export declare function liveTranscriptMessageId(row: {
    eventJson: string;
    seq: number;
    createdAt: number;
}): string;
export type InsideOutSource = {
    sessionId: string;
    channel: string;
    account: string;
    source: string;
    events: InsideOutEvent[];
};
type SourceReader = {
    source: string;
    sessionId?: string;
    signature: string;
    revision: string;
    read: () => InsideOutSource;
};
type Paths = {
    agentId: string;
    databasePath: string;
    sessionsDir?: string;
    sessionId?: string;
};
/** No age cutoff. Each copy is read independently; stable message IDs deduplicate judgments. */
export declare function readInsideOutSources(paths: Paths, errors: string[]): AsyncGenerator<SourceReader>;
export {};
