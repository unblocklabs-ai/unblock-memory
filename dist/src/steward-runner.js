import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { abortable, abortedByTimeout } from "./abortable.js";
import { isRecord, record } from "./guards.js";
import { o200kTokenCount } from "./o200k.js";
const json = (schema) => schema;
/** Bounded transient retries per request (408/429/5xx, interrupted streams, connection resets). */
const TRANSIENT_RETRIES = 2;
class Fault extends Error {
    code;
    retryAfterMs;
    constructor(code, message, retryAfterMs = 0) {
        super(message);
        this.code = code;
        this.retryAfterMs = retryAfterMs;
    }
}
const invalid = (message) => new Fault("invalid_output", message);
const budget = (name) => new Fault("budget_exhausted", `Exceeded ${name}`);
function parse(text) {
    if (typeof text !== "string")
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function conforms(schema, value) {
    return value !== undefined && Value.Check(Type.Unsafe(json(schema)), value);
}
/** Validation keywords OpenAI strict mode rejects; stripped from the wire schema only (local checks keep them). */
const STRICT_UNSUPPORTED = new Set(["maxLength", "minLength", "pattern", "minimum", "maximum", "minItems", "maxItems", "format",
    "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "uniqueItems", "minProperties", "maxProperties", "not", "default"]);
const COMBINATORS = ["anyOf", "oneOf", "allOf"];
const jsonType = (value) => value === null ? "null" : Array.isArray(value) ? "array"
    : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
const nullable = (node) => {
    if (Array.isArray(node.type) && node.type.includes("null"))
        return node;
    if (typeof node.type === "string" && !["object", "array", "null"].includes(node.type) && node.enum === undefined &&
        node.const === undefined)
        return { ...node, type: [node.type, "null"] };
    return { anyOf: [node, { type: "null" }] };
};
function strictNode(input, root = false) {
    if (!isRecord(input))
        return input;
    const node = {};
    for (const [key, value] of Object.entries(input))
        if (!STRICT_UNSUPPORTED.has(key))
            node[key] = value;
    if (node.type === undefined && !COMBINATORS.some(c => Array.isArray(node[c])) && typeof node.$ref !== "string") {
        const values = Array.isArray(node.enum) ? node.enum : Object.hasOwn(node, "const") ? [node.const] : undefined;
        const types = values && [...new Set(values.map(jsonType))];
        if (types?.length)
            node.type = types.length === 1 ? types[0] : types;
        else if (root || isRecord(node.properties))
            node.type = "object";
    }
    if (node.type === "object" || isRecord(node.properties)) {
        const properties = isRecord(node.properties) ? node.properties : {};
        const required = new Set(Array.isArray(input.required) ? input.required.filter(k => typeof k === "string") : []);
        node.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
            const strict = strictNode(value);
            return [key, required.has(key) || !isRecord(strict) ? strict : nullable(strict)];
        }));
        node.required = Object.keys(properties);
        node.additionalProperties = false;
    }
    if (Array.isArray(node.items))
        node.items = node.items.map(item => strictNode(item));
    else if (node.items !== undefined)
        node.items = strictNode(node.items);
    for (const c of COMBINATORS)
        if (Array.isArray(node[c]))
            node[c] = node[c].map(branch => strictNode(branch));
    for (const d of ["$defs", "definitions"]) {
        const defs = node[d];
        if (isRecord(defs))
            node[d] = Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, strictNode(v)]));
    }
    return node;
}
/**
 * Wire form of `schema` for OpenAI/codex-lb `strict: true`: every object closes `additionalProperties`, lists
 * every property in `required` (originally optional ones become nullable) and drops unsupported validation
 * keywords. Decode replies with `stripOptionalNulls` and validate them against the ORIGINAL schema.
 */
