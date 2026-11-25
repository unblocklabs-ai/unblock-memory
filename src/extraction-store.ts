import { createHash, randomUUID } from "node:crypto";
import { immediateTransaction, openMemoryDatabase } from "./memory-database.js";
import type { ExtractionMessage, MemoryProposal } from "./extraction-model.js";
import type { SessionMetadata } from "./session-projector.js";
import { jsonHash } from "./json-hash.js";

export type ExtractionSession = SessionMetadata & { sessionKey: string; changedAt?: number; sourceRevision?: string };
type Checkpoint = { cursor: string | null; context: ExtractionMessage[]; since: number; completeRevision: string | null; policyFingerprint: string | null };
export type ExtractedRecord = { id: string; revision: number; text: string; sessionId: string;
  observedAt: number; evidence: MemoryProposal["evidence"]; metadata: ExtractionSession; judgment: unknown };

export class ExtractionLeaseLostError extends Error {
  constructor() {
    super("Extraction lease lost");
    this.name = "ExtractionLeaseLostError";
  }
}

export function extractionPolicyFingerprint(params: {
  version: string;
  historyMessages: number;
  minSupport: number;
  minRetention: number;
  minReplacement: number;
  validatorModel?: string;
}): string {
  return jsonHash({
    version: params.version,
    historyMessages: params.historyMessages,
    minSupport: params.minSupport,
    minRetention: params.minRetention,
    minReplacement: params.minReplacement,
    validatorModel: params.validatorModel ?? null,
  });
}

export function buildCompleteRevision(sourceRevision: string, policyFingerprint: string): string {
  return JSON.stringify({ sourceRevision, policy: policyFingerprint });
}

function parseCompleteRevision(value: string | null): { sourceRevision: string; policy: string | null } | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).sourceRevision === "string" &&
      typeof (parsed as Record<string, unknown>).policy === "string"
    ) {
      return {
        sourceRevision: (parsed as Record<string, string>).sourceRevision!,
        policy: (parsed as Record<string, string>).policy!,
      };
    }
  } catch { /* Legacy plain-string complete_revision without policy binding. */ }
  return { sourceRevision: value, policy: null };
}

function memoryDigest(text: string): string {
  return createHash("sha256").update(text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "")).digest("hex");
}

