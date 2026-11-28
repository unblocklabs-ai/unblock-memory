export declare const SYNTHETIC_INPUT_FAMILIES: readonly ["completion_wake", "internal_context", "heartbeat_control", "intersession_subagent", "cron_wrapper", "exec_system_handoff", "reset_compaction", "human_framing"];
export type SyntheticInputFamily = typeof SYNTHETIC_INPUT_FAMILIES[number];
export type SyntheticInputFilterConfig = {
    enabled?: boolean;
    skipFamilies?: SyntheticInputFamily[];
    extraExactAliases?: string[];
    extraPrefixes?: string[];
};
/** `role` (when known) limits prompt-wrapper rules to user turns; string input is treated as a user turn. */
type Input = {
    text: string;
    inputProvenance?: unknown;
    display?: unknown;
    role?: unknown;
};
type Classification = {
    synthetic: false;
    action: "allow";
    text: string;
    family?: never;
    reason?: never;
} | {
    synthetic: true;
    action: "skip" | "strip";
    text: string;
    family: SyntheticInputFamily;
    reason: string;
};
export declare function syntheticFamilyEnabled(family: SyntheticInputFamily, config?: SyntheticInputFilterConfig): boolean;
/** Classify host input, not general prose about OpenClaw or its controls. */
export declare function classifySyntheticInput(input: string | Input, config?: SyntheticInputFilterConfig): Classification;
/**
 * The human-authored text a consumer may treat as evidence, or `undefined` for synthetic input. Stripped framing never
 * reaches the caller: mixed human + runtime-context turns yield only the human part.
 */
export declare function humanEvidenceText(input: string | Input, config?: SyntheticInputFilterConfig): string | undefined;
/** Human-evidence consumers don't mine unattended tasks, even if those tasks have a usable retrieval payload. */
export declare function isSyntheticEvidence(input: Classification): boolean;
/** Legacy ledger rows have no provenance. Only recognize exact tokens or actual envelopes. */
export declare function isSyntheticRecallQuery(text: string, config?: SyntheticInputFilterConfig): boolean;
export {};
