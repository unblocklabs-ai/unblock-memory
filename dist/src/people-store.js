import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { normalizeAgentIdStrict } from "openclaw/plugin-sdk/routing";
import { Type } from "typebox";
import { Value } from "typebox/value";
const BASELINE_DOSSIER_CATEGORIES = [
    "role",
    "priorities",
    "preferences",
    "successCriteria",
    "workingStyle",
    "relationship",
    "openLoops",
];
const evidenceRefSchema = Type.Object({
    source: Type.Union([
        Type.Literal("session"),
        Type.Literal("memory"),
        Type.Literal("directory"),
        Type.Literal("manual"),
    ]),
    locator: Type.String({ minLength: 1, maxLength: 1000 }),
    observedAt: Type.Optional(Type.String({
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$",
    })),
}, { additionalProperties: false });
const claimSchema = Type.Object({
    statement: Type.String({ minLength: 1, maxLength: 2000 }),
    evidence: Type.Array(evidenceRefSchema, { minItems: 1, maxItems: 50 }),
    epistemicType: Type.Union([
        Type.Literal("observed"),
        Type.Literal("reported"),
        Type.Literal("inferred"),
        Type.Literal("agent_assessment"),
    ]),
    confidence: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
}, { additionalProperties: false });
export const PERSON_DOSSIER_SCHEMA = Type.Object({
    schemaVersion: Type.Literal(1),
    blurb: Type.String({ minLength: 1 }),
    sections: Type.Array(Type.Object({
        category: Type.Union(BASELINE_DOSSIER_CATEGORIES.map((category) => Type.Literal(category))),
        claims: Type.Array(claimSchema, { minItems: 1, maxItems: 100 }),
    }, { additionalProperties: false }), { maxItems: BASELINE_DOSSIER_CATEGORIES.length }),
}, { additionalProperties: false });
const OVERFLOW_KEY = "__people_todo_overflow__";
function required(value, label) {
    const normalized = value.trim();
    if (!normalized)
        throw new Error(`${label} must be a non-empty string`);
    return normalized;
}
function optional(value) {
    return value?.trim() || null;
}
function person(row) {
    return {
        id: row.id,
        displayName: row.display_name,
        preferredName: row.preferred_name,
        status: row.status,
        companyId: row.company_id,
        refinementEnabled: row.refinement_enabled === 1,
        injectionEnabled: row.injection_enabled === 1,
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function identity(row) {
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
function todo(row) {
    return {
        id: row.id,
        deduplicationKey: row.deduplication_key,
        kind: row.kind,
        context: JSON.parse(row.context_json),
        status: row.status,
        occurrenceCount: row.occurrence_count,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        resolvedAt: row.resolved_at,
        resolutionNote: row.resolution_note,
    };
}
function company(row) {
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
    #db;
    #maxOpenTodos;
    #maxBlurbChars;
    constructor(path, options) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.#db = new DatabaseSync(path);
        this.#maxOpenTodos = options.maxOpenTodos;
        this.#maxBlurbChars = options.maxBlurbChars;
        try {
            chmodSync(path, 0o600);
            this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
            this.#migrate();
        }
        catch (error) {
            this.#db.close();
            throw error;
        }
    }
    close() {
        this.#db.close();
    }
    upsertIdentity(input) {
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
                    .get(personId);
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
            (id, display_name, status, refinement_enabled, injection_enabled,
             last_seen_at, created_at, updated_at)
          VALUES (?, ?, 'active', 0, 0, ?, ?, ?)
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
                    .run(personId, provider, accountScope, externalId, optional(input.displayName), optional(input.realName), optional(input.handle), optional(input.avatarUrl), optional(input.title), input.isBot === undefined ? null : Number(input.isBot), Number(input.isDeactivated ?? false), now, now, input.syncedAt ?? null);
                if (provider === "slack" && !directorySync) {
                    this.#upsertTodoRow({
                        deduplicationKey: `needs-enrichment:slack:${accountScope}:${externalId}`,
                        kind: "needs_enrichment",
                        context: { personId, provider, accountScope, externalId },
                    }, now);
                }
            }
            else {
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
                    .run(optional(input.displayName), optional(input.realName), optional(input.handle), optional(input.avatarUrl), optional(input.title), input.isBot === undefined ? null : Number(input.isBot), input.isDeactivated === undefined ? null : Number(input.isDeactivated), now, input.syncedAt ?? null, provider, accountScope, externalId);
                if (!directorySync) {
                    this.#db
                        .prepare("UPDATE people SET last_seen_at = ?, updated_at = ? WHERE id = ?")
                        .run(now, now, personId);
                }
            }
            if (input.isDeactivated === true) {
                this.#db
                    .prepare(`
          UPDATE people SET status = 'unavailable', refinement_enabled = 0,
            injection_enabled = 0, updated_at = ? WHERE id = ?
        `)
                    .run(now, personId);
            }
            const personRow = this.#db
                .prepare("SELECT * FROM people WHERE id = ?")
                .get(personId);
            const identityRow = this.#identityRow(provider, accountScope, externalId);
            this.#db.exec("COMMIT");
            return { person: person(personRow), identity: identity(identityRow), created: !existing };
        }
        catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }
    findPersonByIdentity(provider, accountScope, externalId) {
        const row = this.#db
            .prepare(`
      SELECT people.* FROM people
      JOIN person_identities ON person_identities.person_id = people.id
      WHERE person_identities.provider = ?
        AND person_identities.account_scope = ?
        AND person_identities.external_id = ?
    `)
            .get(provider, accountScope, externalId);
        return row ? person(row) : undefined;
    }
    getPerson(personId) {
        const row = this.#db.prepare("SELECT * FROM people WHERE id = ?").get(personId);
        return row ? person(row) : undefined;
    }
    listIdentities(personId) {
        return this.#db
            .prepare(`
      SELECT * FROM person_identities WHERE person_id = ?
      ORDER BY provider, account_scope, external_id
    `)
            .all(personId)
            .map((row) => identity(row));
    }
    getCompany(companyId) {
        const row = this.#db.prepare("SELECT * FROM companies WHERE id = ?").get(companyId);
        return row ? company(row) : undefined;
    }
    setCompany(personId, input) {
        const name = required(input.name, "company name");
        const primaryDomain = optional(input.primaryDomain);
        const now = new Date().toISOString();
        this.#db.exec("BEGIN IMMEDIATE");
        try {
            const target = this.#db.prepare("SELECT id FROM people WHERE id = ?").get(personId);
            if (!target) {
                this.#db.exec("COMMIT");
                return undefined;
            }
            let row = this.#db
                .prepare("SELECT * FROM companies WHERE name = ? COLLATE NOCASE")
                .get(name);
            if (!row) {
                const id = randomUUID();
                this.#db
                    .prepare(`
          INSERT INTO companies (id, name, primary_domain, status, created_at, updated_at)
          VALUES (?, ?, ?, 'active', ?, ?)
        `)
                    .run(id, name, primaryDomain, now, now);
                row = this.#db.prepare("SELECT * FROM companies WHERE id = ?").get(id);
            }
            else if (primaryDomain && primaryDomain !== row.primary_domain) {
                this.#db
                    .prepare("UPDATE companies SET primary_domain = ?, updated_at = ? WHERE id = ?")
                    .run(primaryDomain, now, row.id);
                row = this.#db.prepare("SELECT * FROM companies WHERE id = ?").get(row.id);
            }
            this.#db
                .prepare("UPDATE people SET company_id = ?, updated_at = ? WHERE id = ?")
                .run(row.id, now, personId);
            this.#db.exec("COMMIT");
            return company(row);
        }
        catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }
    listRefinementCandidates(limit) {
        const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
        return this.#db
            .prepare(`
      SELECT people.* FROM people
      LEFT JOIN person_dossiers ON person_dossiers.person_id = people.id
      WHERE people.status = 'active'
        AND people.refinement_enabled = 1
        AND people.last_seen_at IS NOT NULL
        AND (person_dossiers.reviewed_at IS NULL OR people.last_seen_at > person_dossiers.reviewed_at)
      ORDER BY people.last_seen_at DESC, people.id
      LIMIT ?
    `)
            .all(bounded)
            .map((row) => person(row));
    }
    findIdentity(provider, accountScope, externalId) {
        const row = this.#identityRow(provider, accountScope, externalId);
        return row ? identity(row) : undefined;
    }
    setPolicies(personId, policies) {
        const now = new Date().toISOString();
        this.#db
            .prepare(`
      UPDATE people SET
        refinement_enabled = COALESCE(?, refinement_enabled),
        injection_enabled = COALESCE(?, injection_enabled),
        updated_at = ?
      WHERE id = ?
    `)
            .run(policies.refinementEnabled === undefined ? null : Number(policies.refinementEnabled), policies.injectionEnabled === undefined ? null : Number(policies.injectionEnabled), now, personId);
        const row = this.#db.prepare("SELECT * FROM people WHERE id = ?").get(personId);
        return row ? person(row) : undefined;
    }
    replaceDossier(personId, input, reviewedAt = new Date().toISOString(), options = {}) {
        const dossier = Value.Parse(PERSON_DOSSIER_SCHEMA, input);
        if (dossier.blurb.length > this.#maxBlurbChars) {
            throw new Error(`dossier blurb must not exceed ${this.#maxBlurbChars} characters`);
        }
        const categories = dossier.sections.map((section) => section.category);
        if (new Set(categories).size !== categories.length) {
            throw new Error("dossier sections must have unique categories");
        }
        this.#db.exec("BEGIN IMMEDIATE");
        try {
            const target = this.#db
                .prepare("SELECT refinement_enabled FROM people WHERE id = ?")
                .get(personId);
            if (!target)
                throw new Error(`person not found: ${personId}`);
            if (options.requireRefinementEnabled && target.refinement_enabled !== 1) {
                throw new Error("person is not enabled for refinement");
            }
            const dossierJson = JSON.stringify(dossier);
            const current = this.#db
                .prepare("SELECT dossier_json FROM person_dossiers WHERE person_id = ?")
                .get(personId);
            if (current?.dossier_json === dossierJson) {
                this.#db
                    .prepare("UPDATE person_dossiers SET reviewed_at = ? WHERE person_id = ?")
                    .run(reviewedAt, personId);
            }
            else {
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
            }
            this.#db.exec("COMMIT");
            return dossier;
        }
        catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }
    getDossier(personId) {
        const row = this.#db
            .prepare("SELECT dossier_json, reviewed_at FROM person_dossiers WHERE person_id = ?")
            .get(personId);
        return row
            ? {
                dossier: Value.Parse(PERSON_DOSSIER_SCHEMA, JSON.parse(row.dossier_json)),
                reviewedAt: row.reviewed_at,
            }
            : undefined;
    }
    getDossierBlurb(personId) {
        const row = this.#db
            .prepare("SELECT blurb FROM person_dossiers WHERE person_id = ?")
            .get(personId);
        return row?.blurb;
    }
    softDeletePerson(personId) {
        const now = new Date().toISOString();
        this.#db.exec("BEGIN IMMEDIATE");
        try {
            const changed = this.#db
                .prepare(`
        UPDATE people SET status = 'unavailable', refinement_enabled = 0,
          injection_enabled = 0, updated_at = ? WHERE id = ?
      `)
                .run(now, personId);
            if (changed.changes === 0) {
                this.#db.exec("COMMIT");
                return undefined;
            }
            this.#upsertTodoRow({
                deduplicationKey: `soft-delete-review:${personId}`,
                kind: "soft_delete_review",
                context: { personId },
            }, now);
            const updated = this.getPerson(personId);
            this.#db.exec("COMMIT");
            return updated;
        }
        catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }
    restorePerson(personId) {
        const now = new Date().toISOString();
        this.#db.exec("BEGIN IMMEDIATE");
        try {
            const changed = this.#db
                .prepare(`
        UPDATE people SET status = 'active', refinement_enabled = 0,
          injection_enabled = 0, updated_at = ?
        WHERE id = ? AND status = 'unavailable'
      `)
                .run(now, personId);
            if (changed.changes === 0) {
                this.#db.exec("COMMIT");
                return undefined;
            }
            const restored = this.getPerson(personId);
            this.#db.exec("COMMIT");
            return restored;
        }
        catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }
    resolveTodoByKey(deduplicationKey, note) {
        const now = new Date().toISOString();
        if (!this.#resolveTodoRow(deduplicationKey, note, now))
            return undefined;
        const row = this.#db
            .prepare("SELECT * FROM people_todos WHERE deduplication_key = ?")
            .get(deduplicationKey);
        return row ? todo(row) : undefined;
    }
    upsertTodo(input) {
        const deduplicationKey = required(input.deduplicationKey, "deduplicationKey");
        const kind = required(input.kind, "kind");
        const now = new Date().toISOString();
        this.#db.exec("BEGIN IMMEDIATE");
        try {
            const row = this.#upsertTodoRow({ deduplicationKey, kind, context: input.context }, now);
            this.#db.exec("COMMIT");
            return todo(row);
        }
        catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }
    listTodos(limit = 100) {
        const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
        return this.#db
            .prepare(`
      SELECT * FROM people_todos
      WHERE status IN ('open', 'overflow')
      ORDER BY first_seen_at, id
      LIMIT ?
    `)
            .all(bounded)
            .map((row) => todo(row));
    }
    #upsertTodoRow(input, now) {
        const contextJson = JSON.stringify(input.context ?? {});
        const row = this.#db
            .prepare("SELECT * FROM people_todos WHERE deduplication_key = ?")
            .get(input.deduplicationKey);
        if (row?.status === "resolved") {
            const count = this.#db
                .prepare("SELECT COUNT(*) AS count FROM people_todos WHERE status = 'open'")
                .get();
            if (count.count >= this.#maxOpenTodos)
                return this.#incrementOverflowTodo(now);
            this.#db
                .prepare(`
        UPDATE people_todos
        SET occurrence_count = occurrence_count + 1, context_json = ?, last_seen_at = ?,
          status = 'open', resolved_at = NULL, resolution_note = NULL
        WHERE id = ?
      `)
                .run(contextJson, now, row.id);
            return this.#db.prepare("SELECT * FROM people_todos WHERE id = ?").get(row.id);
        }
        if (row) {
            this.#db
                .prepare(`
        UPDATE people_todos
        SET occurrence_count = occurrence_count + 1, context_json = ?, last_seen_at = ?
        WHERE id = ?
      `)
                .run(contextJson, now, row.id);
            return this.#db.prepare("SELECT * FROM people_todos WHERE id = ?").get(row.id);
        }
        const count = this.#db
            .prepare("SELECT COUNT(*) AS count FROM people_todos WHERE status = 'open'")
            .get();
        if (count.count >= this.#maxOpenTodos)
            return this.#incrementOverflowTodo(now);
        const id = randomUUID();
        this.#db
            .prepare(`
      INSERT INTO people_todos
        (id, deduplication_key, kind, context_json, status, occurrence_count,
         first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, 'open', 1, ?, ?)
    `)
            .run(id, input.deduplicationKey, input.kind, contextJson, now, now);
        return this.#db.prepare("SELECT * FROM people_todos WHERE id = ?").get(id);
    }
    #incrementOverflowTodo(now) {
        const row = this.#db
            .prepare("SELECT * FROM people_todos WHERE deduplication_key = ?")
            .get(OVERFLOW_KEY);
        if (row) {
            this.#db
                .prepare(`
        UPDATE people_todos SET occurrence_count = occurrence_count + 1, last_seen_at = ?,
          status = 'overflow', resolved_at = NULL, resolution_note = NULL
        WHERE id = ?
      `)
                .run(now, row.id);
            return this.#db.prepare("SELECT * FROM people_todos WHERE id = ?").get(row.id);
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
        return this.#db.prepare("SELECT * FROM people_todos WHERE id = ?").get(id);
    }
    #resolveTodoRow(deduplicationKey, note, now) {
        const changed = this.#db
            .prepare(`
      UPDATE people_todos SET status = 'resolved', resolved_at = ?, resolution_note = ?, last_seen_at = ?
      WHERE deduplication_key = ? AND status IN ('open', 'overflow')
    `)
            .run(now, note ?? null, now, deduplicationKey);
        return changed.changes === 1;
    }
    #identityRow(provider, accountScope, externalId) {
        return this.#db
            .prepare(`
      SELECT * FROM person_identities
      WHERE provider = ? AND account_scope = ? AND external_id = ?
    `)
            .get(provider, accountScope, externalId);
    }
    #migrate() {
        const current = this.#db.prepare("PRAGMA user_version").get();
        if (current.user_version === 1)
            return;
        if (current.user_version !== 0) {
            throw new Error(`unsupported PeopleSQL schema version: ${current.user_version}`);
        }
        this.#db.exec("BEGIN IMMEDIATE");
        try {
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
          refinement_enabled INTEGER NOT NULL DEFAULT 0 CHECK (refinement_enabled IN (0, 1)),
          injection_enabled INTEGER NOT NULL DEFAULT 0 CHECK (injection_enabled IN (0, 1)),
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

        CREATE INDEX people_status_seen ON people(status, last_seen_at);
        CREATE INDEX people_policy_seen ON people(refinement_enabled, last_seen_at);
        CREATE INDEX people_todos_status_seen ON people_todos(status, last_seen_at);
        PRAGMA user_version = 1;
      `);
            this.#db.exec("COMMIT");
        }
        catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }
}
export class PeopleStores {
    #stateRoot;
    #options;
    #stores = new Map();
    constructor(options) {
        this.#stateRoot = options.stateRoot ?? resolveStateDir();
        this.#options = options;
    }
    get(agentId) {
        const normalized = normalizeAgentIdStrict(agentId);
        if (!normalized.ok || normalized.value !== agentId)
            throw new Error(`invalid agent id: ${agentId}`);
        const canonicalAgentId = normalized.value;
        let store = this.#stores.get(canonicalAgentId);
        if (!store) {
            store = new PeopleStore(join(this.#stateRoot, "agents", canonicalAgentId, "unblock-memory", "people.sqlite"), this.#options);
            this.#stores.set(canonicalAgentId, store);
        }
        return store;
    }
    closeAll() {
        for (const store of this.#stores.values())
            store.close();
        this.#stores.clear();
    }
}
