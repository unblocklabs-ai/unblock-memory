import type { TrainingInput } from "./training-input.js";
import type { TrainingHit } from "./training-retrieval.js";
import { MEMORY_JUDGE_VERSION, memoryUsefulnessRequest, judgeMemoryPassage } from "./typesafe.js";

export const CONTEXT_JUDGE_VERSION = MEMORY_JUDGE_VERSION;

export function contextJudgeRequest(input: TrainingInput, asOf: string, hit: TrainingHit) {
  return memoryUsefulnessRequest(input, {
    excerpt: hit.text, sourcePath: hit.path, corpus: hit.corpus, dates: hit.dates,
  }, asOf);
}

export async function judgeTrainingPassage(request: ReturnType<typeof contextJudgeRequest>, apiKey: string) {
  return judgeMemoryPassage(request, { apiKey, timeoutMs: 30_000 });
}
