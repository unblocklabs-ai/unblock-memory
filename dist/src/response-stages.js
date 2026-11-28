import { RESPONSE_EXTRACTOR_VERSION } from "./response-episodes.js";
import { judgeResponse, judgeResponseFollowup, RESPONSE_STAGE_VERSIONS, runStageAttempt, } from "./response-judge.js";
import { decisionModelScope, DEFAULT_DECISION_MODEL } from "./decision-client.js";
import { jsonHash } from "./json-hash.js";
export async function assessResponseStages(store, cohort, e, params, sentimentEnabled, usage) {
    params.signal.throwIfAborted();
    const scope = decisionModelScope(params.model ?? DEFAULT_DECISION_MODEL, params.endpoint);
    const original = { before: e.before, request: e.request, answer: e.answer, contextLimited: e.contextLimited };
    const feedback = { ...original, feedback: e.feedback };
    const evidence = {
        quality: original,
        feedback,
        sentiment: feedback,
        retrospective: { ...feedback, followup: e.followup },
    };
    const keys = Object.fromEntries(Object.keys(evidence).map(stage => [stage,
        jsonHash([RESPONSE_EXTRACTOR_VERSION, scope, RESPONSE_STAGE_VERSIONS[stage],
            e.id, e.session, e.senderId, e.thread, evidence[stage]]),
    ]));
    const cache = {
        quality: store.stage(cohort, e, "quality", keys.quality),
        feedback: store.stage(cohort, e, "feedback", keys.feedback),
        sentiment: sentimentEnabled ? store.stage(cohort, e, "sentiment", keys.sentiment) : undefined,
        begin(stages) {
            params.signal.throwIfAborted();
            store.stageBegin(stages.map(stage => keys[stage]), Date.now());
            usage.stageAttempts += stages.length;
        },
        save(stage, result) {
            params.signal.throwIfAborted();
            store.stageSave(keys[stage], result, Date.now());
        },
        settle(stages) {
            store.stageSettled(stages.map(stage => keys[stage]));
        },
    };
    usage.stageCacheHits += Number(!!cache.quality) + Number(!!cache.feedback) + Number(!!cache.sentiment);
    const assessRetrospective = async () => {
        params.signal.throwIfAborted();
        const cached = store.stage(cohort, e, "retrospective", keys.retrospective);
        if (cached) {
            usage.stageCacheHits++;
            return cached;
        }
        return runStageAttempt({
            begin: () => cache.begin(["retrospective"]), settle: () => cache.settle(["retrospective"]), signal: params.signal,
        }, async () => {
            const retrospective = await judgeResponseFollowup(e, params);
            cache.save("retrospective", retrospective);
            return retrospective;
        });
    };
    const [judgment, retrospective] = await Promise.allSettled([
        judgeResponse(e, params, sentimentEnabled, cache), assessRetrospective(),
    ]);
    if (judgment.status === "rejected")
        throw judgment.reason;
    if (retrospective.status === "rejected")
        throw retrospective.reason;
    return { ...judgment.value, retrospective: retrospective.value };
}
