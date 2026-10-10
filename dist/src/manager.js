import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { EXTRACTED_COLLECTION, extractedRecords, extractedPath, extractedHit, syncExtractedIndex } from "./extraction-index.js";
import chokidar from "chokidar";
import picomatch from "picomatch";
import { ensureMemoryAnalysisSchema, latestAnalysisCollections, latestAnalysisRunId, markMemoryAnalysisStale, readAnalysisSummary, readCluster, readClusters, runAnalysisWorker, } from "./analysis.js";
import { CurationStore, chunkFingerprint, } from "./curation.js";
import { readSessionManifest, sessionMetadataByPath, syncSessionProjections, PROJECTOR_VERSION, } from "./session-sync.js";
import { parseSessionMessageSpans, sessionContextSpans, sessionSnippetMessages } from "./session-projector.js";
import { parseSafeVirtualPath, sourceMatchesPath } from "./sources.js";
import { auditQualityPage } from "./quality-audit.js";
import { qualityTaskPresence } from "./quality-triage.js";
import { reviewIndexedClaim } from "./evidence-review.js";
import { reviewClusterIngestion } from "./cluster-review.js";
import { abortable } from "./abortable.js";
import { RetrievalTelemetry } from "./retrieval-telemetry.js";
import { trainingCandidates } from "./training-candidates.js";
import { expandSessionSearchHit, renderMemoryPassage } from "./memory-passage.js";
export { expandSessionSearchHit } from "./memory-passage.js";
const DEFAULT_READ_LINES = 120;
const MAX_READ_CHARS = 12_000;
const WATCH_DEBOUNCE_MS = 250;
const qmdModule = import("@unblocklabs/qmd");
function readSkillDocuments(source) {
    const documents = [];
    const visitedDirectories = new Set();
    const visit = (directory) => {
        let canonicalDirectory;
        try {
            canonicalDirectory = realpathSync(directory);
        }
        catch {
            return;
        }
        if (visitedDirectories.has(canonicalDirectory))
            return;
        visitedDirectories.add(canonicalDirectory);
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            const path = resolve(directory, entry.name);
            let kind = entry.isDirectory()
                ? "directory"
                : entry.isFile()
                    ? "file"
                    : undefined;
            if (entry.isSymbolicLink()) {
                try {
                    const target = statSync(path);
                    kind = target.isDirectory() ? "directory" : target.isFile() ? "file" : undefined;
                }
                catch {
                    continue;
                }
            }
            if (kind === "directory") {
                visit(path);
                continue;
            }
            const relativePath = relative(source.root, path).split(sep).join("/");
            if (kind !== "file" || basename(path).toLowerCase() !== "skill.md" ||
                !picomatch.isMatch(relativePath, source.pattern, { dot: true }))
                continue;
            documents.push({ path, body: readFileSync(path, "utf8") });
        }
    };
    visit(source.root);
    return documents;
}
function frontmatterValue(body, key) {
    const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\n|$)/u.exec(body)?.[1];
    const raw = frontmatter?.split("\n")
        .map((line) => new RegExp(`^${key}:\\s*(.+?)\\s*$`, "u").exec(line)?.[1])
        .find((value) => value !== undefined);
    return raw?.replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2").trim();
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
function lineSpan(body, position, text) {
    const before = body.slice(0, position);
    const startLine = before.split("\n").length;
    const endLine = startLine + Math.max(0, text.split("\n").length - 1);
    return { startLine, endLine };
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
    #extraction;
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
    #watchCollections = new Set();
    #watchError;
    #closed = false;
    #files = 0;
    #dirty = true;
    #sessionMetadata = new Map();
    #sessionManifest;
    #sessionManifestMtimeNs;
    #skillIndex;
    #qualityAuditRunning = false;
    #reviewLifetime = new AbortController();
    #structuralChunksOmitted = 0;
    #structuralDiagnosticsAvailable = false;
    #retrievalTelemetry = new RetrievalTelemetry();
    #recordEmbedding(result) {
        if ("structuralChunksOmitted" in result && typeof result.structuralChunksOmitted === "number") {
            this.#structuralDiagnosticsAvailable = true;
            this.#structuralChunksOmitted += result.structuralChunksOmitted;
        }
    }
    async diagnostics() {
        await this.#operationChain;
        const store = await this.#getStore();
        const status = await store.getStatus();
        const manifest = this.#sessions ? await readSessionManifest(this.#sessions.manifestPath) : undefined;
        return {
            projectorVersion: PROJECTOR_VERSION,
            semanticChunkingVersion: "semanticChunkingVersion" in status ? status.semanticChunkingVersion : null,
            sessionsNeedingProjection: manifest ? Object.values(manifest.sessions).filter(session => session.projectorVersion !== PROJECTOR_VERSION).length : 0,
            needsEmbedding: status.needsEmbedding,
            embeddingReady: status.needsEmbedding === 0 && status.hasVectorIndex,
            structuralChunksOmitted: this.#structuralDiagnosticsAvailable ? this.#structuralChunksOmitted : null,
            retrieval: this.#retrievalTelemetry.snapshot(),
            scope: "Projection count covers previously indexed sessions; omissions count this manager lifetime; null means dependency has not reported counts.",
        };
    }
    constructor(params) {
        this.#dbPath = params.dbPath;
        this.#curationPath = params.curationPath ?? `${params.dbPath}.curation.sqlite`;
        this.#extraction = params.extraction;
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
        this.#sessionManifest = manifest;
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
        this.#watcher.on("all", (_event, path) => {
            if (this.#closed)
                return;
            const matchingSources = [...this.#sources.values()].filter((source) => source.kind !== "sessions" && sourceMatchesPath(source, path));
            if (matchingSources.some((source) => source.kind === "skills"))
                this.#skillIndex = undefined;
            if (!matchingSources.some((source) => source.kind !== "skills"))
                return;
            for (const source of matchingSources)
                if (source.kind !== "skills")
                    this.#watchCollections.add(source.collection);
            this.#dirty = true;
            if (this.#watchTimer)
                clearTimeout(this.#watchTimer);
            this.#watchTimer = setTimeout(() => {
                this.#watchTimer = undefined;
                const collections = [...this.#watchCollections];
                this.#watchCollections.clear();
                void this.#sync({ reason: "watch" }, collections).catch(() => undefined);
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
                collections: Object.fromEntries([...this.#qmdSources().map((source) => [
                        source.collection,
                        { path: source.root, pattern: source.pattern },
                    ]), ...(this.#extraction?.enabled && this.#extraction.publish
                        ? [[EXTRACTED_COLLECTION, { path: dirname(this.#dbPath), pattern: ".no-extracted-files", includeByDefault: false }]] : [])]),
            },
        });
        try {
            enableSecureDelete(store);
            ensureMemoryAnalysisSchema(store.internal.db);
            markStaleForAnalysisCollectionChange(store.internal.db, this.#analysisCollectionNames(), this.#skillCollectionNames().length > 0);
            const configuredCollections = new Set(this.#qmdSources().map((source) => source.collection));
            if (this.#extraction?.enabled && this.#extraction.publish)
                configuredCollections.add(EXTRACTED_COLLECTION);
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
            await ensureSemanticChunking(store);
        }
        catch (error) {
            await store.close().catch(() => undefined);
            throw error;
        }
        this.#cleanupRemovedDocuments = (changedDocuments) => {
            cleanupRemovedDocuments(store, changedDocuments);
        };
        this.#store = store;
        return store;
    }
    #qmdSources() {
        return [...this.#sources.values()].filter((source) => source.kind !== "skills");
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
        const extracted = this.#extraction?.enabled && this.#extraction.publish ? [EXTRACTED_COLLECTION] : [];
        if (corpora === undefined)
            return [...publicSources.map((source) => source.collection), ...extracted];
        if (corpora.length === 0)
            throw new Error("memory_search corpora must not be empty");
        const selected = new Set(corpora);
        if (selected.has("all")) {
            if (selected.size > 1)
                throw new Error('memory_search corpus "all" must be used alone');
            return [...publicSources.map((source) => source.collection), ...extracted];
        }
        const known = new Set(publicSources.map((source) => source.corpus));
        if (extracted.length)
            known.add("extracted");
        const unknown = [...selected].find((corpus) => !known.has(corpus));
        if (unknown)
            throw new Error(`memory_search unknown corpus: ${unknown}`);
        return [...publicSources
                .filter((source) => selected.has(source.corpus))
                .map((source) => source.collection), ...(selected.has("extracted") ? extracted : [])];
    }
    syncExtracted() {
        return this.#enqueue(async () => {
            if (!this.#extraction?.enabled || !this.#extraction.publish)
                return;
            const store = await this.#getAnalysisStore();
            const records = extractedRecords(this.#curationPath).filter(r => this.#extraction.chatTypes.includes(r.metadata.chatType));
            await syncExtractedIndex(store, records);
            await this.#refreshIndexStatus(store);
        });
    }
    #currentExtracted(paths, filter) {
        if (!this.#extraction?.enabled || !this.#extraction.publish)
            return [];
        const records = extractedRecords(this.#curationPath, paths?.filter(path => path.startsWith(`qmd://${EXTRACTED_COLLECTION}/`))
            .map(path => path.slice(`qmd://${EXTRACTED_COLLECTION}/`.length)))
            .filter(r => this.#extraction.chatTypes.includes(r.metadata.chatType));
        if (!filter)
            return records;
        const allowed = new Set(sessionAllowedPaths(new Map(records.map(r => [extractedPath(r), r.metadata])), EXTRACTED_COLLECTION, filter)[EXTRACTED_COLLECTION]);
        return records.filter(r => allowed.has(extractedPath(r)));
    }
    async #updateAndEmbed(store, collections, force) {
        // Extracted facts are DB projections, not files: never run filesystem sync on them.
        const analysisStore = store;
        let changedDocuments = 0;
        try {
            const update = await store.update({ collections: collections ? [...collections] : this.#qmdSources().map(source => source.collection) });
            changedDocuments = update.updated + update.removed;
            if ((update.indexed + changedDocuments > 0 || update.needsEmbedding > 0 || force) && analysisStore.internal) {
                markMemoryAnalysisStale(analysisStore.internal.db);
            }
        }
        catch (error) {
            // QMD may commit earlier collections before a later collection fails.
            if (analysisStore.internal)
                markMemoryAnalysisStale(analysisStore.internal.db);
            changedDocuments = Math.max(1, changedDocuments);
            throw error;
        }
        finally {
            // A later collection failing must not leave earlier removed plaintext behind.
            this.#cleanupRemovedDocuments?.(changedDocuments);
        }
        let chunksEmbedded = 0;
        for (const collection of collections?.length ? collections : [undefined]) {
            const embed = await store.embed({ ...(collection ? { collection } : {}), force, chunkStrategy: "semantic" });
            this.#recordEmbedding(embed);
            const count = completedEmbeddingCount(embed);
            chunksEmbedded += count;
            if (count > 0 && analysisStore.internal)
                markMemoryAnalysisStale(analysisStore.internal.db);
        }
        return chunksEmbedded;
    }
    async #refreshIndexStatus(store) {
        const status = await store.getStatus();
        const collections = await store.listCollections();
        this.#files = collections.reduce((total, collection) => total + collection.active_count, 0);
        this.#dirty = status.needsEmbedding > 0;
    }
    sync(params) {
        return this.#sync(params);
    }
    #sync(params, affectedCollections) {
        const run = async () => {
            const store = await this.#getStore();
            this.#dirty = true;
            const collections = affectedCollections ?? this.#qmdSources().filter((source) => source.kind !== "sessions").map(source => source.collection);
            await this.#updateAndEmbed(store, collections.length ? collections : undefined, params?.force);
            await this.#refreshIndexStatus(store);
        };
        return this.#enqueue(run);
    }
    syncSessions(force = false, onPhase) {
        return this.#enqueue(async () => {
            const sessions = this.#sessions;
            if (!sessions)
                throw new Error('memory session sync requires a configured "sessions" corpus');
            onPhase?.("projecting");
            const synced = await syncSessionProjections({
                ...sessions,
                force,
                indexPath: this.#dbPath,
                indexReady: async () => (await (await this.#getStore()).getStatus()).needsEmbedding === 0,
                index: async () => {
                    onPhase?.("indexing");
                    const store = await this.#getStore();
                    return this.#updateAndEmbed(store, [sessions.collection]);
                },
            });
            this.#sessionMetadata = sessionMetadataByPath(synced.manifest);
            this.#sessionManifest = synced.manifest;
            if (synced.result.skipReason)
                return synced.result;
            const store = await this.#getStore();
            await this.#refreshIndexStatus(store);
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
    reviewClaim(params) {
        return this.#review(params.signal, context => reviewIndexedClaim({ ...params, ...context,
            sources: [...this.#sources.values()].filter(source => params.corpora.includes(source.corpus)),
        }));
    }
    reviewCluster(params) {
        return this.#review(params.signal, context => reviewClusterIngestion({ ...params, ...context,
            sources: [...this.#sources.values()].filter(source => params.corpora.includes(source.corpus)),
        }));
    }
    async #review(callerSignal, run) {
        const signal = AbortSignal.any([callerSignal, this.#reviewLifetime.signal]);
        signal.throwIfAborted();
        const store = await abortable(this.#enqueue(async () => {
            signal.throwIfAborted();
            const store = await this.#getAnalysisStore();
            signal.throwIfAborted();
            return store;
        }), signal);
        const read = (work) => {
            signal.throwIfAborted();
            return abortable(this.#enqueue(async () => {
                signal.throwIfAborted();
                return work();
            }), signal);
        };
        // Only the synchronous evidence snapshot and freshness check enter the queue.
        // Closing aborts inference and prevents any late response from touching the DB.
        signal.throwIfAborted();
        return abortable(run({ db: store.internal.db, signal, read }), signal);
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
    async listMaintenanceTasks(params = {}) {
        await this.#operationChain;
        const tasks = this.#getCuration().listTasks(params);
        if (!tasks.some(task => task.type === "quality_review"))
            return tasks;
        const store = await this.#getAnalysisStore();
        const fingerprints = new Map();
        return tasks.map(task => ({ ...task, indexPresence: qualityTaskPresence(store.internal.db, task, fingerprints) }));
    }
    async auditQuality(params) {
        if (this.#qualityAuditRunning)
            return { status: "busy" };
        this.#qualityAuditRunning = true;
        try {
            await this.#operationChain;
            params.signal.throwIfAborted();
            const store = await this.#getAnalysisStore();
            params.signal.throwIfAborted();
            if (this.#closed)
                return { status: "unavailable" };
            return await auditQualityPage({
                ...params, db: store.internal.db, curation: this.#getCuration(),
                sources: [...this.#sources.values()].filter(source => source.kind !== "skills" && params.corpora.includes(source.corpus)),
                isActive: () => !this.#closed,
            });
        }
        finally {
            this.#qualityAuditRunning = false;
        }
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
        const fingerprints = new Map();
        for (const annotation of curation.annotations()) {
            if (!annotation.contentFingerprint) {
                insert.run(annotation.collection, annotation.path, null, null, annotation.eventTime, annotation.basis, 1);
                continue;
            }
            const key = JSON.stringify([annotation.collection, annotation.path]);
            let chunks = fingerprints.get(key);
            if (!chunks) {
                chunks = new Map();
                const rows = findChunks.all(annotation.collection, annotation.path);
                for (const row of rows) {
                    const fingerprint = chunkFingerprint(row.doc.slice(row.pos, row.pos + row.chunk_len));
                    if (!chunks.has(fingerprint))
                        chunks.set(fingerprint, row);
                }
                fingerprints.set(key, chunks);
            }
            const matched = chunks.get(annotation.contentFingerprint);
            if (annotation.qmdHash !== (matched?.hash ?? null) || annotation.qmdSeq !== (matched?.seq ?? null)) {
                curation.updateAnnotationLocation({ annotation, qmdHash: matched?.hash ?? null, qmdSeq: matched?.seq ?? null });
            }
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
        const started = performance.now();
        const operation = "vector";
        let results;
        try {
            results = await this.#search(query, opts);
        }
        catch (error) {
            this.#retrievalTelemetry.record(operation, { elapsedMs: performance.now() - started,
                outcome: opts?.signal?.aborted ? "cancelled" : "failed" });
            throw error;
        }
        this.#retrievalTelemetry.record(operation, { elapsedMs: performance.now() - started,
            outcome: results.length ? "ok" : "empty", results: results.length,
            contextChars: results.reduce((sum, hit) => sum + hit.snippet.length, 0) });
        return results;
    }
    async #search(query, opts) {
        if (opts?.sources && !opts.sources.includes("memory"))
            return [];
        if (this.#sources.size === 0)
            return [];
        const collections = this.#collectionNames(opts?.corpora);
        opts?.signal?.throwIfAborted();
        await this.#operationChain;
        const sessions = this.#sessions;
        opts?.signal?.throwIfAborted();
        if (sessions && collections.includes(sessions.collection)) {
            await this.#refreshSessionMetadata();
        }
        let allowedPaths = opts?.sessionFilter && sessions && collections.includes(sessions.collection)
            ? sessionAllowedPaths(this.#sessionMetadata, sessions.collection, opts.sessionFilter)
            : undefined;
        const store = await this.#getStore();
        opts?.signal?.throwIfAborted();
        const currentRecords = (paths) => {
            if (!collections.includes(EXTRACTED_COLLECTION))
                return [];
            return this.#currentExtracted(paths, opts?.sessionFilter);
        };
        if (collections.includes(EXTRACTED_COLLECTION)) {
            allowedPaths = { ...allowedPaths, [EXTRACTED_COLLECTION]: currentRecords().map(extractedPath) };
        }
        const hits = await store.vsearch(query, {
            collection: collections,
            limit: opts?.maxResults ?? 5,
            minScore: opts?.minScore ?? 0.3,
            allowedPaths,
            expand: false,
        });
        opts?.signal?.throwIfAborted();
        return this.#renderSearchHits(hits, store, opts);
    }
    /** Shared discovery: exact trained recipe, scoped before either retrieval lane. */
    async searchCandidates(queries, opts) {
        return this.#enqueue(async () => {
            opts.signal?.throwIfAborted();
            const collections = this.#collectionNames(opts.corpora);
            if (!collections.length)
                return [];
            if (this.#sessions && collections.includes(this.#sessions.collection))
                await this.#refreshSessionMetadata();
            const sessions = this.#sessions;
            let allowedPaths = opts.sessionFilter && sessions && collections.includes(sessions.collection)
                ? sessionAllowedPaths(this.#sessionMetadata, sessions.collection, opts.sessionFilter) : undefined;
            if (collections.includes(EXTRACTED_COLLECTION)) {
                allowedPaths = { ...allowedPaths, [EXTRACTED_COLLECTION]: this.#currentExtracted(undefined, opts.sessionFilter).map(extractedPath) };
            }
            const store = await this.#getAnalysisStore();
            const hits = new Map();
            // Serialize native QMD work. Cancellation prevents further queries/collections.
            for (const lane of ["lex", "vec"]) {
                opts.signal?.throwIfAborted();
                for (const hit of await trainingCandidates(store, queries[lane], collections, lane, opts.signal, allowedPaths)) {
                    const key = JSON.stringify([hit.file, hit.bestChunkPos, hit.bestChunk]);
                    if (!hits.has(key))
                        hits.set(key, { file: hit.file, body: hit.body, bestChunk: hit.bestChunk,
                            chunkPos: hit.bestChunkPos, chunkLen: hit.bestChunk.length, displayPath: hit.file, score: hit.score });
                }
            }
            opts.signal?.throwIfAborted();
            return this.#renderSearchHits([...hits.values()], store, opts, true);
        });
    }
    async #renderSearchHits(hits, store, opts, whisperer = false) {
        const tokenizer = store.internal?.llm;
        const results = [];
        const current = new Map(this.#currentExtracted(hits.map(hit => hit.file), opts?.sessionFilter).map(r => [`qmd://${EXTRACTED_COLLECTION}/${extractedPath(r)}`, r]));
        for (const hit of hits) {
            opts?.signal?.throwIfAborted();
            // Proactive hints must retain the entire matched chunk, even when expanded
            // turn/message context exceeds their budget. Ordinary search is unchanged.
            if (hit.bestChunk.length > (opts?.maxSnippetChars ?? Infinity))
                continue;
            const collection = /^qmd:\/\/([^/]+)\//.exec(hit.file)?.[1];
            if (collection === EXTRACTED_COLLECTION) {
                const record = current.get(hit.file);
                if (record && record.text.length <= (opts?.maxSnippetChars ?? Infinity))
                    results.push(extractedHit(record, hit.score));
                continue;
            }
            const corpus = collection ? this.#sources.get(collection)?.corpus : undefined;
            if (!corpus)
                continue;
            const relativePath = collection && hit.file.startsWith(`qmd://${collection}/`)
                ? hit.file.slice(`qmd://${collection}/`.length)
                : undefined;
            const session = corpus === "sessions" && relativePath
                ? this.#sessionMetadata.get(relativePath)
                : undefined;
            const projection = session ? this.#sessionManifest?.sessions[session.sessionId] : undefined;
            // Never apply offsets from a newer projection to an older indexed snapshot.
            const messages = corpus === "sessions"
                ? projection?.messages && projection.documentPath === relativePath &&
                    projection.projectionHash === createHash("sha256").update(hit.body).digest("hex")
                    ? projection.messages : parseSessionMessageSpans(hit.body)
                : undefined;
            const messageTimestamp = messages
                ? sessionContextSpans(hit.body, hit.chunkPos, messages)?.message.timestamp
                : undefined;
            const selected = whisperer ? await renderMemoryPassage(hit, messages)
                : corpus === "sessions" && this.#sessions && tokenizer
                    ? await expandSessionSearchHit(hit, this.#sessions.maxExpandedTokens, (text) => tokenizer.countTokens(text), opts?.maxSnippetChars, messages)
                    : { text: hit.bestChunk, position: hit.chunkPos };
            if (!selected?.text)
                continue;
            const span = lineSpan(hit.body, selected.position, selected.sourceText ?? selected.text);
            results.push({
                path: hit.file,
                ...span,
                score: hit.score,
                vectorScore: hit.score,
                snippet: selected.text,
                ...(messages ? { sessionMessages: sessionSnippetMessages(hit.body, selected, messages, this.#sessions) } : {}),
                source: "memory",
                corpus,
                ...(session ? { session } : {}),
                ...(messageTimestamp ? { messageTimestamp } : {}),
                citation: `${hit.displayPath}#L${span.startLine}-L${span.endLine}`,
            });
        }
        // Expansion above can yield; recheck only derived hits once more before returning.
        const finalPaths = new Set(this.#currentExtracted(results.map(hit => hit.path), opts?.sessionFilter).map(r => `qmd://${EXTRACTED_COLLECTION}/${extractedPath(r)}`));
        return results.filter(hit => !hit.path.startsWith(`qmd://${EXTRACTED_COLLECTION}/`) || finalPaths.has(hit.path));
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
        const { formatDocForEmbedding, formatQueryForEmbedding } = await qmdModule;
        let skillIndex = this.#skillIndex;
        if (!skillIndex) {
            const pending = (async () => {
                const sourceOrder = new Map([...this.#sources.keys()].map((collection, index) => [collection, index]));
                const metadata = new Map();
                for (const source of this.#sources.values()) {
                    if (source.kind !== "skills")
                        continue;
                    for (const document of readSkillDocuments(source)) {
                        const name = frontmatterValue(document.body, "name") || basename(dirname(document.path));
                        const description = frontmatterValue(document.body, "description") ?? "";
                        const key = name.toLowerCase();
                        const order = sourceOrder.get(source.collection) ?? Number.MAX_SAFE_INTEGER;
                        const current = metadata.get(key);
                        if (!current || order < current.sourceOrder) {
                            metadata.set(key, {
                                candidate: { name, description, path: document.path },
                                description,
                                sourceOrder: order,
                            });
                        }
                    }
                }
                const skills = [...metadata.values()];
                const embeddings = await llm.embedBatch(skills.map(({ candidate, description }) => formatDocForEmbedding(description, candidate.name, llm.embedModelName)));
                return skills.flatMap(({ candidate }, index) => {
                    const embedding = embeddings[index]?.embedding;
                    return embedding ? [{ ...candidate, score: 0, embedding }] : [];
                });
            })();
            skillIndex = pending.catch((error) => {
                if (this.#skillIndex === skillIndex)
                    this.#skillIndex = undefined;
                throw error;
            });
            this.#skillIndex = skillIndex;
        }
        const queryEmbedding = await llm.embed(formatQueryForEmbedding(query, llm.embedModelName), { isQuery: true });
        if (!queryEmbedding)
            return [];
        const candidates = await skillIndex;
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
        if (params.relPath.startsWith(`qmd://${EXTRACTED_COLLECTION}/`)) {
            const record = this.#extraction?.enabled && this.#extraction.publish
                ? extractedRecords(this.#curationPath, [params.relPath.slice(`qmd://${EXTRACTED_COLLECTION}/`.length)]).find(r => this.#extraction.chatTypes.includes(r.metadata.chatType) &&
                    params.relPath === `qmd://${EXTRACTED_COLLECTION}/${extractedPath(r)}`) : undefined;
            return record ? buildReadResult({ content: `${record.text}\nObserved: ${new Date(record.observedAt).toISOString()}\nSource: ${extractedHit(record, 1).citation}`,
                path: params.relPath, from: params.from, lines: params.lines }) : { status: "not_found", text: "", path: params.relPath };
        }
        const safe = parseSafeVirtualPath(params.relPath, this.#sources);
        if (!safe || safe.source.kind === "skills") {
            return { status: "not_found", text: "", path: params.relPath };
        }
        await this.#operationChain;
        const store = await this.#getStore();
        const doc = await store.get(safe.normalized, { includeBody: true });
        if ("error" in doc || doc.filepath !== safe.normalized || doc.body === undefined) {
            return { status: "not_found", text: "", path: params.relPath };
        }
        return buildReadResult({
            content: doc.body,
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
        this.#reviewLifetime.abort();
        if (this.#watchTimer)
            clearTimeout(this.#watchTimer);
        this.#watchTimer = undefined;
        this.#watchCollections.clear();
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
