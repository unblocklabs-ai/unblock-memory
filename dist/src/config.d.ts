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
export type ChatType = typeof CHAT_TYPES[number];
type SessionCorpusConfig = {
    name: "sessions";
    kind: "sessions";
    chatTypes: readonly ChatType[];
};
export type CorpusConfig = FileCorpusConfig | SkillCorpusConfig | SessionCorpusConfig;
export declare const DEFAULT_CORPORA: readonly FileCorpusConfig[];
export type UnblockMemoryConfig = {
    corpora: readonly CorpusConfig[];
    keepEmbeddingModelWarm: boolean;
    analysis: {
        executable?: string;
    };
    skillWhisperer: {
        enabled: boolean;
        historyMessages: number;
        minScore: number;
        cooldownTurns: number;
    };
};
export declare function resolveConfig(value: unknown): UnblockMemoryConfig;
export {};
