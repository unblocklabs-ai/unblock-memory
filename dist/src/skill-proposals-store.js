import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import picomatch from "picomatch";
import { ensureSchemaUnderWriteLock, immediateTransaction, tableExists } from "./memory-database.js";
// Loaded by plain-Node workers and offline tools (`memory-steward skills`): keep this module free of `openclaw`.
/**
 * Durable, review-only skill proposals. The Steward writes `pending` rows; nothing here ever touches a live `SKILL.md`
 * except {@link applyApprovedProposal}, which an operator calls explicitly on an `approved` row.
 *
 * State machine: `pending -> approved | rejected | superseded`, `approved -> applied | superseded`.
 */
const SKILL_PROPOSALS_COMPONENT = "skill_proposals";
const SKILL_PROPOSALS_SCHEMA_VERSION = 1;
const TABLE = "skill_proposals";
export const SKILL_PROPOSAL_KINDS = ["description_update", "pitfall_patch", "new_skill"];
export const SKILL_PROPOSAL_STATUSES = ["pending", "approved", "rejected", "applied", "superseded"];
/** The filename every proposal targets: an apply can never write any other file. */
export const SKILL_FILE_NAME = "SKILL.md";
const SKILL_PROPOSALS_SCHEMA = `CREATE TABLE IF NOT EXISTS skill_proposals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('description_update', 'pitfall_patch', 'new_skill')),
  skill_name TEXT NOT NULL,
  skill_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'applied', 'superseded')),
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  base_description TEXT,
  proposed_description TEXT,
  proposed_content TEXT NOT NULL,
  diff_summary TEXT NOT NULL,
  base_sha256 TEXT,
  replay_metrics_json TEXT CHECK(replay_metrics_json IS NULL OR json_valid(replay_metrics_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  proposal_hash TEXT NOT NULL,
  recipe_hash TEXT NOT NULL DEFAULT 'default',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  reviewed_at_ms INTEGER,
  reviewed_by TEXT,
  review_note TEXT,
  applied_at_ms INTEGER,
  applied_path TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_skill_proposals_agent_status ON skill_proposals(agent_id, status, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_skill_proposals_subject ON skill_proposals(agent_id, kind, skill_name, status);
CREATE INDEX IF NOT EXISTS idx_skill_proposals_hash ON skill_proposals(agent_id, kind, skill_name, proposal_hash);`;
export class SkillProposalError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "SkillProposalError";
        this.code = code;
    }
}
/* ───────────────────────────── Helpers ───────────────────────────── */
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
function requireText(value, field) {
    if (typeof value !== "string" || !value.trim())
        throw new SkillProposalError("invalid_input", `Skill proposal ${field} must be a non-empty string`);
    return value.trim();
}
function requireEnum(value, allowed, field) {
    if (typeof value !== "string" || !allowed.includes(value)) {
        throw new SkillProposalError("invalid_input", `Skill proposal ${field} must be one of ${allowed.join(", ")}`);
    }
    return value;
}
function optionalText(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function requireNow(value) {
    const now = value ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0)
        throw new SkillProposalError("invalid_input", "nowMs must be a non-negative integer");
    return now;
}
function parseJson(text, fallback) {
    if (typeof text !== "string")
        return fallback;
    try {
        return JSON.parse(text);
    }
    catch {
        return fallback;
    }
}
const nullableText = (value) => value === null || value === undefined ? null : String(value);
const nullableNumber = (value) => value === null || value === undefined ? null : Number(value);
function proposal(row) {
    const evidence = parseJson(row.evidence_json, {});
    return {
        id: String(row.id), agentId: String(row.agent_id), kind: row.kind, skillName: String(row.skill_name),
        skillPath: String(row.skill_path), status: row.status, title: String(row.title), rationale: String(row.rationale),
        baseDescription: nullableText(row.base_description), proposedDescription: nullableText(row.proposed_description),
        proposedContent: String(row.proposed_content), diffSummary: String(row.diff_summary), baseSha256: nullableText(row.base_sha256),
        replayMetrics: parseJson(row.replay_metrics_json, null),
        evidence: evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : {},
        proposalHash: String(row.proposal_hash), recipeHash: String(row.recipe_hash),
        createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms),
        reviewedAtMs: nullableNumber(row.reviewed_at_ms), reviewedBy: nullableText(row.reviewed_by), reviewNote: nullableText(row.review_note),
        appliedAtMs: nullableNumber(row.applied_at_ms), appliedPath: nullableText(row.applied_path),
    };
}
/** Runs `fn` atomically, joining a caller's open transaction (e.g. `WorkStore.commitWithDomain`) instead of nesting. */
function atomically(db, fn) {
    return db.isTransaction ? fn() : immediateTransaction(db, fn);
}
function hasTable(db) {
    try {
        return tableExists(db, TABLE);
    }
    catch {
        return false;
    }
}
/** Create the table and register `memory_schema('skill_proposals', 1)`. Idempotent; refuses unknown future versions. */
export function ensureSkillProposalsSchema(db) {
    const ready = () => {
        if (!tableExists(db, "memory_schema"))
            return false;
        const version = db.prepare("SELECT version FROM memory_schema WHERE component=?").get(SKILL_PROPOSALS_COMPONENT)?.version;
        if (version !== undefined && version !== SKILL_PROPOSALS_SCHEMA_VERSION)
            throw new Error("Unsupported skill_proposals schema version");
        return version === SKILL_PROPOSALS_SCHEMA_VERSION && tableExists(db, TABLE);
    };
    const install = () => {
        db.exec("CREATE TABLE IF NOT EXISTS memory_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT");
        db.exec(SKILL_PROPOSALS_SCHEMA);
        db.prepare("INSERT OR IGNORE INTO memory_schema VALUES (?,?)").run(SKILL_PROPOSALS_COMPONENT, SKILL_PROPOSALS_SCHEMA_VERSION);
    };
    // Inside a caller's transaction (a fenced commit) the write lock is already held: never nest `BEGIN`.
    if (db.isTransaction) {
        if (!ready())
            install();
        return;
    }
    ensureSchemaUnderWriteLock(db, ready, install);
}
/** Default dedup identity: what the apply step would write, not when or why it was proposed. */
function skillProposalHash(input) {
    return sha256(JSON.stringify([input.kind, input.skillName, input.proposedDescription ?? null, input.proposedContent]));
}
/** Replay quality for "better proposal" comparisons; `undefined` = not comparable (newer simply wins). */
function quality(metrics) {
    if (!metrics || !Number.isFinite(metrics.recallGainPp) || !Number.isFinite(metrics.falseActivationDeltaPp))
        return undefined;
    return metrics.recallGainPp - metrics.falseActivationDeltaPp - 100 * (metrics.criticalRegressions || 0);
}
/* ───────────────────────────── Writes ───────────────────────────── */
/**
 * Insert a `pending` proposal, deduplicated by `(agent_id, kind, skill_name, proposal_hash)` (open twins must also share
 * `skill_path` and `base_sha256`). A new proposal supersedes
 * older `pending` ones for the same `(agent_id, kind, skill_name)`, unless one of them targets the same live file revision
 * with strictly better replay metrics (then that one is kept). `approved` rows are never superseded here: an operator
 * decision outranks a background pass.
 */
