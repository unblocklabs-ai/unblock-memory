import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { agentStateDir, agentTranscriptDatabase } from "./agent-paths.js";
import { resolveDecisionCredential } from "./decision-client.js";
import { runDeepThoughtInvestigation } from "./deep-thought.js";
import { DEFAULTS } from "./defaults.js";
import { EXPECTATION_STATUSES, ExpectationsStore, syncDeterministicExpectations } from "./expectations-store.js";
import { readFleetCommonsEntries, summarizeFleetCommons } from "./fleet-commons.js";
import { buildNodeBriefSnapshot, buildNodeTelemetrySnapshot, formatPrometheusMetrics, pushNodeSnapshot, renderFleetMorningBrief, } from "./fleet-organism.js";
import { CRYSTAL_TIERS, listCrystals, MemoryCrystalsStore, summarizeCrystals } from "./memory-crystals.js";
import { MEMORY_DATABASE } from "./memory-database.js";
import { runOutcomeLedgerPass, summarizeOutcomeMetrics } from "./outcome-ledger.js";
import { responseCohort } from "./response-audit.js";
import { resolveTimezone } from "./session-projector.js";
import { applyApprovedProposal, listSkillProposals, reviewSkillProposal, SKILL_PROPOSAL_KINDS, SKILL_PROPOSAL_STATUSES, SkillProposalError, summarizeSkillProposals, } from "./skill-proposals-store.js";
import { resolveSources } from "./sources.js";
import { listOpenBlockers, runCaptainsLogPass } from "./steward-captains-log.js";
import { CRYSTALS_KIND, runCrystalsPass } from "./steward-crystals.js";
import { resolveExpectationsFromCaptainsLog, runExpectationsPass, } from "./steward-expectations.js";
import { buildPeopleShadowReport, runPeopleShadowPass, PEOPLE_SHADOW_KIND, } from "./steward-people-shadow.js";
import { listShortfallPostmortems, listVoltaireShifts, OVERNIGHT_KIND, overnightLocalParts, runOvernightThinkingPass, summarizeOvernightThinking, withinQuietHours, } from "./steward-overnight.js";
import { runStewardSkillsPass, SKILLS_WORK_KIND, } from "./steward-skills.js";
import { WorkStore } from "./work-store.js";
/* ═════════════════════════ Background semaphore ═════════════════════════ */
const BACKGROUND_SLOTS = Symbol.for("unblock-memory.steward.backgroundSlots");
function slots() {
    const global = globalThis;
    global[BACKGROUND_SLOTS] ??= { active: 0 };
    return global[BACKGROUND_SLOTS];
}
/** Process-wide (all agents, all plugin instances) background Steward slot; returns a one-shot release or undefined at capacity. */
export function tryAcquireBackgroundSlot(maxActive) {
    const state = slots();
    if (state.active >= Math.max(1, maxActive))
        return undefined;
    state.active += 1;
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        state.active = Math.max(0, state.active - 1);
    };
}
export function activeBackgroundStewards() {
    return slots().active;
}
/**
 * After a Captain's Log append: close the workspace/channel expectations its new entries settle (one d1.2 call), then
 * mirror the new blockers. Judging first means fresh blockers are never evaluated against their own capture. Each step
 * is isolated, so a d1.2 hiccup never fails Captain's Log.
 */
async function afterCaptainsLogAppend(options, params) {
    const { store, agentId, result, signal, warn } = params;
    const expectations = options.config.expectations;
    if (result.status !== "appended" || !expectations.enabled)
        return undefined;
    const followUp = {};
    const decisionModel = options.pluginConfig?.decisionModel;
    if (expectations.captainsLogDecisionResolve && decisionModel?.enabled && !signal?.aborted) {
        try {
            followUp.resolution = await resolveExpectationsFromCaptainsLog({
                db: store.db, agentId, decisionModel,
                newEntries: result.entries.map(entry => ({ ...entry, capturedAtMs: result.capturedAtMs })),
                chatTypes: expectations.captainsLogResolveChatTypes,
                minConfidence: expectations.captainsLogResolveMinConfidence,
                timeoutMs: expectations.captainsLogResolveTimeoutMs,
                ...(signal ? { signal } : {}),
                ...(options.captainsLogDecide ? { decide: options.captainsLogDecide } : {}),
            });
        }
        catch (error) {
            if (!signal?.aborted)
                warn(`unblock-memory steward captains-log expectations check (${agentId}): ${String(error)}`);
        }
    }
    if (signal?.aborted)
        return followUp;
    try {
        syncDeterministicExpectations(store.db, agentId, Date.now(), { blockerAutoExpireMinutes: expectations.blockerAutoExpireMinutes });
    }
    catch (error) {
        warn(`unblock-memory steward captains-log expectations sync (${agentId}): ${String(error)}`);
    }
    return followUp;
}
/** One Expectations pass, shared by the background tick and `memory-steward expectations --run`. */
function expectationsPassOptions(config, base, runner, databasePath) {
    return {
        ...base,
        intervalMinutes: config.intervalMinutes,
        lookbackMinutes: config.lookbackMinutes,
        dueLeadMinutes: config.dueLeadMinutes,
        sweepAfterMinutes: config.sweepAfterMinutes,
        maxSessionsPerRun: config.maxSessionsPerRun,
        maxCharsPerSession: config.maxCharsPerSession,
        maxSweepItems: config.maxSweepItems,
        timeoutMs: config.timeoutMs,
        excludeChatTypes: config.excludeChatTypes,
        workspaceSweepChatTypes: config.workspaceSweepChatTypes,
        extract: config.extract,
        sweep: config.sweep,
        blockerAutoExpireMinutes: config.blockerAutoExpireMinutes,
        // Without a runner the pass is deterministic-only and never reads transcripts.
        ...(runner ? { runner, databasePath: databasePath() } : {}),
    };
}
/** One Captain's Log pass, shared by the background tick and the `captains-log` CLI. */
function captainsLogPassOptions(config, base, pluginConfig) {
    return {
        ...base,
        intervalMinutes: config.intervalMinutes,
        lookbackMinutes: config.lookbackMinutes,
        maxSessionsPerRun: config.maxSessionsPerRun,
        maxCharsPerSession: config.maxCharsPerSession,
        maxExistingLogChars: config.maxExistingLogChars,
        timeoutMs: config.timeoutMs,
        excludeChatTypes: config.excludeChatTypes,
        // Emotional-salience tuning.
        includeEmotionalSalience: config.includeEmotionalSalience,
        minSalienceScore: config.minSalienceScore,
        minAbsoluteIntensity: config.minAbsoluteIntensity,
        minRelativeIntensity: config.minRelativeIntensity,
        ...(pluginConfig ? { baselineMinInteractions: pluginConfig.insideOut.baselineMinInteractions } : {}),
    };
}
/** Analysis adapter over one agent's memory manager. `recluster` is offered only with a configured analysis worker. */
function crystalsAnalysis(manager, analysisExecutable) {
    return {
        listClusters: limit => manager.listClusters(limit),
        fetchCluster: ({ clusterId, memberLimit, sort, offset }) => manager.fetchCluster({
            clusterId, ...(memberLimit !== undefined ? { topK: memberLimit } : {}), ...(sort ? { sort } : {}),
            ...(offset !== undefined ? { offset } : {}),
        }),
        ...(analysisExecutable ? { recluster: (signal) => manager.recluster(undefined, signal) } : {}),
    };
}
/** One Crystals pass, shared by the background tick and `memory-steward crystals --run`. */
function crystalsPassOptions(config, base, runner, manager, analysisExecutable, pluginConfig) {
    return {
        ...base,
        analysis: crystalsAnalysis(manager, analysisExecutable),
        corpusForCollection: collection => manager.corpusForCollection(collection),
        intervalMinutes: config.intervalMinutes,
        reclusterMinIntervalMinutes: config.reclusterMinIntervalMinutes,
        // Without a runner nothing can be synthesized, so never pay for a recluster; decay and promotion still run.
        autoRecluster: config.autoRecluster && runner !== undefined,
        minClusterSize: config.minClusterSize,
        maxClustersPerRun: config.maxClustersPerRun,
        maxMembersPerCluster: config.maxMembersPerCluster,
        stmStaleAfterMinutes: config.stmStaleAfterMinutes,
        ltmPromoteMinHelped: config.ltmPromoteMinHelped,
        ltmPromoteMinHits: config.ltmPromoteMinHits,
        allowedCorpora: config.allowedCorpora,
        timeoutMs: config.timeoutMs,
        prioritizeEmotionalSalience: config.prioritizeEmotionalSalience,
        ...(pluginConfig ? { baselineMinInteractions: pluginConfig.insideOut.baselineMinInteractions } : {}),
        ...(runner ? { runner } : {}),
    };
}
/** `deep_thought` cites `qmd://<collection>/<path>`; Overnight anchors want the trusted corpus name too. */
function overnightCitation(citation, manager) {
    const collection = /^qmd:\/\/([^/]+)\//u.exec(citation.source)?.[1];
    const corpus = collection ? manager.corpusForCollection(collection) : undefined;
    return { ...citation, ...(corpus ? { corpus } : {}) };
}
/**
 * Fresh (cache-bypassing) headless `deep_thought` under the candidate's own audience and corpora. It never saves or
 * supersedes a `derived_observations` row itself (`skipSave`): the Overnight pass commits the verified answer inside
 * the same fenced transaction as any Voltaire shift, so a lost fence leaves the prior conclusion untouched.
 */
