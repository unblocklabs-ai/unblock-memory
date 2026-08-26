import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { AllowedDocumentPaths, QMDStore, VectorSearchResult } from "@unblocklabs/qmd";
import chokidar, { type FSWatcher } from "chokidar";
import {
  ensureMemoryAnalysisSchema,
  latestAnalysisRunId,
  markMemoryAnalysisStale,
  readAnalysisSummary,
  readCluster,
  readClusters,
  runAnalysisWorker,
  type AnalysisRunner,
  type MemoryAnalysisSummary,
  type MemoryClusterDetail,
  type MemoryClusterList,
  type MemoryClusterSort,
  type MemoryReclusterOptions,
} from "./analysis.js";
import type {
  CorpusMemorySearchResult,
  CorpusSearchOptions,
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchManagerContract,
  MemorySearchResult,
  MemorySyncParams,
  SessionSearchFilter,
} from "./contracts.js";
import type { ChatType } from "./config.js";
import {
  readSessionManifest,
  sessionMetadataByPath,
  syncSessionProjections,
  type SessionSyncResult,
} from "./session-sync.js";
import type { SessionMetadata } from "./session-projector.js";
import { parseSafeVirtualPath, type ResolvedSource } from "./sources.js";

const DEFAULT_READ_LINES = 120;
const MAX_READ_CHARS = 12_000;
const WATCH_DEBOUNCE_MS = 250;
const qmdModule = import("@unblocklabs/qmd");

export type ManagerStore = Pick<
  QMDStore,
  | "update"
  | "embed"
  | "getStatus"
  | "listCollections"
  | "searchLex"
  | "vsearch"
  | "get"
  | "getDocumentBody"
  | "close"
>;

export type ManagerSessionConfig = {
  agentId: string;
  agentName: string;
  chatTypes: readonly ChatType[];
  collection: string;
  databasePath: string;
  manifestPath: string;
  outputDir: string;
  timezone: string;
};

type AnalysisStore = ManagerStore & Pick<QMDStore, "internal">;

function completedEmbeddingCount(
  result: Awaited<ReturnType<ManagerStore["embed"]>>,
): number {
  if (result.errors > 0) {
    throw new Error(`QMD failed to embed ${result.errors} chunk${result.errors === 1 ? "" : "s"}`);
  }
  return result.chunksEmbedded;
}

async function ensureSemanticChunking(store: QMDStore): Promise<void> {
  const configured = store.internal.db.prepare(
    "SELECT value FROM store_config WHERE key = 'embedding_chunk_strategy'",
  ).get() as { value?: unknown } | undefined;
  if (configured?.value === "semantic") return;
  completedEmbeddingCount(await store.embed({ chunkStrategy: "semantic" }));
}

export function enableSecureDelete(store: QMDStore): void {
  store.internal.db.exec("PRAGMA secure_delete = ON");
}

