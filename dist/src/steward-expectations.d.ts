import { DatabaseSync } from "node:sqlite";
import { Type, type Static } from "typebox";
import { type ChoiceAnswer, type ChoiceQuestion } from "@unblocklabs/decisions";
import type { ChatType, UnblockMemoryConfig } from "./config.js";
import { type DeterministicSyncResult, type ExpectationChatType, type ExpectationKind } from "./expectations-store.js";
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
 * 3. With a `runner`: sweeps open overdue / due-soon / aging expectations — and any open item whose own conversation
 *    audience has new activity in this pass — against evidence from THEIR OWN audience
 *    (workspace items: channel conversations only) recorded since the item opened or was last swept, judging
 *    `still_open | kept | broken | right | wrong | expired` with a surprise score.
 * 4. Extracted rows, resolutions (plus linked Captain's Log blocker writeback) and the watermark commit in one
 *    `commitWithDomain` transaction.
 *
 * Separately, `resolveExpectationsFromCaptainsLog` closes workspace/channel expectations right after a Captain's Log
 * append, with one batched d1.2 `choice` call over the freshly distilled entries.
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
    /**
     * Session chat types whose conversations count as evidence when sweeping `workspace`-audience expectations (default
     * `["channel"]`, the safe multi-user choice; a 1:1 assistant can add `"group"` / `"direct"`; `[]` = none). Sessions
     * must also be read at all, i.e. not listed in `excludeChatTypes`.
     */
    workspaceSweepChatTypes?: readonly ChatType[];
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
/** A just-appended Captain's Log entry (`id` is its `captains_log_entries` row). */
export type CaptainsLogResolveEntry = {
    id: string;
    topic: string;
    summary: string;
    blocked: boolean;
    channels: readonly string[];
    nativeChannels?: readonly string[];
    /** When the entry was captured; defaults to `nowMs`. Expectations opened after the newest capture are never judged. */
    capturedAtMs?: number;
};
declare const CAPTAINS_LOG_VERDICTS: {
    readonly still_open: {
        readonly definition: "The entries do not mention this expectation, leave it unverified, describe it only as discussed, planned, in progress or pending, or say it remains open or blocked.";
    };
    readonly resolved: {
        readonly definition: "The entries explicitly state that this obligation, blocker or action was completed, approved, fixed or satisfied (for a prediction or decision outcome: that it came true).";
    };
    readonly broken: {
        readonly definition: "The entries explicitly show that this commitment or prediction failed, was cancelled or rejected, or proved false.";
    };
};
type CaptainsLogVerdict = Extract<keyof typeof CAPTAINS_LOG_VERDICTS, string>;
type CaptainsLogQuestions = Record<string, ChoiceQuestion<CaptainsLogVerdict>>;
export type CaptainsLogDecisionState = {
    newCaptainsLogEntries: {
        topic: string;
        summary: string;
        blocked: boolean;
        channels: string[];
    }[];
    openExpectations: Record<string, {
        kind: ExpectationKind;
        channel?: string;
        summary: string;
        expectedState: string;
    }>;
};
/** Seam for the d1.2 call (defaults to `@unblocklabs/decisions` via `decideWithModel`). */
export type CaptainsLogDecide = (state: CaptainsLogDecisionState, questions: CaptainsLogQuestions, options: {
    timeoutMs: number;
    signal?: AbortSignal;
}) => Promise<{
    answers: Record<string, ChoiceAnswer<CaptainsLogVerdict> | undefined>;
}>;
export type ResolveFromCaptainsLogOptions = {
    /** The plugin memory database holding `expectations` and `captains_log_entries`. */
    db: DatabaseSync;
    agentId: string;
    newEntries: readonly CaptainsLogResolveEntry[];
    decisionModel: Pick<UnblockMemoryConfig["decisionModel"], "enabled" | "endpoint" | "model" | "apiKey" | "apiKeyFile">;
    /** Minimum probability of the chosen `resolved` / `broken` option before it is applied (default 0.85). */
    minConfidence?: number;
    /** d1.2 request deadline in ms (default 15000). `0` = no plugin-side limit; the decisions SDK still caps one request at 60 s. */
    timeoutMs?: number;
    /** Expectation chat types eligible for post-Captain's-Log d1.2 resolution (default `["workspace", "channel"]`). */
    chatTypes?: readonly ExpectationChatType[];
    /** Maximum open expectations judged per pass (default `0` = unlimited, batched in chunks of 24 per d1.2 call). */
    maxCandidates?: number;
    signal?: AbortSignal;
    nowMs?: number;
    decide?: CaptainsLogDecide;
};
export type ResolveFromCaptainsLogResult = {
    checked: number;
    resolved: number;
    skipped?: "disabled" | "no_credential";
};
/**
 * Right after a Captain's Log append: one batched d1.2 `choice` per open workspace / channel expectation over the new
 * entries, closing only explicit `resolved` / `broken` outcomes at `>= minConfidence`. DM and group expectations are
 * never sent (they stay in their own per-conversation Steward sweeps). A mirrored blocker whose topic was re-captured as
 * still `blocked`, or that the new entries themselves created, is never judged. No entries or no candidates → no call.
 */
export declare function resolveExpectationsFromCaptainsLog(options: ResolveFromCaptainsLogOptions): Promise<ResolveFromCaptainsLogResult>;
export {};
