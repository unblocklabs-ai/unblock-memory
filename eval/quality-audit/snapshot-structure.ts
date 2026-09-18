// Run on the corpus host. Keep this private snapshot outside repositories/workspaces.
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveConfig } from "../../src/config.js";
import { resolveSources, resolveSessionSource, parseSafeVirtualPath } from "../../src/sources.js";
import { chunkFingerprint } from "../../src/curation.js";
import { qualityStructure } from "../../src/quality-audit.js";

const [configPath, workspace, stateDir, output] = process.argv.slice(2);
if (!configPath || !workspace || !stateDir || !output) throw new Error("Usage: snapshot config workspace state-dir output");
process.umask(0o077);
const config = resolveConfig(JSON.parse(await readFile(configPath, "utf8")).plugins.entries["unblock-memory"].config);
if (!config.qualityAudit.enabled || !config.typesafe.enabled) throw new Error("Audit approval required");
const approved = config.corpora.filter(c => config.qualityAudit.corpora.includes(c.name));
const sources = new Map(resolveSources(workspace, approved.filter(c => c.kind === "files"))
  .map(source => [source.collection, source]));
const sessions = approved.find(c => c.kind === "sessions");
if (sessions?.kind === "sessions") {
  const source = resolveSessionSource(join(stateDir, "sessions"), sessions.chatTypes);
  sources.set(source.collection, source);
}
const db = new DatabaseSync(join(stateDir, "index.sqlite"), { readOnly: true });
const curation = new DatabaseSync(join(stateDir, "curation.sqlite"), { readOnly: true });
type Item = { kind: "quality"; id: string; corpus: string; text: string; sourceKind: "files" | "sessions";
  structuralFlag: boolean; baselineNoise?: number; source: string; seq: number; hash: string };
const pools = new Map<string, Map<string, Item>>();
try {
  db.exec("BEGIN");
  const docs = db.prepare("SELECT id, collection, path, hash FROM documents WHERE active = 1 ORDER BY id").all();
  const content = db.prepare("SELECT doc FROM content WHERE hash = ?");
  const chunks = db.prepare("SELECT seq, pos, chunk_len FROM content_vectors WHERE hash = ? ORDER BY seq");
  const cached = curation.prepare("SELECT noise FROM quality_judgments WHERE cache_key = ?");
  for (const doc of docs) {
    const source = sources.get(String(doc.collection));
    if (!source || !parseSafeVirtualPath(`qmd://${source.collection}/${doc.path}`, sources)) continue;
    const body = content.get(doc.hash)?.doc;
    if (typeof body !== "string") continue;
    const pool = pools.get(source.corpus) ?? new Map<string, Item>();
    pools.set(source.corpus, pool);
    for (const chunk of chunks.all(doc.hash)) {
      const pos = Number(chunk.pos), len = Number(chunk.chunk_len);
      if (pos < 0 || len <= 0 || len > 6000 || pos + len > body.length) continue;
      const text = body.slice(pos, pos + len);
      const fingerprint = chunkFingerprint(text);
      const key = chunkFingerprint(JSON.stringify(["jev-1.13.0:quality-v1", source.kind, fingerprint]));
      const judgment = cached.get(key);
      const structure = qualityStructure(text);
      pool.set(fingerprint, { kind: "quality", id: `${source.corpus}:${fingerprint}`, corpus: source.corpus, text,
        sourceKind: source.kind === "sessions" ? "sessions" : "files",
        structuralFlag: structure === "empty" || structure === "encoded_message",
        baselineNoise: judgment ? Number(judgment.noise) : undefined,
        source: `qmd://${source.collection}/${doc.path}`, seq: Number(chunk.seq), hash: String(doc.hash) });
    }
  }
  db.exec("COMMIT");
} finally { db.close(); curation.close(); }
const selected: (Item & { cohort: string })[] = [];
for (const [corpus, pool] of pools) {
  const sorted = [...pool.values()].sort((a, b) => a.id.localeCompare(b.id));
  const random = sorted.slice(0, 100);
  const seen = new Set(random.map(item => item.id));
  selected.push(...random.map(item => ({ ...item, cohort: "corpus_sample" })));
  // Diagnostic enrichment is reported separately, never as prevalence/accuracy.
  const enriched = sorted.filter(item => !seen.has(item.id) && (item.baselineNoise ?? 0) >= 0.65).slice(0, 40);
  selected.push(...enriched.map(item => ({ ...item, cohort: "baseline_noise_enriched" })));
  console.log(JSON.stringify({ corpus, uniqueEligible: pool.size, sample: random.length, enriched: enriched.length }));
}
await writeFile(output, JSON.stringify(selected, null, 2) + "\n", { flag: "wx", mode: 0o600 });
