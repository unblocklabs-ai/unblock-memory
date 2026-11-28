import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs, { existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  appendSkillPitfalls, applyApprovedProposal, createFileExclusively, ensureSkillProposalsSchema, isAdmittedSkillPath, getSkillProposal, listSkillProposals, markSkillProposalApplied,
  readSkillDescription, replaceSkillDescription, reviewSkillProposal, sha256, SkillProposalError, summarizeSkillProposals,
  upsertSkillProposal, withReadOnlySkillProposals, type SkillProposalInput, type SkillReplayMetrics,
} from "../src/skill-proposals-store.js";

const AGENT = "main";
const NOW = Date.parse("2026-11-27T19:00:00Z");
const SKILL = `---\nname: deploy\ndescription: Deploy services to staging\n---\n\n# Deploy\n\n1. Run the deploy script.\n`;

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  // Resolve the tmp root through symlinks (macOS /var -> /private/var) so containment checks see real paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skill-proposals-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skillsDir = join(root, "skills");
  const skillPath = join(skillsDir, "deploy", "SKILL.md");
  mkdirSync(join(skillsDir, "deploy"), { recursive: true });
  writeFileSync(skillPath, SKILL);
  return { db, root, skillsDir, skillPath };
}

// The skills corpus every apply here is confined to: every SKILL.md under the root.
const sources = (root: string, pattern = "**/SKILL.md") => [{ root, pattern }];

const metrics = (gain: number, falseDelta = 0, regressions = 0): SkillReplayMetrics => ({
  baselineRecall: 0.5, candidateRecall: 0.5 + gain / 100, recallGainPp: gain, baselineFalseActivation: 0,
  candidateFalseActivation: falseDelta / 100, falseActivationDeltaPp: falseDelta, criticalRegressions: regressions, samplesEvaluated: 20,
});

function descriptionInput(skillPath: string, description: string, patch: Partial<SkillProposalInput> = {}): SkillProposalInput {
  return { agentId: AGENT, kind: "description_update", skillName: "deploy", skillPath, title: "Sharpen deploy",
    rationale: "Missed release prompts", baseDescription: "Deploy services to staging", proposedDescription: description,
    proposedContent: replaceSkillDescription(SKILL, description), baseSha256: sha256(SKILL), replayMetrics: metrics(20),
    evidence: { inputDigest: "d1" }, nowMs: NOW, ...patch };
}

test("state machine: pending -> approved -> applied, pending -> rejected, illegal transitions throw", t => {
  const { db, skillPath } = fixture(t);
  const first = upsertSkillProposal(db, descriptionInput(skillPath, "Ship releases to production"));
  assert.equal(first.action, "inserted");
  assert.equal(first.proposal.status, "pending");
  assert.deepEqual(first.proposal.replayMetrics, metrics(20));

  assert.throws(() => markSkillProposalApplied(db, { id: first.proposal.id, agentId: AGENT, appliedPath: skillPath }),
    (error: unknown) => error instanceof SkillProposalError && error.code === "invalid_state");
  const approved = reviewSkillProposal(db, { id: first.proposal.id, agentId: AGENT, decision: "approved", reviewedBy: "bek", note: "lgtm", nowMs: NOW + 1 });
  assert.equal(approved.status, "approved");
  assert.equal(approved.reviewedBy, "bek");
  assert.equal(approved.reviewedAtMs, NOW + 1);
  assert.throws(() => reviewSkillProposal(db, { id: first.proposal.id, agentId: AGENT, decision: "rejected" }),
    (error: unknown) => error instanceof SkillProposalError && error.code === "invalid_state");
  const applied = markSkillProposalApplied(db, { id: first.proposal.id, agentId: AGENT, appliedPath: skillPath, nowMs: NOW + 2 });
  assert.equal(applied.status, "applied");
  assert.equal(applied.appliedPath, skillPath);

  const other = upsertSkillProposal(db, descriptionInput(skillPath, "Something else entirely", { baseSha256: sha256("v2") }));
  const rejected = reviewSkillProposal(db, { id: other.proposal.id, agentId: AGENT, decision: "rejected", note: "too vague" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reviewNote, "too vague");
  assert.throws(() => reviewSkillProposal(db, { id: "missing", agentId: AGENT, decision: "approved" }),
    (error: unknown) => error instanceof SkillProposalError && error.code === "not_found");
  // Agent scoping: another agent cannot review this agent's proposal.
  assert.equal(getSkillProposal(db, other.proposal.id, "someone-else"), undefined);
});

test("upsert deduplicates, supersedes older pending proposals, keeps a strictly better one, and honors reviews", t => {
  const { db, skillPath } = fixture(t);
  const a = upsertSkillProposal(db, descriptionInput(skillPath, "Ship releases to production"));
  const again = upsertSkillProposal(db, descriptionInput(skillPath, "Ship releases to production", { rationale: "rerun" }));
  assert.equal(again.action, "unchanged");
  assert.equal(again.proposal.id, a.proposal.id);

  // A worse candidate for the same live revision does not displace the better pending one.
  const worse = upsertSkillProposal(db, descriptionInput(skillPath, "Ship stuff", { replayMetrics: metrics(5) }));
  assert.equal(worse.action, "kept_existing");
  assert.equal(worse.proposal.id, a.proposal.id);

  const better = upsertSkillProposal(db, descriptionInput(skillPath, "Ship and verify releases", { replayMetrics: metrics(30) }));
  assert.equal(better.action, "inserted");
  assert.deepEqual(better.superseded, [a.proposal.id]);
  assert.equal(getSkillProposal(db, a.proposal.id, AGENT)?.status, "superseded");

  // An approved proposal is never superseded by a background pass.
  reviewSkillProposal(db, { id: better.proposal.id, agentId: AGENT, decision: "approved" });
  const later = upsertSkillProposal(db, descriptionInput(skillPath, "Yet another phrasing", { replayMetrics: metrics(40) }));
  assert.deepEqual(later.superseded, []);
  assert.equal(getSkillProposal(db, better.proposal.id, AGENT)?.status, "approved");

  // An operator-rejected proposal is not re-raised.
  reviewSkillProposal(db, { id: later.proposal.id, agentId: AGENT, decision: "rejected" });
  const reraised = upsertSkillProposal(db, descriptionInput(skillPath, "Yet another phrasing", { replayMetrics: metrics(40) }));
  assert.equal(reraised.action, "previously_reviewed");
  assert.equal(listSkillProposals(db, { agentId: AGENT, status: "pending" }).length, 0);

  const summary = summarizeSkillProposals(db, AGENT);
  assert.equal(summary.total, 3);
  assert.deepEqual([summary.byStatus.superseded, summary.byStatus.approved, summary.byStatus.rejected], [1, 1, 1]);
  assert.equal(summary.byKind.description_update, 3);
});

test("upsert validates inputs: base SHA for edits, relative <name>/SKILL.md for new skills", t => {
  const { db, skillPath } = fixture(t);
  const invalid = (error: unknown) => error instanceof SkillProposalError && error.code === "invalid_input";
  assert.throws(() => upsertSkillProposal(db, descriptionInput(skillPath, "x", { baseSha256: null })), invalid);
  assert.throws(() => upsertSkillProposal(db, descriptionInput("relative/SKILL.md", "x")), invalid);
  assert.throws(() => upsertSkillProposal(db, descriptionInput(skillPath.replace("SKILL.md", "README.md"), "x")), invalid);
  const base = { agentId: AGENT, kind: "new_skill" as const, skillName: "x", title: "t", rationale: "r", proposedContent: "---\nname: x\n---\n" };
  assert.throws(() => upsertSkillProposal(db, { ...base, skillPath: "../escape/SKILL.md" }), invalid);
  assert.throws(() => upsertSkillProposal(db, { ...base, skillPath: "/abs/SKILL.md" }), invalid);
});

test("applyApprovedProposal blocks path traversal, symlink escapes and non-SKILL.md targets", t => {
  const { db, root, skillsDir, skillPath } = fixture(t);
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "SKILL.md"), SKILL);
  const outsideCode = (error: unknown) => error instanceof SkillProposalError && error.code === "path_outside_root";

  // `..` escape: lexically outside the root.
  const traversal = upsertSkillProposal(db, descriptionInput(join(skillsDir, "..", "outside", "SKILL.md"), "Escape attempt"));
  reviewSkillProposal(db, { id: traversal.proposal.id, agentId: AGENT, decision: "approved" });
  assert.throws(() => applyApprovedProposal(db, { id: traversal.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) }), outsideCode);

  // Symlinked directory inside the root that points outside it.
  symlinkSync(outside, join(skillsDir, "linked"));
  const linked = upsertSkillProposal(db, descriptionInput(join(skillsDir, "linked", "SKILL.md"), "Through a symlink"));
  reviewSkillProposal(db, { id: linked.proposal.id, agentId: AGENT, decision: "approved" });
  assert.throws(() => applyApprovedProposal(db, { id: linked.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) }), outsideCode);

  // No roots at all is never "allow everything".
  const legit = upsertSkillProposal(db, descriptionInput(skillPath, "Ship releases to production"));
  reviewSkillProposal(db, { id: legit.proposal.id, agentId: AGENT, decision: "approved" });
  assert.throws(() => applyApprovedProposal(db, { id: legit.proposal.id, agentId: AGENT, allowedSources: [] }), outsideCode);

  // New skill whose target dir sits outside every allowed root.
  const fresh = upsertSkillProposal(db, { agentId: AGENT, kind: "new_skill", skillName: "release-checklist", skillPath: "release-checklist/SKILL.md",
    title: "New", rationale: "r", proposedContent: "---\nname: \"release-checklist\"\ndescription: \"d\"\n---\n" });
  reviewSkillProposal(db, { id: fresh.proposal.id, agentId: AGENT, decision: "approved" });
  assert.throws(() => applyApprovedProposal(db, { id: fresh.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), targetDirForNewSkills: outside }), outsideCode);

  assert.equal(readFileSync(join(outside, "SKILL.md"), "utf8"), SKILL, "nothing outside the root was written");
  for (const id of [traversal.proposal.id, linked.proposal.id, legit.proposal.id, fresh.proposal.id]) {
    assert.equal(getSkillProposal(db, id, AGENT)?.status, "approved");
  }
});

