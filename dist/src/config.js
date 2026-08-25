import { isAbsolute } from "node:path";
export const DEFAULT_PATHS = ["MEMORY.md", "USER.md", "memory/**/*.md"];
export function resolveConfig(value) {
    if (!value || typeof value !== "object") {
        return { paths: DEFAULT_PATHS, analysis: {} };
    }
    const config = value;
    let paths = DEFAULT_PATHS;
    if (config.paths !== undefined) {
        if (!Array.isArray(config.paths) || !config.paths.every((entry) => typeof entry === "string" && entry.trim())) {
            throw new Error("unblock-memory paths must be an array of non-empty strings");
        }
        paths = config.paths.map((entry) => entry.trim());
    }
    if (config.analysis === undefined)
        return { paths, analysis: {} };
    if (!config.analysis || typeof config.analysis !== "object") {
        throw new Error("unblock-memory analysis must be an object");
    }
    const configured = config.analysis.executable;
    if (configured === undefined)
        return { paths, analysis: {} };
    if (typeof configured !== "string" || !configured.trim() || !isAbsolute(configured.trim())) {
        throw new Error("unblock-memory analysis.executable must be an absolute non-empty path");
    }
    return { paths, analysis: { executable: configured.trim() } };
}
