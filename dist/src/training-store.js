import { randomUUID } from "node:crypto";
import { immediateTransaction, openMemoryDatabase } from "./memory-database.js";
import { TRAINING_PREPARATION } from "./training-input.js";
import { TRAINING_GATE_MODEL, TRAINING_GATE_THRESHOLD, TRAINING_GATE_VERSION } from "./training-gate.js";
import { TRAINING_RECIPE_VERSION } from "./training-models.js";
import { jsonHash } from "./json-hash.js";
const LEASE_MS = 120_000;
export class TrainingStore {
    #db;
    #owner = randomUUID();
    #nodeId;
    #agentId;
    #requestedModel;
    constructor(path, agentId, requestedModel = TRAINING_GATE_MODEL) {
        this.#db = openMemoryDatabase(path);
        this.#agentId = agentId;
        this.#requestedModel = requestedModel;
        try {
            const version = this.#db.prepare("SELECT version FROM memory_schema WHERE component='training'").get()?.version;
            if (version !== undefined && version !== 1 && version !== 2)
                throw new Error("Unsupported training database version");
            this.#db.exec(`
        CREATE TABLE IF NOT EXISTS training_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), node_id TEXT NOT NULL, agent_id TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS training_lock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL, expires INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS training_inputs (hash TEXT PRIMARY KEY, preparation TEXT NOT NULL, input_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS training_examples (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, event_seq INTEGER NOT NULL, timestamp INTEGER NOT NULL,
          input_hash TEXT NOT NULL REFERENCES training_inputs(hash), context_limited INTEGER NOT NULL,
          active INTEGER NOT NULL, UNIQUE(session_id,event_seq)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS training_gates (
          id TEXT PRIMARY KEY, input_hash TEXT NOT NULL REFERENCES training_inputs(hash),
          prompt_version TEXT NOT NULL, requested_model TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','attempted','complete','failed','ambiguous')),
          probability REAL, actual_model TEXT, input_tokens INTEGER, output_tokens INTEGER,
          error TEXT, completed_at INTEGER,
          UNIQUE(input_hash,prompt_version,requested_model)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS training_attempts (
          id INTEGER PRIMARY KEY, gate_id TEXT NOT NULL REFERENCES training_gates(id),
          started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL,
          error TEXT, result_json TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS training_examples_input ON training_examples(input_hash,active);
        CREATE TABLE IF NOT EXISTS training_steps (
          id TEXT PRIMARY KEY, stage TEXT NOT NULL, request_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','attempted','complete','failed','ambiguous')),
          result_json TEXT, error TEXT, completed_at INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS training_reviews (
          source_id TEXT NOT NULL REFERENCES training_examples(id), scope TEXT NOT NULL DEFAULT '',
          input_hash TEXT NOT NULL, recipe TEXT NOT NULL, reason TEXT NOT NULL,
          details_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(source_id,scope)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS training_step_attempts (
          id INTEGER PRIMARY KEY, step_id TEXT NOT NULL REFERENCES training_steps(id), started_at INTEGER NOT NULL,
          finished_at INTEGER, status TEXT NOT NULL, error TEXT, result_json TEXT
        ) STRICT;
      `);
            if (!this.#db.prepare("SELECT 1 FROM pragma_table_info('training_reviews') WHERE name='scope'").get()) {
                immediateTransaction(this.#db, () => {
                    this.#db.exec(`
            CREATE TABLE training_reviews_v2 (
              source_id TEXT NOT NULL REFERENCES training_examples(id), scope TEXT NOT NULL DEFAULT '',
              input_hash TEXT NOT NULL, recipe TEXT NOT NULL, reason TEXT NOT NULL,
              details_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
              PRIMARY KEY(source_id,scope)
            ) STRICT;
            INSERT INTO training_reviews_v2 (source_id,scope,input_hash,recipe,reason,details_json,updated_at)
              SELECT source_id,CASE WHEN reason='evaluation-unresolved' THEN '__legacy__' ELSE '' END,
                input_hash,recipe,reason,details_json,updated_at FROM training_reviews;
            DROP TABLE training_reviews;
            ALTER TABLE training_reviews_v2 RENAME TO training_reviews;
          `);
                });
            }
            this.#db.exec("INSERT OR REPLACE INTO memory_schema VALUES ('training',2);");
            this.#db.prepare("INSERT OR IGNORE INTO training_identity VALUES (1,?,?)").run(randomUUID(), agentId);
            const identity = this.#db.prepare("SELECT node_id,agent_id FROM training_identity WHERE singleton=1").get();
            if (identity.agent_id !== agentId)
                throw new Error("Training database belongs to a different agent");
            this.#nodeId = String(identity.node_id);
        }
        catch (error) {
            this.#db.close();
            throw error;
        }
    }
    #checkLease() {
        const lease = this.#db.prepare("SELECT owner,expires FROM training_lock WHERE singleton=1").get();
        if (lease?.owner !== this.#owner || Number(lease.expires) <= Date.now())
            throw new Error("Training lease lost; no further API requests permitted");
    }
    async locked(fn) {
        immediateTransaction(this.#db, () => {
            const lock = this.#db.prepare(`INSERT INTO training_lock VALUES (1,?,?) ON CONFLICT(singleton)
        DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE training_lock.expires<=?`)
                .run(this.#owner, Date.now() + LEASE_MS, Date.now());
            if (!lock.changes)
                throw new Error("Another memory-training command is running");
            // A request may have been billed before a crashed process saved the response.
            this.#db.prepare(`UPDATE training_gates SET status='ambiguous',error='interrupted' WHERE status='attempted'
        AND prompt_version=? AND requested_model=? AND input_hash IN (SELECT hash FROM training_inputs WHERE preparation=?)`)
                .run(TRAINING_GATE_VERSION, this.#requestedModel, TRAINING_PREPARATION);
            this.#db.prepare(`UPDATE training_attempts SET status='ambiguous',error='interrupted' WHERE status='attempted'
        AND gate_id IN (SELECT g.id FROM training_gates g JOIN training_inputs i ON i.hash=g.input_hash
          WHERE g.prompt_version=? AND g.requested_model=? AND i.preparation=?)`)
                .run(TRAINING_GATE_VERSION, this.#requestedModel, TRAINING_PREPARATION);
            this.#db.prepare(`UPDATE training_steps SET status='ambiguous',error='interrupted' WHERE status='attempted'
        AND json_extract(request_json,'$.recipe')=?`).run(TRAINING_RECIPE_VERSION);
            this.#db.prepare(`UPDATE training_step_attempts SET status='ambiguous',error='interrupted' WHERE status='attempted'
        AND step_id IN (SELECT id FROM training_steps WHERE json_extract(request_json,'$.recipe')=?)`).run(TRAINING_RECIPE_VERSION);
        });
        let leaseError;
        const heartbeat = setInterval(() => { try {
            this.renew();
        }
        catch (error) {
            leaseError = error;
        } }, 10_000);
        heartbeat.unref();
        try {
            const value = await fn();
            if (leaseError)
                throw leaseError;
            return value;
        }
        finally {
            clearInterval(heartbeat);
            this.#db.prepare("DELETE FROM training_lock WHERE owner=?").run(this.#owner);
        }
    }
    renew() {
        immediateTransaction(this.#db, () => {
            this.#checkLease();
            this.#db.prepare("UPDATE training_lock SET expires=? WHERE owner=?").run(Date.now() + LEASE_MS, this.#owner);
        });
    }
    sessions() { return this.#db.prepare("SELECT DISTINCT session_id FROM training_examples").all().map(r => String(r.session_id)); }
    syncSession(sessionId, examples, since, until, existingOnly) {
        return immediateTransaction(this.#db, () => {
            this.#checkLease();
            const previous = new Map(this.#db.prepare("SELECT event_seq,input_hash,active FROM training_examples WHERE session_id=?").all(sessionId)
                .map(row => [Number(row.event_seq), row]));
            this.#db.prepare("UPDATE training_examples SET active=0 WHERE session_id=?").run(sessionId);
            const counts = { added: 0, changed: 0, unchanged: 0, retired: 0 };
            const retained = new Set();
            const input = this.#db.prepare("INSERT OR IGNORE INTO training_inputs VALUES (?,?,?)");
            const source = this.#db.prepare(`INSERT INTO training_examples VALUES (?,?,?,?,?,?,1)
        ON CONFLICT(session_id,event_seq) DO UPDATE SET timestamp=excluded.timestamp,input_hash=excluded.input_hash,
        context_limited=excluded.context_limited,active=1`);
            const gate = this.#db.prepare(`INSERT OR IGNORE INTO training_gates
        (id,input_hash,prompt_version,requested_model,status) VALUES (?,?,?,?,'pending')`);
            for (const example of examples) {
                const old = previous.get(example.seq);
                if (!old && (existingOnly || example.timestamp < since || example.timestamp >= until))
                    continue;
                retained.add(example.seq);
                input.run(example.inputHash, TRAINING_PREPARATION, JSON.stringify(example.input));
                source.run(jsonHash([this.#nodeId, this.#agentId, sessionId, example.seq]), sessionId, example.seq, example.timestamp, example.inputHash, Number(example.contextLimited));
                const id = jsonHash([example.inputHash, TRAINING_GATE_VERSION, this.#requestedModel]);
                gate.run(id, example.inputHash, TRAINING_GATE_VERSION, this.#requestedModel);
                if (!old)
                    counts.added++;
                else if (old.input_hash !== example.inputHash || old.active !== 1)
                    counts.changed++;
                else
                    counts.unchanged++;
            }
            counts.retired = [...previous].filter(([seq, row]) => row.active === 1 && !retained.has(seq)).length;
            return counts;
        });
    }
    unavailable(sessionId) {
        immediateTransaction(this.#db, () => {
            this.#checkLease();
            this.#db.prepare("UPDATE training_examples SET active=-1 WHERE session_id=? AND active=1").run(sessionId);
        });
    }
    #scope = `g.prompt_version=? AND g.requested_model=? AND EXISTS
    (SELECT 1 FROM training_examples e JOIN training_inputs i ON i.hash=e.input_hash
      WHERE e.input_hash=g.input_hash AND e.active=1 AND i.preparation=?)`;
    pending(limit) {
        return this.#db.prepare(`SELECT g.id,g.input_hash inputHash,i.input_json inputJson
      FROM training_gates g JOIN training_inputs i ON i.hash=g.input_hash
      WHERE ${this.#scope} AND g.status='pending' ORDER BY
      (SELECT MAX(timestamp) FROM training_examples WHERE input_hash=g.input_hash AND active=1) DESC,g.id LIMIT ?`)
            .all(TRAINING_GATE_VERSION, this.#requestedModel, TRAINING_PREPARATION, limit ?? -1);
    }
    start(id) {
        return immediateTransaction(this.#db, () => {
            this.#checkLease();
            if (!this.#db.prepare("UPDATE training_gates SET status='attempted',error=NULL WHERE id=? AND status='pending'").run(id).changes) {
                throw new Error("Training gate is not pending");
            }
            return Number(this.#db.prepare("INSERT INTO training_attempts (gate_id,started_at,status) VALUES (?,?,'attempted')")
                .run(id, Date.now()).lastInsertRowid);
        });
    }
    finish(id, attempt, result) {
        immediateTransaction(this.#db, () => {
            this.#checkLease();
            const ok = "probability" in result;
            const status = ok ? "complete" : result.status, error = ok ? null : result.error;
            const now = Date.now();
            if (!this.#db.prepare(`UPDATE training_gates SET status=?,probability=?,actual_model=?,input_tokens=?,output_tokens=?,error=?,completed_at=? WHERE id=? AND status='attempted'`)
                .run(status, ok ? result.probability : null, ok ? result.model : null, ok ? result.usage.input_tokens : null, ok ? result.usage.output_tokens : null, error, now, id).changes) {
                throw new Error("Training gate attempt lost");
            }
            if (!this.#db.prepare("UPDATE training_attempts SET status=?,finished_at=?,error=?,result_json=? WHERE id=? AND gate_id=? AND status='attempted'")
                .run(status, now, error, ok ? JSON.stringify(result) : null, attempt, id).changes) {
                throw new Error("Training attempt lost");
            }
        });
    }
    retry(includeAmbiguous, ids) {
        if (!ids.length || ids.some(id => !/^[a-f0-9]{64}$/u.test(id)))
            throw new Error("Specify exact training gate or step hashes to retry");
        return immediateTransaction(this.#db, () => {
            this.#checkLease();
            const statuses = includeAmbiguous ? "('failed','ambiguous')" : "('failed')";
            const resetGate = this.#db.prepare(`UPDATE training_gates SET status='pending',error=NULL,completed_at=NULL WHERE id=?
        AND prompt_version=? AND requested_model=? AND status IN ${statuses}
        AND input_hash IN (SELECT hash FROM training_inputs WHERE preparation=?)`);
            const resetStep = this.#db.prepare(`UPDATE training_steps SET status='pending',error=NULL,completed_at=NULL WHERE id=?
        AND json_extract(request_json,'$.recipe')=? AND status IN ${statuses}`);
            return ids.reduce((count, id) => {
                const gates = resetGate.run(id, TRAINING_GATE_VERSION, this.#requestedModel, TRAINING_PREPARATION);
                const steps = resetStep.run(id, TRAINING_RECIPE_VERSION);
                return count + Number(gates.changes) + Number(steps.changes);
            }, 0);
        });
    }
    queryExamples(threshold = TRAINING_GATE_THRESHOLD) {
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
            throw new Error("Threshold must be between 0 and 1");
        return this.#db.prepare(`SELECT e.id,e.input_hash inputHash,i.input_json inputJson,e.session_id sessionId,e.timestamp,
      g.probability recallProbability,g.actual_model recallModel FROM training_examples e JOIN training_inputs i ON i.hash=e.input_hash
      JOIN training_gates g ON g.input_hash=e.input_hash
      WHERE e.active=1 AND i.preparation=? AND g.prompt_version=? AND g.requested_model=?
      AND g.status='complete' AND g.probability>=? ORDER BY e.timestamp DESC,e.id`)
            .all(TRAINING_PREPARATION, TRAINING_GATE_VERSION, this.#requestedModel, threshold);
    }
    step(stage, parameters) {
        const request = { ...parameters, recipe: TRAINING_RECIPE_VERSION };
        const id = jsonHash([stage, request]);
        const row = this.#db.prepare("SELECT status,result_json FROM training_steps WHERE id=? AND stage=?").get(id, stage);
        return { id, stage, request, status: (row?.status ?? "pending"),
            result: row?.status === "complete" ? JSON.parse(String(row.result_json)) : undefined };
    }
    get requestedModel() { return this.#requestedModel; }
    flagReview(example, reason, details, scope = "") {
        immediateTransaction(this.#db, () => {
            this.#checkLease();
            this.#db.prepare(`INSERT INTO training_reviews (source_id,scope,input_hash,recipe,reason,details_json,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(source_id,scope) DO UPDATE SET
        input_hash=excluded.input_hash,recipe=excluded.recipe,reason=excluded.reason,
        details_json=excluded.details_json,updated_at=excluded.updated_at`)
                .run(example.id, scope, example.inputHash, TRAINING_RECIPE_VERSION, reason, JSON.stringify(details), Date.now());
        });
    }
    #clearReviewLocked(sourceId, scope, matchesLegacyUnresolved) {
        if (scope === undefined) {
            this.#db.prepare("DELETE FROM training_reviews WHERE source_id=? AND recipe=?").run(sourceId, TRAINING_RECIPE_VERSION);
            return;
        }
        this.#db.prepare(`DELETE FROM training_reviews WHERE source_id=? AND recipe=?
      AND (scope=? OR (scope='' AND reason!='evaluation-unresolved'))`)
            .run(sourceId, TRAINING_RECIPE_VERSION, scope);
        if (!matchesLegacyUnresolved)
            return;
        const legacyRows = this.#db.prepare(`SELECT scope,details_json details FROM training_reviews
      WHERE source_id=? AND recipe=? AND scope IN ('','__legacy__') AND reason='evaluation-unresolved'`).all(sourceId, TRAINING_RECIPE_VERSION);
        for (const legacy of legacyRows) {
            if (matchesLegacyUnresolved(JSON.parse(String(legacy.details)))) {
                this.#db.prepare(`DELETE FROM training_reviews WHERE source_id=? AND recipe=? AND scope=? AND reason='evaluation-unresolved'`)
                    .run(sourceId, TRAINING_RECIPE_VERSION, String(legacy.scope));
            }
        }
    }
    clearReview(sourceId, scope, matchesLegacyUnresolved) {
        immediateTransaction(this.#db, () => {
            this.#checkLease();
            this.#clearReviewLocked(sourceId, scope, matchesLegacyUnresolved);
        });
    }
    reviews() {
        // Old usefulness-only flags remain in SQLite for audit, but no longer block training.
        return this.#db.prepare(`SELECT r.source_id sourceId,r.scope,r.input_hash inputHash,r.reason,r.details_json details,r.updated_at updatedAt
      FROM training_reviews r JOIN training_examples e ON e.id=r.source_id
      WHERE r.recipe=? AND e.active=1 AND e.input_hash=r.input_hash AND r.reason!='no-useful-evidence'
      ORDER BY r.updated_at DESC,r.source_id,r.scope`)
            .all(TRAINING_RECIPE_VERSION).map(row => ({ sourceId: String(row.sourceId), scope: String(row.scope), inputHash: String(row.inputHash),
            reason: String(row.reason), details: JSON.parse(String(row.details)), updatedAt: Number(row.updatedAt) }));
    }
    startStep(stage, id, request) {
        return immediateTransaction(this.#db, () => {
            this.#checkLease();
            this.#db.prepare("INSERT OR IGNORE INTO training_steps (id,stage,request_json,status) VALUES (?,?,?,'pending')")
                .run(id, stage, JSON.stringify(request));
            if (!this.#db.prepare("UPDATE training_steps SET status='attempted',error=NULL WHERE id=? AND status='pending'").run(id).changes) {
                throw new Error("Training step is not pending");
            }
            return Number(this.#db.prepare("INSERT INTO training_step_attempts (step_id,started_at,status) VALUES (?,?,'attempted')")
                .run(id, Date.now()).lastInsertRowid);
        });
    }
    finishStep(stage, id, attempt, outcome) {
        immediateTransaction(this.#db, () => {
            this.#checkLease();
            const ok = "result" in outcome, status = ok ? "complete" : outcome.status;
            const json = ok ? JSON.stringify(outcome.result) : null, error = ok ? null : outcome.error;
            const now = Date.now();
            if (!this.#db.prepare(`UPDATE training_steps SET status=?,result_json=?,error=?,completed_at=? WHERE id=? AND stage=? AND status='attempted'`)
                .run(status, json, error, now, id, stage).changes)
                throw new Error("Training step attempt lost");
            if (!this.#db.prepare(`UPDATE training_step_attempts SET status=?,finished_at=?,error=?,result_json=? WHERE id=? AND step_id=? AND status='attempted'`)
                .run(status, now, error, json, attempt, id).changes)
                throw new Error("Training attempt lost");
        });
    }
    saveStep(stage, id, request, result, clearReview) {
        immediateTransaction(this.#db, () => {
            this.#checkLease();
            const now = Date.now();
            const json = JSON.stringify(result);
            this.#db.prepare("INSERT OR IGNORE INTO training_steps (id,stage,request_json,status) VALUES (?,?,?,'pending')")
                .run(id, stage, JSON.stringify(request));
            if (!this.#db.prepare("UPDATE training_steps SET status='complete',result_json=?,error=NULL,completed_at=? WHERE id=? AND stage=? AND status='pending'")
                .run(json, now, id, stage).changes) {
                throw new Error("Training step is not pending");
            }
            this.#db.prepare("INSERT INTO training_step_attempts (step_id,started_at,finished_at,status,error,result_json) VALUES (?,?,?,'complete',NULL,?)")
                .run(id, now, now, json);
            if (clearReview) {
                this.#clearReviewLocked(clearReview.sourceId, clearReview.scope, clearReview.matchesLegacyUnresolved);
            }
        });
    }
    completedEvaluations(versions) {
        return this.#db.prepare(`SELECT result_json FROM training_steps WHERE stage='evaluate' AND status='complete'
      AND json_extract(request_json,'$.recipe')=?
      AND (? IS NULL OR (json_extract(request_json,'$.version')=? AND json_extract(request_json,'$.retrievalVersion')=?
        AND json_extract(request_json,'$.judgeVersion')=?)) ORDER BY completed_at DESC,id`)
            .all(TRAINING_RECIPE_VERSION, versions?.selection ?? null, versions?.selection ?? null, versions?.retrieval ?? null, versions?.judge ?? null)
            .map(row => JSON.parse(String(row.result_json)));
    }
    sourceDetails(id) {
        const row = this.#db.prepare(`SELECT session_id sessionId,event_seq userEventId,timestamp,context_limited contextLimited
      FROM training_examples WHERE id=? AND active=1`).get(id);
        if (!row)
            throw new Error("Inactive training source");
        return { nodeId: this.#nodeId, agentId: this.#agentId, sourceId: id, ...row };
    }
    stepRecord(id) {
        const row = this.#db.prepare("SELECT id,stage,request_json,result_json,completed_at FROM training_steps WHERE id=? AND status='complete'").get(id);
        if (!row)
            throw new Error("Missing training provenance checkpoint");
        return { id, stage: row.stage, request: JSON.parse(String(row.request_json)),
            result: JSON.parse(String(row.result_json)), completedAt: row.completed_at };
    }
    stepRecordStatus(id) {
        return this.#db.prepare("SELECT status FROM training_steps WHERE id=? AND json_extract(request_json,'$.recipe')=?")
            .get(id, TRAINING_RECIPE_VERSION)?.status;
    }
    stepScope(id) {
        const row = this.#db.prepare("SELECT stage,status,request_json FROM training_steps WHERE id=? AND json_extract(request_json,'$.recipe')=?")
            .get(id, TRAINING_RECIPE_VERSION);
        if (!row)
            return undefined;
        return {
            stage: String(row.stage),
            status: String(row.status),
            request: JSON.parse(String(row.request_json)),
        };
    }
    status(threshold) {
        const stages = this.#db.prepare(`SELECT g.status,COUNT(*) count FROM training_gates g WHERE ${this.#scope} GROUP BY g.status`)
            .all(TRAINING_GATE_VERSION, this.#requestedModel, TRAINING_PREPARATION);
        const labels = this.#db.prepare(`SELECT COUNT(*) complete,COALESCE(SUM(g.probability>=?),0) positive,
      COALESCE(SUM(g.input_tokens),0) inputTokens,COALESCE(SUM(g.output_tokens),0) outputTokens
      FROM training_gates g WHERE ${this.#scope} AND g.status='complete'`).get(threshold, TRAINING_GATE_VERSION, this.#requestedModel, TRAINING_PREPARATION);
        return { nodeId: this.#nodeId, agentId: this.#agentId, preparation: TRAINING_PREPARATION,
            promptVersion: TRAINING_GATE_VERSION, requestedModel: this.#requestedModel, threshold,
            examples: this.#db.prepare(`SELECT e.active,COUNT(*) count FROM training_examples e
        JOIN training_inputs i ON i.hash=e.input_hash WHERE i.preparation=? GROUP BY e.active`).all(TRAINING_PREPARATION),
            collectedInputs: Number(this.#db.prepare(`SELECT COUNT(DISTINCT e.input_hash) count FROM training_examples e
        JOIN training_inputs i ON i.hash=e.input_hash WHERE e.active=1 AND i.preparation=?`).get(TRAINING_PREPARATION).count),
            queryInputs: Number(labels.positive),
            stages, complete: Number(labels.complete), positive: Number(labels.positive),
            inputTokens: Number(labels.inputTokens), outputTokens: Number(labels.outputTokens),
            negative: Number(labels.complete) - Number(labels.positive),
            recipe: TRAINING_RECIPE_VERSION, reviews: this.reviews(),
            retryable: this.#db.prepare(`SELECT id,stage,status,error FROM training_steps
        WHERE json_extract(request_json,'$.recipe')=? AND status IN ('failed','ambiguous')
        UNION ALL SELECT g.id,'recall',g.status,g.error FROM training_gates g WHERE ${this.#scope}
        AND g.status IN ('failed','ambiguous') ORDER BY stage,id`)
                .all(TRAINING_RECIPE_VERSION, TRAINING_GATE_VERSION, this.#requestedModel, TRAINING_PREPARATION),
            queryStages: this.#db.prepare(`SELECT stage,status,COUNT(*) count FROM training_steps
        WHERE json_extract(request_json,'$.recipe')=? GROUP BY stage,status ORDER BY stage,status`).all(TRAINING_RECIPE_VERSION),
            queryAttempts: this.#db.prepare(`SELECT s.stage,a.status,COUNT(*) count,
        COUNT(json_extract(a.result_json,'$.usage.input_tokens')) usageReported,
        SUM(json_extract(a.result_json,'$.usage.input_tokens')) inputTokens,
        SUM(json_extract(a.result_json,'$.usage.output_tokens')) outputTokens
        FROM training_step_attempts a JOIN training_steps s ON s.id=a.step_id
        WHERE json_extract(s.request_json,'$.recipe')=? GROUP BY s.stage,a.status`).all(TRAINING_RECIPE_VERSION),
            attempts: this.#db.prepare(`SELECT a.status,COUNT(*) count,
        COALESCE(SUM(json_extract(a.result_json,'$.usage.input_tokens')),0) inputTokens,
        COALESCE(SUM(json_extract(a.result_json,'$.usage.output_tokens')),0) outputTokens
        FROM training_attempts a JOIN training_gates g ON g.id=a.gate_id WHERE ${this.#scope} GROUP BY a.status`)
                .all(TRAINING_GATE_VERSION, this.#requestedModel, TRAINING_PREPARATION) };
    }
    *exportRows(threshold) {
        const sourcesQuery = this.#db.prepare(`SELECT id,session_id sessionId,event_seq userEventId,timestamp,context_limited contextLimited
      FROM training_examples WHERE input_hash=? AND active=1 ORDER BY session_id,event_seq`);
        const rows = this.#db.prepare(`SELECT g.*,i.input_json FROM training_gates g JOIN training_inputs i ON i.hash=g.input_hash
      WHERE ${this.#scope} AND g.status='complete' ORDER BY g.id`).iterate(TRAINING_GATE_VERSION, this.#requestedModel, TRAINING_PREPARATION);
        for (const row of rows) {
            yield { stage: "recall-gate", inputHash: row.input_hash, preparation: TRAINING_PREPARATION,
                input: JSON.parse(String(row.input_json)), recallProbability: row.probability,
                recallNeeded: Number(row.probability) >= threshold, threshold, model: row.actual_model,
                requestedModel: this.#requestedModel, promptVersion: row.prompt_version,
                usage: { input_tokens: row.input_tokens, output_tokens: row.output_tokens },
                sources: sourcesQuery.all(String(row.input_hash))
                    .map(source => ({ nodeId: this.#nodeId, agentId: this.#agentId, ...source })) };
        }
    }
    close() { this.#db.close(); }
}
