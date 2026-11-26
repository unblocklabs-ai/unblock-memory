import { DEFAULTS } from "./defaults.js";
import { QUERY_CONTRACT, queryTokenIds, type QueryConversation } from "./query-contract.js";

const { judgeConversationMaxTokens: maxTokens, judgeConversationMaxBytes: maxBytes } = DEFAULTS.memoryWhisperer;
export const JUDGE_CONTEXT_VERSION = `whole-messages-v1:${QUERY_CONTRACT.revision}:${maxTokens}:${maxBytes}`;
export type SelectedJudgeConversation = { status: "ok"; conversation: QueryConversation };
type JudgeConversationSelection = SelectedJudgeConversation | { status: "input_too_large" };

/** Budget the actual judge JSON, using o200k_base as a provider-independent proxy. */
export function selectJudgeConversation({ history, currentRequest }: QueryConversation): JudgeConversationSelection {
  const current = { history: [], currentRequest };
  let bytes = Buffer.byteLength(JSON.stringify(current));
  if (bytes > maxBytes) return { status: "input_too_large" };
  const fitsTokens = (conversation: QueryConversation) =>
    queryTokenIds(JSON.stringify(conversation)).length <= maxTokens;
  if (!fitsTokens(current)) return { status: "input_too_large" };

  let start = history.length;
  while (start > 0) {
    const added = Buffer.byteLength(JSON.stringify(history[start - 1]!)) + (start === history.length ? 0 : 1);
    if (bytes + added > maxBytes) break;
    bytes += added;
    start--;
  }
  const suffix = (index: number): QueryConversation => ({ history: history.slice(index), currentRequest });
  if (start === history.length) return { status: "ok", conversation: current };
  const byteBounded = suffix(start);
  if (fitsTokens(byteBounded)) return { status: "ok", conversation: byteBounded };

  // Test whole suffixes against the serialized token budget, not a sum of per-message token estimates.
  let end = history.length;
  while (end - start > 1) {
    const middle = Math.floor((start + end) / 2);
    if (fitsTokens(suffix(middle))) end = middle;
    else start = middle;
  }
  return { status: "ok", conversation: suffix(end) };
}
