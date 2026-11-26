import { DEFAULTS } from "./defaults.js";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { EXTRACTED_COLLECTION, EXTRACTED_PREFIX, extractedRecords, extractedPath, extractedHit, extractedUri, syncExtractedIndex } from "./extraction-index.js";
import type { ExtractionConfig } from "./extraction-config.js";
import type { AllowedDocumentPaths, QMDStore, VectorSearchResult } from "@unblocklabs/qmd";
import chokidar, { type FSWatcher } from "chokidar";
import picomatch from "picomatch";
import { isScalar, parseDocument } from "yaml";
import {
  ensureMemoryAnalysisSchema,
  latestAnalysisCollections,
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
  MemoryReadCursor,
  MemoryReadResult,
  MemoryRequestContext,
  MemorySearchManagerContract,
  MemorySearchResult,
  MemorySyncParams,
  SessionSearchFilter,
} from "./contracts.js";
import type { ChatType } from "./config.js";
import {
  CurationStore,
  chunkFingerprint,
  type MaintenanceStatus,
  type MaintenanceTask,
  type TemporalBasis,
} from "./curation.js";
import {
  projectionHash,
  readSessionManifest,
  sessionMetadataByPath,
  syncSessionProjections,
  PROJECTOR_VERSION,
  type SessionSyncResult,
  type SessionManifest,
} from "./session-sync.js";
import { parseSessionMessageSpans, sessionContextSpans, sessionSnippetMessages,
  type SessionMetadata } from "./session-projector.js";
import { parseSafeVirtualPath, resolveConfiguredSkillPath, sourceMatchesPath, type ResolvedSource } from "./sources.js";
import { auditQualityPage, type QualityCursor } from "./quality-audit.js";
import { qualityTaskPresence } from "./quality-triage.js";
import { reviewIndexedClaim } from "./evidence-review.js";
import { reviewClusterIngestion } from "./cluster-review.js";
import { abortable } from "./abortable.js";
import { RetrievalTelemetry } from "./retrieval-telemetry.js";
import { discoverLaneCandidates } from "./memory-candidates.js";
import { expandSessionSearchHit, renderMemoryPassage } from "./memory-passage.js";
import type { QueryPair } from "./query-contract.js";
import { startTiming, timeStage, vectorTrace, vectorParts, unaccounted } from "./retrieval-timing.js";
import { parseDailyFilenameDateMs } from "./recall-ledger.js";
import { memoryPassageId } from "./memory-search.js";
export { expandSessionSearchHit } from "./memory-passage.js";

const WATCH_DEBOUNCE_MS = DEFAULTS.sqlite.watchDebounceMs;
const WATCH_RETRY_MS = DEFAULTS.sqlite.watchRetryMs;
const MANAGER_CLOSED_ERROR = "QmdMemoryManager is closed";

type MemoryReadParams = {
  relPath: string;
  from?: number;
  lines?: number;
  cursor?: MemoryReadCursor;
  requestContext?: MemoryRequestContext;
};

export type ManagerStore = Pick<
  QMDStore,
  | "update"
  | "embed"
  | "getStatus"
  | "listCollections"
  | "vsearch"
  | "get"
  | "close"
>;

export type ManagerSessionConfig = {
  agentId: string;
  agentName: string;
  chatTypes: readonly ChatType[];
  maxExpandedTokens: number;
  collection: string;
  databasePath: string;
  manifestPath: string;
  outputDir: string;
  timezone: string;
};

export type SkillCatalogEntry = {
  name: string;
  description: string;
  path: string;
};

export type SkillSearchCandidate = SkillCatalogEntry & { score: number };

type AnalysisStore = ManagerStore & Pick<QMDStore, "internal">;
type PassageHit = Pick<VectorSearchResult, "file" | "body" | "bestChunk" | "chunkPos" | "chunkLen" | "displayPath" | "score" | "ref">;

type SkillIndexEntry = SkillSearchCandidate & {
  embedding: number[];
};

function readSkillSource(source: ResolvedSource): SkillCatalogEntry[] {
  const entries: SkillCatalogEntry[] = [];
  const visitedDirectories = new Set<string>();
  const visit = (directory: string) => {
    let canonicalDirectory: string;
    try {
      canonicalDirectory = realpathSync(directory);
    } catch {
      return;
    }
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      let kind: "directory" | "file" | undefined = entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : undefined;
      if (entry.isSymbolicLink()) {
        try {
          const target = statSync(path);
          kind = target.isDirectory() ? "directory" : target.isFile() ? "file" : undefined;
        } catch {
          continue;
        }
      }
      if (kind === "directory") {
        visit(path);
        continue;
      }
      const relativePath = relative(source.root, path).split(sep).join("/");
      if (kind !== "file" || basename(path).toLowerCase() !== "skill.md" ||
        !picomatch.isMatch(relativePath, source.pattern, { dot: false })) continue;
      entries.push(readSkillCatalogEntry(path));
    }
  };
  visit(source.root);
  return entries;
}

function frontmatterValue(body: string, key: "name" | "description"): string | undefined {
  const frontmatter = /^\uFEFF?---[ \t]*\r?\n((?:[^\n]*\n)*?)---[ \t]*(?:\r?\n|$)/u.exec(body)?.[1];
  if (frontmatter === undefined) return;
  const document = parseDocument(frontmatter, { schema: "failsafe" });
  const scalar = document.get(key, true);
  // Some existing skills use unquoted punctuation that is invalid YAML.
  if (!isScalar(scalar) && document.errors.length) {
    const raw = new RegExp(`^${key}:[ \\t]*(.+)$`, "mu").exec(frontmatter)?.[1]?.trim();
    if (raw) return raw;
  }
  if (!isScalar(scalar) || typeof scalar.value !== "string") return;
  return scalar.type === "BLOCK_FOLDED" || scalar.type === "BLOCK_LITERAL"
    ? scalar.value
    : scalar.value.trim();
}

export function readSkillCatalogEntry(path: string): SkillCatalogEntry {
  const body = readFileSync(path, "utf8");
  return {
    name: frontmatterValue(body, "name") || basename(dirname(path)),
    description: frontmatterValue(body, "description") ?? "",
    path,
  };
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftMagnitude * rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}

