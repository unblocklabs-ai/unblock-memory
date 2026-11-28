import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import picomatch from "picomatch";
import { isMap, isNode, isScalar, parseDocument } from "yaml";
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
 * `skill_path` and `base_sha256`). Competition is scoped to one target file, `(agent_id, kind, skill_name, skill_path)`:
 * a new proposal supersedes older `pending` ones for that same file, unless one of them targets the same live file revision
 * with strictly better replay metrics (then that one is kept). Two skills sharing a name in different roots never compete.
 * `approved` rows are never superseded here: an operator decision outranks a background pass.
 */
export function upsertSkillProposal(db, input) {
    ensureSkillProposalsSchema(db);
    const agentId = requireText(input.agentId, "agentId");
    const kind = requireEnum(input.kind, SKILL_PROPOSAL_KINDS, "kind");
    const skillName = requireText(input.skillName, "skillName");
    const rawPath = requireText(input.skillPath, "skillPath");
    // Absolute targets are normalized (`.`/`..` collapsed) so one file always has one dedup / supersession identity.
    const skillPath = isAbsolute(rawPath) ? resolve(rawPath) : rawPath;
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
        // apply, so it must not strand this fresh draft. An operator's reject/apply of the same content stays final, but only
        // for that same canonical file: a decision on one SKILL.md never suppresses a proposal for a different file.
        const same = db.prepare(`SELECT * FROM skill_proposals WHERE agent_id=? AND kind=? AND skill_name=? AND proposal_hash=?
      AND skill_path=? AND (status IN ('rejected','applied') OR (status IN ('pending','approved') AND base_sha256 IS ?))
      ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at_ms DESC LIMIT 1`)
            .get(agentId, kind, skillName, proposalHash, skillPath, baseSha256);
        if (same) {
            const existing = proposal(same);
            return { action: existing.status === "pending" || existing.status === "approved" ? "unchanged" : "previously_reviewed",
                proposal: existing, superseded: [] };
        }
        const pending = db.prepare(`SELECT * FROM skill_proposals WHERE agent_id=? AND kind=? AND skill_name=? AND skill_path=?
      AND status='pending' ORDER BY created_at_ms`).all(agentId, kind, skillName, skillPath).map(proposal);
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
/**
 * `approved -> applied`, recording where the file landed. For an edit, every other open proposal for the same file that was
 * derived from the bytes just displaced (`base_sha256` = this proposal's base) is superseded: its base is gone. Drafts
 * already based on the newly installed bytes (or any other revision) are left alone.
 */
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
        if (current.kind !== "new_skill" && current.baseSha256) {
            db.prepare(`UPDATE skill_proposals SET status='superseded', updated_at_ms=?
        WHERE agent_id=? AND id!=? AND skill_path=? AND kind!='new_skill' AND base_sha256=? AND status IN ('pending','approved')`)
                .run(nowMs, input.agentId, input.id, current.skillPath, current.baseSha256);
        }
        return requireProposal(db, input.id, input.agentId);
    });
}
function isInside(root, target) {
    const rel = relative(root, target);
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
const errorCode = (error) => error?.code;
/** The deepest ancestor of `path` (or `path` itself) that exists on disk. */
function nearestExisting(path) {
    let current = path;
    while (!lstatSync(current, { throwIfNoEntry: false })) {
        const parent = dirname(current);
        if (parent === current)
            return current;
        current = parent;
    }
    return current;
}
/** Where `path` really lands: the deepest existing ancestor resolved through symlinks, plus the not-yet-created tail. */
function realLocation(path) {
    const existing = nearestExisting(path);
    return join(realpathSync(existing), relative(existing, path));
}
/** Same matching as the skills catalog: strictly under `root`, and the portable relative path matches the corpus glob. */
const matchesSource = (source, root, path) => isInside(root, path) && picomatch.isMatch(relative(root, path).split(sep).join("/"), source.pattern, { dot: false });
const validSource = (source) => typeof source.root === "string" && !!source.root.trim() && typeof source.pattern === "string" && !!source.pattern;
/**
 * The skills-corpus admission check shared by `skill-apply` and the Skills pass: `path` is a `SKILL.md` matching one
 * configured source's glob, both lexically (against the configured or canonical root) and after resolving every symlink.
 * A configured root that does not exist yet is located through its nearest existing ancestor.
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
        if (!validSource(source))
            return false;
        const root = resolve(source.root);
        let realRoot;
        try {
            realRoot = realLocation(root);
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
/**
 * Before creating any directory for a first `new_skill`: the nearest EXISTING ancestor of the target's directory must be a
 * real directory whose resolved location keeps the whole target inside a configured source root (that root may not exist
 * yet). Returns the directories `mkdir` will create, outermost first, so each new entry can be made durable.
 */
function creatableDirectories(target, sources) {
    const dir = dirname(target);
    const ancestor = nearestExisting(dir);
    const stat = statSync(ancestor, { throwIfNoEntry: false });
    if (!stat?.isDirectory())
        throw new SkillProposalError("path_outside_root", `Refusing to create ${dir}: ${ancestor} is not a directory`);
    const realTarget = join(realpathSync(ancestor), relative(ancestor, target));
    const inside = sources.some(source => {
        if (!validSource(source))
            return false;
        try {
            return matchesSource(source, realLocation(resolve(source.root)), realTarget);
        }
        catch {
            return false;
        }
    });
    if (!inside)
        throw new SkillProposalError("path_outside_root", `Refusing to create ${dir}: ${ancestor} resolves outside every configured skills source`);
    const created = [];
    for (let current = dir; current !== ancestor; current = dirname(current))
        created.unshift(current);
    return created;
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
/** `write(2)` may write fewer bytes than asked: loop until every byte landed (a zero-byte write is an error, never a spin). */
function writeAll(descriptor, bytes) {
    for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
        if (!Number.isSafeInteger(written) || written <= 0)
            throw new Error(`Short write: ${offset} of ${bytes.length} bytes`);
        offset += written;
    }
}
/** Filesystems that cannot fsync a directory (some network, FUSE and container mounts) report one of these. */
const DIR_FSYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM"]);
/**
 * Make a directory entry change (rename / link / mkdir / unlink) durable. Best-effort where the filesystem cannot fsync a
 * directory at all: the entry change itself already happened, so failing here would only strand an applied proposal.
 */
function fsyncDirectory(dir) {
    if (process.platform === "win32")
        return; // Windows cannot open a directory for fsync; NTFS journals the entry itself.
    const descriptor = openSync(dir, "r");
    try {
        fsyncSync(descriptor);
    }
    catch (error) {
        if (!DIR_FSYNC_UNSUPPORTED.has(errorCode(error) ?? ""))
            throw error;
    }
    finally {
        closeSync(descriptor);
    }
}
/** Fully written + fsynced sibling temp file; the caller links or renames it into place. Never leaves a partial temp. */
function writeTemp(target, content, mode) {
    const temp = join(dirname(target), `.${SKILL_FILE_NAME}.${randomUUID()}.tmp`);
    const descriptor = openSync(temp, "wx", mode);
    try {
        writeAll(descriptor, Buffer.from(content, "utf8"));
        fsyncSync(descriptor);
    }
    catch (error) {
        try {
            closeSync(descriptor);
        }
        catch { /* already closed */ }
        try {
            unlinkSync(temp);
        }
        catch { /* already gone */ }
        throw error;
    }
    closeSync(descriptor);
    return temp;
}
/**
 * Atomic no-clobber create: the complete file appears at `target` via `link(2)`, which fails with `EEXIST` instead of
 * replacing anything, so two concurrent creates can never overwrite each other (or an operator's hand-written file).
 * The directory entry is fsynced before returning.
 */
export function createFileExclusively(target, content, mode = 0o644) {
    const temp = writeTemp(target, content, mode);
    try {
        linkSync(temp, target);
    }
    catch (error) {
        if (errorCode(error) === "EEXIST")
            throw new SkillProposalError("target_exists", `${target} already exists`);
        throw error;
    }
    finally {
        try {
            unlinkSync(temp);
        }
        catch { /* already gone */ }
    }
    fsyncDirectory(dirname(target));
}
/** Replace `target` only while it still hashes to `expectedSha`, via temp file + rename + directory fsync. */
function replaceAtomically(target, content, mode, expectedSha) {
    const temp = writeTemp(target, content, mode);
    try {
        // Re-check right before the rename: the window for a non-cooperating editor is only this one syscall.
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
    fsyncDirectory(dirname(target));
}
/* ── Cross-process apply lock ── */
/** One lock per target directory: every proposal for one `SKILL.md` (any kind, any process) serializes on it. */
const APPLY_LOCK_NAME = `.${SKILL_FILE_NAME}.apply.lock`;
/** How long an apply waits for a busy lock (`0` = wait indefinitely). */
const DEFAULT_LOCK_WAIT_MS = 30_000;
/**
 * Age after which a lock whose owner CANNOT be checked (another host, or an unreadable/partial owner record) is broken;
 * `0` = never. A same-host owner is only ever judged by its pid: a live process's lock is never broken by age.
 */
const DEFAULT_LOCK_STALE_MS = 10 * 60_000;
const sleepSync = (ms) => { if (ms > 0)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
function lockOwner(raw) {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Stale = a same-host owner whose pid is gone (`ESRCH`). An owner this host cannot check (another host, or no readable
 * `{token,pid,host}`) is stale only past `staleMs` (`0` = never). A live same-host pid is NEVER stale, however old.
 */
function lockIsStale(raw, ageMs, staleMs) {
    const owner = lockOwner(raw);
    const checkable = owner?.host === hostname() && typeof owner.token === "string" && Number.isSafeInteger(owner.pid) && owner.pid > 0;
    if (!checkable)
        return staleMs > 0 && ageMs > staleMs;
    try {
        process.kill(owner.pid, 0);
        return false;
    }
    catch (error) {
        return errorCode(error) === "ESRCH";
    }
}
/** Write `owner` into a freshly `O_EXCL`-created file at `path`; `false` when the file already exists. */
function createOwnerFile(path, owner) {
    let descriptor;
    try {
        descriptor = openSync(path, "wx", 0o600);
    }
    catch (error) {
        if (errorCode(error) === "EEXIST")
            return false;
        throw error;
    }
    try {
        writeAll(descriptor, Buffer.from(JSON.stringify(owner)));
        fsyncSync(descriptor);
    }
    catch (error) {
        try {
            closeSync(descriptor);
        }
        catch { /* already closed */ }
        try {
            unlinkSync(path);
        }
        catch { /* already gone */ }
        throw error;
    }
    closeSync(descriptor);
    return true;
}
/** Unlink `path` only while it still holds exactly `raw` (the record judged stale / owned); `true` when it is gone. */
function unlinkIfUnchanged(path, raw) {
    let current;
    try {
        current = readFileSync(path, "utf8");
    }
    catch (error) {
        if (errorCode(error) === "ENOENT")
            return true;
        throw error;
    }
    if (current !== raw)
        return false;
    try {
        unlinkSync(path);
    }
    catch (error) {
        if (errorCode(error) !== "ENOENT")
            throw error;
    }
    return true;
}
/**
 * Break a stale lock; `true` when the lock is gone (broken here or released meanwhile), so the caller retries at once.
 * Never renames a lock aside: under an exclusive `<lock>.break` guard (one breaker at a time), the lock is re-read and
 * unlinked only if it is still the exact stale record judged — so a fresh lock taken meanwhile can never be removed.
 */
function breakStaleLock(path, staleMs, owner) {
    const read = (target) => {
        try {
            return { raw: readFileSync(target, "utf8"), ageMs: Date.now() - lstatSync(target).mtimeMs };
        }
        catch (error) {
            if (errorCode(error) === "ENOENT")
                return undefined;
            throw error;
        }
    };
    const judged = read(path);
    if (!judged)
        return true;
    if (!lockIsStale(judged.raw, judged.ageMs, staleMs))
        return false;
    const guard = `${path}.break`;
    if (!createOwnerFile(guard, owner)) {
        // Another breaker is at work. Its guard is itself freed only once its owner is provably dead (or uncheckable + old).
        const held = read(guard);
        if (held && lockIsStale(held.raw, held.ageMs, staleMs))
            unlinkIfUnchanged(guard, held.raw);
        return false;
    }
    try {
        return unlinkIfUnchanged(path, judged.raw);
    }
    finally {
        unlinkIfUnchanged(guard, JSON.stringify(owner));
    }
}
/** Acquire the per-target apply lock (an `O_EXCL` lock file holding `{token,pid,host}`); returns its release function. */
function acquireApplyLock(dir, waitMs, staleMs) {
    const path = join(dir, APPLY_LOCK_NAME);
    const owner = { token: randomUUID(), pid: process.pid, host: hostname(), acquiredAtMs: Date.now() };
    const deadline = waitMs > 0 ? Date.now() + waitMs : Infinity;
    for (let delay = 5;; delay = Math.min(delay * 2, 100)) {
        if (createOwnerFile(path, owner)) {
            // Token-verified release: a lock that is no longer ours (never expected: live owners are never broken) is left alone.
            return () => { try {
                unlinkIfUnchanged(path, JSON.stringify(owner));
            }
            catch { /* nothing of ours to remove */ } };
        }
        if (breakStaleLock(path, staleMs, owner))
            continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            throw new SkillProposalError("locked", `Another skill apply holds ${path}`);
        sleepSync(Math.min(delay, remaining));
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
function approvedProposal(db, input) {
    const current = requireProposal(db, input.id, input.agentId);
    if (current.status !== "approved")
        throw new SkillProposalError("invalid_state", `Skill proposal ${input.id} is ${current.status}, not approved`);
    assertDescriptionRoundTrip(current);
    return current;
}
function targetOf(current, input) {
    if (current.kind !== "new_skill")
        return confinedTarget(current.skillPath, input.allowedSources);
    if (!input.targetDirForNewSkills?.trim())
        throw new SkillProposalError("invalid_input", "new_skill proposals require targetDirForNewSkills");
    return confinedTarget(join(resolve(input.targetDirForNewSkills), current.skillPath), input.allowedSources);
}
/** What an apply would do to the live file right now; throws `conflict` / `target_exists` when it must not. */
function planApply(current, target) {
    const live = statSync(target, { throwIfNoEntry: false });
    const bytes = live?.isFile() ? readFileSync(target) : undefined;
    // Crash recovery: an earlier apply wrote exactly these bytes but died before recording that.
    if (bytes && sha256(bytes) === sha256(current.proposedContent))
        return { alreadyApplied: true, diff: "", mode: 0o644 };
    if (current.kind === "new_skill") {
        if (live)
            throw new SkillProposalError("target_exists", `${target} already exists`);
        return { alreadyApplied: false, diff: lineDiff("", current.proposedContent), mode: 0o644 };
    }
    if (!bytes || !live)
        throw new SkillProposalError("conflict", `${target} no longer exists`);
    if (sha256(bytes) !== current.baseSha256) {
        throw new SkillProposalError("conflict", `${target} changed since the proposal was drafted (base SHA-256 mismatch)`);
    }
    return { alreadyApplied: false, diff: lineDiff(bytes.toString("utf8"), current.proposedContent), mode: live.mode & 0o777 };
}
/**
 * Apply one operator-approved proposal: confine the target to the configured skills sources, then — under a cross-process
 * lock on the target's directory held from the approval re-check through the `applied` receipt — re-read the approval,
 * verify the live file still matches `base_sha256` (or, for `new_skill`, does not exist yet), write it completely (temp +
 * fsync + rename, or an atomic no-clobber link for `new_skill`), fsync the directory, and only then mark it `applied`.
 * Crash-safe: when the live file already holds exactly the proposed bytes (an earlier apply wrote it but died before
 * recording that), the row is marked `applied` without writing. `dryRun` previews the diff without locking, writing or
 * changing state.
 */
export function applyApprovedProposal(db, input) {
    if (!hasTable(db))
        throw new SkillProposalError("not_found", `Skill proposal ${input.id} not found`);
    const lockWaitMs = input.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS, lockStaleMs = input.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    for (const [name, value] of [["lockWaitMs", lockWaitMs], ["lockStaleMs", lockStaleMs]]) {
        if (!Number.isSafeInteger(value) || value < 0)
            throw new SkillProposalError("invalid_input", `${name} must be a non-negative integer`);
    }
    const initial = approvedProposal(db, input);
    let target = targetOf(initial, input);
    if (input.dryRun) {
        const plan = planApply(initial, target);
        return { status: "preview", proposal: initial, targetPath: target, diff: plan.diff, bytesWritten: 0 };
    }
    if (initial.kind === "new_skill") {
        const created = creatableDirectories(target, input.allowedSources);
        if (created.length) {
            mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
            for (const dir of created)
                fsyncDirectory(dirname(dir));
            // A symlink swapped in while the directories were created is caught here, before any file is written.
            target = targetOf(initial, input);
        }
    }
    // Lock order is always file lock, then SQLite write lock, so two appliers can never deadlock on each other.
    const release = acquireApplyLock(dirname(target), lockWaitMs, lockStaleMs);
    try {
        // One `BEGIN IMMEDIATE` spans the approval re-check, the base-SHA check, the file write and the `applied` receipt: no
        // other writer of this database can review, supersede or apply the row in between.
        return atomically(db, () => {
            // Under the fence: the approval, the target and the live bytes are re-read, never trusted from before the lock.
            const current = approvedProposal(db, input);
            if (targetOf(current, input) !== target)
                throw new SkillProposalError("conflict", `Skill proposal ${input.id} target changed during apply`);
            const plan = planApply(current, target);
            let bytesWritten = 0;
            if (plan.alreadyApplied)
                fsyncDirectory(dirname(target)); // the earlier writer may have died before its fsync
            else if (current.kind === "new_skill")
                createFileExclusively(target, current.proposedContent, plan.mode);
            else
                replaceAtomically(target, current.proposedContent, plan.mode, current.baseSha256);
            if (!plan.alreadyApplied)
                bytesWritten = Buffer.byteLength(current.proposedContent);
            const applied = markSkillProposalApplied(db, { id: current.id, agentId: current.agentId, appliedPath: target,
                ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }) });
            return { status: "applied", proposal: applied, targetPath: target, diff: plan.diff, bytesWritten };
        });
    }
    finally {
        release();
    }
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
/** Same frontmatter framing as the skills catalog (`manager.ts`): `---` line, YAML lines, `---` line. */
const FRONTMATTER = /^(---[ \t]*\r?\n)((?:[^\n]*\n)*?)(---[ \t]*(?:\r?\n|$))/u;
const BOM = "﻿";
const DESCRIPTION_LINE = /^description[ \t]*:/u;
/** `[bom, rest]`: a leading UTF-8 BOM is carried through every rewrite untouched. */
const splitBom = (content) => content.startsWith(BOM) ? [BOM, content.slice(1)] : ["", content];
const eolOf = (content) => content.includes("\r\n") ? "\r\n" : "\n";
/** Parsed exactly like the skills catalog does (`failsafe`: every scalar is a string, so routing reads what it sees). */
const parseFrontmatter = (source) => parseDocument(source, { schema: "failsafe" });
/** The top-level `description` pair of a parsed frontmatter document (quoted or plain key, block or flow map). */
function descriptionPair(document) {
    const contents = document.contents;
    if (!isMap(contents))
        return undefined;
    return contents.items.find(pair => isScalar(pair.key) && pair.key.value === "description");
}
function scalarText(document) {
    const value = descriptionPair(document)?.value;
    return isScalar(value) && typeof value.value === "string" ? value.value.trim() : undefined;
}
/**
 * The frontmatter `description` (plain, quoted or block scalar), or `undefined` when absent. Parsed with the same `yaml`
 * package and schema as the skills catalog; like the catalog, frontmatter that is not valid YAML (an unquoted `: ` in a
 * legacy description) falls back to the raw `description:` line.
 */
export function readSkillDescription(content) {
    const match = FRONTMATTER.exec(splitBom(content)[1]);
    if (!match)
        return undefined;
    const document = parseFrontmatter(match[2]);
    const text = scalarText(document);
    if (text !== undefined || !document.errors.length)
        return text;
    return /^description:[ \t]*(.+)$/mu.exec(match[2])?.[1]?.trim() || undefined;
}
/** Legacy fallback for frontmatter the YAML parser rejects: one past the last line of the scalar at `lines[index]`. */
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
/** Rewrite the description inside frontmatter `source` (the text between the `---` lines, including its last newline). */
function rewriteFrontmatter(source, value, newline) {
    const document = parseFrontmatter(source);
    const pair = document.errors.length ? undefined : descriptionPair(document);
    const range = isNode(pair?.value) ? pair.value.range ?? undefined : undefined;
    if (pair && range) {
        // Exact source span of the value node: the key (however quoted), comments and every other byte stay put.
        const [start, end] = range;
        const replaced = source.slice(start, end);
        const lineBreak = replaced.endsWith("\r\n") ? "\r\n" : replaced.endsWith("\n") ? "\n" : ""; // a block scalar owns its last newline
        const gap = start > 0 && source[start - 1] === ":" ? " " : "";
        return `${source.slice(0, start)}${gap}${value}${lineBreak}${source.slice(end)}`;
    }
    if (!document.errors.length && document.contents !== null && !isMap(document.contents)) {
        throw new SkillProposalError("invalid_input", "SKILL.md frontmatter is not a mapping");
    }
    if (!document.errors.length && isMap(document.contents) && document.contents.flow) {
        // A flow map (`{name: x}`) gains the key through the AST; the round-trip check below validates the result.
        document.set("description", value === "" ? "" : JSON.parse(value));
        return document.toString();
    }
    // No description yet, or legacy frontmatter the parser rejects: line-based replace (or append) of the `description` key.
    const lines = source.split(/\r?\n/u);
    if (lines.at(-1) === "")
        lines.pop();
    const line = `description: ${value}`;
    const index = lines.findIndex(text => DESCRIPTION_LINE.test(text));
    if (index < 0)
        lines.push(line);
    else
        lines.splice(index, scalarEnd(lines, index) - index, line);
    return lines.length ? `${lines.join(newline)}${newline}` : "";
}
/**
 * Replace (or add) the frontmatter `description`, leaving every other byte intact: a UTF-8 BOM and the file's line endings
 * are preserved, and the value node's exact YAML source range is replaced (quoted keys, indented or flow maps, block
 * scalars with blank lines). The value is written as a JSON string, which is a valid YAML double-quoted scalar. A file
 * without frontmatter gains one. Throws `invalid_input` unless the rewritten frontmatter parses without any YAML error
 * (e.g. `DUPLICATE_KEY`), every other key parses exactly as before, and its `description` is exactly the
 * (whitespace-normalized) proposed one.
 */
export function replaceSkillDescription(content, description, name) {
    const proposed = description.replace(/\s+/gu, " ").trim();
    const value = JSON.stringify(proposed);
    const [bom, body] = splitBom(content);
    const match = FRONTMATTER.exec(body);
    let updated, before, after;
    if (!match) {
        const eol = eolOf(body);
        after = [...(name ? [`name: ${JSON.stringify(name)}`] : []), `description: ${value}`].join(eol) + eol;
        updated = `${bom}---${eol}${after}---${eol}${eol}${body}`;
    }
    else {
        const newline = match[1].endsWith("\r\n") ? "\r\n" : "\n";
        before = match[2];
        after = rewriteFrontmatter(before, value, newline);
        updated = `${bom}${match[1]}${after}${match[3]}${body.slice(match[0].length)}`;
    }
    const document = parseFrontmatter(after);
    const fail = (why) => { throw new SkillProposalError("invalid_input", `Rewritten SKILL.md frontmatter ${why}`); };
    if (document.errors.length)
        fail(`is not valid YAML (${document.errors.map(error => error.code).join(", ")})`);
    if (scalarText(document) !== proposed || readSkillDescription(updated) !== proposed)
        fail("does not read back as the proposed description");
    if (before !== undefined) {
        const original = parseFrontmatter(before);
        if (!original.errors.length) {
            const others = (doc) => {
                const data = doc.toJS();
                if (!data || typeof data !== "object" || Array.isArray(data))
                    return {};
                const { description: _ignored, ...rest } = data;
                return rest;
            };
            if (JSON.stringify(others(original)) !== JSON.stringify(others(document)))
                fail("changed keys other than description");
        }
    }
    return updated;
}
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
/** CommonMark ATX `## Pitfalls` (≤ 3 spaces of indent: 4 is an indented code block), optional closing `#`s. */
const PITFALLS_HEADING = /^ {0,3}##[ \t]+pitfalls(?:[ \t]+#+)?[ \t]*$/iu;
const PITFALLS_SETEXT_TEXT = /^ {0,3}pitfalls[ \t]*$/iu;
/** Any level-1/2 ATX heading (including an empty `##`). */
const SECTION_HEADING = /^ {0,3}#{1,2}(?:[ \t]|$)/u;
const SETEXT_H1 = /^ {0,3}=+[ \t]*$/u;
const SETEXT_H2 = /^ {0,3}-+[ \t]*$/u;
/** Lines that can never be setext heading text: blank, ATX headings, list items, block quotes, indented code. */
const NOT_PARAGRAPH = /^(?:\s*$| {0,3}(?:#{1,6}(?:[ \t]|$)|[-+*][ \t]|\d{1,9}[.)][ \t]|>)| {4}|\t)/u;
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
/** How many leading rows (`\n`-terminated lines) the YAML frontmatter block occupies, its closing `---` included; 0 if none. */
function frontmatterRows(content) {
    const match = FRONTMATTER.exec(splitBom(content)[1]);
    if (!match)
        return 0;
    const block = match[0];
    return (block.match(/\n/gu)?.length ?? 0) + (block.endsWith("\n") ? 0 : 1);
}
/** `lines[i]` is setext heading text underlined (`===` = h1, `---` = h2) by `lines[i + 1]`, outside any fence. */
const setextAt = (lines, fenced, i) => i + 1 < lines.length && !fenced[i] && !fenced[i + 1] && !NOT_PARAGRAPH.test(lines[i]) &&
    (SETEXT_H1.test(lines[i + 1]) || SETEXT_H2.test(lines[i + 1]));
/**
 * Append bullets under the file's `## Pitfalls` section (created at the end when missing). Existing text is untouched,
 * the file's line endings are kept, and section detection follows CommonMark: a heading needs at most 3 spaces of indent
 * (4 = indented code), headings inside fenced code (``` / ~~~) are ignored, and the section ends at the next level-1/2
 * ATX heading or setext (`===` / `---` underlined) heading, so a bullet never lands inside code or the next section.
 */
export function appendSkillPitfalls(content, bullets) {
    const items = bullets.map(bullet => bullet.replace(/\s+/gu, " ").trim()).filter(Boolean).map(bullet => `- ${bullet}`);
    if (!items.length)
        return content;
    const eol = eolOf(content);
    // Each element keeps its own terminator, so untouched lines stay byte-for-byte identical.
    const rows = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
    const lines = rows.map(row => row.replace(/\r?\n$/u, ""));
    // Markdown starts strictly AFTER the YAML frontmatter's closing `---`: a `# comment` (or a ``` inside a block scalar)
    // up there is YAML, never a heading or a fence, so frontmatter rows are masked out of every scan below.
    const frontmatter = frontmatterRows(content);
    const scanned = fencedLines(lines.slice(frontmatter));
    const fenced = [...Array.from({ length: frontmatter }, () => true), ...scanned.fenced];
    const open = scanned.open && { ...scanned.open, at: scanned.open.at + frontmatter };
    let heading = -1, bodyStart = -1;
    for (let i = 0; i < lines.length && heading < 0; i++) {
        if (fenced[i])
            continue;
        if (PITFALLS_HEADING.test(lines[i])) {
            heading = i;
            bodyStart = i + 1;
        }
        else if (PITFALLS_SETEXT_TEXT.test(lines[i]) && setextAt(lines, fenced, i) && SETEXT_H2.test(lines[i + 1])) {
            heading = i;
            bodyStart = i + 2;
        }
    }
    if (heading < 0) {
        // An unclosed fence runs to the end of the file: close it first so the new section is never code.
        const body = `${content.replace(/\s+$/u, "")}${open ? `${eol}${open.marker}` : ""}`;
        return `${body}${eol}${eol}## Pitfalls${eol}${eol}${items.join(eol)}${eol}`;
    }
    let end = bodyStart;
    while (end < lines.length && (fenced[end] || !(SECTION_HEADING.test(lines[end]) || setextAt(lines, fenced, end))))
        end++;
    // A fence left open inside the section swallows the rest of the file: insert before it.
    if (open && open.at >= bodyStart && open.at < end)
        end = open.at;
    let insert = end;
    while (insert > bodyStart && lines[insert - 1].trim() === "")
        insert--;
    const before = rows.slice(0, insert), after = rows.slice(insert);
    if (before.length && !before.at(-1).endsWith("\n"))
        before[before.length - 1] += eol;
    const spacer = insert === bodyStart ? [eol] : [];
    const added = items.map((item, i) => i === items.length - 1 && !after.length && !content.endsWith("\n") ? item : `${item}${eol}`);
    return [...before, ...spacer, ...added, ...after].join("");
}
