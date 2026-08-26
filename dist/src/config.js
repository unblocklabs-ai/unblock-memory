import { isAbsolute } from "node:path";
const DEFAULT_PATHS = ["MEMORY.md", "USER.md", "memory/**/*.md"];
const CHAT_TYPES = ["channel", "group", "direct"];
export const DEFAULT_CORPORA = [{
        name: "memory",
        kind: "files",
        paths: DEFAULT_PATHS,
    }];
function assertOnlyKeys(value, allowed, label) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown)
        throw new Error(`unblock-memory ${label} has unknown property: ${unknown}`);
}
function resolveCorpora(value) {
    if (value === undefined)
        return DEFAULT_CORPORA;
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error("unblock-memory corpora must be a non-empty array");
    }
    const names = new Set();
    const corpora = value.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`unblock-memory corpora[${index}] must be an object`);
        }
        const corpus = entry;
        if (typeof corpus.name !== "string" || !corpus.name.trim()) {
            throw new Error(`unblock-memory corpora[${index}].name must be a non-empty string`);
        }
        const name = corpus.name.trim();
        if (name === "all") {
            throw new Error(`unblock-memory corpus name is reserved: ${name}`);
        }
        if (names.has(name))
            throw new Error(`unblock-memory corpus names must be unique: ${name}`);
        names.add(name);
        if (corpus.kind === "sessions") {
            assertOnlyKeys(corpus, ["name", "kind", "chatTypes"], `corpora[${index}]`);
            if (name !== "sessions") {
                throw new Error('unblock-memory session corpus must be named "sessions"');
            }
            const chatTypes = corpus.chatTypes ?? ["channel", "group"];
            if (!Array.isArray(chatTypes) || chatTypes.length === 0 ||
                !chatTypes.every((chatType) => CHAT_TYPES.includes(chatType))) {
                throw new Error(`unblock-memory corpus sessions chatTypes must contain channel, group, or direct`);
            }
            return { name: "sessions", kind: "sessions", chatTypes: [...new Set(chatTypes)] };
        }
        assertOnlyKeys(corpus, ["name", "kind", "paths"], `corpora[${index}]`);
        if (name === "sessions") {
            throw new Error('unblock-memory corpus named "sessions" must have kind "sessions"');
        }
        if (corpus.kind !== "files") {
            throw new Error(`unblock-memory corpus ${name} must have kind "files" or "sessions"`);
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
export function resolveConfig(value) {
    if (value === undefined || value === null) {
        return { corpora: DEFAULT_CORPORA, keepEmbeddingModelWarm: true, analysis: {} };
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error("unblock-memory config must be an object");
    }
    const config = value;
    assertOnlyKeys(config, ["corpora", "keepEmbeddingModelWarm", "analysis"], "config");
    const corpora = resolveCorpora(config.corpora);
    if (config.keepEmbeddingModelWarm !== undefined && typeof config.keepEmbeddingModelWarm !== "boolean") {
        throw new Error("unblock-memory keepEmbeddingModelWarm must be a boolean");
    }
    const keepEmbeddingModelWarm = config.keepEmbeddingModelWarm ?? true;
    if (config.analysis === undefined)
        return { corpora, keepEmbeddingModelWarm, analysis: {} };
    if (!config.analysis || typeof config.analysis !== "object" || Array.isArray(config.analysis)) {
        throw new Error("unblock-memory analysis must be an object");
    }
    const analysis = config.analysis;
    assertOnlyKeys(analysis, ["executable"], "analysis");
    const configured = analysis.executable;
    if (configured === undefined)
        return { corpora, keepEmbeddingModelWarm, analysis: {} };
    if (typeof configured !== "string" || !configured.trim() || !isAbsolute(configured.trim())) {
        throw new Error("unblock-memory analysis.executable must be an absolute non-empty path");
    }
    return { corpora, keepEmbeddingModelWarm, analysis: { executable: configured.trim() } };
}
