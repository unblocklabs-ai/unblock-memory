import { createHash } from "node:crypto";
import { selectJudgeConversation } from "./judge-context.js";
import { DEFAULT_BRIGHTNESS_CONFIG, memorySubjectId } from "./memory-brightness.js";
import { MEMORY_PASSAGE_CHARS, duplicateMemoryPassage } from "./memory-passage.js";
import { judgeMemoryPassage, memoryUsefulnessRequest } from "./decision-ranking.js";
import { startTiming, retrievalParts, unaccounted } from "./retrieval-timing.js";
import { parseDailyFilenameDateMs } from "./recall-ledger.js";
export function memoryPassageId(text) {
    return createHash("sha256").update(text.replace(/\s+/gu, " ").trim()).digest("hex");
}
function rankHits(entries, hitOf, brightness) {
    const baseline = (a, b) => hitOf(b).score - hitOf(a).score;
    if (brightness?.lookup && brightness.recipe !== "off" && entries.length) {
        const { lookup, weight = DEFAULT_BRIGHTNESS_CONFIG.weight, maxBoost = DEFAULT_BRIGHTNESS_CONFIG.maxBoost } = brightness;
        if (weight > 0 && Number.isFinite(weight) && maxBoost >= 0) {
            const subjects = entries.map(entry => {
                const { corpus, path } = hitOf(entry);
                return memorySubjectId(corpus, path);
            });
            let scores;
            try {
                const evidence = lookup([...new Set(subjects)]);
                if (evidence?.size) {
                    scores = new Map(entries.map((entry, index) => {
                        const normalized = evidence.get(subjects[index])?.normalized ?? 0;
                        const boost = Number.isFinite(normalized) ? Math.max(-maxBoost, Math.min(maxBoost, weight * normalized)) : 0;
                        return [entry, hitOf(entry).score + boost];
                    }));
                }
            }
            catch {
                // Brightness is optional; a failed lookup keeps the baseline ranking.
            }
            if (scores)
                return entries.sort((a, b) => scores.get(b) - scores.get(a) || baseline(a, b));
        }
    }
    return entries.sort(baseline);
}
function isQueryList(queries) {
    return Array.isArray(queries);
}
function resolveLocator(hit, passageId) {
    if (hit.locator)
        return hit.locator;
    const extractedMs = hit.extracted?.observedAt ? Date.parse(hit.extracted.observedAt) : Number.NaN;
    if (Number.isFinite(extractedMs)) {
        return { rawLeafId: passageId, observedAtMs: extractedMs, observedAtBasis: "extracted" };
    }
    const fileDateMs = hit.corpus !== "sessions" ? parseDailyFilenameDateMs(hit.path) : undefined;
    if (fileDateMs !== undefined) {
        return { rawLeafId: passageId, observedAtMs: fileDateMs, observedAtBasis: "filename_date" };
    }
    return { rawLeafId: passageId, observedAtBasis: "unknown" };
}
/** Reciprocal-rank constant for cross-topic fusion, matching QMD's own lane fusion. */
const TOPIC_RRF_K = 60;
/**
 * Deterministic passage-level RRF across topics: score = sum over topics of 1 / (60 + rank). Each passage keeps
 * the metadata of its highest-scoring occurrence; ties keep first-seen order (topic order, then rank).
 */
