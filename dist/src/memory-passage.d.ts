import type { VectorSearchResult } from "@unblocklabs/qmd";
import { type SessionMessageSpan } from "./session-projector.js";
export declare const MEMORY_PASSAGE_CHARS: number;
type Passage = Pick<VectorSearchResult, "body" | "bestChunk" | "chunkPos" | "chunkLen">;
type LocatedPassage = {
    path: string;
    text: string;
    startLine: number;
    endLine: number;
};
/** Deduplicate matching excerpts and overlapping lines from the same source. */
export declare function duplicateMemoryPassage(passage: LocatedPassage, previous: readonly LocatedPassage[]): boolean;
/** Preserve a complete match and, when it fits, its whole turn/message context. */
export declare function expandSessionSearchHit(result: Passage, maxTokens: number, countTokens: (text: string) => Promise<number>, maxChars?: number, messages?: SessionMessageSpan[]): Promise<{
    text: string;
    position: number;
    sourceText?: string;
}>;
/** Render a complete passage within the shared search and Whisperer excerpt limit. */
export declare function renderMemoryPassage(result: Passage, messages?: SessionMessageSpan[]): Promise<{
    sourceText: string;
    text: string;
    position: number;
} | undefined>;
export {};
