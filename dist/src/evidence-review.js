import { createHash } from "node:crypto";
import { parseSafeVirtualPath } from "./sources.js";
import { reviewTypeSafeClaim } from "./typesafe-review.js";
export async function reviewIndexedClaim(params) {
    const unavailable = (reason) => ({ status: "unavailable", verdict: "insufficient_evidence", needsReview: true, reason });
    if (!params.claim.trim() || params.claim.length > 2000 || !params.citations.length || params.citations.length > 3)
        return unavailable("Invalid review bounds");
    params.signal.throwIfAborted();
    const sources = new Map(params.sources.filter(source => source.kind !== "skills").map(source => [source.collection, source]));
    const read = params.read ?? (async (run) => run());
    const snapshot = await read(() => {
        const evidence = [];
        for (const citation of params.citations) {
            const safe = parseSafeVirtualPath(citation.path, sources);
            if (!safe || !Number.isInteger(citation.from) || citation.from < 1 || !Number.isInteger(citation.lines) || citation.lines < 1 || citation.lines > 120)
                return unavailable("Evidence is unavailable or outside approved corpora");
            const row = params.db.prepare(`SELECT d.hash, c.doc FROM documents d JOIN content c ON c.hash = d.hash
        WHERE d.active = 1 AND d.collection = ? AND d.path = ?`).get(safe.source.collection, safe.relativePath);
            if (!row)
                return unavailable("Evidence is not indexed");
            const lines = row.doc.split("\n");
            if (citation.from > lines.length)
                return unavailable("Evidence range is outside the indexed source");
            const text = lines.slice(citation.from - 1, citation.from - 1 + citation.lines).join("\n");
            if (!text.trim())
                return unavailable("Evidence range is empty");
            evidence.push({ path: safe.normalized, from: citation.from, lines: Math.min(citation.lines, lines.length - citation.from + 1),
                text, documentHash: row.hash, excerptHash: createHash("sha256").update(text).digest("hex") });
        }
        return { status: "ready", evidence };
    });
    if (snapshot.status !== "ready")
        return snapshot;
    const { evidence } = snapshot;
    if (evidence.reduce((sum, item) => sum + item.text.length, 0) > 6000)
        return unavailable("Evidence exceeds 6000 characters; choose a narrower complete passage");
    const judgment = await reviewTypeSafeClaim({ ...params, evidence: evidence.map(item => item.text) });
    params.signal.throwIfAborted();
    return read(() => {
        for (const item of evidence) {
            const safe = parseSafeVirtualPath(item.path, sources);
            if (!safe || !params.db.prepare("SELECT 1 FROM documents WHERE active = 1 AND collection = ? AND path = ? AND hash = ?")
                .get(safe.source.collection, safe.relativePath, item.documentHash))
                return unavailable("Indexed evidence changed during review; retry");
        }
        return { status: "ok", ...judgment,
            evidence: evidence.map(({ text: _text, ...citation }) => citation),
            policy: "jev-1.13.0:claim-v1", scope: "Advisory support check against cited indexed excerpts only, not current truth or authorization to write. Verify original sources and identity before promotion." };
    });
}