test("applyApprovedProposal refuses unapproved rows and a live file that changed since the proposal (base SHA-256 conflict)", t => {
  const { db, skillsDir, skillPath } = fixture(t);
  const pending = upsertSkillProposal(db, descriptionInput(skillPath, "Ship releases to production"));
  assert.throws(() => applyApprovedProposal(db, { id: pending.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) }),
    (error: unknown) => error instanceof SkillProposalError && error.code === "invalid_state");
  reviewSkillProposal(db, { id: pending.proposal.id, agentId: AGENT, decision: "approved" });
  const edited = `${SKILL}\nAn operator edit.\n`;
  writeFileSync(skillPath, edited);
  assert.throws(() => applyApprovedProposal(db, { id: pending.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) }),
    (error: unknown) => error instanceof SkillProposalError && error.code === "conflict");
  assert.throws(() => applyApprovedProposal(db, { id: pending.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), dryRun: true }),
    (error: unknown) => error instanceof SkillProposalError && error.code === "conflict");
  assert.equal(readFileSync(skillPath, "utf8"), edited, "the operator's edit survives");
  assert.equal(getSkillProposal(db, pending.proposal.id, AGENT)?.status, "approved");
});

test("dryRun previews the diff without writing or changing state", t => {
  const { db, skillsDir, skillPath } = fixture(t);
  const { proposal } = upsertSkillProposal(db, descriptionInput(skillPath, "Ship releases to production"));
  reviewSkillProposal(db, { id: proposal.id, agentId: AGENT, decision: "approved" });
  const preview = applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), dryRun: true });
  assert.equal(preview.status, "preview");
  assert.equal(preview.bytesWritten, 0);
  assert.match(preview.diff, /^-description: Deploy services to staging$/mu);
  assert.match(preview.diff, /^\+description: "Ship releases to production"$/mu);
  assert.equal(readFileSync(skillPath, "utf8"), SKILL);
  assert.equal(getSkillProposal(db, proposal.id, AGENT)?.status, "approved");
});

