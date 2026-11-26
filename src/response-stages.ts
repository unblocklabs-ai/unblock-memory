import type { ResponseEpisode } from "./response-episodes.js";
import { RESPONSE_EXTRACTOR_VERSION } from "./response-episodes.js";
import {
  judgeResponse,
  judgeResponseFollowup,
  RESPONSE_STAGE_VERSIONS,
  type ResponseJudgeParams,
  type ResponseStages,
} from "./response-judge.js";
import { decisionModelScope, DEFAULT_DECISION_MODEL } from "./decision-client.js";
import type { ResponseAuditStore } from "./response-store.js";
import { jsonHash } from "./json-hash.js";

type CoreResponseStage = "quality" | "feedback" | "sentiment" | "retrospective";

export async function assessResponseStages(store: ResponseAuditStore, cohort: string, e: ResponseEpisode,
  params: ResponseJudgeParams, sentimentEnabled: boolean,
  usage: { stageAttempts: number; stageCacheHits: number }) {
  params.signal.throwIfAborted();
  const scope = decisionModelScope(params.model ?? DEFAULT_DECISION_MODEL, params.endpoint);
  const original = { before: e.before, request: e.request, answer: e.answer, contextLimited: e.contextLimited };
  const feedback = { ...original, feedback: e.feedback };
  const evidence: Record<CoreResponseStage, unknown> = {
    quality: original,
    feedback,
    sentiment: feedback,
    retrospective: { ...feedback, followup: e.followup },
  };
  const keys = Object.fromEntries((Object.keys(evidence) as CoreResponseStage[]).map(stage => [stage,
    jsonHash([RESPONSE_EXTRACTOR_VERSION, scope, RESPONSE_STAGE_VERSIONS[stage],
      e.id, e.session, e.senderId, e.thread, evidence[stage]]),
  ])) as Record<CoreResponseStage, string>;
  const cache = {
    quality: store.stage(cohort, e, "quality", keys.quality),
    feedback: store.stage(cohort, e, "feedback", keys.feedback),
    sentiment: sentimentEnabled ? store.stage(cohort, e, "sentiment", keys.sentiment) : undefined,
    begin(stages: CoreResponseStage[]) {
      params.signal.throwIfAborted();
      store.stageBegin(stages.map(stage => keys[stage]), Date.now());
      usage.stageAttempts += stages.length;
    },
    save<K extends CoreResponseStage>(stage: K, result: ResponseStages[K]) {
      params.signal.throwIfAborted();
      store.stageSave(keys[stage], result, Date.now());
    },
    settle(stages: CoreResponseStage[]) {
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
    cache.begin(["retrospective"]);
    try {
      const retrospective = await judgeResponseFollowup(e, params);
      cache.save("retrospective", retrospective);
      return retrospective;
    } catch (error) {
      if (!params.signal.aborted) cache.settle(["retrospective"]);
      throw error;
    }
  };
  const [judgment, retrospective] = await Promise.allSettled([
    judgeResponse(e, params, sentimentEnabled, cache), assessRetrospective(),
  ]);
  if (judgment.status === "rejected") throw judgment.reason;
  if (retrospective.status === "rejected") throw retrospective.reason;
  return { ...judgment.value, retrospective: retrospective.value };
}
