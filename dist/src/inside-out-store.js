import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { openMemoryDatabase } from "./memory-database.js";
import { PURGED_GRADE, purgeEmotionProfile, refreshEmotionBaselines } from "./emotion-baselines.js";
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
/** Refresh People links without loading transcripts or calling Jev. Known accounts stay exact. Purged grades stay unlinked. */
export function linkInsideOutPeople(path) {
    const db = openInsideOutStore(path);
    try {
        let updated = 0;
        if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='person_identities'").get()) {
            const person = `(${PERSON_MATCH})`;
            updated = Number(db.prepare(`UPDATE inside_out AS e SET person_id=${person}
        WHERE person_id IS NOT ${person} AND error IS NOT ?`).run(PURGED_GRADE).changes);
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
    if (!existsSync(path))
        return { snapshots: 0, comparisons: 0 };
    if (options.link !== false)
        linkInsideOutPeople(path);
    const db = openInsideOutStore(path);
    try {
        return refreshEmotionBaselines(db, { ...options, minInteractions: options.minInteractions ?? 20 });
    }
    finally {
        db.close();
    }
}
const baselineJobs = new Map();
/**
 * Keep historical aggregation off the Gateway event loop; serialize refreshes per store.
 * Aborting skips queued work and terminates a running worker: SQLite rolls back its open
 * batch, committed batches are idempotent, and the next refresh resumes.
 */
export function refreshInsideOutBaselinesAsync(path, options = {}, signal) {
    const settings = { ...options, now: options.now ?? Date.now() };
    const job = (baselineJobs.get(path) ?? Promise.resolve()).catch(() => { }).then(() => {
        signal?.throwIfAborted();
        if (!existsSync(path))
            return { snapshots: 0, comparisons: 0 };
        return new Promise((resolve, reject) => {
            const worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        // tsx's CLI preload only registers on the main thread. Source-mode
        // development needs explicit registration; compiled installs do not.
        if (workerData.module.endsWith(".ts")) require("node:module").createRequire(workerData.module)("tsx/esm/api").register();
        import(workerData.module).then(({ refreshInsideOutBaselines }) => {
          parentPort.postMessage(refreshInsideOutBaselines(workerData.path, workerData.options));
        }).catch(error => { throw error; });
      `, { eval: true, workerData: { module: import.meta.url, path, options: settings } });
            let result, aborted = false;
            const abort = () => { aborted = true; void worker.terminate(); };
            signal?.addEventListener("abort", abort, { once: true });
            worker.once("message", (value) => { result = value; });
            worker.once("error", reject);
            // Settle only after the worker closes its database and exits.
            worker.once("exit", code => {
                signal?.removeEventListener("abort", abort);
                if (aborted)
                    reject(signal.reason);
                else if (code === 0 && result)
                    resolve(result);
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
        if (!probe.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='inside_out'").get())
            return { baselines: 0, assessments: 0, grades: 0 };
    }
    finally {
        probe.close();
    }
    const db = openInsideOutStore(path);
    try {
        return purgeEmotionProfile(db, personId, options);
    }
    finally {
        db.close();
    }
}
