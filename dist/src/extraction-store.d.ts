import type { ExtractionMessage, MemoryProposal } from "./extraction-model.js";
import type { SessionMetadata } from "./session-projector.js";
export type ExtractionSession = SessionMetadata & {
    sessionKey: string;
    changedAt?: number;
};
type Checkpoint = {
    cursor: string | null;
    context: ExtractionMessage[];
    since: number;
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
export declare class ExtractionStore {
    readonly db: import("node:sqlite").DatabaseSync;
    constructor(path: string);
    close(): void;
    liveSince(): number;
    claim(scheduled: boolean, intervalMs: number): string | undefined;
    renew(owner: string): void;
    release(owner: string): void;
    checkpoint(session: ExtractionSession, since?: number): Checkpoint;
    records(sessionId?: string, paths?: readonly string[]): ExtractedRecord[];
    reset(sessionId: string, cursor: string | null, owner: string): void;
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
    }): number;
    error(sessionId: string, code: string): void;
    report(): {
        memories: ExtractedRecord[];
        sessions: Record<string, import("node:sqlite").SQLOutputValue>[];
    };
}
export {};
