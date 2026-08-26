import { isAbsolute } from "node:path";

const DEFAULT_PATHS = ["MEMORY.md", "USER.md", "memory/**/*.md"] as const;

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

const CHAT_TYPES = ["channel", "group", "direct"] as const;
export type ChatType = typeof CHAT_TYPES[number];

type SessionCorpusConfig = {
  name: "sessions";
  kind: "sessions";
  chatTypes: readonly ChatType[];
};

export type CorpusConfig = FileCorpusConfig | SkillCorpusConfig | SessionCorpusConfig;

export const DEFAULT_CORPORA: readonly FileCorpusConfig[] = [{
  name: "memory",
  kind: "files",
  paths: DEFAULT_PATHS,
}];

export type UnblockMemoryConfig = {
  corpora: readonly CorpusConfig[];
  keepEmbeddingModelWarm: boolean;
  analysis: { executable?: string };
  skillWhisperer: {
    enabled: boolean;
    historyMessages: number;
    minScore: number;
    cooldownTurns: number;
  };
};

const DEFAULT_SKILL_WHISPERER: UnblockMemoryConfig["skillWhisperer"] = {
  enabled: false,
  historyMessages: 5,
  minScore: 0.4,
  cooldownTurns: 10,
};

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`unblock-memory ${label} has unknown property: ${unknown}`);
}

function resolveCorpora(value: unknown): readonly CorpusConfig[] {
  if (value === undefined) return DEFAULT_CORPORA;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("unblock-memory corpora must be a non-empty array");
  }

  const names = new Set<string>();
  const corpora = value.map((entry, index): CorpusConfig => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`unblock-memory corpora[${index}] must be an object`);
    }
    const corpus = entry as Record<string, unknown>;
    if (typeof corpus.name !== "string" || !corpus.name.trim()) {
      throw new Error(`unblock-memory corpora[${index}].name must be a non-empty string`);
    }
    const name = corpus.name.trim();
    if (name === "all") {
      throw new Error(`unblock-memory corpus name is reserved: ${name}`);
    }
    if (names.has(name)) throw new Error(`unblock-memory corpus names must be unique: ${name}`);
    names.add(name);
    if (corpus.kind === "skills") {
      assertOnlyKeys(corpus, ["name", "kind", "paths"], `corpora[${index}]`);
      if (name !== "skills") {
        throw new Error('unblock-memory skills corpus must be named "skills"');
      }
      if (!Array.isArray(corpus.paths) || corpus.paths.length === 0 ||
        !corpus.paths.every((path) => typeof path === "string" && path.trim())) {
        throw new Error("unblock-memory corpus skills paths must be a non-empty array of non-empty strings");
      }
      return { name: "skills", kind: "skills", paths: corpus.paths.map((path) => path.trim()) };
    }
    if (corpus.kind === "sessions") {
      assertOnlyKeys(corpus, ["name", "kind", "chatTypes"], `corpora[${index}]`);
      if (name !== "sessions") {
        throw new Error('unblock-memory session corpus must be named "sessions"');
      }
      const chatTypes = corpus.chatTypes ?? ["channel", "group"];
      if (!Array.isArray(chatTypes) || chatTypes.length === 0 ||
        !chatTypes.every((chatType) => CHAT_TYPES.includes(chatType as ChatType))) {
        throw new Error(`unblock-memory corpus sessions chatTypes must contain channel, group, or direct`);
      }
      return { name: "sessions", kind: "sessions", chatTypes: [...new Set(chatTypes)] as ChatType[] };
    }
    assertOnlyKeys(corpus, ["name", "kind", "paths"], `corpora[${index}]`);
    if (name === "sessions") {
      throw new Error('unblock-memory corpus named "sessions" must have kind "sessions"');
    }
    if (name === "skills") {
      throw new Error('unblock-memory corpus named "skills" must have kind "skills"');
    }
    if (corpus.kind !== "files") {
      throw new Error(`unblock-memory corpus ${name} must have kind "files", "skills", or "sessions"`);
    }
    if (!Array.isArray(corpus.paths) || corpus.paths.length === 0 ||
      !corpus.paths.every((path) => typeof path === "string" && path.trim())) {
      throw new Error(`unblock-memory corpus ${name} paths must be a non-empty array of non-empty strings`);
    }
    return { name, kind: "files", paths: corpus.paths.map((path) => path.trim()) };
  });

  if (corpora.filter((corpus) => corpus.name === "memory").length !== 1) {
    throw new Error('unblock-memory corpora must contain exactly one corpus named "memory"');
  }
  return corpora;
}

