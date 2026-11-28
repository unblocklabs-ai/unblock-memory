import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { WhispererDiagnostics } from "./diagnostics.js";
import { type SyntheticInputFilterConfig } from "./synthetic-input.js";
import { type MemoryCandidateManager } from "./memory-search.js";
import type { RecallLedgerWriter } from "./recall-ledger.js";
import type { WhispererPrompt } from "./whisperer-prompt.js";
import { type DeepThoughtAudienceIdentity } from "./deep-thought-store.js";
import { type BrightnessConfig } from "./memory-brightness.js";
/** Optional: whisper fresh, generation-verified `deep_thought` syntheses (`derived_observations`) matching the turn. */
type DerivedObservationWhisperOptions = {
    /** The agent's memory database holding `derived_observations` (opened read-only; missing = nothing to whisper). */
    dbPathForAgent: (agentId: string) => string;
    /** Current QMD collection generations covering exactly `corpora` (same contract as `deep_thought`). */
    getCollectionGenerations: (agentId: string, corpora: readonly string[]) => Promise<Record<string, number>> | Record<string, number>;
    /**
     * Must produce the exact key `deep_thought` saved under. Default: `deepThoughtAudienceKey` over the hook context
     * (agent + session key + provider + account, plus sender outside group/channel sessions). A blank result disables
     * the whisper for that turn.
     */
    audienceKey?: (ctx: DeepThoughtAudienceIdentity) => string | undefined;
    /** Syntheses whispered per turn (default 2; `0` = unlimited). */
    maxHints?: number;
    /** Minimum share of a stored question's meaningful tokens the turn must cover (default 0.45). */
    minTokenOverlap?: number;
    /** Minimum shared meaningful tokens for a non-exact match (default 2). */
    minSharedTokens?: number;
    /** Payload budget for the derived entries (default `memoryWhisperer.maxInjectedChars`; `0` = unlimited). Entries are never sliced. */
    maxPayloadChars?: number;
    /** Turns a whispered synthesis stays suppressed in a session (default `memoryWhisperer.cooldownTurns`). */
    cooldownTurns?: number;
};
/** Optional: whisper active, ACL-matched Memory Crystals (`memory_crystals`) whose title + summary match the turn. */
type CrystalWhisperOptions = {
    /** The agent's memory database holding `memory_crystals` (opened read-only; missing = nothing to whisper). */
    dbPathForAgent: (agentId: string) => string;
    /**
     * Caller audience in addition to the always-visible `workspace` audience. Default: `deepThoughtAudienceKey` over the
     * hook context (the same key derived observations use). A blank result limits the turn to `workspace` crystals.
     */
    audienceKey?: (ctx: DeepThoughtAudienceIdentity) => string | undefined;
    /** Crystals whispered per turn (default 2; `0` = unlimited). */
    maxHints?: number;
    minTokenOverlap?: number;
    minSharedTokens?: number;
    ltmRankBoost?: number;
    /** Payload budget for the crystal entries (default `memoryWhisperer.maxInjectedChars`; `0` = unlimited). */
    maxPayloadChars?: number;
    /** Count emitted crystals (STM→LTM promotion evidence). Default: a best-effort write to the existing database. */
    recordHits?: (agentId: string, ids: readonly string[]) => void;
};
/** Optional: re-order usefulness-qualified finalists by Brightness evidence (never on the `off` recipe). */
type BrightnessWhisperOptions = BrightnessConfig & {
    dbPathForAgent: (agentId: string) => string;
    baselineMinInteractions?: number;
};
export type MemoryWhispererOptions = {
    syntheticInput?: SyntheticInputFilterConfig;
    derivedObservations?: DerivedObservationWhisperOptions;
    crystals?: CrystalWhisperOptions;
    brightness?: BrightnessWhisperOptions;
    /** Active retrieval recipe fingerprint; forwarded on recall-ledger query records and the completed log line. */
    recipeHash?: string;
};
type MemoryWhispererRuntime = {
    getMemorySearchManager(params: {
        cfg: OpenClawConfig;
        agentId: string;
    }): Promise<{
        manager: MemoryCandidateManager | null;
    }>;
};
type RecallLedgerSink = {
    writer: RecallLedgerWriter;
    dbPathForAgent: (agentId: string) => string;
};
export declare function registerMemoryWhisperer(api: OpenClawPluginApi, runtime: MemoryWhispererRuntime, config: UnblockMemoryConfig["memoryWhisperer"], decisionModel: UnblockMemoryConfig["decisionModel"], diagnostics?: WhispererDiagnostics, recallLedger?: RecallLedgerSink, options?: MemoryWhispererOptions): WhispererPrompt | undefined;
export {};
