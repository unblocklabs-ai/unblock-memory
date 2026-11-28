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
    /**
     * What the replayed prompts were: the exact request the skill router saw (`routed_request`), the recall query recorded
     * for the same run as a stand-in for historical rows without one (`query_proxy`), or a mix of both.
     */
    replayBasis?: "routed_request" | "query_proxy" | "mixed";
    routedExamples?: number;
    proxyExamples?: number;
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
export type SkillProposalErrorCode = "not_found" | "invalid_state" | "invalid_input" | "path_outside_root" | "conflict" | "target_exists" | "locked";
export declare class SkillProposalError extends Error {
    readonly code: SkillProposalErrorCode;
    constructor(code: SkillProposalErrorCode, message: string);
}
export declare const sha256: (text: string | Buffer) => string;
/** Create the table and register `memory_schema('skill_proposals', 1)`. Idempotent; refuses unknown future versions. */
export declare function ensureSkillProposalsSchema(db: DatabaseSync): void;
/**
 * Insert a `pending` proposal, deduplicated by `(agent_id, kind, skill_name, proposal_hash)` (open twins must also share
 * `skill_path` and `base_sha256`). Competition is scoped to one target file, `(agent_id, kind, skill_name, skill_path)`:
 * a new proposal supersedes older `pending` ones for that same file, unless one of them targets the same live file revision
 * with strictly better replay metrics (then that one is kept). Two skills sharing a name in different roots never compete.
 * `approved` rows are never superseded here: an operator decision outranks a background pass.
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
/**
 * `approved -> applied`, recording where the file landed. For an edit, every other open proposal for the same file that was
 * derived from the bytes just displaced (`base_sha256` = this proposal's base) is superseded: its base is gone. Drafts
 * already based on the newly installed bytes (or any other revision) are left alone.
 */
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
 * A configured root that does not exist yet is located through its nearest existing ancestor.
 */
export declare function isAdmittedSkillPath(path: string, sources: readonly SkillSource[]): boolean;
/**
 * Atomic no-clobber create: the complete file appears at `target` via `link(2)`, which fails with `EEXIST` instead of
 * replacing anything, so two concurrent creates can never overwrite each other (or an operator's hand-written file).
 * The directory entry is fsynced before returning.
 */
export declare function createFileExclusively(target: string, content: string, mode?: number): void;
type ApplyInput = {
    id: string;
    agentId: string;
    allowedSources: readonly SkillSource[];
    targetDirForNewSkills?: string;
    dryRun?: boolean;
    nowMs?: number;
    /** How long to wait for another process's apply of the same file (default 30 s; `0` = wait indefinitely). */
    lockWaitMs?: number;
    /**
     * Break a lock whose owner cannot be checked (another host, or an unreadable owner record) once older than this
     * (default 10 min; `0` = never). A same-host lock is broken only when its owner pid is dead, never by age.
     */
    lockStaleMs?: number;
};
/**
 * Apply one operator-approved proposal: confine the target to the configured skills sources, then — under a cross-process
 * lock on the target's directory held from the approval re-check through the `applied` receipt — re-read the approval,
 * verify the live file still matches `base_sha256` (or, for `new_skill`, does not exist yet), write it completely (temp +
 * fsync + rename, or an atomic no-clobber link for `new_skill`), fsync the directory, and only then mark it `applied`.
 * Crash-safe: when the live file already holds exactly the proposed bytes (an earlier apply wrote it but died before
 * recording that), the row is marked `applied` without writing. `dryRun` previews the diff without locking, writing or
 * changing state.
 */
export declare function applyApprovedProposal(db: DatabaseSync, input: ApplyInput): ApplySkillProposalResult;
/** Newest first. Missing table → `[]`; never creates anything. */
export declare function listSkillProposals(db: DatabaseSync, filter: SkillProposalFilter): SkillProposal[];
export declare function getSkillProposal(db: DatabaseSync, id: string, agentId: string): SkillProposal | undefined;
export declare function summarizeSkillProposals(db: DatabaseSync, agentId: string): SkillProposalsSummary;
/** Open `path` read-only (never creating it), run `fn`, close. A missing file yields `fallback`. */
export declare function withReadOnlySkillProposals<T>(path: string, fallback: T, fn: (db: DatabaseSync) => T): T;
/**
 * The frontmatter `description` (plain, quoted or block scalar), or `undefined` when absent. Parsed with the same `yaml`
 * package and schema as the skills catalog; like the catalog, frontmatter that is not valid YAML (an unquoted `: ` in a
 * legacy description) falls back to the raw `description:` line.
 */
export declare function readSkillDescription(content: string): string | undefined;
/**
 * Replace (or add) the frontmatter `description`, leaving every other byte intact: a UTF-8 BOM and the file's line endings
 * are preserved, and the value node's exact YAML source range is replaced (quoted keys, indented or flow maps, block
 * scalars with blank lines). The value is written as a JSON string, which is a valid YAML double-quoted scalar. A file
 * without frontmatter gains one. Throws `invalid_input` unless the rewritten frontmatter parses without any YAML error
 * (e.g. `DUPLICATE_KEY`), every other key parses exactly as before, and its `description` is exactly the
 * (whitespace-normalized) proposed one.
 */
export declare function replaceSkillDescription(content: string, description: string, name?: string): string;
/**
 * Append bullets under the file's `## Pitfalls` section (created at the end when missing). Existing text is untouched,
 * the file's line endings are kept, and section detection follows CommonMark: a heading needs at most 3 spaces of indent
 * (4 = indented code), headings inside fenced code (``` / ~~~) are ignored, and the section ends at the next level-1/2
 * ATX heading or setext (`===` / `---` underlined) heading, so a bullet never lands inside code or the next section.
 */
export declare function appendSkillPitfalls(content: string, bullets: readonly string[]): string;
export {};