test("applyApprovedProposal writes all three kinds atomically and marks them applied", t => {
  const { db, skillsDir, skillPath } = fixture(t);
  const tempFiles = (dir: string) => readdirSync(dir).filter(name => name.endsWith(".tmp"));

  // description_update
  const description = upsertSkillProposal(db, descriptionInput(skillPath, "Ship releases to production"));
  reviewSkillProposal(db, { id: description.proposal.id, agentId: AGENT, decision: "approved" });
  // A sibling pitfall drafted against the same base becomes stale once the description lands.
  const staleSibling = upsertSkillProposal(db, { agentId: AGENT, kind: "pitfall_patch", skillName: "deploy", skillPath, title: "p", rationale: "r",
    proposedContent: appendSkillPitfalls(SKILL, ["Old base pitfall"]), baseSha256: sha256(SKILL) });
  const applied = applyApprovedProposal(db, { id: description.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), nowMs: NOW + 5 });
  assert.equal(applied.status, "applied");
  assert.equal(applied.proposal.status, "applied");
  assert.equal(applied.proposal.appliedAtMs, NOW + 5);
  const afterDescription = readFileSync(skillPath, "utf8");
  assert.equal(readSkillDescription(afterDescription), "Ship releases to production");
  assert.equal(afterDescription.replace(/^description:.*$/mu, ""), SKILL.replace(/^description:.*$/mu, ""), "only the description line changed");
  assert.equal(getSkillProposal(db, staleSibling.proposal.id, AGENT)?.status, "superseded");
  assert.deepEqual(tempFiles(join(skillsDir, "deploy")), []);

  // pitfall_patch against the new live revision
  const pitfall = upsertSkillProposal(db, { agentId: AGENT, kind: "pitfall_patch", skillName: "deploy", skillPath, title: "Add pitfall",
    rationale: "Hurt twice", proposedContent: appendSkillPitfalls(afterDescription, ["When the canary fails, roll back before retrying."]),
    baseSha256: sha256(afterDescription), evidence: { evidenceIds: ["outcome:o1"] } });
  reviewSkillProposal(db, { id: pitfall.proposal.id, agentId: AGENT, decision: "approved" });
  applyApprovedProposal(db, { id: pitfall.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) });
  const afterPitfall = readFileSync(skillPath, "utf8");
  assert.ok(afterPitfall.startsWith(afterDescription.trimEnd()));
  assert.match(afterPitfall, /## Pitfalls\n\n- When the canary fails, roll back before retrying\.\n$/u);

  // new_skill
  const content = "---\nname: \"release-checklist\"\ndescription: \"Run the release checklist\"\n---\n\n# Release checklist\n";
  const fresh = upsertSkillProposal(db, { agentId: AGENT, kind: "new_skill", skillName: "release-checklist", skillPath: "release-checklist/SKILL.md",
    title: "New skill", rationale: "Recurring procedure", proposedDescription: "Run the release checklist", proposedContent: content });
  reviewSkillProposal(db, { id: fresh.proposal.id, agentId: AGENT, decision: "approved" });
  assert.throws(() => applyApprovedProposal(db, { id: fresh.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) }),
    (error: unknown) => error instanceof SkillProposalError && error.code === "invalid_input");
  const created = applyApprovedProposal(db, { id: fresh.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), targetDirForNewSkills: skillsDir });
  assert.equal(created.targetPath, join(skillsDir, "release-checklist", "SKILL.md"));
  assert.equal(readFileSync(created.targetPath, "utf8"), content);
  assert.equal(created.proposal.status, "applied");

  // A second new_skill for an existing target never overwrites it.
  const dup = upsertSkillProposal(db, { agentId: AGENT, kind: "new_skill", skillName: "release-checklist", skillPath: "release-checklist/SKILL.md",
    title: "Dup", rationale: "r", proposedContent: `${content}\nmore\n` });
  reviewSkillProposal(db, { id: dup.proposal.id, agentId: AGENT, decision: "approved" });
  assert.throws(() => applyApprovedProposal(db, { id: dup.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), targetDirForNewSkills: skillsDir }),
    (error: unknown) => error instanceof SkillProposalError && error.code === "target_exists");
  assert.equal(readFileSync(created.targetPath, "utf8"), content);
  assert.deepEqual(tempFiles(join(skillsDir, "release-checklist")), []);
});

test("read helpers tolerate a missing table and a missing database file", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  assert.deepEqual(listSkillProposals(db, { agentId: AGENT }), []);
  assert.equal(getSkillProposal(db, "x", AGENT), undefined);
  const summary = summarizeSkillProposals(db, AGENT);
  assert.equal(summary.total, 0);
  assert.equal(summary.oldestPendingAtMs, null);
  assert.equal(withReadOnlySkillProposals(join(tmpdir(), "does-not-exist", "x.sqlite"), "fallback", () => "ran"), "fallback");
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema").get()?.n, 0, "reads never create tables");
  ensureSkillProposalsSchema(db);
  ensureSkillProposalsSchema(db);
  assert.equal(db.prepare("SELECT version FROM memory_schema WHERE component='skill_proposals'").get()?.version, 1);
});

test("SKILL.md helpers replace only the description and append pitfalls under one section", () => {
  const folded = "---\nname: x\ndescription: >\n  Folded line one\n  and two\nlicense: MIT\n---\nBody\n";
  assert.equal(readSkillDescription(folded), "Folded line one and two");
  const replaced = replaceSkillDescription(folded, "New: \"quoted\" text");
  assert.equal(replaced, "---\nname: x\ndescription: \"New: \\\"quoted\\\" text\"\nlicense: MIT\n---\nBody\n");
  assert.equal(readSkillDescription(replaced), "New: \"quoted\" text");
  assert.equal(replaceSkillDescription("# No frontmatter\n", "Desc", "x"), "---\nname: \"x\"\ndescription: \"Desc\"\n---\n\n# No frontmatter\n");

  const existing = "# S\n\n## Pitfalls\n\n- Old one\n\n## Next\n\nText\n";
  assert.equal(appendSkillPitfalls(existing, ["New one"]), "# S\n\n## Pitfalls\n\n- Old one\n- New one\n\n## Next\n\nText\n");
  assert.equal(appendSkillPitfalls("# S\n", ["A"]), "# S\n\n## Pitfalls\n\n- A\n");
});

/* ───────────────────────────── Step 4 review fixes ───────────────────────────── */

const code = (expected: string) => (error: unknown) => error instanceof SkillProposalError && error.code === expected;

test("replaceSkillDescription preserves a UTF-8 BOM and CRLF line endings, with or without frontmatter", () => {
  const bom = "\uFEFF---\r\nname: x\r\ndescription: Old\r\n---\r\n\r\nBody\r\n";
  assert.equal(readSkillDescription(bom), "Old", "a BOM never hides the frontmatter");
  assert.equal(replaceSkillDescription(bom, "New desc"), "\uFEFF---\r\nname: x\r\ndescription: \"New desc\"\r\n---\r\n\r\nBody\r\n");
  assert.equal(replaceSkillDescription("\uFEFF# Title\r\n", "D", "x"), "\uFEFF---\r\nname: \"x\"\r\ndescription: \"D\"\r\n---\r\n\r\n# Title\r\n");
});

