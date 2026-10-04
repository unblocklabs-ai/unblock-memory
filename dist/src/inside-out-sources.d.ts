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
            upstreamUserText?: string;
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
