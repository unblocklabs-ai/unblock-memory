// Read-only corpus comparison. Deterministic model doubles exercise real QMD chunking;
// this is a coverage/citation test, not a production embedding-quality benchmark.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [stateRoot, installedPlugin, shadowReport, bundle, output] = process.argv.slice(2);
assert.ok(stateRoot && installedPlugin && shadowReport && bundle && output);
const imp = path => import(pathToFileURL(path).href);
const baseline = await imp(`${bundle}/baseline-parser.mjs`);
const { projectSession: beforeProjection } = await imp(`${installedPlugin}/dist/src/session-projector.js`);
const { projectSession: afterProjection } = await imp(`${bundle}/session-projector.js`);
const { chunkMarkdownSemantically: beforeChunking } = await imp(`${installedPlugin}/../qmd/dist/semantic-chunking.js`);
const { chunkMarkdownSemantically: afterChunking } = await imp(`${bundle}/semantic-chunking.js`);
const summary = JSON.parse(await readFile(`${shadowReport}/summary.json`, 'utf8'));
assert.equal(summary.inputsStable, true);
const editRows = (await readFile(`${shadowReport}/edits.jsonl`, 'utf8')).split('\n').filter(line => line.trim()).map(JSON.parse);
const state = `${stateRoot}/agents/main/unblock-memory`;
const index = new DatabaseSync(`${state}/index.sqlite`, { readOnly: true });
const raw = new DatabaseSync(`${stateRoot}/agents/main/agent/openclaw-agent.sqlite`, { readOnly: true });
const manifestText = await readFile(`${state}/sessions-manifest.json`, 'utf8');
const manifest = JSON.parse(manifestText);
const hash = text => createHash('sha256').update(text).digest('hex');
assert.equal(hash(manifestText), summary.manifestSha256, 'Session manifest changed since shadow run');
const versions = [index, raw].map(db => db.prepare('PRAGMA data_version').get().data_version);
for (const db of [index, raw]) db.exec('BEGIN');
const report = { model: 'deterministic hash vectors and character-count tokenizer; no model calls', documents: 0,
  projectionEventsChecked: 0, changedProjectionEvents: 0, changedRuntimeSessions: 0, chunkPasses: [], inputsStable: false };