test("replaceSkillDescription replaces a | / > block scalar whole, including blank lines inside it", () => {
  for (const style of ["|", ">-"]) {
    const content = `---\nname: x\ndescription: ${style}\n  First paragraph\n  continues here.\n\n  Second paragraph.\nlicense: MIT\n---\nBody\n`;
    assert.equal(readSkillDescription(content), style === "|" ? "First paragraph\ncontinues here.\n\nSecond paragraph."
      : "First paragraph continues here.\nSecond paragraph.");
    const replaced = replaceSkillDescription(content, "Sharper");
    assert.equal(replaced, "---\nname: x\ndescription: \"Sharper\"\nlicense: MIT\n---\nBody\n", `${style}: no orphaned block lines remain`);
    assert.equal(readSkillDescription(replaced), "Sharper");
  }
  // Trailing blank lines after the scalar belong to the document, not the description.
  assert.equal(replaceSkillDescription("---\ndescription: |\n  a\n\nname: x\n---\n", "b"), "---\ndescription: \"b\"\n\nname: x\n---\n");
});

test("applyApprovedProposal refuses a description_update whose content does not round-trip to its proposed description", t => {
  const { db, skillsDir, skillPath } = fixture(t);
  const { proposal } = upsertSkillProposal(db, descriptionInput(skillPath, "Reviewed description",
    { proposedContent: replaceSkillDescription(SKILL, "Something else entirely") }));
  reviewSkillProposal(db, { id: proposal.id, agentId: AGENT, decision: "approved" });
  for (const dryRun of [true, false]) {
    assert.throws(() => applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), dryRun }), code("invalid_input"));
  }
  assert.equal(readFileSync(skillPath, "utf8"), SKILL);
  assert.equal(getSkillProposal(db, proposal.id, AGENT)?.status, "approved");
});

test("appendSkillPitfalls never lands bullets inside ``` or ~~~ fenced code and keeps CRLF", () => {
  // A `## Pitfalls` line inside a fence is code, not the section.
  const fakeHeading = "# S\n\n```md\n## Pitfalls\n```\n";
  assert.equal(appendSkillPitfalls(fakeHeading, ["A"]), "# S\n\n```md\n## Pitfalls\n```\n\n## Pitfalls\n\n- A\n");
  // A heading inside a fence does not end the section early; bullets go after the fence, at the real section end.
  const fencedInside = "## Pitfalls\n\n- Old\n\n~~~sh\n## not a heading\necho hi\n~~~\n\n## Next\n";
  assert.equal(appendSkillPitfalls(fencedInside, ["New"]), "## Pitfalls\n\n- Old\n\n~~~sh\n## not a heading\necho hi\n~~~\n- New\n\n## Next\n");
  // An unclosed fence in the section swallows the rest of the file: bullets go before it.
  assert.equal(appendSkillPitfalls("## Pitfalls\n\n- Old\n```\ncode\n", ["New"]), "## Pitfalls\n\n- Old\n- New\n```\ncode\n");
  // An unclosed fence with no section is closed before the new section.
  assert.equal(appendSkillPitfalls("# S\n````\ncode\n", ["A"]), "# S\n````\ncode\n````\n\n## Pitfalls\n\n- A\n");
  // CRLF files stay CRLF, byte-for-byte outside the insertion.
  assert.equal(appendSkillPitfalls("# S\r\n\r\n## Pitfalls\r\n\r\n- Old\r\n", ["New"]), "# S\r\n\r\n## Pitfalls\r\n\r\n- Old\r\n- New\r\n");
  assert.equal(appendSkillPitfalls("# S\r\n", ["A"]), "# S\r\n\r\n## Pitfalls\r\n\r\n- A\r\n");
});

test("applyApprovedProposal is crash-safe: a live file already holding the proposed bytes is marked applied without a write", t => {
  const { db, skillsDir, skillPath } = fixture(t);
  const input = descriptionInput(skillPath, "Ship releases to production");
  const { proposal } = upsertSkillProposal(db, input);
  reviewSkillProposal(db, { id: proposal.id, agentId: AGENT, decision: "approved" });
  writeFileSync(skillPath, input.proposedContent); // an earlier apply wrote the file, then died before marking the row
  const preview = applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), dryRun: true });
  assert.deepEqual([preview.status, preview.diff], ["preview", ""]);
  const recovered = applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) });
  assert.deepEqual([recovered.status, recovered.proposal.status, recovered.bytesWritten], ["applied", "applied", 0]);

  const content = "---\nname: \"rollback\"\ndescription: \"Roll back\"\n---\n";
  const fresh = upsertSkillProposal(db, { agentId: AGENT, kind: "new_skill", skillName: "rollback", skillPath: "rollback/SKILL.md",
    title: "New", rationale: "r", proposedContent: content });
  reviewSkillProposal(db, { id: fresh.proposal.id, agentId: AGENT, decision: "approved" });
  mkdirSync(join(skillsDir, "rollback"));
  writeFileSync(join(skillsDir, "rollback", "SKILL.md"), content);
  assert.equal(applyApprovedProposal(db, { id: fresh.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir),
    targetDirForNewSkills: skillsDir }).proposal.status, "applied");
});

test("new_skill creation is an atomic no-clobber create: a file that appears first is never overwritten", t => {
  const { db, skillsDir } = fixture(t);
  const target = join(skillsDir, "race", "SKILL.md");
  mkdirSync(join(skillsDir, "race"));
  writeFileSync(target, "operator wrote this first\n");
  assert.throws(() => createFileExclusively(target, "steward draft\n"), code("target_exists"));
  assert.equal(readFileSync(target, "utf8"), "operator wrote this first\n");
  assert.deepEqual(readdirSync(join(skillsDir, "race")), ["SKILL.md"], "no temp file is left behind");

  // Through the apply path: the preview saw no file, then a concurrent writer created it before the apply.
  const fresh = upsertSkillProposal(db, { agentId: AGENT, kind: "new_skill", skillName: "late", skillPath: "late/SKILL.md",
    title: "New", rationale: "r", proposedContent: "steward draft\n" });
  reviewSkillProposal(db, { id: fresh.proposal.id, agentId: AGENT, decision: "approved" });
  const apply = (dryRun: boolean) => applyApprovedProposal(db, { id: fresh.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir),
    targetDirForNewSkills: skillsDir, dryRun });
  assert.equal(apply(true).status, "preview");
  mkdirSync(join(skillsDir, "late"));
  writeFileSync(join(skillsDir, "late", "SKILL.md"), "concurrent\n");
  assert.throws(() => apply(false), code("target_exists"));
  assert.equal(readFileSync(join(skillsDir, "late", "SKILL.md"), "utf8"), "concurrent\n");
  assert.equal(getSkillProposal(db, fresh.proposal.id, AGENT)?.status, "approved");
});

