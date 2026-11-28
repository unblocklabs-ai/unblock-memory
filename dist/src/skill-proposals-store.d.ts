import { DatabaseSync } from "node:sqlite";
export declare const SKILL_PROPOSAL_KINDS: readonly ["description_update", "pitfall_patch", "new_skill"];
export declare const SKILL_PROPOSAL_STATUSES: readonly ["pending", "approved", "rejected", "applied", "superseded"];
export type SkillProposalKind = typeof SKILL_PROPOSAL_KINDS[number];
type SkillProposalStatus = typeof SKILL_PROPOSAL_STATUSES[number];
/** The filename every proposal targets: an apply can never write any other file. */
export declare const SKILL_FILE_NAME = "SKILL.md";
export type SkillReplayMetrics = {
    baselineRecall: number;
    candidateRecall: number;
    recallGainPp: number;
    baselineFalseActivation: number;
    candidateFalseActivation: number;
    falseActivationDeltaPp: number;
    criticalRegressions: number;
    samplesEvaluated: number;
    positives?: number;
    negatives?: number;
    /** Examples dropped because a baseline or candidate judgment failed (scorer error / outage). */
    examplesFailed?: number;
};
export type SkillProposal = {
    id: string;
    agentId: string;
    kind: SkillProposalKind;
    skillName: string;
    /** Absolute live path for `description_update`/`pitfall_patch`; `<name>/SKILL.md` relative to the new-skills dir for `new_skill`. */
    skillPath: string;
    status: SkillProposalStatus;
    title: string;
    rationale: string;
    baseDescription: string | null;
    proposedDescription: string | null;
    proposedContent: string;
    diffSummary: string;
    baseSha256: string | null;
    replayMetrics: SkillReplayMetrics | null;
    evidence: Record<string, unknown>;
    proposalHash: string;
    recipeHash: string;
    createdAtMs: number;
    updatedAtMs: number;
    reviewedAtMs: number | null;
    reviewedBy: string | null;
    reviewNote: string | null;
    appliedAtMs: number | null;
    appliedPath: string | null;
};
export type SkillProposalInput = {
    agentId: string;
    kind: SkillProposalKind;
    skillName: string;
    skillPath: string;
    title: string;
    rationale: string;
    baseDescription?: string | null;
    proposedDescription?: string | null;
    /** The complete file the apply step writes. */
    proposedContent: string;
    diffSummary?: string;
    /** Required for `description_update`/`pitfall_patch`: SHA-256 of the live file the proposal was derived from. */
    baseSha256?: string | null;
    replayMetrics?: SkillReplayMetrics | null;
    evidence?: Record<string, unknown>;
    /** Defaults to a hash of `(kind, skillName, proposedDescription, proposedContent)`. */
    proposalHash?: string;
    recipeHash?: string;
    nowMs?: number;
};
export type SkillProposalUpsertResult = {
    /**
     * `inserted`: new pending row. `unchanged`: an identical proposal is already pending/approved. `previously_reviewed`:
     * an operator already rejected (or applied) this exact proposal, so it is not re-raised. `kept_existing`: a strictly
     * better pending proposal for the same live file is already queued.
     */
    action: "inserted" | "unchanged" | "previously_reviewed" | "kept_existing";
    proposal: SkillProposal;
    /** Ids of older pending proposals this one superseded. */
    superseded: string[];
};
export type SkillProposalFilter = {
    agentId: string;
    status?: SkillProposalStatus | readonly SkillProposalStatus[];
    kind?: SkillProposalKind | readonly SkillProposalKind[];
    skillName?: string;
    /** `0`/omitted = unlimited. */
    limit?: number;
};
export type SkillProposalsSummary = {
    total: number;
    byStatus: Record<SkillProposalStatus, number>;
    byKind: Record<SkillProposalKind, number>;
    /** Oldest still-pending proposal, or `null` when none waits for review. */
    oldestPendingAtMs: number | null;
};
export type SkillProposalErrorCode = "not_found" | "invalid_state" | "invalid_input" | "path_outside_root" | "conflict" | "target_exists";
export declare class SkillProposalError extends Error {
    readonly code: SkillProposalErrorCode;
    constructor(code: SkillProposalErrorCode, message: string);
}
export declare const sha256: (text: string | Buffer) => string;
/** Create the table and register `memory_schema('skill_proposals', 1)`. Idempotent; refuses unknown future versions. */
export declare function ensureSkillProposalsSchema(db: DatabaseSync): void;
/**
 * Insert a `pending` proposal, deduplicated by `(agent_id, kind, skill_name, proposal_hash)` (open twins must also share
 * `skill_path` and `base_sha256`). A new proposal supersedes
 * older `pending` ones for the same `(agent_id, kind, skill_name)`, unless one of them targets the same live file revision
 * with strictly better replay metrics (then that one is kept). `approved` rows are never superseded here: an operator
 * decision outranks a background pass.
 */
