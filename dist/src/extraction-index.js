import { createHash } from "node:crypto";
import { hasMemoryTable } from "./memory-database.js";
import { ExtractionStore } from "./extraction-store.js";
export const EXTRACTED_COLLECTION = "unblock-extracted";
export function extractedPath(record) { return `${record.id}/${record.revision}`; }
export function extractedRecords(storePath, paths) {
    if (!hasMemoryTable(storePath, "extracted_memories"))
        return [];
    const store = new ExtractionStore(storePath);
    try {
        return store.records(undefined, paths);
    }
    finally {
        store.close();
    }
}
export function extractedHit(record, score) {
    return { path: `qmd://${EXTRACTED_COLLECTION}/${extractedPath(record)}`, startLine: 1, endLine: 1, score,
        snippet: record.text, corpus: "extracted", source: "memory", session: record.metadata,
        extracted: { id: record.id, revision: record.revision, observedAt: new Date(record.observedAt).toISOString() },
        citation: `session:${record.sessionId}#${record.evidence.map(e => e.messageId).join(",")}` };
}
/** Single adapter for QMD's documented advanced store API; no Markdown and no private SQL writes. */
export async function syncExtractedIndex(store, records) {
    const internal = store.internal;
    const wanted = new Set(records.map(extractedPath));
    for (const path of internal.getActiveDocumentPaths(EXTRACTED_COLLECTION)) {
        if (!wanted.has(path))
            internal.deactivateDocument(EXTRACTED_COLLECTION, path);
    }
    for (const record of records) {
        const path = extractedPath(record);
        const hash = createHash("sha256").update(record.text).digest("hex");
        const date = new Date(record.observedAt).toISOString();
        if (internal.findActiveDocument(EXTRACTED_COLLECTION, path)?.hash === hash)
            continue;
        internal.insertContent(hash, record.text, date);
        internal.insertDocument(EXTRACTED_COLLECTION, path, record.text, hash, date, date);
    }
    // embed() is itself incremental and repairs interruptions between insert and embedding.
    const result = await store.embed({ collection: EXTRACTED_COLLECTION, chunkStrategy: "semantic" });
    if (result.errors)
        throw new Error("QMD failed to embed extracted memories");
}
