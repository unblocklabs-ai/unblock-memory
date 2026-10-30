import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { openMemoryDatabase } from "./memory-database.js";
import { PURGED_GRADE, baselineFingerprint, purgeEmotionProfile, refreshEmotionBaselines, tableExists } from "./emotion-baselines.js";
// Imported by the baseline worker with plain Node resolution: host SDK aliases do not
// reach worker threads, so this module and its imports must stay free of `openclaw`.
const SCHEMA = `CREATE TABLE IF NOT EXISTS inside_out (
  interaction_id TEXT NOT NULL, rubric TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL, human_key TEXT NOT NULL, sender_id TEXT NOT NULL, channel TEXT NOT NULL, source TEXT NOT NULL,
  target_at INTEGER, reviewed_at INTEGER NOT NULL, model TEXT NOT NULL, context_trimmed INTEGER NOT NULL,
  joy REAL, sadness REAL, fear REAL, anger REAL, disgust REAL, surprise REAL, error TEXT, person_id TEXT,
  PRIMARY KEY(interaction_id,rubric)
) STRICT;
CREATE INDEX IF NOT EXISTS inside_out_human_time ON inside_out(human_key,target_at);
CREATE INDEX IF NOT EXISTS inside_out_failed_rubric ON inside_out(rubric,reviewed_at) WHERE error IS NOT NULL;
CREATE TABLE IF NOT EXISTS inside_out_checkpoints (
  source TEXT NOT NULL, rubric TEXT NOT NULL, session_id TEXT NOT NULL, signature TEXT NOT NULL,
  revision TEXT NOT NULL, last_seq INTEGER NOT NULL,
  PRIMARY KEY(source,rubric)
) STRICT;`;
// A missing account may match across scopes only when every candidate names the same person.
export const PERSON_MATCH = `SELECT min(i.person_id) person_id FROM person_identities i
  WHERE i.provider=e.channel AND i.external_id=e.sender_id
  AND (i.account_scope=json_extract(e.human_key,'$[1]') OR substr(json_extract(e.human_key,'$[1]'),1,8)='session:')
  HAVING count(DISTINCT i.person_id)=1`;
export function openInsideOutStore(path) {
    const db = openMemoryDatabase(path);
    try {
        db.exec(SCHEMA);
        if (!db.prepare("SELECT 1 FROM pragma_table_info('inside_out') WHERE name='person_id'").get()) {
            db.exec("ALTER TABLE inside_out ADD COLUMN person_id TEXT");
        }
        db.exec("CREATE INDEX IF NOT EXISTS inside_out_person_time ON inside_out(person_id,target_at)");
        return db;
    }
    catch (error) {
        db.close();
        throw error;
    }
}
/**
 * Refresh People links without loading transcripts or calling Jev. Known accounts stay exact.
 * Purged grades stay unlinked. Matching is a read; only changed links are written, in short batches.
 */
export function linkInsideOutPeople(path) {
    const db = openInsideOutStore(path);
    try {
        let updated = 0;
        if (tableExists(db, "person_identities")) {
            const person = `(${PERSON_MATCH})`;
            const changes = db.prepare(`SELECT e.rowid id,${person} person_id FROM inside_out e
        WHERE e.person_id IS NOT ${person} AND e.error IS NOT ?`).all(PURGED_GRADE);
            const link = db.prepare("UPDATE inside_out SET person_id=? WHERE rowid=? AND error IS NOT ?");
            for (let start = 0; start < changes.length; start += 500) {
                db.exec("BEGIN IMMEDIATE");
                try {
                    for (const change of changes.slice(start, start + 500))
                        updated += Number(link.run(change.person_id, change.id, PURGED_GRADE).changes);
                    db.exec("COMMIT");
                }
                catch (error) {
                    db.exec("ROLLBACK");
                    throw error;
                }
            }
        }
        const counts = db.prepare(`SELECT count(person_id) linked,count(*)-count(person_id) unlinked FROM inside_out`).get();
        return { updated, linked: Number(counts.linked), unlinked: Number(counts.unlinked) };
    }
    finally {
        db.close();
    }
}
/** Rebuild local statistics from existing grades, refreshing exact People links first unless the caller just did. */
export function refreshInsideOutBaselines(path, options = {}) {
    return refreshWithFingerprint(path, options).result;
}
/**
 * Worker entry, also behind the synchronous API. `unless`: the fingerprint left by this store's
 * previous refresh; unchanged inputs skip the pass.
 * @public loaded by name from the worker thread
 */
