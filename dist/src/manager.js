import { realpathSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import chokidar from "chokidar";
import { ensureMemoryAnalysisSchema, latestAnalysisCollections, latestAnalysisRunId, markMemoryAnalysisStale, readAnalysisSummary, readCluster, readClusters, runAnalysisWorker, } from "./analysis.js";
import { CurationStore, chunkFingerprint, } from "./curation.js";
import { readSessionManifest, sessionMetadataByPath, syncSessionProjections, } from "./session-sync.js";
import { parseSafeVirtualPath } from "./sources.js";
const DEFAULT_READ_LINES = 120;
const MAX_READ_CHARS = 12_000;
const WATCH_DEBOUNCE_MS = 250;
const qmdModule = import("@unblocklabs/qmd");
function frontmatterValue(body, key) {
    const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\n|$)/u.exec(body)?.[1];
    const raw = frontmatter?.split("\n")
        .map((line) => new RegExp(`^${key}:\\s*(.+?)\\s*$`, "u").exec(line)?.[1])
        .find((value) => value !== undefined);
    return raw?.replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2").trim();
}
function embeddingText(name, description, model) {
    return model.toLowerCase().includes("qwen3-embedding")
        ? `${name}\n${description}`
        : `title: ${name} | text: ${description}`;
}
function queryText(query, model) {
    return model.toLowerCase().includes("qwen3-embedding")
        ? `Instruct: Retrieve relevant documents for the given query\nQuery: ${query}`
        : `task: search result | query: ${query}`;
}
function cosineSimilarity(left, right) {
    if (left.length !== right.length || left.length === 0)
        return 0;
    let dot = 0;
    let leftMagnitude = 0;
    let rightMagnitude = 0;
    for (let index = 0; index < left.length; index += 1) {
        const leftValue = left[index];
        const rightValue = right[index];
        dot += leftValue * rightValue;
        leftMagnitude += leftValue * leftValue;
        rightMagnitude += rightValue * rightValue;
    }
    const denominator = Math.sqrt(leftMagnitude * rightMagnitude);
    return denominator === 0 ? 0 : dot / denominator;
}
function markStaleForAnalysisCollectionChange(db, collections, hasSkills) {
    const current = collections.toSorted();
    const previous = latestAnalysisCollections(db)?.toSorted();
    if (previous
        ? previous.join("\0") !== current.join("\0")
        : hasSkills && latestAnalysisRunId(db) !== undefined) {
        markMemoryAnalysisStale(db);
    }
}
function completedEmbeddingCount(result) {
    if (result.errors > 0) {
        throw new Error(`QMD failed to embed ${result.errors} chunk${result.errors === 1 ? "" : "s"}`);
    }
    return result.chunksEmbedded;
}
async function ensureSemanticChunking(store) {
    const configured = store.internal.db.prepare("SELECT value FROM store_config WHERE key = 'embedding_chunk_strategy'").get();
    if (configured?.value === "semantic")
        return;
    completedEmbeddingCount(await store.embed({ chunkStrategy: "semantic" }));
}
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
function lexicalResult(hit, corpus, session) {
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
        corpus,
        ...(session ? { session } : {}),
        citation: `${hit.displayPath}#L1-L${endLine}`,
    };
}
function sessionAllowedPaths(metadataByPath, collection, filter) {
    const startedFrom = filter.startedFrom === undefined ? undefined : Date.parse(filter.startedFrom);
    const startedTo = filter.startedTo === undefined ? undefined : Date.parse(filter.startedTo);
    if (startedFrom !== undefined && !Number.isFinite(startedFrom)) {
        throw new Error("memory_search sessionFilter.startedFrom must be an ISO 8601 timestamp");
    }
    if (startedTo !== undefined && !Number.isFinite(startedTo)) {
        throw new Error("memory_search sessionFilter.startedTo must be an ISO 8601 timestamp");
    }
    if (startedFrom !== undefined && startedTo !== undefined && startedFrom > startedTo) {
        throw new Error("memory_search sessionFilter.startedFrom must not be after startedTo");
    }
    const provider = filter.provider?.trim().toLowerCase();
    const accountId = filter.accountId?.trim();
    const conversationId = filter.conversationId?.trim();
    const paths = [...metadataByPath].flatMap(([path, metadata]) => (startedFrom === undefined || metadata.startedAt >= startedFrom) &&
        (startedTo === undefined || metadata.startedAt <= startedTo) &&
        (provider === undefined || metadata.provider?.trim().toLowerCase() === provider) &&
        (filter.chatType === undefined || metadata.chatType === filter.chatType) &&
        (accountId === undefined || metadata.accountId?.trim() === accountId) &&
        (conversationId === undefined || metadata.conversationId?.trim() === conversationId)
        ? [path]
        : []);
    return { [collection]: paths };
}
export class QmdMemoryManager {
    #dbPath;
    #workspaceDir;
    #curationPath;
    #sources;
    #storeFactory;
    #keepModelsWarm;
    #analysisExecutable;
    #analysisRunner;
    #sessions;
    #store;
    #curation;
    #cleanupRemovedDocuments;
    #operationChain;
    #watcher;
    #watchReady;
    #watchTimer;
    #watchError;
    #closed = false;
    #files = 0;
    #dirty = true;
    #sessionMetadata = new Map();
    #sessionManifestMtimeNs;
    #skillIndex;
    constructor(params) {
        this.#dbPath = params.dbPath;
        this.#curationPath = params.curationPath ?? `${params.dbPath}.curation.sqlite`;
        this.#workspaceDir = params.workspaceDir;
        this.#sources = new Map(params.sources.map((source) => [source.collection, source]));
        this.#storeFactory = params.storeFactory;
        this.#keepModelsWarm = params.keepModelsWarm ?? true;
        this.#analysisExecutable = params.analysisExecutable;
        this.#analysisRunner = params.analysisRunner ?? runAnalysisWorker;
        this.#sessions = params.sessions;
    }
    async start() {
        if (this.#sessions) {
            await this.#reloadSessionMetadata();
        }
        this.#startWatcher();
        await this.sync({ reason: "first-use" });
        await this.#watchReady;
    }
    async #manifestMtimeNs(path) {
        try {
            return (await stat(path, { bigint: true })).mtimeNs;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
    }
    async #reloadSessionMetadata() {
        const sessions = this.#sessions;
        if (!sessions)
            return;
        const mtimeNs = await this.#manifestMtimeNs(sessions.manifestPath);
        const manifest = await readSessionManifest(sessions.manifestPath);
        this.#sessionMetadata = sessionMetadataByPath(manifest);
        this.#sessionManifestMtimeNs = mtimeNs;
    }
    async #refreshSessionMetadata() {
        const sessions = this.#sessions;
        if (!sessions)
            return;
        const mtimeNs = await this.#manifestMtimeNs(sessions.manifestPath);
        if (mtimeNs !== this.#sessionManifestMtimeNs)
            await this.#reloadSessionMetadata();
    }
    #startWatcher() {
        const paths = [...new Set([...this.#sources.values()]
                .filter((source) => source.kind !== "sessions")
                .map((source) => source.watchPath))];
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
            if (store.internal) {
                ensureMemoryAnalysisSchema(store.internal.db);
                markStaleForAnalysisCollectionChange(store.internal.db, this.#analysisCollectionNames(), this.#skillCollectionNames().length > 0);
            }
            return this.#store;
        }
        const { createStore } = await qmdModule;
        const store = await createStore({
            dbPath: this.#dbPath,
            keepModelsWarm: this.#keepModelsWarm,
            config: {
                collections: Object.fromEntries([...this.#sources.values()].map((source) => [
                    source.collection,
                    { path: source.root, pattern: source.pattern },
                ])),
            },
        });
        enableSecureDelete(store);
        ensureMemoryAnalysisSchema(store.internal.db);
        markStaleForAnalysisCollectionChange(store.internal.db, this.#analysisCollectionNames(), this.#skillCollectionNames().length > 0);
        const configuredCollections = new Set(this.#allCollectionNames());
        const staleCollections = (await store.getStatus()).collections
            .map((collection) => collection.name)
            .filter((collection) => !configuredCollections.has(collection));
        const appearsInAnalysis = store.internal.db.prepare(`
      SELECT 1
      FROM memory_analysis_memberships membership
      JOIN documents document ON document.hash = membership.hash
      WHERE membership.run_id = (
        SELECT id FROM memory_analysis_runs
        WHERE completed_at IS NOT NULL
        ORDER BY completed_at DESC, created_at DESC, id DESC
        LIMIT 1
      ) AND document.collection = ?
      LIMIT 1
    `);
        const prunedAnalysisInput = staleCollections.some((collection) => appearsInAnalysis.get(collection));
        const prunedDocuments = await pruneStaleCollections(store, configuredCollections);
        if (prunedDocuments > 0 && prunedAnalysisInput)
            markMemoryAnalysisStale(store.internal.db);
        try {
            await ensureSemanticChunking(store);
        }
        catch (error) {
            await store.close();
            throw error;
        }
        this.#cleanupRemovedDocuments = (changedDocuments) => {
            cleanupRemovedDocuments(store, changedDocuments);
        };
        this.#store = store;
        return store;
    }
    #allCollectionNames() {
        return [...this.#sources.keys()];
    }
    #analysisCollectionNames() {
        return [...this.#sources.values()]
            .filter((source) => source.kind !== "skills")
            .map((source) => source.collection);
    }
    #skillCollectionNames() {
        return [...this.#sources.values()]
            .filter((source) => source.kind === "skills")
            .map((source) => source.collection);
    }
    #collectionNames(corpora) {
        const publicSources = [...this.#sources.values()].filter((source) => source.kind !== "skills");
        if (corpora === undefined)
            return publicSources.map((source) => source.collection);
        if (corpora.length === 0)
            throw new Error("memory_search corpora must not be empty");
        const selected = new Set(corpora);
        if (selected.has("all")) {
            if (selected.size > 1)
                throw new Error('memory_search corpus "all" must be used alone');
            return publicSources.map((source) => source.collection);
        }
        const known = new Set(publicSources.map((source) => source.corpus));
        const unknown = [...selected].find((corpus) => !known.has(corpus));
        if (unknown)
            throw new Error(`memory_search unknown corpus: ${unknown}`);
        return publicSources
            .filter((source) => selected.has(source.corpus))
            .map((source) => source.collection);
    }
    sync(params) {
        const run = async () => {
            const store = await this.#getStore();
            this.#dirty = true;
            const analysisStore = store;
            const collections = [...this.#sources.values()].filter((source) => source.kind !== "sessions");
            let analysisMarkedStale = false;
            const markAnalysisStale = () => {
                if (analysisMarkedStale || !analysisStore.internal)
                    return;
                markMemoryAnalysisStale(analysisStore.internal.db);
                analysisMarkedStale = true;
            };
            if (collections.length === 0) {
                const update = await store.update({ collections: [] });
                this.#cleanupRemovedDocuments?.(update.updated + update.removed);
                if (update.indexed + update.updated + update.removed > 0 ||
                    update.needsEmbedding > 0 || params?.force === true) {
                    markAnalysisStale();
                }
                const embed = await store.embed({ force: params?.force, chunkStrategy: "semantic" });
                if (completedEmbeddingCount(embed) > 0)
                    markAnalysisStale();
            }
            for (const source of collections) {
                const update = await store.update({ collections: [source.collection] });
                this.#cleanupRemovedDocuments?.(update.updated + update.removed);
                const changed = update.indexed + update.updated + update.removed > 0 || update.needsEmbedding > 0;
                if (source.kind === "skills" && (changed || params?.force === true))
                    this.#skillIndex = undefined;
                if (source.kind !== "skills" && (changed || params?.force === true))
                    markAnalysisStale();
                const embed = await store.embed({
                    collection: source.collection,
                    force: params?.force,
                    chunkStrategy: "semantic",
                });
                if (source.kind !== "skills" && completedEmbeddingCount(embed) > 0)
                    markAnalysisStale();
            }
            const status = await store.getStatus();
            const indexedCollections = await store.listCollections();
            this.#files = indexedCollections.reduce((total, collection) => total + collection.active_count, 0);
            this.#dirty = status.needsEmbedding > 0;
        };
        return this.#enqueue(run);
    }
    syncSessions(force = false, onPhase) {
        return this.#enqueue(async () => {
            const sessions = this.#sessions;
            if (!sessions)
                throw new Error('memory session sync requires a configured "sessions" corpus');
            onPhase?.("projecting");
            const store = await this.#getStore();
            const synced = await syncSessionProjections({
                ...sessions,
                force,
                index: async () => {
                    onPhase?.("indexing");
                    const update = await store.update({ collections: [sessions.collection] });
                    this.#cleanupRemovedDocuments?.(update.updated + update.removed);
                    const analysisStore = store;
                    const invalidatesAnalysis = update.indexed + update.updated + update.removed > 0 ||
                        update.needsEmbedding > 0;
                    if (invalidatesAnalysis && analysisStore.internal) {
                        markMemoryAnalysisStale(analysisStore.internal.db);
                    }
                    const embed = await store.embed({
                        collection: sessions.collection,
                        chunkStrategy: "semantic",
                    });
                    const chunksEmbedded = completedEmbeddingCount(embed);
                    if (!invalidatesAnalysis && chunksEmbedded > 0 && analysisStore.internal) {
                        markMemoryAnalysisStale(analysisStore.internal.db);
                    }
                    return chunksEmbedded;
                },
            });
            this.#sessionMetadata = sessionMetadataByPath(synced.manifest);
            const status = await store.getStatus();
            const collections = await store.listCollections();
            this.#files = collections.reduce((total, collection) => total + collection.active_count, 0);
            this.#dirty = status.needsEmbedding > 0;
            return synced.result;
        });
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
                collections: this.#analysisCollectionNames(),
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
        return this.#enqueue(async () => {
            const db = (await this.#getAnalysisStore()).internal.db;
            this.#loadTemporalAnnotations(db);
            const detail = readCluster(db, params.clusterId, params.topK, params.offset, params.sort, { sessionCollection: this.#sessions?.collection });
            if (params.sort === "date_asc" || params.sort === "date_desc") {
                for (const member of detail.members ?? []) {
                    if (member.eventTime !== null)
                        continue;
                    const safe = parseSafeVirtualPath(member.eventTimeSource, this.#sources);
                    if (!safe)
                        continue;
                    this.#getCuration().addTask({
                        type: "ambiguous_event_time",
                        corpus: safe.source.corpus,
                        collection: safe.source.collection,
                        path: safe.relativePath,
                        reason: "cluster chronology has no reliable event time",
                        contentFingerprint: member.contentFingerprint,
                        detail: "Inspect the document and relevant evidence; annotate a date only when one can be supported.",
                    });
                }
            }
            if (detail.runId && detail.members) {
                this.#addDuplicateTasks(db, detail.runId, detail.members);
            }
            return detail;
        });
    }
    listMaintenanceTasks(params = {}) {
        return this.#getCuration().listTasks(params);
    }
    updateMaintenanceTask(params) {
        return this.#getCuration().updateTask(params);
    }
    #getCuration() {
        this.#curation ??= new CurationStore(this.#curationPath);
        return this.#curation;
    }
    #loadTemporalAnnotations(db) {
        db.exec("DELETE FROM memory_temporal_annotations");
        const findChunks = db.prepare(`
      SELECT d.hash, vectors.seq, vectors.pos, vectors.chunk_len, content.doc
      FROM documents d
      JOIN content ON content.hash = d.hash
      JOIN content_vectors vectors ON vectors.hash = d.hash
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
      ORDER BY vectors.seq
    `);
        const insert = db.prepare(`
      INSERT OR REPLACE INTO memory_temporal_annotations
        (collection, path, qmd_hash, qmd_seq, event_time, basis, document_wide)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        const curation = this.#getCuration();
        for (const annotation of curation.annotations()) {
            if (!annotation.contentFingerprint) {
                insert.run(annotation.collection, annotation.path, null, null, annotation.eventTime, annotation.basis, 1);
                continue;
            }
            const rows = findChunks.all(annotation.collection, annotation.path);
            const matched = rows.find((row) => chunkFingerprint(row.doc.slice(row.pos, row.pos + row.chunk_len)) === annotation.contentFingerprint);
            curation.updateAnnotationLocation({
                annotation,
                qmdHash: matched?.hash ?? null,
                qmdSeq: matched?.seq ?? null,
            });
            if (matched) {
                insert.run(annotation.collection, annotation.path, matched.hash, matched.seq, annotation.eventTime, annotation.basis, 0);
            }
        }
    }
    #addDuplicateTasks(db, runId, members) {
        if (members.length === 0)
            return;
        const pageMatch = members.map(() => "(duplicates.canonical_hash = ? AND duplicates.canonical_seq = ?) OR " +
            "(duplicates.duplicate_hash = ? AND duplicates.duplicate_seq = ?)").join(" OR ");
        const pageParams = members.flatMap((member) => [member.hash, member.seq, member.hash, member.seq]);
        const sessionCollections = [...this.#sources.values()]
            .filter((source) => source.kind === "sessions")
            .map((source) => source.collection);
        const excludeSessions = sessionCollections.length > 0
            ? `duplicate_document.collection NOT IN (${sessionCollections.map(() => "?").join(", ")})`
            : "1 = 1";
        const rows = db.prepare(`
      SELECT
        duplicate_document.collection,
        duplicate_document.path,
        duplicates.content_fingerprint,
        COUNT(*) AS occurrence_count
      FROM memory_analysis_duplicate_occurrences duplicates
      JOIN (SELECT DISTINCT hash FROM documents WHERE active = 1) canonical_document
        ON canonical_document.hash = duplicates.canonical_hash
      JOIN documents duplicate_document
        ON duplicate_document.hash = duplicates.duplicate_hash
       AND duplicate_document.active = 1
      WHERE duplicates.run_id = ?
        AND (${pageMatch})
        AND ${excludeSessions}
      GROUP BY duplicate_document.collection, duplicate_document.path,
               duplicates.content_fingerprint
      ORDER BY duplicate_document.collection, duplicate_document.path,
               duplicates.content_fingerprint
      LIMIT 10
    `).all(runId, ...pageParams, ...sessionCollections);
        const curation = this.#getCuration();
        for (const row of rows) {
            const source = this.#sources.get(row.collection);
            if (!source || source.kind === "sessions")
                continue;
            curation.addTask({
                type: "exact_duplicate",
                corpus: source.corpus,
                collection: row.collection,
                path: row.path,
                reason: "exact chunk content repeats in this source document",
                contentFingerprint: row.content_fingerprint,
                detail: `${row.occurrence_count} exact duplicate occurrence${row.occurrence_count === 1 ? "" : "s"}. ` +
                    "Review the source and propose cleanup only if repetition is accidental.",
            });
        }
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
        const collections = this.#collectionNames(opts?.corpora);
        opts?.signal?.throwIfAborted();
        await this.#operationChain;
        const sessions = this.#sessions;
        if (opts?.sessionFilter && sessions && collections.includes(sessions.collection)) {
            await this.#refreshSessionMetadata();
        }
        const allowedPaths = opts?.sessionFilter && sessions && collections.includes(sessions.collection)
            ? sessionAllowedPaths(this.#sessionMetadata, sessions.collection, opts.sessionFilter)
            : undefined;
        const store = await this.#getStore();
        if (opts?.lexicalOnly) {
            const hits = await store.searchLex(query, {
                limit: opts.maxResults ?? 5,
                collection: collections,
            });
            return hits.flatMap((hit) => {
                const corpus = this.#sources.get(hit.collectionName)?.corpus;
                const prefix = `qmd://${hit.collectionName}/`;
                const session = corpus === "sessions" && hit.filepath.startsWith(prefix)
                    ? this.#sessionMetadata.get(hit.filepath.slice(prefix.length))
                    : undefined;
                return hit.score >= (opts.minScore ?? 0) && corpus ? [lexicalResult(hit, corpus, session)] : [];
            });
        }
        const hits = await store.vsearch(query, {
            collection: collections,
            limit: opts?.maxResults ?? 5,
            minScore: opts?.minScore ?? 0.3,
            allowedPaths,
            expand: false,
        });
        return hits.flatMap((hit) => {
            const collection = /^qmd:\/\/([^/]+)\//.exec(hit.file)?.[1];
            const corpus = collection ? this.#sources.get(collection)?.corpus : undefined;
            if (!corpus)
                return [];
            const span = lineSpan(hit);
            const relativePath = collection && hit.file.startsWith(`qmd://${collection}/`)
                ? hit.file.slice(`qmd://${collection}/`.length)
                : undefined;
            const session = corpus === "sessions" && relativePath
                ? this.#sessionMetadata.get(relativePath)
                : undefined;
            return [{
                    path: hit.file,
                    ...span,
                    score: hit.score,
                    vectorScore: hit.score,
                    snippet: hit.bestChunk,
                    source: "memory",
                    corpus,
                    ...(session ? { session } : {}),
                    citation: `${hit.displayPath}#L${span.startLine}-L${span.endLine}`,
                }];
        });
    }
    async searchSkills(query, minScore, limit) {
        const collections = this.#skillCollectionNames();
        if (collections.length === 0)
            return [];
        await this.#operationChain;
        const store = await this.#getStore();
        if (!store.internal?.llm)
            throw new Error("Skill Whisperer requires the QMD embedding model");
        const llm = store.internal.llm;
        this.#skillIndex ??= (async () => {
            const placeholders = collections.map(() => "?").join(", ");
            const rows = store.internal.db.prepare(`
        SELECT document.collection, document.path, content.doc AS body
        FROM documents document
        JOIN content ON content.hash = document.hash
        WHERE document.active = 1 AND document.collection IN (${placeholders})
        ORDER BY document.collection, document.path
      `).all(...collections);
            const sourceOrder = new Map([...this.#sources.keys()].map((collection, index) => [collection, index]));
            const metadata = new Map();
            for (const row of rows) {
                const file = `qmd://${row.collection}/${row.path}`;
                const safe = parseSafeVirtualPath(file, this.#sources);
                if (!safe || safe.source.kind !== "skills")
                    continue;
                const path = realpathSync(resolve(safe.source.root, safe.relativePath));
                if (basename(path).toLowerCase() !== "skill.md")
                    continue;
                const name = frontmatterValue(row.body, "name") || basename(dirname(path));
                const description = frontmatterValue(row.body, "description") ?? "";
                const key = name.toLowerCase();
                const order = sourceOrder.get(row.collection) ?? Number.MAX_SAFE_INTEGER;
                const current = metadata.get(key);
                if (!current || order < current.sourceOrder) {
                    metadata.set(key, { candidate: { name, path }, description, sourceOrder: order });
                }
            }
            const skills = [...metadata.values()];
            const embeddings = await llm.embedBatch(skills.map(({ candidate, description }) => embeddingText(candidate.name, description, llm.embedModelName)));
            return skills.flatMap(({ candidate }, index) => {
                const embedding = embeddings[index]?.embedding;
                return embedding ? [{ ...candidate, score: 0, embedding }] : [];
            });
        })().catch((error) => {
            this.#skillIndex = undefined;
            throw error;
        });
        const queryEmbedding = await llm.embed(queryText(query, llm.embedModelName), { isQuery: true });
        if (!queryEmbedding)
            return [];
        const candidates = await this.#skillIndex;
        return candidates
            .map(({ embedding, ...candidate }) => ({
            ...candidate,
            score: cosineSimilarity(queryEmbedding.embedding, embedding),
        }))
            .filter((candidate) => candidate.score >= minScore)
            .sort((left, right) => right.score - left.score)
            .slice(0, limit);
    }
    async readFile(params) {
        const safe = parseSafeVirtualPath(params.relPath, this.#sources);
        if (!safe || safe.source.kind === "skills") {
            return { status: "not_found", text: "", path: params.relPath };
        }
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
        const corpora = new Map();
        for (const source of this.#sources.values()) {
            const sources = corpora.get(source.corpus) ?? [];
            sources.push(source);
            corpora.set(source.corpus, sources);
        }
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
                corpora: [...corpora].map(([name, sources]) => sources[0]?.kind === "sessions"
                    ? { name, kind: "sessions", chatTypes: sources[0].chatTypes }
                    : {
                        name,
                        kind: sources[0]?.kind === "skills" ? "skills" : "files",
                        paths: sources.map((source) => source.configuredPath),
                    }),
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
        this.#curation?.close();
        this.#curation = undefined;
    }
}
