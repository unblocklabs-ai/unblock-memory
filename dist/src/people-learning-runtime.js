import { randomUUID } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { listAgentIds, jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentWorkspaceDir, resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { agentStateDir, agentTranscriptDatabase } from "./agent-paths.js";
import { resolveConfig } from "./config.js";
import { PeopleStores, recordDossierVerificationInTransaction } from "./people-store.js";
import { inventoryPeople, dossierAssertions, privateJson } from "./people-learning-inventory.js";
import { PeopleLearningStore, LEARNING_RECEIPT_SCHEMA, manifestRevision } from "./people-learning-store.js";
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
const LEARNING_PARAMETERS = Type.Union([
    Type.Object({ action: Type.Literal("inventory"), kind: Type.Enum(["nightly", "weekly"]) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("inspect"), runId: Type.String() }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("signals"), runId: Type.String() }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("checkpoint"),
        runId: Type.String(),
        manifestRevision: Type.String({ pattern: "\\S" }),
        receipt: LEARNING_RECEIPT_SCHEMA,
    }, { additionalProperties: false }),
]);
function withLearningStore(storePath, agentId, fn) {
    const ledger = new PeopleLearningStore(storePath, agentId);
    try {
        return fn(ledger);
    }
    finally {
        ledger.close();
    }
}
function resolvePluginConfig(cfg, fallback) {
    const entry = cfg.plugins?.entries?.["unblock-memory"];
    return resolveConfig(entry ? entry.config : fallback);
}
function isLearningEnabled(config, agentId, kind) {
    if (!config.people.enabled || !config.people.whisperer.enabled)
        return false;
    const agent = learningForAgent(config.people.learning, agentId);
    return agent.enabled && (kind === undefined || agent[kind]);
}
function isLearningAuthorized(cfg, config, job) {
    return listAgentIds(cfg).includes(job.agentId) && isLearningEnabled(config, job.agentId, job.kind);
}
function isAnalysisApproved(config) {
    return config.responseAudit.enabled && config.decisionModel.enabled && config.responseAudit.intervalMinutes > 0;
}
function auditCohort(config) {
    return responseCohort(config.responseAudit, config.decisionModel.model, config.decisionModel.endpoint);
}
function publishManifest(root, manifest) {
    return privateJson(root, `${manifestRevision(manifest)}.manifest.json`, manifest);
}
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
    return {
        state, root, storePath: join(state, MEMORY_DATABASE),
        databasePath: agentTranscriptDatabase(cfg, agentId), workspace, sources,
    };
}
function importLegacyBacklog(cfg, stores, ledger, agentId, paths, manifest) {
    // Carry the original extension's queue forward without modifying its receipts
    // or pretending its free-form entries have already been resolved.
    const legacyPath = join(paths.workspace, "logs", "people-reflection", "backlog.json");
    if (!existsSync(legacyPath))
        return;
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
    const canonicalWorkspace = canonical(paths.workspace);
    const workspaceOwners = listAgentIds(cfg).filter(id => canonical(resolveAgentWorkspaceDir(cfg, id)) === canonicalWorkspace);
    const declaredOwner = record(legacy)?.agentId;
    const owner = declaredOwner === undefined ? (workspaceOwners.length === 1 ? workspaceOwners[0] : undefined)
        : typeof declaredOwner === "string" && workspaceOwners.includes(declaredOwner) ? declaredOwner : undefined;
    if (!owner) {
        manifest.sourceGaps.push({
            id: jsonHash(["legacy-owner", legacyPath]),
            reason: "Legacy backlog in a shared workspace has no exact agentId; establish ownership before import",
        });
        return;
    }
    if (owner !== agentId)
        return;
    const hash = jsonHash(legacy), legacyId = `legacy:${hash}`;
    const legacyFile = privateJson(paths.root, `${hash}.legacy.json`, legacy);
    const previous = ledger.get(legacyId);
    // An import has its own first-seen metadata. An unchanged source must not
    // inherit a different day's window or switch kind on the next review.
    if (!previous) {
        ledger.begin({
            ...manifest, id: legacyId, roster: [], assertions: [], sessions: [], fullValidation: true,
            sourceGaps: [{ id: hash, reason: `Imported legacy review backlog; resume every unfinished entry before resolving: ${legacyFile}` }],
        });
    }
    if (previous?.status !== "complete" && record(legacy)?.bootstrapRequired === true) {
        const people = stores.get(agentId);
        manifest.fullValidation = true;
        manifest.assertions = manifest.roster.flatMap(person => {
            const dossier = people.getDossier(person.personId)?.dossier;
            return dossier ? dossierAssertions(person.personId, dossier) : [];
        });
    }
}
function beginReview(cfg, config, stores, agentId, kind, stateRoot, day, resumeTimezone) {
    const paths = reviewPaths(cfg, config, agentId, stateRoot);
    const settings = learningForAgent(config.people.learning, agentId);
    return withLearningStore(paths.storePath, agentId, ledger => {
        const requestedTimezone = resumeTimezone ?? settings.timezone ?? resolveTimezone(cfg.agents?.defaults?.userTimezone);
        const priorWindow = ledger.get(`${kind}:${reviewWindow(Date.now(), requestedTimezone, kind, day).localDay}`)?.manifest.window;
        const manifest = inventoryPeople({
            agentId, kind, people: stores.get(agentId), databasePath: paths.databasePath,
            timezone: priorWindow?.timezone ?? requestedTimezone, day: priorWindow?.localDay ?? day,
            exportRoot: join(paths.root, "exports"),
        });
        importLegacyBacklog(cfg, stores, ledger, agentId, paths, manifest);
        ledger.planMissedWindows(manifest);
        let manifestFile = "";
        const run = ledger.begin(manifest, published => {
            manifestFile = publishManifest(paths.root, published);
        });
        return { ...run, manifestFile, backlog: ledger.backlog() };
    });
}
function saveErrors(receipt, manifest, stores, agentId) {
    const people = stores.get(agentId), errors = [];
    const manifestCreatedAt = Date.parse(manifest.createdAt);
    const changesByPerson = new Map();
    for (const change of receipt.changes) {
        const saved = people.getDossierChange(change.personId, change.changeId);
        if (!saved || Date.parse(saved.changedAt) < manifestCreatedAt)
            errors.push(`Unconfirmed save: ${change.changeId}`);
        let ids = changesByPerson.get(change.personId);
        if (!ids) {
            ids = new Set();
            changesByPerson.set(change.personId, ids);
        }
        ids.add(change.changeId);
    }
    const reviewsById = new Map(receipt.assertionReviews.map(r => [r.assertionId, r]));
    const manifestAssertionIds = new Set(manifest.assertions.map(a => a.id));
    const personState = new Map();
    const currentPersonState = (personId) => {
        let state = personState.get(personId);
        if (!state) {
            const dossier = people.getDossier(personId)?.dossier;
            const assertionIds = new Set(dossier ? dossierAssertions(personId, dossier).map(a => a.id) : []);
            state = { assertionIds, revision: people.getDossierRevision(personId) };
            personState.set(personId, state);
        }
        return state;
    };
    const hasCurrentChange = (personId, revision) => revision !== null && (changesByPerson.get(personId)?.has(revision) ?? false);
    for (const assertion of manifest.assertions) {
        const review = reviewsById.get(assertion.id);
        if (!review || review.disposition === "unresolved")
            continue;
        const { assertionIds, revision } = currentPersonState(assertion.personId);
        const retained = assertionIds.has(assertion.id);
        if (review.disposition === "revalidated" && !retained)
            errors.push(`Revalidated statement no longer present: ${assertion.id}`);
        if (review.disposition !== "revalidated" && retained)
            errors.push(`Correction/retirement not saved: ${assertion.id}`);
        // The source-verified receipt records this revalidation's actual date.
        // Unchanged claims need not be rewritten or have their original dates renewed.
        if (review.disposition !== "revalidated" && !hasCurrentChange(assertion.personId, revision)) {
            errors.push(`Missing current change receipt: ${assertion.id}`);
        }
    }
    // Concurrent additions must be reviewed, not silently excluded from a weekly/ bootstrap run.
    for (const personId of reviewCohort(manifest)) {
        const { assertionIds, revision } = currentPersonState(personId);
        if (!assertionIds.size)
            continue;
        let hasNewAssertion = false;
        for (const id of assertionIds)
            if (!manifestAssertionIds.has(id)) {
                hasNewAssertion = true;
                break;
            }
        if (hasNewAssertion && !hasCurrentChange(personId, revision)) {
            errors.push(`New assertions require current verified save receipts: ${personId}`);
        }
    }
    return errors;
}
function reviewCohort(manifest) {
    return new Set([
        ...manifest.assertions.map(a => a.personId),
        ...manifest.roster.filter(p => manifest.kind === "weekly" && p.sessionIds.length > 0).map(p => p.personId),
    ]);
}
function analysisBasis(config, manifest) {
    return jsonHash([auditCohort(config), config.responseAudit.lookbackDays, manifest]);
}
async function handleSignalsAction(options) {
    const { params, agentId, paths, analysisConfig, analysisGeneration, analysisSequence, instanceId, isCurrent, signal } = options;
    if (!isAnalysisApproved(analysisConfig)) {
        let report;
        if (analysisConfig.responseAudit.enabled && hasMemoryTable(paths.storePath, "response_results")) {
            const store = new ResponseAuditStore(paths.storePath);
            try {
                report = store.report(auditCohort(analysisConfig), Date.now() - 8 * 86400_000);
            }
            finally {
                store.close();
            }
        }
        return jsonResult({ status: "not_approved", report, reason: "Automatic external analysis is not enabled; cached leads only" });
    }
    const startedAt = Date.now();
    const { since, until, basis, expectedManifestRevision } = withLearningStore(paths.storePath, agentId, ledger => {
        const target = ledger.get(params.runId);
        if (!target || target.manifest.inventoryPending)
            throw new Error("Inventory this run before analysis");
        return {
            since: target.manifest.window.since,
            until: target.manifest.window.until,
            basis: analysisBasis(analysisConfig, target.manifest),
            expectedManifestRevision: target.manifestRevision,
        };
    });
    const audit = await auditResponses({
        config: analysisConfig, agentId, ...paths,
        indexPath: join(paths.state, "index.sqlite"), peoplePath: paths.storePath,
        sources: paths.sources.filter(s => analysisConfig.responseAudit.memoryCorpora.includes(s.corpus)), signal,
    });
    const pending = "coverage" in audit ? audit.coverage : undefined;
    let unresolved = 0;
    let report;
    if (hasMemoryTable(paths.storePath, "response_results")) {
        const store = new ResponseAuditStore(paths.storePath);
        try {
            const cohort = auditCohort(analysisConfig);
            unresolved = store.unresolvedWork(cohort, since, until);
            report = store.report(cohort, since, undefined, { until, bucket: "day" });
        }
        finally {
            store.close();
        }
    }
    else
        unresolved++;
    const analysisStatus = !unresolved && since >= Date.now() - analysisConfig.responseAudit.lookbackDays * 86400_000 &&
        audit.status === "ok" && pending && !pending.failed && !pending.deferredByLimit &&
        !pending.sessionsOverBudget && !pending.reconciliationDeferred && !pending.sessionLimitReached && !pending.oversized && !pending.stale
        ? "complete" : "unresolved";
    if (!isCurrent()) {
        return jsonResult({
            status: "unresolved",
            stale: true,
            staleReason: "superseded",
            audit,
            report,
            note: "Analysis configuration or service generation changed while in flight; newer analysis state preserved",
        });
    }
    const recorded = withLearningStore(paths.storePath, agentId, ledger => ledger.recordAnalysis(params.runId, analysisStatus, audit, basis, {
        expectedManifestRevision,
        startedAt,
        generation: analysisGeneration,
        sequence: analysisSequence,
        instanceId,
    }));
    if (!recorded.recorded) {
        return jsonResult({
            status: "unresolved",
            stale: true,
            staleReason: recorded.reason,
            audit,
            report,
            note: "Older or stale in-flight analysis was fenced; newer analysis state preserved",
        });
    }
    return jsonResult({
        status: analysisStatus, audit, report,
        note: "Signals cover only existing approvals and bounded audit work; preserve unassessed/failed analysis as unresolved",
    });
}
function handleInspectAction(options) {
    const { params, cfg, config, stores, agentId, stateRoot, paths } = options;
    return withLearningStore(paths.storePath, agentId, ledger => {
        const prior = ledger.get(params.runId);
        if (prior && prior.status !== "complete" && !params.runId.startsWith("legacy:")) {
            beginReview(cfg, config, stores, agentId, prior.manifest.kind, stateRoot, prior.manifest.window.localDay, prior.manifest.window.timezone);
        }
        const run = ledger.get(params.runId);
        return jsonResult({ run, manifestRevision: run?.manifestRevision, backlog: ledger.backlog() });
    });
}
function handleCheckpointAction(options) {
    const { params, config, stores, agentId, paths } = options;
    const people = stores.get(agentId);
    return withLearningStore(paths.storePath, agentId, ledger => {
        let verificationTargets = [];
        // Validate revision, expand newly acquired dossier assertions (without ever calling
        // ledger.begin() or mutating sessions/roster/sourceGaps), and merge the receipt inside
        // one immediateTransaction; then commit dossier verifications + completion atomically.
        const coverage = ledger.checkpoint(params.runId, params.receipt, Date.now(), (receipt, manifest) => {
            verificationTargets = manifest.fullValidation
                ? [...new Set(manifest.assertions.map(a => a.personId))]
                    .filter(personId => people.getDossier(personId))
                    .map(personId => ({ personId, revision: people.getDossierRevision(personId) }))
                : [];
            const errors = saveErrors(receipt, manifest, stores, agentId);
            const approved = isAnalysisApproved(config);
            const analysis = ledger.analysis(params.runId);
            if (approved && receipt.analysis.status !== "unresolved" &&
                (receipt.analysis.status !== "complete" || analysis?.status !== "complete" || analysis.basis !== analysisBasis(config, manifest))) {
                errors.push("Approved analysis has not completed for this cohort and inventory; preserve unresolved analysis backlog");
            }
            if (!approved && receipt.analysis.status !== "not_approved") {
                errors.push("External analysis is not approved; do not invent analysis results");
            }
            return errors;
        }, (receiptId, db, manifest) => {
            if (!manifest.fullValidation)
                return;
            for (const { personId, revision } of verificationTargets) {
                recordDossierVerificationInTransaction(db, personId, revision, `Complete source validation receipt ${receiptId}`);
            }
        }, params.manifestRevision, {
            collectAssertions: manifest => [...reviewCohort(manifest)].flatMap(personId => {
                const dossier = people.getDossier(personId)?.dossier;
                return dossier ? dossierAssertions(personId, dossier) : [];
            }),
            beforeManifestCommit: published => { publishManifest(paths.root, published); },
            shouldFinalize: manifest => manifest.fullValidation,
        });
        return jsonResult(coverage);
    });
}
const STARTUP_RETRY_DELAY_MS = 5_000;
const RETRY_DELAY_MS = 60_000;
const MAX_QUIET_STARTUP_RETRIES = 8;
function isStartupPrepError(error) {
    return /not completed startup inspection and preparation/i.test(String(error));
}
export function registerPeopleLearning(api, initial, stores) {
    let cfg = api.config, config = initial, stateRoot = resolveStateDir(), live = false;
    // Separate durable cron declaration recognition from current authorization:
    // recognizedJobs persists across transient reconcile/reload failures so private-session
    // hooks keep enforcing tool restrictions, while authorization is checked against live cfg/config.
    let recognizedJobs = [];
    let reconciliation, followUp;
    let rerun = false, startupRetries = 0;
    let getCron;
    let generation = 0;
    let analysisSeq = 0;
    const instanceId = randomUUID();
    let scheduler;
    let retryTask;
    const mergeRecognized = (discovered, replace = false) => {
        const next = new Map(replace ? [] : recognizedJobs.map(j => [`${j.agentId}:${j.id}`, j]));
        for (const job of discovered)
            next.set(`${job.agentId}:${job.id}`, job);
        recognizedJobs = [...next.values()];
    };
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
        rerun = false;
        const version = generation;
        const learning = config.people.enabled && config.people.whisperer.enabled ? config.people.learning
            : {
                ...config.people.learning,
                enabled: false,
                agents: Object.fromEntries(Object.entries(config.people.learning.agents ?? {}).map(([id, agent]) => [id, { ...agent, enabled: false }])),
            };
        reconciliation = Promise.resolve()
            .then(async () => {
            const cron = getCron?.();
            if (!cron) {
                if (live && version === generation) {
                    rerun = false;
                    api.logger.warn("unblock-memory people learning incomplete: this host does not expose service getCron; upgrade the host");
                    scheduleRetry(RETRY_DELAY_MS);
                }
                return;
            }
            await reconcilePeopleLearning(cron, cfg, learning, () => live && version === generation, (discovered, replace) => {
                if (live && version === generation)
                    mergeRecognized(discovered, replace);
            });
            if (live && version === generation) {
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
            config = resolvePluginConfig(cfg, api.pluginConfig);
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
            generation++;
            rerun = false;
            startupRetries = 0;
            clearRetry();
            await reconciliation?.catch(() => { });
            await followUp?.catch(() => { });
            // Do NOT clear recognizedJobs here: on service reload (stop -> start),
            // a transient reconcile failure in start() would otherwise leave
            // before_tool_call failing open. recognizedJobs is only replaced on an
            // authoritative full snapshot from reconcilePeopleLearning.
        },
    });
    api.on("gateway_start", () => reconcile());
    api.on("cron_reconciled", (_event, context) => {
        if (context.config) {
            const nextConfig = resolvePluginConfig(context.config, api.pluginConfig);
            generation++;
            cfg = context.config;
            config = nextConfig;
        }
        return reconcile();
    });
    // Defense in depth: cron delivery is none AND these review sessions cannot send,
    // spawn another agent, exec, change configuration, or reactivate a person.
    api.on("before_tool_call", (event, context) => {
        const job = learningSession(context.sessionKey, recognizedJobs);
        if (!job)
            return;
        if (!isLearningAuthorized(cfg, config, job)) {
            return { block: true, blockReason: "People learning is disabled for this agent" };
        }
        if (!LEARNING_TOOLS.includes(event.toolName) || (event.toolName === "memory_people_update" &&
            !["replace_dossier", "delete_dossier"].includes(String(record(event.params)?.action)))) {
            return { block: true, blockReason: "Private People Whisperer maintenance permits source reads and dossier curation only" };
        }
        if (event.toolName === "memory_people_update") {
            try {
                const person = stores.get(job.agentId).getPerson(String(record(event.params)?.personId));
                if (!person || person.status !== "active" || !person.injectionEnabled) {
                    return { block: true, blockReason: "Inactive/paused people are review-only" };
                }
            }
            catch {
                return { block: true, blockReason: "People source unavailable; preserve unresolved work" };
            }
        }
    });
    api.registerTool(ctx => {
        const active = getContext(ctx), job = learningSession(ctx.sessionKey, recognizedJobs);
        if (!active || !job || active.agentId !== job.agentId || !isLearningAuthorized(cfg, config, job))
            return null;
        return {
            name: "memory_people_learning",
            label: "Private People Learning",
            parameters: LEARNING_PARAMETERS,
            description: "Inventory full local exchanges and assertion coverage, inspect resumable private backlog, get approved analysis leads, and checkpoint verified review receipts. Scheduled People Whisperer sessions only.",
            async execute(_id, input, signal) {
                const params = Value.Parse(LEARNING_PARAMETERS, input);
                if (!live)
                    return jsonResult({ status: "unavailable" });
                if (!isLearningAuthorized(cfg, config, job))
                    return jsonResult({ status: "disabled" });
                if (params.action === "inventory")
                    return jsonResult(beginReview(cfg, config, stores, active.agentId, params.kind, stateRoot));
                const paths = reviewPaths(cfg, config, active.agentId, stateRoot);
                if (params.action === "signals") {
                    const analysisGeneration = generation;
                    return handleSignalsAction({
                        params,
                        agentId: active.agentId,
                        paths,
                        analysisConfig: config,
                        analysisGeneration,
                        analysisSequence: ++analysisSeq,
                        instanceId,
                        isCurrent: () => live && generation === analysisGeneration,
                        signal,
                    });
                }
                if (params.action === "inspect") {
                    return handleInspectAction({ params, cfg, config, stores, agentId: active.agentId, stateRoot, paths });
                }
                return handleCheckpointAction({ params, config, stores, agentId: active.agentId, paths });
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
            const stores = new PeopleStores({ maxOpenTodos: config.people.todos.maxOpen, maxBlurbChars: config.people.whisperer.maxChars });
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
            withLearningStore(paths.storePath, opts.agent, ledger => {
                console.log(JSON.stringify({ backlog: ledger.backlog(), ...(opts.run ? { run: ledger.get(opts.run) } : {}) }, null, 2));
            });
        });
    }, { descriptors: [{ name: "memory-people-learning", description: "Private people-learning coverage and inventories", hasSubcommands: true }] });
}
