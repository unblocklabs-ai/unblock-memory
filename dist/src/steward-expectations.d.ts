import { Type, type Static } from "typebox";
import type { ChatType } from "./config.js";
import { type DeterministicSyncResult } from "./expectations-store.js";
import type { StewardRunner, StewardUsage } from "./steward-runner.js";
import { type WorkStore } from "./work-store.js";
/**
 * Steward Expectations pass: a fenced `WorkStore` run (`kind='expectations'`, `scope=agentId`).
 *
 * 1. Always mirrors Captain's Log blockers and people todos into `expectations` (zero model cost), committed under the
 *    fence before any model call so a provider outage never delays them.
 * 2. With a `runner` + `databasePath`: extracts explicit commitments, predictions, blockers and decision-outcome
 *    hypotheses from unseen eligible sessions, one model call per audience — each channel/group conversation
 *    (`channel|group:<provider>:<accountId>:<nativeChannelId>`) and each DM (`direct:<provider>:<accountId>:<senderId>`)
 *    is its own audience; nothing is pooled into `workspace`. Only items grounded in opaque `s1..sN` refs are kept.
 * 3. With a `runner`: sweeps open overdue / due-soon / aging expectations against evidence from THEIR OWN audience
 *    (workspace items: channel conversations only) recorded since the item opened or was last swept, judging
 *    `still_open | kept | broken | right | wrong | expired` with a surprise score.
 * 4. Extracted rows, resolutions (plus linked Captain's Log blocker writeback) and the watermark commit in one
 *    `commitWithDomain` transaction.
 */
export declare const EXPECTATIONS_KIND = "expectations";
declare const EXPECTATION_EXTRACTION_SCHEMA: Type.TObject<{
    expectations: Type.TArray<Type.TObject<{
        kind: Type.TUnion<[Type.TLiteral<"commitment">, Type.TLiteral<"prediction">, Type.TLiteral<"blocker">, Type.TLiteral<"decision_outcome">]>;
        summary: Type.TString;
        expectedState: Type.TString;
        dueAt: Type.TOptional<Type.TString>;
        subjectLabel: Type.TOptional<Type.TString>;
        keywords: Type.TOptional<Type.TArray<Type.TString>>;
        sessionRefs: Type.TArray<Type.TString>;
    }>>;
    skipReason: Type.TOptional<Type.TString>;
}>;
export type ExpectationExtraction = Static<typeof EXPECTATION_EXTRACTION_SCHEMA>;
declare const EXPECTATION_SWEEP_SCHEMA: Type.TObject<{
    judgments: Type.TArray<Type.TObject<{
        ref: Type.TString;
        verdict: Type.TUnion<[Type.TLiteral<"still_open">, Type.TLiteral<"kept">, Type.TLiteral<"broken">, Type.TLiteral<"right">, Type.TLiteral<"wrong">, Type.TLiteral<"expired">]>;
        surpriseScore: Type.TNumber;
        resolutionNote: Type.TString;
        sessionRefs: Type.TArray<Type.TString>;
    }>>;
}>;
export type ExpectationSweep = Static<typeof EXPECTATION_SWEEP_SCHEMA>;
export type ExpectationsPassOptions = {
    agentId: string;
    /** WorkStore on the plugin memory database (`unblock-memory.sqlite`) that also holds Captain's Log and people tables. */
    workStore: WorkStore;
    owner: string;
    /** Optional: without it the pass is deterministic-only (no model cost). */
    runner?: Pick<StewardRunner, "complete">;
    /** The live OpenClaw agent database (`openclaw-agent.sqlite`). Required for session extraction and sweeps. */
    databasePath?: string;
    timezone?: string;
    intervalMinutes?: number;
    lookbackMinutes?: number;
    /** Sweep open expectations due within this many minutes (overdue ones always qualify). */
    dueLeadMinutes?: number;
    /** Sweep open expectations older than this, due date or not. */
    sweepAfterMinutes?: number;
    /** Extraction sessions read per pass (`0` = unlimited). A capped pass resumes the unread rest next time. */
    maxSessionsPerRun?: number;
    /** Auto-expire mirrored Captain's Log blockers not re-captured within this many minutes (default 4320; `0` = never). */
    blockerAutoExpireMinutes?: number;
    /** Text character budget per session; `0` = unlimited. */
    maxCharsPerSession?: number;
    /** Open expectations judged per pass; `0` = unlimited. */
    maxSweepItems?: number;
    /** Per model call; `0` = unlimited. */
    timeoutMs?: number;
    /** Defaults to `["direct"]`. Opting DMs in keeps each DM in its own strict `direct:<provider>:<accountId>:<senderId>` audience. */
    excludeChatTypes?: readonly ChatType[];
    /** Disable either model stage (both default on when a runner is present). */
    extract?: boolean;
    sweep?: boolean;
    signal?: AbortSignal;
    leaseMs?: number;
    heartbeatMs?: number;
    now?: () => number;
};
type PassOutcome = {
    status: "not_due" | "already_running" | "aborted";
} | {
    status: "deterministic_only" | "empty" | "completed";
} | {
    status: "failed";
    reason: string;
};
export type ExpectationsPassResult = PassOutcome & {
    sessions: number;
    deterministic?: DeterministicSyncResult;
    extracted: number;
    swept: number;
    resolved: number;
    nextDueAt?: number;
    usage?: StewardUsage;
};
/** Scheduled Expectations pass. Only a live WorkStore attempt may write expectations or move the watermark. */
export declare function runExpectationsPass(options: ExpectationsPassOptions): Promise<ExpectationsPassResult>;
export {};
