export type ResolvedSource = {
    collection: string;
    configuredPath: string;
    root: string;
    pattern: string;
    watchPath: string;
};
export declare function resolveSource(workspaceDir: string, configuredPath: string): ResolvedSource;
export declare function parseSafeVirtualPath(virtualPath: string, sources: ReadonlyMap<string, ResolvedSource>): {
    source: ResolvedSource;
    relativePath: string;
    normalized: string;
} | undefined;