export function refreshWithFingerprint(path, options) {
    if (!existsSync(path))
        return { result: { snapshots: 0, comparisons: 0 } };
    if (options.link !== false)
        linkInsideOutPeople(path);
    const db = openInsideOutStore(path);
    try {
        const settings = { ...options, minInteractions: options.minInteractions ?? 20, now: options.now ?? Date.now() };
        if (!options.recompare && options.unless && baselineFingerprint(db, settings) === options.unless) {
            return { result: { snapshots: 0, comparisons: 0 }, fingerprint: options.unless };
        }
        const result = refreshEmotionBaselines(db, settings);
        return { result, fingerprint: baselineFingerprint(db, settings) };
    }
    finally {
        db.close();
    }
}
const baselineJobs = new Map();
const fingerprints = new Map();
/**
 * Keep historical aggregation off the Gateway event loop; serialize refreshes per store, and skip
 * one whose inputs have not changed since this process's previous refresh of that store.
 * Aborting skips queued work and terminates a running worker. Its connection closes with the
 * worker, so SQLite rolls back the open batch; committed batches are idempotent and the next refresh resumes.
 */
export function refreshInsideOutBaselinesAsync(path, options = {}, signal) {
    const job = (baselineJobs.get(path) ?? Promise.resolve()).catch(() => { }).then(() => {
        signal?.throwIfAborted();
        if (!existsSync(path))
            return { snapshots: 0, comparisons: 0 };
        const settings = { ...options, now: options.now ?? Date.now(), unless: fingerprints.get(path) };
        return new Promise((resolve, reject) => {
            const worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        // tsx's CLI preload only registers on the main thread. Source-mode
        // development needs explicit registration; compiled installs do not.
        if (workerData.module.endsWith(".ts")) require("node:module").createRequire(workerData.module)("tsx/esm/api").register();
        import(workerData.module).then(({ refreshWithFingerprint }) => {
          parentPort.postMessage(refreshWithFingerprint(workerData.path, workerData.options));
        }).catch(error => { throw error; });
      `, { eval: true, workerData: { module: import.meta.url, path, options: settings } });
            let outcome, aborted = false;
            const abort = () => { aborted = true; void worker.terminate(); };
            signal?.addEventListener("abort", abort, { once: true });
            worker.once("message", (value) => { outcome = value; });
            worker.once("error", reject);
            // Settle only after the worker closes its database and exits.
            worker.once("exit", code => {
                signal?.removeEventListener("abort", abort);
                if (aborted)
                    reject(signal.reason);
                else if (code === 0 && outcome) {
                    if (outcome.fingerprint)
                        fingerprints.set(path, outcome.fingerprint);
                    resolve(outcome.result);
                }
                else
                    reject(new Error(`Inside Out baseline worker exited without a result (code ${code})`));
            });
        });
    }).finally(() => { if (baselineJobs.get(path) === job)
        baselineJobs.delete(path); });
    baselineJobs.set(path, job);
    return job;
}
/** Operator erasure for one person; see purgeEmotionProfile. */
export function purgeInsideOutPerson(path, personId, options = {}) {
    if (!personId.trim())
        throw new Error("A PeopleSQL person ID is required");
    if (!existsSync(path))
        return { baselines: 0, assessments: 0, grades: 0 };
    // Never create Inside Out tables in a store that has none.
    const probe = openMemoryDatabase(path);
    try {
        if (!tableExists(probe, "inside_out"))
            return { baselines: 0, assessments: 0, grades: 0 };
    }
    finally {
        probe.close();
    }
    // Erasing grades must cover replies linked to this person since the last refresh.
    if (options.grades)
        linkInsideOutPeople(path);
    const db = openInsideOutStore(path);
    try {
        return purgeEmotionProfile(db, personId, options);
    }
    finally {
        db.close();
    }
}