function fuseTopicHits(lists) {
    const fused = new Map();
    const topicRanks = new Map();
    let order = 0;
    for (const [topic, hits] of lists.entries()) {
        const seenInTopic = new Set();
        let rank = 0;
        for (const hit of hits) {
            const passageId = memoryPassageId(hit.snippet);
            if (seenInTopic.has(passageId))
                continue;
            seenInTopic.add(passageId);
            rank++;
            const ranks = topicRanks.get(passageId) ?? Array.from({ length: lists.length }, () => undefined);
            ranks[topic] = rank;
            topicRanks.set(passageId, ranks);
            const contribution = 1 / (TOPIC_RRF_K + rank);
            const existing = fused.get(passageId);
            if (!existing) {
                fused.set(passageId, { hit, rrf: contribution, order: order++ });
            }
            else {
                existing.rrf += contribution;
                if (hit.score > existing.hit.score)
                    existing.hit = hit;
            }
        }
    }
    const hits = [...fused.values()]
        .sort((a, b) => b.rrf - a.rrf || a.order - b.order)
        .map(({ hit, rrf }) => ({ ...hit, score: rrf }));
    return { hits, topicRanks, topicCount: lists.length };
}
const timingCounters = new Set(["metadataReloads", "vectorScanAttempts"]);
/**
 * Parallel topic searches must not share one mutable timing sink: `startTiming` writes `previous + elapsed`, so
 * overlapping stages overwrite each other. Each topic records into its own bucket; overlapping durations add
 * their maximum (wall-clock lower bound) to the outer sink and counters add their sum.
 */
function mergeTopicTimings(target, buckets) {
    if (!target)
        return;
    const fields = new Set(buckets.flatMap(bucket => Object.keys(bucket)));
    for (const field of fields) {
        const values = buckets.map(bucket => bucket[field] ?? 0);
        const merged = timingCounters.has(field) ? values.reduce((sum, value) => sum + value, 0) : Math.max(...values);
        target[field] = (target[field] ?? 0) + merged;
    }
}
async function searchTopics(manager, topics, options) {
    // One serialized job records its stages sequentially, so it can share the outer timing sink.
    if (manager.searchCandidateTopics)
        return manager.searchCandidateTopics(topics, options);
    const buckets = topics.map(() => ({}));
    try {
        return await Promise.allSettled(topics.map((topic, index) => manager.searchCandidates(topic, { ...options, ...(options.timings ? { timings: buckets[index] } : {}) })));
    }
    finally {
        mergeTopicTimings(options.timings, buckets);
    }
}
/** Reserve the best eligible candidate of each topic first, then fill by fused score up to `limit`. */
function reserveTopicCandidates(candidates, fusion, limit) {
    const ranked = [...candidates].sort((a, b) => b.score - a.score);
    const picked = new Set();
    for (let topic = 0; topic < fusion.topicCount && picked.size < limit; topic++) {
        let best;
        let bestRank = Number.POSITIVE_INFINITY;
        for (const candidate of ranked) {
            const rank = fusion.topicRanks.get(memoryPassageId(candidate.snippet))?.[topic];
            if (rank !== undefined && rank < bestRank) {
                best = candidate;
                bestRank = rank;
            }
        }
        // A passage that is already the best hit of an earlier topic covers this topic too.
        if (best)
            picked.add(best);
    }
    for (const candidate of ranked) {
        if (picked.size >= limit)
            break;
        picked.add(candidate);
    }
    // Keep the judge pool in fused-score order regardless of reservation order.
    return ranked.filter(candidate => picked.has(candidate));
}
/**
 * Reserve the highest-ranked qualifying passage of each topic first, then fill in ranked order, so one topic's
 * many strong hits cannot push another topic's qualifying hit out of the results.
 */
function reserveTopicFinalists(ranked, fusion, limit) {
    const picked = new Set();
    for (let topic = 0; topic < fusion.topicCount && picked.size < limit; topic++) {
        const best = ranked.find(entry => fusion.topicRanks.get(memoryPassageId(entry.result.snippet))?.[topic] !== undefined);
        if (best)
            picked.add(best);
    }
    for (const entry of ranked) {
        if (picked.size >= limit)
            break;
        picked.add(entry);
    }
    return ranked.filter(entry => picked.has(entry));
}
/**
 * Both entry points use the same complete passages and independent usefulness judgments.
 * A single query pair (or one-element list) searches exactly as before; 2+ topic pairs search together (one
 * manager job when supported) and fuse with passage-level RRF, reserving a judge slot and a finalist slot per topic.
 */
