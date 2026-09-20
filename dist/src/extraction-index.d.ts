import type { QMDStore } from "@unblocklabs/qmd";
import type { CorpusMemorySearchResult } from "./contracts.js";
import { type ExtractedRecord } from "./extraction-store.js";
export declare const EXTRACTED_COLLECTION = "unblock-extracted";
export declare function extractedPath(record: ExtractedRecord): string;
export declare function extractedRecords(storePath: string, paths?: readonly string[]): ExtractedRecord[];
export declare function extractedHit(record: ExtractedRecord, score: number): CorpusMemorySearchResult;
/** Single adapter for QMD's documented advanced store API; no Markdown and no private SQL writes. */
export declare function syncExtractedIndex(store: Pick<QMDStore, "internal" | "embed">, records: ExtractedRecord[]): Promise<void>;
