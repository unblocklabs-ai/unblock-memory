import { DatabaseSync } from "node:sqlite";
import { Type, type Static } from "typebox";
import type { ChatType } from "./config.js";
import type { StewardRunner, StewardUsage } from "./steward-runner.js";
import { type WorkStore } from "./work-store.js";
export declare const CAPTAINS_LOG_KIND = "captains_log";
export declare const CAPTAINS_LOG_SCHEMA: Type.TObject<{
    shouldAppend: Type.TBoolean;
    entries: Type.TArray<Type.TObject<{
        topic: Type.TString;
        summary: Type.TString;
        blocked: Type.TOptional<Type.TBoolean>;
        sessionRefs: Type.TOptional<Type.TArray<Type.TString>>;
    }>>;
    skipReason: Type.TOptional<Type.TString>;
}>;
declare const CAPTURED_ENTRY: Type.TObject<{
    topic: Type.TString;
    summary: Type.TString;
    blocked: Type.TBoolean;
    channels: Type.TArray<Type.TString>;
    sessionRefs: Type.TArray<Type.TString>;
}>;
type CapturedEntry = Static<typeof CAPTURED_ENTRY>;
declare const ARTIFACT: Type.TObject<{
    pendingAppend: Type.TOptional<Type.TObject<{
        day: Type.TString;
        hash: Type.TString;
        sectionChars: Type.TInteger;
        priorMatches: Type.TInteger;
        capturedAtMs: Type.TInteger;
        sessionMaxSeq: Type.TRecord<"^.*$", Type.TInteger>;
        entries: Type.TOptional<Type.TArray<Type.TObject<{
            topic: Type.TString;
            summary: Type.TString;
            blocked: Type.TBoolean;
            channels: Type.TArray<Type.TString>;
            sessionRefs: Type.TArray<Type.TString>;
        }>>>;
    }>>;
    schemaVersion: Type.TLiteral<1>;
    lastCapturedAtMs: Type.TInteger;
    sessionMaxSeq: Type.TRecord<"^.*$", Type.TInteger>;
    lastEntryHash: Type.TOptional<Type.TString>;
}>;
export type CaptainsLogWatermark = Omit<Static<typeof ARTIFACT>, "pendingAppend">;
type CaptainsLogEntry = CapturedEntry & {
    id: string;
    agentId: string;
    day: string;
    capturedAtMs: number;
    sectionHash: string;
    ordinal: number;
    resolvedAtMs: number | null;
    resolutionNote: string | null;
};
/** Newest captures first, with entries from each section in rendered order. Zero or omitted limit is unlimited. */
export declare function listCaptainsLogEntries(db: DatabaseSync, options: {
    agentId: string;
    day?: string;
    sinceMs?: number;
    blockedOnly?: boolean;
    openOnly?: boolean;
    limit?: number;
}): CaptainsLogEntry[];
export declare function listOpenBlockers(db: DatabaseSync, agentId: string, limit?: number): CaptainsLogEntry[];
/** Resolve an open blocker once, without modifying its original capture or reopening it on replay. */
export declare function resolveCaptainsLogBlocker(db: DatabaseSync, options: {
    id: string;
    agentId: string;
    resolvedAtMs?: number;
    note?: string;
}): boolean;
export type CaptainsLogPassOptions = {
    agentId: string;
    /** The live OpenClaw agent database, not the plugin work database. */
    databasePath: string;
    workspaceDir: string;
    workStore: WorkStore;
    runner: Pick<StewardRunner, "complete">;
    owner: string;
    timezone?: string;
    intervalMinutes?: number;
    lookbackMinutes?: number;
    maxSessionsPerRun?: number;
    /** Text character budget per session; zero is unlimited. */
    maxCharsPerSession?: number;
    /** Character budget for the tail of the daily log sent to Steward; zero is unlimited. */
    maxExistingLogChars?: number;
    timeoutMs?: number;
    excludeChatTypes?: readonly ChatType[];
    /** Preview without acquiring a lease, creating a file, or moving the schedule or watermark. */
    dryRun?: boolean;
    signal?: AbortSignal;
    leaseMs?: number;
    heartbeatMs?: number;
    now?: () => number;
};
type PassOutcome = {
    status: "empty" | "not_due" | "already_running" | "aborted";
} | {
    status: "no_append";
    skipReason?: string;
} | {
    status: "appended" | "preview";
    filePath: string;
    markdown: string;
} | {
    status: "failed";
    reason: string;
};
export type CaptainsLogPassResult = {
    sessions: number;
    nextDueAt?: number;
    usage?: StewardUsage;
} & PassOutcome;
/** Scheduled pass (or read-only preview). Only a live WorkStore attempt may append or move the watermark. */
export declare function runCaptainsLogPass(options: CaptainsLogPassOptions): Promise<CaptainsLogPassResult>;
export {};
