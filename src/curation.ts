import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDatabase } from "./memory-database.js";
import type { QualityJudgment } from "./typesafe.js";

const TEMPORAL_BASES = ["path", "frontmatter", "session", "agent_verified"] as const;
export type TemporalBasis = typeof TEMPORAL_BASES[number];

const MAINTENANCE_TASK_TYPES = ["ambiguous_event_time", "exact_duplicate", "quality_review"] as const;
export type MaintenanceTaskType = typeof MAINTENANCE_TASK_TYPES[number];

const MAINTENANCE_STATUSES = ["pending", "resolved", "deferred", "irrelevant"] as const;
export type MaintenanceStatus = typeof MAINTENANCE_STATUSES[number];

export type TemporalAnnotation = {
  corpus: string;
  collection: string;
  path: string;
  contentFingerprint: string;
  eventTime: string;
  basis: TemporalBasis;
  evidence: string;
  qmdHash: string | null;
  qmdSeq: number | null;
  createdAt: string;
  updatedAt: string;
};

export type MaintenanceTask = {
  id: string;
  type: MaintenanceTaskType;
  corpus: string;
  collection: string;
  path: string;
  reason: string;
  contentFingerprint: string;
  detail: string | null;
  resolutionNote: string | null;
  status: MaintenanceStatus;
  createdAt: string;
  updatedAt: string;
};

type AnnotationRow = {
  corpus: string;
  collection: string;
  path: string;
  content_fingerprint: string;
  event_time: string;
  basis: TemporalBasis;
  evidence: string;
  qmd_hash: string | null;
  qmd_seq: number | null;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  type: MaintenanceTaskType;
  corpus: string;
  collection: string;
  path: string;
  reason: string;
  content_fingerprint: string;
  detail: string | null;
  resolution_note: string | null;
  status: MaintenanceStatus;
  created_at: string;
  updated_at: string;
};

