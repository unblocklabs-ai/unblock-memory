import { setTimeout as delay } from "node:timers/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { abortable, abortedByTimeout } from "./abortable.js";
import { isRecord, record } from "./guards.js";
import { o200kTokenCount } from "./o200k.js";
import type { StewardConfig } from "./steward-config.js";

type JsonObject = Record<string, unknown>;
export type StewardUsage = { requests: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
  reasoningTokens?: number; costUsd?: number };
export type StewardToolDef<TParams = JsonObject> = { name: string; description: string; parameters: JsonObject;
  execute: (params: TParams, signal: AbortSignal) => Promise<unknown> };
type Prompt = { purpose: string; systemPrompt: string; userPrompt: string; model?: string;
  reasoning?: StewardConfig["reasoning"]; signal?: AbortSignal };
export type StewardCompleteRequest<T> = Prompt & { schema: JsonObject; timeoutMs?: number; maxRetries?: number };
export type StewardErrorCode = "aborted" | "timeout" | "lifecycle_reload" | "missing_credentials" | "context_overflow" |
  "transient_provider" | "invalid_output" | "budget_exhausted" | "provider_error";
type Failure = { ok: false; code: StewardErrorCode; error: string; retryable: boolean; usage: StewardUsage };
export type StewardCompleteResult<T> = Failure | { ok: true; data: T; usage: StewardUsage; model?: string;
  backend: "host_llm" | "responses_api" };
export type StewardRunRequest<T> = Prompt & { tools: readonly StewardToolDef[]; submitSchema: JsonObject; submitDescription?: string;
  maxTurns: number; maxToolCalls: number; maxInputTokens?: number; maxToolResultChars?: number; wallTimeoutMs: number;
  onToolCall?: (event: { name: string; ok: boolean; elapsedMs: number }) => void };
type Status = "complete" | "incomplete" | "needs_decision";
type Counts = { turns: number; toolCalls: number };
export type StewardRunResult<T> = Counts & (Failure | { ok: true; status: Status; data: T; summary: string; usage: StewardUsage; model?: string });
export interface StewardRunner {
  complete<T>(req: StewardCompleteRequest<T>): Promise<StewardCompleteResult<T>>;
  run<T>(req: StewardRunRequest<T>): Promise<StewardRunResult<T>>;
}
type Deps = { config: StewardConfig; resolveApiKey: () => Promise<string | undefined>;
  hostLlmComplete?: OpenClawPluginApi["runtime"]["llm"]["complete"]; fetch?: typeof fetch };

class Fault extends Error {
  constructor(readonly code: StewardErrorCode, message: string, readonly retryAfterMs = 0) { super(message); }
}
const invalid = (message: string) => new Fault("invalid_output", message);
const budget = (name: string) => new Fault("budget_exhausted", `Exceeded ${name}`);
function parse(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
function conforms<T>(schema: JsonObject, value: unknown): value is T {
  return value !== undefined && Value.Check(Type.Unsafe<T>(schema), value);
}

/** One deadline and accounting ledger across retries, tools and correction turns. */
function attempt(timeoutMs: number, caller?: AbortSignal) {
  const controller = new AbortController();
  const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
  const deadline = performance.now() + timeoutMs;
  const expire = () => controller.abort(new DOMException("Steward deadline", "TimeoutError"));
  const timer = setTimeout(expire, timeoutMs);
  const check = () => {
    if (performance.now() >= deadline) expire();
    signal.throwIfAborted();
  };
  const usage: StewardUsage = { requests: 0 };
  let reportedCosts = 0, totalCost = 0;
  function account(fields: Partial<Record<Exclude<keyof StewardUsage, "requests">, unknown>>) {
    for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "costUsd"] as const) {
      const n = fields[key];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) continue;
      if (key === "costUsd") { totalCost += n; reportedCosts++; }
      else usage[key] = (usage[key] ?? 0) + n;
    }
  }
  function receipt(): StewardUsage {
    return reportedCosts && reportedCosts === usage.requests ? { ...usage, costUsd: totalCost } : { ...usage };
  }
  function failure(error: unknown): Failure {
    const fault = signal.aborted || performance.now() >= deadline
      ? (abortedByTimeout(signal) || !signal.aborted ? new Fault("timeout", "Steward deadline elapsed") : new Fault("aborted", "Steward aborted"))
      : error instanceof Fault ? error : new Fault("provider_error", "Steward request failed");
    return { ok: false, code: fault.code, error: fault.message, retryable: ["lifecycle_reload", "timeout", "transient_provider"].includes(fault.code),
      usage: receipt() };
  }
  return { signal, deadline, check, usage, account, receipt, failure, close: () => clearTimeout(timer) };
}
type Attempt = ReturnType<typeof attempt>;

