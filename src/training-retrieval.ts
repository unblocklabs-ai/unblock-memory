import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { QMDStore } from "@unblocklabs/qmd";
import type { ChatType } from "./config.js";
import { readSessionManifest } from "./session-sync.js";
import type { SessionMessageSpan } from "./session-projector.js";
import { resolveSessionSource } from "./sources.js";
import { trainingCandidates } from "./training-candidates.js";

export const TRAINING_RETRIEVAL_VERSION = "qmd-2.10.1-historical-prefix-depth10-v2";
export const TRAINING_SEARCH_OPTIONS = { vector: 10, bm25: 10, mergedLimit: null, rerank: false } as const;
export type TrainingHit = { path: string; text: string; dates: string[]; position: number; score: number; methods: string[] };
type ChunkRow = { seq: number; pos: number; chunk_len: number; model: string; embed_fingerprint: string; embedding: Uint8Array };

/** Never infer dates by parsing message bodies: headings can be quoted or forged. */
export function historicalPrefix(body: string, spans: readonly SessionMessageSpan[] | undefined, cutoff: number) {
  if (!spans?.length || !body.startsWith("# Transcript\n\n") || !Number.isFinite(cutoff)) return;
  let previousEnd = 14;
  const parsed: { span: SessionMessageSpan; time: number }[] = [];
  for (const span of spans) {
    if (![span.start, span.bodyStart, span.end].every(Number.isSafeInteger) || span.start < previousEnd ||
        span.bodyStart <= span.start || span.end < span.bodyStart || span.end > body.length ||
        body.slice(previousEnd, span.start).trim()) return;
    const heading = `## ${span.type === "user" ? "User" : "Assistant"} — ${span.name} — ${span.timestamp}\n\n`;
    if (body.slice(span.start, span.bodyStart) !== heading) return;
    // Explicit zones only: no process-local timezone interpretation. Unknown zones fail closed.
    const time = typeof span.timestamp === "string" && / (?:UTC|GMT(?:[+-]\d{1,2}(?::\d{2})?)?|[ECMP][SD]T)$/u.test(span.timestamp)
      ? Date.parse(span.timestamp) : NaN;
    parsed.push({ span, time }); previousEnd = span.end;
  }
  if (body.slice(previousEnd).trim()) return;
  // Projection dates have second precision. Exclude the entire cutoff second,
  // including the current question, equal-time replies and crossing chunks.
  const before = Math.floor(cutoff / 1000) * 1000;
  const safe: typeof parsed = [];
  for (const item of parsed) {
    if (!Number.isFinite(item.time) || item.time >= before) break;
    safe.push(item);
  }
  if (!safe.length) return;
  return { body: body.slice(0, parsed[safe.length]?.span.start ?? body.length), spans: safe.map(s => s.span) };
}

/** A read-only source snapshot, copied into a disposable in-memory QMD index.
 * No filesystem projection, live-index mutation, model re-embedding or dependency patch. */