export function cleanupRemovedDocuments(store: QMDStore, changedDocuments = 0): number {
  enableSecureDelete(store);
  const cleaned =
    changedDocuments +
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

export async function pruneStaleCollections(
  store: QMDStore,
  configuredCollections: ReadonlySet<string>,
): Promise<number> {
  const staleCollections = (await store.getStatus()).collections
    .map((collection) => collection.name)
    .filter((name) => !configuredCollections.has(name));
  if (staleCollections.length === 0) return 0;

  enableSecureDelete(store);
  const deleteDocuments = store.internal.db.prepare(
    "DELETE FROM documents WHERE collection = ?",
  );
  const removed = store.internal.db.transaction(() => {
    let count = 0;
    for (const collection of staleCollections) count += deleteDocuments.run(collection).changes;
    return count;
  }).immediate();
  cleanupRemovedDocuments(store, removed);
  return removed;
}

export function buildReadResult(params: {
  content: string;
  path: string;
  from?: number;
  lines?: number;
}): MemoryReadResult {
  const fileLines = params.content.split("\n");
  if (fileLines.at(-1) === "") fileLines.pop();
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
  if (hardTruncated) text = text.slice(0, MAX_READ_CHARS);
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

function lineSpan(result: VectorSearchResult): Pick<MemorySearchResult, "startLine" | "endLine"> {
  const before = result.body.slice(0, result.chunkPos);
  const startLine = before.split("\n").length;
  const endLine = startLine + Math.max(0, result.bestChunk.split("\n").length - 1);
  return { startLine, endLine };
}

function lexicalResult(
  hit: Awaited<ReturnType<ManagerStore["searchLex"]>>[number],
  corpus: string,
  session?: SessionMetadata,
): CorpusMemorySearchResult {
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

function sessionAllowedPaths(
  metadataByPath: ReadonlyMap<string, SessionMetadata>,
  collection: string,
  filter: SessionSearchFilter,
): AllowedDocumentPaths {
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
  const paths = [...metadataByPath].flatMap(([path, metadata]) =>
    (startedFrom === undefined || metadata.startedAt >= startedFrom) &&
    (startedTo === undefined || metadata.startedAt <= startedTo) &&
    (provider === undefined || metadata.provider?.trim().toLowerCase() === provider) &&
    (filter.chatType === undefined || metadata.chatType === filter.chatType) &&
    (accountId === undefined || metadata.accountId?.trim() === accountId) &&
    (conversationId === undefined || metadata.conversationId?.trim() === conversationId)
      ? [path]
      : [],
  );
  return { [collection]: paths };
}

export class QmdMemoryManager implements MemorySearchManagerContract {
  readonly #dbPath: string;
  readonly #workspaceDir: string;
  readonly #sources: ReadonlyMap<string, ResolvedSource>;
  readonly #storeFactory?: () => Promise<ManagerStore>;
  readonly #keepModelsWarm: boolean;
  readonly #analysisExecutable?: string;
  readonly #analysisRunner: AnalysisRunner;
  readonly #sessions?: ManagerSessionConfig;
  #store?: ManagerStore;
  #cleanupRemovedDocuments?: (changedDocuments: number) => void;
  #operationChain?: Promise<void>;
  #watcher?: FSWatcher;
  #watchReady?: Promise<void>;
  #watchTimer?: NodeJS.Timeout;
  #watchError?: string;
  #closed = false;
  #files = 0;
  #dirty = true;
  #sessionMetadata = new Map<string, SessionMetadata>();
  #sessionManifestMtimeNs?: bigint;

  constructor(params: {
    dbPath: string;
    workspaceDir: string;
    sources: readonly ResolvedSource[];
    storeFactory?: () => Promise<ManagerStore>;
    keepModelsWarm?: boolean;
    analysisExecutable?: string;
    analysisRunner?: AnalysisRunner;
    sessions?: ManagerSessionConfig;
  }) {
    this.#dbPath = params.dbPath;
    this.#workspaceDir = params.workspaceDir;
    this.#sources = new Map(params.sources.map((source) => [source.collection, source]));
    this.#storeFactory = params.storeFactory;
    this.#keepModelsWarm = params.keepModelsWarm ?? true;
    this.#analysisExecutable = params.analysisExecutable;
    this.#analysisRunner = params.analysisRunner ?? runAnalysisWorker;
    this.#sessions = params.sessions;
  }

  async start(): Promise<void> {
    if (this.#sessions) {
      await this.#reloadSessionMetadata();
    }
    this.#startWatcher();
    await this.sync({ reason: "first-use" });
    await this.#watchReady;
  }

  async #manifestMtimeNs(path: string): Promise<bigint | undefined> {
    try {
      return (await stat(path, { bigint: true })).mtimeNs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #reloadSessionMetadata(): Promise<void> {
    const sessions = this.#sessions;
    if (!sessions) return;
    const mtimeNs = await this.#manifestMtimeNs(sessions.manifestPath);
    const manifest = await readSessionManifest(sessions.manifestPath);
    this.#sessionMetadata = sessionMetadataByPath(manifest);
    this.#sessionManifestMtimeNs = mtimeNs;
  }

  async #refreshSessionMetadata(): Promise<void> {
    const sessions = this.#sessions;
    if (!sessions) return;
    const mtimeNs = await this.#manifestMtimeNs(sessions.manifestPath);
    if (mtimeNs !== this.#sessionManifestMtimeNs) await this.#reloadSessionMetadata();
  }

  #startWatcher(): void {
    const paths = [...new Set([...this.#sources.values()]
      .filter((source) => source.kind === "files")
      .map((source) => source.watchPath))];
    if (paths.length === 0 || this.#watcher) return;
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
      if (this.#closed) return;
      this.#dirty = true;
      if (this.#watchTimer) clearTimeout(this.#watchTimer);
      this.#watchTimer = setTimeout(() => {
        this.#watchTimer = undefined;
        void this.sync({ reason: "watch" }).catch(() => undefined);
      }, WATCH_DEBOUNCE_MS);
    });
  }

  async #getStore(): Promise<ManagerStore> {
    if (this.#store) return this.#store;
    await mkdir(dirname(this.#dbPath), { recursive: true });
    if (this.#storeFactory) {
      this.#store = await this.#storeFactory();
      const store = this.#store as Partial<AnalysisStore>;
      if (store.internal) ensureMemoryAnalysisSchema(store.internal.db);
      return this.#store;
    }
    const { createStore } = await qmdModule;
    const store = await createStore({
      dbPath: this.#dbPath,
      keepModelsWarm: this.#keepModelsWarm,
      config: {
        collections: Object.fromEntries(
          [...this.#sources.values()].map((source) => [
            source.collection,
            { path: source.root, pattern: source.pattern },
          ]),
        ),
      },
    });
    enableSecureDelete(store);
    ensureMemoryAnalysisSchema(store.internal.db);
    const prunedDocuments = await pruneStaleCollections(store, new Set(this.#collectionNames()));
    if (prunedDocuments > 0) markMemoryAnalysisStale(store.internal.db);
    try {
      await ensureSemanticChunking(store);
    } catch (error) {
      await store.close();
      throw error;
    }
    this.#cleanupRemovedDocuments = (changedDocuments) => {
      cleanupRemovedDocuments(store, changedDocuments);
    };
    this.#store = store;
    return store;
  }

  #collectionNames(corpora?: readonly string[]): string[] {
    if (corpora === undefined) return [...this.#sources.keys()];
    if (corpora.length === 0) throw new Error("memory_search corpora must not be empty");
    const selected = new Set(corpora);
    if (selected.has("all")) {
      if (selected.size > 1) throw new Error('memory_search corpus "all" must be used alone');
      return [...this.#sources.keys()];
    }
    const known = new Set([...this.#sources.values()].map((source) => source.corpus));
    const unknown = [...selected].find((corpus) => !known.has(corpus));
    if (unknown) throw new Error(`memory_search unknown corpus: ${unknown}`);
    return [...this.#sources.values()]
      .filter((source) => selected.has(source.corpus))
      .map((source) => source.collection);
  }

  sync(params?: MemorySyncParams): Promise<void> {
    const run = async () => {
      const store = await this.#getStore();
      this.#dirty = true;
      const collections = [...this.#sources.values()]
        .filter((source) => source.kind === "files")
        .map((source) => source.collection);
      const update = await store.update({ collections });
      this.#cleanupRemovedDocuments?.(update.updated + update.removed);
      const analysisStore = store as Partial<AnalysisStore>;
      const invalidatesAnalysis =
        update.indexed + update.updated + update.removed > 0 ||
        update.needsEmbedding > 0 ||
        params?.force === true;
      if (invalidatesAnalysis && analysisStore.internal) {
        markMemoryAnalysisStale(analysisStore.internal.db);
      }
      let chunksEmbedded = 0;
      for (const collection of collections.length > 0 ? collections : [undefined]) {
        const embed = await store.embed({
          ...(collection ? { collection } : {}),
          force: params?.force,
          chunkStrategy: "semantic",
        });
        chunksEmbedded += completedEmbeddingCount(embed);
      }
      if (!invalidatesAnalysis && chunksEmbedded > 0 && analysisStore.internal) {
        markMemoryAnalysisStale(analysisStore.internal.db);
      }
      const status = await store.getStatus();
      const indexedCollections = await store.listCollections();
      this.#files = indexedCollections.reduce((total, collection) => total + collection.active_count, 0);
      this.#dirty = status.needsEmbedding > 0;
    };
    return this.#enqueue(run);
  }

  syncSessions(
    force = false,
    onPhase?: (phase: "projecting" | "indexing") => void,
  ): Promise<SessionSyncResult> {
    return this.#enqueue(async () => {
      const sessions = this.#sessions;
      if (!sessions) throw new Error('memory session sync requires a configured "sessions" corpus');
      onPhase?.("projecting");
      const store = await this.#getStore();
      const synced = await syncSessionProjections({
        ...sessions,
        force,
        index: async () => {
          onPhase?.("indexing");
          const update = await store.update({ collections: [sessions.collection] });
          this.#cleanupRemovedDocuments?.(update.updated + update.removed);
          const analysisStore = store as Partial<AnalysisStore>;
          const invalidatesAnalysis =
            update.indexed + update.updated + update.removed > 0 ||
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

  recluster(options?: MemoryReclusterOptions, signal?: AbortSignal): Promise<MemoryAnalysisSummary> {
    return this.#enqueue(async () => {
      if (!this.#analysisExecutable) {
        throw new Error("Memory analysis is unavailable: configure analysis.executable with an absolute worker path");
      }
      signal?.throwIfAborted();
      const store = await this.#getAnalysisStore();
      const status = await store.getStatus();
      if (status.needsEmbedding > 0) {
        throw new Error(
          `Memory analysis requires an up-to-date QMD vector index: ${status.needsEmbedding} chunks need embedding. ` +
          "Run memory sync and retry memory_recluster after embedding finishes.",
        );
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

  listClusters(limit?: number): Promise<MemoryClusterList> {
    return this.#enqueue(async () => readClusters((await this.#getAnalysisStore()).internal.db, limit));
  }

  fetchCluster(params: {
    clusterId: string;
    topK?: number;
    offset?: number;
    sort?: MemoryClusterSort;
  }): Promise<MemoryClusterDetail> {
    return this.#enqueue(async () => readCluster(
      (await this.#getAnalysisStore()).internal.db,
      params.clusterId,
      params.topK,
      params.offset,
      params.sort,
    ));
  }

  async #getAnalysisStore(): Promise<AnalysisStore> {
    const store = await this.#getStore();
    if (!("internal" in store)) throw new Error("Memory analysis requires the QMD SQLite store");
    return store as AnalysisStore;
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = (this.#operationChain ?? Promise.resolve()).then(run, run);
    this.#operationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async search(
    query: string,
    opts?: CorpusSearchOptions,
  ): Promise<CorpusMemorySearchResult[]> {
    if (opts?.sources && !opts.sources.includes("memory")) return [];
    if (this.#sources.size === 0) return [];
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
      if (!corpus) return [];
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

  async readFile(params: { relPath: string; from?: number; lines?: number }): Promise<MemoryReadResult> {
    const safe = parseSafeVirtualPath(params.relPath, this.#sources);
    if (!safe) return { status: "not_found", text: "", path: params.relPath };
    await this.#operationChain;
    const store = await this.#getStore();
    const doc = await store.get(safe.normalized);
    if ("error" in doc || doc.filepath !== safe.normalized) {
      return { status: "not_found", text: "", path: params.relPath };
    }
    const content = await store.getDocumentBody(safe.normalized);
    if (content === null) return { status: "not_found", text: "", path: params.relPath };
    return buildReadResult({
      content,
      path: safe.normalized,
      from: params.from,
      lines: params.lines,
    });
  }

  status(): MemoryProviderStatus {
    const corpora = new Map<string, ResolvedSource[]>();
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
          : { name, kind: "files", paths: sources.map((source) => source.configuredPath) }),
        ...(this.#watchError ? { watchError: this.#watchError } : {}),
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    await this.#getStore();
    return { ok: true, checked: true, checkedAtMs: Date.now() };
  }

  async probeVectorAvailability(): Promise<boolean> {
    const status = await (await this.#getStore()).getStatus();
    return status.hasVectorIndex;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.#watchTimer = undefined;
    await this.#watcher?.close();
    this.#watcher = undefined;
    this.#watchReady = undefined;
    await this.#operationChain?.catch(() => undefined);
    await this.#store?.close();
    this.#store = undefined;
  }
}
