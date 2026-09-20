import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { CurationStore } from "../src/curation.js";
import { hasMemoryTable, MEMORY_DATABASE, openMemoryDatabase } from "../src/memory-database.js";
import { PeopleStore } from "../src/people-store.js";
import { ResponseAuditStore } from "../src/response-store.js";
import { ResponsePeople } from "../src/response-identity.js";
import type { ResponseEpisode } from "../src/response-episodes.js";

const peopleOptions = { maxOpenTodos: 10, maxBlurbChars: 1200 };
const command = promisify(execFile);
const temp = () => mkdtemp(join(tmpdir(), "memory-consolidation-"));
const tableNames = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map(row => String(row.name));

// Current store APIs supply realistic data; remove new metadata to reproduce
// exactly the legacy on-disk layout, including the old PeopleSQL version pragma.
async function legacyFixture(root: string) {
  const curation = new CurationStore(join(root, "curation.sqlite"));
  curation.cacheQualityJudgment("cached", { noise: 0.1, evidence: 0.9 });
  curation.addTask({ type: "quality_review", corpus: "memory", collection: "memory", path: "test.md",
    reason: "review", contentFingerprint: "fp", detail: "Memory task, not a response audit" });
  curation.close();
  const people = new PeopleStore(join(root, "people.sqlite"), peopleOptions);
  const person = people.upsertIdentity({ provider: "slack", accountScope: "default", externalId: "U123", displayName: "Bek" }).person;
  people.replaceDossier(person.id, "test", { schemaVersion: 1, blurb: "Bek is the CEO.", sections: [] });
  people.recordWhisperReceipt({ threadKey: "thread", personId: person.id, runId: "run", contribution: "CEO" });
  people.close();
  const response = new ResponseAuditStore(join(root, "response-audit.sqlite"));
  response.claimScheduled(1000, 720_000);
  response.acquire(1000);
  response.checkpointSave("cohort", "session", "revision", { eligible: 1 });
  response.advance("cohort", "session");
  response.reviews.annotate(1000, "deployment", "Operator-only annotation");
  response.close();
  const audit = new DatabaseSync(join(root, "response-audit.sqlite"));
  audit.exec(`INSERT INTO response_results VALUES ('cohort','episode','session','hash',1000,1,'ok',1,1000,1001,'{"opaque":"cached judgment"}');
    INSERT INTO response_stages VALUES ('stage-key','quality','ok',1,1000,1001,'{"cached":"stage judgment"}');
    INSERT INTO response_stage_links VALUES ('cohort','episode','hash','quality','stage-key');
    INSERT INTO response_scans VALUES ('cohort',1001,'{"evaluated":1}');
    INSERT INTO response_review_tasks VALUES ('review','episode','delivery_quality','human','resolved','human','Keep decision',1000,1001);
    INSERT INTO response_review_evidence VALUES ('review','cohort','hash',1,'{"references":[1,2]}');
    INSERT INTO response_review_decisions VALUES (9,'review','resolved','human','Keep decision',1001);
    INSERT INTO response_review_versions VALUES ('cohort','episode','hash','review-policy');`);
  audit.close();
  for (const file of ["curation.sqlite", "people.sqlite", "response-audit.sqlite"]) {
    const db = new DatabaseSync(join(root, file));
    db.exec(`DROP TABLE memory_schema; PRAGMA user_version=${file === "people.sqlite" ? 4 : 0}`);
    db.close();
  }
  return person;
}

