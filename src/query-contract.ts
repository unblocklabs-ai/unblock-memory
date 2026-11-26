import { o200kTokenIds } from "./o200k.js";

export type QueryLane = "lex" | "vec";
export type QueryPair = Record<QueryLane, string>;
export type QueryConversation = { history: { role: "user" | "assistant"; content: string }[]; currentRequest: string };
export const QUERY_CONTRACT = { revision: "o200k-v1", conversationBytes: 24_000, conversationTokens: 8192 } as const;
export class QueryInputBudgetError extends Error {
  constructor() { super("Query input exceeds context budget"); this.name = "QueryInputBudgetError"; }
}

export function parseQueryPair(value: unknown): QueryPair {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 2 || !("lex" in value) || !("vec" in value) ||
    typeof value.lex !== "string" || typeof value.vec !== "string" || !value.lex.trim() || !value.vec.trim()) {
    throw new Error("Expected exactly one nonempty lex/vec query pair");
  }
  return { lex: value.lex.trim(), vec: value.vec.trim() };
}

/** Escape template delimiters before budgeting the serialized conversation. */
export function serializeQueryConversation(conversation: QueryConversation): string {
  return JSON.stringify({ history: conversation.history, currentRequest: conversation.currentRequest }).replaceAll("<", "\\u003c");
}

/** Bounded o200k_base IDs: exact for ordinary text, linear and conservative for long unbroken runs. */
export function queryTokenIds(text: string): number[] {
  return o200kTokenIds(text);
}

/** Never alter the current request or split a history message. */
export function prepareQueryConversation(history: QueryConversation["history"], currentRequest: string) {
  if (!currentRequest) throw new Error("Missing or unparseable current request");
  const conversation: QueryConversation = { history: [], currentRequest };
  let bytes = Buffer.byteLength(serializeQueryConversation(conversation));
  if (bytes > QUERY_CONTRACT.conversationBytes) throw new QueryInputBudgetError();
  // Start with the byte-bounded suffix, rather than repeatedly serializing the
  // entire retained session. This is a byte bound, never a message-count cap.
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    const added = Buffer.byteLength(JSON.stringify(message).replaceAll("<", "\\u003c")) + (conversation.history.length ? 1 : 0);
    if (bytes + added > QUERY_CONTRACT.conversationBytes) break;
    conversation.history.unshift(message);
    bytes += added;
  }
  const fits = (start: number) => queryTokenIds(serializeQueryConversation({
    history: conversation.history.slice(start), currentRequest,
  })).length <= QUERY_CONTRACT.conversationTokens;
  if (fits(0)) return { conversation, contextLimited: conversation.history.length < history.length };
  if (!fits(conversation.history.length)) throw new QueryInputBudgetError();
  // Search whole-message suffixes with the exact serialized tokenizer contract;
  // never approximate the budget by adding independently tokenized messages.
  let tooLarge = 0, fitting = conversation.history.length;
  while (fitting - tooLarge > 1) {
    const middle = Math.floor((tooLarge + fitting) / 2);
    if (fits(middle)) fitting = middle;
    else tooLarge = middle;
  }
  conversation.history = conversation.history.slice(fitting);
  return { conversation, contextLimited: true };
}