function overnightInvestigate(deps, cfg, agentId, manager) {
    return async ({ question, corpora, audienceKey, signal }) => {
        const outcome = await runDeepThoughtInvestigation(deps, { cfg, agentId, question, audienceKey, corpora, skipSave: true,
            ...(signal ? { signal } : {}) });
        return {
            status: outcome.status,
            ...(outcome.answer !== undefined ? { answer: outcome.answer } : {}),
            ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
            citations: outcome.citations.map(citation => overnightCitation(citation, manager)),
            openQuestions: outcome.openQuestions,
            ...(outcome.unverifiedCitationsDropped !== undefined ? { unverifiedCitationsDropped: outcome.unverifiedCitationsDropped } : {}),
            ...(outcome.collectionGenerations ? { collectionGenerations: outcome.collectionGenerations } : {}),
            ...(outcome.derivedObservationId ? { derivedObservationId: outcome.derivedObservationId } : {}),
        };
    };
}
/** True when a scheduled run-mode item is claimable now: absent, due, or holding an expired lease. */
function workDue(store, kind, scope, nowMs = Date.now()) {
    const item = store.get(kind, scope);
    if (!item)
        return true;
    if (item.status === "running")
        return item.leaseUntil <= nowMs;
    return (item.status === "pending" || item.status === "staged") && item.dueAt <= nowMs;
}
/** A not-due Crystals tick, reported without ever starting the agent's memory manager. */
function crystalsNotDue(store, agentId) {
    const item = store.get(CRYSTALS_KIND, agentId);
    return { status: item?.status === "running" ? "already_running" : "not_due", created: 0, revised: 0, skippedUnchanged: 0,
        skippedAudience: 0, promoted: 0, retired: 0, synthesized: 0, reclustered: false, errors: [],
        ...(item ? { nextDueAt: item.dueAt } : {}) };
}
/** One Overnight Thinking pass, shared by the background tick and `memory-steward overnight --run`. */
function overnightPassOptions(config, base, runner, memory, workspaceDir) {
    const { manager, deepThought, cfg } = memory ?? {};
    return {
        ...base,
        runner,
        intervalMinutes: config.intervalMinutes,
        ...(config.quietHoursStartHour !== undefined ? { quietHoursStartHour: config.quietHoursStartHour } : {}),
        ...(config.quietHoursEndHour !== undefined ? { quietHoursEndHour: config.quietHoursEndHour } : {}),
        voltaireEnabled: config.voltaireEnabled,
        postmortemsEnabled: config.postmortemsEnabled,
        preAnswerEnabled: config.preAnswerEnabled,
        lookbackDays: config.lookbackDays,
        minRecurrence: config.minRecurrence,
        lookaheadMinutes: config.lookaheadMinutes,
        maxVoltairePerRun: config.maxVoltairePerRun,
        maxPostmortemsPerRun: config.maxPostmortemsPerRun,
        maxPreAnswersPerRun: config.maxPreAnswersPerRun,
        minConfidence: config.minConfidence,
        recallChatTypes: config.recallChatTypes,
        saveDerivedObservations: config.saveDerivedObservations,
        dailyLogChatTypes: config.dailyLogChatTypes,
        dailyLogCorpora: config.dailyLogCorpora,
        timeoutMs: config.timeoutMs,
        // Shifts anchor through the default writer: Memory Crystals' shared `recordCoreMemory` on its `core_memories` table.
        ...(manager ? { getCollectionGenerations: (corpora) => manager.getCollectionGenerations(corpora) } : {}),
        ...(manager && deepThought && cfg ? { investigate: overnightInvestigate(deepThought, cfg, base.agentId, manager) } : {}),
        ...(config.writeDailyLogNotes ? { dailyLogDir: join(workspaceDir(), "memory") } : {}),
    };
}
/** A not-due Skills tick, reported without ever listing the agent's skill catalog. */
function skillsNotDue(store, agentId) {
    const item = store.get(SKILLS_WORK_KIND, agentId);
    return { status: item?.status === "running" ? "already_running" : "not_due", descriptionUpdates: 0, pitfallPatches: 0, newSkills: 0,
        modelCalls: 0, replayJudgments: 0, proposals: [], rejected: [], errors: [], ...(item ? { nextDueAt: item.dueAt } : {}) };
}
/**
 * The production `scoreSkillCatalog` replay credential: the plugin's own `decisionModel` (endpoint, model, key). Undefined
 * (decisionModel disabled, or no key) makes the pass record `replay_unavailable` and skip description updates only.
 */
