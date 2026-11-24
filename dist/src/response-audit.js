import { setImmediate } from "node:timers/promises";
import { abortable } from "./abortable.js";
import { decisionModelScope, resolveTypeSafeApiKey, TYPESAFE_MODEL } from "./typesafe-client.js";
import { RESPONSE_EXTRACTOR_VERSION, ResponseTranscriptReader } from "./response-episodes.js";
import { responseRubricVersion, RESPONSE_STAGE_VERSIONS, judgeMemoryOpportunity, } from "./response-judge.js";
import { ResponseAuditStore } from "./response-store.js";
import { responseMemoryCandidates } from "./response-memory.js";
import { assessResponseStages } from "./response-stages.js";
import { ResponsePeople } from "./response-identity.js";
import { jsonHash } from "./json-hash.js";
export function responseCohort(config, model = TYPESAFE_MODEL, endpoint) {
    return responseRubricVersion(model, endpoint) + ":" + jsonHash({
        extractor: RESPONSE_EXTRACTOR_VERSION, historyMessages: config.historyMessages,
        stages: RESPONSE_STAGE_VERSIONS,
        sentimentEnabled: config.sentimentEnabled,
        senderIds: [...config.senderIds].sort(), chatTypes: [...config.chatTypes].sort(), memoryCorpora: [...config.memoryCorpora].sort(),
    }).slice(0, 16);
}
/** All inference is outside memory's mutation queue and outside transcript DB transactions. */
export async function auditResponses(options) {
    const { config, agentId } = options;
    if (!config.responseAudit.enabled || !config.typesafe.enabled)
        return { status: "disabled" };
    const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]);
    const cohort = responseCohort(config.responseAudit, config.typesafe.model, config.typesafe.endpoint);
    let key;
    if (!options.dryRun) {
        try {
            key = await abortable(resolveTypeSafeApiKey(config.typesafe), signal);
        }
        catch {
            return { status: "unavailable", reason: "Credentials unavailable or audit cancelled" };
        }
        if (!key)
            return { status: "unavailable", reason: "TypeSafe API key not configured" };
    }
    let reader, store, lease;
    let people;
    const now = Date.now();
    const coverage = { sessions: 0, sessionLimitReached: false, sessionsOverBudget: 0, completedResponses: 0,
        reconciledSessions: 0, reconciliationDeferred: 0,
        extractedSessions: 0, unchangedSessions: 0,
        stageAttempts: 0, stageCacheHits: 0,
        eligible: 0, noFeedback: 0, pendingFeedback: 0, oversized: 0, filteredEvents: 0, outsideLookback: 0,
        attempted: 0, evaluated: 0, cachedOrBackoff: 0, deferredByLimit: 0, failed: 0, stale: 0 };
    try {
        signal.throwIfAborted();
        if (!options.dryRun) {
            store = new ResponseAuditStore(options.storePath);
            lease = store.acquire(now);
            if (!lease)
                return { status: "already_running" };
        }
        // The first store open may have imported people into the shared database.
        people = new ResponsePeople(options.peoplePath);
        reader = new ResponseTranscriptReader(options.databasePath, agentId);
        const since = now - config.responseAudit.lookbackDays * 86400_000;
        store?.reviews.refresh(cohort, since);
        const cursor = store?.cursor(cohort) ?? "";
        const tracked = new Set(store?.activeSessions(cohort, since) ?? []);
        const sessions = [...new Set([...reader.sessions(config.responseAudit, now, cursor).map(s => s.sessionId),
                ...[...tracked].filter(id => id > cursor)])].sort();
        coverage.sessionLimitReached = sessions.length > 100;
        let stoppedForBudget = false;
        for (const session of sessions.slice(0, 100)) {
            await setImmediate();
            signal.throwIfAborted();
            coverage.sessions++;
            const checkpoint = store?.checkpoint(cohort, session);
            const work = store?.sessionWork(cohort, session, since, now);
            const snapshot = reader.read(session, config.responseAudit, work?.due ? undefined : checkpoint?.revision);
            if (snapshot === undefined) {
                coverage.sessionsOverBudget++;
                coverage.reconciliationDeferred++;
                store?.advance(cohort, session);
                continue;
            }
            if (snapshot === null) {
                store?.observe(cohort, session, []);
                store?.checkpointForget(cohort, session);
                coverage.reconciledSessions++;
                store?.advance(cohort, session);
                continue;
            }
            if ("unchanged" in snapshot) {
                coverage.unchangedSessions++;
                coverage.cachedOrBackoff += work?.total ?? 0;
                if (checkpoint)
                    addCoverage(coverage, checkpoint.coverage);
                store?.advance(cohort, session);
                continue;
            }
            coverage.extractedSessions++;
            if (tracked.has(session))
                coverage.reconciledSessions++;
            addCoverage(coverage, snapshot.coverage);
            const episodes = snapshot.episodes.filter(e => e.timestamp >= since);
            coverage.outsideLookback += snapshot.episodes.length - episodes.length;
            store?.observe(cohort, session, snapshot.episodes);
            store?.checkpointSave(cohort, session, snapshot.revision, snapshot.coverage);
            // Oldest first within a session; new data cannot forever starve its existing backlog.
            for (const e of episodes) {
                signal.throwIfAborted();
                if (options.dryRun)
                    continue;
                if (!store.needsJudgment(cohort, e, Date.now())) {
                    coverage.cachedOrBackoff++;
                    continue;
                }
                if (coverage.attempted >= config.responseAudit.maxEpisodes) {
                    coverage.deferredByLimit++;
                    continue;
                }
                coverage.attempted++;
                const existing = store.memoryRetryResult(cohort, e);
                store.attempted(cohort, e, Date.now());
                try {
                    const params = {
                        apiKey: key, endpoint: config.typesafe.endpoint, model: config.typesafe.model,
                        timeoutMs: config.typesafe.timeoutMs, signal,
                    };
                    const result = existing
                        ? {
                            ...existing,
                            memory: await assessMemoryOpportunity(store, cohort, e, existing.feedback, options, params, coverage),
                        }
                        : await (async () => {
                            const judgment = await abortable(assessResponseStages(store, cohort, e, params, config.responseAudit.sentimentEnabled, coverage), signal);
                            const memory = await assessMemoryOpportunity(store, cohort, e, judgment.feedback, options, params, coverage);
                            return {
                                ...judgment,
                                human: people.resolve(e),
                                references: references(e),
                                agentModel: e.model,
                                contextLimited: e.contextLimited,
                                memorySearchCalls: e.memorySearchCalls,
                                memory,
                            };
                        })();
                    signal.throwIfAborted();
                    const fresh = reader.read(session, config.responseAudit, snapshot.revision);
                    if (!fresh || (!("unchanged" in fresh) && !fresh.episodes.some(candidate => candidate.id === e.id && candidate.inputHash === e.inputHash))) {
                        coverage.stale++;
                        store.stale(cohort, e);
                        if (fresh !== undefined) {
                            store.observe(cohort, session, fresh?.episodes ?? []);
                            store.checkpointForget(cohort, session);
                        }
                        break;
                    }
                    store.save(cohort, e, result, Date.now());
                    if (existing && result.memory.status === "unavailable")
                        coverage.failed++;
                    else
                        coverage.evaluated++;
                }
                catch {
                    coverage.failed++;
                    if (signal.aborted)
                        throw new Error("Audit cancelled");
                }
            }
            // Let stop/cancellation handlers run between bounded synchronous session reads.
            await setImmediate();
            store?.advance(cohort, session);
            if (coverage.attempted >= config.responseAudit.maxEpisodes && session !== sessions.at(-1)) {
                stoppedForBudget = true;
                coverage.deferredByLimit++; // At least one unvisited session; precise episode count is not yet known.
                break;
            }
        }
        if (!coverage.sessionLimitReached && !stoppedForBudget)
            store?.advance(cohort, "");
        coverage.deferredByLimit = Math.max(coverage.deferredByLimit, store?.pendingWork(cohort, since, Date.now()) ?? 0);
        store?.scan(cohort, coverage, Date.now());
        return { status: options.dryRun ? "dry_run" : "ok", cohort, coverage };
    }
    catch {
        store?.scan(cohort, { ...coverage, interrupted: true }, Date.now());
        return { status: "unavailable", reason: "Response audit failed or was cancelled", cohort, coverage };
    }
    finally {
        reader?.close();
        if (lease)
            store?.release(lease);
        store?.close();
        people?.close();
    }
}
function addCoverage(target, delta) {
    for (const key of Object.keys(delta))
        target[key] += delta[key];
}
async function assessMemoryOpportunity(store, cohort, e, feedback, options, params, usage) {
    if (feedback.memoryGap.noul < 0.8 || !options.config.responseAudit.memoryCorpora.length) {
        return { status: "not_requested", candidates: [] };
    }
    try {
        const approved = options.sources.filter(s => options.config.responseAudit.memoryCorpora.includes(s.corpus));
        const candidates = responseMemoryCandidates(options.indexPath, approved, e);
        const memoryKey = jsonHash([
            decisionModelScope(options.config.typesafe.model, options.config.typesafe.endpoint),
            RESPONSE_STAGE_VERSIONS.memory,
            e.id, e.session, e.senderId, e.request, e.answer, e.feedback, candidates,
            [...options.config.responseAudit.memoryCorpora].sort(),
        ]);
        let judged = store.stage(cohort, e, "memory", memoryKey, candidates);
        if (judged)
            usage.stageCacheHits++;
        else {
            store.stageBegin([memoryKey], Date.now());
            usage.stageAttempts++;
            judged = await abortable(judgeMemoryOpportunity(e, candidates, params), params.signal);
            store.stageSave(memoryKey, judged, Date.now());
        }
        return { status: "checked", candidates: judged };
    }
    catch {
        if (params.signal.aborted)
            throw new Error("Audit cancelled");
        return { status: "unavailable", candidates: [] };
    }
}
function references(e) {
    return { sessionId: e.session.sessionId, request: e.request.map(m => m.seq), answer: e.answer.map(m => m.seq),
        feedback: e.feedback.map(m => m.seq), followup: e.followup.messages.map(m => m.seq), inputHash: e.inputHash };
}