test("open-proposal dedup includes skill_path and base_sha256, so a stale-base twin never strands a fresh draft", t => {
  const { db, skillPath } = fixture(t);
  const stale = upsertSkillProposal(db, descriptionInput(skillPath, "Ship releases"));
  reviewSkillProposal(db, { id: stale.proposal.id, agentId: AGENT, decision: "approved" });
  assert.equal(upsertSkillProposal(db, descriptionInput(skillPath, "Ship releases")).action, "unchanged", "same file revision = same proposal");
  // The live file moved on (e.g. an unrelated edit): the same content re-drafted against the new base is a new proposal.
  const rebased = upsertSkillProposal(db, descriptionInput(skillPath, "Ship releases", { baseSha256: sha256("edited") }));
  assert.equal(rebased.action, "inserted");
  assert.equal(rebased.proposal.baseSha256, sha256("edited"));
  // Same content for a different file is a different proposal too.
  const other = join(skillPath, "..", "..", "other", "SKILL.md");
  assert.equal(upsertSkillProposal(db, descriptionInput(other, "Ship releases")).action, "inserted");
  // An operator rejection stays final whatever the base.
  const rejected = upsertSkillProposal(db, descriptionInput(skillPath, "Rejected idea"));
  reviewSkillProposal(db, { id: rejected.proposal.id, agentId: AGENT, decision: "rejected" });
  assert.equal(upsertSkillProposal(db, descriptionInput(skillPath, "Rejected idea", { baseSha256: sha256("edited") })).action, "previously_reviewed");
  // ...but only for that file: the same rejected/applied content for a different SKILL.md is a fresh proposal.
  assert.equal(upsertSkillProposal(db, descriptionInput(other, "Rejected idea")).action, "inserted", "a rejection is scoped to its file");
  const appliedHere = upsertSkillProposal(db, descriptionInput(skillPath, "Applied idea"));
  reviewSkillProposal(db, { id: appliedHere.proposal.id, agentId: AGENT, decision: "approved" });
  markSkillProposalApplied(db, { id: appliedHere.proposal.id, agentId: AGENT, appliedPath: skillPath });
  assert.equal(upsertSkillProposal(db, descriptionInput(skillPath, "Applied idea")).action, "previously_reviewed");
  assert.equal(upsertSkillProposal(db, descriptionInput(other, "Applied idea")).action, "inserted", "an apply is scoped to its file");
});

test("skill-apply targets must match a configured source pattern and stay inside its real root", t => {
  const { db, root, skillsDir, skillPath } = fixture(t);
  mkdirSync(join(skillsDir, "deep", "nested"), { recursive: true });
  writeFileSync(join(skillsDir, "deep", "nested", "SKILL.md"), SKILL);
  const shallow = sources(skillsDir, "*/SKILL.md");
  assert.equal(isAdmittedSkillPath(skillPath, shallow), true);
  assert.equal(isAdmittedSkillPath(join(skillsDir, "deep", "nested", "SKILL.md"), shallow), false, "under the root but not matching the glob");
  assert.equal(isAdmittedSkillPath(join(skillsDir, ".hidden", "SKILL.md"), sources(skillsDir)), false, "dot paths are not catalog skills");
  const nested = upsertSkillProposal(db, descriptionInput(join(skillsDir, "deep", "nested", "SKILL.md"), "Nested"));
  reviewSkillProposal(db, { id: nested.proposal.id, agentId: AGENT, decision: "approved" });
  assert.throws(() => applyApprovedProposal(db, { id: nested.proposal.id, agentId: AGENT, allowedSources: shallow }), code("path_outside_root"));

  // A symlinked skill directory that matches the glob but resolves outside the root.
  const outside = join(root, "outside", "evil");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "SKILL.md"), SKILL);
  symlinkSync(outside, join(skillsDir, "evil"));
  assert.equal(isAdmittedSkillPath(join(skillsDir, "evil", "SKILL.md"), shallow), false);
  const escaped = upsertSkillProposal(db, descriptionInput(join(skillsDir, "evil", "SKILL.md"), "Escape"));
  reviewSkillProposal(db, { id: escaped.proposal.id, agentId: AGENT, decision: "approved" });
  assert.throws(() => applyApprovedProposal(db, { id: escaped.proposal.id, agentId: AGENT, allowedSources: shallow }), code("path_outside_root"));
  assert.equal(readFileSync(join(outside, "SKILL.md"), "utf8"), SKILL);
});

/* ───────────────────────────── Round 1 review fixes (apply fence, YAML, CommonMark) ───────────────────────────── */

const LOCK = ".SKILL.md.apply.lock";
const approvedDescription = (db: DatabaseSync, skillPath: string, description = "Ship releases to production") => {
  const { proposal } = upsertSkillProposal(db, descriptionInput(skillPath, description));
  reviewSkillProposal(db, { id: proposal.id, agentId: AGENT, decision: "approved" });
  return proposal;
};
/** Swap one `node:fs` function for the duration of a test (named ESM imports in the store see it via syncBuiltinESMExports). */
type AnyFn = (...args: any[]) => any;
function mockFs(t: TestContext, name: "writeSync" | "fsyncSync", impl: (original: AnyFn, ...args: any[]) => unknown) {
  const original = (fs[name] as AnyFn).bind(fs);
  const mock = t.mock.method(fs, name, ((...args: unknown[]) => impl(original, ...args)) as never);
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

test("apply writes every byte through short writes, and fsyncs the directory before the applied receipt", t => {
  const { db, skillsDir, skillPath } = fixture(t);
  const proposal = approvedDescription(db, skillPath);
  const events: string[] = [];
  db.function("note_applied", () => { events.push("applied"); return null; });
  db.exec(`CREATE TRIGGER note_applied AFTER UPDATE OF status ON skill_proposals WHEN new.status='applied' BEGIN SELECT note_applied(); END`);
  mockFs(t, "writeSync", (original, fd, buffer, offset, length) => original(fd, buffer, offset, Math.min(Number(length), 3)));
  mockFs(t, "fsyncSync", (original, fd) => { events.push(fstatSync(fd).isDirectory() ? "dir" : "file"); return original(fd); });
  const applied = applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) });
  const expected = replaceSkillDescription(SKILL, "Ship releases to production");
  assert.equal(readFileSync(skillPath, "utf8"), expected, "3-byte writes still land the whole file");
  assert.equal(applied.bytesWritten, Buffer.byteLength(expected));
  assert.ok(events.indexOf("dir") >= 0 && events.indexOf("dir") < events.indexOf("applied"), `directory fsync precedes the receipt: ${events}`);
  assert.deepEqual(readdirSync(join(skillsDir, "deploy")).sort(), ["SKILL.md"], "no temp or lock file is left behind");
});

