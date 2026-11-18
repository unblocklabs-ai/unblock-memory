import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('coverage rejects omitted claims, skipped sessions and unverified evidence; unresolved work remains partial', t => {
  const root = mkdtempSync(join(tmpdir(), 'people-coverage-')); t.after(() => rmSync(root, { recursive: true }));
  const manifest = { assertions: [{ id: 'claim-1' }, { id: 'claim-2' }], sourceGaps: [],
    roster: [{ senderId: 'U123', sessions: [{ sessionId: 'session-1' }] }] };
  const receipt = { kind: 'nightly', fullValidation: true,
    assertionReviews: manifest.assertions.map(claim => ({ assertionId: claim.id,
      disposition: 'revalidated', reason: 'Checked original evidence and newer corrections',
      reviewedAt: '2026-11-16T08:00:00Z', sourceRefs: ['session source event 1'] })),
    peopleReviews: [{ senderId: 'U123', status: 'reviewed', reason: 'Read the exchange', sessionIds: ['session-1'], sourceRefs: ['session-1/event-1'] }] };
  const run = (value = receipt) => {
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'receipt.json'), JSON.stringify(value));
    const result = spawnSync(process.execPath, [new URL('../scripts/people-review-coverage.mjs', import.meta.url).pathname,
      join(root, 'manifest.json'), join(root, 'receipt.json')], { encoding: 'utf8' });
    return JSON.parse(result.stdout);
  };
  assert.equal(run().status, 'complete');
  assert.equal(run({ ...receipt, assertionReviews: receipt.assertionReviews.slice(0,1) }).status, 'invalid');
  assert.equal(run({ ...receipt, peopleReviews: [{ ...receipt.peopleReviews[0], sessionIds: [] }] }).status, 'invalid');
  assert.equal(run({ ...receipt, assertionReviews: receipt.assertionReviews.map(c => ({ ...c, sourceRefs: [] })) }).status, 'invalid');
  assert.equal(run({ ...receipt, assertionReviews: receipt.assertionReviews.map(c => ({ ...c, disposition: 'unresolved' })) }).status, 'partial');
  manifest.sourceGaps.push({ id: 'gap-1', reason: 'cold transcript' });
  assert.equal(run().status, 'partial');
  assert.equal(run({ ...receipt, sourceGapReviews: [{ sourceGapId: 'gap-1', status: 'resolved',
    sourceRefs: ['Supported native session read event 1'], reason: 'Read and verified original archived exchange' }] }).status, 'complete');
});
