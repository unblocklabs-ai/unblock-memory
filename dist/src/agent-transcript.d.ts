import type { DatabaseSync } from "node:sqlite";
/** Identity fence, not a payload-format allowlist. Required capabilities are checked below. */
export declare function agentTranscriptSchemaVersion(db: DatabaseSync, errorMessage?: string): number;
export declare function assertAgentTranscriptIdentity(db: DatabaseSync, agentId: string, version: number, errorMessage?: string): void;
type AgentTranscriptRow = {
    seq: number;
    eventJson: string;
    createdAt: number;
};
type TranscriptSnapshot = {
    kind: "ready";
    rows: AgentTranscriptRow[];
} | {
    kind: "cold";
} | {
    kind: "oversized";
} | {
    kind: "unreadable";
};
/**
 * One read-only storage boundary for full-fidelity active transcripts. The public
 * SDK's full reader may restore cold archives; its read-only catalog truncates and
 * redacts content. Neither currently provides the contract these consumers need.
 * Keep payload SQL here until the SDK offers a bounded, full-fidelity read-only API.
 */
export declare class AgentTranscriptReader {
    #private;
    readonly db: DatabaseSync;
    constructor(db: DatabaseSync, agentId: string, errorMessage?: string);
    /** Include storage availability in incremental fingerprints, not just hot row counts. */
    coldSql(sessionIdExpression: string): string;
    /** Caller owns a transaction so metadata, cold marker, bounds and rows share one snapshot. */
    read(sessionId: string, limits?: {
        maxEvents?: number;
        maxBytes?: number;
        maxSeq?: number;
    }): TranscriptSnapshot;
}
export {};