test("a failed or zero-byte write unlinks the temp file and leaves the live file and the approval untouched", t => {
  for (const failure of ["throw", "zero"] as const) {
    const { db, skillsDir, skillPath } = fixture(t);
    const proposal = approvedDescription(db, skillPath);
    let calls = 0;
    const original = fs.writeSync.bind(fs) as (...a: unknown[]) => number;
    const restore = t.mock.method(fs, "writeSync", ((...args: unknown[]) => {
      // The first write is the lock file; fail the temp file's write.
      if (++calls === 1) return original(...args);
      if (failure === "throw") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return 0;
    }) as typeof fs.writeSync);
    syncBuiltinESMExports();
    try {
      assert.throws(() => applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) }),
        failure === "throw" ? /disk full/u : /Short write/u);
    } finally { restore.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(readFileSync(skillPath, "utf8"), SKILL);
    assert.deepEqual(readdirSync(join(skillsDir, "deploy")), ["SKILL.md"], `${failure}: temp and lock files are removed`);
    assert.equal(getSkillProposal(db, proposal.id, AGENT)?.status, "approved");
  }
});

test("apply waits on another live holder's lock and fails `locked` without touching the file", t => {
  const { db, skillsDir, skillPath } = fixture(t);
  const proposal = approvedDescription(db, skillPath);
  const lock = join(skillsDir, "deploy", LOCK);
  const held = JSON.stringify({ token: "other", pid: process.pid, host: hostname(), acquiredAtMs: Date.now() });
  writeFileSync(lock, held);
  const started = Date.now();
  assert.throws(() => applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), lockWaitMs: 60 }), code("locked"));
  assert.ok(Date.now() - started >= 50, "it waited before giving up");
  assert.equal(readFileSync(skillPath, "utf8"), SKILL);
  assert.equal(readFileSync(lock, "utf8"), held, "a live holder's lock is never broken");
  assert.equal(getSkillProposal(db, proposal.id, AGENT)?.status, "approved");
  // A live same-host owner is never evicted by age, whatever lockStaleMs says.
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(lock, old, old);
  for (const lockStaleMs of [0, 1, undefined]) {
    assert.throws(() => applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), lockWaitMs: 20,
      ...(lockStaleMs === undefined ? {} : { lockStaleMs }) }), code("locked"), `lockStaleMs=${lockStaleMs}`);
    assert.equal(readFileSync(lock, "utf8"), held, "an hour-old live lock is still intact");
  }
  assert.equal(readFileSync(skillPath, "utf8"), SKILL);
});

test("a lock this host cannot check (another host, or no readable owner) is broken only once older than lockStaleMs", t => {
  for (const held of [JSON.stringify({ token: "remote", pid: 1, host: `not-${hostname()}`, acquiredAtMs: Date.now() }), "{partial"]) {
    const { db, skillsDir, skillPath } = fixture(t);
    const proposal = approvedDescription(db, skillPath);
    const lock = join(skillsDir, "deploy", LOCK);
    writeFileSync(lock, held);
    assert.throws(() => applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), lockWaitMs: 20 }),
      code("locked"), "a fresh uncheckable lock is respected");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lock, old, old);
    assert.throws(() => applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), lockWaitMs: 20,
      lockStaleMs: 0 }), code("locked"), "lockStaleMs 0 never breaks by age");
    assert.equal(applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) }).proposal.status, "applied");
    assert.deepEqual(readdirSync(join(skillsDir, "deploy")), ["SKILL.md"], "lock and break guard are both gone");
  }
});

test("only one breaker at a time: a live `.break` guard keeps even a dead owner's lock in place, verified before unlink", t => {
  const { db, skillsDir, skillPath } = fixture(t);
  const proposal = approvedDescription(db, skillPath);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  const lock = join(skillsDir, "deploy", LOCK), guard = `${lock}.break`;
  const stale = JSON.stringify({ token: "crashed", pid: dead, host: hostname(), acquiredAtMs: Date.now() });
  writeFileSync(lock, stale);
  writeFileSync(guard, JSON.stringify({ token: "breaker", pid: process.pid, host: hostname(), acquiredAtMs: Date.now() }));
  assert.throws(() => applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), lockWaitMs: 30 }),
    code("locked"));
  assert.equal(readFileSync(lock, "utf8"), stale, "never unlinked or renamed aside without holding the guard");
  // A guard left by a dead breaker is freed, then the dead owner's lock is broken.
  writeFileSync(guard, JSON.stringify({ token: "breaker", pid: dead, host: hostname(), acquiredAtMs: Date.now() }));
  assert.equal(applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), lockWaitMs: 1_000 }).proposal.status, "applied");
  assert.deepEqual(readdirSync(join(skillsDir, "deploy")), ["SKILL.md"]);
});

test("one BEGIN IMMEDIATE spans the approval re-check, the file write and the applied receipt", t => {
  const { db, skillsDir, skillPath } = fixture(t);
  const proposal = approvedDescription(db, skillPath);
  const writes: boolean[] = [];
  mockFs(t, "writeSync", (original, ...args) => { writes.push(db.isTransaction); return original(...args); });
  applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) });
  assert.deepEqual(writes, [false, true], "the lock file is written before the transaction, the skill file inside it");
  assert.equal(db.isTransaction, false);
  assert.equal(getSkillProposal(db, proposal.id, AGENT)?.status, "applied");
});

test("a filesystem that cannot fsync directories (EINVAL / ENOTSUP / EPERM) never strands an applied proposal", t => {
  for (const failure of ["EINVAL", "ENOTSUP", "EPERM"]) {
    const { db, skillsDir, skillPath } = fixture(t);
    const proposal = approvedDescription(db, skillPath);
    const restore = t.mock.method(fs, "fsyncSync", ((fd: number) => {
      if (fstatSync(fd).isDirectory()) throw Object.assign(new Error(`fsync ${failure}`), { code: failure });
    }) as typeof fs.fsyncSync);
    syncBuiltinESMExports();
    try {
      assert.equal(applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) }).proposal.status,
        "applied", failure);
    } finally { restore.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(readFileSync(skillPath, "utf8"), replaceSkillDescription(SKILL, "Ship releases to production"));
  }
  const { db, skillsDir, skillPath } = fixture(t);
  const proposal = approvedDescription(db, skillPath);
  const restore = t.mock.method(fs, "fsyncSync", ((fd: number) => {
    if (fstatSync(fd).isDirectory()) throw Object.assign(new Error("fsync EIO"), { code: "EIO" });
  }) as typeof fs.fsyncSync);
  syncBuiltinESMExports();
  try {
    assert.throws(() => applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) }), /EIO/u,
      "a real I/O error still fails the apply");
  } finally { restore.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(getSkillProposal(db, proposal.id, AGENT)?.status, "approved", "rolled back with the transaction");
});

