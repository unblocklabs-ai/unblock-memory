import { DatabaseSync } from "node:sqlite";
/** Current-index investigation only. No QMD manager startup, re-indexing or historical claims. */
export function responseMemoryCandidates(indexPath, sources, episode) {
    if (!sources.length)
        return [];
    const text = [...episode.request, ...episode.feedback].map(m => m.text).join(" ");
    const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? [])]
        .filter(w => !["that", "this", "with", "have", "what", "please", "could", "would", "should", "about", "from", "your", "there", "already"].includes(w)).slice(0, 16);
    if (!words.length)
        return [];
    const query = words.map(w => `"${w}"`).join(" OR ");
    const db = new DatabaseSync(indexPath, { readOnly: true });
    try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
        // Whole short indexed documents only: never call a truncated excerpt complete evidence.
        const rows = db.prepare(`SELECT d.collection,d.path,d.hash,c.doc text
      FROM documents_fts JOIN documents d ON d.id=documents_fts.rowid JOIN content c ON c.hash=d.hash
      WHERE documents_fts MATCH ? AND d.active=1 AND d.collection IN (${sources.map(() => "?").join(",")})
      AND length(c.doc)<=2000 ORDER BY bm25(documents_fts) LIMIT 3`).all(query, ...sources.map(s => s.collection));
        return rows.map(row => ({ path: `qmd://${row.collection}/${row.path}`, text: String(row.text), hash: String(row.hash) }));
    }
    finally {
        db.close();
    }
}
