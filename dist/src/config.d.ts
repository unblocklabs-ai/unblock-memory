export declare const DEFAULT_PATHS: readonly ["MEMORY.md", "USER.md", "memory/**/*.md"];
export type UnblockQmdConfig = {
    paths: readonly string[];
};
export declare function resolveConfig(value: unknown): UnblockQmdConfig;
