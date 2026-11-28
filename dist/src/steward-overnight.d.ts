import { DatabaseSync } from "node:sqlite";
import { Type, type Static } from "typebox";
import type { StewardRunner, StewardUsage } from "./steward-runner.js";
import type { WorkStore } from "./work-store.js";
import { type SyntheticInputFilterConfig } from "./synthetic-input.js";
/**
 * Overnight Thinking Steward: a fenced `WorkStore` run (`kind='overnight_thinking'`, `scope=agentId`) that uses
 * agent time while humans sleep.
 *
 * A. **Voltaire Drift**: re-investigate questions whose underlying knowledge moved (a `derived_observations` row whose
 *    QMD collection generations advanced) or that keep recurring in `recall_queries`. The OLD conclusion is diffed
 *    against the NEW conclusion (never hit lists). When truth moved, an immutable `voltaire_shifts` row is recorded,
 *    plus an optional retroactive `core_memories` anchor and an append-only daily-log note (❔ was / ✅ now).
 * B. **Shortfall Post-Mortems**: every `hurt` turn in the Outcome Ledger (`memory_outcomes`) is diagnosed once
 *    (`missed_memory | stale_memory | wrong_skill | noisy_whisper | other` + a concrete fix) into `shortfall_postmortems`.
 * C. **Anticipatory Pre-Answering**: recurring weekday/hour query rhythms (plus optional `upcomingTopics`) are
 *    investigated ahead of time so a verified answer already waits in `derived_observations` for an instant whisper.
 *
 * Every candidate keeps its OWN `audience_key` and corpora end to end: nothing is pooled across audiences. Only shifts
 * whose audience kind is in `dailyLogChatTypes` (default `workspace` + `channel`; add `group` / `direct` to opt in; an
 * audience never seen in recall is never eligible) AND whose corpora are ALL in `dailyLogCorpora` (default `memory` +
 * `knowledge`; add `sessions` / `extracted` to opt in) reach the workspace daily log or an audience-less `core_memories`
 * table. Both lists are the only source of truth: nothing else is hardcoded. Only a complete answer with at least one citation and ZERO unverified
 * citations dropped is saved, diffed or published. All domain writes — including the new `derived_observations` row
 * that supersedes the prior one — land in ONE `commitWithDomain` transaction: a worker that lost its fence publishes
 * nothing and supersedes nothing.
 */
