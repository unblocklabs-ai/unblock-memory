import { DEFAULTS } from "./defaults.js";
import type { TrainingInput } from "./training-input.js";
import type { SelectedJudgeConversation } from "./judge-context.js";
import type { TrainingHit } from "./training-retrieval.js";
import { MEMORY_JUDGE_VERSION, memoryUsefulnessRequest, judgeMemoryPassage } from "./decision-ranking.js";

export const CONTEXT_JUDGE_VERSION = MEMORY_JUDGE_VERSION;

export function contextJudgeRequest(input: TrainingInput | SelectedJudgeConversation, asOf: string, hit: TrainingHit, model?: string) {
  return memoryUsefulnessRequest(input, {
    excerpt: hit.text, sourcePath: hit.path, corpus: hit.corpus, dates: hit.dates,
  }, asOf, model);
}

export async function judgeTrainingPassage(request: ReturnType<typeof contextJudgeRequest>, apiKey: string,
  options?: { endpoint?: string; model?: string }) {
  return judgeMemoryPassage(request, { apiKey, endpoint: options?.endpoint, model: options?.model, timeoutMs: DEFAULTS.training.decisionTimeoutMs });
}
