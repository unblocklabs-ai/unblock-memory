import type { ChatType, FileCorpusConfig } from "./config.js";
export type ResolvedSource = {
    collection: string;
    corpus: string;
    configuredPath: string;
    kind: "files" | "sessions";
    root: string;
    pattern: string;
    watchPath: string;
    chatTypes?: readonly ChatType[];
};
export declare function resolveSource(workspaceDir: string, configuredPath: string, corpus?: string): ResolvedSource;
export declare function resolveSessionSource(sessionsDir: string, chatTypes: readonly ChatType[]): ResolvedSource;
export declare function resolveSources(workspaceDir: string, corpora: readonly FileCorpusConfig[]): ResolvedSource[];
export declare function parseSafeVirtualPath(virtualPath: string, sources: ReadonlyMap<string, ResolvedSource>): {
    source: ResolvedSource;
    relativePath: string;
    normalized: string;
} | undefined;