export function resolveConfig(value: unknown): UnblockMemoryConfig {
  if (value === undefined || value === null) {
    return {
      corpora: DEFAULT_CORPORA,
      keepEmbeddingModelWarm: true,
      analysis: {},
      skillWhisperer: DEFAULT_SKILL_WHISPERER,
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unblock-memory config must be an object");
  }
  const config = value as Record<string, unknown>;
  assertOnlyKeys(config, ["corpora", "keepEmbeddingModelWarm", "analysis", "skillWhisperer"], "config");
  const corpora = resolveCorpora(config.corpora);
  if (config.keepEmbeddingModelWarm !== undefined && typeof config.keepEmbeddingModelWarm !== "boolean") {
    throw new Error("unblock-memory keepEmbeddingModelWarm must be a boolean");
  }
  const keepEmbeddingModelWarm = config.keepEmbeddingModelWarm ?? true;
  let analysisConfig: { executable?: string } = {};
  if (config.analysis !== undefined) {
    if (!config.analysis || typeof config.analysis !== "object" || Array.isArray(config.analysis)) {
      throw new Error("unblock-memory analysis must be an object");
    }
    const analysis = config.analysis as Record<string, unknown>;
    assertOnlyKeys(analysis, ["executable"], "analysis");
    const configured = analysis.executable;
    if (configured !== undefined) {
      if (typeof configured !== "string" || !configured.trim() || !isAbsolute(configured.trim())) {
        throw new Error("unblock-memory analysis.executable must be an absolute non-empty path");
      }
      analysisConfig = { executable: configured.trim() };
    }
  }

  let skillWhisperer = DEFAULT_SKILL_WHISPERER;
  if (config.skillWhisperer !== undefined) {
    if (!config.skillWhisperer || typeof config.skillWhisperer !== "object" || Array.isArray(config.skillWhisperer)) {
      throw new Error("unblock-memory skillWhisperer must be an object");
    }
    const value = config.skillWhisperer as Record<string, unknown>;
    assertOnlyKeys(value, ["enabled", "historyMessages", "minScore", "cooldownTurns"], "skillWhisperer");
    const enabled = value.enabled ?? false;
    const historyMessages = value.historyMessages ?? 5;
    const minScore = value.minScore ?? 0.4;
    const cooldownTurns = value.cooldownTurns ?? 10;
    if (typeof enabled !== "boolean") throw new Error("unblock-memory skillWhisperer.enabled must be a boolean");
    if (typeof historyMessages !== "number" || !Number.isInteger(historyMessages) || historyMessages < 0) {
      throw new Error("unblock-memory skillWhisperer.historyMessages must be a non-negative integer");
    }
    if (typeof minScore !== "number" || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      throw new Error("unblock-memory skillWhisperer.minScore must be between 0 and 1");
    }
    if (typeof cooldownTurns !== "number" || !Number.isInteger(cooldownTurns) || cooldownTurns < 0) {
      throw new Error("unblock-memory skillWhisperer.cooldownTurns must be a non-negative integer");
    }
    skillWhisperer = { enabled, historyMessages, minScore, cooldownTurns };
  }
  if (skillWhisperer.enabled && !corpora.some((corpus) => corpus.kind === "skills")) {
    throw new Error('unblock-memory enabled skillWhisperer requires a corpus named "skills" with kind "skills"');
  }
  return { corpora, keepEmbeddingModelWarm, analysis: analysisConfig, skillWhisperer };
}
