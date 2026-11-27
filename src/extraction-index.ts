import type { QMDStore } from "@unblocklabs/qmd";
import type { CorpusMemorySearchResult } from "./contracts.js";
import { hasMemoryTable } from "./memory-database.js";
import { ExtractionStore, type ExtractedRecord } from "./extraction-store.js";

export const EXTRACTED_COLLECTION = "unblock-extracted";
export const EXTRACTED_PREFIX = `qmd://${EXTRACTED_COLLECTION}/`;
export function extractedPath(record: ExtractedRecord): string { return `${record.id}/${record.revision}`; }
export function extractedUri(record: ExtractedRecord): string { return `${EXTRACTED_PREFIX}${extractedPath(record)}`; }
export function extractedRecords(storePath: string, paths?: readonly string[]): ExtractedRecord[] {
  if (paths?.length === 0 || !hasMemoryTable(storePath, "extracted_memories")) return [];
  const store = new ExtractionStore(storePath);
  try { return store.records(undefined, paths); } finally { store.close(); }
}
export function extractedHit(record: ExtractedRecord, score: number): CorpusMemorySearchResult {
  return { path: extractedUri(record), startLine: 1, endLine: 1, score,
    snippet: record.text, corpus: "extracted", source: "memory", session: record.metadata,
    extracted: { id: record.id, revision: record.revision, observedAt: new Date(record.observedAt).toISOString() },
    citation: `session:${record.sessionId}#${record.evidence.map(e => e.messageId).join(",")}` };
}

/**
 * Single adapter for QMD's projected-collection API: no Markdown and no private SQL writes. The complete
 * published set replaces the collection atomically; retracted plaintext and vectors are cleaned up, then
 * the collection is embedded (incremental, and repairs interruptions between publication and embedding).
 */
export async function syncExtractedIndex(store: Pick<QMDStore, "syncProjectedCollection">, records: ExtractedRecord[]) {
  const documents = records.map(record => {
    const date = new Date(record.observedAt).toISOString();
    return { path: extractedPath(record), content: record.text, createdAt: date, modifiedAt: date };
  });
  return store.syncProjectedCollection(EXTRACTED_COLLECTION, documents, { embed: true, chunkStrategy: "semantic", cleanup: true });
}
