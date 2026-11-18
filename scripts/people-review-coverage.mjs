#!/usr/bin/env node
import { readFileSync } from 'node:fs';

// Coverage verification is deterministic; evidence interpretation remains the agent's job.
const [manifestPath, receiptPath] = process.argv.slice(2);
if (!manifestPath || !receiptPath) throw new Error('Usage: people-review-coverage.mjs MANIFEST_JSON RECEIPT_JSON');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
if (manifest.id && manifest.agentId) {
  const { verifyLearningCoverage, LEARNING_RECEIPT_SCHEMA } = await import('../dist/src/people-learning-store.js');
  const { Value } = await import('typebox/value');
  const result = verifyLearningCoverage(manifest, Value.Parse(LEARNING_RECEIPT_SCHEMA, receipt));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'complete' ? 0 : 1);
}
// Compatibility for receipts produced by the original local extension. These
// cannot be submitted to plugin-owned runs, which require the schema above.
const errors = [];
const byId = new Map((receipt.assertionReviews ?? []).map(review => [review.assertionId, review]));
if (byId.size !== (receipt.assertionReviews ?? []).length) errors.push('Duplicate assertion dispositions');
const statuses = new Set(['revalidated','corrected','retired','unresolved']);
let reviewed = 0, unresolved = 0;
if (receipt.fullValidation) {
  for (const claim of manifest.assertions) {
    const review = byId.get(claim.id);
    if (!review) { errors.push(`Missing assertion ${claim.id}`); continue; }
    if (!statuses.has(review.disposition) || !review.reason?.trim() || !Number.isFinite(Date.parse(review.reviewedAt))) {
      errors.push(`Invalid disposition ${claim.id}`); continue;
    }
    if (review.disposition !== 'unresolved' && (!Array.isArray(review.sourceRefs) || !review.sourceRefs.length)) {
      errors.push(`Missing original-source verification ${claim.id}`); continue;
    }
    if (review.disposition === 'unresolved') unresolved++; else reviewed++;
  }
  const known = new Set(manifest.assertions.map(claim => claim.id));
  for (const id of byId.keys()) if (!known.has(id)) errors.push(`Unknown assertion ${id}`);
}
if (receipt.kind === 'nightly') {
  const people = new Map((receipt.peopleReviews ?? []).map(person => [person.senderId, person]));
  if (people.size !== (receipt.peopleReviews ?? []).length) errors.push('Duplicate team-member reviews');
  for (const person of manifest.roster) {
    const review = people.get(person.senderId);
    if (!review || !['reviewed','no_interactions','unresolved'].includes(review.status)) {
      errors.push(`Missing/invalid team-member review ${person.senderId}`); continue;
    }
    if (person.sessions.length && review.status === 'no_interactions') errors.push(`Skipped existing interactions for ${person.senderId}`);
    const inspected = new Set(review.sessionIds ?? []);
    if (review.status === 'reviewed' && person.sessions.some(session => !inspected.has(session.sessionId))) {
      errors.push(`Unreviewed session for ${person.senderId}`);
    }
    if (review.status === 'reviewed' && (!review.reason?.trim() || !Array.isArray(review.sourceRefs) || !review.sourceRefs.length)) {
      errors.push(`Missing exchange evidence for ${person.senderId}`);
    }
    if (review.status === 'unresolved') unresolved++;
  }
}
const gapReviews = new Map((receipt.sourceGapReviews ?? []).map(review => [review.sourceGapId, review]));
const gaps = manifest.sourceGaps.filter(gap => {
  const review = gapReviews.get(gap.id);
  return review?.status !== 'resolved' || !review.reason?.trim() || !review.sourceRefs?.length;
}).length;
const status = errors.length ? 'invalid' : unresolved || gaps || receipt.auditBacklog ? 'partial' : 'complete';
console.log(JSON.stringify({ status, expectedAssertions: receipt.fullValidation ? manifest.assertions.length : 0,
  reviewed, unresolved, sourceGaps: gaps, errors }, null, 2));
if (status !== 'complete') process.exitCode = 1;