function annotation(row: AnnotationRow): TemporalAnnotation {
  return {
    corpus: row.corpus,
    collection: row.collection,
    path: row.path,
    contentFingerprint: row.content_fingerprint,
    eventTime: row.event_time,
    basis: row.basis,
    evidence: row.evidence,
    qmdHash: row.qmd_hash,
    qmdSeq: row.qmd_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function task(row: TaskRow): MaintenanceTask {
  return {
    id: row.id,
    type: row.type,
    corpus: row.corpus,
    collection: row.collection,
    path: row.path,
    reason: row.reason,
    contentFingerprint: row.content_fingerprint,
    detail: row.detail,
    resolutionNote: row.resolution_note,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function chunkFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class CurationStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = openMemoryDatabase(path);
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      const version = this.#db.prepare("SELECT version FROM memory_schema WHERE component='curation'").get()?.version;
      if (version !== undefined && version !== 1) throw new Error("Unsupported curation schema version");
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS temporal_annotations (
          corpus TEXT NOT NULL,
          collection TEXT NOT NULL,
          path TEXT NOT NULL,
          content_fingerprint TEXT NOT NULL DEFAULT '',
          event_time TEXT NOT NULL,
          basis TEXT NOT NULL CHECK (basis IN ('path', 'frontmatter', 'session', 'agent_verified')),
          evidence TEXT NOT NULL,
          qmd_hash TEXT,
          qmd_seq INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (corpus, collection, path, content_fingerprint)
        );

      `);
      this.#ensureMaintenanceSchema();
      this.#db.exec(`CREATE TABLE IF NOT EXISTS quality_judgments (
        cache_key TEXT PRIMARY KEY,
        noise REAL NOT NULL CHECK (noise BETWEEN 0 AND 1),
        evidence REAL NOT NULL CHECK (evidence BETWEEN 0 AND 1)
      )`);
      this.#db.exec("INSERT OR IGNORE INTO memory_schema VALUES ('curation',1); COMMIT");
    } catch (error) { this.#db.close(); throw error; }
  }

  #ensureMaintenanceSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('ambiguous_event_time', 'exact_duplicate', 'quality_review')),
        corpus TEXT NOT NULL,
        collection TEXT NOT NULL,
        path TEXT NOT NULL,
        reason TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        detail TEXT,
        resolution_note TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'deferred', 'irrelevant')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (type, corpus, collection, path, reason, content_fingerprint)
      );
    `);
    const schema = this.#db.prepare("SELECT sql FROM sqlite_master WHERE name = 'maintenance_tasks'")
      .get() as { sql: string };
    if (!schema.sql.includes("'quality_review'")) {
      this.#db.exec(schema.sql.replace("maintenance_tasks", "maintenance_tasks_quality")
        .replace("'exact_duplicate'", "'exact_duplicate', 'quality_review'"));
      this.#db.exec(`INSERT INTO maintenance_tasks_quality SELECT * FROM maintenance_tasks;
        DROP TABLE maintenance_tasks;
        ALTER TABLE maintenance_tasks_quality RENAME TO maintenance_tasks;`);
    }
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS maintenance_tasks_status_created
        ON maintenance_tasks(status, created_at);
    `);
  }

  close(): void {
    this.#db.close();
  }

  qualityJudgment(key: string): QualityJudgment | undefined {
    return this.#db.prepare("SELECT noise, evidence FROM quality_judgments WHERE cache_key = ?")
      .get(key) as QualityJudgment | undefined;
  }

  cacheQualityJudgment(key: string, judgment: QualityJudgment): void {
    this.#db.prepare("INSERT OR REPLACE INTO quality_judgments(cache_key, noise, evidence) VALUES (?, ?, ?)")
      .run(key, judgment.noise, judgment.evidence);
  }

  annotations(): TemporalAnnotation[] {
    return this.#db.prepare(`
      SELECT * FROM temporal_annotations
      ORDER BY collection, path, content_fingerprint
    `).all().map((row) => annotation(row as AnnotationRow));
  }

  addTask(candidate: {
    type: MaintenanceTaskType;
    corpus: string;
    collection: string;
    path: string;
    reason: string;
    contentFingerprint?: string;
    detail?: string;
  }): MaintenanceTask {
    const now = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO maintenance_tasks
        (id, type, corpus, collection, path, reason, content_fingerprint, detail, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(type, corpus, collection, path, reason, content_fingerprint) DO UPDATE SET
        detail = CASE
          WHEN maintenance_tasks.status = 'pending' THEN excluded.detail
          ELSE maintenance_tasks.detail
        END,
        updated_at = CASE
          WHEN maintenance_tasks.status = 'pending' THEN excluded.updated_at
          ELSE maintenance_tasks.updated_at
        END
    `).run(
      randomUUID(),
      candidate.type,
      candidate.corpus,
      candidate.collection,
      candidate.path,
      candidate.reason,
      candidate.contentFingerprint ?? "",
      candidate.detail ?? null,
      now,
      now,
    );
    return task(this.#db.prepare(`SELECT * FROM maintenance_tasks
      WHERE type = ? AND corpus = ? AND collection = ? AND path = ? AND reason = ? AND content_fingerprint = ?`)
      .get(candidate.type, candidate.corpus, candidate.collection, candidate.path,
        candidate.reason, candidate.contentFingerprint ?? "") as TaskRow);
  }

  listTasks(params: { status?: MaintenanceStatus; limit?: number } = {}): MaintenanceTask[] {
    const status = params.status ?? "pending";
    const limit = Math.max(1, Math.min(10, Math.floor(params.limit ?? 5)));
    return this.#db.prepare(`
      SELECT * FROM maintenance_tasks
      WHERE status = ?
      ORDER BY CASE WHEN type = 'quality_review' AND json_valid(detail) THEN
        CASE WHEN json_extract(detail, '$.evidence') >= 0.8 AND
          (json_extract(detail, '$.noise') >= 0.8 OR reason = 'possible_double_encoded_message') THEN 0 ELSE 1 END
        ELSE 1 END, created_at, id
      LIMIT ?
    `).all(status, limit).map((row) => task(row as TaskRow));
  }

  updateTask(params: {
    id: string;
    status: Exclude<MaintenanceStatus, "pending">;
    note?: string;
    annotation?: {
      scope: "chunk" | "document";
      eventTime: string;
      basis: TemporalBasis;
      evidence: string;
    };
  }): MaintenanceTask | undefined {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT * FROM maintenance_tasks WHERE id = ?")
        .get(params.id) as TaskRow | undefined;
      if (!row) {
        this.#db.exec("COMMIT");
        return undefined;
      }
      const now = new Date().toISOString();
      if (row.type === "quality_review" && params.status === "resolved" && !params.note?.trim()) {
        throw new Error("resolving a quality review requires a note describing source/index verification");
      }
      if (row.type === "ambiguous_event_time" && params.status === "resolved" && !params.annotation) {
        throw new Error("resolving an ambiguous event-time task requires a date annotation");
      }
      if (params.annotation) {
        if (row.type !== "ambiguous_event_time") {
          throw new Error("date annotations can only resolve ambiguous event-time tasks");
        }
        if (params.status !== "resolved") {
          throw new Error("date annotations require resolved status");
        }
        if (!Number.isFinite(Date.parse(params.annotation.eventTime))) {
          throw new Error("date annotation eventTime must be an ISO 8601 timestamp");
        }
        const fingerprint = params.annotation.scope === "document" ? "" : row.content_fingerprint;
        if (params.annotation.scope === "chunk" && !fingerprint) {
          throw new Error("chunk annotation requires a content fingerprint");
        }
        this.#db.prepare(`
          INSERT INTO temporal_annotations
            (corpus, collection, path, content_fingerprint, event_time, basis, evidence,
             qmd_hash, qmd_seq, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
          ON CONFLICT(corpus, collection, path, content_fingerprint) DO UPDATE SET
            event_time = excluded.event_time,
            basis = excluded.basis,
            evidence = excluded.evidence,
            qmd_hash = NULL,
            qmd_seq = NULL,
            updated_at = excluded.updated_at
        `).run(
          row.corpus,
          row.collection,
          row.path,
          fingerprint,
          params.annotation.eventTime,
          params.annotation.basis,
          params.annotation.evidence,
          now,
          now,
        );
      }
      this.#db.prepare(`
        UPDATE maintenance_tasks
        SET status = ?, resolution_note = ?, updated_at = ?
        WHERE id = ?
      `).run(params.status, params.note ?? null, now, params.id);
      const updated = task(
        this.#db.prepare("SELECT * FROM maintenance_tasks WHERE id = ?").get(params.id) as TaskRow,
      );
      this.#db.exec("COMMIT");
      return updated;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  updateAnnotationLocation(params: {
    annotation: TemporalAnnotation;
    qmdHash: string | null;
    qmdSeq: number | null;
  }): void {
    this.#db.prepare(`
      UPDATE temporal_annotations
      SET qmd_hash = ?, qmd_seq = ?
      WHERE corpus = ? AND collection = ? AND path = ? AND content_fingerprint = ?
    `).run(
      params.qmdHash,
      params.qmdSeq,
      params.annotation.corpus,
      params.annotation.collection,
      params.annotation.path,
      params.annotation.contentFingerprint,
    );
  }
}
