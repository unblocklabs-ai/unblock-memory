import { type ExtractionMessage, type PriorMemory } from "./extraction-model.js";
import { readExtractionPage } from "./extraction-source.js";
import type { ExtractionSession } from "./extraction-store.js";
export declare function extractionHistory(messages: ExtractionMessage[], count: number): ExtractionMessage[];
/** SDK pages are transport only. A chunk always belongs to exactly one session. */
export declare function readExtractionChunk(params: {
    agentId: string;
    agentName: string;
    session: ExtractionSession;
    cursor: string | null;
    context: ExtractionMessage[];
    existing: PriorMemory[];
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
}>;
