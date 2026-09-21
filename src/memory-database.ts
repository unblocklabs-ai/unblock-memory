import { closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MEMORY_DATABASE = "unblock-memory.sqlite";

const legacyStores = [
  { file: "curation.sqlite", component: "curation", tables: [
    "temporal_annotations", "maintenance_tasks", "quality_judgments",
  ] },
  { file: "people.sqlite", component: "people", tables: [
    "companies", "people", "person_identities", "person_dossiers", "people_todos",
    "person_whisper_receipts", "person_evidence_receipts", "person_dossier_changes", "person_primer_judgments",
  ] },
  { file: "response-audit.sqlite", component: "responses", tables: [
    "response_lease", "response_results", "response_scans", "response_checkpoints", "response_cursors",
    "response_schedule", "response_stages", "response_stage_links", "response_review_tasks",
    "response_review_evidence", "response_review_decisions", "response_review_versions", "response_annotations",
  ] },
] as const;

function identifier(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

function requireRegularFile(path: string): void {
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (file && !file.isFile()) throw new Error("Memory database must be a regular file, not a symlink");
}

function enableWal(db: DatabaseSync): void {
  // Switching journal modes can return SQLITE_BUSY without invoking busy_timeout.
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode=WAL");
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("errcode" in error) || error.errcode !== 5 || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, Math.max(0, deadline - Date.now())));
    }
  }
}

/** Separate domain stores share settings, not a monolithic data-access API. */
export function openMemoryDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  requireRegularFile(path);
  const descriptor = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(descriptor, 0o600); } finally { closeSync(descriptor); }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    enableWal(db);
    db.exec(`PRAGMA foreign_keys=ON;
      PRAGMA trusted_schema=OFF;
      CREATE TABLE IF NOT EXISTS memory_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;`);
    // Explicit standalone store paths remain useful to tests and offline tools.
    // Only the production filename opts into sibling-file consolidation.
    if (basename(path) === MEMORY_DATABASE) consolidate(db, dirname(path));
    return db;
  } catch (error) { db.close(); throw error; }
}

function consolidate(db: DatabaseSync, directory: string): void {
  const completed = () => {
    const version = db.prepare("SELECT version FROM memory_schema WHERE component='storage'").get()?.version;
    if (version !== undefined && version !== 1) throw new Error("Unsupported durable storage version");
    return version === 1;
  };
  if (completed()) return;
  const sources = legacyStores.filter(source => lstatSync(join(directory, source.file), { throwIfNoEntry: false }));
  const attached: string[] = [];
  try {
    for (const source of sources) {
      const path = join(directory, source.file);
      requireRegularFile(path);
      const alias = `legacy_${source.component}`;
      db.prepare(`ATTACH DATABASE ? AS ${identifier(alias)}`).run(path);
      attached.push(alias);
    }
    // Attached legacy writer locks cover the entire snapshot/copy/verification.
    // They cannot stop old binaries writing again later: upgrade with writers stopped.
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    try {
      if (!completed()) {
        const existing = db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name!='memory_schema'").get();
        if (existing) throw new Error("Unmarked durable database is not empty; refusing to overwrite it");
        for (const source of sources) {
          const schema = identifier(`legacy_${source.component}`);
          const version = Number(db.prepare(`PRAGMA ${schema}.user_version`).get()?.user_version);
          if (source.component === "people" ? version < 0 || version > 4 : version !== 0) {
            throw new Error(`Unsupported legacy ${source.component} schema version`);
          }
          const integrity = db.prepare(`PRAGMA ${schema}.integrity_check`).all();
          if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error(`Invalid legacy ${source.component} database`);
          const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema WHERE name NOT LIKE 'sqlite_%'`).all();
          if (source.component === "people" && version === 0 && objects.length) throw new Error("Unversioned legacy people schema");
          for (const object of objects) {
            if ((object.type !== "table" && object.type !== "index") || typeof object.sql !== "string" ||
                !source.tables.some(name => name === object.tbl_name) || /CREATE\s+VIRTUAL\s+TABLE/i.test(object.sql)) {
              throw new Error(`Unsupported legacy ${source.component} schema object`);
            }
          }
          const tables = objects.filter(object => object.type === "table");
          if (source.component === "people" && version > 0) {
            const required = ["companies", "people", "person_identities", "person_dossiers", "people_todos",
              ...(version >= 2 ? ["person_whisper_receipts"] : []),
              ...(version === 2 ? ["person_evidence_receipts"] : []),
              ...(version === 4 ? ["person_dossier_changes"] : [])];
            if (required.some(name => !tables.some(table => table.name === name))) throw new Error("Incomplete legacy people schema");
          }
          for (const table of tables) db.exec(String(table.sql));
          for (const table of tables) {
            const name = identifier(String(table.name));
            db.exec(`INSERT INTO main.${name} SELECT * FROM ${schema}.${name}`);
            const counts = db.prepare(`SELECT (SELECT count(*) FROM main.${name}) AS actual,
              (SELECT count(*) FROM ${schema}.${name}) AS expected`).get();
            const different = db.prepare(`SELECT * FROM ${schema}.${name} EXCEPT SELECT * FROM main.${name}`).get();
            const extra = db.prepare(`SELECT * FROM main.${name} EXCEPT SELECT * FROM ${schema}.${name}`).get();
            if (counts?.actual !== counts?.expected || different || extra) throw new Error(`Legacy ${source.component} copy verification failed`);
          }
          for (const index of objects.filter(object => object.type === "index")) db.exec(String(index.sql));
          if (source.component === "people") db.prepare("INSERT INTO memory_schema VALUES ('people',?)").run(version);
        }
        if (db.prepare("PRAGMA main.foreign_key_check").get()) throw new Error("Migrated memory has broken foreign keys");
        const integrity = db.prepare("PRAGMA main.integrity_check").all();
        if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("Migrated memory integrity check failed");
        db.prepare("INSERT INTO memory_schema VALUES ('storage',1)").run();
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    finally { db.exec("PRAGMA foreign_keys=ON"); }
  } finally {
    for (const alias of attached.reverse()) db.exec(`DETACH DATABASE ${identifier(alias)}`);
  }
}

/** File existence no longer tells us which feature has initialized its tables. */
export function hasMemoryTable(path: string, table: string): boolean {
  if (!existsSync(path) && !(basename(path) === MEMORY_DATABASE &&
      legacyStores.some(source => existsSync(join(dirname(path), source.file))))) return false;
  const db = openMemoryDatabase(path);
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)); }
  finally { db.close(); }
}