test("imports all legacy values and schemas, including live WAL; preserves files, QMD and audit privacy", async () => {
  const root = await temp(), person = await legacyFixture(root), path = join(root, MEMORY_DATABASE);
  const index = join(root, "index.sqlite"); await writeFile(index, "QMD sentinel");
  const legacyPeople = new DatabaseSync(join(root, "people.sqlite"));
  legacyPeople.exec("PRAGMA wal_autocheckpoint=0; UPDATE people SET preferred_name='WAL-only name'");
  assert.ok((await stat(join(root, "people.sqlite-wal"))).size > 0);
  const db = openMemoryDatabase(path);
  try {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA busy_timeout").get()?.timeout, 5000);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 0);
    assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    for (const file of ["curation.sqlite", "people.sqlite", "response-audit.sqlite"]) {
      const source = new DatabaseSync(join(root, file), { readOnly: true });
      try {
        for (const table of tableNames(source)) {
          assert.deepEqual(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
            source.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(), table);
        }
      } finally { source.close(); }
    }
    assert.equal(db.prepare("SELECT preferred_name FROM people WHERE id=?").get(person.id)?.preferred_name, "WAL-only name");
  } finally { db.close(); legacyPeople.close(); }
  assert.equal(await readFile(index, "utf8"), "QMD sentinel");

  const people = new PeopleStore(path, peopleOptions), curation = new CurationStore(path), response = new ResponseAuditStore(path);
  const identities = new ResponsePeople(path);
  try {
    assert.equal(people.getDossier(person.id)?.dossier.blurb, "Bek is the CEO.");
    assert.equal(people.getWhisperReceipt("thread", person.id)?.runId, "run");
    assert.deepEqual({ ...curation.qualityJudgment("cached") }, { noise: 0.1, evidence: 0.9 });
    assert.equal(curation.listTasks().length, 1);
    assert.equal(response.reviews.annotations(0, 2000).length, 1);
    assert.equal(response.checkpoint("cohort", "session")?.revision, "revision");
    assert.equal(response.cursor("cohort"), "session");
    assert.equal(response.needsJudgment("cohort", { id: "episode", inputHash: "hash" } as ResponseEpisode, 1_000_000), false);
    assert.equal(response.reviews.list("cohort")[0]?.resolutionNote, "Keep decision");
    assert.equal(response.acquire(1001), undefined);
    assert.equal(response.claimScheduled(2000, 720_000), false);
    assert.equal(identities.resolve({ senderId: "U123", session: { accountId: "default", sessionId: "session" } } as ResponseEpisode).personId, person.id);
    assert.doesNotMatch(JSON.stringify(curation.listTasks()), /Operator-only annotation/);
    // Completed imports must not resurrect stale legacy values on reopen.
    people.upsertIdentity({ provider: "slack", accountScope: "default", externalId: "new", displayName: "New" });
  } finally { identities.close(); people.close(); curation.close(); response.close(); }
  const reopened = new PeopleStore(path, peopleOptions);
  assert.ok(reopened.findPersonByIdentity("slack", "default", "new"));
  reopened.close();
});

test("fresh/partial installations share one database without implying response history", async () => {
  const root = await temp(), path = join(root, MEMORY_DATABASE);
  assert.equal(hasMemoryTable(path, "response_results"), false);
  new PeopleStore(path, peopleOptions).close();
  assert.equal(hasMemoryTable(path, "response_results"), false);
  new CurationStore(path).close();
  new ResponseAuditStore(path).close();
  assert.equal(hasMemoryTable(path, "response_results"), true);
  const partial = await temp();
  const legacy = new CurationStore(join(partial, "curation.sqlite"));
  legacy.cacheQualityJudgment("key", { noise: 0, evidence: 1 }); legacy.close();
  const db = new DatabaseSync(join(partial, "curation.sqlite")); db.exec("DROP TABLE memory_schema"); db.close();
  const migrated = new CurationStore(join(partial, MEMORY_DATABASE));
  assert.equal(migrated.qualityJudgment("key")?.evidence, 1); migrated.close();
});

test("failed import rolls back every copied table and retries without duplication", async () => {
  const root = await temp(); await legacyFixture(root);
  const path = join(root, MEMORY_DATABASE), legacy = new DatabaseSync(join(root, "response-audit.sqlite"));
  legacy.exec("CREATE TABLE unknown_future_schema (id TEXT)");
  assert.throws(() => openMemoryDatabase(path), /Unsupported legacy responses/);
  const failed = new DatabaseSync(path);
  assert.deepEqual(tableNames(failed), ["memory_schema"]);
  assert.equal(failed.prepare("SELECT * FROM memory_schema").get(), undefined); failed.close();
  legacy.exec("DROP TABLE unknown_future_schema"); legacy.close();
  const retry = openMemoryDatabase(path);
  assert.equal(retry.prepare("SELECT count(*) n FROM people").get()?.n, 1); retry.close();
  openMemoryDatabase(path).close();
});

