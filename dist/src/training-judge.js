import { DEFAULTS } from "./defaults.js";
import { MEMORY_JUDGE_VERSION, memoryUsefulnessRequest, judgeMemoryPassage } from "./decision-ranking.js";
export const CONTEXT_JUDGE_VERSION = MEMORY_JUDGE_VERSION;
export function contextJudgeRequest(input, asOf, hit, model) {
    return memoryUsefulnessRequest(input, {
        excerpt: hit.text, sourcePath: hit.path, corpus: hit.corpus, dates: hit.dates,
    }, asOf, model);
}
export async function judgeTrainingPassage(request, apiKey, options) {
    return judgeMemoryPassage(request, { apiKey, endpoint: options?.endpoint, model: options?.model, timeoutMs: DEFAULTS.training.decisionTimeoutMs });
}