async function credential(deps: Deps, a: Attempt) {
  a.check();
  let token;
  try { token = await abortable(deps.resolveApiKey(), a.signal); } catch { /* Do not expose credential source details. */ }
  a.check();
  if (!token || /\s/u.test(token)) throw new Fault("missing_credentials", "No usable Steward credential");
  return token;
}

async function envelope(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw invalid("Provider response exceeds byte limit");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return record(parse(Buffer.concat(chunks).toString("utf8")));
}

function retryAfter(header: string | null) {
  if (!header) return 0;
  const n = Number(header);
  return Math.max(0, Number.isFinite(n) ? n * 1000 : Date.parse(header) - Date.now()) || 0;
}
function providerFault(response: Response, body?: JsonObject) {
  const err = record(body?.error) ?? body;
  // Inspect classification only; upstream bodies may contain prompts or credentials.
  const detail = [err?.code, err?.type, err?.message, body?.error, record(body?.incomplete_details)?.reason]
    .filter(x => typeof x === "string").join(" ");
  if (/context[_ -](?:length[_ -]exceeded|overflow|window)|exceeds? (?:the )?(?:maximum )?context/i.test(detail)) {
    return new Fault("context_overflow", "Provider context window exceeded");
  }
  if (![400, 401, 403].includes(response.status) && ([429, 502, 503, 504].includes(response.status) ||
    /stream_incomplete|upstream.*clos(?:ed|ing)|stream.*closed/i.test(detail))) {
    return new Fault("transient_provider", "Temporary provider failure", retryAfter(response.headers.get("retry-after")));
  }
  if (!response.ok || body?.error || body?.status === "failed") return new Fault("provider_error", `Provider failure (HTTP ${response.status})`);
  if (body?.status !== undefined && body.status !== "completed") return invalid("Provider response did not complete");
}

