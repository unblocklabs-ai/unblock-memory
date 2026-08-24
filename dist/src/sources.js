import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
const GLOB_MAGIC = /[*?[{(]/;
function expandHome(value) {
    return value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
}
function collectionName(source) {
    return `source-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`;
}
function assertWorkspaceSourceHasNoSymlinkRoot(workspaceDir, configuredPath, root) {
    if (isAbsolute(expandHome(configuredPath)))
        return;
    const workspace = resolve(workspaceDir);
    const rootRelative = relative(workspace, root);
    if (rootRelative === ".." || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)) {
        return;
    }
    let current = root;
    while (current !== workspace) {
        if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
            throw new Error(`unblock-qmd source path must not traverse a workspace symlink: ${configuredPath}`);
        }
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
}
export function resolveSource(workspaceDir, configuredPath) {
    const expanded = expandHome(configuredPath);
    const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(workspaceDir, expanded);
    if (existsSync(absolute)) {
        const stat = lstatSync(absolute);
        const root = stat.isDirectory() ? absolute : dirname(absolute);
        const pattern = stat.isDirectory() ? "**/*.md" : basename(absolute);
        assertWorkspaceSourceHasNoSymlinkRoot(workspaceDir, configuredPath, root);
        return {
            collection: collectionName(absolute),
            configuredPath,
            root,
            pattern,
            watchPath: absolute,
        };
    }
    const magicIndex = absolute.search(GLOB_MAGIC);
    if (magicIndex < 0) {
        const isExactMarkdownFile = basename(absolute).toLowerCase().endsWith(".md");
        const root = isExactMarkdownFile ? dirname(absolute) : absolute;
        assertWorkspaceSourceHasNoSymlinkRoot(workspaceDir, configuredPath, root);
        return {
            collection: collectionName(absolute),
            configuredPath,
            root,
            pattern: isExactMarkdownFile ? basename(absolute) : "**/*.md",
            watchPath: absolute,
        };
    }
    const prefix = absolute.slice(0, magicIndex);
    const root = prefix.slice(0, prefix.lastIndexOf(sep)) || sep;
    const pattern = relative(root, absolute).split(sep).join("/");
    assertWorkspaceSourceHasNoSymlinkRoot(workspaceDir, configuredPath, root);
    return { collection: collectionName(absolute), configuredPath, root, pattern, watchPath: root };
}
export function parseSafeVirtualPath(virtualPath, sources) {
    const match = /^qmd:\/\/([^/]+)\/(.+)$/.exec(virtualPath.trim());
    if (!match)
        return undefined;
    const source = sources.get(match[1]);
    const relativePath = match[2];
    if (!source || relativePath.includes("\0") || isAbsolute(relativePath))
        return undefined;
    const target = resolve(source.root, relativePath);
    if (relative(source.root, target).startsWith(`..${sep}`) || relative(source.root, target) === "..") {
        return undefined;
    }
    if (!target.toLowerCase().endsWith(".md"))
        return undefined;
    try {
        const realRoot = realpathSync(source.root);
        const realTarget = realpathSync(target);
        const rel = relative(realRoot, realTarget);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            return undefined;
    }
    catch {
        return undefined;
    }
    return { source, relativePath, normalized: `qmd://${source.collection}/${relativePath}` };
}
