// Run on-host. Reads all databases read-only; writes private reports only to a new, non-corpus directory.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, relative } from 'node:path';
const [stateRootArg, pluginRoot, parserPath, outputArg] = process.argv.slice(2);
assert.ok(stateRootArg && pluginRoot && parserPath && outputArg, 'STATE_ROOT PLUGIN_ROOT PARSER_JS NEW_REPORT_DIRECTORY');
const root = resolve(stateRootArg), output = resolve(outputArg), state = `${root}/agents/main/unblock-memory`;
const config = JSON.parse(await readFile(`${root}/openclaw.json`, 'utf8'));
const imp = name => import(pathToFileURL(`${pluginRoot}/dist/src/${name}.js`).href);
const { resolveConfig } = await imp('config');
const { resolveSources, resolveSessionSource } = await imp('sources');
const { parseAttachments, parseInternalMessage, structuralChunkReason, applyProposal } = await import(pathToFileURL(parserPath).href);
const cfg = resolveConfig(config.plugins.entries['unblock-memory'].config);
const sources = resolveSources(`${root}/workspace`, cfg.corpora.filter(c => c.kind !== 'sessions'));
const sessionCorpus = cfg.corpora.find(c => c.kind === 'sessions');
if (sessionCorpus) sources.push(resolveSessionSource(`${state}/sessions`, sessionCorpus.chatTypes));
assert.ok(!sources.some(s => { const p=relative(s.root,output);return p===''||(!p.startsWith('..')&&!p.startsWith('/')); }), 'Report directory must not be inside a corpus root');
await mkdir(output, { mode: 0o700 }); // Exclusive: never overwrite an earlier report.
const approved = new Map(sources.filter(s => cfg.qualityAudit.corpora.includes(s.corpus)).map(s => [s.collection, s]));
const hash = text => createHash('sha256').update(text).digest('hex');
const index = new DatabaseSync(`${state}/index.sqlite`, { readOnly: true });
const curation = new DatabaseSync(`${state}/curation.sqlite`, { readOnly: true });
const raw = new DatabaseSync(`${root}/agents/main/agent/openclaw-agent.sqlite`, { readOnly: true });
const manifestText = await readFile(`${state}/sessions-manifest.json`, 'utf8');
const manifest = JSON.parse(manifestText);
const databases = { index, curation, raw };
const versions = Object.fromEntries(Object.entries(databases).map(([name, db]) => [name, db.prepare('PRAGMA data_version').get().data_version]));
for (const db of Object.values(databases)) db.exec('BEGIN');
const included = new Set(Object.values(manifest.sessions).map(s => s.sessionId));
// Key by owning session AND exact text, not a global textual match or quoted marker.
const userMessages = new Set(), trustedMessages = new Set();
for (const row of raw.prepare(`SELECT e.event_json,w.session_id FROM session_windows w
 JOIN session_transcript_active_events a ON a.session_id=w.session_id
 JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq`).iterate()) {
 if (!included.has(row.session_id)) continue;
 const e = JSON.parse(row.event_json), m = e.message;
 if (e.type !== 'message' || m?.role !== 'user') continue;
 let text = (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter(b=>b.type==='text').map(b=>b.text).join('\n') : '').trim();
 // Mirror the production projector's sole non-Loggie user-text normalization.
 const speaker=[m.__openclaw?.senderName,m.__openclaw?.senderUsername,m.__openclaw?.senderId,m.senderName,m.senderLabel,m.senderId]
  .find(s=>typeof s==='string'&&s.trim())?.trim()??'User';
 if(speaker!=='User')text=text.replace(/^From:[^\n]*\n/u,'').trim();
 const key=JSON.stringify([row.session_id,hash(text)]);userMessages.add(key);
 if (m.provenance?.kind === 'inter_session' && ['subagent_announce','agent_harness_task'].includes(m.provenance.sourceTool)) trustedMessages.add(key);
}
const metadata = new Map(Object.values(manifest.sessions).map(s => [s.documentPath,s]));
const flagged = new Map(curation.prepare("SELECT * FROM maintenance_tasks WHERE type='quality_review' AND status='pending'").all().map(t=>[JSON.stringify([t.collection,t.path,t.content_fingerprint]),t]));
const report={documents:0,chunks:0,flaggedTasks:flagged.size,changedDocuments:0,edits:0,preservedPayloads:0,verifiedUnchangedCharacters:0,byReason:{},chunkEffects:{flagged:{untouched:0,partial:0,structuralOnly:0},unflagged:{untouched:0,partial:0,structuralOnly:0}},missingFlaggedTasks:[],untrustedInternalCandidates:0,wholeMessagesEmptied:0,scope:cfg.qualityAudit.corpora};
report.parserSha256=hash(await readFile(parserPath));
report.manifestSha256=hash(manifestText);
report.documentFingerprints=[];
const editLog=[],chunkLog=[],seenTasks=new Set(),rejected=[],taskEffects=new Map();
for (const doc of index.prepare('SELECT d.id,d.collection,d.path,d.hash,c.doc FROM documents d JOIN content c ON c.hash=d.hash WHERE d.active=1 ORDER BY d.id').iterate()) {
 const source=approved.get(doc.collection);if(!source)continue;report.documents++;
 const text=doc.doc;
 report.documentFingerprints.push({collection:doc.collection,path:doc.path,sha256:hash(text)});
 const proposal={edits:[],preserved:[]};
 if(source.kind==='sessions'){
  const sessionId=metadata.get(doc.path)?.sessionId;
  const headings=[...text.matchAll(/^## (User|Assistant) — .* — \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S.*\n/gm)];
  for(let i=0;i<headings.length;i++){
   if(headings[i][1]!=='User')continue;
   const offset=headings[i].index+headings[i][0].length,end=headings[i+1]?.index??text.length;
   const untrimmed=text.slice(offset,end),body=untrimmed.trim(),start=offset+untrimmed.indexOf(body);
   const key=JSON.stringify([sessionId,hash(body)]),trusted=trustedMessages.has(key);
   const candidate=/OPENCLAW_INTERNAL_CONTEXT|\[Inter-session message\]|^A background task completed\.|<file name=|EXTERNAL_UNTRUSTED_CONTENT/m.test(body);
   if(!userMessages.has(key)){
    if(candidate)rejected.push({path:doc.path,start,end,reason:'no-exact-raw-message-match',body});
    continue;
   }
   let p=parseInternalMessage(body,trusted);
   const missingProvenance=!trusted&&parseInternalMessage(body,true).edits.length>0;
   if(missingProvenance)report.untrustedInternalCandidates++;
   if(!p.edits.length)p=parseAttachments(body);
   if(candidate&&!p.edits.length)rejected.push({path:doc.path,start,end,reason:missingProvenance?'missing-internal-provenance':'unrecognized-complete-grammar',body});
   const normalized=applyProposal(body,p);
   if(body.trim()&&!normalized.trim())report.wholeMessagesEmptied++;
   for(const e of p.edits)proposal.edits.push({...e,start:e.start+start,end:e.end+start});
   for(const kept of p.preserved)proposal.preserved.push({start:kept.start+start,end:kept.end+start});
  }
 }
 const normalized=applyProposal(text,proposal);
 // Independent retained-span/offset accounting: every original character outside edits survives exactly.
 let oldPos=0,newPos=0;
 for(const e of [...proposal.edits].sort((a,b)=>a.start-b.start)){
  const retained=text.slice(oldPos,e.start);assert.equal(normalized.slice(newPos,newPos+retained.length),retained);
  report.verifiedUnchangedCharacters+=retained.length;newPos+=retained.length+e.replacement.length;oldPos=e.end;
  report.byReason[e.reason]=(report.byReason[e.reason]??0)+1;
  editLog.push({documentId:doc.id,corpus:source.corpus,path:doc.path,...e,removed:text.slice(e.start,e.end)});
 }
 assert.equal(normalized.slice(newPos),text.slice(oldPos));report.verifiedUnchangedCharacters+=text.length-oldPos;
 for(const kept of proposal.preserved)assert.ok(normalized.includes(text.slice(kept.start,kept.end)));
 report.preservedPayloads+=proposal.preserved.length;
 report.edits+=proposal.edits.length;if(proposal.edits.length)report.changedDocuments++;
 for(const chunk of index.prepare('SELECT seq,pos,chunk_len FROM content_vectors WHERE hash=? ORDER BY seq').all(doc.hash)){
  report.chunks++;const start=chunk.pos,end=start+chunk.chunk_len,original=text.slice(start,end);
  const task=flagged.get(JSON.stringify([doc.collection,doc.path,hash(original)]));if(task)seenTasks.add(task.id);
  const reason=structuralChunkReason(text,start,end);
  const edits=proposal.edits.filter(e=>e.start<end&&e.end>start).sort((a,b)=>a.start-b.start);
  let remaining='',at=start;
  for(const e of edits){remaining+=text.slice(at,Math.max(at,e.start));at=Math.max(at,Math.min(end,e.end));}
  remaining+=text.slice(at,end);
  // A generated message heading is context, not retained payload evidence.
  const payload=remaining.replace(/^# Transcript\s*$/gm,'').replace(/^## (User|Assistant) — .* — \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S.*$/gm,'').trim();
  const effect=reason|| (edits.length&&!payload)?'structuralOnly':edits.length?'partial':'untouched';
  report.chunkEffects[task?'flagged':'unflagged'][effect]++;
  if(task){const effects=taskEffects.get(task.id)??new Set();effects.add(effect);taskEffects.set(task.id,effects);}
  if(effect!=='untouched'||task)chunkLog.push({taskId:task?.id,documentId:doc.id,corpus:source.corpus,path:doc.path,seq:chunk.seq,start,end,effect,reasons:reason?[reason]:[...new Set(edits.map(e=>e.reason))],original,retained:reason?'':remaining});
 }
}
report.missingFlaggedTasks=[...flagged.values()].filter(t=>!seenTasks.has(t.id)).map(t=>t.id);
assert.equal(report.wholeMessagesEmptied,0);
report.uniqueTaskEffects={untouched:0,partial:0,structuralOnly:0,mixed:0};
for(const effects of taskEffects.values())report.uniqueTaskEffects[effects.size===1?[...effects][0]:'mixed']++;
report.rejectedMessagesByReason={};
for(const r of rejected)report.rejectedMessagesByReason[r.reason]=(report.rejectedMessagesByReason[r.reason]??0)+1;
for(const db of Object.values(databases))db.exec('COMMIT');
report.inputsStable=Object.entries(databases).every(([name,db])=>db.prepare('PRAGMA data_version').get().data_version===versions[name])
 && hash(await readFile(`${state}/sessions-manifest.json`))===report.manifestSha256;
index.close();curation.close();raw.close();
for(const [name,data] of [['edits',editLog],['chunks',chunkLog],['rejected',rejected]])await writeFile(`${output}/${name}.jsonl`,data.map(x=>JSON.stringify(x)).join('\n')+'\n',{mode:0o600});
await writeFile(`${output}/summary.json`,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const {documentFingerprints,...summary}=report;
console.log(JSON.stringify(summary));