export function upsertSkillProposal(db, input) {
    ensureSkillProposalsSchema(db);
    const agentId = requireText(input.agentId, "agentId");
    const kind = requireEnum(input.kind, SKILL_PROPOSAL_KINDS, "kind");
    const skillName = requireText(input.skillName, "skillName");
    const skillPath = requireText(input.skillPath, "skillPath");
    const title = requireText(input.title, "title");
    const rationale = requireText(input.rationale, "rationale");
    if (typeof input.proposedContent !== "string" || !input.proposedContent.trim()) {
        throw new SkillProposalError("invalid_input", "Skill proposal proposedContent must be a non-empty string");
    }
    if (basename(skillPath) !== SKILL_FILE_NAME)
        throw new SkillProposalError("invalid_input", `Skill proposal skillPath must name a ${SKILL_FILE_NAME}`);
    const baseSha256 = optionalText(input.baseSha256)?.toLowerCase() ?? null;
    if (kind === "new_skill") {
        if (isAbsolute(skillPath) || skillPath.split(/[\\/]/u).some(part => part === "" || part === "." || part === "..")) {
            throw new SkillProposalError("invalid_input", "new_skill skillPath must be a plain relative <name>/SKILL.md");
        }
    }
    else {
        if (!isAbsolute(skillPath))
            throw new SkillProposalError("invalid_input", `${kind} skillPath must be absolute`);
        if (!baseSha256 || !/^[a-f0-9]{64}$/u.test(baseSha256))
            throw new SkillProposalError("invalid_input", `${kind} requires a SHA-256 baseSha256`);
    }
    if (kind === "description_update" && !optionalText(input.proposedDescription)) {
        throw new SkillProposalError("invalid_input", "description_update requires proposedDescription");
    }
    const evidenceJson = JSON.stringify(input.evidence ?? {});
    const metricsJson = input.replayMetrics ? JSON.stringify(input.replayMetrics) : null;
    const proposalHash = optionalText(input.proposalHash) ?? skillProposalHash({ ...input, kind, skillName });
    const nowMs = requireNow(input.nowMs);
    return atomically(db, () => {
        // An open (pending/approved) twin only counts when it targets the same file revision: a stale-base twin can never
        // apply, so it must not strand this fresh draft. An operator's reject/apply of the same content stays final.
        const same = db.prepare(`SELECT * FROM skill_proposals WHERE agent_id=? AND kind=? AND skill_name=? AND proposal_hash=?
      AND (status IN ('rejected','applied') OR (status IN ('pending','approved') AND skill_path=? AND base_sha256 IS ?))
      ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at_ms DESC LIMIT 1`)
            .get(agentId, kind, skillName, proposalHash, skillPath, baseSha256);
        if (same) {
            const existing = proposal(same);
            return { action: existing.status === "pending" || existing.status === "approved" ? "unchanged" : "previously_reviewed",
                proposal: existing, superseded: [] };
        }
        const pending = db.prepare(`SELECT * FROM skill_proposals WHERE agent_id=? AND kind=? AND skill_name=? AND status='pending'
      ORDER BY created_at_ms`).all(agentId, kind, skillName).map(proposal);
        const incoming = quality(input.replayMetrics);
        const better = pending.find(old => old.baseSha256 === baseSha256 && incoming !== undefined &&
            (quality(old.replayMetrics) ?? -Infinity) > incoming);
        if (better)
            return { action: "kept_existing", proposal: better, superseded: [] };
        const superseded = pending.map(old => old.id);
        const supersede = db.prepare("UPDATE skill_proposals SET status='superseded', updated_at_ms=? WHERE id=? AND status='pending'");
        for (const id of superseded)
            supersede.run(nowMs, id);
        const id = `skillprop:${randomUUID()}`;
        db.prepare(`INSERT INTO skill_proposals (id,agent_id,kind,skill_name,skill_path,status,title,rationale,base_description,
        proposed_description,proposed_content,diff_summary,base_sha256,replay_metrics_json,evidence_json,proposal_hash,recipe_hash,
        created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, agentId, kind, skillName, skillPath, title, rationale, input.baseDescription ?? null, optionalText(input.proposedDescription), input.proposedContent, input.diffSummary ?? "", baseSha256, metricsJson, evidenceJson, proposalHash, optionalText(input.recipeHash) ?? "default", nowMs, nowMs);
        return { action: "inserted", proposal: getSkillProposal(db, id, agentId), superseded };
    });
}
function requireProposal(db, id, agentId) {
    const found = getSkillProposal(db, id, agentId);
    if (!found)
        throw new SkillProposalError("not_found", `Skill proposal ${id} not found`);
    return found;
}
/** Operator review: `pending -> approved | rejected`. Any other state throws `invalid_state`. */
export function reviewSkillProposal(db, input) {
    const decision = requireEnum(input.decision, ["approved", "rejected"], "decision");
    const nowMs = requireNow(input.nowMs);
    if (!hasTable(db))
        throw new SkillProposalError("not_found", `Skill proposal ${input.id} not found`);
    return atomically(db, () => {
        const current = requireProposal(db, input.id, input.agentId);
        if (current.status !== "pending")
            throw new SkillProposalError("invalid_state", `Skill proposal ${input.id} is ${current.status}, not pending`);
        db.prepare(`UPDATE skill_proposals SET status=?, reviewed_at_ms=?, reviewed_by=?, review_note=?, updated_at_ms=?
      WHERE id=? AND agent_id=? AND status='pending'`)
            .run(decision, nowMs, optionalText(input.reviewedBy), optionalText(input.note), nowMs, input.id, input.agentId);
        return requireProposal(db, input.id, input.agentId);
    });
}
/** `approved -> applied`, recording where the file landed. Supersedes other open proposals for that file (their base is gone). */
export function markSkillProposalApplied(db, input) {
    const appliedPath = requireText(input.appliedPath, "appliedPath");
    const nowMs = requireNow(input.nowMs);
    if (!hasTable(db))
        throw new SkillProposalError("not_found", `Skill proposal ${input.id} not found`);
    return atomically(db, () => {
        const current = requireProposal(db, input.id, input.agentId);
        if (current.status !== "approved")
            throw new SkillProposalError("invalid_state", `Skill proposal ${input.id} is ${current.status}, not approved`);
        db.prepare(`UPDATE skill_proposals SET status='applied', applied_at_ms=?, applied_path=?, updated_at_ms=?
      WHERE id=? AND agent_id=? AND status='approved'`).run(nowMs, appliedPath, nowMs, input.id, input.agentId);
        if (current.kind !== "new_skill") {
            // Every other open proposal for this file was derived from the bytes just replaced.
            db.prepare(`UPDATE skill_proposals SET status='superseded', updated_at_ms=?
        WHERE agent_id=? AND id!=? AND skill_path=? AND kind!='new_skill' AND status IN ('pending','approved')`)
                .run(nowMs, input.agentId, input.id, current.skillPath);
        }
        return requireProposal(db, input.id, input.agentId);
    });
}
function isInside(root, target) {
    const rel = relative(root, target);
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
/** Where `path` really lands: the deepest existing ancestor resolved through symlinks, plus the not-yet-created tail. */
function realLocation(path) {
    let current = path;
    const tail = [];
    for (;;) {
        try {
            return join(realpathSync(current), ...tail.reverse());
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            const parent = dirname(current);
            if (parent === current)
                throw error;
            tail.push(basename(current));
            current = parent;
        }
    }
}
/** Same matching as the skills catalog: strictly under `root`, and the portable relative path matches the corpus glob. */
const matchesSource = (source, root, path) => isInside(root, path) && picomatch.isMatch(relative(root, path).split(sep).join("/"), source.pattern, { dot: false });
/**
 * The skills-corpus admission check shared by `skill-apply` and the Skills pass: `path` is a `SKILL.md` matching one
 * configured source's glob, both lexically (against the configured or canonical root) and after resolving every symlink.
 */
export function isAdmittedSkillPath(path, sources) {
    const lexical = resolve(path);
    if (basename(lexical) !== SKILL_FILE_NAME)
        return false;
    let real;
    try {
        real = realLocation(lexical);
    }
    catch {
        return false;
    }
    return sources.some(source => {
        if (typeof source.root !== "string" || !source.root.trim() || typeof source.pattern !== "string" || !source.pattern)
            return false;
        const root = resolve(source.root);
        let realRoot;
        try {
            realRoot = realpathSync(root);
        }
        catch {
            return false;
        }
        return (matchesSource(source, root, lexical) || matchesSource(source, realRoot, lexical)) && matchesSource(source, realRoot, real);
    });
}
/** The target must be admitted by {@link isAdmittedSkillPath}, be named `SKILL.md`, and must not itself be a symlink. */
function confinedTarget(target, sources) {
    if (!sources.length)
        throw new SkillProposalError("path_outside_root", "allowedSources must list at least one skills source");
    const lexical = resolve(target);
    if (basename(lexical) !== SKILL_FILE_NAME)
        throw new SkillProposalError("path_outside_root", `Refusing to write ${lexical}: not a ${SKILL_FILE_NAME}`);
    const entry = lstatSync(lexical, { throwIfNoEntry: false });
    if (entry && !entry.isFile())
        throw new SkillProposalError("path_outside_root", `Refusing to write ${lexical}: not a regular file`);
    if (!isAdmittedSkillPath(lexical, sources)) {
        throw new SkillProposalError("path_outside_root", `Refusing to write ${lexical}: outside every configured skills source`);
    }
    return lexical;
}
/** Minimal line diff (common prefix/suffix trimmed) for operator previews. */
function lineDiff(before, after, context = 2) {
    const a = before === "" ? [] : before.split("\n"), b = after.split("\n");
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start])
        start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    if (start === endA && start === endB)
        return "";
    const from = Math.max(0, start - context);
    const lines = [`@@ -${from + 1},${endA - from} +${from + 1},${endB - from} @@`];
    for (let i = from; i < start; i++)
        lines.push(` ${a[i]}`);
    for (let i = start; i < endA; i++)
        lines.push(`-${a[i]}`);
    for (let i = start; i < endB; i++)
        lines.push(`+${b[i]}`);
    for (let i = endA; i < Math.min(a.length, endA + context); i++)
        lines.push(` ${a[i]}`);
    return lines.join("\n");
}
/** Fully written + fsynced sibling temp file; the caller links or renames it into place. */
function writeTemp(target, content, mode) {
    const temp = join(dirname(target), `.${SKILL_FILE_NAME}.${randomUUID()}.tmp`);
    const descriptor = openSync(temp, "wx", mode);
    try {
        writeSync(descriptor, content);
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
    return temp;
}
/**
 * Atomic no-clobber create: the complete file appears at `target` via `link(2)`, which fails with `EEXIST` instead of
 * replacing anything, so two concurrent creates can never overwrite each other (or an operator's hand-written file).
 */
export function createFileExclusively(target, content, mode = 0o644) {
    const temp = writeTemp(target, content, mode);
    try {
        linkSync(temp, target);
    }
    catch (error) {
        if (error.code === "EEXIST")
            throw new SkillProposalError("target_exists", `${target} already exists`);
        throw error;
    }
    finally {
        try {
            unlinkSync(temp);
        }
        catch { /* already gone */ }
    }
}
/** Replace `target` only while it still hashes to `expectedSha`, via temp file + rename. */
function replaceAtomically(target, content, mode, expectedSha) {
    const temp = writeTemp(target, content, mode);
    try {
        // Re-check right before the rename: the window for a concurrent edit is only this one syscall.
        const live = lstatSync(target, { throwIfNoEntry: false });
        if (!live?.isFile() || sha256(readFileSync(target)) !== expectedSha)
            throw new SkillProposalError("conflict", `${target} changed during apply`);
        renameSync(temp, target);
    }
    catch (error) {
        try {
            unlinkSync(temp);
        }
        catch { /* already renamed or gone */ }
        throw error;
    }
}
/** A `description_update` must carry exactly the description its content declares, or the reviewed text is not what lands. */
function assertDescriptionRoundTrip(proposal) {
    if (proposal.kind !== "description_update")
        return;
    if (readSkillDescription(proposal.proposedContent) !== proposal.proposedDescription) {
        throw new SkillProposalError("invalid_input", `Skill proposal ${proposal.id}: proposedContent does not declare proposedDescription`);
    }
}
/**
 * Apply one operator-approved proposal: confine the target to the configured skills sources, verify the live file still
 * matches `base_sha256` (or, for `new_skill`, does not exist yet), write it (temp + rename, or an atomic no-clobber create
 * for `new_skill`), and mark it `applied`. Crash-safe: when the live file already holds exactly the proposed bytes (an
 * earlier apply wrote it but died before recording that), the row is marked `applied` without writing.
 * `dryRun` returns the preview diff without writing or changing state.
 */
export function applyApprovedProposal(db, input) {
    if (!hasTable(db))
        throw new SkillProposalError("not_found", `Skill proposal ${input.id} not found`);
    const current = requireProposal(db, input.id, input.agentId);
    if (current.status !== "approved")
        throw new SkillProposalError("invalid_state", `Skill proposal ${input.id} is ${current.status}, not approved`);
    assertDescriptionRoundTrip(current);
    let target;
    if (current.kind === "new_skill") {
        if (!input.targetDirForNewSkills?.trim())
            throw new SkillProposalError("invalid_input", "new_skill proposals require targetDirForNewSkills");
        target = confinedTarget(join(resolve(input.targetDirForNewSkills), current.skillPath), input.allowedSources);
    }
    else {
        target = confinedTarget(current.skillPath, input.allowedSources);
    }
    const proposedSha = sha256(current.proposedContent);
    const mark = (bytesWritten, diff) => ({ status: "applied", targetPath: target, diff, bytesWritten,
        proposal: markSkillProposalApplied(db, { id: current.id, agentId: current.agentId, appliedPath: target,
            ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }) }) });
    const live = statSync(target, { throwIfNoEntry: false });
    const bytes = live?.isFile() ? readFileSync(target) : undefined;
    if (bytes && sha256(bytes) === proposedSha) {
        return input.dryRun ? { status: "preview", proposal: current, targetPath: target, diff: "", bytesWritten: 0 } : mark(0, "");
    }
    let before = "", mode = 0o644;
    if (current.kind === "new_skill") {
        if (live)
            throw new SkillProposalError("target_exists", `${target} already exists`);
    }
    else {
        if (!bytes || !live)
            throw new SkillProposalError("conflict", `${target} no longer exists`);
        if (sha256(bytes) !== current.baseSha256) {
            throw new SkillProposalError("conflict", `${target} changed since the proposal was drafted (base SHA-256 mismatch)`);
        }
        before = bytes.toString("utf8");
        mode = live.mode & 0o777;
    }
    const diff = lineDiff(before, current.proposedContent);
    if (input.dryRun)
        return { status: "preview", proposal: current, targetPath: target, diff, bytesWritten: 0 };
    if (current.kind === "new_skill") {
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        createFileExclusively(target, current.proposedContent, mode);
    }
    else {
        replaceAtomically(target, current.proposedContent, mode, current.baseSha256);
    }
    return mark(Buffer.byteLength(current.proposedContent), diff);
}
/* ───────────────────────────── Reads ───────────────────────────── */
const asList = (value) => value === undefined ? undefined : Array.isArray(value) ? value : [value];
/** Newest first. Missing table → `[]`; never creates anything. */
export function listSkillProposals(db, filter) {
    if (!hasTable(db))
        return [];
    const limit = filter.limit ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 0)
        throw new RangeError("limit must be a non-negative integer");
    const where = ["agent_id=?"], params = [filter.agentId];
    for (const [column, values] of [["status", asList(filter.status)], ["kind", asList(filter.kind)]]) {
        if (!values)
            continue;
        if (!values.length)
            return [];
        where.push(`${column} IN (${values.map(() => "?").join(",")})`);
        params.push(...values);
    }
    if (filter.skillName !== undefined) {
        where.push("skill_name=?");
        params.push(filter.skillName);
    }
    const sql = `SELECT * FROM skill_proposals WHERE ${where.join(" AND ")} ORDER BY created_at_ms DESC, id${limit ? " LIMIT ?" : ""}`;
    return db.prepare(sql).all(...params, ...(limit ? [limit] : [])).map(proposal);
}
export function getSkillProposal(db, id, agentId) {
    if (!hasTable(db))
        return undefined;
    const row = db.prepare("SELECT * FROM skill_proposals WHERE id=? AND agent_id=?").get(id, agentId);
    return row ? proposal(row) : undefined;
}
export function summarizeSkillProposals(db, agentId) {
    const summary = {
        total: 0, oldestPendingAtMs: null,
        byStatus: Object.fromEntries(SKILL_PROPOSAL_STATUSES.map(status => [status, 0])),
        byKind: Object.fromEntries(SKILL_PROPOSAL_KINDS.map(kind => [kind, 0])),
    };
    if (!hasTable(db))
        return summary;
    for (const row of db.prepare("SELECT status, kind, COUNT(*) AS n FROM skill_proposals WHERE agent_id=? GROUP BY status, kind").all(agentId)) {
        const n = Number(row.n);
        summary.total += n;
        const status = row.status, kind = row.kind;
        if (status in summary.byStatus)
            summary.byStatus[status] += n;
        if (kind in summary.byKind)
            summary.byKind[kind] += n;
    }
    const oldest = db.prepare("SELECT MIN(created_at_ms) AS at FROM skill_proposals WHERE agent_id=? AND status='pending'").get(agentId)?.at;
    summary.oldestPendingAtMs = oldest === null || oldest === undefined ? null : Number(oldest);
    return summary;
}
/** Open `path` read-only (never creating it), run `fn`, close. A missing file yields `fallback`. */
export function withReadOnlySkillProposals(path, fallback, fn) {
    if (!statSync(path, { throwIfNoEntry: false })?.isFile())
        return fallback;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON");
        return fn(db);
    }
    finally {
        db.close();
    }
}
/* ───────────────────────────── SKILL.md text helpers ───────────────────────────── */
const FRONTMATTER = /^(---\r?\n)([\s\S]*?\r?\n)(---[ \t]*(?:\r?\n|$))/u;
const BOM = "\uFEFF";
const BLOCK_SCALAR = /^[|>][1-9+-]*\s*$/u;
const DESCRIPTION_KEY = /^description\s*:/u;
/** `[bom, rest]`: a leading UTF-8 BOM is carried through every rewrite untouched. */
const splitBom = (content) => content.startsWith(BOM) ? [BOM, content.slice(1)] : ["", content];
const eolOf = (content) => content.includes("\r\n") ? "\r\n" : "\n";
/**
 * One past the last line of the scalar that starts at `lines[index]`: every following indented line, including blank
 * lines inside it (a block scalar's paragraph breaks). Trailing blank lines are left to the surrounding document.
 */
function scalarEnd(lines, index) {
    let end = index + 1;
    for (let i = index + 1; i < lines.length; i++) {
        if (/^\s+\S/u.test(lines[i]))
            end = i + 1;
        else if (lines[i].trim())
            break;
    }
    return end;
}
/** YAML literal (`|`) or folded (`>`) block body, de-indented; chomping is irrelevant because the result is trimmed. */
function blockScalar(style, lines) {
    const indent = Math.min(...lines.filter(line => line.trim()).map(line => /^\s*/u.exec(line)[0].length));
    const text = lines.map(line => line.trim() ? line.slice(indent).trimEnd() : "").join("\n");
    // Folding: a single line break becomes a space, and each extra blank line keeps one newline.
    return (style === "|" ? text : text.replace(/([^\n])\n(?=[^\n])/gu, "$1 ").replace(/\n(\n+)/gu, "$1")).trim();
}
/** The frontmatter `description` (plain, quoted or block scalar), or `undefined` when absent. */
export function readSkillDescription(content) {
    const match = FRONTMATTER.exec(splitBom(content)[1]);
    if (!match)
        return undefined;
    const lines = match[2].split(/\r?\n/u);
    const index = lines.findIndex(line => DESCRIPTION_KEY.test(line));
    if (index < 0)
        return undefined;
    const raw = lines[index].replace(/^description\s*:\s*/u, "").trimEnd();
    const body = lines.slice(index + 1, scalarEnd(lines, index));
    if (BLOCK_SCALAR.test(raw))
        return body.some(line => line.trim()) ? blockScalar(raw[0], body) : "";
    const continuation = body.map(line => line.trim()).filter(Boolean);
    if (raw.startsWith("\"")) {
        try {
            return JSON.parse([raw, ...continuation].join(" "));
        }
        catch {
            return raw.slice(1, -1);
        }
    }
    if (raw.startsWith("'"))
        return [raw, ...continuation].join(" ").replace(/^'|'$/gu, "").replaceAll("''", "'");
    return [raw, ...continuation].join(" ").trim();
}
/**
 * Replace (or add) the frontmatter `description`, leaving every other byte intact: a UTF-8 BOM and the file's line endings
 * are preserved, and a multi-line value (including a `|` / `>` block scalar with blank lines) is replaced whole. The value
 * is written as a JSON string, which is a valid YAML double-quoted scalar. A file without frontmatter gains one. Throws
 * `invalid_input` unless the result reads back as exactly the (whitespace-normalized) proposed description.
 */
export function replaceSkillDescription(content, description, name) {
    const proposed = description.replace(/\s+/gu, " ").trim();
    const value = `description: ${JSON.stringify(proposed)}`;
    const [bom, body] = splitBom(content);
    const match = FRONTMATTER.exec(body);
    let updated;
    if (!match) {
        const eol = eolOf(body);
        const header = [...(name ? [`name: ${JSON.stringify(name)}`] : []), value].join(eol);
        updated = `${bom}---${eol}${header}${eol}---${eol}${eol}${body}`;
    }
    else {
        const newline = match[1].endsWith("\r\n") ? "\r\n" : "\n";
        const lines = match[2].split(/\r?\n/u);
        if (lines.at(-1) === "")
            lines.pop();
        const index = lines.findIndex(line => DESCRIPTION_KEY.test(line));
        if (index < 0)
            lines.push(value);
        else
            lines.splice(index, scalarEnd(lines, index) - index, value);
        updated = `${bom}${match[1]}${lines.join(newline)}${newline}${match[3]}${body.slice(match[0].length)}`;
    }
    if (readSkillDescription(updated) !== proposed) {
        throw new SkillProposalError("invalid_input", "Rewritten SKILL.md frontmatter does not read back as the proposed description");
    }
    return updated;
}
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
/** Which lines are inside (or delimit) a fenced code block, and the fence still open at the end of the file, if any. */
function fencedLines(lines) {
    const fenced = [];
    let open;
    lines.forEach((line, at) => {
        const match = FENCE.exec(line);
        if (open) {
            fenced.push(true);
            if (match && match[1][0] === open.marker[0] && match[1].length >= open.marker.length && !match[2].trim())
                open = undefined;
        }
        else if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
            open = { at, marker: match[1] };
            fenced.push(true);
        }
        else
            fenced.push(false);
    });
    return { fenced, ...(open ? { open } : {}) };
}
/**
 * Append bullets under the file's `## Pitfalls` section (created at the end when missing). Existing text is untouched,
 * the file's line endings are kept, and headings or section ends inside fenced code blocks (``` / ~~~) are ignored, so a
 * bullet never lands inside code.
 */
export function appendSkillPitfalls(content, bullets) {
    const items = bullets.map(bullet => bullet.replace(/\s+/gu, " ").trim()).filter(Boolean).map(bullet => `- ${bullet}`);
    if (!items.length)
        return content;
    const eol = eolOf(content);
    // Each element keeps its own terminator, so untouched lines stay byte-for-byte identical.
    const rows = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
    const lines = rows.map(row => row.replace(/\r?\n$/u, ""));
    const { fenced, open } = fencedLines(lines);
    const heading = lines.findIndex((line, i) => !fenced[i] && /^##\s+pitfalls\s*$/iu.test(line.trim()));
    if (heading < 0) {
        // An unclosed fence runs to the end of the file: close it first so the new section is never code.
        const body = `${content.replace(/\s+$/u, "")}${open ? `${eol}${open.marker}` : ""}`;
        return `${body}${eol}${eol}## Pitfalls${eol}${eol}${items.join(eol)}${eol}`;
    }
    let end = heading + 1;
    while (end < lines.length && (fenced[end] || !/^#{1,2}\s/u.test(lines[end])))
        end++;
    // A fence left open inside the section swallows the rest of the file: insert before it.
    if (open && open.at > heading && open.at < end)
        end = open.at;
    let insert = end;
    while (insert > heading + 1 && lines[insert - 1].trim() === "")
        insert--;
    const before = rows.slice(0, insert), after = rows.slice(insert);
    if (before.length && !before.at(-1).endsWith("\n"))
        before[before.length - 1] += eol;
    const spacer = insert === heading + 1 ? [eol] : [];
    const added = items.map((item, i) => i === items.length - 1 && !after.length && !content.endsWith("\n") ? item : `${item}${eol}`);
    return [...before, ...spacer, ...added, ...after].join("");
}
