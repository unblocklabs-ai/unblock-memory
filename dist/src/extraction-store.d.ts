import type { ExtractionMessage, MemoryProposal } from "./extraction-model.js";
import type { SessionMetadata } from "./session-projector.js";
export type ExtractionSession = SessionMetadata & {
    sessionKey: string;
    changedAt?: number;
    sourceRevision?: string;
};
type Checkpoint = {
    cursor: string | null;
    context: ExtractionMessage[];
    since: number;
    completeRevision: string | null;
    policyFingerprint: string | null;
};
export type ExtractedRecord = {
    id: string;
    revision: number;
    text: string;
    sessionId: string;
    observedAt: number;
    evidence: MemoryProposal["evidence"];
    metadata: ExtractionSession;
    judgment: unknown;
};
export declare class ExtractionLeaseLostError extends Error {
    constructor();
}
export declare function extractionPolicyFingerprint(params: {
    version: string;
    historyMessages: number;
    minSupport: number;
    minRetention: number;
    /** Deprecated for immutable observations, but still hashed: the v0.15.x fingerprint shape must not change. */
    minReplacement: number;
    extractorModel?: string;
    validatorModel?: string;
}): string;
export declare function buildCompleteRevision(sourceRevision: string, policyFingerprint: string): string;
export declare class ExtractionStore {
    readonly db: import("node:sqlite").DatabaseSync;
    constructor(path: string);
    close(): void;
    liveSince(): number;
    claim(scheduled: boolean, intervalMs: number): string | undefined;
    renew(owner: string): void;
    release(owner: string): void;
    readCheckpoint(sessionId: string): (Checkpoint & {
        error: string | null;
    }) | undefined;
    /**
     * The stored cursor that `checkpoint()` would discard by rewinding (a broader backfill or a policy change), or
     * null when it would resume. The caller must verify this cursor against the source first: once discarded, a
     * rewritten or deleted session reads as a fresh page and its stale observations would stay active.
     */
    rewindCursor(session: ExtractionSession, since?: number, policyFingerprint?: string): string | null;
    checkpoint(session: ExtractionSession, owner: string, since?: number, policyFingerprint?: string): Checkpoint;
    records(sessionId?: string, paths?: readonly string[]): ExtractedRecord[];
    reset(sessionId: string, cursor: string | null, owner: string, policyFingerprint?: string): void;
    private assertCheckpointFenced;
    completeEmpty(params: {
        sessionId: string;
        expected: string | null;
        owner: string;
        completeRevision?: string;
        policyFingerprint?: string;
    }): void;
    commit(params: {
        session: ExtractionSession;
        expected: string | null;
        cursor: string;
        context: ExtractionMessage[];
        accepted: {
            proposal: MemoryProposal;
            observedAt: number;
            judgment: unknown;
        }[];
        owner: string;
        version: string;
        completeRevision?: string;
        policyFingerprint?: string;
    }): number;
    error(sessionId: string, code: string, owner: string): void;
    report(): {
        memories: ExtractedRecord[];
        sessions: Record<string, import("node:sqlite").SQLOutputValue>[];
    };
}
export {};
