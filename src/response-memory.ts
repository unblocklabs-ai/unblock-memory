import { DEFAULTS } from "./defaults.js";
import { DatabaseSync } from "node:sqlite";
import type { ResolvedSource } from "./sources.js";
import type { ResponseEpisode } from "./response-episodes.js";

const queryTerms = new RegExp(`[\\p{L}\\p{N}_-]{${DEFAULTS.responseAudit.memoryQueryMinTermChars},}`, "gu");

/** Current-index investigation only. No QMD manager startup, re-indexing or historical claims. */
export function responseMemoryCandidates(indexPath: string, sources: readonly ResolvedSource[], episode: ResponseEpisode) {
  if (!sources.length) return [];
  const text = [...episode.request, ...episode.feedback].map(m => m.text).join(" ");
  const words = [...new Set(text.toLowerCase().match(queryTerms) ?? [])]
    .filter(w => !["that", "this", "with", "have", "what", "please", "could", "would", "should", "about", "from", "your", "there", "already"].includes(w))
    .slice(0, DEFAULTS.responseAudit.memoryQueryMaxTerms);
  if (!words.length) return [];
  const query = words.map(w => `"${w}"`).join(" OR ");
  const db = new DatabaseSync(indexPath, { readOnly: true });
  try {
    db.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${DEFAULTS.sqlite.readerBusyTimeoutMs}`);
    // Whole short indexed documents only: never call a truncated excerpt complete evidence.
    const rows = db.prepare(`SELECT d.collection,d.path,d.hash,c.doc text
      FROM documents_fts JOIN documents d ON d.id=documents_fts.rowid JOIN content c ON c.hash=d.hash
      WHERE documents_fts MATCH ? AND d.active=1 AND d.collection IN (${sources.map(() => "?").join(",")})
      AND length(c.doc)<=? ORDER BY bm25(documents_fts) LIMIT ?`).all(
      query, ...sources.map(s => s.collection), DEFAULTS.responseAudit.memoryCandidateMaxDocChars, DEFAULTS.responseAudit.memoryCandidateLimit);
    return rows.map(row => ({ path: `qmd://${row.collection}/${row.path}`, text: String(row.text), hash: String(row.hash) }));
  } finally { db.close(); }
}
