import type { VectorSearchResult } from "@unblocklabs/qmd";
import { type SessionMessageSpan } from "./session-projector.js";
export declare const MEMORY_PASSAGE_CHARS = 1200;
export declare const MEMORY_PASSAGE_VERSION = "complete-excerpt-1200-v1";
type Passage = Pick<VectorSearchResult, "body" | "bestChunk" | "chunkPos" | "chunkLen">;
type LocatedPassage = {
    path: string;
    text: string;
    startLine: number;
    endLine: number;
};
/** Same passage eligibility in target scoring and runtime hint selection. */
export declare function duplicateMemoryPassage(passage: LocatedPassage, previous: readonly LocatedPassage[]): boolean;
/** Preserve a complete match and, when it fits, its whole turn/message context. */
export declare function expandSessionSearchHit(result: Passage, maxTokens: number, countTokens: (text: string) => Promise<number>, maxChars?: number, messages?: SessionMessageSpan[]): Promise<{
    text: string;
    position: number;
    sourceText?: string;
}>;
/** One fixed, model-independent renderer for offline and deployed Whisperer. */
export declare function renderMemoryPassage(result: Passage, messages?: SessionMessageSpan[]): Promise<{
    sourceText: string;
    text: string;
    position: number;
} | undefined>;
export {};