export async function searchMemory(manager, queries, options) {
    const { signal } = options;
    signal?.throwIfAborted();
    const asOf = options.asOf ?? new Date().toISOString();
    const timings = options.timings ?? {};
    const endRetrieval = startTiming("retrievalMs", timings, signal);
    const topics = isQueryList(queries) ? queries : [queries];
    if (!topics.length)
        throw new RangeError("searchMemory requires at least one query pair");
    const searchOptions = {
        corpora: options.corpora, sessionFilter: options.sessionFilter, requestContext: options.requestContext,
        sources: options.sources, signal, maxSnippetChars: MEMORY_PASSAGE_CHARS, timings,
    };
    let hits;
    let fusion;
    let topicsFailed;
    try {
        if (topics.length === 1) {
            hits = await manager.searchCandidates(topics[0], searchOptions);
        }
        else {
            const settled = await searchTopics(manager, topics, searchOptions);
            signal?.throwIfAborted();
            // One failed topic must not hide the others; fail only when every topic search failed.
            if (settled.every(result => result.status === "rejected"))
                throw settled[0].reason;
            topicsFailed = settled.filter(result => result.status === "rejected").length;
            fusion = fuseTopicHits(settled.map(result => result.status === "fulfilled" ? result.value : []));
            hits = fusion.hits;
        }
    }
    finally {
        endRetrieval();
        if (timings.retrievalMs !== undefined)
            timings.retrievalOtherMs = unaccounted(timings.retrievalMs, timings, retrievalParts);
    }
    signal?.throwIfAborted();
    const observation = { retrievalMs: timings.retrievalMs ?? 0, judgeMs: 0,
        candidates: hits.length, eligible: 0, requestsSucceeded: 0, requestsFailed: 0,
        ...(topicsFailed !== undefined ? { topicsFailed } : {}) };
    const trackTrace = Boolean(options.onTrace);
    const candidates = [];
    const traces = [];
    const traceByCandidate = new Map();
    const endCandidatePrep = startTiming("candidatePrepMs", timings, signal);
    try {
        let retrievalRank = 0;
        for (const hit of hits) {
            // Defense in depth before disclosing passages to the external judge.
            if (options.corpora && !options.corpora.includes("all") && !options.corpora.includes(hit.corpus))
                continue;
            const excerpt = hit.snippet.trim();
            if (!excerpt || excerpt.length > MEMORY_PASSAGE_CHARS)
                continue;
            const passageId = memoryPassageId(excerpt);
            if (options.excludedPassages?.has(passageId)) {
                if (trackTrace) {
                    retrievalRank++;
                    traces.push({
                        hit: { ...hit, snippet: excerpt },
                        passageId,
                        locator: resolveLocator(hit, passageId),
                        retrievalRank,
                        retrievalScore: hit.score,
                        disposition: "cooldown",
                    });
                }
                continue;
            }
            if (duplicateMemoryPassage({ ...hit, text: excerpt }, candidates.map(candidate => ({ ...candidate, text: candidate.snippet }))))
                continue;
            const candidate = { ...hit, snippet: excerpt };
            candidates.push(candidate);
            if (trackTrace) {
                retrievalRank++;
                const trace = {
                    hit: candidate,
                    passageId,
                    locator: resolveLocator(candidate, passageId),
                    retrievalRank,
                    retrievalScore: hit.score,
                    disposition: "unjudged_cap",
                };
                traces.push(trace);
                traceByCandidate.set(candidate, trace);
            }
        }
    }
    finally {
        endCandidatePrep();
    }
    observation.eligible = candidates.length;
    options.onCandidates?.(observation);
    const fallback = (reason) => {
        // Retrieval scores are not decision model usefulness probabilities.
        const ranked = rankHits([...candidates], hit => hit, options.brightness);
        const limit = options.maxResults ?? 5;
        const results = ranked.slice(0, limit);
        if (trackTrace) {
            for (const [index, candidate] of results.entries()) {
                const trace = traceByCandidate.get(candidate);
                if (trace) {
                    trace.disposition = "returned";
                    trace.finalRank = index + 1;
                }
            }
            options.onTrace?.(traces);
        }
        return { ...timings, ...observation, rankingMode: "retrieval", fallbackReason: reason, results };
    };
    const conversation = "status" in options.conversation
        ? options.conversation
        : selectJudgeConversation(options.conversation);
    if (conversation.status === "input_too_large" || !options.apiKey) {
        signal?.throwIfAborted();
        if (options.allowRetrievalFallback) {
            return fallback(conversation.status === "input_too_large" ? "input_too_large" : "key_unavailable");
        }
        if (trackTrace)
            options.onTrace?.(traces);
        return { ...timings, ...observation, rankingMode: "decision", results: [] };
    }
    const maxJudge = typeof options.maxJudgeCandidates === "number" && Number.isFinite(options.maxJudgeCandidates)
        ? Math.max(0, Math.floor(options.maxJudgeCandidates))
        : undefined;
    const judgePool = maxJudge === undefined
        ? candidates
        : fusion
            ? reserveTopicCandidates(candidates, fusion, maxJudge)
            : [...candidates].sort((a, b) => b.score - a.score).slice(0, maxJudge);
    const minUsefulness = options.minUsefulness ?? 0.7;
    const apiKey = options.apiKey;
    const endJudge = startTiming("judgeMs", timings, signal);
    let judged;
    try {
        judged = (await Promise.all(judgePool.map(async (hit, candidateIndex) => {
            const requestStarted = performance.now();
            const trace = trackTrace ? traceByCandidate.get(hit) : undefined;
            try {
                const { probability, usage } = await judgeMemoryPassage(memoryUsefulnessRequest(conversation, {
                    excerpt: hit.snippet, corpus: hit.corpus, sourcePath: hit.path,
                    // Observation dates let the judge order contradictory dated observations (e.g. 2025 vs 2026).
                    dates: [...new Set([
                            ...(hit.extracted?.observedAt ? [hit.extracted.observedAt] : []),
                            ...(hit.sessionMessages?.flatMap(message => message.timestamp ? [message.timestamp] : [])
                                ?? (hit.messageTimestamp ? [hit.messageTimestamp] : [])),
                        ])],
                }, asOf, options.model), { ...options, apiKey });
                if (usage) {
                    observation.inputTokens = (observation.inputTokens ?? 0) + usage.input_tokens;
                    observation.outputTokens = (observation.outputTokens ?? 0) + usage.output_tokens;
                }
                signal?.throwIfAborted();
                observation.requestsSucceeded++;
                options.onJudgment?.({ candidateIndex, elapsedMs: performance.now() - requestStarted });
                if (trace) {
                    trace.usefulnessScore = probability;
                    trace.disposition = probability >= minUsefulness ? "rank_limit" : "below_threshold";
                }
                // Discovery reciprocal ranks are not vector similarity or usefulness.
                const { vectorScore: _vectorScore, textScore: _textScore, ...result } = hit;
                const scored = { ...result, score: probability };
                return [{ result: scored, trace }];
            }
            catch (error) {
                if (signal?.aborted)
                    return [];
                observation.requestsFailed++;
                if (trace)
                    trace.disposition = "judge_failed";
                options.onJudgment?.({ candidateIndex, elapsedMs: performance.now() - requestStarted, error });
                return [];
            }
        }))).flat();
    }
    finally {
        endJudge();
    }
    signal?.throwIfAborted();
    observation.judgeMs = timings.judgeMs ?? 0;
    if (options.allowRetrievalFallback && judgePool.length && !observation.requestsSucceeded)
        return fallback("all_judgments_failed");
    const ranked = rankHits(judged.filter(({ result }) => result.score >= minUsefulness), entry => entry.result, options.brightness);
    const maxResults = options.maxResults ?? 5;
    const passed = fusion
        ? reserveTopicFinalists(ranked, fusion, maxResults)
        : ranked.slice(0, maxResults);
    if (trackTrace) {
        for (const [index, entry] of passed.entries()) {
            if (entry.trace) {
                entry.trace.disposition = "passed";
                entry.trace.finalRank = index + 1;
            }
        }
        options.onTrace?.(traces);
    }
    return { ...timings, ...observation, rankingMode: "decision", results: passed.map(entry => entry.result) };
}
