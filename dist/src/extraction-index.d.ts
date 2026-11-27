import type { QMDStore } from "@unblocklabs/qmd";
import type { CorpusMemorySearchResult } from "./contracts.js";
import { type ExtractedRecord } from "./extraction-store.js";
export declare const EXTRACTED_COLLECTION = "unblock-extracted";
export declare const EXTRACTED_PREFIX = "qmd://unblock-extracted/";
export declare function extractedPath(record: ExtractedRecord): string;
export declare function extractedUri(record: ExtractedRecord): string;
export declare function extractedRecords(storePath: string, paths?: readonly string[]): ExtractedRecord[];
export declare function extractedHit(record: ExtractedRecord, score: number): CorpusMemorySearchResult;
/**
 * Single adapter for QMD's projected-collection API: no Markdown and no private SQL writes. The complete
 * published set replaces the collection atomically; retracted plaintext and vectors are cleaned up, then
 * the collection is embedded (incremental, and repairs interruptions between publication and embedding).
 */
export declare function syncExtractedIndex(store: Pick<QMDStore, "syncProjectedCollection">, records: ExtractedRecord[]): Promise<{
    upserted: number;
    unchanged: number;
    retracted: number;
    embedded: number;
    generation: number;
}>;
