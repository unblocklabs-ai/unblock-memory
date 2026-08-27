import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
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
            throw new Error(`unblock-memory source path must not traverse a workspace symlink: ${configuredPath}`);
        }
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
}
export function resolveSource(workspaceDir, configuredPath, corpus = "memory") {
    const expanded = expandHome(configuredPath);
    const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(workspaceDir, expanded);
    if (existsSync(absolute)) {
        const stat = statSync(absolute);
        const root = stat.isDirectory() ? absolute : dirname(absolute);
        const pattern = stat.isDirectory() ? "**/*.md" : basename(absolute);
        assertWorkspaceSourceHasNoSymlinkRoot(workspaceDir, configuredPath, root);
        return {
            collection: collectionName(absolute),
            corpus,
            configuredPath,
            kind: "files",
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
            corpus,
            configuredPath,
            kind: "files",
            root,
            pattern: isExactMarkdownFile ? basename(absolute) : "**/*.md",
            watchPath: absolute,
        };
    }
    const prefix = absolute.slice(0, magicIndex);
    const root = prefix.slice(0, prefix.lastIndexOf(sep)) || sep;
    const pattern = relative(root, absolute).split(sep).join("/");
    assertWorkspaceSourceHasNoSymlinkRoot(workspaceDir, configuredPath, root);
    return { collection: collectionName(absolute), corpus, configuredPath, kind: "files", root, pattern, watchPath: root };
}
function resolveFileSource(workspaceDir, configuredPath, corpus) {
    return { ...resolveSource(workspaceDir, configuredPath, corpus.name), kind: corpus.kind };
}
export function resolveSessionSource(sessionsDir, chatTypes) {
    return {
        ...resolveSource(sessionsDir, sessionsDir, "sessions"),
        configuredPath: sessionsDir,
        kind: "sessions",
        chatTypes,
    };
}
export function resolveSources(workspaceDir, corpora) {
    const sources = [];
    const configured = new Map();
    for (const corpus of corpora) {
        for (const path of corpus.paths) {
            const source = resolveFileSource(workspaceDir, path, corpus);
            const identity = `${source.root}\0${source.pattern}`;
            const duplicate = configured.get(identity);
            if (duplicate) {
                throw new Error(`unblock-memory source ${path} in corpus ${corpus.name} duplicates ` +
                    `${duplicate.configuredPath} in corpus ${duplicate.corpus}`);
            }
            configured.set(identity, source);
            sources.push(source);
        }
    }
    return sources;
}
export function resolveConfiguredSkillPath(workspaceDir, inputPath, sources) {
    if (basename(inputPath).toLowerCase() !== "skill.md")
        return undefined;
    const target = resolve(isAbsolute(expandHome(inputPath))
        ? expandHome(inputPath)
        : resolve(workspaceDir, inputPath));
    let canonicalTarget;
    try {
        canonicalTarget = realpathSync(target);
    }
    catch {
        return undefined;
    }
    for (const source of sources) {
        if (source.kind !== "skills")
            continue;
        const relativePath = relative(source.root, target);
        if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
            continue;
        if (picomatch.isMatch(relativePath.split(sep).join("/"), source.pattern, { dot: true }))
            return canonicalTarget;
    }
    return undefined;
}
export function parseSafeVirtualPath(virtualPath, sources) {
    const match = /^qmd:\/\/([^/]+)\/(.+)$/.exec(virtualPath.trim());
    if (!match)
        return undefined;
    const source = sources.get(match[1]);
    const relativePath = match[2];
    if (!source || relativePath.includes("\0") || isAbsolute(relativePath))
        return undefined;
    const portableRelativePath = relativePath.split(sep).join("/");
    if (!picomatch.isMatch(portableRelativePath, source.pattern, { dot: true }))
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
