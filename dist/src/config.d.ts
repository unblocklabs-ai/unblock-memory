export declare const DEFAULT_PATHS: readonly ["MEMORY.md", "USER.md", "memory/**/*.md"];
export type UnblockMemoryConfig = {
    paths: readonly string[];
    analysis: {
        executable?: string;
    };
};
export declare function resolveConfig(value: unknown): UnblockMemoryConfig;
