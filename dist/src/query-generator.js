import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { abortable, abortedByTimeout } from "./abortable.js";
import { messageText } from "./whisperer-context.js";
import { CONVERSATION_INFO, queryUserText } from "./response-text.js";
import { parseQueryPair, prepareQueryConversation } from "./query-contract.js";
import { nonBlank, record } from "./guards.js";
/** Preserve whole visible messages and the complete current request, never tool/thinking text. */
export function queryConversation(prompt, messages, currentUserMessage) {
    const currentRequest = queryUserText(currentUserMessage !== undefined ? currentUserMessage : prompt) ?? "";
    const visible = [];
    const assistantTexts = new Map();
    for (const item of messages) {
        const event = record(item), message = record(event?.type === "message" ? event.message : item);
        if (event?.type === "compaction" || message?.role === "compactionSummary") {
            visible.length = 0;
            assistantTexts.clear();
            continue;
        }
        if (!message || message.role === "toolResult" || message.role === "tool")
            continue;
        const meta = record(message.__openclaw);
        if (message.provenance !== undefined || (message.role === "user" && record(meta?.senderIdentity)?.senderKind === "bot")) {
            visible.length = 0;
            assistantTexts.clear();
            continue;
        }
        const mirror = message.provider === "openclaw" && message.model === "delivery-mirror";
        if (message.role === "assistant" && (message.channel === "analysis" || message.stopReason === "error" ||
            message.stopReason === "aborted" || (message.provider === "openclaw" && message.model === "gateway-injected") ||
            (mirror && record(message.openclawDeliveryMirror)?.kind === "channel-final-suppressed")))
            continue;
        const text = messageText(message);
        const sender = nonBlank(meta?.senderId) ?? nonBlank(message.senderId);
        const upstream = typeof meta?.upstreamUserText === "string" ? meta.upstreamUserText : undefined;
        const content = text?.role === "user"
            ? (upstream ? queryUserText(upstream, sender) : undefined) ??
                // Fall back to canonical message.content only when upstreamUserText is absent or has a decorated non-envelope prefix,
                // never to bypass a rejected Conversation info envelope.
                (upstream && CONVERSATION_INFO.test(upstream.trim()) ? undefined : (text.text ? queryUserText(text.text, sender) : undefined))
            : text?.text;
        if (message.role === "user") {
            assistantTexts.clear();
            if (!content || /^(?:\[cron:|\[OpenClaw heartbeat poll\]|\[Inter-session message\]|\[Queued messages while agent was busy\]|\[Subagent Context\]|<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>|<relevant-memories>|<unblock_memory>|<conversation_context>)/.test(content)) {
                visible.length = 0;
                continue;
            }
        }
        if (!text || !content || (text.role === "assistant" && (content === "NO_REPLY" || content === "HEARTBEAT_OK")))
            continue;
        if (text.role === "assistant") {
            const previous = assistantTexts.get(content);
            assistantTexts.set(content, mirror);
            if (previous !== undefined && (mirror || previous))
                continue;
        }
        visible.push({ role: text.role, content });
    }
    const last = visible.at(-1);
    if (last?.role === "user" && last.content.replaceAll("\r\n", "\n") === currentRequest.replaceAll("\r\n", "\n"))
        visible.pop();
    return prepareQueryConversation(visible, currentRequest).conversation;
}
const FALLBACK_STOP_WORDS = new Set(("a about all also am an and any are as at be been before being but by can could did do does doing done " +
    "for from get got had has have having he her here hers him his how i if in into is it its just know " +
    "like make may me more most my no not now of on one only or other our out over please said say see " +
    "she should so some still such than that the their them then there these they think this those through " +
    "to too under up very was we were what whats when where which who why will with would you your").split(" "));
const MAX_FALLBACK_LEX_TERMS = 12;
const MAX_FALLBACK_TERM_CHARS = 64;
const MAX_FALLBACK_LEX_CHARS = 256;
const MAX_FALLBACK_VEC_CHARS = 450;
const MAX_JUDGE_HISTORY_MESSAGES = 2;
const MAX_JUDGE_CONVERSATION_CHARS = 1_500;
const MIN_COMPACT_HISTORY_CHARS = 80;
function sliceHeadSafe(text, maxChars) {
    if (maxChars <= 0)
        return "";
    if (text.length <= maxChars)
        return text;
    let end = maxChars;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff)
        end--;
    return text.slice(0, end);
}
function sliceTailSafe(text, maxChars) {
    if (maxChars <= 0)
        return "";
    if (text.length <= maxChars)
        return text;
    let start = text.length - maxChars;
    const first = text.charCodeAt(start);
    if (first >= 0xdc00 && first <= 0xdfff)
        start++;
    return text.slice(start);
}
function extractFallbackTerms(text) {
    const seen = new Set();
    const terms = [];
    for (const token of text.match(/[\p{L}\p{N}_]+/gu) ?? []) {
        const lower = token.toLowerCase();
        if (token.length > MAX_FALLBACK_TERM_CHARS || (lower.length === 1 && /^[a-z]$/u.test(lower)) ||
            seen.has(lower) || FALLBACK_STOP_WORDS.has(lower))
            continue;
        seen.add(lower);
        terms.push(token);
        if (terms.length >= MAX_FALLBACK_LEX_TERMS)
            break;
    }
    return terms;
}
function joinBoundedTerms(tokens) {
    const parts = [];
    let length = 0;
    for (const token of tokens) {
        const bounded = sliceHeadSafe(token, MAX_FALLBACK_TERM_CHARS);
        if (!bounded)
            continue;
        const added = bounded.length + (parts.length ? 1 : 0);
        if (length + added > MAX_FALLBACK_LEX_CHARS)
            break;
        parts.push(bounded);
        length += added;
    }
    return parts.join(" ");
}
/** Deterministic query pair used when the resident query API fails or times out. */
export function fallbackQueries(conversation) {
    const request = conversation.currentRequest.trim();
    if (!request)
        throw new Error("Missing or unparseable current request");
    const requestTerms = extractFallbackTerms(request);
    const terms = [...requestTerms];
    const seen = new Set(terms.map(term => term.toLowerCase()));
    const recentUsers = conversation.history.filter(message => message.role === "user").slice(-2);
    if (terms.length < 4) {
        for (let index = recentUsers.length - 1; index >= 0 && terms.length < MAX_FALLBACK_LEX_TERMS; index--) {
            for (const token of extractFallbackTerms(recentUsers[index].content)) {
                const lower = token.toLowerCase();
                if (seen.has(lower))
                    continue;
                seen.add(lower);
                terms.push(token);
                if (terms.length >= MAX_FALLBACK_LEX_TERMS)
                    break;
            }
        }
    }
    const rawTokens = [...new Set((request.match(/[\p{L}\p{N}_]+/gu) ?? [])
            .map(token => sliceHeadSafe(token, MAX_FALLBACK_TERM_CHARS).toLowerCase())
            .filter(Boolean))].slice(0, MAX_FALLBACK_LEX_TERMS);
    const lex = (joinBoundedTerms(terms) || joinBoundedTerms(rawTokens) || sliceHeadSafe(request, MAX_FALLBACK_LEX_CHARS)).trim();
    const vecSource = requestTerms.length < 4 && recentUsers.length
        ? `${recentUsers.at(-1).content.trim()}\n${request}`
        : request;
    const vec = (vecSource.length <= MAX_FALLBACK_VEC_CHARS
        ? vecSource
        : request.length >= MAX_FALLBACK_VEC_CHARS
            ? sliceHeadSafe(request, MAX_FALLBACK_VEC_CHARS)
            : sliceTailSafe(vecSource, MAX_FALLBACK_VEC_CHARS)).trim();
    return { lex, vec };
}
function clampHeadTail(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const ellipsis = "\n…\n";
    const half = Math.floor((maxChars - ellipsis.length) / 2);
    return `${sliceHeadSafe(text, half).trimEnd()}${ellipsis}${sliceTailSafe(text, half).trimStart()}`;
}
/** Bound conversation context repeated across automatic passage usefulness judgments. */
export function compactJudgeConversation(conversation) {
    const currentRequest = clampHeadTail(conversation.currentRequest, MAX_JUDGE_CONVERSATION_CHARS);
    let remaining = MAX_JUDGE_CONVERSATION_CHARS - currentRequest.length;
    const history = [];
    for (let index = conversation.history.length - 1; index >= 0 && history.length < MAX_JUDGE_HISTORY_MESSAGES && remaining > 0; index--) {
        const message = conversation.history[index];
        if (message.content.length <= remaining) {
            history.unshift(message);
            remaining -= message.content.length;
        }
        else if (remaining >= MIN_COMPACT_HISTORY_CHARS) {
            history.unshift({ role: message.role, content: clampHeadTail(message.content, remaining) });
            remaining = 0;
        }
        else {
            break;
        }
    }
    return { history, currentRequest };
}
export class QueryApiError extends Error {
    code;
    status;
    constructor(code, status) {
        super(`Query API ${code}`);
        this.code = code;
        this.status = status;
        this.name = "QueryApiError";
    }
}
function throwIfQueryAborted(signal) {
    if (abortedByTimeout(signal))
        throw new QueryApiError("timeout");
    signal.throwIfAborted();
}
/** The host owns model warmth/lifecycle; the plugin only sends bounded, cancellable requests. */
export class ApiQueryGenerator {
    config;
    constructor(config) {
        this.config = config;
    }
    async generate(conversation, signal) {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
        throwIfQueryAborted(requestSignal);
        if (!this.config.apiKeyFile)
            throw new QueryApiError("credentials");
        let token;
        try {
            token = (await readFile(this.config.apiKeyFile, { encoding: "utf8", signal: requestSignal })).trim();
        }
        catch {
            if (abortedByTimeout(requestSignal))
                throw new QueryApiError("timeout");
            throw new QueryApiError("credentials");
        }
        if (!token || /\s/u.test(token))
            throw new QueryApiError("credentials");
        throwIfQueryAborted(requestSignal);
        const id = randomUUID();
        let response;
        try {
            response = await fetch(`${this.config.endpoint}/generate`, {
                method: "POST", redirect: "error", signal: requestSignal,
                headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ id, conversation }),
            });
        }
        catch {
            if (abortedByTimeout(requestSignal))
                throw new QueryApiError("timeout");
            throw new QueryApiError("unavailable");
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => { });
            throw new QueryApiError("http_error", response.status);
        }
        // Bound even chunked responses; never log or retain provider errors or prompt payloads.
        const reader = response.body?.getReader();
        if (!reader)
            throw new QueryApiError("invalid_response");
        try {
            const chunks = [];
            let size = 0;
            for (;;) {
                const { done, value } = await abortable(reader.read(), requestSignal);
                if (done)
                    break;
                size += value.byteLength;
                if (size > 16_384)
                    throw new QueryApiError("invalid_response");
                chunks.push(value);
            }
            throwIfQueryAborted(requestSignal);
            const envelope = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            const result = record(envelope?.response);
            if (result?.id !== id || typeof result.text !== "string" || result.error !== undefined) {
                throw new QueryApiError("invalid_response");
            }
            return parseQueryPair(JSON.parse(result.text));
        }
        catch (error) {
            if (error instanceof QueryApiError)
                throw error;
            if (abortedByTimeout(requestSignal))
                throw new QueryApiError("timeout");
            throw new QueryApiError("invalid_response");
        }
        finally {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
        }
    }
}
