import { MEMORY_JUDGE_VERSION, memoryUsefulnessRequest, judgeMemoryPassage } from "./typesafe.js";
export const CONTEXT_JUDGE_VERSION = MEMORY_JUDGE_VERSION;
export function contextJudgeRequest(input, asOf, hit) {
    return memoryUsefulnessRequest(input, {
        excerpt: hit.text, sourcePath: hit.path, corpus: hit.corpus, dates: hit.dates,
    }, asOf);
}
export async function judgeTrainingPassage(request, apiKey) {
    return judgeMemoryPassage(request, { apiKey, timeoutMs: 30_000 });
}