export declare function upsertSkillProposal(db: DatabaseSync, input: SkillProposalInput): SkillProposalUpsertResult;
/** Operator review: `pending -> approved | rejected`. Any other state throws `invalid_state`. */
export declare function reviewSkillProposal(db: DatabaseSync, input: {
    id: string;
    agentId: string;
    decision: "approved" | "rejected";
    reviewedBy?: string;
    note?: string;
    nowMs?: number;
}): SkillProposal;
/** `approved -> applied`, recording where the file landed. Supersedes other open proposals for that file (their base is gone). */
export declare function markSkillProposalApplied(db: DatabaseSync, input: {
    id: string;
    agentId: string;
    appliedPath: string;
    nowMs?: number;
}): SkillProposal;
export type ApplySkillProposalResult = {
    status: "applied" | "preview";
    proposal: SkillProposal;
    targetPath: string;
    /** Line diff between the live file (empty for `new_skill`) and the proposed content. */
    diff: string;
    bytesWritten: number;
};
/** One configured skills source: a root directory plus the corpus glob (relative to it) a `SKILL.md` must match. */
export type SkillSource = {
    root: string;
    pattern: string;
};
/**
 * The skills-corpus admission check shared by `skill-apply` and the Skills pass: `path` is a `SKILL.md` matching one
 * configured source's glob, both lexically (against the configured or canonical root) and after resolving every symlink.
 */
export declare function isAdmittedSkillPath(path: string, sources: readonly SkillSource[]): boolean;
/**
 * Atomic no-clobber create: the complete file appears at `target` via `link(2)`, which fails with `EEXIST` instead of
 * replacing anything, so two concurrent creates can never overwrite each other (or an operator's hand-written file).
 */
export declare function createFileExclusively(target: string, content: string, mode?: number): void;
/**
 * Apply one operator-approved proposal: confine the target to the configured skills sources, verify the live file still
 * matches `base_sha256` (or, for `new_skill`, does not exist yet), write it (temp + rename, or an atomic no-clobber create
 * for `new_skill`), and mark it `applied`. Crash-safe: when the live file already holds exactly the proposed bytes (an
 * earlier apply wrote it but died before recording that), the row is marked `applied` without writing.
 * `dryRun` returns the preview diff without writing or changing state.
 */
export declare function applyApprovedProposal(db: DatabaseSync, input: {
    id: string;
    agentId: string;
    allowedSources: readonly SkillSource[];
    targetDirForNewSkills?: string;
    dryRun?: boolean;
    nowMs?: number;
}): ApplySkillProposalResult;
/** Newest first. Missing table → `[]`; never creates anything. */
export declare function listSkillProposals(db: DatabaseSync, filter: SkillProposalFilter): SkillProposal[];
export declare function getSkillProposal(db: DatabaseSync, id: string, agentId: string): SkillProposal | undefined;
export declare function summarizeSkillProposals(db: DatabaseSync, agentId: string): SkillProposalsSummary;
/** Open `path` read-only (never creating it), run `fn`, close. A missing file yields `fallback`. */
export declare function withReadOnlySkillProposals<T>(path: string, fallback: T, fn: (db: DatabaseSync) => T): T;
/** The frontmatter `description` (plain, quoted or block scalar), or `undefined` when absent. */
export declare function readSkillDescription(content: string): string | undefined;
/**
 * Replace (or add) the frontmatter `description`, leaving every other byte intact: a UTF-8 BOM and the file's line endings
 * are preserved, and a multi-line value (including a `|` / `>` block scalar with blank lines) is replaced whole. The value
 * is written as a JSON string, which is a valid YAML double-quoted scalar. A file without frontmatter gains one. Throws
 * `invalid_input` unless the result reads back as exactly the (whitespace-normalized) proposed description.
 */
export declare function replaceSkillDescription(content: string, description: string, name?: string): string;
/**
 * Append bullets under the file's `## Pitfalls` section (created at the end when missing). Existing text is untouched,
 * the file's line endings are kept, and headings or section ends inside fenced code blocks (``` / ~~~) are ignored, so a
 * bullet never lands inside code.
 */
export declare function appendSkillPitfalls(content: string, bullets: readonly string[]): string;
export {};
