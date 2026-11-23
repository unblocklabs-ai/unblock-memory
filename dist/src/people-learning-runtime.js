import { join, relative, isAbsolute } from "node:path";
import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { listAgentIds, jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentWorkspaceDir, resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { agentStateDir, agentTranscriptDatabase } from "./agent-paths.js";
import { resolveConfig } from "./config.js";
import { PeopleStores as LocalPeopleStores } from "./people-store.js";
import { inventoryPeople, dossierAssertions, privateJson } from "./people-learning-inventory.js";
import { PeopleLearningStore, LEARNING_RECEIPT_SCHEMA } from "./people-learning-store.js";
import { learningForAgent } from "./people-learning-config.js";
import { resolveTimezone } from "./session-projector.js";
import { reconcilePeopleLearning, learningSession, LEARNING_TOOLS } from "./people-learning-cron.js";
import { MEMORY_DATABASE, hasMemoryTable } from "./memory-database.js";
import { resolveSources } from "./sources.js";
import { auditResponses, responseCohort } from "./response-audit.js";
import { ResponseAuditStore } from "./response-store.js";
import { getContext } from "./tool-context.js";
import { record } from "./guards.js";
import { jsonHash } from "./json-hash.js";
import { reviewWindow } from "./people-learning-time.js";
function reviewPaths(cfg, config, agentId, stateRoot) {
    if (!listAgentIds(cfg).includes(agentId))
        throw new Error("Unknown people-learning agent");
    const state = agentStateDir(agentId, stateRoot), root = join(state, "people-learning");
    const workspace = resolveAgentWorkspaceDir(cfg, agentId);
    const sources = resolveSources(workspace, config.corpora.filter(c => c.kind !== "sessions"));
    // Even unusual absolute corpora must not accidentally ingest private review exports.
    for (const source of sources) {
        const path = relative(source.root, root);
        if (path === "" || (!path.startsWith("..") && !isAbsolute(path)))
            throw new Error("People review state overlaps a configured corpus root");
    }
    return { state, root, storePath: join(state, MEMORY_DATABASE),
        databasePath: agentTranscriptDatabase(cfg, agentId), workspace, sources };
}
function beginReview(cfg, config, stores, agentId, kind, stateRoot, day, resumeTimezone) {
    const paths = reviewPaths(cfg, config, agentId, stateRoot);
    const settings = learningForAgent(config.people.learning, agentId);
    const ledger = new PeopleLearningStore(paths.storePath, agentId);
    try {
        const requestedTimezone = resumeTimezone ?? settings.timezone ?? resolveTimezone(cfg.agents?.defaults?.userTimezone);
        const priorWindow = ledger.get(`${kind}:${reviewWindow(Date.now(), requestedTimezone, kind, day).localDay}`)?.manifest.window;
        const manifest = inventoryPeople({ agentId, kind, people: stores.get(agentId), databasePath: paths.databasePath,
            timezone: priorWindow?.timezone ?? requestedTimezone, day: priorWindow?.localDay ?? day,
            exportRoot: join(paths.root, "exports") });
        // Carry the original extension's queue forward without modifying its receipts
        // or pretending its free-form entries have already been resolved.
        const legacyPath = join(paths.workspace, "logs", "people-reflection", "backlog.json");
        if (existsSync(legacyPath)) {
            let legacy;
            try {
                if (statSync(legacyPath).size > 1024 * 1024)
                    throw new Error("Legacy backlog over read budget");
                legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
            }
            catch {
                legacy = { source: legacyPath, unresolved: "Legacy backlog unreadable; inspect original locally" };
            }
            const canonical = (path) => existsSync(path) ? realpathSync(path) : path;
            const workspaceOwners = listAgentIds(cfg).filter(id => canonical(resolveAgentWorkspaceDir(cfg, id)) === canonical(paths.workspace));
            const declaredOwner = record(legacy)?.agentId;
            const owner = declaredOwner === undefined ? (workspaceOwners.length === 1 ? workspaceOwners[0] : undefined)
                : typeof declaredOwner === "string" && workspaceOwners.includes(declaredOwner) ? declaredOwner : undefined;
            if (!owner) {
                manifest.sourceGaps.push({ id: jsonHash(["legacy-owner", legacyPath]), reason: "Legacy backlog in a shared workspace has no exact agentId; establish ownership before import" });
            }
            else if (owner === agentId) {
                const hash = jsonHash(legacy), legacyId = `legacy:${hash}`;
                const legacyFile = privateJson(paths.root, `${hash}.legacy.json`, legacy);
                const previous = ledger.get(legacyId);
                // An import has its own first-seen metadata. An unchanged source must not
                // inherit a different day's window or switch kind on the next review.
                if (!previous)
                    ledger.begin({ ...manifest, id: legacyId, roster: [], assertions: [], sessions: [], fullValidation: true,
                        sourceGaps: [{ id: hash, reason: `Imported legacy review backlog; resume every unfinished entry before resolving: ${legacyFile}` }] });
                if (previous?.status !== "complete" && record(legacy)?.bootstrapRequired === true) {
                    manifest.fullValidation = true;
                    manifest.assertions = manifest.roster.flatMap(person => {
                        const dossier = stores.get(agentId).getDossier(person.personId)?.dossier;
                        return dossier ? dossierAssertions(person.personId, dossier) : [];
                    });
                }
            }
        }
        ledger.planMissedWindows(manifest);
        const run = ledger.begin(manifest);
        const file = privateJson(paths.root, `${jsonHash(run.manifest)}.manifest.json`, run.manifest);
        return { ...run, manifestFile: file, backlog: ledger.backlog() };
    }
    finally {
        ledger.close();
    }
}
function saveErrors(receipt, manifest, stores, agentId) {
    const people = stores.get(agentId), errors = [];
    for (const change of receipt.changes) {
        const saved = people.getDossierChange(change.personId, change.changeId);
        if (!saved || Date.parse(saved.changedAt) < Date.parse(manifest.createdAt))
            errors.push(`Unconfirmed save: ${change.changeId}`);
    }
    for (const assertion of manifest.assertions) {
        const review = receipt.assertionReviews.find(r => r.assertionId === assertion.id);
        if (!review || review.disposition === "unresolved")
            continue;
        const dossier = people.getDossier(assertion.personId)?.dossier;
        const current = dossier ? dossierAssertions(assertion.personId, dossier) : [];
        const retained = current.find(a => a.id === assertion.id);
        if (review.disposition === "revalidated" && !retained)
            errors.push(`Revalidated statement no longer present: ${assertion.id}`);
        if (review.disposition !== "revalidated" && retained)
            errors.push(`Correction/retirement not saved: ${assertion.id}`);
        // The source-verified receipt records this revalidation's actual date.
        // Unchanged claims need not be rewritten or have their original dates renewed.
        if (review.disposition !== "revalidated" && !receipt.changes.some(c => c.personId === assertion.personId &&
            c.changeId === people.getDossierRevision(assertion.personId)))
            errors.push(`Missing current change receipt: ${assertion.id}`);
    }
    // Concurrent additions must be reviewed, not silently excluded from a weekly/ bootstrap run.
    for (const personId of reviewCohort(manifest)) {
        const dossier = people.getDossier(personId)?.dossier;
        if (!dossier)
            continue;
        if (dossierAssertions(personId, dossier).some(a => !manifest.assertions.some(old => old.id === a.id)) &&
            !receipt.changes.some(c => c.personId === personId && c.changeId === people.getDossierRevision(personId)))
            errors.push(`New assertions require current verified save receipts: ${personId}`);
    }
    return errors;
}
function reviewCohort(manifest) {
    return new Set([...manifest.assertions.map(a => a.personId),
        ...manifest.roster.filter(p => manifest.kind === "weekly" && p.sessionIds.length > 0).map(p => p.personId)]);
}
function analysisBasis(config, manifest) {
    return jsonHash([responseCohort(config.responseAudit), config.responseAudit.lookbackDays, manifest]);
}
const STARTUP_RETRY_DELAY_MS = 5_000;
const RETRY_DELAY_MS = 60_000;
const MAX_QUIET_STARTUP_RETRIES = 8;
function isStartupPrepError(error) {
    return /not completed startup inspection and preparation/i.test(String(error));
}
export function registerPeopleLearning(api, initial, stores) {
    let cfg = api.config, config = initial, stateRoot = resolveStateDir(), live = false;
    let jobs = [], reconciliation, followUp;
    let rerun = false, startupRetries = 0;
    let getCron;
    let generation = 0;
    let scheduler;
    let retryTask;
    const clearRetry = () => { retryTask?.cancel?.(); retryTask = undefined; };
    const scheduleRetry = (delayMs) => {
        clearRetry();
        if (!live || !scheduler || scheduler.signal?.aborted)
            return;
        try {
            retryTask = scheduler.schedule({ id: "people-learning-reconcile", delayMs, run: reconcile });
        }
        catch {
            // Host scheduler can close concurrently during gateway shutdown or reload.
        }
    };
    const reconcile = () => {
        if (!live)
            return Promise.resolve();
        if (reconciliation) {
            rerun = true;
            if (!followUp) {
                const next = () => {
                    followUp = undefined;
                    if (!live || !rerun)
                        return;
                    rerun = false;
                    return reconcile();
                };
                followUp = reconciliation.then(next, next);
            }
            return followUp;
        }
        const cron = getCron?.();
        if (!cron) {
            api.logger.warn("unblock-memory people learning incomplete: this host does not expose service getCron; upgrade the host");
            return Promise.resolve();
        }
        rerun = false;
        const version = generation;
        const learning = config.people.enabled && config.people.whisperer.enabled ? config.people.learning
            : { ...config.people.learning, enabled: false, agents: {} };
        reconciliation = reconcilePeopleLearning(cron, cfg, learning, () => live && version === generation)
            .then(result => {
            if (live && version === generation) {
                jobs = result;
                startupRetries = 0;
                clearRetry();
            }
        })
            .catch(error => {
            if (!live || version !== generation)
                return;
            rerun = false;
            if (isStartupPrepError(error) && scheduler && !scheduler.signal?.aborted && startupRetries < MAX_QUIET_STARTUP_RETRIES) {
                startupRetries++;
                if (startupRetries === 1) {
                    api.logger.info?.("unblock-memory people learning scheduling deferred until agent startup preparation completes");
                }
                scheduleRetry(STARTUP_RETRY_DELAY_MS);
                return;
            }
            api.logger.warn(`unblock-memory people learning scheduling incomplete: ${String(error)}`);
            scheduleRetry(RETRY_DELAY_MS);
        })
            .finally(() => { reconciliation = undefined; });
        return reconciliation;
    };
    api.registerService({
        id: "unblock-memory-people-learning",
        reload: { configPrefixes: ["plugins.entries.unblock-memory", "agents"] },
        start(context) {
            cfg = context.config;
            stateRoot = context.stateDir;
            const entry = cfg.plugins?.entries?.["unblock-memory"];
            config = resolveConfig(entry ? entry.config : api.pluginConfig);
            clearRetry();
            live = true;
            generation++;
            startupRetries = 0;
            rerun = false;
            getCron = context.getCron?.bind(context);
            scheduler = context.scheduler;
            void reconcile();
        },
        async stop() {
            live = false;
            const stopVersion = ++generation;
            rerun = false;
            startupRetries = 0;
            clearRetry();
            await reconciliation?.catch(() => { });
            await followUp?.catch(() => { });
            if (stopVersion === generation)
                jobs = [];
        },
    });
    api.on("gateway_start", () => reconcile());
    api.on("cron_reconciled", (_event, context) => {
        if (context.config) {
            const entry = context.config.plugins?.entries?.["unblock-memory"];
            const nextConfig = resolveConfig(entry ? entry.config : api.pluginConfig);
            generation++;
            cfg = context.config;
            config = nextConfig;
        }
        return reconcile();
    });
    // Defense in depth: cron delivery is none AND these review sessions cannot send,
    // spawn another agent, exec, change configuration, or reactivate a person.
    api.on("before_tool_call", (event, context) => {
        const job = learningSession(context.sessionKey, jobs);
        if (!job)
            return;
        if (!config.people.enabled || !config.people.whisperer.enabled || !learningForAgent(config.people.learning, job.agentId).enabled) {
            return { block: true, blockReason: "People learning is disabled for this agent" };
        }
        if (!LEARNING_TOOLS.includes(event.toolName) || (event.toolName === "memory_people_update" &&
            !["replace_dossier", "delete_dossier"].includes(String(record(event.params)?.action)))) {
            return { block: true, blockReason: "Private People Whisperer maintenance permits source reads and dossier curation only" };
        }
        if (event.toolName === "memory_people_update") {
            try {
                const person = stores.get(job.agentId).getPerson(String(record(event.params)?.personId));
                if (!person || person.status !== "active" || !person.injectionEnabled)
                    return { block: true, blockReason: "Inactive/paused people are review-only" };
            }
            catch {
                return { block: true, blockReason: "People source unavailable; preserve unresolved work" };
            }
        }
    });
    const parameters = Type.Union([
        Type.Object({ action: Type.Literal("inventory"), kind: Type.Enum(["nightly", "weekly"]) }, { additionalProperties: false }),
        Type.Object({ action: Type.Literal("inspect"), runId: Type.String() }, { additionalProperties: false }),
        Type.Object({ action: Type.Literal("signals"), runId: Type.String() }, { additionalProperties: false }),
        Type.Object({ action: Type.Literal("checkpoint"), runId: Type.String(), receipt: LEARNING_RECEIPT_SCHEMA }, { additionalProperties: false }),
    ]);
    api.registerTool(ctx => {
        const active = getContext(ctx), job = learningSession(ctx.sessionKey, jobs);
        if (!active || !job || active.agentId !== job.agentId || !config.people.enabled || !config.people.whisperer.enabled ||
            !learningForAgent(config.people.learning, active.agentId).enabled)
            return null;
        return { name: "memory_people_learning", label: "Private People Learning", parameters,
            description: "Inventory full local exchanges and assertion coverage, inspect resumable private backlog, get approved analysis leads, and checkpoint verified review receipts. Scheduled People Whisperer sessions only.",
            async execute(_id, input, signal) {
                const params = Value.Parse(parameters, input);
                if (!live)
                    return jsonResult({ status: "unavailable" });
                if (!config.people.enabled || !config.people.whisperer.enabled || !learningForAgent(config.people.learning, active.agentId).enabled)
                    return jsonResult({ status: "disabled" });
                if (params.action === "inventory")
                    return jsonResult(beginReview(cfg, config, stores, active.agentId, params.kind, stateRoot));
                const paths = reviewPaths(cfg, config, active.agentId, stateRoot);
                if (params.action === "signals") {
                    const analysisConfig = config;
                    if (!config.responseAudit.enabled || !config.typesafe.enabled || !config.responseAudit.intervalMinutes) {
                        let report;
                        if (config.responseAudit.enabled && hasMemoryTable(paths.storePath, "response_results")) {
                            const store = new ResponseAuditStore(paths.storePath);
                            try {
                                report = store.report(responseCohort(config.responseAudit), Date.now() - 8 * 86400_000);
                            }
                            finally {
                                store.close();
                            }
                        }
                        return jsonResult({ status: "not_approved", report, reason: "Automatic external analysis is not enabled; cached leads only" });
                    }
                    const targetLedger = new PeopleLearningStore(paths.storePath, active.agentId);
                    let since, until, basis;
                    try {
                        const target = targetLedger.get(params.runId);
                        if (!target || target.manifest.inventoryPending)
                            throw new Error("Inventory this run before analysis");
                        since = target.manifest.window.since;
                        until = target.manifest.window.until;
                        basis = analysisBasis(analysisConfig, target.manifest);
                    }
                    finally {
                        targetLedger.close();
                    }
                    const audit = await auditResponses({ config: analysisConfig, agentId: active.agentId, ...paths,
                        indexPath: join(paths.state, "index.sqlite"), peoplePath: paths.storePath,
                        sources: paths.sources.filter(s => analysisConfig.responseAudit.memoryCorpora.includes(s.corpus)), signal });
                    const pending = "coverage" in audit ? audit.coverage : undefined;
                    let unresolved = 0;
                    let report;
                    if (hasMemoryTable(paths.storePath, "response_results")) {
                        const store = new ResponseAuditStore(paths.storePath);
                        try {
                            unresolved = store.unresolvedWork(responseCohort(analysisConfig.responseAudit), since, until);
                            report = store.report(responseCohort(analysisConfig.responseAudit), since, undefined, { until, bucket: "day" });
                        }
                        finally {
                            store.close();
                        }
                    }
                    else
                        unresolved++;
                    const analysisStatus = !unresolved && since >= Date.now() - analysisConfig.responseAudit.lookbackDays * 86400_000 && audit.status === "ok" && pending && !pending.failed && !pending.deferredByLimit &&
                        !pending.sessionsOverBudget && !pending.reconciliationDeferred && !pending.sessionLimitReached && !pending.oversized && !pending.stale
                        ? "complete" : "unresolved";
                    const ledger = new PeopleLearningStore(paths.storePath, active.agentId);
                    try {
                        ledger.recordAnalysis(params.runId, analysisStatus, audit, basis);
                    }
                    finally {
                        ledger.close();
                    }
                    return jsonResult({ status: analysisStatus, audit, report, note: "Signals cover only existing approvals and bounded audit work; preserve unassessed/failed analysis as unresolved" });
                }
                const ledger = new PeopleLearningStore(paths.storePath, active.agentId);
                try {
                    if (params.action === "inspect") {
                        const prior = ledger.get(params.runId);
                        if (prior && prior.status !== "complete" && !params.runId.startsWith("legacy:"))
                            beginReview(cfg, config, stores, active.agentId, prior.manifest.kind, stateRoot, prior.manifest.window.localDay, prior.manifest.window.timezone);
                        return jsonResult({ run: ledger.get(params.runId), backlog: ledger.backlog() });
                    }
                    let run = ledger.get(params.runId);
                    if (!run)
                        throw new Error("Unknown review run");
                    // A participant may have acquired a dossier since the inventory.
                    // Expand expectations before accepting a weekly checkpoint.
                    const current = [...reviewCohort(run.manifest)].flatMap(personId => {
                        const dossier = stores.get(active.agentId).getDossier(personId)?.dossier;
                        return dossier ? dossierAssertions(personId, dossier) : [];
                    });
                    run = ledger.begin({ ...run.manifest, assertions: [...new Map([...run.manifest.assertions, ...current].map(a => [a.id, a])).values()] });
                    const people = stores.get(active.agentId);
                    const verificationTargets = [...new Set(run.manifest.assertions.map(a => a.personId))]
                        .filter(personId => people.getDossier(personId))
                        .map(personId => ({ personId, revision: people.getDossierRevision(personId) }));
                    // Validate the merged checkpoint, including saved dispositions from earlier attempts.
                    const coverage = ledger.checkpoint(params.runId, params.receipt, Date.now(), receipt => {
                        const errors = saveErrors(receipt, run.manifest, stores, active.agentId);
                        const approved = config.responseAudit.enabled && config.typesafe.enabled && config.responseAudit.intervalMinutes > 0;
                        const analysis = ledger.analysis(params.runId);
                        if (approved && receipt.analysis.status !== "unresolved" &&
                            (receipt.analysis.status !== "complete" || analysis?.status !== "complete" || analysis.basis !== analysisBasis(config, run.manifest)))
                            errors.push("Approved analysis has not completed for this cohort and inventory; preserve unresolved analysis backlog");
                        if (!approved && receipt.analysis.status !== "not_approved")
                            errors.push("External analysis is not approved; do not invent analysis results");
                        return errors;
                    }, run.manifest.fullValidation ? receiptId => {
                        for (const { personId, revision } of verificationTargets)
                            people.recordDossierVerification(personId, revision, `Complete source validation receipt ${receiptId}`);
                    } : undefined);
                    return jsonResult(coverage);
                }
                finally {
                    ledger.close();
                }
            },
        };
    }, { names: ["memory_people_learning"] });
}
/** Operator CLI keeps raw review output private; no main-agent default. */
export function registerPeopleLearningCli(api, config) {
    api.registerCli(({ program, config: cfg }) => {
        const root = program.command("memory-people-learning").description("Private People Whisperer inventories and durable coverage/backlog");
        root.command("inventory").requiredOption("--agent <id>", "Exact configured agent id")
            .option("--kind <kind>", "nightly or weekly", "nightly").option("--date <date>", "Completed local day YYYY-MM-DD")
            .action((opts) => {
            if (opts.kind !== "nightly" && opts.kind !== "weekly")
                throw new Error("Invalid review kind");
            const stores = new LocalPeopleStores({ maxOpenTodos: config.people.todos.maxOpen, maxBlurbChars: config.people.whisperer.maxChars });
            try {
                console.log(JSON.stringify(beginReview(cfg, config, stores, opts.agent, opts.kind, resolveStateDir(), opts.date), null, 2));
            }
            finally {
                stores.closeAll();
            }
        });
        root.command("status").requiredOption("--agent <id>", "Exact configured agent id")
            .option("--run <id>", "Inspect one review and its latest receipt")
            .action((opts) => {
            const paths = reviewPaths(cfg, config, opts.agent, resolveStateDir());
            const ledger = new PeopleLearningStore(paths.storePath, opts.agent);
            try {
                console.log(JSON.stringify({ backlog: ledger.backlog(), ...(opts.run ? { run: ledger.get(opts.run) } : {}) }, null, 2));
            }
            finally {
                ledger.close();
            }
        });
    }, { descriptors: [{ name: "memory-people-learning", description: "Private people-learning coverage and inventories", hasSubcommands: true }] });
}
