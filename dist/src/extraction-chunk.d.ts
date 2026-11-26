import { type ExtractionMessage } from "./extraction-model.js";
import { readExtractionPage } from "./extraction-source.js";
import type { ExtractionSession } from "./extraction-store.js";
export declare function extractionHistory(messages: ExtractionMessage[], count: number): ExtractionMessage[];
/**
 * The host cursor that fences a stored checkpoint cursor: the bookmark's page fence, or the cursor itself.
 * Undefined for a malformed bookmark, which callers must treat as a source reset.
 */
export declare function checkpointFence(cursor: string): string | undefined;
/** SDK pages are transport only. A chunk always belongs to exactly one session. */
export declare function readExtractionChunk(params: {
    agentId: string;
    agentName: string;
    session: ExtractionSession;
    cursor: string | null;
    context: ExtractionMessage[];
    signal: AbortSignal;
    readPage?: typeof readExtractionPage;
}): Promise<{
    kind: "reset";
    cursor: string;
} | {
    kind: "missing";
} | {
    kind: "unavailable";
} | {
    kind: "page";
    messages: ExtractionMessage[];
    newIds: string[];
    entryCount: number;
    fence: string;
    exhausted: boolean;
    cursor: string;
} | {
    kind: "reset";
    cursor: null;
}>;