test("a lock left by a dead process on this host is broken at once", t => {
  const { db, skillsDir, skillPath } = fixture(t);
  const proposal = approvedDescription(db, skillPath);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  const lock = join(skillsDir, "deploy", LOCK);
  writeFileSync(lock, JSON.stringify({ token: "crashed", pid: dead, host: hostname(), acquiredAtMs: Date.now() }));
  const applied = applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), lockWaitMs: 1, lockStaleMs: 0 });
  assert.equal(applied.proposal.status, "applied");
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(join(skillsDir, "deploy")), ["SKILL.md"], "the stale lock was not left aside");
});

test("approval and base bytes are revalidated under the cross-process fence, before any write", async t => {
  const { root, skillsDir, skillPath } = fixture(t);
  const dbPath = join(root, "memory.sqlite");
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  const proposal = approvedDescription(db, skillPath);
  const lock = join(skillsDir, "deploy", LOCK);
  // Another process takes the apply lock, supersedes this approval in SQLite while holding it, then releases.
  const child = spawn(process.execPath, ["-e", `
    const fs = require("node:fs"), os = require("node:os"), { DatabaseSync } = require("node:sqlite");
    const [lock, dbPath, id] = process.argv.slice(1);
    fs.writeFileSync(lock, JSON.stringify({ token: "child", pid: process.pid, host: os.hostname(), acquiredAtMs: Date.now() }), { flag: "wx" });
    console.log("locked");
    setTimeout(() => {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE skill_proposals SET status='superseded' WHERE id=?").run(id);
      db.close();
      fs.unlinkSync(lock);
    }, 300);`, lock, dbPath, proposal.id], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise(resolve => child.once("exit", resolve));
  await new Promise<void>(resolve => child.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("locked")) resolve(); }));
  assert.throws(() => applyApprovedProposal(db, { id: proposal.id, agentId: AGENT, allowedSources: sources(skillsDir), lockWaitMs: 10_000 }),
    code("invalid_state"));
  await exited;
  assert.equal(readFileSync(skillPath, "utf8"), SKILL, "the superseded proposal never wrote the file");
  assert.equal(getSkillProposal(db, proposal.id, AGENT)?.status, "superseded");
});

test("pending competition is scoped to one target file, and applied supersedes only siblings of the displaced bytes", t => {
  const { db, root, skillsDir, skillPath } = fixture(t);
  // Two different files that happen to share a skill name never supersede each other.
  const twin = join(root, "other-root", "deploy", "SKILL.md");
  mkdirSync(join(root, "other-root", "deploy"), { recursive: true });
  writeFileSync(twin, SKILL);
  const mine = upsertSkillProposal(db, descriptionInput(skillPath, "Ship releases to production"));
  const theirs = upsertSkillProposal(db, descriptionInput(twin, "Deploy the other service"));
  assert.deepEqual(theirs.superseded, []);
  assert.equal(getSkillProposal(db, mine.proposal.id, AGENT)?.status, "pending");
  // Lexically different spellings of one file are one target.
  const respelled = upsertSkillProposal(db, descriptionInput(join(skillsDir, "deploy", ".", "..", "deploy", "SKILL.md"), "Ship releases to production"));
  assert.equal(respelled.action, "unchanged");

  reviewSkillProposal(db, { id: mine.proposal.id, agentId: AGENT, decision: "approved" });
  const installed = replaceSkillDescription(SKILL, "Ship releases to production");
  const stale = upsertSkillProposal(db, { agentId: AGENT, kind: "pitfall_patch", skillName: "deploy", skillPath, title: "p", rationale: "r",
    proposedContent: appendSkillPitfalls(SKILL, ["Old base"]), baseSha256: sha256(SKILL) });
  // A fresh draft already based on the bytes this apply installs (e.g. drafted by a pass right after a crash-recovery).
  const fresh = upsertSkillProposal(db, { agentId: AGENT, kind: "pitfall_patch", skillName: "deploy", skillPath: twin, title: "p", rationale: "r",
    proposedContent: appendSkillPitfalls(SKILL, ["Twin"]), baseSha256: sha256(SKILL) });
  const rebased = upsertSkillProposal(db, { agentId: AGENT, kind: "description_update", skillName: "deploy", skillPath, title: "d",
    rationale: "r", proposedDescription: "Next", proposedContent: replaceSkillDescription(installed, "Next"), baseSha256: sha256(installed) });
  applyApprovedProposal(db, { id: mine.proposal.id, agentId: AGENT, allowedSources: sources(skillsDir) });
  assert.equal(getSkillProposal(db, stale.proposal.id, AGENT)?.status, "superseded", "derived from the displaced bytes");
  assert.equal(getSkillProposal(db, rebased.proposal.id, AGENT)?.status, "pending", "based on the newly installed bytes");
  assert.equal(getSkillProposal(db, fresh.proposal.id, AGENT)?.status, "pending", "another file entirely");
  assert.equal(getSkillProposal(db, theirs.proposal.id, AGENT)?.status, "pending");
});

test("a first new_skill under a configured root that does not exist yet is created; an escaping ancestor is refused before mkdir", t => {
  const { db, root, skillsDir } = fixture(t);
  const content = "---\nname: \"fresh\"\ndescription: \"Fresh\"\n---\n";
  const newSkill = (name: string) => {
    const { proposal } = upsertSkillProposal(db, { agentId: AGENT, kind: "new_skill", skillName: name, skillPath: `${name}/SKILL.md`,
      title: "New", rationale: "r", proposedContent: content });
    reviewSkillProposal(db, { id: proposal.id, agentId: AGENT, decision: "approved" });
    return proposal;
  };
  const freshRoot = join(root, "workspace", "skills-drafts");
  const created = applyApprovedProposal(db, { id: newSkill("fresh").id, agentId: AGENT, allowedSources: sources(freshRoot),
    targetDirForNewSkills: freshRoot });
  assert.equal(created.targetPath, join(freshRoot, "fresh", "SKILL.md"));
  assert.equal(readFileSync(created.targetPath, "utf8"), content);
  assert.deepEqual(readdirSync(join(freshRoot, "fresh")), ["SKILL.md"]);

  // The nearest existing ancestor is a symlink out of the root: nothing is created outside.
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(skillsDir, "escape"));
  assert.throws(() => applyApprovedProposal(db, { id: newSkill("evil").id, agentId: AGENT, allowedSources: sources(skillsDir),
    targetDirForNewSkills: join(skillsDir, "escape", "nested") }), code("path_outside_root"));
  assert.deepEqual(readdirSync(outside), [], "no directory was created through the symlink");
});

