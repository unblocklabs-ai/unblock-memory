import { randomUUID } from "node:crypto";
import type { QMDStore } from "@unblocklabs/qmd";

// Discovery-only adapter for pinned @unblocklabs/qmd 2.10.1 (MIT, query.js).
// Keep its tokenization, FTS highlights, chunk choice and source-aware dedup.
// Unlike search(), request exactly ten per method and return ALL merged passages.
// No dependency rewriting, query expansion or query-conditioned remote scoring.
type Chunk = { pos: number; text: string };
type Candidate = { file: string; body: string; bestChunk: string; bestChunkPos: number;
  score: number; explain: { methods: string[] };
  vector?: { score: number; rank: number }; bm25?: { score: number; rank: number } };
type ChunkApi = {
  normalizeCjkForFTS: (text: string) => string;
  getStoredChunkSpans: (db: QMDStore["internal"]["db"], hash: string) => { pos: number; chunk_len: number }[];
  chunkDocumentAsync: (body: string, max?: number, overlap?: number, window?: number, path?: string) => Promise<Chunk[]>;
};
const stopWords = new Set("a an and are as at be by can did do does for from how i in is it of on or that the their this to was were what when where which who why will with you".split(" "));
function queryTerms(query: string) {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  const meaningful = words.filter(word => !stopWords.has(word));
  return (meaningful.length ? meaningful : words).slice(0, 64);
}
function lexicalChunk(chunks: Chunk[], body: string, highlighted: string, marker: string, intent: string) {
  const compactLength = (text: string) => text.replace(/\s/gu, "").length;
  const ranges: { start: number; end: number }[] = [];
  let offset = 0;
  for (const [i, part] of highlighted.split(marker).entries()) {
    const end = offset + compactLength(part);
    if (i % 2 === 1) ranges.push({ start: offset, end });
    offset = end;
  }
  const intentTerms = queryTerms(intent);
  let sourcePos = 0, compactPos = 0;
  return chunks.map(chunk => {
    compactPos += compactLength(body.slice(sourcePos, chunk.pos));
    sourcePos = chunk.pos;
    const end = compactPos + compactLength(chunk.text);
    const matches = ranges.reduce((sum, range) => sum + Math.max(0, Math.min(end, range.end) - Math.max(compactPos, range.start)) / Math.max(1, range.end - range.start), 0);
    const lower = chunk.text.toLowerCase();
    return { chunk, matches, intentMatches: intentTerms.filter(term => lower.includes(term)).length };
  }).sort((a, b) => b.matches - a.matches || b.intentMatches - a.intentMatches || a.chunk.pos - b.chunk.pos)[0]?.chunk;
}

export async function trainingCandidates(qmd: QMDStore, query: string, collection: string | string[], intent: string, signal?: AbortSignal): Promise<Candidate[]> {
  signal?.throwIfAborted();
  if (!query.trim() || query.length > 12_000) throw new Error("Invalid training query");
  // QMD exposes its store but not these chunk helpers at the package root.
  // Resolve relative to its installed SDK, never a global QMD or modified copy.
  const chunksApi = await import(new URL("./store.js", import.meta.resolve("@unblocklabs/qmd")).href) as ChunkApi;
  const candidates = new Map<string, Candidate>();
  const add = (hit: Omit<Candidate, "score" | "explain">, method: "vector" | "bm25", rank: number, rawScore: number) => {
    if (!hit.bestChunk.trim() || hit.bestChunk.length > 12_000) return;
    const key = JSON.stringify([hit.file, hit.bestChunk.trim()]), existing = candidates.get(key);
    if (existing) {
      if (!existing.explain.methods.includes(method)) existing.explain.methods.push(method);
      existing.score = Math.max(existing.score, 1 / (rank + 1));
      existing[method] ??= { score: rawScore, rank: rank + 1 };
    } else candidates.set(key, { ...hit, score: 1 / (rank + 1), explain: { methods: [method] },
      [method]: { score: rawScore, rank: rank + 1 } });
  };
  const vectors = await qmd.searchVector(query, { limit: 10, collection });
  signal?.throwIfAborted();
  for (const [rank, hit] of vectors.entries()) {
    const pos = hit.chunkPos, len = hit.chunkLen, body = hit.body ?? "";
    if (pos === undefined || len === undefined || pos < 0 || len <= 0 || pos + len > body.length) continue;
    add({ file: hit.filepath, body, bestChunk: body.slice(pos, pos + len), bestChunkPos: pos }, "vector", rank, hit.score);
  }
  const expression = queryTerms(query).map(term => `"${chunksApi.normalizeCjkForFTS(term).trim()}"`).join(" OR ");
  if (expression) {
    const marker = `qmd-match-${randomUUID()}`;
    const rows = qmd.internal.db.prepare(`SELECT d.collection,d.path,d.hash,c.doc,
      bm25(documents_fts,1.5,4.0,1.0) AS rank, highlight(documents_fts,2,?,?) AS highlighted
      FROM documents_fts JOIN documents d ON d.id=documents_fts.rowid JOIN content c ON c.hash=d.hash
      WHERE documents_fts MATCH ? AND d.active=1 AND d.collection IN (SELECT value FROM json_each(?))
      ORDER BY rank,d.collection,d.path LIMIT 10`).all<{
        collection: string; path: string; hash: string; doc: string; rank: number; highlighted: string;
      }>(marker, marker, expression, JSON.stringify(typeof collection === "string" ? [collection] : collection));
    for (const [rank, row] of rows.entries()) {
      signal?.throwIfAborted();
      const file = `qmd://${row.collection}/${row.path}`;
      const stored = chunksApi.getStoredChunkSpans(qmd.internal.db, row.hash)
        .filter(span => span.pos >= 0 && span.chunk_len > 0 && span.pos + span.chunk_len <= row.doc.length)
        .map(span => ({ pos: span.pos, text: row.doc.slice(span.pos, span.pos + span.chunk_len) }));
      const chunks = stored.length ? stored : await chunksApi.chunkDocumentAsync(row.doc, undefined, undefined, undefined, file);
      const selected = lexicalChunk(chunks, row.doc, row.highlighted, marker, intent);
      if (selected) add({ file, body: row.doc, bestChunk: selected.text, bestChunkPos: selected.pos }, "bm25", rank, row.rank);
    }
  }
  return [...candidates.values()].sort((a, b) => b.score - a.score);
}