async function post(deps: Deps, a: Attempt, token: string, body: string, retries: number, beforeSend?: () => void) {
  for (let retry = 0; ; retry++) {
    a.check();
    beforeSend?.();
    a.usage.requests++;
    let response: Response | undefined;
    try {
      response = await abortable((deps.fetch ?? fetch)(deps.config.endpoint, { method: "POST", redirect: "error", signal: a.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body }), a.signal);
      const json = await envelope(response, a.signal);
      const u = record(json?.usage);
      a.account({ inputTokens: u?.input_tokens, outputTokens: u?.output_tokens, cachedInputTokens: record(u?.input_tokens_details)?.cached_tokens,
        reasoningTokens: record(u?.output_tokens_details)?.reasoning_tokens, costUsd: u?.cost_usd });
      a.check();
      const fault = providerFault(response, json);
      if (fault) throw fault;
      if (!json || !Array.isArray(json.output) || !json.output.every(isRecord)) throw invalid("Malformed Responses output");
      const output: JsonObject[] = json.output;
      if (output.some(item => (item.status !== undefined && item.status !== "completed") || item.type === "refusal" ||
        (Array.isArray(item.content) && item.content.some(part => record(part)?.type === "refusal")))) {
        throw invalid("Provider refused or returned unfinished output");
      }
      return { output, model: typeof json.model === "string" ? json.model : undefined };
    } catch (error) {
      a.check();
      const fault = error instanceof Fault ? error : (response && providerFault(response)) ??
        new Fault("transient_provider", "Provider connection failed");
      if (fault.code !== "transient_provider" || retry >= retries) throw fault;
      const wait = Math.max(fault.retryAfterMs, (1 + Math.random()) * 100 * 2 ** retry);
      if (wait >= a.deadline - performance.now()) throw fault;
      await delay(wait, undefined, { signal: a.signal });
    }
  }
}
function baseRequest(req: Prompt, config: StewardConfig) {
  const effort = req.reasoning ?? config.reasoning;
  return { model: req.model ?? config.model, instructions: req.systemPrompt, stream: false, store: false,
    ...(effort === "off" ? {} : { reasoning: { effort } }) };
}
function redactSecrets(text: string, token: string) {
  return text.replaceAll(token, "[redacted]").replace(/\bBearer\s+[^\s"',;\]}]+|\b(?:sk-|xox[baprs]-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}/gi, "[redacted]");
}
function toolText(value: unknown, token: string, max: number) {
  const text = redactSecrets(typeof value === "string" ? value : JSON.stringify(value) ?? "null", token);
  return text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/u, "");
}

export function createStewardRunner(deps: Deps): StewardRunner {
  return {
    async complete<T>(req: StewardCompleteRequest<T>): Promise<StewardCompleteResult<T>> {
      const a = attempt(req.timeoutMs ?? deps.config.deepThought.timeoutMs, req.signal);
      try {
        a.check();
        const host = deps.hostLlmComplete;
        const token = host ? undefined : await credential(deps, a);
        let prompt = req.userPrompt;
        for (let pass = 0; ; pass++) {
          a.check();
          let model, text;
          if (host) {
            a.usage.requests++;
            let reply;
            try {
              reply = await abortable(host({ model: req.model ?? deps.config.model, systemPrompt: req.systemPrompt,
                messages: [{ role: "user", content: prompt }], responseFormat: req.schema, reasoning: req.reasoning ?? deps.config.reasoning,
                purpose: req.purpose, signal: a.signal }), a.signal);
            } catch (error) {
              if (record(error)?.code === "LLM_RUNTIME_LIFECYCLE") throw new Fault("lifecycle_reload", "Host runtime reloading");
              throw error;
            }
            a.account({ ...reply.usage, cachedInputTokens: reply.usage?.cacheReadTokens });
            if (reply.stopReason === "error") throw new Fault("provider_error", "Host completion failed");
            if (reply.stopReason === "aborted") throw new Fault("aborted", "Host completion aborted");
            if (reply.stopReason && reply.stopReason !== "stop") throw invalid("Host completion did not finish");
            text = reply.text;
            model = reply.responseModel ?? reply.model;
          } else {
            const reply = await post(deps, a, token!, JSON.stringify({ ...baseRequest(req, deps.config),
              input: [{ role: "user", content: prompt }], text: { format: { type: "json_schema", name: "steward_output",
                schema: req.schema, strict: true } } }), 0);
            text = reply.output.filter(i => i.type === "message" && Array.isArray(i.content))
              .flatMap(i => i.content).map(record).filter(i => i?.type === "output_text" && typeof i.text === "string").map(i => i!.text).join("");
            model = reply.model;
          }
          const data = parse(text);
          if (conforms<T>(req.schema, data)) {
            a.check();
            return { ok: true, data, usage: a.receipt(), model, backend: host ? "host_llm" : "responses_api" };
          }
          if (pass || (req.maxRetries ?? 1) <= 0) throw invalid("Completion does not match schema");
          prompt += "\nYour previous output did not match the schema. Return only a JSON value matching the requested schema.";
        }
      } catch (error) { return a.failure(error); }
      finally { a.close(); }
    },
    run: req => run(deps, req),
  };
}

const SUBMIT = "submit_result";
function submissionSchema(schema: JsonObject) {
  const properties = schema.properties ?? {};
  if ((schema.type !== undefined && schema.type !== "object") || !isRecord(properties) ||
    Object.hasOwn(properties, "status") || (schema.required !== undefined && !Array.isArray(schema.required))) {
    throw invalid("submitSchema must describe an object without a reserved status property");
  }
  return { ...schema, type: "object", additionalProperties: false,
    properties: { ...properties, status: { type: "string", enum: ["complete", "incomplete", "needs_decision"] } },
    required: [...(Array.isArray(schema.required) ? schema.required : []), "status"] };
}

async function run<T>(deps: Deps, req: StewardRunRequest<T>): Promise<StewardRunResult<T>> {
  const a = attempt(req.wallTimeoutMs, req.signal);
  let turns = 0, toolCalls = 0;
  try {
    a.check();
    const maxInput = req.maxInputTokens ?? deps.config.deepThought.maxInputTokens;
    const maxChars = req.maxToolResultChars ?? deps.config.deepThought.maxToolResultChars;
    for (const [name, value] of Object.entries({ maxTurns: req.maxTurns, maxToolCalls: req.maxToolCalls,
      maxInputTokens: maxInput, maxToolResultChars: maxChars, wallTimeoutMs: req.wallTimeoutMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw budget(name);
    }
    const submit = submissionSchema(req.submitSchema);
    const byName = new Map(req.tools.map(tool => [tool.name, tool]));
    if (byName.size !== req.tools.length || byName.has(SUBMIT)) throw invalid("Tool names must be unique and may not shadow submit_result");
    const tools = [...req.tools.map(({ name, description, parameters }) => ({ type: "function", name, description, parameters })),
      { type: "function", name: SUBMIT, description: req.submitDescription ?? "Submit the final structured result.",
        parameters: submit, strict: true }];
    const token = await credential(deps, a);
    const input: JsonObject[] = [{ role: "user", content: req.userPrompt }];
    const seen = new Set<string>();
    let tokensRemaining = maxInput, correcting = false;
    while (turns < req.maxTurns) {
      a.check();
      const body = JSON.stringify({ ...baseRequest(req, deps.config), tools, input, include: ["reasoning.encrypted_content"],
        ...(correcting ? { tool_choice: { type: "function", name: SUBMIT } } : {}) });
      const tokens = o200kTokenCount(body);
      let dispatched = false;
      const reply = await post(deps, a, token, body, 2, () => {
        if (tokens > tokensRemaining) throw budget("maxInputTokens");
        tokensRemaining -= tokens;
        if (!dispatched) { dispatched = true; turns++; }
      });
      // Replay whole output first, including encrypted reasoning; then append one output per call.
      for (const item of reply.output) input.push(item);
      const calls = reply.output.filter(item => item.type === "function_call").map(item => {
        if (typeof item.name !== "string" || typeof item.call_id !== "string" || !item.call_id.trim() || seen.has(item.call_id)) {
          throw invalid("Malformed or duplicate function call ID");
        }
        seen.add(item.call_id);
        return { name: item.name, id: item.call_id, args: parse(item.arguments) };
      });
      if (calls.some(c => c.name === SUBMIT) && calls.length !== 1) throw invalid("Ambiguous final submission");
      if (correcting && (calls.length !== 1 || calls[0]?.name !== SUBMIT)) throw invalid("Missing corrected submit_result");
      if (calls.length > req.maxToolCalls - toolCalls) throw budget("maxToolCalls");
      let needsCorrection = calls.length === 0;
      for (const { name, id, args } of calls) {
        a.check();
        toolCalls++;
        const start = performance.now();
        let ok = false;
        try {
          let output: string;
          if (name === SUBMIT) {
            if (isRecord(args) && conforms<JsonObject & { status: Status }>(submit, args)) {
              const { status, ...data } = args;
              if (conforms<T>(req.submitSchema, data)) {
                a.check();
                ok = true;
                const summary = typeof data.summary === "string" ? data.summary : typeof data.answer === "string" ? data.answer : status;
                return { ok: true, status, data, summary, turns, toolCalls, model: reply.model, usage: a.receipt() };
              }
            }
            output = "Error: final submission did not match the schema.";
            needsCorrection = true;
          } else {
            const tool = byName.get(name);
            if (!tool) output = "Error: unknown tool.";
            else if (!isRecord(args) || !conforms(tool.parameters, args)) output = "Error: invalid tool arguments.";
            else {
              try {
                const result = await abortable(tool.execute(args, a.signal), a.signal);
                output = toolText(result, token, maxChars);
                ok = true;
              } catch {
                a.check();
                output = "Error: tool execution failed.";
              }
            }
          }
          input.push({ type: "function_call_output", call_id: id, output: output.slice(0, maxChars) });
        } finally {
          req.onToolCall?.({ name: redactSecrets(name, token).slice(0, 128), ok, elapsedMs: performance.now() - start });
        }
      }
      if (needsCorrection) {
        if (correcting) throw invalid("Invalid corrected submit_result");
        correcting = true;
        input.push({ role: "user", content: "Call submit_result once with a result matching its schema." });
      }
      if (toolCalls === req.maxToolCalls) throw budget("maxToolCalls");
    }
    throw budget("maxTurns");
  } catch (error) { return { ...a.failure(error), turns, toolCalls }; }
  finally { a.close(); }
}