// Check production projection against the approved parser on every active event in indexed sessions.
const preamble = '# Transcript\n\n';
const projectedSessions = new Map();
for (const row of raw.prepare(`SELECT a.session_id,e.event_json,e.created_at FROM session_transcript_active_events a
 JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq ORDER BY a.session_id,a.active_position`).iterate()) {
  const meta = manifest.sessions[row.session_id];
  if (!meta) continue;
  const input = { ...meta, agentName: 'main', timezone: 'UTC', events: [{ eventJson: row.event_json, createdAt: row.created_at }] };
  const before = beforeProjection(input), after = afterProjection(input);
  let expected = before;
  let projectionEdits = [];
  const m = JSON.parse(row.event_json).message;
  if (before && m?.role === 'user' && meta.provider?.toLowerCase() !== 'loggie') {
    const start = before.indexOf('\n\n', preamble.length) + 2;
    const body = before.slice(start, -1);
    const trusted = m.provenance?.kind === 'inter_session' && ['subagent_announce','agent_harness_task'].includes(m.provenance.sourceTool);
    const internal = baseline.parseInternalMessage(body, trusted);
    const proposal = internal.edits.length ? internal : baseline.parseAttachments(body);
    expected = before.slice(0, start) + baseline.applyProposal(body, proposal) + '\n';
    projectionEdits = proposal.edits.map(e=>({...e,start:e.start+start,end:e.end+start}));
  }
  assert.equal(after, expected, `Projection differs from approved rules in session ${row.session_id}`);
  report.projectionEventsChecked++;
  if (before !== after) report.changedProjectionEvents++;
  // Non-Loggie projection joins messages exactly this way. Include every message,
  // not just changed events, so new chunking sees the complete runtime context.
  if (before && meta.provider?.toLowerCase() !== 'loggie') {
    const document = projectedSessions.get(row.session_id) ?? { path: meta.documentPath, text: preamble, normalized: preamble, edits: [], messages: 0 };
    const separator = document.messages ? '\n\n' : '';
    const offset = document.text.length + separator.length - preamble.length;
    document.edits.push(...projectionEdits.map(e=>({...e,start:e.start+offset,end:e.end+offset})));
    document.text += separator + before.slice(preamble.length,-1);
    document.normalized += separator + after.slice(preamble.length,-1);
    document.messages++;
    projectedSessions.set(row.session_id,document);
  }
}
const documents = summary.documentFingerprints.map(fingerprint => {
  const row = index.prepare('SELECT d.id,c.doc FROM documents d JOIN content c ON c.hash=d.hash WHERE d.active=1 AND d.collection=? AND d.path=?').get(fingerprint.collection,fingerprint.path);
  assert.ok(row, 'Missing snapshot document');
  assert.equal(hash(row.doc), fingerprint.sha256, 'Indexed content changed since shadow run');
  const edits = editRows.filter(e => e.documentId === row.id).sort((a,b) => a.start-b.start);
  for (const edit of edits) assert.equal(row.doc.slice(edit.start,edit.end), edit.removed);
  return { ...fingerprint, text: row.doc, edits, normalized: baseline.applyProposal(row.doc,{ edits, preserved: [] }) };
});
report.documents = documents.length;
const changedSessions = [...projectedSessions.values()].filter(d=>d.edits.length);
report.changedRuntimeSessions = changedSessions.length;
for (const document of changedSessions) {
  document.text+='\n'; document.normalized+='\n';
  document.edits.sort((a,b)=>a.start-b.start);
  assert.equal(baseline.applyProposal(document.text,{edits:document.edits,preserved:[]}),document.normalized);
}
function coverage(text, chunks) {
  const covered = new Uint8Array(text.length);
  let end = 0;
  for (const c of chunks) {
    assert.ok(c.pos >= end, 'Overlapping/out-of-order citation spans');
    assert.equal(text.slice(c.pos, c.pos+c.text.length), c.text, 'Inexact source citation');
    covered.fill(1,c.pos,c.pos+c.text.length);
    end = c.pos+c.text.length;
  }
  return covered;
}
for (const maxTokens of [300, 128]) {
  const totals = { maxTokens, beforeChunks: 0, afterChunks: 0, structuralChunksSkipped: 0, retainedCharactersChecked: 0 };
  const options = { minTokens: Math.min(100,maxTokens), maxTokens,
    countTokens: async text => Math.ceil(text.length/4),
    embedBatch: async texts => texts.map(text => [...createHash('sha256').update(text).digest()].slice(0,16).map(v => v/255)) };
  for (const doc of [...documents,...changedSessions]) {
    const old = await beforeChunking(doc.text, doc.path, options);
    const normalizedOld = doc.edits.length ? await beforeChunking(doc.normalized,doc.path,options) : old;
    const current = await afterChunking(doc.normalized,doc.path,options);
    const rejected = normalizedOld.filter(c => baseline.structuralChunkReason(doc.normalized,c.pos,c.pos+c.text.length));
    assert.deepEqual(current, normalizedOld.filter(c => !rejected.includes(c)), 'New chunking changed beyond approved structural eligibility');
    const beforeCoverage = coverage(doc.text,old), afterCoverage = coverage(doc.normalized,current);
    // Authorized structural omissions are accounted for separately, not mistaken for payload loss.
    for (const c of rejected) afterCoverage.fill(1,c.pos,c.pos+c.text.length);
    let originalPos=0, normalizedPos=0;
    for (const edit of [...doc.edits,{start:doc.text.length,end:doc.text.length,replacement:''}]) {
      const retained=doc.text.slice(originalPos,edit.start);
      assert.equal(doc.normalized.slice(normalizedPos,normalizedPos+retained.length),retained);
      for(let i=0;i<retained.length;i++) if(beforeCoverage[originalPos+i] && !afterCoverage[normalizedPos+i] && /\S/u.test(retained[i])) {
        assert.fail(`Previously indexed retained content lost: ${doc.path}:${originalPos+i}`);
      }
      totals.retainedCharactersChecked+=retained.length;
      normalizedPos+=retained.length+edit.replacement.length; originalPos=edit.end;
    }
    totals.beforeChunks+=old.length; totals.afterChunks+=current.length; totals.structuralChunksSkipped+=rejected.length;
  }
  report.chunkPasses.push(totals);
}
for(const db of [index,raw])db.exec('COMMIT');
report.inputsStable=[index,raw].every((db,i)=>db.prepare('PRAGMA data_version').get().data_version===versions[i])
 && hash(await readFile(`${state}/sessions-manifest.json`))===summary.manifestSha256;
index.close();raw.close();
// Only an exclusive report directory is created; no documents, index, or tasks are changed.
await mkdir(output,{mode:0o700});
await writeFile(`${output}/summary.json`,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report));
assert.equal(report.inputsStable,true,'Inputs changed during comparison; rerun');
