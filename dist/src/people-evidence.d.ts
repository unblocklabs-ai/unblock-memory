export type PersonSessionEvidence = {
    source: "session";
    locator: string;
    observedAt: string;
    text: string;
};
export declare function readPersonSessionEvidence(params: {
    databasePath: string;
    agentId: string;
    accountScope: string;
    externalId: string;
    limit?: number;
    maxMessageChars?: number;
}): PersonSessionEvidence[];