test("replaceSkillDescription round-trips through the YAML AST: quoted keys, indented and flow maps, comments, BOM + CRLF", () => {
  const cases: Array<[string, string]> = [
    ["---\n\"description\": Before\nname: x\n---\nBody\n", "---\n\"description\": \"After\"\nname: x\n---\nBody\n"],
    ["---\n'description': 'Before'\n---\n", "---\n'description': \"After\"\n---\n"],
    ["---\n  name: x\n  description: Before\n---\n", "---\n  name: x\n  description: \"After\"\n---\n"],
    ["---\n{name: x, description: Before}\n---\n", "---\n{name: x, description: \"After\"}\n---\n"],
    ["---\nname: x\ndescription: Before # routing text\nlicense: MIT\n---\n", "---\nname: x\ndescription: \"After\" # routing text\nlicense: MIT\n---\n"],
    ["﻿---\r\n\"description\": |\r\n  a\r\n\r\n  b\r\nname: x\r\n---\r\nBody\r\n", "﻿---\r\n\"description\": \"After\"\r\nname: x\r\n---\r\nBody\r\n"],
    ["---\ndescription:\nname: x\n---\n", "---\ndescription: \"After\"\nname: x\n---\n"],
    ["---\n---\nBody\n", "---\ndescription: \"After\"\n---\nBody\n"],
    // Legacy frontmatter that is not valid YAML (unquoted `: `) is repaired by quoting the description.
    ["---\nname: x\ndescription: Use when: deploying\n---\n", "---\nname: x\ndescription: \"After\"\n---\n"],
  ];
  for (const [input, expected] of cases) {
    const out = replaceSkillDescription(input, "After");
    assert.equal(out, expected, JSON.stringify(input));
    assert.equal(readSkillDescription(out), "After");
  }
  assert.equal(readSkillDescription("---\n\"description\": Before\n---\n"), "Before");
  assert.equal(readSkillDescription("---\n{name: x, description: 'It''s here'}\n---\n"), "It's here");
  assert.equal(readSkillDescription("---\nname: x\ndescription: Use when: deploying\n---\n"), "Use when: deploying", "same fallback as the catalog");
  // A flow map without a description gains one through the AST.
  assert.equal(readSkillDescription(replaceSkillDescription("---\n{name: x}\n---\n", "After")), "After");
});

test("replaceSkillDescription rejects results with YAML errors (DUPLICATE_KEY, broken siblings) or a wrong read-back", () => {
  // Duplicate keys stay duplicate after a rewrite: refuse instead of letting the parser pick one.
  assert.throws(() => replaceSkillDescription("---\ndescription: a\ndescription: b\n---\n", "After"), code("invalid_input"));
  assert.throws(() => replaceSkillDescription("---\nname: x\nname: y\ndescription: a\n---\n", "After"), code("invalid_input"));
  // Another key that is not valid YAML is not ours to fix.
  assert.throws(() => replaceSkillDescription("---\nname: a: b\ndescription: c\n---\n", "After"), code("invalid_input"));
  assert.throws(() => replaceSkillDescription("---\n- a\n- b\n---\n", "After"), code("invalid_input"), "a sequence is not frontmatter");
});

test("appendSkillPitfalls follows CommonMark headings: ≤3-space indent, closing #s, setext headings and boundaries", () => {
  // Four spaces is an indented code block, not a heading: a real section is created.
  assert.equal(appendSkillPitfalls("# S\n\n    ## Pitfalls\n", ["A"]), "# S\n\n    ## Pitfalls\n\n## Pitfalls\n\n- A\n");
  assert.equal(appendSkillPitfalls("   ## Pitfalls ##\n\n- Old\n", ["A"]), "   ## Pitfalls ##\n\n- Old\n- A\n");
  assert.equal(appendSkillPitfalls("## Pitfalls\n\n- Old\n\n## \n\nx\n", ["A"]), "## Pitfalls\n\n- Old\n- A\n\n## \n\nx\n", "an empty ## ends it");
  // Setext headings end the section (=== h1, --- h2 under paragraph text).
  assert.equal(appendSkillPitfalls("## Pitfalls\n\n- Old\n\nNext\n====\n\nx\n", ["A"]), "## Pitfalls\n\n- Old\n- A\n\nNext\n====\n\nx\n");
  assert.equal(appendSkillPitfalls("## Pitfalls\n\n- Old\n\nNext\n---\n", ["A"]), "## Pitfalls\n\n- Old\n- A\n\nNext\n---\n");
  // A thematic break (after a blank line or a list item) is not a heading.
  assert.equal(appendSkillPitfalls("## Pitfalls\n\n- Old\n\n---\n\n- More\n", ["A"]), "## Pitfalls\n\n- Old\n\n---\n\n- More\n- A\n");
  assert.equal(appendSkillPitfalls("## Pitfalls\n\n- Old\n---\n", ["A"]), "## Pitfalls\n\n- Old\n---\n- A\n");
  // A setext `Pitfalls` heading is the section.
  assert.equal(appendSkillPitfalls("Pitfalls\n--------\n\n- Old\n\n## Next\n", ["A"]), "Pitfalls\n--------\n\n- Old\n- A\n\n## Next\n");
  // `### Pitfalls` is a subsection, never the section; `#` inside fences still ignored.
  assert.equal(appendSkillPitfalls("### Pitfalls\n", ["A"]), "### Pitfalls\n\n## Pitfalls\n\n- A\n");
  assert.equal(appendSkillPitfalls("## Pitfalls\n\n```\nNext\n===\n```\n\n## End\n", ["A"]), "## Pitfalls\n\n```\nNext\n===\n```\n- A\n\n## End\n");
});

test("appendSkillPitfalls scans for headings only after the frontmatter's closing ---", () => {
  // A YAML `# comment` that looks like `## Pitfalls`, and a ``` inside a block scalar, are frontmatter, never Markdown.
  const withComment = "---\nname: deploy\n## Pitfalls\ndescription: |\n  ```\n  x\n---\n\n# Deploy\n\nRun it.\n";
  assert.equal(appendSkillPitfalls(withComment, ["A"]), `${withComment}\n## Pitfalls\n\n- A\n`);
  assert.equal(readSkillDescription(appendSkillPitfalls(withComment, ["A"])), readSkillDescription(withComment), "frontmatter untouched");
  // A YAML line `Pitfalls` right above the closing `---` is not a setext heading either.
  const setextLike = "---\nPitfalls\n---\n\n# Deploy\n";
  assert.equal(appendSkillPitfalls(setextLike, ["A"]), `${setextLike}\n## Pitfalls\n\n- A\n`);
  // The real section after the frontmatter is still found (CRLF + BOM kept).
  const real = "\uFEFF---\r\nname: x\r\n# Pitfalls\r\n---\r\n\r\n## Pitfalls\r\n\r\n- Old\r\n";
  assert.equal(appendSkillPitfalls(real, ["A"]), "\uFEFF---\r\nname: x\r\n# Pitfalls\r\n---\r\n\r\n## Pitfalls\r\n\r\n- Old\r\n- A\r\n");
});
