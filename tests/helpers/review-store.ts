import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type QMDStore } from "@unblocklabs/qmd";
import { resolveSource, type ResolvedSource } from "../../src/sources.js";
import { CurationStore } from "../../src/curation.js";
import { ensureMemoryAnalysisSchema, clusterReference } from "../../src/analysis.js";

export async function reviewFixture(): Promise<{
  db: QMDStore["internal"]["db"]; store: QMDStore; source: ResolvedSource; curation: CurationStore;
  insert(text: string, collection?: string): Promise<{ hash: string; path: string; uri: string; text: string }>;
  cluster(hashes: string[]): string;
  params: { db: QMDStore["internal"]["db"]; sources: ResolvedSource[]; apiKey: string; timeoutMs: number; signal: AbortSignal };
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "unblock-review-"));
  const source = resolveSource(root, "memory/**/*.md", "memory");
  await mkdir(source.root, { recursive: true });
  const store = await createStore({ dbPath: join(root, "index.sqlite"), config: { collections: {} } });
  const db = store.internal.db;
  const curation = new CurationStore(join(root, "curation.sqlite"));
  ensureMemoryAnalysisSchema(db);
  let count = 0;
  const insert = async (text: string, collection = source.collection) => {
    const hash = `hash-${++count}`, path = `note-${count}.md`;
    await writeFile(join(source.root, path), text);
    db.prepare("INSERT INTO content(hash, doc, created_at) VALUES (?, ?, 'now')").run(hash, text);
    db.prepare(`INSERT INTO documents(collection, path, title, hash, created_at, modified_at, active)
      VALUES (?, ?, 'Note', ?, 'now', 'now', 1)`).run(collection, path, hash);
    db.prepare(`INSERT INTO content_vectors(hash, seq, pos, chunk_len, model, embedded_at)
      VALUES (?, 0, 0, ?, 'model', 'now')`).run(hash, text.length);
    return { hash, path, uri: `qmd://${collection}/${path}`, text };
  };
  const cluster = (hashes: string[]) => {
    db.prepare(`INSERT INTO memory_analysis_runs VALUES ('run', 'now', 'done', 'digest', 'model', 'fingerprint', 768, '{}', NULL)`).run();
    db.prepare("INSERT INTO memory_analysis_clusters VALUES ('run', 1, ?, 0.8)").run(hashes.length);
    hashes.forEach((hash, i) => db.prepare("INSERT INTO memory_analysis_memberships VALUES ('run', ?, 0, 1, ?, 0.1, 0, 0, ?)")
      .run(hash, 1 - i / hashes.length, i + 1));
    return clusterReference("run", 1);
  };
  return { db, store, source, curation, insert, cluster,
    params: { db, sources: [source], apiKey: "fake-secret", timeoutMs: 1000, signal: new AbortController().signal },
    close: async () => { curation.close(); await store.close(); },
  };
}