test("refuses unsupported versions, corrupt/incomplete sources, broken references and unmarked populated targets", async () => {
  for (const failure of ["version", "corrupt", "incomplete", "foreign-key", "target"] as const) {
    const root = await temp(); await legacyFixture(root);
    const path = join(root, MEMORY_DATABASE);
    if (failure === "corrupt") await writeFile(join(root, "response-audit.sqlite"), "not sqlite");
    else if (failure === "target") {
      const db = new DatabaseSync(path); db.exec("CREATE TABLE unrelated(id TEXT)"); db.close();
    } else {
      const db = new DatabaseSync(join(root, "people.sqlite"));
      db.exec(failure === "version" ? "PRAGMA user_version=99" : failure === "incomplete" ? "DROP TABLE person_dossiers" :
        "PRAGMA foreign_keys=OFF; UPDATE person_dossiers SET person_id='absent'");
      db.close();
    }
    assert.throws(() => openMemoryDatabase(path));
    const db = new DatabaseSync(path);
    assert.equal(db.prepare("SELECT version FROM memory_schema WHERE component='storage'").get(), undefined);
    db.close();
  }
});

test("consolidates PeopleSQL versions 1–3 before applying their existing upgrades", async () => {
  for (const version of [1, 2, 3]) {
    const root = await temp(), person = await legacyFixture(root);
    const legacy = new DatabaseSync(join(root, "people.sqlite"));
    legacy.exec(`DROP TABLE person_dossier_changes; PRAGMA user_version=${version}`);
    if (version === 1) legacy.exec(`DROP TABLE person_whisper_receipts;
      ALTER TABLE people ADD COLUMN refinement_enabled INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX people_policy_seen ON people(refinement_enabled,last_seen_at)`);
    if (version === 2) legacy.exec("CREATE TABLE person_evidence_receipts (person_id TEXT, locator TEXT)");
    legacy.close();
    const path = join(root, MEMORY_DATABASE), store = new PeopleStore(path, peopleOptions);
    assert.equal(store.getDossier(person.id)?.dossier.blurb, "Bek is the CEO."); store.close();
    const db = openMemoryDatabase(path);
    assert.equal(db.prepare("SELECT version FROM memory_schema WHERE component='people'").get()?.version, 4);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 0); db.close();
    const old = new DatabaseSync(join(root, "people.sqlite"), { readOnly: true });
    assert.equal(old.prepare("PRAGMA user_version").get()?.user_version, version); old.close();
  }
});

test("simultaneous first opens import only once, then independent stores write safely", async () => {
  const root = await temp(); await legacyFixture(root);
  const path = join(root, MEMORY_DATABASE), module = new URL("../src/memory-database.ts", import.meta.url).href;
  const run = (key: string) => command(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {openMemoryDatabase} from ${JSON.stringify(module)};
    const db=openMemoryDatabase(${JSON.stringify(path)});
    db.prepare('INSERT INTO quality_judgments VALUES (?,0,1)').run(${JSON.stringify(key)}); db.close();`]);
  await Promise.all([run("one"), run("two"), run("three")]);
  const db = openMemoryDatabase(path);
  assert.equal(db.prepare("SELECT count(*) n FROM people").get()?.n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM quality_judgments").get()?.n, 4); db.close();
});

test("terminated uncommitted work is rolled back before migration retries", async () => {
  const root = await temp(); await legacyFixture(root);
  const path = join(root, MEMORY_DATABASE);
  await command(process.execPath, ["--input-type=module", "-e", `import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(${JSON.stringify(path)});
    db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE people(id TEXT); INSERT INTO people VALUES ('partial')");
    process.exit(0);`]);
  const db = openMemoryDatabase(path);
  assert.equal(db.prepare("SELECT count(*) n FROM people").get()?.n, 1);
  assert.equal(db.prepare("SELECT id FROM people WHERE id='partial'").get(), undefined); db.close();
});

test("rejects database symlinks instead of overwriting their targets", async () => {
  const root = await temp(), target = join(root, "unrelated"); await writeFile(target, "untouched");
  await symlink(target, join(root, MEMORY_DATABASE));
  assert.throws(() => openMemoryDatabase(join(root, MEMORY_DATABASE)), /regular file/);
  assert.equal(await readFile(target, "utf8"), "untouched");
  const dangling = await temp();
  await symlink(join(dangling, "absent"), join(dangling, MEMORY_DATABASE));
  assert.throws(() => openMemoryDatabase(join(dangling, MEMORY_DATABASE)), /regular file/);
  const legacyLink = await temp();
  await symlink(join(legacyLink, "absent"), join(legacyLink, "people.sqlite"));
  assert.throws(() => openMemoryDatabase(join(legacyLink, MEMORY_DATABASE)), /regular file/);
});
