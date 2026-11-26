import { type QueryConversation } from "./query-contract.js";
export declare const JUDGE_CONTEXT_VERSION: string;
export type SelectedJudgeConversation = {
    status: "ok";
    conversation: QueryConversation;
};
type JudgeConversationSelection = SelectedJudgeConversation | {
    status: "input_too_large";
};
/** Budget the actual judge JSON, using o200k_base as a provider-independent proxy. */
export declare function selectJudgeConversation({ history, currentRequest }: QueryConversation): JudgeConversationSelection;
export {};
