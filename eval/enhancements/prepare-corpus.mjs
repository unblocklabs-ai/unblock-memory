// Copy an approved INDEXED corpus on-host into a new private sandbox. Never alters live state.
import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { pathToFileURL } from "node:url";
const [liveRoot, installedPlugin, output] = process.argv.slice(2);
assert.ok(liveRoot && installedPlugin && output);
assert.notEqual(resolve(liveRoot), resolve(output));
await mkdir(output, { mode: 0o700 });
const imp = name => import(pathToFileURL(`${installedPlugin}/dist/src/${name}.js`));
const { resolveConfig } = await imp("config");
const { resolveSources, resolveSessionSource } = await imp("sources");
const host = JSON.parse(await readFile(`${liveRoot}/openclaw.json`, "utf8"));
const cfg = resolveConfig(host.plugins.entries["unblock-memory"].config);
const workspace = host.agents.defaults.workspace;
const approved = cfg.qualityAudit.corpora;
assert.ok(cfg.qualityAudit.enabled && approved.length);
const fileCorpora = cfg.corpora.filter(c => c.kind === "files" && approved.includes(c.name));
const originals = resolveSources(workspace, fileCorpora);
const sessionCorpus = cfg.corpora.find(c => c.kind === "sessions" && approved.includes(c.name));
const liveState = `${liveRoot}/agents/main/unblock-memory`;
const state = `${output}/agents/main/unblock-memory`;
await mkdir(`${output}/agents/main/agent`, { recursive: true, mode: 0o700 });
await mkdir(`${state}/sessions`, { recursive: true, mode: 0o700 });
const manifestBefore = await readFile(`${liveState}/sessions-manifest.json`, "utf8");
for (const [source, target] of [
  [`${liveState}/index.sqlite`, `${state}/index.sqlite`],
  [`${liveState}/curation.sqlite`, `${state}/curation.sqlite`],
  [`${liveRoot}/agents/main/agent/openclaw-agent.sqlite`, `${output}/agents/main/agent/openclaw-agent.sqlite`],
]) {
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, target); } finally { db.close(); }
  await chmod(target, 0o600);
}
assert.equal(await readFile(`${liveState}/sessions-manifest.json`, "utf8"), manifestBefore, "Live manifest changed during copy; retry a new sandbox");
await writeFile(`${state}/sessions-manifest.json`, manifestBefore, { mode: 0o600, flag: "wx" });
const configCorpora = [];
const mappings = [];
for (const [i, source] of originals.entries()) {
  const root = `${output}/workspace/source-${i}`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const configuredPath = `source-${i}/${source.pattern}`;
  const corpus = configCorpora.find(c => c.name === source.corpus);
  if (corpus) corpus.paths.push(configuredPath);
  else configCorpora.push({ name: source.corpus, kind: "files", paths: [configuredPath] });
  const replacement = resolveSources(`${output}/workspace`, [{ name: source.corpus, kind: "files", paths: [configuredPath] }])[0];
  mappings.push({ source, replacement });
}
if (sessionCorpus) {
  configCorpora.push({ ...sessionCorpus, syncIntervalMinutes: 0 });
  mappings.push({ source: resolveSessionSource(`${liveState}/sessions`, sessionCorpus.chatTypes),
    replacement: resolveSessionSource(`${state}/sessions`, sessionCorpus.chatTypes) });
}
const db = new DatabaseSync(`${state}/index.sqlite`);
const curation = new DatabaseSync(`${state}/curation.sqlite`);
let documents = 0;
for (const { source, replacement } of mappings) {
  for (const row of db.prepare(`SELECT d.path, c.doc FROM documents d JOIN content c ON c.hash = d.hash
    WHERE d.active = 1 AND d.collection = ?`).all(source.collection)) {
    const target = resolve(replacement.root, row.path);
    const rel = relative(replacement.root, target);
    assert.ok(rel && !rel.startsWith("..") && !rel.startsWith("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, row.doc, { mode: 0o600, flag: "wx" });
    documents++;
  }
  db.prepare("UPDATE documents SET collection = ? WHERE collection = ?").run(replacement.collection, source.collection);
  curation.prepare("UPDATE maintenance_tasks SET collection = ? WHERE collection = ?").run(replacement.collection, source.collection);
}
db.prepare(`UPDATE documents SET active = 0 WHERE collection NOT IN (${mappings.map(() => "?").join(",")})`).run(...mappings.map(m => m.replacement.collection));
db.close(); curation.close();
await writeFile(`${output}/openclaw.json`, JSON.stringify({ agents: { defaults: { workspace: `${output}/workspace` } },
  plugins: { entries: { "unblock-memory": { config: { corpora: configCorpora,
    qualityAudit: { ...cfg.qualityAudit, corpora: approved }, typesafe: { enabled: false } } } } } }, null, 2), { mode: 0o600, flag: "wx" });
await writeFile(`${output}/snapshot.json`, JSON.stringify({ documents, approved, basis: "Indexed content snapshot, not current filesystem content", mappings }, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ documents, approved, output }));
