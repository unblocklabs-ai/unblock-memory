import type { UnblockMemoryConfig } from "./config.js";
import { extractWithLuna, validateExtractedMemory } from "./extraction-model.js";
import { type ExtractionSession } from "./extraction-store.js";
import { readExtractionPage } from "./extraction-source.js";
export declare function runExtraction(params: {
    config: UnblockMemoryConfig;
    storePath: string;
    agentId: string;
    runtime: unknown;
    agentName: string;
    sessions: () => ExtractionSession[];
    signal: AbortSignal;
    since?: number;
    sessionId?: string;
    scheduled?: boolean;
    readPage?: typeof readExtractionPage;
    extract?: typeof extractWithLuna;
    validate?: typeof validateExtractedMemory;
}): Promise<{
    status: "disabled";
    reason?: undefined;
    processed?: undefined;
    accepted?: undefined;
    rejected?: undefined;
    unchanged?: undefined;
    failed?: undefined;
} | {
    status: "unavailable";
    reason: string;
    processed?: undefined;
    accepted?: undefined;
    rejected?: undefined;
    unchanged?: undefined;
    failed?: undefined;
} | {
    status: "not_due_or_busy";
    reason?: undefined;
    processed?: undefined;
    accepted?: undefined;
    rejected?: undefined;
    unchanged?: undefined;
    failed?: undefined;
} | {
    status: "completed";
    processed: number;
    accepted: number;
    rejected: number;
    unchanged: number;
    failed: number;
    reason?: undefined;
}>;