function markStaleForAnalysisCollectionChange(
  db: AnalysisStore["internal"]["db"],
  collections: readonly string[],
  hasSkills: boolean,
): void {
  const current = collections.toSorted();
  const previous = latestAnalysisCollections(db)?.toSorted();
  if (
    previous
      ? previous.join("\0") !== current.join("\0")
      : hasSkills && latestAnalysisRunId(db) !== undefined
  ) {
    markMemoryAnalysisStale(db);
  }
}

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

function pruneStaleCollections(
  store: QMDStore,
  staleCollections: readonly string[],
): number {
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

function staleReadCursor(path: string): MemoryReadResult {
  return { status: "stale_cursor", text: "", path, error: "Read cursor no longer matches this source or position. Restart without cursor." };
}

function splitsSurrogatePair(line: string, offset: number): boolean {
  const left = line.charCodeAt(offset - 1);
  const right = line.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

export function buildReadResult({ content, path, from: start, lines, cursor }: {
  content: string;
  path: string;
  from?: number;
  lines?: number;
  cursor?: MemoryReadCursor;
}): MemoryReadResult {
  const { memoryGetDefaultLines, memoryGetMaxChars, memoryGetMaxLines } = DEFAULTS.memoryWhisperer;
  const fileLines = content.split("\n");
  if (fileLines.at(-1) === "") fileLines.pop();
  const from = cursor?.line ?? Math.max(1, Math.floor(start ?? 1));
  const sha256Text = (text: string) => createHash("sha256").update(text).digest("hex");
  const offset = cursor?.offset ?? 0;
  const revision = () => sha256Text(JSON.stringify([path, sha256Text(content)]));
  if (cursor) {
    const firstLine = fileLines[from - 1];
    if (start !== undefined || !Number.isSafeInteger(from) || from < 1 || firstLine === undefined ||
        !Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= firstLine.length) ||
        splitsSurrogatePair(firstLine, offset) || cursor.revision !== revision()) {
      return staleReadCursor(path);
    }
  }
  const requestedLines = Math.min(memoryGetMaxLines, Math.max(1, Math.floor(lines ?? memoryGetDefaultLines)));
  const selected = fileLines.slice(from - 1, from - 1 + requestedLines);

  const fragments: string[] = [];
  let contentChars = 0;
  let nextCursor: MemoryReadCursor | undefined;
  for (const line of selected) {
    const first = fragments.length === 0;
    const fragment = first ? line.slice(offset) : line;
    const nextLength = contentChars + fragment.length + (first ? 0 : 1);
    if (nextLength > memoryGetMaxChars) {
      if (first) {
        let end = offset + memoryGetMaxChars;
        if (splitsSurrogatePair(line, end)) end--;
        fragments.push(line.slice(offset, end));
        contentChars = end - offset;
        nextCursor = { line: from, offset: end, revision: cursor?.revision ?? revision() };
      }
      break;
    }
    fragments.push(fragment);
    contentChars = nextLength;
  }
  const nextLine = from + fragments.length;
  const nextFrom = !nextCursor && nextLine <= fileLines.length ? nextLine : undefined;
  const notice = nextCursor ? "Use nextCursor as cursor to continue." :
    nextFrom !== undefined ? `Use from=${nextFrom} to continue.` : undefined;
  return {
    status: "ok",
    text: fragments.join("\n") + (notice ? `\n\n[More content available. ${notice}]` : ""),
    path,
    from,
    lines: fragments.length,
    ...(notice ? { truncated: true, contentChars } : {}),
    ...(nextCursor ? { nextCursor } : {}),
    ...(nextFrom !== undefined ? { nextFrom } : {}),
  };
}

function lineSpan(
  body: string,
  position: number,
  text: string,
): Pick<MemorySearchResult, "startLine" | "endLine"> {
  const before = body.slice(0, position);
  const startLine = before.split("\n").length;
  const endLine = startLine + Math.max(0, text.split("\n").length - 1);
  return { startLine, endLine };
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
  readonly #curationPath: string;
  /** Present only when extracted memories are published into search. */
  readonly #publishedExtraction?: ExtractionConfig;
  readonly #sources: ReadonlyMap<string, ResolvedSource>;
  /** Non-skill sources: the QMD-indexed, analyzable corpora. */
  readonly #indexSources: readonly ResolvedSource[];
  readonly #indexCollections: readonly string[];
  readonly #hasSkills: boolean;
  readonly #storeFactory?: () => Promise<ManagerStore>;
  readonly #keepModelsWarm: boolean;
  readonly #analysisExecutable?: string;
  readonly #analysisRunner: AnalysisRunner;
  readonly #sessions?: ManagerSessionConfig;
  readonly #trackRecallLocators: boolean;
  #store?: ManagerStore;
  #storePromise?: Promise<ManagerStore>;
  #curation?: CurationStore;
  #cleanupRemovedDocuments?: (changedDocuments: number) => void;
  #operationChain?: Promise<void>;
  readonly #inFlight = new Set<Promise<void>>();
  #closePromise?: Promise<void>;
  #watcher?: FSWatcher;
  #watchReady?: Promise<void>;
  #watchMemory = false;
  #watchTimer?: NodeJS.Timeout;
  readonly #watchCollections = new Set<string>();
  #watchError?: string;
  #closed = false;
  #files = 0;
  #dirty = true;
  #sessionMetadata = new Map<string, SessionMetadata>();
  #sessionManifest?: SessionManifest;
  #sessionManifestMtimeNs?: bigint;
  #skillCatalog?: { entries: SkillCatalogEntry[]; aliases: Map<string, string[]> };
  #skillIndex?: Promise<SkillIndexEntry[]>;
  #qualityAuditRunning = false;
  #reviewLifetime = new AbortController();
  #structuralChunksOmitted = 0;
  #structuralDiagnosticsAvailable = false;
  readonly #retrievalTelemetry = new RetrievalTelemetry();

  #recordEmbedding(result: Awaited<ReturnType<ManagerStore["embed"]>>): void {
    if ("structuralChunksOmitted" in result && typeof result.structuralChunksOmitted === "number") {
      this.#structuralDiagnosticsAvailable = true;
      this.#structuralChunksOmitted += result.structuralChunksOmitted;
    }
  }

  async diagnostics() {
    return this.#runFenced(async () => {
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
    });
  }

  constructor(params: {
    dbPath: string;
    curationPath?: string;
    extraction?: ExtractionConfig;
    workspaceDir: string;
    sources: readonly ResolvedSource[];
    storeFactory?: () => Promise<ManagerStore>;
    keepModelsWarm?: boolean;
    analysisExecutable?: string;
    analysisRunner?: AnalysisRunner;
    sessions?: ManagerSessionConfig;
    trackRecallLocators?: boolean;
  }) {
    this.#dbPath = params.dbPath;
    this.#curationPath = params.curationPath ?? `${params.dbPath}.curation.sqlite`;
    this.#publishedExtraction = params.extraction?.enabled && params.extraction.publish ? params.extraction : undefined;
    this.#workspaceDir = params.workspaceDir;
    this.#sources = new Map(params.sources.map((source) => [source.collection, source]));
    this.#indexSources = [...this.#sources.values()].filter((source) => source.kind !== "skills");
    this.#indexCollections = this.#indexSources.map((source) => source.collection);
    this.#hasSkills = [...this.#sources.values()].some((source) => source.kind === "skills");
    this.#storeFactory = params.storeFactory;
    this.#keepModelsWarm = params.keepModelsWarm ?? true;
    this.#analysisExecutable = params.analysisExecutable;
    this.#analysisRunner = params.analysisRunner ?? runAnalysisWorker;
    this.#sessions = params.sessions;
    this.#trackRecallLocators = params.trackRecallLocators ?? false;
  }

  async start(): Promise<void> {
    this.#assertOpen();
    if (this.#sessions) {
      await this.#reloadSessionMetadata();
    }
    this.#assertOpen();
    this.#watchMemory = true;
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
    this.#sessionManifest = manifest;
    this.#sessionManifestMtimeNs = mtimeNs;
  }

  async #refreshSessionMetadata(): Promise<boolean> {
    const sessions = this.#sessions;
    if (!sessions) return false;
    const mtimeNs = await this.#manifestMtimeNs(sessions.manifestPath);
    if (mtimeNs === this.#sessionManifestMtimeNs) return false;
    await this.#reloadSessionMetadata();
    return true;
  }

  #startWatcher(): void {
    const paths = [...new Set([...this.#sources.values()]
      .filter((source) => source.kind !== "sessions")
      .map((source) => source.watchPath))];
    if (paths.length === 0 || this.#watcher) return;
    this.#watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      persistent: false,
      ignored: (path, stats) => Boolean(stats && !stats.isDirectory() && !path.toLowerCase().endsWith(".md")),
    });
    this.#watchReady = new Promise((resolve) => {
      this.#watcher?.once("ready", () => {
        // A cold catalog read can predate watcher readiness.
        this.#invalidateSkills();
        resolve();
      });
      this.#watcher?.once("error", () => resolve());
    });
    this.#watcher.on("error", (error) => {
      this.#watchError = error instanceof Error ? error.message : String(error);
    });
    this.#watcher.on("all", (_event, path) => {
      if (this.#closed) return;
      const matchingSources = [...this.#sources.values()].filter((source) =>
        source.kind !== "sessions" && sourceMatchesPath(source, path));
      if (matchingSources.some((source) => source.kind === "skills")) this.#invalidateSkills();
      if (!this.#watchMemory || !matchingSources.some((source) => source.kind !== "skills")) return;
      for (const source of matchingSources) if (source.kind !== "skills") this.#watchCollections.add(source.collection);
      this.#dirty = true;
      this.#scheduleWatchSync();
    });
  }

  #invalidateSkills(): void {
    this.#skillCatalog = undefined;
    this.#skillIndex = undefined;
  }

  #scheduleWatchSync(retry = false): void {
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.#watchTimer = setTimeout(() => {
      this.#watchTimer = undefined;
      if (this.#closed) return;
      void this.#sync({ watchOnly: true }).catch(() => {
        if (!retry && !this.#closed && !this.#watchTimer) this.#scheduleWatchSync(true);
      });
    }, retry ? WATCH_RETRY_MS : WATCH_DEBOUNCE_MS);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(MANAGER_CLOSED_ERROR);
  }

  #runFenced<T>(run: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(MANAGER_CLOSED_ERROR));
    const promise = Promise.resolve().then(run);
    const tracked = promise.then(() => undefined, () => undefined);
    this.#inFlight.add(tracked);
    void tracked.finally(() => {
      this.#inFlight.delete(tracked);
    });
    return promise;
  }

  async #getStore(): Promise<ManagerStore> {
    this.#assertOpen();
    if (this.#store) return this.#store;
    if (!this.#storePromise) {
      const pending = this.#openStore();
      this.#storePromise = pending;
      void pending.finally(() => {
        if (this.#storePromise === pending) this.#storePromise = undefined;
      }).catch(() => undefined);
    }
    const store = await this.#storePromise;
    this.#assertOpen();
    return store;
  }

  async #openStore(): Promise<ManagerStore> {
    this.#assertOpen();
    await mkdir(dirname(this.#dbPath), { recursive: true });
    this.#assertOpen();
    if (this.#storeFactory) {
      const created = await this.#storeFactory();
      if (this.#closed) {
        await created.close().catch(() => undefined);
        throw new Error(MANAGER_CLOSED_ERROR);
      }
      try {
        const store = created as Partial<AnalysisStore>;
        if (store.internal) {
          ensureMemoryAnalysisSchema(store.internal.db);
          markStaleForAnalysisCollectionChange(store.internal.db, this.#indexCollections, this.#hasSkills);
        }
      } catch (error) {
        await created.close().catch(() => undefined);
        throw error;
      }
      this.#store = created;
      return created;
    }
    const { createStore } = await import("@unblocklabs/qmd");
    this.#assertOpen();
    const store = await createStore({
      dbPath: this.#dbPath,
      keepModelsWarm: this.#keepModelsWarm,
      config: {
        collections: Object.fromEntries(
          [...this.#indexSources.map((source) => [
            source.collection,
            { path: source.root, pattern: source.pattern },
          ]), ...(this.#publishedExtraction
            ? [[EXTRACTED_COLLECTION, { path: dirname(this.#dbPath), pattern: ".no-extracted-files", includeByDefault: false }]] : [])],
        ),
      },
    });
    try {
      this.#assertOpen();
      enableSecureDelete(store);
      ensureMemoryAnalysisSchema(store.internal.db);
      markStaleForAnalysisCollectionChange(store.internal.db, this.#indexCollections, this.#hasSkills);
      const configuredCollections = new Set(this.#collectionNames());
      const staleCollections = (await store.getStatus()).collections
        .map((collection) => collection.name)
        .filter((collection) => !configuredCollections.has(collection));
      if (staleCollections.length > 0) {
        const latestRunId = latestAnalysisRunId(store.internal.db);
        let prunedAnalysisInput = false;
        if (latestRunId !== undefined) {
          const appearsInAnalysis = store.internal.db.prepare(`
            SELECT 1
            FROM memory_analysis_memberships membership
            JOIN documents document ON document.hash = membership.hash
            WHERE membership.run_id = ? AND document.collection = ?
            LIMIT 1
          `);
          prunedAnalysisInput = staleCollections.some((collection) => appearsInAnalysis.get(latestRunId, collection));
        }
        const prunedDocuments = pruneStaleCollections(store, staleCollections);
        if (prunedDocuments > 0 && prunedAnalysisInput) markMemoryAnalysisStale(store.internal.db);
      }
      await ensureSemanticChunking(store);
      this.#assertOpen();
    } catch (error) {
      await store.close().catch(() => undefined);
      throw error;
    }
    this.#cleanupRemovedDocuments = (changedDocuments) => {
      cleanupRemovedDocuments(store, changedDocuments);
    };
    this.#store = store;
    return store;
  }

  #collectionNames(corpora?: readonly string[]): string[] {
    const extracted = this.#publishedExtraction ? [EXTRACTED_COLLECTION] : [];
    if (corpora === undefined) return [...this.#indexCollections, ...extracted];
    if (corpora.length === 0) throw new Error("memory_search corpora must not be empty");
    const selected = new Set(corpora);
    if (selected.has("all")) {
      if (selected.size > 1) throw new Error('memory_search corpus "all" must be used alone');
      return [...this.#indexCollections, ...extracted];
    }
    const known = new Set(this.#indexSources.map((source) => source.corpus));
    if (extracted.length) known.add("extracted");
    const unknown = [...selected].find((corpus) => !known.has(corpus));
    if (unknown) throw new Error(`memory_search unknown corpus: ${unknown}`);
    return [...this.#indexSources
      .filter((source) => selected.has(source.corpus))
      .map((source) => source.collection), ...(selected.has("extracted") ? extracted : [])];
  }

  syncExtracted(): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#publishedExtraction) return;
      const store = await this.#getAnalysisStore();
      await syncExtractedIndex(store, this.#currentExtracted());
      await this.#refreshIndexStatus(store);
    });
  }

  #currentExtracted(paths?: readonly string[], filter?: SessionSearchFilter) {
    const extraction = this.#publishedExtraction;
    if (!extraction) return [];
    const records = extractedRecords(this.#curationPath, paths?.filter(path => path.startsWith(EXTRACTED_PREFIX))
      .map(path => path.slice(EXTRACTED_PREFIX.length)))
      .filter(r => extraction.chatTypes.includes(r.metadata.chatType));
    if (!filter) return records;
    const allowed = new Set(sessionAllowedPaths(new Map(records.map(r => [extractedPath(r), r.metadata])), EXTRACTED_COLLECTION, filter)[EXTRACTED_COLLECTION]);
    return records.filter(r => allowed.has(extractedPath(r)));
  }

  /** Search scope: session-filtered transcripts plus currently published extracted memories. */
  #allowedPaths(collections: readonly string[], filter?: SessionSearchFilter): AllowedDocumentPaths | undefined {
    const sessions = this.#sessions;
    const allowed = filter && sessions && collections.includes(sessions.collection)
      ? sessionAllowedPaths(this.#sessionMetadata, sessions.collection, filter) : undefined;
    return collections.includes(EXTRACTED_COLLECTION)
      ? { ...allowed, [EXTRACTED_COLLECTION]: this.#currentExtracted(undefined, filter).map(extractedPath) }
      : allowed;
  }

  async #updateAndEmbed(store: ManagerStore, collections?: readonly string[], force?: boolean): Promise<number> {
    // Extracted facts are DB projections, not files: never run filesystem sync on them.
    const analysisStore = store as Partial<AnalysisStore>;
    let changedDocuments = 0;
    try {
      const update = await store.update({ collections: [...(collections ?? this.#indexCollections)] });
      changedDocuments = update.updated + update.removed;
      if ((update.indexed + changedDocuments > 0 || update.needsEmbedding > 0 || force) && analysisStore.internal) {
        markMemoryAnalysisStale(analysisStore.internal.db);
      }
    } catch (error) {
      // QMD may commit earlier collections before a later collection fails.
      if (analysisStore.internal) markMemoryAnalysisStale(analysisStore.internal.db);
      changedDocuments = Math.max(1, changedDocuments);
      throw error;
    } finally {
      // A later collection failing must not leave earlier removed plaintext behind.
      this.#cleanupRemovedDocuments?.(changedDocuments);
    }
    let chunksEmbedded = 0;
    for (const collection of collections?.length ? collections : [undefined]) {
      const embed = await store.embed({ ...(collection ? { collection } : {}), force, chunkStrategy: "semantic" });
      this.#recordEmbedding(embed);
      const count = completedEmbeddingCount(embed);
      chunksEmbedded += count;
      if (count > 0 && analysisStore.internal) markMemoryAnalysisStale(analysisStore.internal.db);
    }
    return chunksEmbedded;
  }

  async #refreshIndexStatus(store: ManagerStore): Promise<void> {
    const status = await store.getStatus();
    const collections = await store.listCollections();
    this.#files = collections.reduce((total, collection) => total + collection.active_count, 0);
    this.#dirty = status.needsEmbedding > 0 || this.#watchCollections.size > 0;
  }

  sync(params?: MemorySyncParams): Promise<void> {
    return this.#sync({ force: params?.force });
  }

  #sync({ force, watchOnly }: { force?: boolean; watchOnly?: boolean }): Promise<void> {
    return this.#enqueue(async () => {
      const watched = [...this.#watchCollections];
      if (watchOnly && watched.length === 0) return;
      this.#watchCollections.clear();
      this.#dirty = true;
      try {
        const store = await this.#getStore();
        const collections = watchOnly ? watched : this.#indexSources.filter((source) => source.kind !== "sessions").map(source => source.collection);
        await this.#updateAndEmbed(store, collections.length ? collections : undefined, force);
        await this.#refreshIndexStatus(store);
      } catch (error) {
        if (!this.#closed) for (const collection of watched) this.#watchCollections.add(collection);
        throw error;
      }
    });
  }

  syncSessions(
    force = false,
    onPhase?: (phase: "projecting" | "indexing") => void,
  ): Promise<SessionSyncResult> {
    return this.#enqueue(async () => {
      const sessions = this.#sessions;
      if (!sessions) throw new Error('memory session sync requires a configured "sessions" corpus');
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
      this.#sessionManifestMtimeNs = await this.#manifestMtimeNs(sessions.manifestPath);
      if (synced.result.skipReason) return synced.result;
      const store = await this.#getStore();
      await this.#refreshIndexStatus(store);
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
        collections: this.#indexCollections,
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

  reviewClaim(params: Omit<Parameters<typeof reviewIndexedClaim>[0], "db" | "sources" | "read"> & { corpora: readonly string[] }) {
    return this.#review(params.signal, context => reviewIndexedClaim({ ...params, ...context,
      sources: [...this.#sources.values()].filter(source => params.corpora.includes(source.corpus)),
    }));
  }

  reviewCluster(params: Omit<Parameters<typeof reviewClusterIngestion>[0], "db" | "sources" | "read"> & { corpora: readonly string[] }) {
    return this.#review(params.signal, context => reviewClusterIngestion({ ...params, ...context,
      sources: [...this.#sources.values()].filter(source => params.corpora.includes(source.corpus)),
    }));
  }

  async #review<T>(callerSignal: AbortSignal, run: (context: Pick<Parameters<typeof reviewIndexedClaim>[0], "db" | "signal" | "read">) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([callerSignal, this.#reviewLifetime.signal]);
    signal.throwIfAborted();
    const store = await abortable(this.#enqueue(async () => {
      signal.throwIfAborted();
      const store = await this.#getAnalysisStore();
      signal.throwIfAborted();
      return store;
    }), signal);
    const read = <R>(work: () => R) => {
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

  fetchCluster(params: {
    clusterId: string;
    topK?: number;
    offset?: number;
    sort?: MemoryClusterSort;
  }): Promise<MemoryClusterDetail> {
    return this.#enqueue(async () => {
      const db = (await this.#getAnalysisStore()).internal.db;
      this.#loadTemporalAnnotations(db);
      const detail = readCluster(
        db,
        params.clusterId,
        params.topK,
        params.offset,
        params.sort,
        { sessionCollection: this.#sessions?.collection },
      );
      if (params.sort === "date_asc" || params.sort === "date_desc") {
        for (const member of detail.members ?? []) {
          if (member.eventTime !== null) continue;
          const safe = parseSafeVirtualPath(member.eventTimeSource, this.#sources);
          if (!safe) continue;
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

  async listMaintenanceTasks(params: { status?: MaintenanceStatus; limit?: number } = {}): Promise<(MaintenanceTask & {
    indexPresence?: ReturnType<typeof qualityTaskPresence>;
  })[]> {
    return this.#runFenced(async () => {
      await this.#operationChain;
      const tasks = this.#getCuration().listTasks(params);
      if (!tasks.some(task => task.type === "quality_review")) return tasks;
      const store = await this.#getAnalysisStore();
      const fingerprints = new Map<string, Set<string>>();
      return tasks.map(task => ({ ...task, indexPresence: qualityTaskPresence(store.internal.db, task, fingerprints) }));
    });
  }

  async auditQuality(params: {
    corpora: readonly string[]; apiKey: string; endpoint?: string; model?: string; timeoutMs: number; minNoise: number;
    limit?: number; after?: QualityCursor; signal: AbortSignal;
  }) {
    if (this.#qualityAuditRunning) return { status: "busy" as const };
    this.#qualityAuditRunning = true;
    try {
      await this.#operationChain;
      params.signal.throwIfAborted();
      const store = await this.#getAnalysisStore();
      params.signal.throwIfAborted();
      if (this.#closed) return { status: "unavailable" as const };
      return await auditQualityPage({
        ...params, db: store.internal.db, curation: this.#getCuration(),
        sources: [...this.#sources.values()].filter(source =>
          source.kind !== "skills" && params.corpora.includes(source.corpus)),
        isActive: () => !this.#closed,
      });
    } finally {
      this.#qualityAuditRunning = false;
    }
  }

  updateMaintenanceTask(params: {
    id: string;
    status: Exclude<MaintenanceStatus, "pending">;
    note?: string;
    annotation?: {
      scope: "chunk" | "document";
      eventTime: string;
      basis: TemporalBasis;
      evidence: string;
    };
  }) {
    return this.#getCuration().updateTask(params);
  }

  #getCuration(): CurationStore {
    this.#assertOpen();
    this.#curation ??= new CurationStore(this.#curationPath);
    return this.#curation;
  }

  #loadTemporalAnnotations(db: AnalysisStore["internal"]["db"]): void {
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
    const fingerprints = new Map<string, Map<string, { hash: string; seq: number }>>();
    for (const annotation of curation.annotations()) {
      if (!annotation.contentFingerprint) {
        insert.run(
          annotation.collection,
          annotation.path,
          null,
          null,
          annotation.eventTime,
          annotation.basis,
          1,
        );
        continue;
      }
      const key = JSON.stringify([annotation.collection, annotation.path]);
      let chunks = fingerprints.get(key);
      if (!chunks) {
        chunks = new Map();
        const rows = findChunks.all<{ hash: string; seq: number; pos: number; chunk_len: number; doc: string }>(annotation.collection, annotation.path);
        for (const row of rows) {
          const fingerprint = chunkFingerprint(row.doc.slice(row.pos, row.pos + row.chunk_len));
          if (!chunks.has(fingerprint)) chunks.set(fingerprint, row);
        }
        fingerprints.set(key, chunks);
      }
      const matched = chunks.get(annotation.contentFingerprint);
      if (annotation.qmdHash !== (matched?.hash ?? null) || annotation.qmdSeq !== (matched?.seq ?? null)) {
        curation.updateAnnotationLocation({ annotation, qmdHash: matched?.hash ?? null, qmdSeq: matched?.seq ?? null });
      }
      if (matched) {
        insert.run(
          annotation.collection,
          annotation.path,
          matched.hash,
          matched.seq,
          annotation.eventTime,
          annotation.basis,
          0,
        );
      }
    }
  }

  #addDuplicateTasks(
    db: AnalysisStore["internal"]["db"],
    runId: string,
    members: readonly { hash: string; seq: number }[],
  ): void {
    if (members.length === 0) return;
    const pageMatch = members.map(() =>
      "(duplicates.canonical_hash = ? AND duplicates.canonical_seq = ?) OR " +
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
    `).all<{
      collection: string;
      path: string;
      content_fingerprint: string;
      occurrence_count: number;
    }>(runId, ...pageParams, ...sessionCollections);
    const curation = this.#getCuration();
    for (const row of rows) {
      const source = this.#sources.get(row.collection);
      if (!source || source.kind === "sessions") continue;
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

  async #getAnalysisStore(): Promise<AnalysisStore> {
    const store = await this.#getStore();
    if (!("internal" in store)) throw new Error("Memory analysis requires the QMD SQLite store");
    return store as AnalysisStore;
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(MANAGER_CLOSED_ERROR));
    const guardedRun = () => {
      this.#assertOpen();
      return run();
    };
    const result = (this.#operationChain ?? Promise.resolve()).then(guardedRun, guardedRun);
    this.#operationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async search(
    query: string,
    opts?: CorpusSearchOptions,
  ): Promise<CorpusMemorySearchResult[]> {
    const started = performance.now();
    const operation = "vector";
    let results: CorpusMemorySearchResult[];
    try {
      results = await this.#search(query, opts);
    } catch (error) {
      this.#retrievalTelemetry.record(operation, { elapsedMs: performance.now() - started,
        outcome: opts?.signal?.aborted ? "cancelled" : "failed" });
      throw error;
    }
    this.#retrievalTelemetry.record(operation, { elapsedMs: performance.now() - started,
      outcome: results.length ? "ok" : "empty", results: results.length,
      contextChars: results.reduce((sum, hit) => sum + hit.snippet.length, 0) });
    return results;
  }

  async #search(query: string, opts?: CorpusSearchOptions): Promise<CorpusMemorySearchResult[]> {
    return this.#runFenced(async () => {
      if (opts?.sources && !opts.sources.includes("memory")) return [];
      if (this.#sources.size === 0) return [];
      const collections = this.#collectionNames(opts?.corpora);
      opts?.signal?.throwIfAborted();
      await this.#operationChain;
      const sessions = this.#sessions;
      opts?.signal?.throwIfAborted();
      if (sessions && collections.includes(sessions.collection)) {
        await this.#refreshSessionMetadata();
      }
      const store = await this.#getStore();
      opts?.signal?.throwIfAborted();
      const allowedPaths = this.#allowedPaths(collections, opts?.sessionFilter);
      const hits = await store.vsearch(query, {
        collection: collections,
        limit: opts?.maxResults ?? 5,
        minScore: opts?.minScore ?? 0.3,
        allowedPaths,
        expand: false,
      });
      opts?.signal?.throwIfAborted();
      return this.#renderSearchHits(hits, store, opts);
    });
  }

  /** Shared discovery: exact trained recipe, scoped before either retrieval lane. */
  async searchCandidates(queries: QueryPair, opts: CorpusSearchOptions): Promise<CorpusMemorySearchResult[]> {
    const [result] = await this.#searchCandidateJob([queries], opts, true);
    if (result!.status === "rejected") throw result!.reason;
    return result!.value;
  }

  /**
   * Multi-topic discovery in ONE serialized job: one queue slot behind background indexing, one metadata refresh
   * and store setup, then each topic's lanes in order. A failed topic settles alone; cancellation fails the job.
   */
  async searchCandidateTopics(topics: readonly QueryPair[], opts: CorpusSearchOptions):
    Promise<PromiseSettledResult<CorpusMemorySearchResult[]>[]> {
    return this.#searchCandidateJob(topics, opts, false);
  }

  async #searchCandidateJob(topics: readonly QueryPair[], opts: CorpusSearchOptions, rethrow: boolean):
    Promise<PromiseSettledResult<CorpusMemorySearchResult[]>[]> {
    const { timings, signal } = opts;
    const endQueueWait = startTiming("queueWaitMs", timings, signal);
    try {
      return await this.#enqueue(async () => {
        endQueueWait();
        opts.signal?.throwIfAborted();
        const collections = this.#collectionNames(opts.corpora);
        if (!collections.length) return topics.map(() => ({ status: "fulfilled" as const, value: [] }));
        const allowedPaths = await timeStage("metadataMs", timings, signal, async () => {
          if (this.#sessions && collections.includes(this.#sessions.collection)) {
            const reloaded = await this.#refreshSessionMetadata();
            if (timings && !signal?.aborted) timings.metadataReloads = Number(reloaded);
          }
          return this.#allowedPaths(collections, opts.sessionFilter);
        });
        const store = await timeStage("storeSetupMs", timings, signal, () => this.#getAnalysisStore()) as QMDStore;
        const settled: PromiseSettledResult<CorpusMemorySearchResult[]>[] = [];
        for (const queries of topics) {
          opts.signal?.throwIfAborted();
          try {
            settled.push({ status: "fulfilled", value: await this.#discoverCandidates(store, queries, collections, allowedPaths, opts) });
          } catch (reason) {
            if (rethrow || opts.signal?.aborted) throw reason;
            settled.push({ status: "rejected", reason });
          }
        }
        return settled;
      });
    } finally { endQueueWait(); }
  }

  async #discoverCandidates(store: QMDStore, queries: QueryPair, collections: string[],
    allowedPaths: AllowedDocumentPaths | undefined, opts: CorpusSearchOptions): Promise<CorpusMemorySearchResult[]> {
    const { timings, signal } = opts;
    const RRF_K = 60;
    const hits = new Map<string, { hit: PassageHit; rrfScore: number; topRank: number }>();
    // Serialize native QMD work. Cancellation prevents further queries/collections.
    for (const lane of ["lex", "vec"] as const) {
      opts.signal?.throwIfAborted();
      let candidates;
      try {
        candidates = await timeStage(lane === "lex" ? "bm25Ms" : "vectorMs", timings, signal,
          () => discoverLaneCandidates(store, queries[lane], collections, lane, opts.signal, allowedPaths,
            lane === "vec" ? vectorTrace(timings, signal) : undefined));
      } finally {
        if (lane === "vec" && timings?.vectorMs !== undefined) {
          timings.vectorOtherMs = unaccounted(timings.vectorMs, timings, vectorParts);
        }
      }
      for (const [index, hit] of candidates.entries()) {
        const rank = hit.bm25?.rank ?? hit.vector?.rank ?? index + 1;
        const contribution = 1 / (RRF_K + rank);
        const { ref } = hit;
        const key = JSON.stringify(ref
          ? [hit.file, ref.docHash, ref.chunkPos, ref.chunkLen]
          : [hit.file, hit.bestChunkPos, hit.bestChunk.trim()]);
        const existing = hits.get(key);
        if (existing) {
          existing.rrfScore += contribution;
          existing.topRank = Math.min(existing.topRank, rank);
          if (ref && ref.seq !== null && existing.hit.ref?.seq === null) existing.hit.ref = ref;
        } else {
          hits.set(key, {
            hit: { file: hit.file, body: hit.body, bestChunk: hit.bestChunk,
              chunkPos: hit.bestChunkPos, chunkLen: hit.bestChunk.length, displayPath: hit.file, score: 0, ref },
            rrfScore: contribution,
            topRank: rank,
          });
        }
      }
    }
    // Passage-level RRF (k=60) with QMD's top-rank bonuses so rank-1 single-lane
    // hits compete cleanly alongside dual-lane matches before any candidate cap.
    const fused = [...hits.values()].map(entry => ({
      ...entry.hit,
      score: entry.rrfScore + (entry.topRank === 1 ? 0.05 : entry.topRank <= 3 ? 0.02 : 0),
    })).sort((a, b) => b.score - a.score);
    opts.signal?.throwIfAborted();
    return timeStage("passageMs", timings, signal, () => this.#renderSearchHits(fused, store, opts, true));
  }

  async #renderSearchHits(
    hits: readonly PassageHit[],
    store: ManagerStore, opts?: Pick<CorpusSearchOptions, "maxSnippetChars" | "signal" | "sessionFilter">, whisperer = false,
  ): Promise<CorpusMemorySearchResult[]> {
    const tokenizer = (store as Partial<AnalysisStore>).internal?.llm;
    const results: CorpusMemorySearchResult[] = [];
    const current = new Map(this.#currentExtracted(hits.map(hit => hit.file), opts?.sessionFilter).map(r => [extractedUri(r), r]));
    for (const hit of hits) {
      opts?.signal?.throwIfAborted();
      // Proactive hints must retain the entire matched chunk, even when expanded
      // turn/message context exceeds their budget. Ordinary search is unchanged.
      if (hit.bestChunk.length > (opts?.maxSnippetChars ?? Infinity)) continue;
      const { ref } = hit;
      const locator = this.#trackRecallLocators ? {
        docHash: ref?.docHash,
        qmdSeq: ref?.seq ?? undefined,
        chunkPos: ref?.chunkPos ?? hit.chunkPos,
        chunkLen: ref?.chunkLen ?? hit.chunkLen,
      } : undefined;
      const collection = /^qmd:\/\/([^/]+)\//.exec(hit.file)?.[1];
      if (collection === EXTRACTED_COLLECTION) {
        const record = current.get(hit.file);
        if (record && record.text.length <= (opts?.maxSnippetChars ?? Infinity)) {
          const item = extractedHit(record, hit.score);
          if (locator) {
            item.locator = {
              ...locator,
              rawLeafId: memoryPassageId(hit.bestChunk || record.text),
              observedAtMs: Number.isFinite(record.observedAt) ? record.observedAt : undefined,
              observedAtBasis: Number.isFinite(record.observedAt) ? "extracted" : "unknown",
            };
          }
          results.push(item);
        }
        continue;
      }
      const source = collection ? this.#sources.get(collection) : undefined;
      const corpus = source?.corpus;
      if (!corpus || !source) continue;
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
          projection.projectionHash === (ref?.docHash ?? projectionHash(hit.body))
          ? projection.messages : parseSessionMessageSpans(hit.body)
        : undefined;
      const contextSpan = messages ? sessionContextSpans(hit.body, hit.chunkPos, messages) : undefined;
      const messageTimestamp = contextSpan?.message.timestamp;
      const messageTimestampMs = contextSpan?.message.timestampMs;
      const selected = whisperer ? await renderMemoryPassage(hit, messages)
        : corpus === "sessions" && this.#sessions && tokenizer
        ? await expandSessionSearchHit(
            hit,
            this.#sessions.maxExpandedTokens,
            (text) => tokenizer.countTokens(text),
            opts?.maxSnippetChars,
            messages,
          )
        : { text: hit.bestChunk, position: hit.chunkPos };
      if (!selected?.text) continue;
      const span = lineSpan(hit.body, selected.position, selected.sourceText ?? selected.text);
      const item: CorpusMemorySearchResult = {
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
      };
      if (locator) {
        const isMemoryDateSource = corpus !== "sessions" && relativePath !== undefined && (
          corpus === "memory" || basename(source.root) === "memory" || /(?:^|\/)memory\//u.test(relativePath)
        );
        const fileDateMs = isMemoryDateSource && relativePath ? parseDailyFilenameDateMs(relativePath) : undefined;
        item.locator = {
          ...locator,
          rawLeafId: memoryPassageId(hit.bestChunk),
          observedAtMs: messageTimestampMs ?? fileDateMs,
          observedAtBasis: messageTimestampMs !== undefined
            ? "session_message"
            : fileDateMs !== undefined
            ? "filename_date"
            : "unknown",
        };
      }
      results.push(item);
    }
    // Expansion above can yield; recheck only derived hits once more before returning.
    const finalPaths = new Set(this.#currentExtracted(results.map(hit => hit.path), opts?.sessionFilter).map(extractedUri));
    return results.filter(hit => !hit.path.startsWith(EXTRACTED_PREFIX) || finalPaths.has(hit.path));
  }

  async listSkills(): Promise<SkillCatalogEntry[]> {
    return this.#getSkillCatalog().map((entry) => ({ ...entry }));
  }

  skillAliases(canonicalPath: string): readonly string[] {
    this.#getSkillCatalog();
    return this.#skillCatalog?.aliases.get(canonicalPath) ?? [];
  }

  #getSkillCatalog(): readonly SkillCatalogEntry[] {
    this.#assertOpen();
    if (!this.#hasSkills) return [];
    this.#startWatcher();
    if (!this.#skillCatalog) {
      const byName = new Map<string, SkillCatalogEntry>();
      const aliases = new Map<string, string[]>();
      for (const source of this.#sources.values()) {
        if (source.kind !== "skills") continue;
        for (const entry of readSkillSource(source)) {
          const canonical = resolveConfiguredSkillPath(this.#workspaceDir, entry.path, [source]);
          if (!canonical) continue;
          if (canonical !== entry.path) {
            const paths = aliases.get(canonical);
            if (paths) paths.push(entry.path);
            else aliases.set(canonical, [entry.path]);
          }
          const key = entry.name.toLowerCase();
          if (!byName.has(key)) byName.set(key, entry);
        }
      }
      this.#skillCatalog = { entries: [...byName.values()], aliases };
    }
    return this.#skillCatalog.entries;
  }

  async searchSkills(query: string, minScore: number, limit: number): Promise<SkillSearchCandidate[]> {
    return this.#runFenced(async () => {
      if (!this.#hasSkills) return [];
      await this.#operationChain;
      const store = await this.#getStore() as Partial<AnalysisStore>;
      if (!store.internal?.llm) throw new Error("Skill Whisperer requires the QMD embedding model");
      const llm = store.internal.llm;
      const { formatDocForEmbedding, formatQueryForEmbedding } = await import("@unblocklabs/qmd");
      this.#assertOpen();
      let skillIndex = this.#skillIndex;
      if (!skillIndex) {
        const pending = (async () => {
          const skills = this.#getSkillCatalog();
          const embeddings = await llm.embedBatch(
            skills.map((candidate) =>
              formatDocForEmbedding(candidate.description, candidate.name, llm.embedModelName)),
          );
          return skills.flatMap((candidate, index) => {
            const embedding = embeddings[index]?.embedding;
            return embedding ? [{ ...candidate, score: 0, embedding }] : [];
          });
        })();
        skillIndex = pending.catch((error) => {
          if (this.#skillIndex === skillIndex) this.#skillIndex = undefined;
          throw error;
        });
        this.#skillIndex = skillIndex;
      }
      const queryEmbedding = await llm.embed(formatQueryForEmbedding(query, llm.embedModelName), { isQuery: true });
      if (!queryEmbedding) return [];
      const candidates = await skillIndex;
      return candidates
        .map(({ embedding, ...candidate }) => ({
          ...candidate,
          score: cosineSimilarity(queryEmbedding.embedding, embedding),
        }))
        .filter((candidate) => candidate.score >= minScore)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    });
  }

  // OpenClaw's line-only read contract cannot return a stale cursor.
  readFile(params: MemoryReadParams & { cursor?: undefined }): Promise<Exclude<MemoryReadResult, { status: "stale_cursor" }>>;
  readFile(params: MemoryReadParams): Promise<MemoryReadResult>;
  async readFile(params: MemoryReadParams): Promise<MemoryReadResult> {
    return this.#runFenced(async () => {
      const { relPath, from, lines, cursor } = params;
      const notFound = (): MemoryReadResult => cursor ? staleReadCursor(relPath) :
        { status: "not_found", text: "", path: relPath };
      if (relPath.startsWith(EXTRACTED_PREFIX)) {
        const record = this.#currentExtracted([relPath]).find(r => relPath === extractedUri(r));
        return record ? buildReadResult({ content: `${record.text}\nObserved: ${new Date(record.observedAt).toISOString()}\nSource: ${extractedHit(record, 1).citation}`,
          path: relPath, from, lines, cursor }) : notFound();
      }
      const safe = parseSafeVirtualPath(relPath, this.#sources);
      if (!safe || safe.source.kind === "skills") return notFound();
      await this.#operationChain;
      const store = await this.#getStore();
      const doc = await store.get(safe.normalized, { includeBody: true });
      if ("error" in doc || doc.filepath !== safe.normalized || doc.body === undefined) return notFound();
      return buildReadResult({ content: doc.body, path: safe.normalized, from, lines, cursor });
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
          : {
              name,
              kind: sources[0]?.kind === "skills" ? "skills" : "files",
              paths: sources.map((source) => source.configuredPath),
            }),
        ...(this.#watchError ? { watchError: this.#watchError } : {}),
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return this.#runFenced(async () => {
      await this.#getStore();
      return { ok: true, checked: true, checkedAtMs: Date.now() };
    });
  }

  async probeVectorAvailability(): Promise<boolean> {
    return this.#runFenced(async () => {
      const status = await (await this.#getStore()).getStatus();
      return status.hasVectorIndex;
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#reviewLifetime.abort();
    if (!this.#closePromise) {
      this.#closePromise = this.#close();
    }
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.#watchTimer = undefined;
    this.#watchCollections.clear();
    await this.#watcher?.close();
    this.#watcher = undefined;
    this.#watchReady = undefined;
    await this.#operationChain?.catch(() => undefined);
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight]);
    }
    await this.#storePromise?.catch(() => undefined);
    await this.#store?.close();
    this.#store = undefined;
    this.#storePromise = undefined;
    this.#curation?.close();
    this.#curation = undefined;
  }
}
