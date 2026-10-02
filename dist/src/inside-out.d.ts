import type { UnblockMemoryConfig } from "./config.js";
export type InsideOutConfig = {
    enabled: boolean;
    intervalMinutes: number;
    maxInteractions: number;
    maxContextTokens: number;
};
export declare function resolveInsideOut(value: unknown): InsideOutConfig;
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