export function toStrictJsonSchema(schema) {
    return strictNode(json(schema), true);
}
/** Remove the `null`s strict mode forces onto originally optional keys (unless the original accepts null). */
export function stripOptionalNulls(value, schema) {
    const node = json(schema);
    if (value === null || typeof value !== "object")
        return value;
    for (const c of COMBINATORS) {
        const branches = node[c];
        if (!Array.isArray(branches))
            continue;
        for (const branch of branches) {
            if (!isRecord(branch))
                continue;
            const stripped = stripOptionalNulls(value, branch);
            if (conforms(branch, stripped))
                return stripped;
        }
    }
    if (Array.isArray(value))
        return isRecord(node.items) ? value.map(item => stripOptionalNulls(item, node.items)) : value;
    if (!isRecord(node.properties) || !isRecord(value))
        return value;
    const properties = node.properties;
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        const property = properties[key];
        if (item === null && !required.has(key) && isRecord(property) && !conforms(property, null))
            continue;
        out[key] = isRecord(property) ? stripOptionalNulls(item, property) : item;
    }
    return out;
}
/** One deadline and accounting ledger across retries, tools and correction turns. `timeoutMs === 0` means unlimited. */
function attempt(timeoutMs, caller) {
    const controller = new AbortController();
    const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
    const bounded = timeoutMs > 0;
    const deadline = bounded ? performance.now() + timeoutMs : Number.POSITIVE_INFINITY;
    const expire = () => controller.abort(new DOMException("Steward deadline", "TimeoutError"));
    const timer = bounded ? setTimeout(expire, timeoutMs) : undefined;
    const check = () => {
        if (bounded && performance.now() >= deadline)
            expire();
        signal.throwIfAborted();
    };
    const usage = { requests: 0 };
    let reportedCosts = 0, totalCost = 0;
    function account(fields) {
        for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "costUsd"]) {
            const n = fields[key];
            if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
                continue;
            if (key === "costUsd") {
                totalCost += n;
                reportedCosts++;
            }
            else
                usage[key] = (usage[key] ?? 0) + n;
        }
    }
    function receipt() {
        return reportedCosts && reportedCosts === usage.requests ? { ...usage, costUsd: totalCost } : { ...usage };
    }
    function failure(error) {
        const fault = signal.aborted || (bounded && performance.now() >= deadline)
            ? (abortedByTimeout(signal) || !signal.aborted ? new Fault("timeout", "Steward deadline elapsed") : new Fault("aborted", "Steward aborted"))
            : error instanceof Fault ? error : new Fault("provider_error", "Steward request failed");
        return { ok: false, code: fault.code, error: fault.message, retryable: ["lifecycle_reload", "timeout", "transient_provider"].includes(fault.code),
            usage: receipt() };
    }
    return { signal, deadline, check, usage, account, receipt, failure, close: () => { if (timer !== undefined)
            clearTimeout(timer); } };
}
async function credential(deps, a) {
    a.check();
    let token;
    try {
        token = await abortable(deps.resolveApiKey(), a.signal);
    }
    catch { /* Do not expose credential source details. */ }
    a.check();
    if (!token || /\s/u.test(token))
        throw new Fault("missing_credentials", "No usable Steward credential");
    return token;
}
async function envelope(response, signal) {
    const reader = response.body?.getReader();
    if (!reader)
        return undefined;
    const chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await abortable(reader.read(), signal);
            if (done)
                break;
            bytes += value.byteLength;
            if (bytes > 16 * 1024 * 1024)
                throw invalid("Provider response exceeds byte limit");
            chunks.push(value);
        }
    }
    finally {
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
    return record(parse(Buffer.concat(chunks).toString("utf8")));
}
function retryAfter(header) {
    if (!header)
        return 0;
    const n = Number(header);
    return Math.max(0, Number.isFinite(n) ? n * 1000 : Date.parse(header) - Date.now()) || 0;
}
function providerFault(response, body) {
    const err = record(body?.error) ?? body;
    // Inspect classification only; upstream bodies may contain prompts or credentials.
    const detail = [err?.code, err?.type, err?.message, body?.error, record(body?.incomplete_details)?.reason]
        .filter(x => typeof x === "string").join(" ");
    if (/context[_ -](?:length[_ -]exceeded|overflow|window)|exceeds? (?:the )?(?:maximum )?context/i.test(detail)) {
        return new Fault("context_overflow", "Provider context window exceeded");
    }
    if ([401, 403].includes(response.status))
        return new Fault("auth_denied", `Provider denied the credential (HTTP ${response.status})`);
    if (response.status !== 400 && ([408, 429, 500, 502, 503, 504].includes(response.status) ||
        /stream_incomplete|upstream.*clos(?:ed|ing)|stream.*closed/i.test(detail))) {
        return new Fault("transient_provider", "Temporary provider failure", retryAfter(response.headers.get("retry-after")));
    }
    if (!response.ok || body?.error || body?.status === "failed")
        return new Fault("provider_error", `Provider failure (HTTP ${response.status})`);
    if (body?.status !== undefined && body.status !== "completed")
        return invalid("Provider response did not complete");
}
async function post(deps, a, token, body, retries, beforeSend) {
    for (let retry = 0;; retry++) {
        a.check();
        beforeSend?.();
        a.usage.requests++;
        let response;
        try {
            response = await abortable((deps.fetch ?? fetch)(deps.config.endpoint, { method: "POST", redirect: "error", signal: a.signal,
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body }), a.signal);
            const json = await envelope(response, a.signal);
            const u = record(json?.usage);
            a.account({ inputTokens: u?.input_tokens, outputTokens: u?.output_tokens, cachedInputTokens: record(u?.input_tokens_details)?.cached_tokens,
                reasoningTokens: record(u?.output_tokens_details)?.reasoning_tokens, costUsd: u?.cost_usd });
            a.check();
            const fault = providerFault(response, json);
            if (fault)
                throw fault;
            if (!json || !Array.isArray(json.output) || !json.output.every(isRecord))
                throw invalid("Malformed Responses output");
            const output = json.output;
            if (output.some(item => (item.status !== undefined && item.status !== "completed") || item.type === "refusal" ||
                (Array.isArray(item.content) && item.content.some(part => record(part)?.type === "refusal")))) {
                throw invalid("Provider refused or returned unfinished output");
            }
            return { output, model: typeof json.model === "string" ? json.model : undefined };
        }
        catch (error) {
            a.check();
            const fault = error instanceof Fault ? error : (response && providerFault(response)) ??
                new Fault("transient_provider", "Provider connection failed");
            if (fault.code !== "transient_provider" || retry >= retries)
                throw fault;
            const wait = Math.max(fault.retryAfterMs, (1 + Math.random()) * 100 * 2 ** retry);
            if (wait >= a.deadline - performance.now())
                throw fault;
            await delay(wait, undefined, { signal: a.signal });
        }
    }
}
function baseRequest(req, config) {
    const effort = req.reasoning ?? config.reasoning;
    return { model: req.model ?? config.model, instructions: req.systemPrompt, stream: false, store: false,
        ...(effort === "off" ? {} : { reasoning: { effort } }) };
}
function redactSecrets(text, token) {
    return (token ? text.replaceAll(token, "[redacted]") : text).replace(/\bBearer\s+[^\s"',;\]}]+|\b(?:sk-|xox[baprs]-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}/gi, "[redacted]");
}
function toolText(value, token, max) {
    const text = redactSecrets(typeof value === "string" ? value : JSON.stringify(value) ?? "null", token);
    return max <= 0 || text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/u, "");
}
export function createStewardRunner(deps) {
    return {
        async complete(req) {
            const a = attempt(req.timeoutMs ?? deps.config.deepThought.timeoutMs, req.signal);
            try {
                a.check();
                const host = deps.useHostLlm ? deps.hostLlmComplete : undefined;
                const token = host ? undefined : await credential(deps, a);
                const wireSchema = toStrictJsonSchema(req.schema);
                let prompt = redactSecrets(req.userPrompt, token);
                for (let pass = 0;; pass++) {
                    a.check();
                    let model, text;
                    if (host) {
                        a.usage.requests++;
                        let reply;
                        try {
                            reply = await abortable(host({ model: req.model ?? deps.config.model, systemPrompt: req.systemPrompt,
                                messages: [{ role: "user", content: prompt }], responseFormat: json(req.schema), reasoning: req.reasoning ?? deps.config.reasoning,
                                purpose: req.purpose, signal: a.signal }), a.signal);
                        }
                        catch (error) {
                            const code = record(error)?.code;
                            if (code === "LLM_RUNTIME_LIFECYCLE")
                                throw new Fault("lifecycle_reload", "Host runtime reloading");
                            if (code === "LLM_COMPLETION_NOT_AUTHORIZED" || (error instanceof Error && /LLM_COMPLETION_NOT_AUTHORIZED/u.test(error.message))) {
                                throw new Fault("auth_denied", "Host denied the plugin completion");
                            }
                            throw error;
                        }
                        a.account({ ...reply.usage, cachedInputTokens: reply.usage?.cacheReadTokens });
                        if (reply.stopReason === "error")
                            throw new Fault("provider_error", "Host completion failed");
                        if (reply.stopReason === "aborted")
                            throw new Fault("aborted", "Host completion aborted");
                        if (reply.stopReason && reply.stopReason !== "stop")
                            throw invalid("Host completion did not finish");
                        text = reply.text;
                        model = reply.responseModel ?? reply.model;
                    }
                    else {
                        const reply = await post(deps, a, token, JSON.stringify({ ...baseRequest(req, deps.config),
                            input: [{ role: "user", content: prompt }], text: { format: { type: "json_schema", name: "steward_output",
                                    schema: wireSchema, strict: true } } }), TRANSIENT_RETRIES);
                        text = reply.output.filter(i => i.type === "message" && Array.isArray(i.content))
                            .flatMap(i => i.content).map(record).filter(i => i?.type === "output_text" && typeof i.text === "string").map(i => i.text).join("");
                        model = reply.model;
                    }
                    const data = stripOptionalNulls(parse(text), req.schema);
                    if (conforms(req.schema, data)) {
                        a.check();
                        return { ok: true, data, usage: a.receipt(), model, backend: host ? "host_llm" : "responses_api" };
                    }
                    if (pass || (req.maxRetries ?? 1) <= 0)
                        throw invalid("Completion does not match schema");
                    prompt += "\nYour previous output did not match the schema. Return only a JSON value matching the requested schema.";
                }
            }
            catch (error) {
                return a.failure(error);
            }
            finally {
                a.close();
            }
        },
        run: req => run(deps, req),
    };
}
const SUBMIT = "submit_result";
const WRAP_UP = "The investigation budget is exhausted: no further tools are available. Call submit_result now with your best " +
    "answer synthesized ONLY from the evidence already gathered in this conversation, citing only sources you actually " +
    "searched or read. Use status \"incomplete\" if that evidence is insufficient.";
function submissionSchema(input) {
    const schema = json(input);
    const properties = schema.properties ?? {};
    if ((schema.type !== undefined && schema.type !== "object") || !isRecord(properties) ||
        Object.hasOwn(properties, "status") || (schema.required !== undefined && !Array.isArray(schema.required))) {
        throw invalid("submitSchema must describe an object without a reserved status property");
    }
    return { ...schema, type: "object", additionalProperties: false,
        properties: { ...properties, status: { type: "string", enum: ["complete", "incomplete", "needs_decision"] } },
        required: [...(Array.isArray(schema.required) ? schema.required : []), "status"] };
}
async function run(deps, req) {
    const a = attempt(req.wallTimeoutMs, req.signal);
    let turns = 0, toolCalls = 0;
    try {
        a.check();
        const maxInput = req.maxInputTokens ?? deps.config.deepThought.maxInputTokens;
        const maxChars = req.maxToolResultChars ?? deps.config.deepThought.maxToolResultChars;
        const wrapUpReserveMs = req.wrapUpReserveMs ??
            (req.wallTimeoutMs > deps.config.deepThought.wrapUpReserveMs ? deps.config.deepThought.wrapUpReserveMs : 0);
        for (const [name, value] of Object.entries({ maxTurns: req.maxTurns, maxToolCalls: req.maxToolCalls,
            maxInputTokens: maxInput, maxToolResultChars: maxChars, wallTimeoutMs: req.wallTimeoutMs, wrapUpReserveMs })) {
            if (!Number.isSafeInteger(value) || value < 0)
                throw budget(name);
        }
        const submit = submissionSchema(req.submitSchema);
        const byName = new Map(req.tools.map(tool => [tool.name, tool]));
        if (byName.size !== req.tools.length || byName.has(SUBMIT))
            throw invalid("Tool names must be unique and may not shadow submit_result");
        const submitTool = { type: "function", name: SUBMIT, description: req.submitDescription ?? "Submit the final structured result.",
            parameters: toStrictJsonSchema(submit), strict: true };
        const tools = [...req.tools.map(({ name, description, parameters }) => ({ type: "function", name, description, parameters: toStrictJsonSchema(parameters), strict: true })), submitTool];
        const token = await credential(deps, a);
        const input = [{ role: "user", content: redactSecrets(req.userPrompt, token) }];
        const seen = new Set();
        let model;
        /** One model turn. When `maxInputTokens > 0`, it bounds each request body; transient retries resend it uncharged. */
        const send = async (options) => {
            a.check();
            const body = JSON.stringify({ ...baseRequest(req, deps.config), tools: options.only ?? tools, input,
                include: ["reasoning.encrypted_content"], ...(options.forced ? { tool_choice: { type: "function", name: SUBMIT } } : {}) });
            if (maxInput > 0 && o200kTokenCount(body) > maxInput)
                throw budget("maxInputTokens");
            let dispatched = false;
            const reply = await post(deps, a, token, body, TRANSIENT_RETRIES, () => { if (!dispatched) {
                dispatched = true;
                turns++;
            } });
            model = reply.model ?? model;
            // Replay whole output first, including encrypted reasoning; then append one output per call.
            for (const item of reply.output)
                input.push(item);
            return reply.output.filter(item => item.type === "function_call").map(item => {
                if (typeof item.name !== "string" || typeof item.call_id !== "string" || !item.call_id.trim() || seen.has(item.call_id)) {
                    throw invalid("Malformed or duplicate function call ID");
                }
                seen.add(item.call_id);
                return { name: item.name, id: item.call_id, args: parse(item.arguments) };
            });
        };
        const report = (name, ok, elapsedMs) => req.onToolCall?.({ name: redactSecrets(name, token).slice(0, 128), ok, elapsedMs });
        /** Decode a strict-mode submission (optional keys arrive as null) and validate it against the caller's schema. */
        const accept = (args) => {
            const decoded = stripOptionalNulls(args, submit);
            if (!isRecord(decoded) || !conforms(submit, decoded))
                return undefined;
            const { status, ...data } = decoded;
            if (!conforms(req.submitSchema, data))
                return undefined;
            a.check();
            const summary = typeof data.summary === "string" ? data.summary : typeof data.answer === "string" ? data.answer : status;
            return { ok: true, status, data, summary, turns, toolCalls, model, usage: a.receipt() };
        };
        let correcting = false, exhausted;
        for (;;) {
            if (req.maxTurns > 0 && turns >= req.maxTurns) {
                exhausted = "maxTurns";
                break;
            }
            // When a finite wall clock is configured, reserve time for one forced wrap-up turn instead of discarding research.
            if (turns > 0 && Number.isFinite(a.deadline) && wrapUpReserveMs > 0 && a.deadline - performance.now() <= wrapUpReserveMs) {
                exhausted = "wallTimeoutMs";
                break;
            }
            const calls = await send({ forced: correcting });
            if (calls.some(c => c.name === SUBMIT) && calls.length !== 1)
                throw invalid("Ambiguous final submission");
            if (correcting && (calls.length !== 1 || calls[0]?.name !== SUBMIT))
                throw invalid("Missing corrected submit_result");
            // submit_result never counts against maxToolCalls. A batch that would overrun a finite budget executes nothing.
            const nonSubmitCount = calls.filter(c => c.name !== SUBMIT).length;
            if (req.maxToolCalls > 0 && nonSubmitCount > req.maxToolCalls - toolCalls) {
                for (const { id } of calls)
                    input.push({ type: "function_call_output", call_id: id, output: "Error: tool call budget exhausted; not executed." });
                exhausted = "maxToolCalls";
                break;
            }
            let needsCorrection = calls.length === 0;
            if (calls.length === 1 && calls[0].name === SUBMIT) {
                const { name, id, args } = calls[0];
                a.check();
                const start = performance.now();
                const accepted = accept(args);
                if (accepted) {
                    report(name, true, performance.now() - start);
                    return accepted;
                }
                report(name, false, performance.now() - start);
                input.push({ type: "function_call_output", call_id: id, output: "Error: final submission did not match the schema." });
                needsCorrection = true;
            }
            else if (calls.length > 0) {
                // Fan out all tool calls in this turn concurrently; replay outputs and telemetry in deterministic call order.
                toolCalls += calls.length;
                const settled = await Promise.all(calls.map(async ({ name, id, args }) => {
                    a.check();
                    const start = performance.now();
                    let ok = false;
                    let output;
                    const tool = byName.get(name);
                    const decoded = tool && stripOptionalNulls(args, tool.parameters);
                    if (!tool)
                        output = "Error: unknown tool.";
                    else if (!isRecord(decoded) || !conforms(tool.parameters, decoded))
                        output = "Error: invalid tool arguments.";
                    else {
                        try {
                            const result = await abortable(tool.execute(decoded, a.signal), a.signal);
                            output = toolText(result, token, maxChars);
                            ok = true;
                        }
                        catch {
                            a.check();
                            output = "Error: tool execution failed.";
                        }
                    }
                    return { name, id, ok, elapsedMs: performance.now() - start, output: maxChars > 0 ? output.slice(0, maxChars) : output };
                }));
                a.check();
                for (const item of settled) {
                    report(item.name, item.ok, item.elapsedMs);
                    input.push({ type: "function_call_output", call_id: item.id, output: item.output });
                }
            }
            if (needsCorrection) {
                if (correcting)
                    throw invalid("Invalid corrected submit_result");
                correcting = true;
                input.push({ role: "user", content: "Call submit_result once with a result matching its schema." });
            }
            if (req.maxToolCalls > 0 && toolCalls >= req.maxToolCalls) {
                exhausted = "maxToolCalls";
                break;
            }
        }
        // Budget reached without a submission: one forced, submit-only wrap-up turn keeps the research instead of discarding it.
        input.push({ role: "user", content: WRAP_UP });
        const calls = await send({ forced: true, only: [submitTool] });
        const final = calls.length === 1 && calls[0].name === SUBMIT ? calls[0] : undefined;
        const start = performance.now();
        const accepted = final && accept(final.args);
        if (final)
            report(final.name, !!accepted, performance.now() - start);
        if (accepted)
            return accepted;
        throw budget(exhausted);
    }
    catch (error) {
        return { ...a.failure(error), turns, toolCalls };
    }
    finally {
        a.close();
    }
}
