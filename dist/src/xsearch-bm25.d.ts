import type { AllowedDocumentPaths, QMDStore, VectorSearchResult } from "@unblocklabs/qmd";
/** QMD's document BM25 index, scoped BEFORE LIMIT. Select a complete stored chunk
 * for judging instead of transmitting a potentially enormous session document. */
export declare function xsearchBm25(db: QMDStore["internal"]["db"], query: string, collections: readonly string[], limit: number, allowedPaths?: AllowedDocumentPaths): VectorSearchResult[];