export async function historicalTrainingSearch(stateDir: string, chatTypes: readonly ChatType[], cutoff: number,
  openStore?: typeof import("@unblocklabs/qmd")["createStore"]) {
  const indexPath = join(stateDir, "index.sqlite");
  if (!existsSync(indexPath)) throw new Error("No QMD index; sync sessions before evaluating training queries");
  const manifest = await readSessionManifest(join(stateDir, "sessions-manifest.json"));
  const source = resolveSessionSource(join(stateDir, "sessions"), chatTypes);
  const createStore = openStore ?? (await import("@unblocklabs/qmd")).createStore;
  const qmd = await createStore({ dbPath: ":memory:", keepModelsWarm: true,
    config: { collections: { [source.collection]: { path: source.root, pattern: "**/*.md" } } } });
  // A snapshot has one native embedding context. Serialize its vector stage only;
  // QMD's remote TypeSafe scoring remains concurrent across all ten queries.
  const searchVec = qmd.internal.searchVec;
  let vectorTail = Promise.resolve();
  qmd.internal.searchVec = (...args) => {
    const result = vectorTail.then(() => searchVec(...args));
    vectorTail = result.then(() => {}, () => {});
    return result;
  };
  const db = qmd.internal.db;
  const maxDate = new Date(cutoff).toISOString();
  const report = { sessions: 0, chunks: 0, excluded: 0, truncated: 0, excludedChunks: 0 };
  const metadata = new Map<string, SessionMessageSpan[]>();
  const fingerprint = createHash("sha256").update(JSON.stringify([TRAINING_RETRIEVAL_VERSION, chatTypes.toSorted(), maxDate]));
  try {
    // QMD's SDK only opens writable stores. Use its exact SQLite binding in
    // read-only mode; mixing node:sqlite with better-sqlite3 corrupts sqlite-vec's
    // process-global SQLite API pointer when both load the native extension.
    const requireQmd = createRequire(import.meta.resolve("@unblocklabs/qmd"));
    const Database = requireQmd("better-sqlite3") as new (path: string, options: { readonly: true; fileMustExist: true }) => QMDStore["internal"]["db"];
    const sourceDb = new Database(indexPath, { readonly: true, fileMustExist: true });
    try {
      const extension: unknown = requireQmd("sqlite-vec");
      if (!extension || typeof extension !== "object" || !("getLoadablePath" in extension) || typeof extension.getLoadablePath !== "function") {
        throw new Error("QMD sqlite-vec extension unavailable");
      }
      const extensionPath: unknown = extension.getLoadablePath();
      if (typeof extensionPath !== "string") throw new Error("QMD sqlite-vec path unavailable");
      sourceDb.loadExtension(extensionPath);
      sourceDb.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
      db.exec("BEGIN");
      const settings = sourceDb.prepare("SELECT key,value FROM store_config WHERE key='embedding_chunk_strategy'").all<{ key: string; value: string }>();
      for (const { key, value } of settings) db.prepare("INSERT OR REPLACE INTO store_config VALUES (?,?)").run(key, value);
      fingerprint.update(JSON.stringify(settings));
      const document = sourceDb.prepare(`SELECT d.hash,c.doc FROM documents d JOIN content c ON c.hash=d.hash
        WHERE d.active=1 AND d.collection=? AND d.path=?`);
      const chunks = sourceDb.prepare(`SELECT cv.seq,cv.pos,cv.chunk_len,cv.model,cv.embed_fingerprint,v.embedding
        FROM content_vectors cv JOIN vectors_vec v ON v.hash_seq=cv.hash||'_'||cv.seq
        WHERE cv.hash=? ORDER BY cv.seq`);
      let dimensions: number | undefined;
      // Copy cooperatively: concurrent snapshots must not starve lease timers,
      // provider responses or native-model disposal. Keep the source transaction
      // open across yields so every row still comes from the same read snapshot.
      let yieldAt = performance.now() + 25;
      for (const session of Object.values(manifest.sessions).sort((a, b) => a.documentPath.localeCompare(b.documentPath))) {
        if (performance.now() >= yieldAt) { await yieldToEventLoop(); yieldAt = performance.now() + 25; }
        // Loggie projections can retroactively annotate old text using later revisions.
        // Workspace files and meetings lack immutable historical content proof here.
        if (!chatTypes.includes(session.chatType) || session.provider === "loggie" || session.startedAt >= cutoff) { report.excluded++; continue; }
        const row = document.get<{ hash: string; doc: string }>(source.collection, session.documentPath);
        if (!row || createHash("sha256").update(row.doc).digest("hex") !== session.projectionHash) { report.excluded++; continue; }
        const prefix = historicalPrefix(row.doc, session.messages, cutoff);
        if (!prefix) { report.excluded++; continue; }
        const hash = createHash("sha256").update(prefix.body).digest("hex");
        qmd.internal.insertContent(hash, prefix.body, maxDate);
        qmd.internal.insertDocument(source.collection, session.documentPath, "Transcript", hash, maxDate, maxDate);
        metadata.set(`qmd://${source.collection}/${session.documentPath}`, prefix.spans);
        fingerprint.update(JSON.stringify([session.documentPath, hash]));
        report.sessions++;
        if (prefix.spans.length < (session.messages?.length ?? 0)) report.truncated++;
        for (const chunk of chunks.iterate<ChunkRow>(row.hash)) {
          if (performance.now() >= yieldAt) { await yieldToEventLoop(); yieldAt = performance.now() + 25; }
          if (!Number.isSafeInteger(chunk.pos) || !Number.isSafeInteger(chunk.chunk_len) || chunk.pos < 0 || chunk.chunk_len <= 0 ||
              chunk.pos + chunk.chunk_len > prefix.body.length) { report.excludedChunks++; continue; }
          const bytes = Buffer.from(chunk.embedding);
          if (bytes.length % 4 || !bytes.length) throw new Error("Invalid historical embedding");
          const size = bytes.length / 4;
          if (dimensions === undefined) { dimensions = size; qmd.internal.ensureVecTable(size); }
          if (dimensions !== size) throw new Error("Mixed historical embedding dimensions");
          const vector = new Float32Array(size);
          for (let i = 0; i < size; i++) vector[i] = bytes.readFloatLE(i * 4);
          qmd.internal.insertEmbedding(hash, chunk.seq, chunk.pos, vector, chunk.model, maxDate, 1, chunk.embed_fingerprint, chunk.chunk_len);
          fingerprint.update(JSON.stringify([chunk.seq, chunk.pos, chunk.chunk_len, chunk.model, chunk.embed_fingerprint])).update(bytes);
          report.chunks++;
        }
      }
      db.exec("COMMIT");
    } finally { sourceDb.close(); }
    const corpusHash = fingerprint.digest("hex");
    return { corpusHash, report, maxDate,
      search: async (query: string): Promise<TrainingHit[]> => {
        if (!report.sessions) return [];
        if (!report.chunks) throw new Error("Historical snapshot has no vectors; refusing a BM25-only evaluation");
        const hits = await trainingCandidates(qmd, query, source.collection,
          `Historical request made at ${maxDate}. Current, now and latest refer to that timestamp.`);
        return hits.map(hit => trainingHit(hit, metadata, cutoff));
      }, close: () => qmd.close() };
  } catch (error) { await qmd.close(); throw error; }
}

function trainingHit(hit: Awaited<ReturnType<typeof trainingCandidates>>[number], metadata: ReadonlyMap<string, SessionMessageSpan[]>, cutoff: number): TrainingHit {
  const spans = metadata.get(hit.file)?.filter(s => s.start < hit.bestChunkPos + hit.bestChunk.length && s.end > hit.bestChunkPos);
  if (!spans?.length || spans.some(s => !(Date.parse(s.timestamp) < Math.floor(cutoff / 1000) * 1000)) ||
      hit.body.slice(hit.bestChunkPos, hit.bestChunkPos + hit.bestChunk.length) !== hit.bestChunk) {
    throw new Error("QMD returned evidence outside the historical snapshot");
  }
  return { path: hit.file, position: hit.bestChunkPos, text: hit.bestChunk, dates: [...new Set(spans.map(s => s.timestamp))],
    score: hit.score, methods: hit.explain?.methods ?? [] };
}
