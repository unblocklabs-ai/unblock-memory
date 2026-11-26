import { DEFAULTS } from "./defaults.js";
import { resolveDecisionCredential, DecisionRequestError } from "./decision-client.js";
import { complementaryIndices, reviewMemoryRedundancy } from "./decision-review.js";
import { ApiQueryGenerator, fallbackQueries, QueryApiError, visibleQueryConversation } from "./query-generator.js";
import { selectJudgeConversation } from "./judge-context.js";
import { prepareQueryConversation, QueryInputBudgetError } from "./query-contract.js";
import { searchMemory, memoryPassageId } from "./memory-search.js";
import { startTiming, timeStage } from "./retrieval-timing.js";
import { abortable, abortedByTimeout } from "./abortable.js";
import { nonBlank } from "./guards.js";
const MAX_JUDGE_CANDIDATES = DEFAULTS.memoryWhisperer.maxJudgeCandidates;
const MAX_GENERATION_TIMEOUT_MS = DEFAULTS.memoryWhisperer.maxQueryGenMs;
const MAX_PAYLOAD_CHARS = DEFAULTS.memoryWhisperer.maxInjectedChars;
const MAX_SESSIONS = DEFAULTS.memoryWhisperer.maxTrackedSessions;
const MAX_SEEN_RUNS = DEFAULTS.memoryWhisperer.maxRunsPerSession;
function encodeHints(items) {
    return JSON.stringify(items).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
}
function failureFields(error) {
    return error instanceof DecisionRequestError || error instanceof QueryApiError
        ? { errorCode: error.code, httpStatus: error.status }
        : { errorCode: "unexpected" };
}
async function generateQueriesWithFallback(params) {
    const { generator, conversation, timeoutMs, signal, turn, agentId, diagnostics, log } = params;
    turn.stage = "generation";
    if (!generator) {
        if (signal.aborted)
            return;
        turn.queryFallback = true;
        diagnostics?.record(agentId, "memory", "generation_fallback");
        return fallbackQueries(conversation);
    }
    const generationStarted = performance.now();
    const endGeneration = startTiming("generationMs", turn.measurement, signal);
    const generationTimeoutMs = Math.min(MAX_GENERATION_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs / 2)));
    const generationSignal = AbortSignal.any([signal, AbortSignal.timeout(generationTimeoutMs)]);
    try {
        const queries = await generator.generate(conversation, generationSignal);
        if (signal.aborted)
            return;
        diagnostics?.record(agentId, "memory", "queries_generated");
        return queries;
    }
    catch (error) {
        if (signal.aborted)
            return;
        turn.queryFallback = true;
        log("warn", "generation_fallback", {
            ...failureFields(error),
            elapsedMs: performance.now() - generationStarted,
            timeoutMs: generationTimeoutMs,
        });
        diagnostics?.record(agentId, "memory", "generation_fallback");
        return fallbackQueries(conversation);
    }
    finally {
        endGeneration();
    }
}
async function selectComplementaryHints(params) {
    const { ranked, config, decisionModel, apiKey, signal, turn, agentId, diagnostics, log } = params;
    const baseline = { selected: ranked.slice(0, config.maxHints), redundantIds: new Set() };
    if (!config.complementaryHints || config.maxHints <= 1 || ranked.length <= 1) {
        return baseline;
    }
    turn.stage = "redundancy";
    try {
        const pairs = await reviewMemoryRedundancy({
            apiKey, endpoint: decisionModel.endpoint, model: decisionModel.model, timeoutMs: decisionModel.timeoutMs, signal,
            excerpts: ranked.slice(0, DEFAULTS.review.maxRedundancyCandidates).map(candidate => candidate.excerpt),
        });
        const { selected, redundant } = complementaryIndices(ranked.length, pairs, config.maxHints);
        return {
            selected: selected.map(index => ranked[index]),
            redundantIds: new Set(redundant.map(index => ranked[index].id)),
        };
    }
    catch (error) {
        // Preserve the original useful candidates when the optional refinement is unavailable.
        if (!signal.aborted) {
            diagnostics?.record(agentId, "memory", "redundancy_unavailable");
            log("warn", "redundancy_unavailable", failureFields(error));
        }
        return baseline;
    }
}
function renderBoundedHints(selected) {
    // Bound the complete injected payload without slicing individual excerpts into misleading prefixes.
    const emitted = [];
    const hints = [];
    let rendered = "";
    for (const candidate of selected) {
        const nextHint = {
            source: candidate.hit.path,
            lines: `${candidate.hit.startLine}-${candidate.hit.endLine}`,
            body: candidate.excerpt,
        };
        const nextRendered = encodeHints([...hints, nextHint]);
        if (nextRendered.length > MAX_PAYLOAD_CHARS)
            continue;
        emitted.push(candidate);
        hints.push(nextHint);
        rendered = nextRendered;
    }
    return { emitted, rendered };
}
function splitChannelThread(value) {
    if (!value)
        return {};
    const lower = value.toLowerCase();
    const threadIdx = lower.lastIndexOf(":thread:");
    const topicIdx = lower.lastIndexOf(":topic:");
    const splitAt = Math.max(threadIdx, topicIdx);
    if (splitAt > 0) {
        const markerLen = splitAt === threadIdx ? ":thread:".length : ":topic:".length;
        return {
            channelId: value.slice(0, splitAt).toLowerCase(),
            threadId: nonBlank(value.slice(splitAt + markerLen)),
        };
    }
    return { channelId: lower };
}
function chatTypeFromSessionKey(sessionKey) {
    if (!sessionKey)
        return undefined;
    const match = /:(direct|group|channel):/iu.exec(sessionKey);
    return match?.[1]?.toLowerCase();
}
function whispererOrigin(context, sessionKey) {
    const provider = nonBlank(context.messageProvider)?.toLowerCase();
    const accountId = nonBlank(context.accountId)?.toLowerCase();
    const senderId = nonBlank(context.senderId);
    const rawChannel = nonBlank(context.chatId) ?? nonBlank(context.channelId);
    const split = splitChannelThread(rawChannel);
    const channelId = split.channelId && split.channelId !== provider ? split.channelId : undefined;
    const threadId = split.threadId ?? nonBlank(context.threadId);
    const chatType = nonBlank(context.chatType)?.toLowerCase() ?? chatTypeFromSessionKey(sessionKey);
    return { provider, accountId, senderId, channelId, threadId, chatType };
}
function buildRecallHits(traces, emittedRanks, selectedIds, redundantIds) {
    return traces.map((trace) => {
        let disposition;
        let finalRank = trace.finalRank;
        if (trace.disposition === "passed") {
            const emittedRank = emittedRanks.get(trace.passageId);
            if (emittedRank !== undefined) {
                disposition = "emitted";
                finalRank = emittedRank;
            }
            else if (selectedIds.has(trace.passageId)) {
                disposition = "payload_limit";
                finalRank = undefined;
            }
            else {
                disposition = redundantIds.has(trace.passageId) ? "redundant" : "rank_limit";
                finalRank = undefined;
            }
        }
        else {
            disposition = trace.disposition;
        }
        return {
            rawLeafId: trace.locator.rawLeafId,
            passageId: trace.passageId,
            docHash: trace.locator.docHash,
            qmdSeq: trace.locator.qmdSeq,
            chunkPos: trace.locator.chunkPos,
            chunkLen: trace.locator.chunkLen,
            corpus: trace.hit.corpus,
            sourcePath: trace.hit.path,
            startLine: trace.hit.startLine,
            endLine: trace.hit.endLine,
            targetSessionId: trace.hit.session?.sessionId,
            extractedId: trace.hit.extracted?.id,
            extractedRevision: trace.hit.extracted?.revision,
            observedAtMs: trace.locator.observedAtMs,
            observedAtBasis: trace.locator.observedAtBasis,
            retrievalRank: trace.retrievalRank,
            retrievalScore: trace.retrievalScore,
            usefulnessScore: trace.usefulnessScore,
            disposition,
            finalRank,
        };
    });
}
export function registerMemoryWhisperer(api, runtime, config, decisionModel, diagnostics, recallLedger) {
    if (!config.enabled || !decisionModel.enabled)
        return;
    const sessions = new Map();
    const generator = config.api.endpoint ? new ApiQueryGenerator(config.api) : undefined;
    const touchSession = (key, state) => {
        sessions.delete(key);
        sessions.set(key, state);
    };
    const beforePrompt = async (event, context, surface) => {
        const { agentId, runId, sessionId, sessionKey } = context;
        const scope = sessionId || sessionKey;
        if ((!surface && context.trigger !== "user") || !agentId || !runId || !scope)
            return;
        const corpora = config.corpora;
        if (!corpora.length)
            return;
        const key = JSON.stringify([agentId, scope]);
        const previous = sessions.get(key);
        if (previous) {
            touchSession(key, previous);
            if (previous.runId === runId)
                return previous.result;
            // Ignore delayed prompt rebuilds for already-superseded runs so they never replace the latest run.
            if (previous.seenRuns.has(runId))
                return undefined;
        }
        const currentUserMessage = typeof event.currentUserMessage === "string" ? event.currentUserMessage : undefined;
        const rawCurrent = currentUserMessage !== undefined ? currentUserMessage : event.prompt;
        if (!rawCurrent.replace(/^\s*From: [^\r\n]+ \([^()\r\n]+\)\s*$/, "").trim())
            return;
        const started = performance.now();
        const asOf = new Date().toISOString();
        const turn = {
            stage: "input",
            reason: "completed",
            queryFallback: false,
            requestsSucceeded: 0,
            requestsFailed: 0,
            measurement: { outcome: "skipped", elapsedMs: 0 },
        };
        const log = (level, eventName, fields) => api.logger[level]("unblock-memory memory_whisperer " + JSON.stringify({ event: eventName, agentId, runId, sessionId, stage: turn.stage, ...fields }));
        previous?.controller.abort();
        if (!previous && sessions.size >= MAX_SESSIONS) {
            const oldestKey = sessions.keys().next().value;
            sessions.get(oldestKey)?.controller.abort();
            sessions.delete(oldestKey);
        }
        const seenRuns = previous?.seenRuns ?? new Set();
        seenRuns.add(runId);
        if (seenRuns.size > MAX_SEEN_RUNS)
            seenRuns.delete(seenRuns.values().next().value);
        const state = {
            agentId, sessionId, sessionKey, runId, turn: (previous?.turn ?? 0) + 1,
            controller: new AbortController(), recent: previous?.recent ?? new Map(), seenRuns,
        };
        touchSession(key, state);
        for (const [id, recordedTurn] of state.recent) {
            if (state.turn - recordedTurn > config.cooldownTurns)
                state.recent.delete(id);
        }
        const { signal } = state.controller;
        const timer = setTimeout(() => state.controller.abort(new DOMException("Memory deadline", "TimeoutError")), config.timeoutMs);
        const createdAtMs = Date.now();
        const rawMessageId = nonBlank(event.currentUserMessageId);
        const eventKey = `whisperer:${scope}:${rawMessageId ?? runId}`;
        const origin = whispererOrigin(context, sessionKey);
        let generatedQueries;
        let traces = [];
        let ledgerRecorded = false;
        const recordLedger = (outcome, rankingMode = "decision", emittedRanks = new Map(), selectedIds = new Set(), redundantIds = new Set()) => {
            if (!recallLedger || ledgerRecorded)
                return;
            ledgerRecorded = true;
            recallLedger.writer.enqueue(recallLedger.dbPathForAgent(agentId), {
                kind: "query",
                record: {
                    eventKey,
                    createdAtMs,
                    agentId,
                    source: "whisperer",
                    sessionId,
                    sessionKey,
                    runId,
                    ...origin,
                    lexQuery: generatedQueries?.lex,
                    vecQuery: generatedQueries?.vec,
                    queryFallback: turn.queryFallback,
                    corpora,
                    rankingMode,
                    decisionModel: decisionModel.model,
                    minUsefulness: config.minUsefulness,
                    outcome,
                    hits: buildRecallHits(traces, emittedRanks, selectedIds, redundantIds),
                },
            });
        };
        const run = async () => {
            const visible = visibleQueryConversation(event.prompt, event.messages, currentUserMessage);
            const judgeConversation = selectJudgeConversation(visible);
            if (judgeConversation.status === "input_too_large")
                throw new QueryInputBudgetError();
            const { conversation } = prepareQueryConversation(visible.history, visible.currentRequest);
            turn.stage = "credentials";
            const apiKey = await timeStage("setupMs", turn.measurement, signal, () => resolveDecisionCredential(decisionModel));
            if (signal.aborted)
                return;
            if (!apiKey) {
                turn.reason = "missing_key";
                diagnostics?.record(agentId, "memory", "missing_key");
                recordLedger("missing_key");
                return;
            }
            const queries = await generateQueriesWithFallback({
                generator, conversation, timeoutMs: config.timeoutMs, signal, turn, agentId, diagnostics, log,
            });
            if (!queries || signal.aborted)
                return;
            generatedQueries = queries;
            turn.queryCount = 2;
            turn.stage = "retrieval";
            const { manager } = await timeStage("setupMs", turn.measurement, signal, () => runtime.getMemorySearchManager({ cfg: api.config, agentId }));
            if (signal.aborted)
                return;
            if (!manager) {
                turn.reason = "unavailable";
                diagnostics?.record(agentId, "memory", "unavailable");
                recordLedger("unavailable");
                return;
            }
            const search = await searchMemory(manager, queries, {
                corpora, signal, apiKey, endpoint: decisionModel.endpoint, model: decisionModel.model, timeoutMs: decisionModel.timeoutMs, conversation: judgeConversation,
                asOf, timings: turn.measurement, minUsefulness: config.minUsefulness, maxResults: DEFAULTS.memoryWhisperer.maxFinalists,
                maxJudgeCandidates: MAX_JUDGE_CANDIDATES, excludedPassages: state.recent,
                onCandidates: observation => {
                    turn.measurement.retrievalMs = observation.retrievalMs;
                    turn.measurement.candidates = observation.candidates;
                    turn.measurement.eligible = observation.eligible;
                    turn.measurement.outcome = "empty";
                    turn.stage = "judgment";
                },
                onJudgment: ({ candidateIndex, elapsedMs, error }) => {
                    const fields = { stage: "judgment", candidateIndex, elapsedMs, timeoutMs: decisionModel.timeoutMs };
                    if (error !== undefined) {
                        turn.requestsFailed++;
                        diagnostics?.record(agentId, "memory", "judge_candidate_failed");
                        log("warn", "candidate_failed", { ...fields, ...failureFields(error) });
                    }
                    else {
                        turn.requestsSucceeded++;
                        log("info", "candidate_completed", fields);
                    }
                },
                ...(recallLedger ? { onTrace: (recorded) => { traces = recorded; } } : {}),
            });
            if (signal.aborted || sessions.get(key) !== state)
                return;
            turn.measurement.judgeMs = search.judgeMs;
            if (!search.eligible) {
                turn.reason = "no_candidates";
                diagnostics?.record(agentId, "memory", "no_candidates");
                recordLedger("empty", search.rankingMode);
                return;
            }
            if (!search.requestsSucceeded) {
                turn.reason = "all_candidates_failed";
                turn.measurement.outcome = "failed";
                diagnostics?.record(agentId, "memory", "failed");
                recordLedger("failed", search.rankingMode);
                return;
            }
            const ranked = search.results.map(hit => ({ hit, excerpt: hit.snippet, id: memoryPassageId(hit.snippet) }));
            if (!ranked.length) {
                turn.reason = "rejected";
                diagnostics?.record(agentId, "memory", "rejected");
                recordLedger("rejected", search.rankingMode);
                return;
            }
            const { selected, redundantIds } = await selectComplementaryHints({
                ranked, config, decisionModel, apiKey, signal, turn, agentId, diagnostics, log,
            });
            if (signal.aborted || sessions.get(key) !== state)
                return;
            turn.stage = "render";
            const { emitted, rendered } = renderBoundedHints(selected);
            const selectedIds = new Set(selected.map(candidate => candidate.id));
            const emittedRanks = new Map(emitted.map((candidate, index) => [candidate.id, index + 1]));
            if (!emitted.length) {
                turn.reason = "payload_limit";
                diagnostics?.record(agentId, "memory", "payload_limit");
                recordLedger("rejected", search.rankingMode, emittedRanks, selectedIds, redundantIds);
                return;
            }
            for (const candidate of emitted)
                state.recent.set(candidate.id, state.turn);
            diagnostics?.record(agentId, "memory", "emitted");
            const appendContext = `<memory>\n${rendered}\n</memory>`;
            turn.measurement.outcome = "ok";
            turn.reason = "emitted";
            turn.measurement.results = emitted.length;
            turn.measurement.contextChars = appendContext.length;
            recordLedger("emitted", search.rankingMode, emittedRanks, selectedIds, redundantIds);
            return { appendContext };
        };
        // Prompt rebuilds need the same context, not another retrieval or an empty hook result.
        state.result = (async () => {
            try {
                return await abortable(run(), signal);
            }
            catch (error) {
                if (signal.aborted)
                    return;
                if (error instanceof QueryInputBudgetError) {
                    turn.reason = "input_too_large";
                    turn.measurement.outcome = "skipped";
                    diagnostics?.record(agentId, "memory", "input_too_large");
                    if (sessions.get(key) === state)
                        recordLedger("skipped");
                    return;
                }
                turn.reason = "stage_failed";
                turn.measurement.outcome = "failed";
                diagnostics?.record(agentId, "memory", "failed");
                log("warn", "stage_failed", failureFields(error));
                if (sessions.get(key) === state)
                    recordLedger("failed");
                return;
            }
            finally {
                turn.measurement.elapsedMs = performance.now() - started;
                const timedOut = abortedByTimeout(signal);
                if (signal.aborted) {
                    turn.measurement.outcome = timedOut ? "timed_out" : "cancelled";
                    turn.reason = timedOut ? "deadline" : "cancelled";
                    if (sessions.get(key) === state)
                        recordLedger(timedOut ? "timed_out" : "cancelled");
                }
                diagnostics?.measureMemory(agentId, turn.measurement);
                log("info", "completed", {
                    ...turn.measurement,
                    reason: turn.reason,
                    queryCount: turn.queryCount,
                    queryFallback: turn.queryFallback,
                    requestsSucceeded: turn.requestsSucceeded,
                    requestsFailed: turn.requestsFailed,
                    judgedCandidates: turn.requestsSucceeded,
                    partial: turn.requestsSucceeded > 0 && turn.requestsFailed > 0,
                    timeoutMs: config.timeoutMs,
                    requestTimeoutMs: decisionModel.timeoutMs,
                });
                if (signal.aborted)
                    diagnostics?.record(agentId, "memory", timedOut ? "timed_out" : "cancelled");
                clearTimeout(timer);
                // Stop sibling provider/worker work after an error or an empty early result too.
                state.controller.abort();
            }
        })();
        return state.result;
    };
    api.on("session_end", (event, context) => {
        for (const [key, state] of sessions) {
            if (context.agentId && state.agentId !== context.agentId)
                continue;
            if (state.sessionId === event.sessionId ||
                (state.sessionKey && (state.sessionKey === event.sessionKey || state.sessionKey === context.sessionKey))) {
                state.controller.abort();
                sessions.delete(key);
            }
        }
    });
    api.on("gateway_stop", () => {
        for (const state of sessions.values())
            state.controller.abort();
        sessions.clear();
    });
    return beforePrompt;
}
