import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { normalizeAgentIdStrict } from "openclaw/plugin-sdk/routing";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const BASELINE_DOSSIER_CATEGORIES = [
  "role",
  "priorities",
  "preferences",
  "successCriteria",
  "workingStyle",
  "relationship",
  "openLoops",
] as const;

const evidenceRefSchema = Type.Object(
  {
    source: Type.Union([
      Type.Literal("session"),
      Type.Literal("memory"),
      Type.Literal("directory"),
      Type.Literal("manual"),
    ]),
    locator: Type.String({ minLength: 1, maxLength: 1000 }),
    observedAt: Type.Optional(
      Type.String({
        pattern:
          "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$",
      }),
    ),
  },
  { additionalProperties: false },
);

const claimSchema = Type.Object(
  {
    statement: Type.String({ minLength: 1, maxLength: 2000 }),
    evidence: Type.Array(evidenceRefSchema, { minItems: 1, maxItems: 50 }),
    epistemicType: Type.Union([
      Type.Literal("observed"),
      Type.Literal("reported"),
      Type.Literal("inferred"),
      Type.Literal("agent_assessment"),
    ]),
    confidence: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    ),
  },
  { additionalProperties: false },
);

export const PERSON_DOSSIER_SCHEMA = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    blurb: Type.String({ minLength: 1, pattern: "\\S" }),
    sections: Type.Array(
      Type.Object(
        {
          category: Type.Union(
            BASELINE_DOSSIER_CATEGORIES.map((category) => Type.Literal(category)),
          ),
          claims: Type.Array(claimSchema, { minItems: 1, maxItems: 100 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: BASELINE_DOSSIER_CATEGORIES.length },
    ),
  },
  { additionalProperties: false },
);

export type PersonDossier = Static<typeof PERSON_DOSSIER_SCHEMA>;

export type PersonDossierChange = {
  id: string;
  personId: string;
  action: "replace" | "delete";
  beforeDossier: PersonDossier | null;
  afterDossier: PersonDossier | null;
  reason: string;
  changedAt: string;
};

export type PersonDossierChangeSummary = Omit<
  PersonDossierChange,
  "beforeDossier" | "afterDossier"
> & {
  beforeDossierBytes: number | null;
  afterDossierBytes: number | null;
};

const MAX_DOSSIER_JSON_BYTES = 64 * 1024;

function serializeDossier(dossier: PersonDossier): string {
  const json = JSON.stringify(dossier);
  if (Buffer.byteLength(json, "utf8") > MAX_DOSSIER_JSON_BYTES) {
    throw new Error(`dossier must serialize to at most ${MAX_DOSSIER_JSON_BYTES} bytes`);
  }
  return json;
}

function parseDossierJson(json: string): PersonDossier {
  return Value.Parse(PERSON_DOSSIER_SCHEMA, JSON.parse(json));
}

export type Person = {
  id: string;
  displayName: string;
  preferredName: string | null;
  status: "active" | "unavailable" | "archived";
  companyId: string | null;
  injectionEnabled: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PersonIdentity = {
  personId: string;
  provider: string;
  accountScope: string;
  externalId: string;
  displayName: string | null;
  realName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  title: string | null;
  isBot: boolean | null;
  isDeactivated: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSyncedAt: string | null;
};

export type PeopleTodo = {
  id: string;
  deduplicationKey: string;
  kind: string;
  context: unknown;
  status: "open" | "resolved" | "overflow";
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
};

export type Company = {
  id: string;
  name: string;
  primaryDomain: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

type PersonRow = {
  id: string;
  display_name: string;
  preferred_name: string | null;
  status: Person["status"];
  company_id: string | null;
  injection_enabled: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

type IdentityRow = {
  person_id: string;
  provider: string;
  account_scope: string;
  external_id: string;
  display_name: string | null;
  real_name: string | null;
  handle: string | null;
  avatar_url: string | null;
  title: string | null;
  is_bot: number | null;
  is_deactivated: number;
  first_seen_at: string;
  last_seen_at: string;
  last_synced_at: string | null;
};

type TodoRow = {
  id: string;
  deduplication_key: string;
  kind: string;
  context_json: string;
  status: PeopleTodo["status"];
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
};

type CompanyRow = {
  id: string;
  name: string;
  primary_domain: string | null;
  status: Company["status"];
  created_at: string;
  updated_at: string;
};

type DossierChangeRow = {
  id: string;
  person_id: string;
  action: PersonDossierChange["action"];
  before_dossier_json: string | null;
  after_dossier_json: string | null;
  reason: string;
  changed_at: string;
};

type DossierChangeSummaryRow = Omit<
  DossierChangeRow,
  "before_dossier_json" | "after_dossier_json"
> & {
  before_dossier_bytes: number | null;
  after_dossier_bytes: number | null;
};

const OVERFLOW_KEY = "__people_todo_overflow__";

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function optional(value: string | undefined): string | null {
  return value?.trim() || null;
}

function dossierReason(value: string): string {
  const reason = required(value, "reason");
  if (reason.length > 1000) throw new Error("reason must not exceed 1000 characters");
  return reason;
}

function person(row: PersonRow): Person {
  return {
    id: row.id,
    displayName: row.display_name,
    preferredName: row.preferred_name,
    status: row.status,
    companyId: row.company_id,
    injectionEnabled: row.injection_enabled === 1,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function identity(row: IdentityRow): PersonIdentity {
  return {
    personId: row.person_id,
    provider: row.provider,
    accountScope: row.account_scope,
    externalId: row.external_id,
    displayName: row.display_name,
    realName: row.real_name,
    handle: row.handle,
    avatarUrl: row.avatar_url,
    title: row.title,
    isBot: row.is_bot === null ? null : row.is_bot === 1,
    isDeactivated: row.is_deactivated === 1,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastSyncedAt: row.last_synced_at,
  };
}

function todo(row: TodoRow): PeopleTodo {
  return {
    id: row.id,
    deduplicationKey: row.deduplication_key,
    kind: row.kind,
    context: JSON.parse(row.context_json) as unknown,
    status: row.status,
    occurrenceCount: row.occurrence_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
  };
}

function company(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    primaryDomain: row.primary_domain,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PeopleStore {
  readonly #db: DatabaseSync;
  readonly #maxOpenTodos: number;
  readonly #maxBlurbChars: number;

  constructor(path: string, options: { maxOpenTodos: number; maxBlurbChars: number }) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    this.#maxOpenTodos = options.maxOpenTodos;
    this.#maxBlurbChars = options.maxBlurbChars;
    try {
      chmodSync(path, 0o600);
      this.#db.exec(
        "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON",
      );
      this.#migrate();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  upsertIdentity(input: {
    provider: string;
    accountScope: string;
    externalId: string;
    displayName?: string;
    realName?: string;
    handle?: string;
    avatarUrl?: string;
    title?: string;
    isBot?: boolean;
    isDeactivated?: boolean;
    seenAt?: string;
    syncedAt?: string;
  }): { person: Person; identity: PersonIdentity; created: boolean } {
    const provider = required(input.provider, "provider");
    const accountScope = required(input.accountScope, "accountScope");
    const externalId = required(input.externalId, "externalId");
    const directorySync = input.syncedAt !== undefined;
    const now = input.seenAt ?? input.syncedAt ?? new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#identityRow(provider, accountScope, externalId);
      const personId = existing?.person_id ?? randomUUID();
      if (existing) {
        const existingPerson = this.#db
          .prepare("SELECT * FROM people WHERE id = ?")
          .get(personId) as PersonRow;
        if (existingPerson.status !== "active") {
          this.#db.exec("COMMIT");
          return { person: person(existingPerson), identity: identity(existing), created: false };
        }
      }
      if (!existing) {
        const displayName = optional(input.displayName) ?? optional(input.realName) ?? externalId;
        this.#db
          .prepare(`
          INSERT INTO people
            (id, display_name, status, injection_enabled, last_seen_at, created_at, updated_at)
          VALUES (?, ?, 'active', 1, ?, ?, ?)
        `)
          .run(personId, displayName, directorySync ? null : now, now, now);
        this.#db
          .prepare(`
          INSERT INTO person_identities
            (person_id, provider, account_scope, external_id, display_name, real_name,
             handle, avatar_url, title, is_bot, is_deactivated, first_seen_at,
             last_seen_at, last_synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
          .run(
            personId,
            provider,
            accountScope,
            externalId,
            optional(input.displayName),
            optional(input.realName),
            optional(input.handle),
            optional(input.avatarUrl),
            optional(input.title),
            input.isBot === undefined ? null : Number(input.isBot),
            Number(input.isDeactivated ?? false),
            now,
            now,
            input.syncedAt ?? null,
          );
        if (provider === "slack" && !directorySync) {
          this.#upsertTodoRow(
            {
              deduplicationKey: `needs-enrichment:slack:${accountScope}:${externalId}`,
              kind: "needs_enrichment",
              context: { personId, provider, accountScope, externalId },
            },
            now,
          );
        }
      } else {
        this.#db
          .prepare(`
          UPDATE person_identities SET
            display_name = COALESCE(?, display_name),
            real_name = COALESCE(?, real_name),
            handle = COALESCE(?, handle),
            avatar_url = COALESCE(?, avatar_url),
            title = COALESCE(?, title),
            is_bot = COALESCE(?, is_bot),
            is_deactivated = COALESCE(?, is_deactivated),
            last_seen_at = ?,
            last_synced_at = COALESCE(?, last_synced_at)
          WHERE provider = ? AND account_scope = ? AND external_id = ?
        `)
          .run(
            optional(input.displayName),
            optional(input.realName),
            optional(input.handle),
            optional(input.avatarUrl),
            optional(input.title),
            input.isBot === undefined ? null : Number(input.isBot),
            input.isDeactivated === undefined ? null : Number(input.isDeactivated),
            now,
            input.syncedAt ?? null,
            provider,
            accountScope,
            externalId,
          );
        if (!directorySync) {
          this.#db
            .prepare("UPDATE people SET last_seen_at = ?, updated_at = ? WHERE id = ?")
            .run(now, now, personId);
        }
      }
      if (input.isDeactivated === true) {
        this.#db
          .prepare(`
          UPDATE people SET status = 'unavailable', injection_enabled = 0,
            updated_at = ? WHERE id = ?
        `)
          .run(now, personId);
      }
      const personRow = this.#db
        .prepare("SELECT * FROM people WHERE id = ?")
        .get(personId) as PersonRow;
      const identityRow = this.#identityRow(provider, accountScope, externalId)!;
      this.#db.exec("COMMIT");
      return { person: person(personRow), identity: identity(identityRow), created: !existing };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  findPersonByIdentity(
    provider: string,
    accountScope: string,
    externalId: string,
  ): Person | undefined {
    const row = this.#db
      .prepare(`
      SELECT people.* FROM people
      JOIN person_identities ON person_identities.person_id = people.id
      WHERE person_identities.provider = ?
        AND person_identities.account_scope = ?
        AND person_identities.external_id = ?
    `)
      .get(provider, accountScope, externalId) as PersonRow | undefined;
    return row ? person(row) : undefined;
  }

  getPerson(personId: string): Person | undefined {
    const row = this.#db.prepare("SELECT * FROM people WHERE id = ?").get(personId) as
      | PersonRow
      | undefined;
    return row ? person(row) : undefined;
  }

  listIdentities(personId: string): PersonIdentity[] {
    return this.#db
      .prepare(`
      SELECT * FROM person_identities WHERE person_id = ?
      ORDER BY provider, account_scope, external_id
    `)
      .all(personId)
      .map((row) => identity(row as IdentityRow));
  }

  getCompany(companyId: string): Company | undefined {
    const row = this.#db.prepare("SELECT * FROM companies WHERE id = ?").get(companyId) as
      | CompanyRow
      | undefined;
    return row ? company(row) : undefined;
  }

  setCompany(
    personId: string,
    input: { name: string; primaryDomain?: string },
  ): Company | undefined {
    const name = required(input.name, "company name");
    const primaryDomain = optional(input.primaryDomain);
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const target = this.#db.prepare("SELECT id FROM people WHERE id = ?").get(personId) as
        | { id: string }
        | undefined;
      if (!target) {
        this.#db.exec("COMMIT");
        return undefined;
      }
      let row = this.#db
        .prepare("SELECT * FROM companies WHERE name = ? COLLATE NOCASE")
        .get(name) as CompanyRow | undefined;
      if (!row) {
        const id = randomUUID();
        this.#db
          .prepare(`
          INSERT INTO companies (id, name, primary_domain, status, created_at, updated_at)
          VALUES (?, ?, ?, 'active', ?, ?)
        `)
          .run(id, name, primaryDomain, now, now);
        row = this.#db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as CompanyRow;
      } else if (primaryDomain && primaryDomain !== row.primary_domain) {
        this.#db
          .prepare("UPDATE companies SET primary_domain = ?, updated_at = ? WHERE id = ?")
          .run(primaryDomain, now, row.id);
        row = this.#db.prepare("SELECT * FROM companies WHERE id = ?").get(row.id) as CompanyRow;
      }
      this.#db
        .prepare("UPDATE people SET company_id = ?, updated_at = ? WHERE id = ?")
        .run(row.id, now, personId);
      this.#db.exec("COMMIT");
      return company(row);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listActivePeople(limit = 50, offset = 0): Person[] {
    return this.#db
      .prepare(`
      SELECT * FROM people
      WHERE status = 'active'
      ORDER BY last_seen_at DESC, id
      LIMIT ? OFFSET ?
    `)
      .all(limit, offset)
      .map((row) => person(row as PersonRow));
  }

  findIdentity(
    provider: string,
    accountScope: string,
    externalId: string,
  ): PersonIdentity | undefined {
    const row = this.#identityRow(provider, accountScope, externalId);
    return row ? identity(row) : undefined;
  }

  setInjection(personId: string, enabled: boolean): Person | undefined {
    const now = new Date().toISOString();
    this.#db
      .prepare("UPDATE people SET injection_enabled = ?, updated_at = ? WHERE id = ?")
      .run(Number(enabled), now, personId);
    const row = this.#db.prepare("SELECT * FROM people WHERE id = ?").get(personId) as
      | PersonRow
      | undefined;
    return row ? person(row) : undefined;
  }

  replaceDossier(personId: string, reasonInput: string, input: unknown): PersonDossier {
    const dossier = Value.Parse(PERSON_DOSSIER_SCHEMA, input);
    this.#validateDossier(dossier);
    const dossierJson = serializeDossier(dossier);
    const reason = dossierReason(reasonInput);
    const reviewedAt = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const target = this.#db.prepare("SELECT id FROM people WHERE id = ?").get(personId) as
        | { id: string }
        | undefined;
      if (!target) throw new Error(`person not found: ${personId}`);
      const existing = this.#db
        .prepare("SELECT dossier_json FROM person_dossiers WHERE person_id = ?")
        .get(personId) as { dossier_json: string } | undefined;
      if (existing) parseDossierJson(existing.dossier_json);
      this.#db
        .prepare(`
          INSERT INTO person_dossiers (person_id, dossier_json, blurb, reviewed_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(person_id) DO UPDATE SET
            dossier_json = excluded.dossier_json,
            blurb = excluded.blurb,
            reviewed_at = excluded.reviewed_at
        `)
        .run(personId, dossierJson, dossier.blurb, reviewedAt);
      this.#db
        .prepare(`
          INSERT INTO person_dossier_changes
            (id, person_id, action, before_dossier_json, after_dossier_json, reason, changed_at)
          VALUES (?, ?, 'replace', ?, ?, ?, ?)
        `)
        .run(
          randomUUID(),
          personId,
          existing?.dossier_json ?? null,
          dossierJson,
          reason,
          reviewedAt,
        );
      this.#db.exec("COMMIT");
      return dossier;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteDossier(personId: string, reasonInput: string): boolean {
    const reason = dossierReason(reasonInput);
    const changedAt = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db
        .prepare("SELECT dossier_json FROM person_dossiers WHERE person_id = ?")
        .get(personId) as { dossier_json: string } | undefined;
      if (!existing) {
        this.#db.exec("COMMIT");
        return false;
      }
      parseDossierJson(existing.dossier_json);
      this.#db.prepare("DELETE FROM person_dossiers WHERE person_id = ?").run(personId);
      this.#db
        .prepare(`
          INSERT INTO person_dossier_changes
            (id, person_id, action, before_dossier_json, after_dossier_json, reason, changed_at)
          VALUES (?, ?, 'delete', ?, NULL, ?, ?)
        `)
        .run(randomUUID(), personId, existing.dossier_json, reason, changedAt);
      this.#db.exec("COMMIT");
      return true;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getWhisperReceipt(
    threadKey: string,
    personId: string,
  ): { runId: string; contribution: string; injectedAt: string } | undefined {
    const row = this.#db
      .prepare(`
      SELECT run_id, contribution, injected_at FROM person_whisper_receipts
      WHERE thread_key = ? AND person_id = ?
    `)
      .get(threadKey, personId) as
      | { run_id: string; contribution: string; injected_at: string }
      | undefined;
    return row
      ? { runId: row.run_id, contribution: row.contribution, injectedAt: row.injected_at }
      : undefined;
  }

  recordWhisperReceipt(input: {
    threadKey: string;
    personId: string;
    runId: string;
    contribution: string;
  }): { runId: string; contribution: string; injectedAt: string } {
    const threadKey = required(input.threadKey, "threadKey");
    const runId = required(input.runId, "runId");
    const contribution = required(input.contribution, "contribution");
    const injectedAt = new Date().toISOString();
    this.#db
      .prepare(`
      INSERT OR IGNORE INTO person_whisper_receipts
        (thread_key, person_id, run_id, contribution, injected_at)
      VALUES (?, ?, ?, ?, ?)
    `)
      .run(threadKey, input.personId, runId, contribution, injectedAt);
    return this.getWhisperReceipt(threadKey, input.personId)!;
  }

  getDossier(personId: string): { dossier: PersonDossier; reviewedAt: string } | undefined {
    const row = this.#db
      .prepare("SELECT dossier_json, reviewed_at FROM person_dossiers WHERE person_id = ?")
      .get(personId) as { dossier_json: string; reviewed_at: string } | undefined;
    return row
      ? {
          dossier: parseDossierJson(row.dossier_json),
          reviewedAt: row.reviewed_at,
        }
      : undefined;
  }

  getDossierReviewedAt(personId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT reviewed_at FROM person_dossiers WHERE person_id = ?")
      .get(personId) as { reviewed_at: string } | undefined;
    return row?.reviewed_at;
  }

  listDossierChanges(
    personId: string,
    limit = 20,
    offset = 0,
  ): PersonDossierChangeSummary[] {
    return this.#db
      .prepare(`
        SELECT id, person_id, action, reason, changed_at,
          CASE WHEN before_dossier_json IS NULL THEN NULL
            ELSE length(CAST(before_dossier_json AS BLOB)) END AS before_dossier_bytes,
          CASE WHEN after_dossier_json IS NULL THEN NULL
            ELSE length(CAST(after_dossier_json AS BLOB)) END AS after_dossier_bytes
        FROM person_dossier_changes
        WHERE person_id = ?
        ORDER BY changed_at DESC, rowid DESC
        LIMIT ? OFFSET ?
      `)
      .all(personId, limit, offset)
      .map((value) => {
        const row = value as DossierChangeSummaryRow;
        return {
          id: row.id,
          personId: row.person_id,
          action: row.action,
          beforeDossierBytes: row.before_dossier_bytes,
          afterDossierBytes: row.after_dossier_bytes,
          reason: row.reason,
          changedAt: row.changed_at,
        };
      });
  }

  getDossierChange(personId: string, changeId: string): PersonDossierChange | undefined {
    const row = this.#db
      .prepare("SELECT * FROM person_dossier_changes WHERE person_id = ? AND id = ?")
      .get(personId, changeId) as DossierChangeRow | undefined;
    return row
      ? {
          id: row.id,
          personId: row.person_id,
          action: row.action,
          beforeDossier:
            row.before_dossier_json === null
              ? null
              : parseDossierJson(row.before_dossier_json),
          afterDossier:
            row.after_dossier_json === null
              ? null
              : parseDossierJson(row.after_dossier_json),
          reason: row.reason,
          changedAt: row.changed_at,
        }
      : undefined;
  }

  getDossierBlurb(personId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT blurb FROM person_dossiers WHERE person_id = ?")
      .get(personId) as { blurb: string } | undefined;
    return row?.blurb;
  }

  softDeletePerson(personId: string): Person | undefined {
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.#db
        .prepare(`
        UPDATE people SET status = 'unavailable', injection_enabled = 0,
          updated_at = ? WHERE id = ?
      `)
        .run(now, personId);
      if (changed.changes === 0) {
        this.#db.exec("COMMIT");
        return undefined;
      }
      this.#upsertTodoRow(
        {
          deduplicationKey: `soft-delete-review:${personId}`,
          kind: "soft_delete_review",
          context: { personId },
        },
        now,
      );
      const updated = this.getPerson(personId)!;
      this.#db.exec("COMMIT");
      return updated;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  restorePerson(personId: string): Person | undefined {
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.#db
        .prepare(`
        UPDATE people SET status = 'active', injection_enabled = 0, updated_at = ?
        WHERE id = ? AND status = 'unavailable'
      `)
        .run(now, personId);
      if (changed.changes === 0) {
        this.#db.exec("COMMIT");
        return undefined;
      }
      const restored = this.getPerson(personId)!;
      this.#db.exec("COMMIT");
      return restored;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  resolveTodoByKey(deduplicationKey: string, note?: string): PeopleTodo | undefined {
    const now = new Date().toISOString();
    if (!this.#resolveTodoRow(deduplicationKey, note, now)) return undefined;
    const row = this.#db
      .prepare("SELECT * FROM people_todos WHERE deduplication_key = ?")
      .get(deduplicationKey) as TodoRow | undefined;
    return row ? todo(row) : undefined;
  }

  upsertTodo(input: { deduplicationKey: string; kind: string; context?: unknown }): PeopleTodo {
    const deduplicationKey = required(input.deduplicationKey, "deduplicationKey");
    const kind = required(input.kind, "kind");
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#upsertTodoRow({ deduplicationKey, kind, context: input.context }, now);
      this.#db.exec("COMMIT");
      return todo(row);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listTodos(limit = 100): PeopleTodo[] {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.#db
      .prepare(`
      SELECT * FROM people_todos
      WHERE status IN ('open', 'overflow')
      ORDER BY first_seen_at, id
      LIMIT ?
    `)
      .all(bounded)
      .map((row) => todo(row as TodoRow));
  }

  #upsertTodoRow(
    input: { deduplicationKey: string; kind: string; context?: unknown },
    now: string,
  ): TodoRow {
    const contextJson = JSON.stringify(input.context ?? {});
    const row = this.#db
      .prepare("SELECT * FROM people_todos WHERE deduplication_key = ?")
      .get(input.deduplicationKey) as TodoRow | undefined;
    if (row?.status === "resolved") {
      const count = this.#db
        .prepare("SELECT COUNT(*) AS count FROM people_todos WHERE status = 'open'")
        .get() as { count: number };
      if (count.count >= this.#maxOpenTodos) return this.#incrementOverflowTodo(now);
      this.#db
        .prepare(`
        UPDATE people_todos
        SET occurrence_count = occurrence_count + 1, context_json = ?, last_seen_at = ?,
          status = 'open', resolved_at = NULL, resolution_note = NULL
        WHERE id = ?
      `)
        .run(contextJson, now, row.id);
      return this.#db.prepare("SELECT * FROM people_todos WHERE id = ?").get(row.id) as TodoRow;
    }
    if (row) {
      this.#db
        .prepare(`
        UPDATE people_todos
        SET occurrence_count = occurrence_count + 1, context_json = ?, last_seen_at = ?
        WHERE id = ?
      `)
        .run(contextJson, now, row.id);
      return this.#db.prepare("SELECT * FROM people_todos WHERE id = ?").get(row.id) as TodoRow;
    }

    const count = this.#db
      .prepare("SELECT COUNT(*) AS count FROM people_todos WHERE status = 'open'")
      .get() as { count: number };
    if (count.count >= this.#maxOpenTodos) return this.#incrementOverflowTodo(now);
    const id = randomUUID();
    this.#db
      .prepare(`
      INSERT INTO people_todos
        (id, deduplication_key, kind, context_json, status, occurrence_count,
         first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, 'open', 1, ?, ?)
    `)
      .run(id, input.deduplicationKey, input.kind, contextJson, now, now);
    return this.#db.prepare("SELECT * FROM people_todos WHERE id = ?").get(id) as TodoRow;
  }

  #incrementOverflowTodo(now: string): TodoRow {
    const row = this.#db
      .prepare("SELECT * FROM people_todos WHERE deduplication_key = ?")
      .get(OVERFLOW_KEY) as TodoRow | undefined;
    if (row) {
      this.#db
        .prepare(`
        UPDATE people_todos SET occurrence_count = occurrence_count + 1, last_seen_at = ?,
          status = 'overflow', resolved_at = NULL, resolution_note = NULL
        WHERE id = ?
      `)
        .run(now, row.id);
      return this.#db.prepare("SELECT * FROM people_todos WHERE id = ?").get(row.id) as TodoRow;
    }
    const id = randomUUID();
    this.#db
      .prepare(`
      INSERT INTO people_todos
        (id, deduplication_key, kind, context_json, status, occurrence_count,
         first_seen_at, last_seen_at)
      VALUES (?, ?, 'overflow', '{}', 'overflow', 1, ?, ?)
    `)
      .run(id, OVERFLOW_KEY, now, now);
    return this.#db.prepare("SELECT * FROM people_todos WHERE id = ?").get(id) as TodoRow;
  }

  #resolveTodoRow(deduplicationKey: string, note: string | undefined, now: string): boolean {
    const changed = this.#db
      .prepare(`
      UPDATE people_todos SET status = 'resolved', resolved_at = ?, resolution_note = ?, last_seen_at = ?
      WHERE deduplication_key = ? AND status IN ('open', 'overflow')
    `)
      .run(now, note ?? null, now, deduplicationKey);
    return changed.changes === 1;
  }

  #identityRow(
    provider: string,
    accountScope: string,
    externalId: string,
  ): IdentityRow | undefined {
    return this.#db
      .prepare(`
      SELECT * FROM person_identities
      WHERE provider = ? AND account_scope = ? AND external_id = ?
    `)
      .get(provider, accountScope, externalId) as IdentityRow | undefined;
  }

  #validateDossier(dossier: PersonDossier): void {
    if (dossier.blurb.length > this.#maxBlurbChars) {
      throw new Error(`dossier blurb must not exceed ${this.#maxBlurbChars} characters`);
    }
    const categories = dossier.sections.map((section) => section.category);
    if (new Set(categories).size !== categories.length) {
      throw new Error("dossier sections must have unique categories");
    }
  }

  #migrate(): void {
    const current = this.#db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (current.user_version === 4) return;
    if (
      current.user_version !== 0 &&
      current.user_version !== 1 &&
      current.user_version !== 2 &&
      current.user_version !== 3
    ) {
      throw new Error(`unsupported PeopleSQL schema version: ${current.user_version}`);
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (current.user_version === 2) {
        this.#db.exec(`
          DROP TABLE person_evidence_receipts;
        `);
      } else if (current.user_version === 1) {
        this.#db.exec(`
          DROP INDEX people_policy_seen;
          ALTER TABLE people DROP COLUMN refinement_enabled;
          UPDATE people SET injection_enabled = 1 WHERE status = 'active';

          CREATE TABLE person_whisper_receipts (
            thread_key TEXT NOT NULL,
            person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL,
            contribution TEXT NOT NULL,
            injected_at TEXT NOT NULL,
            PRIMARY KEY (thread_key, person_id)
          ) STRICT;
        `);
      } else if (current.user_version === 0) {
        this.#db.exec(`
        CREATE TABLE companies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          primary_domain TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE people (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          preferred_name TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unavailable', 'archived')),
          company_id TEXT REFERENCES companies(id),
          injection_enabled INTEGER NOT NULL DEFAULT 1 CHECK (injection_enabled IN (0, 1)),
          last_seen_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE person_identities (
          person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          account_scope TEXT NOT NULL,
          external_id TEXT NOT NULL,
          display_name TEXT,
          real_name TEXT,
          handle TEXT,
          avatar_url TEXT,
          title TEXT,
          is_bot INTEGER CHECK (is_bot IN (0, 1)),
          is_deactivated INTEGER NOT NULL DEFAULT 0 CHECK (is_deactivated IN (0, 1)),
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          last_synced_at TEXT,
          PRIMARY KEY (provider, account_scope, external_id)
        ) STRICT;

        CREATE TABLE person_dossiers (
          person_id TEXT PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
          dossier_json TEXT NOT NULL,
          blurb TEXT NOT NULL,
          reviewed_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE people_todos (
          id TEXT PRIMARY KEY,
          deduplication_key TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          context_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'overflow')),
          occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          resolved_at TEXT,
          resolution_note TEXT
        ) STRICT;

        CREATE TABLE person_whisper_receipts (
          thread_key TEXT NOT NULL,
          person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL,
          contribution TEXT NOT NULL,
          injected_at TEXT NOT NULL,
          PRIMARY KEY (thread_key, person_id)
        ) STRICT;

        CREATE INDEX people_status_seen ON people(status, last_seen_at);
        CREATE INDEX people_todos_status_seen ON people_todos(status, last_seen_at);
        `);
      }
      this.#db.exec(`
        CREATE TABLE person_dossier_changes (
          id TEXT PRIMARY KEY,
          person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
          action TEXT NOT NULL CHECK (action IN ('replace', 'delete')),
          before_dossier_json TEXT,
          after_dossier_json TEXT,
          reason TEXT NOT NULL,
          changed_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX person_dossier_changes_person_changed
          ON person_dossier_changes(person_id, changed_at DESC);
        PRAGMA user_version = 4;
      `);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

export class PeopleStores {
  readonly #stateRoot: string;
  readonly #options: { maxOpenTodos: number; maxBlurbChars: number };
  readonly #stores = new Map<string, PeopleStore>();

  constructor(options: { stateRoot?: string; maxOpenTodos: number; maxBlurbChars: number }) {
    this.#stateRoot = options.stateRoot ?? resolveStateDir();
    this.#options = options;
  }

  get(agentId: string): PeopleStore {
    const normalized = normalizeAgentIdStrict(agentId);
    if (!normalized.ok || normalized.value !== agentId)
      throw new Error(`invalid agent id: ${agentId}`);
    const canonicalAgentId = normalized.value;
    let store = this.#stores.get(canonicalAgentId);
    if (!store) {
      store = new PeopleStore(
        join(this.#stateRoot, "agents", canonicalAgentId, "unblock-memory", "people.sqlite"),
        this.#options,
      );
      this.#stores.set(canonicalAgentId, store);
    }
    return store;
  }

  closeAll(): void {
    for (const store of this.#stores.values()) store.close();
    this.#stores.clear();
  }
}