export class ExtractionStore {
  readonly db;
  constructor(path: string) {
    this.db = openMemoryDatabase(path);
    try {
      const version = this.db.prepare("SELECT version FROM memory_schema WHERE component='extraction'").get()?.version;
      if (version !== undefined && version !== 1) throw new Error("Unsupported extraction schema");
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS extraction_worker (
        id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        next_run INTEGER NOT NULL DEFAULT 0, live_since INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS extraction_sessions (
        session_id TEXT PRIMARY KEY, metadata TEXT NOT NULL CHECK(json_valid(metadata)), cursor TEXT,
        extract_since INTEGER NOT NULL,
        context TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(context)), updated_at INTEGER NOT NULL,
        error TEXT, complete_revision TEXT, policy_fingerprint TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS extracted_memories (
        id TEXT NOT NULL, revision INTEGER NOT NULL, session_id TEXT NOT NULL REFERENCES extraction_sessions(session_id),
        text TEXT NOT NULL, digest TEXT NOT NULL, evidence TEXT NOT NULL CHECK(json_valid(evidence)),
        observed_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','superseded','withdrawn')),
        judgment TEXT NOT NULL CHECK(json_valid(judgment)), prompt_version TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(id,revision)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS extracted_current ON extracted_memories(id) WHERE status='active';
      CREATE UNIQUE INDEX IF NOT EXISTS extracted_duplicate ON extracted_memories(session_id,digest) WHERE status='active';
      INSERT OR IGNORE INTO memory_schema VALUES('extraction',1);
    `);
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('extraction_sessions') WHERE name='complete_revision'").get()) {
        this.db.exec("ALTER TABLE extraction_sessions ADD COLUMN complete_revision TEXT");
      }
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('extraction_sessions') WHERE name='policy_fingerprint'").get()) {
        this.db.exec("ALTER TABLE extraction_sessions ADD COLUMN policy_fingerprint TEXT");
      }
      this.db.prepare("INSERT OR IGNORE INTO extraction_worker(id,live_since) VALUES(1,?)").run(Date.now());
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  liveSince(): number { return Number(this.db.prepare("SELECT live_since FROM extraction_worker WHERE id=1").get()!.live_since); }
  claim(scheduled: boolean, intervalMs: number): string | undefined {
    const owner = randomUUID(), now = Date.now();
    const result = this.db.prepare(`UPDATE extraction_worker SET owner=?,lease_until=?,next_run=?
      WHERE id=1 AND lease_until<? AND (?=0 OR next_run<=?)`).run(owner, now + 180_000, now + intervalMs, now, Number(scheduled), now);
    return result.changes ? owner : undefined;
  }
  renew(owner: string) {
    const now = Date.now();
    if (!this.db.prepare("UPDATE extraction_worker SET lease_until=? WHERE id=1 AND owner=? AND lease_until>=?")
      .run(now + 180_000, owner, now).changes) throw new ExtractionLeaseLostError();
  }
  release(owner: string) { this.db.prepare("UPDATE extraction_worker SET owner=NULL,lease_until=0 WHERE id=1 AND owner=?").run(owner); }
  readCheckpoint(sessionId: string): (Checkpoint & { error: string | null }) | undefined {
    const row = this.db.prepare("SELECT cursor,context,extract_since,complete_revision,policy_fingerprint,error FROM extraction_sessions WHERE session_id=?").get(sessionId);
    if (!row) return undefined;
    return {
      cursor: row.cursor as string | null,
      context: JSON.parse(String(row.context)) as ExtractionMessage[],
      since: Number(row.extract_since),
      completeRevision: row.complete_revision as string | null,
      policyFingerprint: row.policy_fingerprint as string | null,
      error: row.error as string | null,
    };
  }
  checkpoint(session: ExtractionSession, owner: string, since?: number, policyFingerprint?: string): Checkpoint {
    return immediateTransaction(this.db, () => {
      this.renew(owner);
      this.db.prepare(`INSERT INTO extraction_sessions(session_id,metadata,updated_at,extract_since,policy_fingerprint) VALUES(?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET metadata=excluded.metadata WHERE metadata IS NOT excluded.metadata`)
        .run(session.sessionId, JSON.stringify(session), Date.now(), since ?? this.liveSince(), policyFingerprint ?? null);
      const row = this.db.prepare("SELECT cursor,context,extract_since,complete_revision,policy_fingerprint FROM extraction_sessions WHERE session_id=?").get(session.sessionId)!;
      const storedCursor = row.cursor as string | null;
      const storedCompleteRevision = row.complete_revision as string | null;
      const storedPolicy = row.policy_fingerprint as string | null;
      if (since !== undefined && since < Number(row.extract_since)) {
        // A broader explicitly approved backfill replays this session. Existing facts are
        // supplied to Luna and exact duplicates are ignored; history is never deleted.
        const nextPolicy = policyFingerprint ?? storedPolicy;
        this.db.prepare("UPDATE extraction_sessions SET cursor=NULL,context='[]',complete_revision=NULL,extract_since=?,policy_fingerprint=? WHERE session_id=?")
          .run(since, nextPolicy, session.sessionId);
        return { cursor: null, context: [], since, completeRevision: null, policyFingerprint: nextPolicy };
      }
      if (policyFingerprint !== undefined) {
        const completeRevisionPolicyMismatch =
          storedCompleteRevision !== null && parseCompleteRevision(storedCompleteRevision)?.policy !== policyFingerprint;
        if ((storedCursor !== null || storedCompleteRevision !== null) && (storedPolicy !== policyFingerprint || completeRevisionPolicyMismatch)) {
          // A prompt or retention-policy change (or unversioned legacy cursor) replays the
          // session from the start with existing facts retained so completion covers the full scan.
          this.db.prepare("UPDATE extraction_sessions SET cursor=NULL,context='[]',complete_revision=NULL,policy_fingerprint=? WHERE session_id=?")
            .run(policyFingerprint, session.sessionId);
          return { cursor: null, context: [], since: Number(row.extract_since), completeRevision: null, policyFingerprint };
        }
        if (storedPolicy !== policyFingerprint) {
          this.db.prepare("UPDATE extraction_sessions SET policy_fingerprint=? WHERE session_id=?")
            .run(policyFingerprint, session.sessionId);
          return {
            cursor: storedCursor,
            context: JSON.parse(String(row.context)) as ExtractionMessage[],
            since: Number(row.extract_since),
            completeRevision: storedCompleteRevision,
            policyFingerprint,
          };
        }
      }
      return {
        cursor: storedCursor,
        context: JSON.parse(String(row.context)) as ExtractionMessage[],
        since: Number(row.extract_since),
        completeRevision: storedCompleteRevision,
        policyFingerprint: storedPolicy,
      };
    });
  }
  records(sessionId?: string, paths?: readonly string[]): ExtractedRecord[] {
    const keys = paths?.filter(path => /^[a-f0-9-]+\/[1-9]\d*$/.test(path)).map(path => path.split("/"));
    if (keys && !keys.length) return [];
    return this.db.prepare(`SELECT m.*,s.metadata FROM extracted_memories m JOIN extraction_sessions s USING(session_id)
      WHERE status='active' ${sessionId === undefined ? "" : "AND session_id=?"}
      ${keys ? `AND (m.id,m.revision) IN (VALUES ${keys.map(() => "(?,?)").join(",")})` : ""}
      ORDER BY observed_at,id`).all(...(sessionId === undefined ? [] : [sessionId]), ...(keys?.flat() ?? []))
      .map(r => ({ id: String(r.id), revision: Number(r.revision), text: String(r.text), sessionId: String(r.session_id),
        observedAt: Number(r.observed_at), evidence: JSON.parse(String(r.evidence)), metadata: JSON.parse(String(r.metadata)), judgment: JSON.parse(String(r.judgment)) }));
  }
  reset(sessionId: string, cursor: string | null, owner: string, policyFingerprint?: string) {
    immediateTransaction(this.db, () => {
      this.renew(owner);
      this.db.prepare("UPDATE extracted_memories SET status='withdrawn' WHERE session_id=? AND status='active'").run(sessionId);
      this.db.prepare("UPDATE extraction_sessions SET cursor=?,context='[]',complete_revision=NULL,policy_fingerprint=?,error=NULL,updated_at=? WHERE session_id=?")
        .run(cursor, policyFingerprint ?? null, Date.now(), sessionId);
    });
  }
  private assertCheckpointFenced(
    current: { cursor: unknown; policy_fingerprint: unknown } | undefined,
    expected: string | null,
    policyFingerprint?: string,
    completeRevision?: string,
  ): string | null {
    if (!current || current.cursor !== expected) throw new Error("Extraction checkpoint changed");
    const storedPolicy = current.policy_fingerprint as string | null;
    if (policyFingerprint !== undefined) {
      if (expected !== null ? storedPolicy !== policyFingerprint : storedPolicy !== null && storedPolicy !== policyFingerprint) {
        throw new Error("Extraction checkpoint changed");
      }
    }
    const nextPolicy = policyFingerprint ?? storedPolicy;
    if (completeRevision !== undefined) {
      const parsed = parseCompleteRevision(completeRevision);
      if (parsed && parsed.policy !== null && nextPolicy !== parsed.policy) {
        throw new Error("Extraction checkpoint changed");
      }
    }
    return nextPolicy;
  }
  completeEmpty(params: { sessionId: string; expected: string | null; owner: string; completeRevision?: string; policyFingerprint?: string }) {
    immediateTransaction(this.db, () => {
      this.renew(params.owner);
      const current = this.db.prepare("SELECT cursor,policy_fingerprint FROM extraction_sessions WHERE session_id=?").get(params.sessionId) as
        { cursor: unknown; policy_fingerprint: unknown } | undefined;
      const nextPolicy = this.assertCheckpointFenced(current, params.expected, params.policyFingerprint, params.completeRevision);
      this.db.prepare("UPDATE extraction_sessions SET updated_at=?,complete_revision=?,policy_fingerprint=?,error=NULL WHERE session_id=?")
        .run(Date.now(), params.completeRevision ?? null, nextPolicy, params.sessionId);
    });
  }
  commit(params: { session: ExtractionSession; expected: string | null; cursor: string; context: ExtractionMessage[];
    accepted: { proposal: MemoryProposal; observedAt: number; judgment: unknown }[]; owner: string; version: string; completeRevision?: string; policyFingerprint?: string }) {
    return immediateTransaction(this.db, () => {
      let written = 0;
      const replaced = new Set<string>();
      this.renew(params.owner);
      const current = this.db.prepare("SELECT cursor,policy_fingerprint FROM extraction_sessions WHERE session_id=?").get(params.session.sessionId) as
        { cursor: unknown; policy_fingerprint: unknown } | undefined;
      const nextPolicy = this.assertCheckpointFenced(current, params.expected, params.policyFingerprint, params.completeRevision);
      for (const { proposal, observedAt, judgment } of params.accepted) {
        const digest = memoryDigest(proposal.text);
        const duplicate = this.db.prepare("SELECT id FROM extracted_memories WHERE session_id=? AND digest=? AND status='active'")
          .get(params.session.sessionId, digest);
        if (duplicate) continue;
        let id: string = randomUUID(), revision = 1;
        if (proposal.replaces) {
          if (replaced.has(proposal.replaces)) throw new Error("Conflicting memory replacement in batch");
          const previous = this.db.prepare("SELECT revision,observed_at FROM extracted_memories WHERE id=? AND session_id=? AND status='active'")
            .get(proposal.replaces, params.session.sessionId);
          if (!previous || Number(previous.observed_at) > observedAt) throw new Error("Invalid or stale memory replacement");
          replaced.add(proposal.replaces);
          id = proposal.replaces; revision = Number(previous.revision) + 1;
          this.db.prepare("UPDATE extracted_memories SET status='superseded' WHERE id=? AND status='active'").run(id);
        }
        this.db.prepare(`INSERT INTO extracted_memories VALUES(?,?,?,?,?,?,?,'active',?,?,?)`)
          .run(id, revision, params.session.sessionId, proposal.text.trim(), digest, JSON.stringify(proposal.evidence), observedAt,
            JSON.stringify(judgment), params.version, Date.now());
        written++;
      }
      this.db.prepare("UPDATE extraction_sessions SET cursor=?,context=?,updated_at=?,complete_revision=?,policy_fingerprint=?,error=NULL WHERE session_id=?")
        .run(params.cursor, JSON.stringify(params.context), Date.now(), params.completeRevision ?? null, nextPolicy, params.session.sessionId);
      return written;
    });
  }
  error(sessionId: string, code: string, owner: string) {
    immediateTransaction(this.db, () => {
      this.renew(owner);
      this.db.prepare("UPDATE extraction_sessions SET error=?,updated_at=? WHERE session_id=?").run(code, Date.now(), sessionId);
    });
  }
  report() {
    return { memories: this.records(), sessions: this.db.prepare("SELECT session_id,updated_at,error,cursor IS NOT NULL AS checkpointed FROM extraction_sessions").all() };
  }
}
