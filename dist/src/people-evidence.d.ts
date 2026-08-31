export type PersonSessionEvidence = {
    source: "session";
    locator: string;
    observedAt: string;
    text: string;
    context: Array<{
        locator: string;
        role: string;
        text: string;
        senderId?: string;
    }>;
};
export declare function readPersonSessionEvidence(params: {
    databasePath: string;
    agentId: string;
    accountScope: string;
    externalId: string;
    limit?: number;
    maxMessageChars?: number;
    excludeLocators?: ReadonlySet<string>;
}): PersonSessionEvidence[];
