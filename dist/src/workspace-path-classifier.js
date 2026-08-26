import fs from "node:fs/promises";
import path from "node:path";
import { isPathStrictlyInside } from "openclaw/plugin-sdk/file-access-runtime";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
export const classifyWorkspaceMemoryPaths = async (params) => await Promise.all(params.relativePaths.map(async (relativePath) => {
    let workspacePath;
    let filePath;
    try {
        [workspacePath, filePath] = await Promise.all([
            fs.realpath(params.workspaceDir),
            fs.realpath(path.resolve(params.workspaceDir, relativePath)),
        ]);
    }
    catch {
        return { relativePath, originClass: "untrusted" };
    }
    if (!isPathStrictlyInside(workspacePath, filePath)) {
        return { relativePath, originClass: "untrusted" };
    }
    const workspaceRelativePath = path.relative(workspacePath, filePath);
    const segments = workspaceRelativePath.split(path.sep);
    const curatedRoot = segments.length === 1 &&
        ["MEMORY.md", "memory.md", "USER.md"].includes(segments[0]);
    if ((segments.length === 1 && ["DREAMS.md", "dreams.md"].includes(segments[0])) ||
        (segments[0] === "memory" && ["dreaming", ".dreams"].includes(segments[1]))) {
        return { relativePath, originClass: "system" };
    }
    const isWorkspaceMemory = curatedRoot ||
        (segments[0] === "memory" && segments.at(-1)?.endsWith(".md") === true);
    const normalizedPath = workspaceRelativePath.replaceAll(path.sep, "/");
    const recorded = isWorkspaceMemory
        ? await readMemoryArtifactProvenance({
            workspaceDir: params.workspaceDir,
            relativePath: normalizedPath,
        })
        : undefined;
    return {
        relativePath,
        originClass: recorded?.originClass ?? (isWorkspaceMemory ? "agent" : "untrusted"),
    };
}));
