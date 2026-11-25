import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { projectionHash, readSessionManifest } from "./session-sync.js";
import { resolveSessionSource } from "./sources.js";
import { trainingCandidates } from "./training-candidates.js";
import { MEMORY_PASSAGE_VERSION, renderMemoryPassage, duplicateMemoryPassage } from "./memory-passage.js";
export const TRAINING_RETRIEVAL_VERSION = `qmd-2.10.2-historical-lanes-depth10-v3:${MEMORY_PASSAGE_VERSION}`;
export const TRAINING_SEARCH_OPTIONS = { vector: 10, bm25: 10, mergedLimit: null, rerank: false };
/** Missing historical evidence is reviewable; unexpected SQLite/I/O failures remain fatal. */
export class HistoricalCorpusUnavailableError extends Error {
}
function createYielder(budgetMs = 25) {
    let yieldAt = performance.now() + budgetMs;
    return async () => {
        if (performance.now() >= yieldAt) {
            await yieldToEventLoop();
            yieldAt = performance.now() + budgetMs;
        }
    };
}
function assertFileExists(path, unavailableMessage) {
    try {
        statSync(path);
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            throw new HistoricalCorpusUnavailableError(unavailableMessage);
        }
        throw error;
    }
}
function inspectHistoricalPrefix(body, spans, cutoff) {
    if (!spans?.length || !body.startsWith("# Transcript\n\n") || !Number.isFinite(cutoff))
        return { status: "unproven" };
    let previousEnd = 14;
    const parsed = [];
    for (const span of spans) {
        if (![span.start, span.bodyStart, span.end].every(Number.isSafeInteger) || span.start < previousEnd ||
            span.bodyStart <= span.start || span.end < span.bodyStart || span.end > body.length ||
            body.slice(previousEnd, span.start).trim())
            return { status: "unproven" };
        const heading = `## ${span.type === "user" ? "User" : "Assistant"} — ${span.name} — ${span.timestamp}\n\n`;
        if (body.slice(span.start, span.bodyStart) !== heading)
            return { status: "unproven" };
        // Explicit zones only: no process-local timezone interpretation. Unknown zones fail closed.
        const time = typeof span.timestamp === "string" && / (?:UTC|GMT(?:[+-]\d{1,2}(?::\d{2})?)?|[ECMP][SD]T)$/u.test(span.timestamp)
            ? Date.parse(span.timestamp) : NaN;
        parsed.push({ span, time });
        previousEnd = span.end;
    }
    if (body.slice(previousEnd).trim())
        return { status: "unproven" };
    // Projection dates have second precision. Exclude the entire cutoff second,
    // including the current question, equal-time replies and crossing chunks.
    const before = Math.floor(cutoff / 1000) * 1000;
    const safe = [];
    let unprovenTimestamp = false;
    for (const item of parsed) {
        if (!Number.isFinite(item.time)) {
            unprovenTimestamp = true;
            break;
        }
        if (item.time >= before)
            break;
        safe.push(item);
    }
    if (!safe.length)
        return { status: unprovenTimestamp ? "unproven" : "empty" };
    return { status: "prefix", body: body.slice(0, parsed[safe.length]?.span.start ?? body.length), spans: safe.map(s => s.span) };
}
/** Never infer dates by parsing message bodies: headings can be quoted or forged. */
export function historicalPrefix(body, spans, cutoff) {
    const inspected = inspectHistoricalPrefix(body, spans, cutoff);
    return inspected.status === "prefix" ? { body: inspected.body, spans: inspected.spans } : undefined;
}
async function captureSourceSessions(stateDir, chatTypes) {
    const indexPath = join(stateDir, "index.sqlite");
    const manifestPath = join(stateDir, "sessions-manifest.json");
    assertFileExists(indexPath, "No QMD index; sync sessions before evaluating training queries");
    assertFileExists(manifestPath, "No session manifest; sync sessions before evaluating training queries");
    const manifest = await readSessionManifest(manifestPath);
    if (manifest.failedSessions && Object.keys(manifest.failedSessions).length > 0) {
        throw new HistoricalCorpusUnavailableError("Session manifest has unavailable/failed sessions; sync sessions before evaluating training queries");
    }
    if (typeof manifest.lastSuccessfulSyncAt !== "number" || !Number.isFinite(manifest.lastSuccessfulSyncAt) ||
        typeof manifest.indexSignature !== "string" || !manifest.indexSignature.trim()) {
        throw new HistoricalCorpusUnavailableError("Session manifest is uncertified; sync sessions before evaluating training queries");
    }
    const source = resolveSessionSource(join(stateDir, "sessions"), chatTypes);
    // Use QMD's exact binding, never mix node:sqlite with sqlite-vec.
    const requireQmd = createRequire(import.meta.resolve("@unblocklabs/qmd"));
    const Database = requireQmd("better-sqlite3");
    const sourceDb = new Database(indexPath, { readonly: true, fileMustExist: true });
    const sessions = [];
    const unbackedSessions = [];
    let excluded = 0;
    let settings;
    try {
        const extension = requireQmd("sqlite-vec");
        if (!extension || typeof extension !== "object" || !("getLoadablePath" in extension) || typeof extension.getLoadablePath !== "function") {
            throw new Error("QMD sqlite-vec extension unavailable");
        }
        const extensionPath = extension.getLoadablePath();
        if (typeof extensionPath !== "string")
            throw new Error("QMD sqlite-vec path unavailable");
        sourceDb.loadExtension(extensionPath);
        sourceDb.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
        settings = sourceDb.prepare("SELECT key,value FROM store_config WHERE key='embedding_chunk_strategy'").all();
        const manifestSessions = Object.values(manifest.sessions).sort((a, b) => a.documentPath.localeCompare(b.documentPath));
        if (!manifestSessions.length) {
            const hasIndexedDocs = sourceDb.prepare("SELECT 1 FROM documents WHERE active=1 AND collection=? LIMIT 1").get(source.collection);
            if (hasIndexedDocs) {
                throw new HistoricalCorpusUnavailableError("Session manifest is unbacked by QMD index; sync sessions before evaluating training queries");
            }
        }
        const document = sourceDb.prepare(`SELECT d.hash,c.doc FROM documents d JOIN content c ON c.hash=d.hash
        WHERE d.active=1 AND d.collection=? AND d.path=?`);
        const hasVectorsTable = Boolean(sourceDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vectors_vec'").get());
        const chunks = hasVectorsTable
            ? sourceDb.prepare(`SELECT cv.seq,cv.pos,cv.chunk_len,cv.model,cv.embed_fingerprint,v.embedding
          FROM content_vectors cv JOIN vectors_vec v ON v.hash_seq=cv.hash||'_'||cv.seq
          WHERE cv.hash=? ORDER BY cv.seq`)
            : undefined;
        const vectors = new Map();
        const maybeYield = createYielder(25);
        for (const session of manifestSessions) {
            await maybeYield();
            // Loggie projections can retroactively annotate old text using later revisions.
            // Workspace files and meetings lack immutable historical content proof here.
            if (!chatTypes.includes(session.chatType) || session.provider === "loggie") {
                excluded++;
                continue;
            }
            const row = document.get(source.collection, session.documentPath);
            if (!row || projectionHash(row.doc) !== session.projectionHash) {
                excluded++;
                unbackedSessions.push(session);
                continue;
            }
            let captured = vectors.get(row.hash);
            if (!captured) {
                captured = [];
                if (chunks) {
                    for (const chunk of chunks.iterate(row.hash)) {
                        await maybeYield();
                        captured.push({ ...chunk, embedding: Buffer.from(chunk.embedding) });
                    }
                }
                vectors.set(row.hash, captured);
            }
            sessions.push({ session, body: row.doc, chunks: captured });
        }
    }
    finally {
        sourceDb.close();
    }
    return { source, sessions, unbackedSessions, excluded, settings };
}
async function selectCutoffDocuments(captured, chatTypes, cutoff) {
    const maxDate = new Date(cutoff).toISOString();
    const report = { sessions: 0, chunks: 0, excluded: captured.excluded, truncated: 0, excludedChunks: 0 };
    const metadata = new Map();
    const fingerprint = createHash("sha256").update(JSON.stringify([TRAINING_RETRIEVAL_VERSION, chatTypes.toSorted(), maxDate]));
    fingerprint.update(JSON.stringify(captured.settings));
    const documents = [];
    let dimensions;
    let unprovenBeforeCutoff = captured.unbackedSessions.some(session => !Number.isFinite(session.startedAt) || session.startedAt < cutoff);
    const maybeYield = createYielder(25);
    for (const { session, body, chunks } of captured.sessions) {
        await maybeYield();
        if (session.startedAt >= cutoff) {
            report.excluded++;
            continue;
        }
        const prefix = inspectHistoricalPrefix(body, session.messages, cutoff);
        if (prefix.status !== "prefix") {
            report.excluded++;
            if (prefix.status === "unproven")
                unprovenBeforeCutoff = true;
            continue;
        }
        const hash = createHash("sha256").update(prefix.body).digest("hex");
        const safeChunks = [];
        documents.push({ path: session.documentPath, hash, body: prefix.body, chunks: safeChunks });
        metadata.set(`qmd://${captured.source.collection}/${session.documentPath}`, prefix.spans);
        fingerprint.update(JSON.stringify([session.documentPath, hash]));
        report.sessions++;
        if (prefix.spans.length < (session.messages?.length ?? 0))
            report.truncated++;
        for (const chunk of chunks) {
            await maybeYield();
            if (!historicalChunk(chunk, prefix.body.length)) {
                report.excludedChunks++;
                continue;
            }
            const bytes = chunk.embedding;
            if (bytes.length % 4 || !bytes.length)
                throw new Error("Invalid historical embedding");
            const size = bytes.length / 4;
            dimensions ??= size;
            if (dimensions !== size)
                throw new Error("Mixed historical embedding dimensions");
            safeChunks.push(chunk);
            fingerprint.update(JSON.stringify([chunk.seq, chunk.pos, chunk.chunk_len, chunk.model, chunk.embed_fingerprint])).update(bytes);
            report.chunks++;
        }
    }
    return { corpusHash: fingerprint.digest("hex"), maxDate, report, metadata, documents, dimensions, unprovenBeforeCutoff };
}
async function materializeQmdStore(createStore, source, settings, documents, dimensions, maxDate) {
    let qmd;
    try {
        qmd = await createStore({ dbPath: ":memory:", keepModelsWarm: true,
            config: { collections: { [source.collection]: { path: source.root, pattern: "**/*.md" } } } });
        // One native embedding context per snapshot; serialize only vector search.
        const searchVec = qmd.internal.searchVec;
        let vectorTail = Promise.resolve();
        qmd.internal.searchVec = (...args) => {
            const result = vectorTail.then(() => searchVec(...args));
            vectorTail = result.then(() => { }, () => { });
            return result;
        };
        const db = qmd.internal.db;
        db.exec("BEGIN");
        for (const { key, value } of settings)
            db.prepare("INSERT OR REPLACE INTO store_config VALUES (?,?)").run(key, value);
        if (dimensions !== undefined)
            qmd.internal.ensureVecTable(dimensions);
        const maybeYield = createYielder(25);
        for (const document of documents) {
            await maybeYield();
            qmd.internal.insertContent(document.hash, document.body, maxDate);
            qmd.internal.insertDocument(source.collection, document.path, "Transcript", document.hash, maxDate, maxDate);
            for (const chunk of document.chunks) {
                await maybeYield();
                const bytes = Buffer.from(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength);
                const vector = new Float32Array(bytes.length / 4);
                for (let i = 0; i < vector.length; i++)
                    vector[i] = bytes.readFloatLE(i * 4);
                qmd.internal.insertEmbedding(document.hash, chunk.seq, chunk.pos, vector, chunk.model, maxDate, 1, chunk.embed_fingerprint, chunk.chunk_len);
            }
        }
        db.exec("COMMIT");
        return qmd;
    }
    catch (error) {
        await qmd?.close();
        throw error;
    }
}
/** Capture source bytes once per run; each cutoff still owns its index and native model context. */
export async function historicalTrainingSource(stateDir, chatTypes) {
    const captured = await captureSourceSessions(stateDir, chatTypes);
    return async (cutoff, openStore) => {
        const createStore = openStore ?? (await import("@unblocklabs/qmd")).createStore;
        const { corpusHash, maxDate, report, metadata, documents, dimensions, unprovenBeforeCutoff } = await selectCutoffDocuments(captured, chatTypes, cutoff);
        if (report.sessions && unprovenBeforeCutoff) {
            throw new HistoricalCorpusUnavailableError("Historical snapshot cannot prove a complete cutoff; sync sessions before evaluating training queries");
        }
        const proven = report.sessions > 0 ? report.chunks > 0 : !unprovenBeforeCutoff;
        let closed = false;
        let indexed;
        return { corpusHash, report, maxDate, proven,
            search: async (query, lane) => {
                if (closed)
                    throw new Error("Historical snapshot is closed");
                if (!report.sessions) {
                    if (unprovenBeforeCutoff) {
                        throw new HistoricalCorpusUnavailableError("Historical snapshot cannot prove an empty cutoff; sync sessions before evaluating training queries");
                    }
                    return [];
                }
                if (lane === "vec" && !report.chunks) {
                    throw new HistoricalCorpusUnavailableError("Historical snapshot has no vectors; refusing an unresolved vector evaluation");
                }
                const qmd = await (indexed ??= materializeQmdStore(createStore, captured.source, captured.settings, documents, dimensions, maxDate));
                const hits = await trainingCandidates(qmd, query, captured.source.collection, lane);
                const rendered = await Promise.all(hits.map(hit => trainingHit(hit, metadata, cutoff)));
                const distinct = [];
                for (const hit of rendered)
                    if (hit && !duplicateMemoryPassage(hit, distinct))
                        distinct.push(hit);
                return distinct;
            }, close: async () => {
                if (closed)
                    return;
                closed = true;
                try {
                    if (indexed)
                        await indexed.then(qmd => qmd.close(), () => { });
                }
                finally {
                    documents.length = 0;
                }
            } };
    };
}
/** Standalone calls get a fresh source capture; evaluation runs reuse their own capture. */
export async function historicalTrainingSearch(stateDir, chatTypes, cutoff, openStore) {
    const source = await historicalTrainingSource(stateDir, chatTypes);
    return source(cutoff, openStore);
}
function historicalChunk(chunk, length) {
    return Number.isSafeInteger(chunk.pos) && Number.isSafeInteger(chunk.chunk_len) && chunk.pos >= 0 && chunk.chunk_len > 0 &&
        chunk.pos + chunk.chunk_len <= length;
}
async function trainingHit(hit, metadata, cutoff) {
    const messages = metadata.get(hit.file);
    const selected = await renderMemoryPassage({ body: hit.body, bestChunk: hit.bestChunk,
        chunkPos: hit.bestChunkPos, chunkLen: hit.bestChunk.length }, messages);
    if (!selected)
        return;
    const spans = messages?.filter(s => s.start < selected.position + (selected.sourceText ?? selected.text).length && s.end > selected.position);
    if (!spans?.length || spans.some(s => !(Date.parse(s.timestamp) < Math.floor(cutoff / 1000) * 1000)) ||
        hit.body.slice(hit.bestChunkPos, hit.bestChunkPos + hit.bestChunk.length) !== hit.bestChunk) {
        throw new Error("QMD returned evidence outside the historical snapshot");
    }
    const startLine = hit.body.slice(0, selected.position).split("\n").length;
    const endLine = startLine + (selected.sourceText ?? selected.text).split("\n").length - 1;
    return { path: hit.file, corpus: "sessions", position: selected.position, text: selected.text, startLine, endLine,
        dates: [...new Set(spans.map(s => s.timestamp))],
        score: hit.score, methods: hit.explain?.methods ?? [] };
}