async function skillReplayDecision(pluginConfig) {
    const decision = pluginConfig?.decisionModel;
    if (!decision?.enabled)
        return undefined;
    const apiKey = await resolveDecisionCredential(decision).catch(() => undefined);
    return apiKey ? { apiKey, endpoint: decision.endpoint, model: decision.model } : undefined;
}
/** One Skills pass, shared by the background tick and `memory-steward skills --run`. */
function skillsPassOptions(config, base, runner, catalog, decision, allowedSkillSources) {
    const { enabled: _enabled, ...tuning } = config;
    return { ...base, ...tuning, runner, catalog, ...(decision ? { decision } : {}), ...(allowedSkillSources ? { allowedSkillSources } : {}) };
}
/**
 * The skills-corpus admission check shared by the background tick, `skills --run` and `skill-apply`: never draft or land
 * a proposal without a configured skills corpus. No plugin config (embedded/test hosts) leaves the pass unconfined.
 */
const skillsCorpusConfigured = (pluginConfig) => !pluginConfig || pluginConfig.corpora.some(corpus => corpus.kind === "skills");
/** Configured skills sources (root + glob) for one agent: the only places `skill-apply` may write a `SKILL.md`. */
function skillSources(pluginConfig, workspaceDir) {
    if (!pluginConfig)
        return undefined;
    const skillCorpora = pluginConfig.corpora.filter(corpus => corpus.kind === "skills");
    return resolveSources(workspaceDir, skillCorpora).map(({ root, pattern }) => ({ root, pattern }));
}
class StewardShutdownError extends Error {
    name = "StewardShutdownError";
    constructor() { super("gateway stopping"); }
}
export function registerStewardRuntime(api, options) {
    const dbPathForAgent = options.dbPathForAgent ?? ((agentId) => join(agentStateDir(agentId), MEMORY_DATABASE));
    const transcriptDbForAgent = options.transcriptDbForAgent ?? agentTranscriptDatabase;
    const workspaceDirForAgent = options.workspaceDirForAgent ?? resolveAgentWorkspaceDir;
    const listAgents = options.listAgents ?? listAgentIds;
    const openWorkStore = options.openWorkStore ?? ((dbPath) => new WorkStore(dbPath));
    registerStewardCli(api, options, dbPathForAgent, openWorkStore, transcriptDbForAgent, workspaceDirForAgent);
    const owner = `steward:${process.pid}:${randomUUID()}`;
    const openStores = new Set();
    let lifetime = new AbortController();
    let timer;
    let running;
    const lastResults = new Map();
    const lastCaptainsLogResults = new Map();
    const lastOutcomeLedgerResults = new Map();
    const lastExpectationsResults = new Map();
    const lastCaptainsLogResolutions = new Map();
    const lastCrystalsResults = new Map();
    const lastOvernightResults = new Map();
    const lastSkillsResults = new Map();
    const outcomeLedger = options.config.outcomeLedger;
    const expectations = options.config.expectations;
    const crystals = options.config.crystals;
    const overnight = options.config.overnight;
    const skills = options.config.skills;
    // Never draft proposals that no `skill-apply` could ever land: without a skills corpus there is no allowed root.
    const skillsCorpusReady = skillsCorpusConfigured(options.pluginConfig);
    // Same cohort Response Audit writes, so outcomes never mix verdicts from another judge configuration.
    const outcomeCohort = options.pluginConfig?.responseAudit.enabled
        ? responseCohort(options.pluginConfig.responseAudit, options.pluginConfig.decisionModel.model, options.pluginConfig.decisionModel.endpoint)
        : undefined;
    const tick = () => {
        if (running)
            return running;
        const { signal } = lifetime;
        if (signal.aborted)
            return Promise.resolve();
        const release = tryAcquireBackgroundSlot(options.config.maxActiveBackground);
        if (!release)
            return Promise.resolve(); // Another agent/instance holds the gateway's background slot.
        running = (async () => {
            let agents;
            let runner;
            try {
                runner = options.createRunner();
            }
            catch (error) {
                // The Outcome Ledger and Expectations ingestion need no model; keep closing the loop without a runner.
                if (!signal.aborted)
                    api.logger.warn(`unblock-memory steward: ${String(error)}`);
            }
            try {
                agents = runner || outcomeLedger.enabled || expectations.enabled || (crystals.enabled && options.memory?.())
                    ? listAgents(api.config) : [];
            }
            catch (error) {
                // `void tick()` must never surface an unhandled rejection.
                if (!signal.aborted)
                    api.logger.warn(`unblock-memory steward: ${String(error)}`);
                return;
            }
            const inventoryContext = options.pluginConfig
                ? { cfg: api.config, config: options.pluginConfig }
                : undefined;
            const timezone = resolveTimezone(api.config?.agents?.defaults?.userTimezone?.trim());
            for (const agentId of agents) {
                if (signal.aborted)
                    break;
                let store;
                try {
                    const dbPath = dbPathForAgent(agentId);
                    store = openWorkStore(dbPath);
                    openStores.add(store);
                    if (outcomeLedger.enabled) {
                        try {
                            lastOutcomeLedgerResults.set(agentId, await runOutcomeLedgerPass({
                                agentId, owner, workStore: store, signal,
                                intervalMinutes: outcomeLedger.intervalMinutes,
                                lookbackMs: outcomeLedger.lookbackMs,
                                maxRowsPerPass: outcomeLedger.maxRowsPerPass,
                                matchWindowMs: outcomeLedger.matchWindowMs,
                                retentionDays: outcomeLedger.retentionDays,
                                ...(outcomeLedger.lateEvidenceRescanMs === undefined ? {} : { lateEvidenceRescanMs: outcomeLedger.lateEvidenceRescanMs }),
                                ...(options.pluginConfig ? { baselineMinInteractions: options.pluginConfig.insideOut.baselineMinInteractions } : {}),
                                ...(outcomeCohort ? { responseCohort: outcomeCohort } : {}),
                            }));
                        }
                        catch (error) {
                            // Isolated: a ledger fault must not skip this agent's model-backed passes.
                            if (!signal.aborted)
                                api.logger.warn(`unblock-memory steward outcome ledger (${agentId}): ${String(error)}`);
                        }
                    }
                    if (expectations.enabled && !signal.aborted) {
                        try {
                            // Runs without a runner too: Captain's Log blockers + people todos are mirrored at zero model cost.
                            lastExpectationsResults.set(agentId, await runExpectationsPass(expectationsPassOptions(expectations, { agentId, workStore: store, owner, timezone, signal, syntheticInput: options.pluginConfig?.syntheticInput }, runner, () => transcriptDbForAgent(api.config, agentId))));
                        }
                        catch (error) {
                            // Isolated: an Expectations fault must not skip this agent's People / Captain's Log passes.
                            if (!signal.aborted)
                                api.logger.warn(`unblock-memory steward expectations (${agentId}): ${String(error)}`);
                        }
                    }
                    if (options.config.peopleShadow.enabled && runner && !signal.aborted) {
                        lastResults.set(agentId, await runPeopleShadowPass({
                            mode: options.config.peopleShadow.mode,
                            ...(inventoryContext ? { inventoryContext } : {}),
                            minConfidence: options.config.peopleShadow.minConfidence,
                            maxHandles: options.config.peopleShadow.maxHandles,
                            maxExcerptChars: options.config.peopleShadow.maxExcerptChars,
                            maxExportBytes: options.config.peopleShadow.maxExportBytes,
                            ...(options.config.peopleShadow.includeInteractionLearning === undefined ? {}
                                : { includeInteractionLearning: options.config.peopleShadow.includeInteractionLearning }),
                            maxNewClaimsPerPerson: options.config.peopleShadow.maxNewClaimsPerPerson,
                            maxInteractionHandles: options.config.peopleShadow.maxInteractionHandles,
                            includeResponseAudit: options.config.peopleShadow.includeResponseAudit,
                            dbPath, agentId, workStore: store, runner, owner, signal,
                            maxItems: options.config.peopleShadow.maxItemsPerRun, timeoutMs: options.config.peopleShadow.timeoutMs,
                        }));
                    }
                    if (options.config.captainsLog.enabled && runner && !signal.aborted) {
                        const captainsLog = await runCaptainsLogPass(captainsLogPassOptions(options.config.captainsLog, {
                            agentId,
                            syntheticInput: options.pluginConfig?.syntheticInput,
                            databasePath: transcriptDbForAgent(api.config, agentId),
                            workspaceDir: workspaceDirForAgent(api.config, agentId),
                            workStore: store,
                            runner,
                            owner,
                            timezone,
                            signal,
                        }, options.pluginConfig));
                        lastCaptainsLogResults.set(agentId, captainsLog);
                        const followUp = await afterCaptainsLogAppend(options, { store, agentId, result: captainsLog, signal,
                            warn: message => api.logger.warn(message) });
                        if (followUp?.resolution)
                            lastCaptainsLogResolutions.set(agentId, followUp.resolution);
                    }
                    const memory = crystals.enabled || overnight.enabled || skills.enabled ? options.memory?.() : undefined;
                    if (crystals.enabled && memory && !signal.aborted) {
                        try {
                            // Never cold-start the agent's QMD manager on a tick where the pass is not due.
                            if (!workDue(store, CRYSTALS_KIND, agentId)) {
                                lastCrystalsResults.set(agentId, crystalsNotDue(store, agentId));
                            }
                            else {
                                // Decay and LTM promotion need no model; synthesis needs the runner.
                                const { manager, error } = await memory.getMemorySearchManager({ cfg: api.config, agentId });
                                if (!manager)
                                    throw new Error(error ?? "memory manager unavailable");
                                lastCrystalsResults.set(agentId, await runCrystalsPass(crystalsPassOptions(crystals, { agentId, workStore: store, owner, signal }, runner, manager, memory.analysisExecutable === true, options.pluginConfig)));
                            }
                        }
                        catch (error) {
                            // Isolated: a Crystals fault must not skip this agent's Overnight pass.
                            if (!signal.aborted)
                                api.logger.warn(`unblock-memory steward crystals (${agentId}): ${String(error)}`);
                        }
                    }
                    if (overnight.enabled && runner && !signal.aborted) {
                        try {
                            let manager = null;
                            // The index is only needed for investigations: never start a manager just for post-mortems, nor on a
                            // tick where the pass is not due or falls outside its quiet hours (the pass then reports that itself).
                            const quiet = withinQuietHours(overnightLocalParts(Date.now(), timezone).hour, overnight.quietHoursStartHour, overnight.quietHoursEndHour);
                            if (memory?.deepThought && (overnight.voltaireEnabled || overnight.preAnswerEnabled) && quiet &&
                                workDue(store, OVERNIGHT_KIND, agentId)) {
                                try {
                                    manager = (await memory.getMemorySearchManager({ cfg: api.config, agentId })).manager;
                                }
                                catch {
                                    manager = null;
                                } // Post-mortems still run; Voltaire/pre-answering need the index.
                            }
                            const deepThought = manager ? memory?.deepThought?.(agentId, api.config) : undefined;
                            lastOvernightResults.set(agentId, await runOvernightThinkingPass(overnightPassOptions(overnight, { agentId, workStore: store, owner, timezone, signal, syntheticInput: options.pluginConfig?.syntheticInput }, runner, manager ? { manager, cfg: api.config, ...(deepThought ? { deepThought } : {}) } : undefined, () => workspaceDirForAgent(api.config, agentId))));
                        }
                        catch (error) {
                            if (!signal.aborted)
                                api.logger.warn(`unblock-memory steward overnight (${agentId}): ${String(error)}`);
                        }
                    }
                    if (skills.enabled && skillsCorpusReady && runner && memory?.skillCatalog && !signal.aborted) {
                        try {
                            // Review-only: drafts `pending` skill_proposals, never a live SKILL.md. Not due = never list the catalog.
                            if (!workDue(store, SKILLS_WORK_KIND, agentId)) {
                                lastSkillsResults.set(agentId, skillsNotDue(store, agentId));
                            }
                            else {
                                const catalog = await memory.skillCatalog({ cfg: api.config, agentId });
                                const decision = await skillReplayDecision(options.pluginConfig);
                                const sources = skillSources(options.pluginConfig, workspaceDirForAgent(api.config, agentId));
                                lastSkillsResults.set(agentId, await runStewardSkillsPass(skillsPassOptions(skills, { agentId, workStore: store, owner, signal }, runner, catalog, decision, sources)));
                            }
                        }
                        catch (error) {
                            if (!signal.aborted)
                                api.logger.warn(`unblock-memory steward skills (${agentId}): ${String(error)}`);
                        }
                    }
                }
                catch (error) {
                    if (!signal.aborted)
                        api.logger.warn(`unblock-memory steward (${agentId}): ${String(error)}`);
                }
                finally {
                    if (store) {
                        openStores.delete(store);
                        try {
                            store.close();
                        }
                        catch { }
                    }
                }
            }
        })().finally(() => { release(); running = undefined; });
        return running;
    };
    const stop = async () => {
        if (timer) {
            clearInterval(timer);
            timer = undefined;
        }
        // Abort in-flight work and release leases in one synchronous step, so a graceful stop adds 0 strikes even if
        // the process exits mid-await. interruptOwner waits at most 200ms on a held lock (the lease then expires).
        lifetime.abort(new StewardShutdownError());
        for (const store of openStores) {
            try {
                store.interruptOwner(owner);
            }
            catch { }
        }
        const pending = running;
        if (!pending)
            return;
        let graceTimer;
        await Promise.race([
            pending.catch(() => undefined),
            new Promise(resolve => { graceTimer = setTimeout(resolve, options.shutdownGraceMs ?? DEFAULTS.steward.shutdownGraceMs); graceTimer.unref?.(); }),
        ]);
        if (graceTimer)
            clearTimeout(graceTimer);
    };
    const enabled = api.registrationMode !== "cli-metadata" && options.config.enabled &&
        (options.config.peopleShadow.enabled || options.config.captainsLog.enabled || outcomeLedger.enabled || expectations.enabled ||
            crystals.enabled || overnight.enabled || skills.enabled);
    if (enabled) {
        api.on("gateway_start", () => {
            if (timer)
                clearInterval(timer);
            if (lifetime.signal.aborted)
                lifetime = new AbortController();
            const intervals = [];
            if (options.config.peopleShadow.enabled)
                intervals.push(options.config.peopleShadow.intervalMinutes);
            if (options.config.captainsLog.enabled)
                intervals.push(options.config.captainsLog.intervalMinutes);
            if (outcomeLedger.enabled)
                intervals.push(outcomeLedger.intervalMinutes);
            if (expectations.enabled)
                intervals.push(expectations.intervalMinutes);
            if (crystals.enabled)
                intervals.push(crystals.intervalMinutes);
            if (overnight.enabled)
                intervals.push(overnight.intervalMinutes);
            if (skills.enabled)
                intervals.push(skills.intervalMinutes);
            const intervalMs = Math.max(1, Math.min(...intervals)) * 60_000;
            timer = setInterval(() => { void tick(); }, intervalMs);
            timer.unref();
            void tick();
        });
        api.on("gateway_stop", stop);
    }
    return {
        owner,
        tick,
        stop,
        lastResults: () => new Map(lastResults),
        lastCaptainsLogResults: () => new Map(lastCaptainsLogResults),
        lastOutcomeLedgerResults: () => new Map(lastOutcomeLedgerResults),
        lastExpectationsResults: () => new Map(lastExpectationsResults),
        lastCaptainsLogResolutions: () => new Map(lastCaptainsLogResolutions),
        lastCrystalsResults: () => new Map(lastCrystalsResults),
        lastOvernightResults: () => new Map(lastOvernightResults),
        lastSkillsResults: () => new Map(lastSkillsResults),
        enabled,
    };
}
/* ═════════════════════════ CLI ═════════════════════════ */
function summarize(items) {
    const byKind = {};
    for (const item of items) {
        byKind[item.kind] ??= {};
        byKind[item.kind][item.status] = (byKind[item.kind][item.status] ?? 0) + 1;
    }
    return byKind;
}
function registerStewardCli(api, options, dbPathForAgent, openWorkStore, transcriptDbForAgent, workspaceDirForAgent) {
    const knownAgent = (cfg, agentId) => {
        if (!(options.listAgents ?? listAgentIds)(cfg).includes(agentId))
            throw new Error("Unknown steward agent");
        return dbPathForAgent(agentId);
    };
    const withStore = (dbPath, fn) => {
        const store = openWorkStore(dbPath);
        try {
            return fn(store);
        }
        finally {
            store.close();
        }
    };
    /**
     * Reporting never creates or migrates the database. An absent file reads as an empty in-memory
     * database; readers already treat missing tables as empty.
     */
    const withReadOnlyDb = (dbPath, fn) => {
        const db = existsSync(dbPath) ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(":memory:");
        try {
            db.exec(`PRAGMA busy_timeout=${DEFAULTS.sqlite.mainBusyTimeoutMs}`);
            return fn(db);
        }
        finally {
            db.close();
        }
    };
    api.registerCli(({ program, config: cfg }) => {
        const root = program.command("memory-steward").description("Steward background work: status, People report, Captain's Log, expectations, crystals, overnight, skills, fleet, re-drive");
        root.command("status").description("Work item counts by kind/status plus the quarantined backlog")
            .option("--agent <id>", "Agent id", "main").option("--kind <kind>", "Filter one work kind")
            .action((opts) => {
            const dbPath = knownAgent(cfg, opts.agent);
            withStore(dbPath, store => {
                const items = store.list(opts.kind);
                console.log(JSON.stringify({
                    agentId: opts.agent,
                    enabled: options.config.enabled,
                    peopleShadow: options.config.peopleShadow.enabled,
                    peopleMode: options.config.peopleShadow.mode,
                    captainsLog: options.config.captainsLog.enabled,
                    outcomeLedger: options.config.outcomeLedger.enabled,
                    expectations: options.config.expectations.enabled,
                    crystals: options.config.crystals.enabled,
                    overnight: options.config.overnight.enabled,
                    skills: options.config.skills.enabled,
                    fleetCommons: options.pluginConfig?.fleetCommons.enabled ?? false,
                    counts: summarize(items),
                    quarantined: items.filter(item => item.status === "quarantined")
                        .map(({ kind, scope, strikes, lastError }) => ({ kind, scope, strikes, lastError })),
                }, null, 2));
            });
        });
        root.command("shadow-report").description("Side-by-side People Steward proposals/publications vs cron receipts (read-only)")
            .option("--agent <id>", "Agent id", "main").option("--manifest <id>", "One people-learning run id, e.g. nightly:2026-11-25")
            .action((opts) => {
            console.log(JSON.stringify(buildPeopleShadowReport(knownAgent(cfg, opts.agent), opts.manifest), null, 2));
        });
        root.command("captains-log").description("Run or preview Steward Captain's Log distillation for one agent")
            .option("--agent <id>", "Agent id", "main").option("--dry-run", "Preview entries without writing or moving watermarks", false)
            .action(async (opts) => {
            const dbPath = knownAgent(cfg, opts.agent);
            const runner = options.createRunner();
            if (!runner) {
                console.log(JSON.stringify({ status: "disabled" }));
                process.exitCode = 1;
                return;
            }
            const store = openWorkStore(dbPath);
            try {
                const result = await runCaptainsLogPass(captainsLogPassOptions(options.config.captainsLog, {
                    agentId: opts.agent,
                    syntheticInput: options.pluginConfig?.syntheticInput,
                    databasePath: transcriptDbForAgent(cfg, opts.agent),
                    workspaceDir: workspaceDirForAgent(cfg, opts.agent),
                    workStore: store,
                    runner,
                    owner: `steward-cli:${process.pid}:${randomUUID()}`,
                    timezone: resolveTimezone(cfg.agents?.defaults?.userTimezone?.trim()),
                    dryRun: Boolean(opts.dryRun),
                }, options.pluginConfig));
                // A dry run never appends, so it never resolves or mirrors anything either.
                const followUp = await afterCaptainsLogAppend(options, { store, agentId: opts.agent, result,
                    warn: message => console.warn(message) });
                console.log(JSON.stringify(followUp?.resolution ? { ...result, expectationsResolution: followUp.resolution } : result, null, 2));
            }
            finally {
                store.close();
            }
        });
        root.command("outcomes").description("Outcome Ledger KPIs: whisper use, skill opens, shortfalls, by recipe (read-only)")
            .option("--agent <id>", "Agent id", "main").option("--since-hours <n>", "Only exposures from the last n hours")
            .option("--recipe <hash>", "Only one retrieval recipe hash")
            .action((opts) => {
            const sinceHours = opts.sinceHours === undefined ? undefined : Number(opts.sinceHours);
            if (sinceHours !== undefined && !(Number.isFinite(sinceHours) && sinceHours > 0)) {
                throw new Error("--since-hours must be a positive number");
            }
            const recipeHash = opts.recipe?.trim();
            if (opts.recipe !== undefined && !recipeHash)
                throw new Error("--recipe must be a non-empty hash");
            const dbPath = knownAgent(cfg, opts.agent);
            withReadOnlyDb(dbPath, db => {
                console.log(JSON.stringify({
                    agentId: opts.agent,
                    ...(sinceHours === undefined ? {} : { sinceHours }),
                    ...(recipeHash ? { recipeHash } : {}),
                    ...summarizeOutcomeMetrics(db, {
                        agentId: opts.agent,
                        ...(sinceHours === undefined ? {} : { sinceMs: Date.now() - Math.round(sinceHours * 3_600_000) }),
                        ...(recipeHash ? { recipeHash } : {}),
                    }),
                }, null, 2));
            });
        });
        root.command("blockers").description("Open [BLOCKED] Captain's Log entries, newest first (read-only)")
            .option("--agent <id>", "Agent id", "main").option("--limit <n>", "Maximum entries (0 = unlimited)", "0")
            .action((opts) => {
            const limit = Number(opts.limit);
            if (!Number.isSafeInteger(limit) || limit < 0)
                throw new Error("--limit must be a non-negative integer");
            const dbPath = knownAgent(cfg, opts.agent);
            withReadOnlyDb(dbPath, db => {
                const blockers = listOpenBlockers(db, opts.agent, limit);
                console.log(JSON.stringify({ agentId: opts.agent, count: blockers.length, blockers }, null, 2));
            });
        });
        root.command("expectations").description("Open/resolved expectations (read-only); --run triggers one Expectations pass now")
            .option("--agent <id>", "Agent id", "main")
            .option("--status <status>", `Filter one status (${EXPECTATION_STATUSES.join(", ")})`)
            .option("--limit <n>", "Maximum expectations (0 = unlimited)", "0")
            .option("--run", "Run one Expectations pass for this agent and print its result", false)
            .action(async (opts) => {
            const limit = Number(opts.limit);
            if (!Number.isSafeInteger(limit) || limit < 0)
                throw new Error("--limit must be a non-negative integer");
            const status = opts.status === undefined ? undefined : EXPECTATION_STATUSES.find(value => value === opts.status?.trim());
            if (opts.status !== undefined && !status)
                throw new Error(`--status must be one of: ${EXPECTATION_STATUSES.join(", ")}`);
            const dbPath = knownAgent(cfg, opts.agent);
            if (opts.run) {
                let runner;
                try {
                    runner = options.createRunner();
                }
                catch (error) {
                    console.warn(`unblock-memory steward runner unavailable; running deterministic ingestion only: ${String(error)}`);
                }
                const store = openWorkStore(dbPath);
                try {
                    const result = await runExpectationsPass(expectationsPassOptions(options.config.expectations, {
                        agentId: opts.agent, workStore: store, owner: `steward-cli:${process.pid}:${randomUUID()}`,
                        syntheticInput: options.pluginConfig?.syntheticInput,
                        timezone: resolveTimezone(cfg.agents?.defaults?.userTimezone?.trim()),
                    }, runner, () => transcriptDbForAgent(cfg, opts.agent)));
                    console.log(JSON.stringify(result, null, 2));
                    if (result.status === "failed")
                        process.exitCode = 1;
                }
                finally {
                    store.close();
                }
                return;
            }
            const read = (db) => ({
                summary: ExpectationsStore.summarize(db, opts.agent),
                expectations: ExpectationsStore.list(db, { agentId: opts.agent, ...(status ? { status } : {}), limit }),
            });
            // Never creates or migrates an absent database: that reads as an empty in-memory one.
            const report = ExpectationsStore.readOnly(dbPath, undefined, read) ?? withReadOnlyDb(dbPath, read);
            console.log(JSON.stringify({ agentId: opts.agent, ...(status ? { status } : {}), ...report }, null, 2));
        });
        const nonNegativeLimit = (value) => {
            const limit = Number(value);
            if (!Number.isSafeInteger(limit) || limit < 0)
                throw new Error("--limit must be a non-negative integer");
            return limit;
        };
        /** CLI `--run` only: borrow one agent's manager, always releasing it afterwards. */
        const withCliManager = async (agentId, needed, fn) => {
            const memory = options.memory?.();
            let manager = null;
            try {
                if (memory && needed(memory)) {
                    try {
                        manager = (await memory.getMemorySearchManager({ cfg, agentId })).manager;
                    }
                    catch {
                        manager = null;
                    }
                }
                return await fn(manager, memory);
            }
            finally {
                if (manager) {
                    try {
                        await memory?.release?.(agentId);
                    }
                    catch { }
                }
            }
        };
        root.command("crystals").description("Memory Crystals by tier with core-memory counts (read-only); --run triggers one Crystals pass now")
            .option("--agent <id>", "Agent id", "main")
            .option("--tier <tier>", `Filter one tier (${CRYSTAL_TIERS.join(", ")})`)
            .option("--limit <n>", "Maximum crystals (0 = unlimited)", "0")
            .option("--run", "Run one Crystals pass for this agent now and print its result", false)
            .action(async (opts) => {
            const limit = nonNegativeLimit(opts.limit);
            const tier = opts.tier === undefined ? undefined : CRYSTAL_TIERS.find(value => value === opts.tier?.trim());
            if (opts.tier !== undefined && !tier)
                throw new Error(`--tier must be one of: ${CRYSTAL_TIERS.join(", ")}`);
            const dbPath = knownAgent(cfg, opts.agent);
            if (opts.run) {
                await withCliManager(opts.agent, () => true, async (manager, memory) => {
                    if (!manager) {
                        console.log(JSON.stringify({ status: "unavailable", reason: "memory index unavailable for this agent" }));
                        process.exitCode = 1;
                        return;
                    }
                    let runner;
                    try {
                        runner = options.createRunner();
                    }
                    catch (error) {
                        console.warn(`unblock-memory steward runner unavailable; running decay/promotion only: ${String(error)}`);
                    }
                    const store = openWorkStore(dbPath);
                    try {
                        const result = await runCrystalsPass(crystalsPassOptions(options.config.crystals, {
                            agentId: opts.agent, workStore: store, owner: `steward-cli:${process.pid}:${randomUUID()}`, ignoreDueAt: true,
                        }, runner, manager, memory?.analysisExecutable === true, options.pluginConfig));
                        console.log(JSON.stringify(result, null, 2));
                        if (result.status === "failed")
                            process.exitCode = 1;
                    }
                    finally {
                        store.close();
                    }
                });
                return;
            }
            // Never creates or migrates an absent database (or one without the crystal tables).
            const report = MemoryCrystalsStore.readOnly(dbPath, undefined, db => ({
                summary: summarizeCrystals(db, opts.agent),
                crystals: listCrystals(db, { agentId: opts.agent, ...(tier ? { tier } : {}), limit }),
            })) ?? { summary: summarizeCrystals(dbPath, opts.agent), crystals: [] };
            console.log(JSON.stringify({ agentId: opts.agent, ...(tier ? { tier } : {}), ...report }, null, 2));
        });
        root.command("overnight").description("Voltaire shifts and shortfall post-mortems (read-only); --run triggers one Overnight pass now")
            .option("--agent <id>", "Agent id", "main")
            .option("--limit <n>", "Maximum shifts and post-mortems each (0 = unlimited)", "0")
            .option("--run", "Run one Overnight Thinking pass now (ignores the schedule and quiet hours)", false)
            .action(async (opts) => {
            const limit = nonNegativeLimit(opts.limit);
            const dbPath = knownAgent(cfg, opts.agent);
            if (opts.run) {
                const runner = options.createRunner();
                if (!runner) {
                    console.log(JSON.stringify({ status: "disabled" }));
                    process.exitCode = 1;
                    return;
                }
                const overnight = options.config.overnight;
                // Investigations need the index; a post-mortem-only run never starts a manager.
                const needsIndex = (memory) => Boolean(memory.deepThought) && (overnight.voltaireEnabled || overnight.preAnswerEnabled);
                await withCliManager(opts.agent, needsIndex, async (manager, memory) => {
                    const deepThought = manager ? memory?.deepThought?.(opts.agent, cfg) : undefined;
                    const store = openWorkStore(dbPath);
                    try {
                        const result = await runOvernightThinkingPass(overnightPassOptions(overnight, {
                            agentId: opts.agent, workStore: store, owner: `steward-cli:${process.pid}:${randomUUID()}`,
                            syntheticInput: options.pluginConfig?.syntheticInput,
                            timezone: resolveTimezone(cfg.agents?.defaults?.userTimezone?.trim()), ignoreDueAt: true, ignoreQuietHours: true,
                        }, runner, manager ? { manager, cfg, ...(deepThought ? { deepThought } : {}) } : undefined, () => workspaceDirForAgent(cfg, opts.agent)));
                        console.log(JSON.stringify(result, null, 2));
                        if (result.status === "failed")
                            process.exitCode = 1;
                    }
                    finally {
                        store.close();
                    }
                });
                return;
            }
            // Each reader opens an existing file read-only and never creates or migrates anything.
            console.log(JSON.stringify({
                agentId: opts.agent,
                summary: summarizeOvernightThinking(dbPath, { agentId: opts.agent }),
                shifts: listVoltaireShifts(dbPath, { agentId: opts.agent, limit }),
                postmortems: listShortfallPostmortems(dbPath, { agentId: opts.agent, limit }),
            }, null, 2));
        });
        /** Parse one `--x <one of>` filter; undefined when omitted. */
        const oneOf = (value, allowed, flag) => {
            if (value === undefined)
                return undefined;
            const matched = allowed.find(entry => entry === value.trim());
            if (!matched)
                throw new Error(`${flag} must be one of: ${allowed.join(", ")}`);
            return matched;
        };
        /** Skill-proposal store errors are operator outcomes (not found, wrong state, conflict), printed as JSON with exit 1. */
        const proposalFailure = (error) => {
            if (!(error instanceof SkillProposalError))
                throw error;
            console.log(JSON.stringify({ status: "error", code: error.code, message: error.message }, null, 2));
            process.exitCode = 1;
        };
        root.command("skills").description("Self-writing skill proposals (read-only); --run triggers one review-only Skills pass now")
            .option("--agent <id>", "Agent id", "main")
            .option("--status <status>", `Filter one status (${SKILL_PROPOSAL_STATUSES.join(", ")})`)
            .option("--kind <kind>", `Filter one kind (${SKILL_PROPOSAL_KINDS.join(", ")})`)
            .option("--limit <n>", "Maximum proposals (0 = unlimited)", "0")
            .option("--run", "Run one Skills pass now (ignores the schedule; writes only pending proposals)", false)
            .action(async (opts) => {
            const limit = nonNegativeLimit(opts.limit);
            const status = oneOf(opts.status, SKILL_PROPOSAL_STATUSES, "--status");
            const kind = oneOf(opts.kind, SKILL_PROPOSAL_KINDS, "--kind");
            const dbPath = knownAgent(cfg, opts.agent);
            if (opts.run) {
                const runner = options.createRunner();
                if (!runner) {
                    console.log(JSON.stringify({ status: "disabled" }));
                    process.exitCode = 1;
                    return;
                }
                if (!skillsCorpusConfigured(options.pluginConfig)) {
                    console.log(JSON.stringify({ status: "unavailable", reason: "no skills corpus configured: no proposal could ever be applied" }));
                    process.exitCode = 1;
                    return;
                }
                const sources = skillSources(options.pluginConfig, workspaceDirForAgent(cfg, opts.agent));
                const memory = options.memory?.();
                if (!memory?.skillCatalog) {
                    console.log(JSON.stringify({ status: "unavailable", reason: "skill catalog unavailable for this agent" }));
                    process.exitCode = 1;
                    return;
                }
                let catalog;
                try {
                    catalog = await memory.skillCatalog({ cfg, agentId: opts.agent });
                }
                finally {
                    try {
                        await memory.release?.(opts.agent);
                    }
                    catch { }
                }
                const store = openWorkStore(dbPath);
                try {
                    const result = await runStewardSkillsPass(skillsPassOptions(options.config.skills, {
                        agentId: opts.agent, workStore: store, owner: `steward-cli:${process.pid}:${randomUUID()}`, ignoreDueAt: true,
                    }, runner, catalog, await skillReplayDecision(options.pluginConfig), sources));
                    console.log(JSON.stringify(result, null, 2));
                    if (result.status === "failed")
                        process.exitCode = 1;
                }
                finally {
                    store.close();
                }
                return;
            }
            // Never creates or migrates an absent database (or one without the skill_proposals table).
            withReadOnlyDb(dbPath, db => {
                console.log(JSON.stringify({
                    agentId: opts.agent, ...(status ? { status } : {}), ...(kind ? { kind } : {}),
                    summary: summarizeSkillProposals(db, opts.agent),
                    proposals: listSkillProposals(db, { agentId: opts.agent, ...(status ? { status } : {}), ...(kind ? { kind } : {}), limit }),
                }, null, 2));
            });
        });
        root.command("skill-review <id>").description("Approve or reject one pending skill proposal (never touches a live SKILL.md)")
            .option("--agent <id>", "Agent id", "main")
            .option("--approve", "Approve the proposal", false)
            .option("--reject", "Reject the proposal (it is never re-raised)", false)
            .option("--by <name>", "Reviewer recorded on the proposal")
            .option("--note <text>", "Review note recorded on the proposal")
            .action((id, opts) => {
            if (Boolean(opts.approve) === Boolean(opts.reject))
                throw new Error("skill-review needs exactly one of --approve or --reject");
            const dbPath = knownAgent(cfg, opts.agent);
            if (!existsSync(dbPath))
                return proposalFailure(new SkillProposalError("not_found", `Skill proposal ${id} not found`));
            withStore(dbPath, store => {
                try {
                    const proposal = reviewSkillProposal(store.db, { id, agentId: opts.agent, decision: opts.approve ? "approved" : "rejected",
                        ...(opts.by === undefined ? {} : { reviewedBy: opts.by }), ...(opts.note === undefined ? {} : { note: opts.note }) });
                    console.log(JSON.stringify({ status: proposal.status, proposal }, null, 2));
                }
                catch (error) {
                    proposalFailure(error);
                }
            });
        });
        root.command("skill-apply <id>").description("Write one approved proposal's SKILL.md inside a configured skills corpus root")
            .option("--agent <id>", "Agent id", "main")
            .option("--dry-run", "Preview the diff without writing or changing state", false)
            .option("--target-dir <dir>", "Directory for new_skill proposals (default: the first configured skills corpus root)")
            .action((id, opts) => {
            const dbPath = knownAgent(cfg, opts.agent);
            const allowedSources = skillSources(options.pluginConfig, workspaceDirForAgent(cfg, opts.agent)) ?? [];
            const targetDirForNewSkills = opts.targetDir === undefined ? allowedSources[0]?.root : resolve(opts.targetDir);
            if (!existsSync(dbPath))
                return proposalFailure(new SkillProposalError("not_found", `Skill proposal ${id} not found`));
            const apply = (db) => {
                try {
                    const result = applyApprovedProposal(db, { id, agentId: opts.agent, allowedSources, dryRun: Boolean(opts.dryRun),
                        ...(targetDirForNewSkills ? { targetDirForNewSkills } : {}) });
                    console.log(JSON.stringify(result, null, 2));
                }
                catch (error) {
                    proposalFailure(error);
                }
            };
            // A preview never writes: it reads through a read-only connection and never opens (or migrates) the work store.
            if (opts.dryRun)
                withReadOnlyDb(dbPath, apply);
            else
                withStore(dbPath, store => apply(store.db));
        });
        /** `--x <n>` hours, `0` allowed. */
        const hoursOption = (value, flag) => {
            const hours = Number(value);
            if (!Number.isFinite(hours) || hours < 0)
                throw new Error(`${flag} must be a non-negative number`);
            return hours;
        };
        /**
         * The local `--agent` id selects the store; only the operator-assigned `--agent-alias` leaves the node, so a
         * client-named agent id never becomes a Prometheus label or hub row key.
         */
        const fleetIds = (opts) => ({ nodeId: opts.node, agentId: opts.agentAlias, sourceAgentId: opts.agent });
        /** Optional `--push <endpoint>`: POST the snapshot to the hub (https:// unless loopback, enforced by pushNodeSnapshot). */
        const pushFleetSnapshot = async (snapshot, opts) => {
            if (opts.push === undefined) {
                if (opts.tokenFile !== undefined)
                    throw new Error("--token-file requires --push");
                return;
            }
            const timeoutMs = Number(opts.pushTimeoutMs);
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
                throw new Error("--push-timeout-ms must be a non-negative integer");
            await pushNodeSnapshot(snapshot, { endpoint: opts.push, timeoutMs, ...(opts.tokenFile === undefined ? {} : { apiKeyFile: resolve(opts.tokenFile) }) });
        };
        const fleetOptions = (command, nodeHelp, pushPath) => command
            .option("--agent <id>", "Local agent id whose store is read (never exported)", "main")
            .option("--agent-alias <alias>", "Operator-assigned agent alias reported in place of the agent id", "default")
            .option("--node <id>", nodeHelp, "local")
            .option("--push <url>", `POST the JSON snapshot to this hub endpoint (e.g. https://hub.example${pushPath})`)
            .option("--token-file <path>", "Bearer token file for --push")
            .option("--push-timeout-ms <n>", "Timeout for --push in ms (0 = none)", "10000");
        fleetOptions(root.command("fleet-telemetry").description("Anonymous Fleet Organism telemetry snapshot for one agent (read-only)"), "Operator-assigned node alias reported to the fleet hub", "/api/v1/telemetry")
            .option("--since-hours <n>", "Outcome lookback in hours (0 = all history)", "24")
            .option("--format <format>", "json or prometheus", "json")
            .action(async (opts) => {
            const format = oneOf(opts.format, ["json", "prometheus"], "--format");
            const sinceHours = hoursOption(opts.sinceHours, "--since-hours");
            const snapshot = buildNodeTelemetrySnapshot(knownAgent(cfg, opts.agent), { ...fleetIds(opts), sinceHours });
            await pushFleetSnapshot(snapshot, opts);
            console.log(format === "prometheus" ? formatPrometheusMetrics([snapshot]).trimEnd() : JSON.stringify(snapshot, null, 2));
        });
        fleetOptions(root.command("fleet-brief").description("Operator-only Fleet Morning Brief for one agent (read-only; never telemetry)"), "Operator-assigned node alias", "/api/v1/brief")
            .option("--due-soon-hours <n>", "Expectations due within n hours (0 = overdue only)", "24")
            .option("--limit <n>", "Maximum items per section (0 = unlimited)", "0")
            .option("--format <format>", "json or markdown", "json")
            .action(async (opts) => {
            const format = oneOf(opts.format, ["json", "markdown"], "--format");
            const dueSoonHours = hoursOption(opts.dueSoonHours, "--due-soon-hours");
            const limit = nonNegativeLimit(opts.limit);
            const dbPath = knownAgent(cfg, opts.agent);
            const ids = fleetIds(opts);
            const brief = buildNodeBriefSnapshot(dbPath, { ...ids, dueSoonHours, limit });
            await pushFleetSnapshot(brief, opts);
            console.log(format === "markdown"
                ? renderFleetMorningBrief([brief], [buildNodeTelemetrySnapshot(dbPath, { ...ids, nowMs: brief.collectedAtMs })]).trimEnd()
                : JSON.stringify(brief, null, 2));
        });
        root.command("fleet-commons").description("Cached Fleet Commons entries (read-only); --sync pulls the feed into search now")
            .option("--agent <id>", "Agent id", "main")
            .option("--sync", "Sync the configured feed into this agent's cache and unblock-fleet collection", false)
            .action(async (opts) => {
            const dbPath = knownAgent(cfg, opts.agent);
            const enabled = options.pluginConfig?.fleetCommons.enabled ?? false;
            if (opts.sync) {
                if (!enabled) {
                    console.log(JSON.stringify({ status: "disabled" }));
                    process.exitCode = 1;
                    return;
                }
                await withCliManager(opts.agent, () => true, async (manager) => {
                    if (!manager?.syncFleetCommons) {
                        console.log(JSON.stringify({ status: "unavailable", reason: "memory index unavailable for this agent" }));
                        process.exitCode = 1;
                        return;
                    }
                    console.log(JSON.stringify(await manager.syncFleetCommons(), null, 2));
                });
                return;
            }
            // Each reader opens an existing file read-only and never creates or migrates anything.
            console.log(JSON.stringify({
                agentId: opts.agent, enabled, summary: summarizeFleetCommons(dbPath), entries: readFleetCommonsEntries(dbPath),
            }, null, 2));
        });
        root.command("requeue").description("Explicitly re-drive one quarantined or completed work item")
            .requiredOption("--scope <scope>", "Exact work scope")
            .option("--kind <kind>", `Work kind (e.g. people_shadow, people_interactions, captains_log, outcome_ledger, expectations, memory_crystals, overnight_thinking, ${SKILLS_WORK_KIND})`, PEOPLE_SHADOW_KIND)
            .option("--agent <id>", "Agent id", "main")
            .action((opts) => {
            const dbPath = knownAgent(cfg, opts.agent);
            withStore(dbPath, store => {
                if (!store.get(opts.kind, opts.scope)) {
                    console.log(JSON.stringify({ status: "not_found" }));
                    process.exitCode = 1;
                    return;
                }
                if (!store.requeue(opts.kind, opts.scope)) {
                    console.log(JSON.stringify({ status: "busy", item: store.get(opts.kind, opts.scope) }, null, 2));
                    process.exitCode = 1;
                    return;
                }
                console.log(JSON.stringify({ status: "requeued", item: store.get(opts.kind, opts.scope) }, null, 2));
            });
        });
    }, { descriptors: [{ name: "memory-steward", description: "Steward background work status, People report, Captain's Log, outcomes, blockers, expectations, crystals, overnight thinking, skill proposals and fleet telemetry", hasSubcommands: true }] });
}
