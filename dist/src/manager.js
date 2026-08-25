import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import chokidar from "chokidar";
import { ensureMemoryAnalysisSchema, latestAnalysisRunId, markMemoryAnalysisStale, readAnalysisSummary, readCluster, readClusters, runAnalysisWorker, } from "./analysis.js";
import { parseSafeVirtualPath } from "./sources.js";
const DEFAULT_READ_LINES = 120;
const MAX_READ_CHARS = 12_000;
const WATCH_DEBOUNCE_MS = 250;
const qmdModule = import("@unblocklabs/qmd");
export function enableSecureDelete(store) {
    store.internal.db.exec("PRAGMA secure_delete = ON");
}
export function cleanupRemovedDocuments(store, changedDocuments = 0) {
    enableSecureDelete(store);
    const cleaned = changedDocuments +
        store.internal.deleteInactiveDocuments() +
        store.internal.cleanupOrphanedVectors() +
        store.internal.cleanupOrphanedContent();
    if (cleaned > 0) {
        store.internal.db.exec("INSERT INTO documents_fts(documents_fts) VALUES('optimize')");
        store.internal.vacuumDatabase();
        store.internal.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    return cleaned;
}
export async function pruneStaleCollections(store, configuredCollections) {
    const staleCollections = (await store.getStatus()).collections
        .map((collection) => collection.name)
        .filter((name) => !configuredCollections.has(name));
    if (staleCollections.length === 0)
        return 0;
    enableSecureDelete(store);
    const deleteDocuments = store.internal.db.prepare("DELETE FROM documents WHERE collection = ?");
    const removed = store.internal.db.transaction(() => {
        let count = 0;
        for (const collection of staleCollections)
            count += deleteDocuments.run(collection).changes;
        return count;
    }).immediate();
    cleanupRemovedDocuments(store, removed);
    return removed;
}
export function buildReadResult(params) {
    const fileLines = params.content.split("\n");
    if (fileLines.at(-1) === "")
        fileLines.pop();
    const from = Math.max(1, Math.floor(params.from ?? 1));
    const requestedLines = Math.max(1, Math.floor(params.lines ?? DEFAULT_READ_LINES));
    const selected = fileLines.slice(from - 1, from - 1 + requestedLines);
    let includedLines = selected.length;
    let text = selected.join("\n");
    while (includedLines > 1 && text.length > MAX_READ_CHARS) {
        includedLines -= 1;
        text = selected.slice(0, includedLines).join("\n");
    }
    const hardTruncated = text.length > MAX_READ_CHARS;
    if (hardTruncated)
        text = text.slice(0, MAX_READ_CHARS);
    const moreLinesRemain = from - 1 + includedLines < fileLines.length;
    const truncated = hardTruncated || moreLinesRemain || includedLines < selected.length;
    const nextFrom = hardTruncated ? undefined : truncated ? from + includedLines : undefined;
    if (truncated) {
        text += `\n\n[More content available.${nextFrom ? ` Use from=${nextFrom} to continue.` : ""}]`;
    }
    return {
        status: "ok",
        text,
        path: params.path,
        from,
        lines: includedLines,
        ...(truncated ? { truncated: true } : {}),
        ...(nextFrom ? { nextFrom } : {}),
    };
}
function lineSpan(result) {
    const before = result.body.slice(0, result.chunkPos);
    const startLine = before.split("\n").length;
    const endLine = startLine + Math.max(0, result.bestChunk.split("\n").length - 1);
    return { startLine, endLine };
}
function lexicalResult(hit) {
    const body = hit.body ?? hit.title;
    const endLine = Math.max(1, body.split("\n").length);
    return {
        path: hit.filepath,
        startLine: 1,
        endLine,
        score: hit.score,
        textScore: hit.score,
        snippet: body,
        source: "memory",
        citation: `${hit.displayPath}#L1-L${endLine}`,
    };
}
export class QmdMemoryManager {
    #dbPath;
    #workspaceDir;
    #sources;
    #storeFactory;
    #analysisExecutable;
    #analysisRunner;
    #store;
    #cleanupRemovedDocuments;
    #operationChain;
    #watcher;
    #watchReady;
    #watchTimer;
    #watchError;
    #closed = false;
    #files = 0;
    #dirty = true;
    constructor(params) {
        this.#dbPath = params.dbPath;
        this.#workspaceDir = params.workspaceDir;
        this.#sources = new Map(params.sources.map((source) => [source.collection, source]));
        this.#storeFactory = params.storeFactory;
        this.#analysisExecutable = params.analysisExecutable;
        this.#analysisRunner = params.analysisRunner ?? runAnalysisWorker;
    }
    async start() {
        this.#startWatcher();
        await this.sync({ reason: "first-use" });
        await this.#watchReady;
    }
    #startWatcher() {
        const paths = [...new Set([...this.#sources.values()].map((source) => source.watchPath))];
        if (paths.length === 0 || this.#watcher)
            return;
        this.#watcher = chokidar.watch(paths, {
            ignoreInitial: true,
            persistent: false,
            ignored: (path, stats) => Boolean(stats && !stats.isDirectory() && !path.toLowerCase().endsWith(".md")),
        });
        this.#watchReady = new Promise((resolve) => {
            this.#watcher?.once("ready", resolve);
            this.#watcher?.once("error", () => resolve());
        });
        this.#watcher.on("error", (error) => {
            this.#watchError = error instanceof Error ? error.message : String(error);
        });
        this.#watcher.on("all", () => {
            if (this.#closed)
                return;
            this.#dirty = true;
            if (this.#watchTimer)
                clearTimeout(this.#watchTimer);
            this.#watchTimer = setTimeout(() => {
                this.#watchTimer = undefined;
                void this.sync({ reason: "watch" }).catch(() => undefined);
            }, WATCH_DEBOUNCE_MS);
        });
    }
    async #getStore() {
        if (this.#store)
            return this.#store;
        await mkdir(dirname(this.#dbPath), { recursive: true });
        if (this.#storeFactory) {
            this.#store = await this.#storeFactory();
            const store = this.#store;
            if (store.internal)
                ensureMemoryAnalysisSchema(store.internal.db);
            return this.#store;
        }
        const { createStore } = await qmdModule;
        const store = await createStore({
            dbPath: this.#dbPath,
            config: {
                collections: Object.fromEntries([...this.#sources.values()].map((source) => [
                    source.collection,
                    { path: source.root, pattern: source.pattern },
                ])),
            },
        });
        enableSecureDelete(store);
        ensureMemoryAnalysisSchema(store.internal.db);
        const prunedDocuments = await pruneStaleCollections(store, new Set(this.#collectionNames()));
        if (prunedDocuments > 0)
            markMemoryAnalysisStale(store.internal.db);
        this.#cleanupRemovedDocuments = (changedDocuments) => {
            cleanupRemovedDocuments(store, changedDocuments);
        };
        this.#store = store;
        return store;
    }
    #collectionNames() {
        return [...this.#sources.keys()];
    }
    sync(params) {
        const run = async () => {
            const store = await this.#getStore();
            this.#dirty = true;
            const update = await store.update();
            this.#cleanupRemovedDocuments?.(update.updated + update.removed);
            const analysisStore = store;
            const invalidatesAnalysis = update.indexed + update.updated + update.removed > 0 ||
                update.needsEmbedding > 0 ||
                params?.force === true;
            if (invalidatesAnalysis && analysisStore.internal) {
                markMemoryAnalysisStale(analysisStore.internal.db);
            }
            const embed = await store.embed({ force: params?.force, chunkStrategy: "semantic" });
            if (!invalidatesAnalysis && embed.chunksEmbedded > 0 && analysisStore.internal) {
                markMemoryAnalysisStale(analysisStore.internal.db);
            }
            const status = await store.getStatus();
            const collections = await store.listCollections();
            this.#files = collections.reduce((total, collection) => total + collection.active_count, 0);
            this.#dirty = status.needsEmbedding > 0;
        };
        return this.#enqueue(run);
    }
    recluster(options, signal) {
        return this.#enqueue(async () => {
            if (!this.#analysisExecutable) {
                throw new Error("Memory analysis is unavailable: configure analysis.executable with an absolute worker path");
            }
            signal?.throwIfAborted();
            const store = await this.#getAnalysisStore();
            const status = await store.getStatus();
            if (status.needsEmbedding > 0) {
                throw new Error(`Memory analysis requires an up-to-date QMD vector index: ${status.needsEmbedding} chunks need embedding. ` +
                    "Run memory sync and retry memory_recluster after embedding finishes.");
            }
            const previousRunId = latestAnalysisRunId(store.internal.db);
            await this.#analysisRunner({
                executable: this.#analysisExecutable,
                dbPath: this.#dbPath,
                options,
                signal,
            });
            const summary = readAnalysisSummary(store.internal.db);
            if (!summary || summary.runId === previousRunId || summary.stale) {
                throw new Error("Memory analysis worker did not produce a new complete analysis run");
            }
            return summary;
        });
    }
    listClusters(limit) {
        return this.#enqueue(async () => readClusters((await this.#getAnalysisStore()).internal.db, limit));
    }
    fetchCluster(params) {
        return this.#enqueue(async () => readCluster((await this.#getAnalysisStore()).internal.db, params.clusterId, params.topK));
    }
    async #getAnalysisStore() {
        const store = await this.#getStore();
        if (!("internal" in store))
            throw new Error("Memory analysis requires the QMD SQLite store");
        return store;
    }
    #enqueue(run) {
        const result = (this.#operationChain ?? Promise.resolve()).then(run, run);
        this.#operationChain = result.then(() => undefined, () => undefined);
        return result;
    }
    async search(query, opts) {
        if (opts?.sources && !opts.sources.includes("memory"))
            return [];
        if (this.#sources.size === 0)
            return [];
        opts?.signal?.throwIfAborted();
        await this.#operationChain;
        const store = await this.#getStore();
        if (opts?.lexicalOnly) {
            const hits = await store.searchLex(query, {
                limit: opts.maxResults ?? 5,
                collection: this.#collectionNames(),
            });
            return hits
                .filter((hit) => hit.score >= (opts.minScore ?? 0))
                .map(lexicalResult);
        }
        const hits = await store.vsearch(query, {
            collection: this.#collectionNames(),
            limit: opts?.maxResults ?? 5,
            minScore: opts?.minScore ?? 0.3,
        });
        return hits.map((hit) => {
            const span = lineSpan(hit);
            return {
                path: hit.file,
                ...span,
                score: hit.score,
                vectorScore: hit.score,
                snippet: hit.bestChunk,
                source: "memory",
                citation: `${hit.displayPath}#L${span.startLine}-L${span.endLine}`,
            };
        });
    }
    async readFile(params) {
        const safe = parseSafeVirtualPath(params.relPath, this.#sources);
        if (!safe)
            return { status: "not_found", text: "", path: params.relPath };
        await this.#operationChain;
        const store = await this.#getStore();
        const doc = await store.get(safe.normalized);
        if ("error" in doc || doc.filepath !== safe.normalized) {
            return { status: "not_found", text: "", path: params.relPath };
        }
        const content = await store.getDocumentBody(safe.normalized);
        if (content === null)
            return { status: "not_found", text: "", path: params.relPath };
        return buildReadResult({
            content,
            path: safe.normalized,
            from: params.from,
            lines: params.lines,
        });
    }
    status() {
        return {
            backend: "builtin",
            provider: "unblock-memory",
            files: this.#files,
            dirty: this.#dirty,
            workspaceDir: this.#workspaceDir,
            dbPath: this.#dbPath,
            sources: ["memory"],
            vector: { enabled: true, available: !this.#dirty },
            custom: {
                paths: [...this.#sources.values()].map((source) => source.configuredPath),
                ...(this.#watchError ? { watchError: this.#watchError } : {}),
            },
        };
    }
    async probeEmbeddingAvailability() {
        await this.#getStore();
        return { ok: true, checked: true, checkedAtMs: Date.now() };
    }
    async probeVectorAvailability() {
        const status = await (await this.#getStore()).getStatus();
        return status.hasVectorIndex;
    }
    async close() {
        this.#closed = true;
        if (this.#watchTimer)
            clearTimeout(this.#watchTimer);
        this.#watchTimer = undefined;
        await this.#watcher?.close();
        this.#watcher = undefined;
        this.#watchReady = undefined;
        await this.#operationChain?.catch(() => undefined);
        await this.#store?.close();
        this.#store = undefined;
    }
}
