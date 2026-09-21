import { randomUUID } from "node:crypto";
import type { AllowedDocumentPaths, QMDStore, VectorSearchResult } from "@unblocklabs/qmd";

// Natural-language lexical recall, not an FTS expression supplied by the caller.
const stopWords = new Set("a an and are as at be by can did do does for from how i in is it of on or that the their this to was were what when where which who why will with you".split(" "));
const compactLength = (text: string) => text.replace(/\s/gu, "").length;

/** QMD's document BM25 index, scoped BEFORE LIMIT. Select a complete stored chunk
 * for judging instead of transmitting a potentially enormous session document. */
export function xsearchBm25(db: QMDStore["internal"]["db"], query: string,
  collections: readonly string[], limit: number, allowedPaths?: AllowedDocumentPaths): VectorSearchResult[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  const meaningful = words.filter(word => !stopWords.has(word));
  const terms = (meaningful.length ? meaningful : words).slice(0, 64);
  if (!terms.length || !collections.length) return [];
  const fts = terms.map(term => `"${term}"`).join(" OR ");
  const marker = randomUUID();
  const rows = db.prepare(`SELECT d.collection, d.path, d.hash, d.title, c.doc,
      bm25(documents_fts, 1.5, 4.0, 1.0) AS rank,
      highlight(documents_fts, 2, ?, ?) AS highlighted
    FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
      JOIN content c ON c.hash = d.hash
    WHERE documents_fts MATCH ? AND d.active = 1
      AND d.collection IN (SELECT value FROM json_each(?))
      AND (NOT EXISTS (SELECT 1 FROM json_each(?) scope WHERE scope.key = d.collection)
        OR EXISTS (SELECT 1 FROM json_each(?) scope, json_each(scope.value) paths
          WHERE scope.key = d.collection AND paths.value = d.path))
    ORDER BY rank, d.collection, d.path LIMIT ?`).all<{
      collection: string; path: string; hash: string; title: string; doc: string; rank: number; highlighted: string;
    }>(marker, marker, fts, JSON.stringify(collections), JSON.stringify(allowedPaths ?? {}), JSON.stringify(allowedPaths ?? {}), limit);
  const chunks = db.prepare("SELECT pos, chunk_len FROM content_vectors WHERE hash = ? ORDER BY pos, seq");
  return rows.flatMap(row => {
    const spans = chunks.all<{ pos: number; chunk_len: number }>(row.hash)
      .filter(span => span.pos >= 0 && span.chunk_len > 0 && span.pos + span.chunk_len <= row.doc.length);
    if (!spans.length) return []; // No invented/truncated chunk; indexing may still be pending.
    // FTS adds spaces around CJK characters. Compare whitespace-free offsets so
    // its actual stemmed/normalized matches map back to unchanged source spans.
    const ranges: { start: number; end: number }[] = [];
    let offset = 0;
    for (const [i, part] of row.highlighted.split(marker).entries()) {
      const end = offset + compactLength(part);
      if (i % 2 === 1) ranges.push({ start: offset, end });
      offset = end;
    }
    let sourcePos = 0, compactPos = 0;
    const selected = spans.map(span => {
      const text = row.doc.slice(span.pos, span.pos + span.chunk_len);
      compactPos += compactLength(row.doc.slice(sourcePos, span.pos));
      sourcePos = span.pos;
      const end = compactPos + compactLength(text);
      const matches = ranges.reduce((sum, range) => sum + Math.max(0,
        Math.min(end, range.end) - Math.max(compactPos, range.start)) / Math.max(1, range.end - range.start), 0);
      return { ...span, text, matches };
    }).sort((a, b) => b.matches - a.matches || a.pos - b.pos)[0]!;
    return [{ file: `qmd://${row.collection}/${row.path}`, displayPath: `${row.collection}/${row.path}`,
      title: row.title, body: row.doc, score: Math.abs(row.rank) / (1 + Math.abs(row.rank)),
      context: null, docid: row.hash.slice(0, 6), bestChunk: selected.text,
      chunkPos: selected.pos, chunkLen: selected.chunk_len }];
  });
}
