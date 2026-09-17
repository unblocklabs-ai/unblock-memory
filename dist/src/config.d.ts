export type FileCorpusConfig = {
    name: string;
    kind: "files";
    paths: readonly string[];
};
export type SkillCorpusConfig = {
    name: "skills";
    kind: "skills";
    paths: readonly string[];
};
declare const CHAT_TYPES: readonly ["channel", "group", "direct"];
export type ChatType = (typeof CHAT_TYPES)[number];
type SessionCorpusConfig = {
    name: "sessions";
    kind: "sessions";
    chatTypes: readonly ChatType[];
    maxExpandedTokens: number;
    syncIntervalMinutes: number;
};
export type CorpusConfig = FileCorpusConfig | SkillCorpusConfig | SessionCorpusConfig;
export declare const DEFAULT_CORPORA: readonly FileCorpusConfig[];
export type UnblockMemoryConfig = {
    corpora: readonly CorpusConfig[];
    keepEmbeddingModelWarm: boolean;
    analysis: {
        executable?: string;
    };
    typesafe: {
        enabled: boolean;
        apiKey?: string;
        apiKeyFile?: string;
        timeoutMs: number;
    };
    qualityAudit: {
        enabled: boolean;
        corpora: readonly string[];
        minNoise: number;
    };
    people: {
        enabled: boolean;
        whisperer: {
            enabled: boolean;
            maxChars: number;
        };
        todos: {
            maxOpen: number;
        };
    };
    skillWhisperer: {
        enabled: boolean;
        historyMessages: number;
        minScore: number;
        cooldownTurns: number;
    };
    memoryWhisperer: {
        enabled: boolean;
        corpora: readonly string[];
        historyMessages: number;
        minUsefulness: number;
        maxHints: number;
        cooldownTurns: number;
        timeoutMs: number;
    };
};
export declare const DEFAULT_PEOPLE_CONFIG: UnblockMemoryConfig["people"];
export declare function resolveConfig(value: unknown): UnblockMemoryConfig;
export {};
