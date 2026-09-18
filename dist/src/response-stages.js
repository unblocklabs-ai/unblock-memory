import { createHash } from "node:crypto";
import { RESPONSE_EXTRACTOR_VERSION } from "./response-episodes.js";
import { judgeResponse, judgeResponseFollowup, RESPONSE_STAGE_VERSIONS } from "./response-judge.js";
import { TYPESAFE_REVIEW_MODEL } from "./typesafe-review.js";
export async function assessResponseStages(store, cohort, e, params, sentimentEnabled, usage) {
    const original = { before: e.before, request: e.request, answer: e.answer, contextLimited: e.contextLimited };
    const feedback = { ...original, feedback: e.feedback };
    const evidence = { quality: original, feedback, sentiment: feedback, retrospective: { ...feedback, followup: e.followup } };
    const keys = Object.fromEntries(Object.keys(evidence).map(stage => [stage,
        createHash("sha256").update(JSON.stringify([RESPONSE_EXTRACTOR_VERSION, TYPESAFE_REVIEW_MODEL, RESPONSE_STAGE_VERSIONS[stage],
            e.id, e.session, e.senderId, e.thread, evidence[stage]])).digest("hex"),
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
    };
    usage.stageCacheHits += Number(!!cache.quality) + Number(!!cache.feedback) + Number(!!cache.sentiment);
    const judgment = await judgeResponse(e, params, sentimentEnabled, cache);
    let retrospective = store.stage(cohort, e, "retrospective", keys.retrospective);
    if (retrospective)
        usage.stageCacheHits++;
    if (!retrospective) {
        cache.begin(["retrospective"]);
        retrospective = await judgeResponseFollowup(e, params);
        cache.save("retrospective", retrospective);
    }
    return { ...judgment, retrospective };
}
