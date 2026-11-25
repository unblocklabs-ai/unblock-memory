import {
  abortedByTimeout,
  classifyDecisionFailure,
  createDecisionClient,
  DEFAULT_DECISIONS_ENDPOINT,
  DEFAULT_DECISIONS_MODEL,
  DecisionError,
  decisionModelScope,
  matchesDecisionModel,
  resolveDecisionApiKey,
  resolveDecisionConfig,
  validateDecisionEndpoint,
  type DecisionResult,
  type QuestionMap,
} from "@unblocklabs/decisions";
import { Type } from "typebox";
import type { UnblockMemoryConfig } from "./config.js";

export {
  classifyDecisionFailure,
  decisionModelScope,
  matchesDecisionModel,
  DEFAULT_DECISIONS_MODEL as DEFAULT_DECISION_MODEL,
  DecisionError as DecisionRequestError,
};

export const NOUL_SCHEMA = Type.Object({
  type: Type.Literal("noul"), noul: Type.Number({ minimum: 0, maximum: 1 }),
});
export const NOUL_ANSWERS_SCHEMA = Type.Object({ answers: Type.Record(Type.String(), NOUL_SCHEMA) });

type DecisionRequestOptions = {
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_UNBOUNDED_TIMEOUT_MS = 60_000;
const CODEX_ORIGIN = new URL(DEFAULT_DECISIONS_ENDPOINT).origin;

/** A conservative estimate of serialized size, not a model-specific tokenizer. Non-ASCII is budgeted separately. */
export function estimateDecisionTokens(value: unknown): number {
  let n = 0;
  for (const c of JSON.stringify(value)) n += c.codePointAt(0)! < 128 ? 1 / 3 : 2;
  return Math.ceil(n);
}

/** A decision-model deadline: the request's own timeout, or the caller's timed-out signal. */
export function isDecisionTimeout(error: unknown, signal: AbortSignal): boolean {
  return (error instanceof DecisionError && error.code === "timeout") || abortedByTimeout(signal);
}

/** Explicit credentials take precedence; a missing explicit file never selects another key. */
export async function resolveDecisionCredential(
  config: Pick<UnblockMemoryConfig["decisionModel"], "enabled" | "apiKey" | "apiKeyFile"> & { endpoint?: string },
): Promise<string | undefined> {
  if (!config.enabled) return undefined;
  if (config.apiKey !== undefined) {
    const trimmed = config.apiKey.trim();
    if (!trimmed) return undefined;
    if (/\s/u.test(trimmed)) {
      throw new DecisionError("Decision model apiKey must not contain whitespace", "invalid_credential");
    }
    return trimmed;
  }
  const endpoint = validateDecisionEndpoint(config.endpoint ?? DEFAULT_DECISIONS_ENDPOINT);
  const codex = new URL(endpoint).origin === CODEX_ORIGIN;
  return resolveDecisionApiKey(resolveDecisionConfig({
    endpoint,
    model: DEFAULT_DECISIONS_MODEL,
    apiKeyFile: config.apiKeyFile,
    ambientEnvKeys: codex ? ["CODEX_LB_API_KEY"] : [],
    fileEnvKeys: codex ? ["CODEX_LB_API_KEY"] : ["CODEX_LB_API_KEY", "DECISION_MODEL_API_KEY"],
  }));
}

function requestClient(params: DecisionRequestOptions, timeoutMs: number) {
  return createDecisionClient({
    endpoint: params.endpoint,
    model: params.model ?? DEFAULT_DECISIONS_MODEL,
    apiKey: params.apiKey,
    ambientEnvKeys: [],
    fileEnvKeys: [],
    timeoutMs,
  });
}

/** Typed decision call backed directly by @unblocklabs/decisions. */
export async function decideWithModel<const Q extends QuestionMap>(
  params: DecisionRequestOptions,
  state: unknown,
  questions: Q,
  options?: { validateModel?: boolean; allowExtraAnswerKeys?: boolean },
): Promise<DecisionResult<Q>> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_UNBOUNDED_TIMEOUT_MS;
  return requestClient(params, timeoutMs).decide(state, questions, {
    timeoutMs,
    signal: params.signal,
    validateModel: options?.validateModel ?? true,
    allowExtraAnswerKeys: options?.allowExtraAnswerKeys ?? false,
  });
}

/**
 * Low-level raw JSON decision request backed by @unblocklabs/decisions `decideRaw()`,
 * for callers that intentionally tolerate partial multi-question responses (e.g. Safety Whisperer).
 */
export async function requestDecision(
  params: DecisionRequestOptions,
  state: unknown,
  questions: unknown,
): Promise<unknown> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_UNBOUNDED_TIMEOUT_MS;
  return requestClient(params, timeoutMs).decideRaw(state, questions, {
    timeoutMs,
    signal: params.signal,
  });
}
