import type { UnblockMemoryConfig } from "./config.js";
import { readInsideOutSources } from "./inside-out-sources.js";
export type InsideOutConfig = {
    enabled: boolean;
    intervalMinutes: number;
    maxInteractions: number;
    maxContextTokens: number;
};
export declare function resolveInsideOut(value: unknown): InsideOutConfig;
/** Refresh People links without loading transcripts or calling Jev. Known accounts stay exact. */
export declare function linkInsideOutPeople(path: string): {
    updated: number;
    linked: number;
    unlinked: number;
};
/** Explicit legacy repair: only read sources owning unlinked reviews; never rejudge their text. */
export declare function repairInsideOutIdentities(options: Parameters<typeof readInsideOutSources>[0] & {
    storePath: string;
}): Promise<{
    repaired: number;
    errors: string[];
}>;
export declare function runInsideOut(options: {
    agentId: string;
    databasePath: string;
    sessionsDir?: string;
    storePath: string;
    config: UnblockMemoryConfig;
    signal?: AbortSignal;
    retry?: boolean;
    sessionId?: string;
}): Promise<{
    reviewed: number;
    cached: number;
    failed: number;
    sources: number;
    skippedSources: number;
    errors: string[];
} | {
    status: string;
}>;
export declare function reportInsideOut(path: string, options?: {
    summary?: boolean;
    sender?: string;
    sessionId?: string;
    since?: number;
    emotion?: string;
    min?: number;
    bucket?: string;
}): Record<string, import("node:sqlite").SQLOutputValue>[];
