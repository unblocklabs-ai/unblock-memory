import { DEFAULTS } from "./defaults.js";
import { chunkFingerprint } from "./curation.js";
import { parseSafeVirtualPath } from "./sources.js";
import { judgeQuality, qualityJudgeVersion } from "./decision-ranking.js";
import { packDecisionState } from "./decision-packs.js";
import { qualityTriage } from "./quality-triage.js";
const MAX_CHUNK_CHARS = DEFAULTS.quality.gradeMaxChars;
/** A formatting clue, never proof that JSON or structured data is worthless. */
export function qualityStructure(text) {
    if (!text.trim())
        return "empty";
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return "plain_or_structured";
    }
    const encoded = typeof value === "string";
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        }
        catch {
            return "plain_or_structured";
        }
    }
    return value && typeof value === "object" && !Array.isArray(value) &&
        "role" in value && "content" in value && typeof value.role === "string"
        ? encoded ? "encoded_message" : "serialized_message" : "plain_or_structured";
}
/** Task reason and detail indicator recorded for each structure. */
const STRUCTURE_FLAGS = {
    empty: { reason: "empty_content", indicator: "deterministic_empty" },
    encoded_message: { reason: "possible_double_encoded_message", indicator: "deterministic_encoding" },
    serialized_message: { reason: "possible_serialized_message", indicator: "decision" },
    plain_or_structured: { reason: "possible_ingestion_noise", indicator: "decision" },
};
/** Synchronous capture: content is hash-addressed, so nothing here yields before inference. */
function captureCandidate(row, source, policy, sources, curation) {
    const text = row.doc.slice(row.pos, row.pos + row.chunk_len);
    const fingerprint = chunkFingerprint(text);
    const cacheKey = chunkFingerprint(JSON.stringify([policy, source.kind, fingerprint]));
    const eligible = Boolean(parseSafeVirtualPath(`qmd://${source.collection}/${row.path}`, sources)) && row.pos >= 0 && row.chunk_len > 0 &&
        row.pos + row.chunk_len <= row.doc.length;
    const structure = qualityStructure(text);
    const judgment = eligible && text.length <= MAX_CHUNK_CHARS
        ? curation.qualityJudgment(cacheKey) : undefined;
    const sourceKind = source.kind === "sessions" ? "sessions" : "files";
    return { row, source, text, chunk: { text, sourceKind }, fingerprint, cacheKey, structure, judgment, eligible };
}
/** Judges uncached candidates; returns fulfilled answers (failed packs are dropped) and over-budget cache keys. */
async function inferMissingJudgments(batch, options) {
    const missing = [...new Map(batch.filter(item => item.eligible && item.text.length <= MAX_CHUNK_CHARS &&
            item.structure !== "empty" && !item.judgment).map(item => [item.cacheKey, item])).values()];
    const packs = packDecisionState(missing, DEFAULTS.quality.judgeBatchSize, DEFAULTS.quality.judgeBatchMaxStateBytes, items => ({ chunks: items.map(item => item.chunk) }));
    const oversized = new Set();
    const jobs = [];
    for (const { items, state } of packs) {
        if (state)
            jobs.push(judgeQuality({
                apiKey: options.apiKey, endpoint: options.endpoint, model: options.model, timeoutMs: options.timeoutMs,
                signal: options.signal, chunks: state.chunks,
            }).then(answers => items.map(({ cacheKey, row }, index) => ({ cacheKey, row, judgment: answers[index] }))));
        else
            oversized.add(items[0].cacheKey);
    }
    const settled = await Promise.allSettled(jobs);
    const answers = settled.flatMap(answer => answer.status === "fulfilled" ? answer.value : []);
    return { answers, oversized };
}
export async function auditQualityPage(params) {
    const { db, curation, signal } = params;
    const policy = qualityJudgeVersion(params.model, params.endpoint);
    const sources = new Map(params.sources.filter(source => source.kind !== "skills")
        .map(source => [source.collection, source]));
    const groups = new Map();
    let scanned = 0, judged = 0, cached = 0, skippedOversized = 0, skippedStale = 0, flagged = 0;
    let next = params.after;
    const result = (status, done) => ({
        status, done, next, scanned, judged, cached, skippedOversized, skippedStale, flagged,
        groups: [...groups.values()].sort((a, b) => Number(b.triage === "preserve_evidence_repair") - Number(a.triage === "preserve_evidence_repair")),
        policy,
        scope: "Indexed chunks only; not a whole-source audit. Findings are indicators, not permission to modify data.",
    });
    const check = () => {
        signal.throwIfAborted();
        if (!params.isActive())
            throw new Error("audit stopped");
    };
    check();
    if (!sources.size)
        return result("ok", true);
    const limit = Math.max(1, Math.min(20, Math.floor(params.limit ?? 10)));
    const rows = db.prepare(`SELECT d.id AS document_id, cv.seq, d.collection, d.path,
      d.hash, cv.pos, cv.chunk_len
    FROM documents d JOIN content c ON c.hash = d.hash JOIN content_vectors cv ON cv.hash = d.hash
    WHERE d.active = 1 AND d.collection IN (${[...sources].map(() => "?").join(",")})
      AND (d.id > ? OR (d.id = ? AND cv.seq > ?))
    ORDER BY d.id, cv.seq LIMIT ?`).all(...sources.keys(), params.after?.documentId ?? 0, params.after?.documentId ?? 0, params.after?.seq ?? -1, limit + 1);
    const current = db.prepare(`SELECT 1 FROM documents d JOIN content_vectors cv ON cv.hash = d.hash
    WHERE d.id = ? AND d.active = 1 AND d.collection = ? AND d.path = ? AND d.hash = ?
      AND cv.seq = ? AND cv.pos = ? AND cv.chunk_len = ?`);
    /** The indexed occurrence still matches what was captured (re-checked after every yield). */
    const isCurrent = (row) => Boolean(current.get(row.document_id, row.collection, row.path, row.hash, row.seq, row.pos, row.chunk_len));
    const page = rows.slice(0, limit);
    const bodies = new Map();
    const readBody = db.prepare("SELECT doc FROM content WHERE hash = ?");
    try {
        check();
        const batch = page.map(metadata => {
            let doc = bodies.get(metadata.hash);
            if (doc === undefined) {
                doc = readBody.get(metadata.hash).doc;
                bodies.set(metadata.hash, doc);
            }
            const row = { ...metadata, doc };
            return captureCandidate(row, sources.get(row.collection), policy, sources, curation);
        });
        const { answers, oversized } = await inferMissingJudgments(batch, params);
        check();
        const fresh = new Map();
        for (const { cacheKey, row, judgment } of answers) {
            if (!isCurrent(row))
                continue;
            fresh.set(cacheKey, judgment);
            // Keep successful sibling judgments even if the cursor stops at a failed candidate.
            curation.cacheQualityJudgment(cacheKey, judgment);
            judged++;
        }
        // Replay in inbox order; the cursor advances only once each occurrence is fully processed.
        for (const item of batch) {
            check();
            const { row, source, text, fingerprint, cacheKey, structure } = item;
            const advance = () => { next = { documentId: row.document_id, seq: row.seq }; };
            scanned++;
            if (!item.eligible || !parseSafeVirtualPath(`qmd://${source.collection}/${row.path}`, sources) || !isCurrent(row)) {
                skippedStale++;
                advance();
                continue;
            }
            if (text.length > MAX_CHUNK_CHARS || oversized.has(cacheKey)) {
                skippedOversized++;
                advance();
                continue;
            }
            const judgment = structure === "empty"
                ? { noise: 1, evidence: 0 } : item.judgment ?? fresh.get(cacheKey);
            if (!judgment)
                throw new Error("missing quality judgment");
            if (item.judgment)
                cached++;
            if (structure !== "empty" && structure !== "encoded_message" && judgment.noise < params.minNoise) {
                advance();
                continue;
            }
            const { reason, indicator } = STRUCTURE_FLAGS[structure];
            const startLine = row.doc.slice(0, row.pos).split("\n").length;
            const endLine = startLine + text.split("\n").length - 1;
            const triage = qualityTriage(judgment.noise, judgment.evidence, structure === "encoded_message");
            const task = curation.addTask({
                type: "quality_review", corpus: source.corpus, collection: source.collection,
                path: row.path, reason, contentFingerprint: fingerprint,
                detail: JSON.stringify({
                    path: `qmd://${source.collection}/${row.path}`, from: startLine, to: endLine,
                    excerpt: text.slice(0, DEFAULTS.quality.previewChars), excerptTruncated: text.length > DEFAULTS.quality.previewChars,
                    indicator,
                    ...judgment, policy,
                    triage,
                    instruction: "Inspect original source and ingestion before acting. Verify source/index after any authorized repair. Never manually edit generated session projections.",
                }),
            });
            flagged++;
            advance();
            if (task.status !== "pending")
                continue;
            const key = JSON.stringify([source.collection, reason, triage]);
            const group = groups.get(key) ?? {
                corpus: source.corpus, source: source.configuredPath, reason, triage, pending: 0, examples: [],
            };
            group.pending++;
            if (group.examples.length < 3)
                group.examples.push(task);
            groups.set(key, group);
        }
        return result("ok", rows.length <= limit);
    }
    catch {
        // Cursor remains at the last completed occurrence; retry unfinished work safely.
        return { ...result("partial", false), error: "Audit interrupted or judgment unavailable; retry from next (or the beginning when absent)." };
    }
}