export declare const OVERNIGHT_KIND = "overnight_thinking";
/** Idempotent; safe both standalone and inside an open transaction (it never nests `BEGIN`). */
export declare function ensureOvernightThinkingSchema(db: DatabaseSync): void;
export type OvernightConfidence = "high" | "medium" | "low";
export type VoltaireShiftType = "updated" | "contradicted" | "resolved";
export type ShortfallRootCause = "missed_memory" | "stale_memory" | "wrong_skill" | "noisy_whisper" | "other";
/** `{corpus, path, quote}` per the overnight contract; `deep_thought`'s own `{source, lines?, date?, quote}` is accepted too. */
export type OvernightCitation = {
    corpus?: string;
    path?: string;
    source?: string;
    lines?: string;
    date?: string;
    quote: string;
};
export type OvernightInvestigateParams = {
    question: string;
    corpora: readonly string[];
    audienceKey: string;
    signal?: AbortSignal;
};
export type OvernightInvestigateResult = {
    status: "complete" | string;
    answer?: string;
    confidence?: string;
    citations: OvernightCitation[];
    openQuestions?: string[];
    collectionGenerations?: Record<string, number>;
    /** Citations the investigation could not ground in visited evidence; any drop disqualifies the answer. */
    unverifiedCitationsDropped?: number;
    /** Set when the investigation already persisted its verified synthesis (legacy adapters; prefer `skipSave`). */
    derivedObservationId?: string;
};
export type OvernightInvestigate = (params: OvernightInvestigateParams) => Promise<OvernightInvestigateResult>;
export type OvernightUpcomingTopic = {
    topic: string;
    corpora?: string[];
    audienceKey?: string;
};
export type OvernightUpcomingTopics = (params: {
    agentId: string;
    nowMs: number;
    lookaheadMinutes: number;
    signal?: AbortSignal;
}) => Promise<OvernightUpcomingTopic[]>;
export type VoltaireShift = {
    id: string;
    agentId: string;
    question: string;
    questionHash: string;
    audienceKey: string;
    priorObservationId: string | null;
    newObservationId: string | null;
    shiftType: VoltaireShiftType;
    confidence: OvernightConfidence;
    priorTruth: string;
    newTruth: string;
    summary: string;
    citations: OvernightCitation[];
    detectedAtMs: number;
};
export type ShortfallPostmortem = {
    id: string;
    agentId: string;
    outcomeId: string;
    evidenceTurnId: string;
    subjectKind: string;
    subjectId: string;
    rootCause: ShortfallRootCause;
    diagnosis: string;
    recommendedFix: string;
    confidence: OvernightConfidence;
    analyzedAtMs: number;
};
/** Handed to an optional `appendDailyLogNote` hook (shared audiences only) after the shift committed. */
export type VoltaireDailyLogNote = {
    agentId: string;
    dateKey: string;
    markdown: string;
    shift: VoltaireShift;
    priorDateIso: string;
};
/** Handed to an optional `recordCoreMemoryAnchor` override; runs inside the fenced commit transaction. */
export type VoltaireCoreMemoryAnchor = {
    shift: VoltaireShift;
    citation: OvernightCitation;
    shared: boolean;
    detectedAtMs: number;
};
export type OvernightThinkingPassOptions = {
    agentId: string;
    owner: string;
    /** WorkStore on the agent's plugin memory database (holds `recall_queries`, `memory_outcomes`, `derived_observations`). */
    workStore: WorkStore;
    runner: Pick<StewardRunner, "complete">;
    /** Fresh, citation-verified investigation (normally `deep_thought` with its cache bypassed). Phases A and C need it. */
    investigate?: OvernightInvestigate;
    /** Current QMD collection generations for exactly these corpora. Without it, unchanged knowledge cannot be proven. */
    getCollectionGenerations?: (corpora: readonly string[]) => Promise<Record<string, number>> | Record<string, number>;
    /** Calendar / meeting titles coming up inside `lookaheadMinutes` (Phase C). */
    upcomingTopics?: OvernightUpcomingTopics;
    voltaireEnabled?: boolean;
    postmortemsEnabled?: boolean;
    preAnswerEnabled?: boolean;
    /** Default 720 (12h). */
    intervalMinutes?: number;
    /** Recall history window (default 30; `0` = all history). Also bounds which `hurt` outcomes are diagnosed. */
    lookbackDays?: number;
    /** Minimum repeats for a recurring question / distinct days for a rhythm (default 2). */
    minRecurrence?: number;
    /** Pre-answer window (default 720 = 12h; `0` = every weekday/hour slot). */
    lookaheadMinutes?: number;
    /** Per-run caps; `0` = unlimited. */
    maxVoltairePerRun?: number;
    maxPostmortemsPerRun?: number;
    maxPreAnswersPerRun?: number;
    /** Per model call and per investigation; `0` (default) = unlimited. */
    timeoutMs?: number;
    /** Lowest diff confidence that records a shift (default `medium`, i.e. `low` is skipped). */
    minConfidence?: OvernightConfidence;
    /** Both set → run only inside `[start, end)` local hours (wraps midnight, e.g. 22 → 6). Both unset → normal schedule. */
    quietHoursStartHour?: number;
    quietHoursEndHour?: number;
    timezone?: string;
    /** `recall_queries.chat_type` values mined for recurring questions (default `["channel","group"]`). */
    recallChatTypes?: readonly string[];
    /** Corpora / audience for `upcomingTopics` items that name none. Items with neither are skipped, never pooled. */
    defaultCorpora?: readonly string[];
    defaultAudienceKey?: string;
    /** Persist complete investigations that came back without a `derivedObservationId` (default true). */
    saveDerivedObservations?: boolean;
    /** Override the default adaptive `core_memories` insert. Return true when an anchor was written. */
    recordCoreMemoryAnchor?: (db: DatabaseSync, anchor: VoltaireCoreMemoryAnchor) => boolean;
    /**
     * Audience kinds whose shifts may reach the workspace daily log or an audience-less `core_memories` anchor
     * (default `["workspace","channel"]`; add `"group"` / `"direct"` to opt in). An audience's kind comes from the
     * `recall_queries` chat types it was seen in (every one must be listed); the `workspace` audience key is `workspace`.
     */
    dailyLogChatTypes?: readonly OvernightDailyLogChatType[];
    /**
     * Corpora whose shifts may reach the workspace daily log or an audience-less `core_memories` anchor; EVERY corpus of
     * the shift must be listed (default `["memory","knowledge"]`; add `"sessions"` / `"extracted"` to opt in).
     */
    dailyLogCorpora?: readonly string[];
    /** Append-only workspace daily-log directory (`<dir>/YYYY-MM-DD.md`); `dailyLogChatTypes` + `dailyLogCorpora` only. */
    dailyLogDir?: string;
    appendDailyLogNote?: (note: VoltaireDailyLogNote) => void | Promise<void>;
    /** Operator run (`memory-steward overnight`): start before the schedule (never steals a live lease). */
    ignoreDueAt?: boolean;
    /** Also bypass the quiet-hours gate (operator runs). */
    ignoreQuietHours?: boolean;
    signal?: AbortSignal;
    leaseMs?: number;
    heartbeatMs?: number;
    syntheticInput?: SyntheticInputFilterConfig;
    now?: () => number;
};
type PassStatus = "not_due" | "already_running" | "aborted" | "outside_quiet_hours" | "disabled" | "empty" | "completed" | "failed";
export type OvernightThinkingPassResult = {
    status: PassStatus;
    reason?: string;
    voltaire: {
        candidates: number;
        skippedUnchanged: number;
        investigated: number;
        compared: number;
        shifts: number;
        anchors: number;
        dailyLogNotes: number;
        lowConfidence: number;
    };
    postmortems: {
        candidates: number;
        analyzed: number;
    };
    preAnswers: {
        candidates: number;
        skippedFresh: number;
        investigated: number;
        answered: number;
    };
    savedObservations: number;
    /** Per-item failures (model/provider codes, investigation errors) that did not stop the pass. */
    errors: string[];
    nextDueAt?: number;
    usage?: StewardUsage;
};
export declare const VOLTAIRE_DIFF_SCHEMA: Type.TObject<{
    shifted: Type.TBoolean;
    shiftType: Type.TUnion<[Type.TLiteral<"updated">, Type.TLiteral<"contradicted">, Type.TLiteral<"resolved">, Type.TLiteral<"none">]>;
    confidence: Type.TUnion<[Type.TLiteral<"high">, Type.TLiteral<"medium">, Type.TLiteral<"low">]>;
    priorTruth: Type.TString;
    newTruth: Type.TString;
    summary: Type.TString;
}>;
export type VoltaireDiff = Static<typeof VOLTAIRE_DIFF_SCHEMA>;
export declare const POSTMORTEM_SCHEMA: Type.TObject<{
    rootCause: Type.TUnion<[Type.TLiteral<"missed_memory">, Type.TLiteral<"stale_memory">, Type.TLiteral<"wrong_skill">, Type.TLiteral<"noisy_whisper">, Type.TLiteral<"other">]>;
    diagnosis: Type.TString;
    recommendedFix: Type.TString;
    confidence: Type.TUnion<[Type.TLiteral<"high">, Type.TLiteral<"medium">, Type.TLiteral<"low">]>;
}>;
export type ShortfallDiagnosis = Static<typeof POSTMORTEM_SCHEMA>;
export type OvernightDailyLogChatType = "workspace" | "channel" | "group" | "direct";
/** Safe defaults: shared audiences over curated corpora. Everything else is an explicit opt-in. */
export declare const OVERNIGHT_DAILY_LOG_DEFAULTS: {
    chatTypes: readonly OvernightDailyLogChatType[];
    corpora: readonly string[];
};
/** Local calendar date, weekday (0 = Sunday) and hour (0..23) of `ms` in `timezone`. */
export declare function overnightLocalParts(ms: number, timezone: string): {
    dateKey: string;
    weekday: number;
    hour: number;
};
/** `true` when no quiet window is configured, or `hour` falls in `[start, end)` (wrapping midnight; `start === end` = all day). */
export declare function withinQuietHours(hour: number, start: number | undefined, end: number | undefined): boolean;
type ReadSource = string | DatabaseSync;
/** Newest first. `limit` `0` (default) = unlimited. `[]` for a missing database or table. */
export declare function listVoltaireShifts(source: ReadSource, options?: {
    agentId?: string;
    audienceKey?: string;
    sinceMs?: number;
    limit?: number;
}): VoltaireShift[];
/** Newest first. `limit` `0` (default) = unlimited. `[]` for a missing database or table. */
export declare function listShortfallPostmortems(source: ReadSource, options?: {
    agentId?: string;
    rootCause?: ShortfallRootCause;
    subjectKind?: string;
    sinceMs?: number;
    limit?: number;
}): ShortfallPostmortem[];
export type OvernightThinkingSummary = {
    shifts: number;
    shiftsByType: Partial<Record<VoltaireShiftType, number>>;
    latestShiftAtMs?: number;
    postmortems: number;
    postmortemsByRootCause: Partial<Record<ShortfallRootCause, number>>;
    latestPostmortemAtMs?: number;
    /** `hurt` outcomes not yet diagnosed (absent when the Outcome Ledger table does not exist). */
    pendingHurtOutcomes?: number;
};
/** Read-only roll-up for `memory-steward overnight`. Zeroes for a missing database. */
export declare function summarizeOvernightThinking(source: ReadSource, options?: {
    agentId?: string;
    sinceMs?: number;
}): OvernightThinkingSummary;
/** Append-only daily-log markdown: the prior conclusion stays visible (❔), the new one is marked current (✅). */
export declare function formatVoltaireDailyLogNote(shift: VoltaireShift, priorDateIso: string): string;
/** Scheduled Overnight Thinking pass. Only a live WorkStore attempt may publish shifts, post-mortems or observations. */
export declare function runOvernightThinkingPass(options: OvernightThinkingPassOptions): Promise<OvernightThinkingPassResult>;
export {};
