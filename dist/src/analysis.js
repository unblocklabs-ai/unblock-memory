import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
const DEFAULT_CLUSTER_LIMIT = 20;
const MAX_CLUSTER_LIMIT = 50;
const DEFAULT_MEMBER_LIMIT = 20;
const MAX_MEMBER_LIMIT = 50;
const MAX_EXCERPT_BYTES = 2_000;
const MAX_TOTAL_EXCERPT_BYTES = 12_000;
const MAX_ALIASES_PER_MEMBER = 5;
const MAX_TOTAL_ALIASES = 50;
export function ensureMemoryAnalysisSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS memory_analysis_runs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      input_digest TEXT NOT NULL,
      model TEXT NOT NULL,
      embedding_fingerprint TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      params_json TEXT NOT NULL,
      stale_at TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_analysis_clusters (
      run_id TEXT NOT NULL,
      cluster_id INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mean_probability REAL NOT NULL,
      PRIMARY KEY (run_id, cluster_id),
      FOREIGN KEY (run_id) REFERENCES memory_analysis_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memory_analysis_memberships (
      run_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL,
      cluster_id INTEGER NOT NULL,
      probability REAL NOT NULL,
      outlier_score REAL NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      representative_rank INTEGER,
      PRIMARY KEY (run_id, hash, seq),
      FOREIGN KEY (run_id) REFERENCES memory_analysis_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memory_analysis_memberships_cluster
      ON memory_analysis_memberships(run_id, cluster_id, representative_rank);

    CREATE TABLE IF NOT EXISTS memory_analysis_duplicate_occurrences (
      run_id TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      canonical_hash TEXT NOT NULL,
      canonical_seq INTEGER NOT NULL,
      duplicate_hash TEXT NOT NULL,
      duplicate_seq INTEGER NOT NULL,
      PRIMARY KEY (run_id, duplicate_hash, duplicate_seq),
      FOREIGN KEY (run_id) REFERENCES memory_analysis_runs(id) ON DELETE CASCADE
    );

    CREATE VIEW IF NOT EXISTS memory_analysis_available_memberships AS
    SELECT
      m.run_id, m.hash, m.seq, m.cluster_id, m.probability, m.outlier_score,
      m.x, m.y, m.representative_rank, cv.pos, cv.chunk_len, c.doc
    FROM memory_analysis_memberships m
    JOIN content_vectors cv ON cv.hash = m.hash AND cv.seq = m.seq
    JOIN content c ON c.hash = m.hash
    WHERE EXISTS (
      SELECT 1
      FROM documents d
      WHERE d.hash = m.hash AND d.active = 1
    );
  `);
    db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS memory_temporal_annotations (
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      qmd_hash TEXT,
      qmd_seq INTEGER,
      event_time TEXT NOT NULL,
      basis TEXT NOT NULL,
      document_wide INTEGER NOT NULL,
      PRIMARY KEY (collection, path, qmd_hash, qmd_seq, document_wide)
    );
  `);
}
export function markMemoryAnalysisStale(db) {
    db.prepare(`
    UPDATE memory_analysis_runs
    SET stale_at = COALESCE(stale_at, CURRENT_TIMESTAMP)
    WHERE id = (
      SELECT id
      FROM memory_analysis_runs
      WHERE completed_at IS NOT NULL
      ORDER BY completed_at DESC, created_at DESC, id DESC
      LIMIT 1
    )
  `).run();
}
export function clusterReference(runId, clusterId) {
    return createHash("sha256").update(`${runId}\0${clusterId}`).digest("hex").slice(0, 10);
}
export function runAnalysisWorker(params) {
    return new Promise((resolve, reject) => {
        params.signal?.throwIfAborted();
        const args = ["--db", params.dbPath, "--collections-json", JSON.stringify(params.collections)];
        if (params.options && Object.keys(params.options).length > 0) {
            args.push("--config-json", JSON.stringify(params.options));
        }
        const child = spawn(params.executable, args, {
            shell: false,
            stdio: ["ignore", "ignore", "pipe"],
        });
        const stderr = [];
        let stderrBytes = 0;
        const maxErrorBytes = 16_384;
        child.stderr.on("data", (chunk) => {
            if (stderrBytes >= maxErrorBytes)
                return;
            const remaining = maxErrorBytes - stderrBytes;
            stderr.push(chunk.subarray(0, remaining));
            stderrBytes += Math.min(chunk.length, remaining);
        });
        let settled = false;
        let aborted = false;
        let abortReason;
        let forceKill;
        const cleanup = () => {
            params.signal?.removeEventListener("abort", onAbort);
            if (forceKill)
                clearTimeout(forceKill);
        };
        const finish = (error, shouldReject = error !== undefined) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            shouldReject ? reject(error) : resolve();
        };
        const onAbort = () => {
            if (aborted)
                return;
            aborted = true;
            abortReason = params.signal?.reason;
            child.kill("SIGTERM");
            forceKill = setTimeout(() => {
                if (!settled)
                    child.kill("SIGKILL");
            }, 250);
            forceKill.unref();
        };
        params.signal?.addEventListener("abort", onAbort, { once: true });
        if (params.signal?.aborted)
            onAbort();
        child.on("error", (error) => finish(aborted ? abortReason : error, true));
        child.on("close", (code, signal) => {
            if (aborted) {
                finish(abortReason, true);
                return;
            }
            if (code === 0) {
                finish();
                return;
            }
            const detail = Buffer.concat(stderr).toString("utf8").trim();
            finish(new Error(`Memory analysis worker ${signal ? `was terminated by ${signal}` : `exited with code ${code ?? "unknown"}`}${detail ? `: ${detail}` : ""}`));
        });
    });
}
function latestRun(db) {
    return db.prepare(`
    SELECT id, created_at, completed_at, input_digest, model, embedding_fingerprint, dimensions, stale_at
    FROM memory_analysis_runs
    WHERE completed_at IS NOT NULL
    ORDER BY completed_at DESC, created_at DESC, id DESC
    LIMIT 1
  `).get();
}
export function latestAnalysisRunId(db) {
    return latestRun(db)?.id;
}
export function latestAnalysisCollections(db) {
    const row = db.prepare(`
    SELECT params_json
    FROM memory_analysis_runs
    WHERE completed_at IS NOT NULL
    ORDER BY completed_at DESC, created_at DESC, id DESC
    LIMIT 1
  `).get();
    if (!row)
        return undefined;
    try {
        const collections = JSON.parse(row.params_json).collections;
        return Array.isArray(collections) && collections.every((value) => typeof value === "string")
            ? collections
            : undefined;
    }
    catch {
        return undefined;
    }
}
function count(db, sql, runId) {
    return db.prepare(sql).get(runId)?.count ?? 0;
}
function analysisSummary(db, run) {
    const clusters = count(db, "SELECT COUNT(*) AS count FROM memory_analysis_clusters WHERE run_id = ?", run.id);
    const members = count(db, "SELECT COUNT(*) AS count FROM memory_analysis_memberships WHERE run_id = ?", run.id);
    const expectedNonNoise = count(db, "SELECT COALESCE(SUM(size), 0) AS count FROM memory_analysis_clusters WHERE run_id = ?", run.id);
    const nonNoise = count(db, "SELECT COUNT(*) AS count FROM memory_analysis_memberships WHERE run_id = ? AND cluster_id <> -1", run.id);
    const noise = count(db, "SELECT COUNT(*) AS count FROM memory_analysis_memberships WHERE run_id = ? AND cluster_id = -1", run.id);
    const unassigned = count(db, `
    SELECT COUNT(*) AS count
    FROM memory_analysis_memberships m
    LEFT JOIN memory_analysis_clusters c
      ON c.run_id = m.run_id AND c.cluster_id = m.cluster_id
    WHERE m.run_id = ? AND m.cluster_id <> -1 AND c.cluster_id IS NULL
  `, run.id);
    if (nonNoise !== expectedNonNoise || members !== nonNoise + noise || unassigned > 0)
        return undefined;
    return {
        status: "ok",
        runId: run.id,
        createdAt: run.created_at,
        completedAt: run.completed_at,
        inputDigest: run.input_digest,
        model: run.model,
        embeddingFingerprint: run.embedding_fingerprint,
        dimensions: run.dimensions,
        clusters,
        members,
        noise,
        stale: run.stale_at !== null,
        staleSince: run.stale_at,
    };
}
export function readAnalysisSummary(db) {
    const run = latestRun(db);
    return run ? analysisSummary(db, run) : undefined;
}
function latestValidRun(db) {
    const run = latestRun(db);
    return run && analysisSummary(db, run) ? run : undefined;
}
function sourcePaths(db, hash, limit) {
    if (limit <= 0)
        return [];
    return db.prepare(`
    SELECT collection, path
    FROM documents
    WHERE hash = ? AND active = 1
    ORDER BY collection, path
    LIMIT ?
  `).all(hash, limit).map((row) => `qmd://${row.collection}/${row.path}`);
}
function byteSlice(text, maxBytes) {
    const bytes = Buffer.from(text);
    if (bytes.length <= maxBytes)
        return text;
    if (maxBytes <= 3)
        return "";
    return bytes.subarray(0, maxBytes - 3).toString("utf8").replace(/\uFFFD$/u, "") + "…";
}
function members(db, runId, clusterId, limit, offset = 0, sort = "representative", maxExcerptBytes = MAX_EXCERPT_BYTES, maxTotalBytes = MAX_TOTAL_EXCERPT_BYTES, maxTotalAliases = MAX_TOTAL_ALIASES, temporal = {}) {
    const representativeOrder = clusterId === -1
        ? "m.outlier_score DESC, m.hash, m.seq"
        : `CASE WHEN m.representative_rank IS NULL THEN 1 ELSE 0 END,
       m.representative_rank,
       m.probability DESC,
       m.outlier_score,
       m.hash,
       m.seq`;
    const score = clusterId === -1 ? "m.outlier_score" : "m.probability";
    const order = {
        representative: representativeOrder,
        score_desc: `${score} DESC, m.hash, m.seq`,
        score_asc: `${score} ASC, m.hash, m.seq`,
        date_desc: "julianday(COALESCE(m.event_time, m.source_modified_at)) DESC, m.hash, m.seq",
        date_asc: "julianday(COALESCE(m.event_time, m.source_modified_at)) ASC, m.hash, m.seq",
    }[sort];
    const rows = db.prepare(`
    WITH candidate_times AS (
      SELECT
        m.hash,
        m.seq,
        d.collection,
        d.path,
        d.modified_at AS source_modified_at,
        CASE
          WHEN d.collection = ? THEN d.modified_at
          WHEN d.path GLOB '*[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9].md'
            THEN substr(d.path, length(d.path) - 12, 10) || 'T00:00:00.000Z'
          ELSE annotation.event_time
        END AS event_time,
        CASE
          WHEN d.collection = ? THEN 'session'
          WHEN d.path GLOB '*[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9].md' THEN 'path'
          ELSE annotation.basis
        END AS event_time_basis,
        CASE
          WHEN d.collection = ? THEN 1
          WHEN d.path GLOB '*[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9].md' THEN 2
          WHEN annotation.event_time IS NOT NULL THEN 3
          ELSE 4
        END AS priority
      FROM memory_analysis_available_memberships m
      JOIN documents d ON d.hash = m.hash AND d.active = 1
      LEFT JOIN memory_temporal_annotations annotation
        ON annotation.collection = d.collection
       AND annotation.path = d.path
       AND (annotation.document_wide = 1 OR
            (annotation.qmd_hash = m.hash AND annotation.qmd_seq = m.seq))
      WHERE m.run_id = ? AND m.cluster_id = ?
    ), ranked_times AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY hash, seq
        ORDER BY priority, julianday(COALESCE(event_time, source_modified_at)) DESC, collection, path
      ) AS rank
      FROM candidate_times
    ), member_rows AS (
      SELECT
        m.hash, m.seq, m.probability, m.outlier_score, m.x, m.y,
        m.representative_rank, m.pos, m.chunk_len, m.doc,
        (
          SELECT d.modified_at
          FROM documents d
          WHERE d.hash = m.hash AND d.active = 1
          ORDER BY julianday(d.modified_at) DESC, d.collection, d.path
          LIMIT 1
        ) AS source_modified_at,
        temporal.event_time,
        temporal.event_time_basis,
        temporal.collection AS event_collection,
        temporal.path AS event_path
      FROM memory_analysis_available_memberships m
      JOIN ranked_times temporal
        ON temporal.hash = m.hash AND temporal.seq = m.seq AND temporal.rank = 1
      WHERE m.run_id = ? AND m.cluster_id = ?
    )
    SELECT * FROM member_rows m
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(temporal.sessionCollection ?? "", temporal.sessionCollection ?? "", temporal.sessionCollection ?? "", runId, clusterId, runId, clusterId, limit, offset);
    let remaining = maxTotalBytes;
    let remainingAliases = maxTotalAliases;
    return rows.map((row, index) => {
        const remainingRows = rows.length - index;
        const excerptBudget = Math.min(maxExcerptBytes, Math.floor(remaining / remainingRows));
        const fullText = row.doc.slice(row.pos, row.pos + row.chunk_len);
        const text = byteSlice(fullText, excerptBudget);
        remaining -= Buffer.byteLength(text);
        const aliasBudget = Math.min(MAX_ALIASES_PER_MEMBER, Math.floor(remainingAliases / remainingRows));
        const aliases = sourcePaths(db, row.hash, aliasBudget);
        remainingAliases -= aliases.length;
        return {
            hash: row.hash,
            seq: row.seq,
            probability: row.probability,
            outlierScore: row.outlier_score,
            x: row.x,
            y: row.y,
            representativeRank: row.representative_rank,
            sourceModifiedAt: row.source_modified_at,
            eventTime: row.event_time,
            eventTimeBasis: row.event_time_basis,
            eventTimeSource: `qmd://${row.event_collection}/${row.event_path}`,
            contentFingerprint: createHash("sha256").update(fullText).digest("hex"),
            text,
            sourcePaths: aliases,
        };
    });
}
function availableSize(db, runId, clusterId) {
    return db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_analysis_available_memberships
    WHERE run_id = ? AND cluster_id = ?
  `).get(runId, clusterId)?.count ?? 0;
}
function readMetadata(run) {
    if (!run) {
        return {
            stale: true,
            staleSince: null,
            analyzedAt: null,
            hint: "No memory analysis exists. Call memory_recluster, then memory_list_clusters.",
        };
    }
    if (run.stale_at) {
        return {
            stale: true,
            staleSince: run.stale_at,
            analyzedAt: run.completed_at,
            hint: "Memory changed after this analysis. Call memory_recluster to refresh it.",
        };
    }
    return { stale: false, staleSince: null, analyzedAt: run.completed_at };
}
function toSummary(db, run, row, includePreview, previewBytes = 600, aliasLimit = MAX_TOTAL_ALIASES) {
    const preview = includePreview
        ? members(db, run.id, row.cluster_id, 1, 0, "representative", previewBytes, previewBytes, aliasLimit)[0]
        : undefined;
    return {
        clusterId: clusterReference(run.id, row.cluster_id),
        size: row.size,
        availableSize: row.available_size,
        meanProbability: row.mean_probability,
        ...(preview ? {
            preview: {
                hash: preview.hash,
                seq: preview.seq,
                probability: preview.probability,
                text: preview.text,
                sourcePaths: preview.sourcePaths,
            },
        } : {}),
    };
}
function noiseRow(db, runId) {
    return db.prepare(`
    SELECT
      -1 AS cluster_id,
      COUNT(*) AS size,
      (
        SELECT COUNT(*)
        FROM memory_analysis_available_memberships available
        WHERE available.run_id = ? AND available.cluster_id = -1
      ) AS available_size,
      COALESCE(AVG(m.probability), 0) AS mean_probability
    FROM memory_analysis_memberships m
    WHERE m.run_id = ? AND m.cluster_id = -1
    HAVING COUNT(*) > 0
  `).get(runId, runId);
}
export function readClusters(db, requestedLimit = DEFAULT_CLUSTER_LIMIT) {
    const run = latestValidRun(db);
    if (!run) {
        return { status: "not_analyzed", ...readMetadata(), clusters: [], noise: null };
    }
    const limit = Math.max(1, Math.min(MAX_CLUSTER_LIMIT, Math.floor(requestedLimit)));
    const rows = db.prepare(`
    SELECT
      c.cluster_id,
      c.size,
      (
        SELECT COUNT(*)
        FROM memory_analysis_available_memberships available
        WHERE available.run_id = c.run_id AND available.cluster_id = c.cluster_id
      ) AS available_size,
      c.mean_probability
    FROM memory_analysis_clusters c
    WHERE c.run_id = ?
    ORDER BY c.size DESC, c.cluster_id
    LIMIT ?
  `).all(run.id, limit);
    let remainingBytes = MAX_TOTAL_EXCERPT_BYTES;
    let remainingAliases = MAX_TOTAL_ALIASES;
    const clusters = rows.map((row) => {
        const previewBytes = Math.min(600, remainingBytes);
        const summary = toSummary(db, run, row, previewBytes > 0, previewBytes, remainingAliases);
        remainingBytes -= Buffer.byteLength(summary.preview?.text ?? "");
        remainingAliases -= summary.preview?.sourcePaths.length ?? 0;
        return summary;
    });
    const noise = noiseRow(db, run.id);
    return {
        status: "ok",
        runId: run.id,
        ...readMetadata(run),
        clusters,
        noise: noise ? toSummary(db, run, noise, false) : null,
    };
}
function resolveClusterId(db, runId, reference) {
    const clusterIds = db.prepare(`
    SELECT cluster_id
    FROM memory_analysis_clusters
    WHERE run_id = ?
    UNION ALL
    SELECT -1
    WHERE EXISTS (
      SELECT 1 FROM memory_analysis_memberships WHERE run_id = ? AND cluster_id = -1
    )
  `).all(runId, runId);
    return clusterIds.find((row) => clusterReference(runId, row.cluster_id) === reference)?.cluster_id;
}
export function readCluster(db, clusterReferenceId, requestedLimit = DEFAULT_MEMBER_LIMIT, requestedOffset = 0, sort = "representative", temporal = {}) {
    const run = latestValidRun(db);
    if (!run) {
        return { status: "not_analyzed", ...readMetadata() };
    }
    const metadata = readMetadata(run);
    const clusterId = resolveClusterId(db, run.id, clusterReferenceId);
    if (clusterId === undefined) {
        return {
            status: "not_found",
            runId: run.id,
            ...metadata,
            hint: "Cluster IDs change after reclustering. Call memory_list_clusters and use a current clusterId.",
        };
    }
    const row = clusterId === -1
        ? noiseRow(db, run.id)
        : db.prepare(`
        SELECT cluster_id, size, mean_probability, 0 AS available_size
        FROM memory_analysis_clusters
        WHERE run_id = ? AND cluster_id = ?
      `).get(run.id, clusterId);
    if (!row) {
        return { status: "not_found", runId: run.id, ...metadata };
    }
    const limit = Math.max(1, Math.min(MAX_MEMBER_LIMIT, Math.floor(requestedLimit)));
    const offset = Math.max(0, Math.floor(requestedOffset));
    const total = availableSize(db, run.id, clusterId);
    const pageMembers = members(db, run.id, clusterId, limit, offset, sort, MAX_EXCERPT_BYTES, MAX_TOTAL_EXCERPT_BYTES, MAX_TOTAL_ALIASES, temporal);
    const nextOffset = offset + pageMembers.length;
    const hasMore = nextOffset < total;
    return {
        status: "ok",
        runId: run.id,
        ...metadata,
        cluster: {
            clusterId: clusterReferenceId,
            size: row.size,
            availableSize: total,
            meanProbability: row.mean_probability,
        },
        members: pageMembers,
        page: {
            offset,
            returned: pageMembers.length,
            total,
            hasMore,
            ...(hasMore ? { nextOffset } : {}),
        },
    };
}
