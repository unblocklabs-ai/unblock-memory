import { DEFAULTS } from "./defaults.js";
import { DatabaseSync } from "node:sqlite";
import { AgentTranscriptReader } from "./agent-transcript.js";
import { messageText } from "./whisperer-context.js";
import { responseUserText } from "./response-text.js";
import { jsonHash } from "./json-hash.js";
import { record } from "./guards.js";
export const RESPONSE_EXTRACTOR_VERSION = 7;
const { maxSessionEvents: MAX_EVENTS, maxSessionBytes: MAX_SESSION_BYTES, maxEpisodeChars: MAX_EPISODE_CHARS } = DEFAULTS.responseAudit;
function isApprovedSender(senderIds, senderId) {
    return senderId.trim().length > 0 && (senderIds.includes("*") || senderIds.includes(senderId));
}
function isHumanSender(meta) {
    const identity = record(meta?.senderIdentity);
    return identity?.senderKind !== "bot" && (identity?.senderKind === "human" || meta?.senderIsOwner === true);
}
const IGNORE = { kind: "ignore" };
const BOUNDARY = { kind: "boundary" };
const FILTERED = { kind: "filtered", partialFollowup: false };
/** Classifies one transcript row without touching episode state. */
function classifyEvent(row, session, config) {
    let e;
    try {
        e = record(JSON.parse(row.eventJson));
    }
    catch {
        return FILTERED;
    }
    if (e?.type !== "message") {
        // Compaction/context rewrites cannot silently join unrelated transcript segments.
        return e?.type === "compaction" ? BOUNDARY : IGNORE;
    }
    const m = record(e.message), meta = record(m?.__openclaw);
    if (!m)
        return BOUNDARY;
    if (m.role === "toolResult")
        return IGNORE; // Tool bodies/thinking are never sent.
    if (m.role === "user") {
        const transport = record(meta?.transport);
        const senderId = meta?.senderId;
        if (m.provenance !== undefined || !isHumanSender(meta) ||
            typeof senderId !== "string" || !isApprovedSender(config.senderIds, senderId) ||
            transport?.channel !== "slack" || transport.conversationRef !== session.conversationId) {
            return FILTERED;
        }
        const raw = typeof meta?.upstreamUserText === "string" ? meta.upstreamUserText : messageText(m)?.text;
        const visible = raw ? responseUserText(raw, senderId) : undefined;
        if (!visible)
            return FILTERED;
        const thread = typeof transport.threadId === "string" ? transport.threadId : "";
        return { kind: "user", senderId, thread, text: visible.text, contextLimited: visible.contextLimited };
    }
    if (m.role !== "assistant")
        return FILTERED;
    if (m.provenance !== undefined || meta?.turnTainted === true)
        return FILTERED;
    if (m.provider === "openclaw" && (m.model === "delivery-mirror" || m.model === "gateway-injected")) {
        // Preserve only preceding clean assistant evidence, never the synthetic notice.
        // This is not a completed response and cannot enter the original quality grade.
        return { kind: "filtered", partialFollowup: true };
    }
    if (m.stopReason === "error" || m.stopReason === "aborted")
        return BOUNDARY;
    const memorySearchCalls = Array.isArray(m.content) ? m.content.filter(p => {
        const block = record(p);
        return block?.type === "toolCall" && (block.name === "memory_search" || block.name === "memory_get");
    }).length : 0;
    const text = messageText(m)?.text;
    if (!text || text === "NO_REPLY" || text === "HEARTBEAT_OK" || m.channel === "analysis")
        return { kind: "assistant", memorySearchCalls };
    return { kind: "assistant", memorySearchCalls, reply: {
            text,
            model: typeof m.model === "string" ? m.model : "unknown",
            final: meta?.runTerminal === true || (m.stopReason === "stop" && m.channel !== "commentary"),
        } };
}
/** Never deduce human identity from text or the user role alone. */
export function responseEpisodes(session, rows, config) {
    const coverage = { completedResponses: 0, eligible: 0, noFeedback: 0,
        pendingFeedback: 0, oversized: 0, filteredEvents: 0 };
    const episodes = [];
    let history = [], historyDropped = false;
    let followupTarget;
    const closeFollowup = (safe, partial = false) => {
        if (!followupTarget)
            return;
        if (!safe || !current?.answer.length || (!partial && !current.final))
            followupTarget.followup = { status: "unavailable", messages: [] };
        else if (current.answer.length > DEFAULTS.responseAudit.maxFollowupMessages ||
            JSON.stringify(current.answer).length > DEFAULTS.responseAudit.maxFollowupChars) {
            followupTarget.followup = { status: "oversized", messages: [] };
        }
        else
            followupTarget.followup = { status: partial ? "partial" : "complete", messages: [...current.answer] };
        followupTarget = undefined;
    };
    let current;
    let pending = [];
    const finish = (closed) => {
        if (!current?.final) {
            current = undefined;
            return;
        }
        coverage.completedResponses++;
        if (!current.feedback.length)
            coverage.noFeedback++;
        else if (!closed)
            coverage.pendingFeedback++;
        else if (current.feedback.length > DEFAULTS.responseAudit.maxFeedbackMessages ||
            JSON.stringify(current).length > MAX_EPISODE_CHARS)
            coverage.oversized++;
        else {
            const { final: _final, ...content } = current;
            const id = jsonHash([session.sessionId, current.answer.at(-1).seq]);
            const episode = { id, inputHash: "", session, ...content, followup: { status: "pending", messages: [] } };
            episodes.push(episode);
            followupTarget = episode;
            coverage.eligible++;
        }
        current = undefined;
    };
    const boundary = () => { closeFollowup(false); finish(false); history = []; historyDropped = false; pending = []; };
    const filterOut = () => { coverage.filteredEvents++; boundary(); };
    const remember = (text) => {
        history.push(text);
        if (history.length > config.historyMessages) {
            history.shift();
            historyDropped = true;
        }
    };
    const onUser = (row, event) => {
        const { senderId, thread } = event;
        if ((current && (current.senderId !== senderId || current.thread !== thread)) ||
            pending.some(p => p.senderId !== senderId || p.thread !== thread))
            boundary();
        closeFollowup(true);
        if (event.contextLimited)
            historyDropped = true;
        const text = { seq: row.seq, role: "user", text: event.text };
        if (current) {
            if (!current.final)
                boundary();
            else
                current.feedback.push(text);
        }
        pending.push({ text, senderId, thread });
    };
    const onAssistant = (row, event) => {
        if (pending.length) {
            const request = pending.map(p => p.text), identity = pending[0];
            finish(true);
            current = { request, before: [...history], answer: [], feedback: [], senderId: identity.senderId,
                thread: identity.thread, final: false, timestamp: row.createdAt, model: "unknown",
                memorySearchCalls: 0, contextLimited: historyDropped };
            pending = [];
            request.forEach(remember);
        }
        if (!current)
            return;
        current.memorySearchCalls += event.memorySearchCalls;
        const { reply } = event;
        if (!reply)
            return;
        const item = { seq: row.seq, role: "assistant", text: reply.text };
        current.answer.push(item);
        remember(item);
        current.model = reply.model;
        current.timestamp = row.createdAt;
        current.final ||= reply.final;
    };
    for (const row of rows) {
        const event = classifyEvent(row, session, config);
        switch (event.kind) {
            case "ignore": break;
            case "boundary":
                boundary();
                break;
            case "filtered":
                if (event.partialFollowup)
                    closeFollowup(true, true);
                filterOut();
                break;
            case "user":
                onUser(row, event);
                break;
            case "assistant":
                onAssistant(row, event);
                break;
        }
    }
    if (current?.final)
        closeFollowup(true);
    finish(false); // No next assistant turn: the feedback block may still grow.
    for (const episode of episodes) {
        const { inputHash: _hash, session: s, ...content } = episode;
        episode.inputHash = jsonHash([RESPONSE_EXTRACTOR_VERSION, s.sessionId, s.accountId, s.chatType, s.conversationId, content]);
    }
    return { episodes, coverage };
}
/** Bounded, read-only active transcript snapshot; cold history is deferred, inactive branches excluded. */
export class ResponseTranscriptReader {
    #db;
    #transcripts;
    constructor(path, agentId) {
        this.#db = new DatabaseSync(path, { readOnly: true });
        try {
            this.#db.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${DEFAULTS.sqlite.readerBusyTimeoutMs}`);
            this.#transcripts = new AgentTranscriptReader(this.#db, agentId, "Unsupported response-audit transcript schema or agent");
        }
        catch (error) {
            this.#db.close();
            throw error;
        }
    }
    sessions(config, now, after = "") {
        // Page metadata candidates, then apply the approved-sender filter to decoded
        // events before the audit cap. Unrelated Slack traffic must not hide previews.
        const candidates = this.#db.prepare(`SELECT w.session_id sessionId, COALESCE(w.account_id,c.account_id,'') accountId,
      w.chat_type chatType, w.primary_conversation_id conversationId
      FROM session_windows w JOIN conversations c ON c.conversation_id=w.primary_conversation_id
      WHERE COALESCE(w.channel,c.channel)='slack' AND w.chat_type IN (${config.chatTypes.map(() => "?").join(",")})
      AND w.session_id>?
      AND EXISTS (SELECT 1 FROM transcript_events e JOIN session_transcript_active_events a
        ON a.session_id=e.session_id AND a.event_seq=e.seq WHERE e.session_id=w.session_id AND e.created_at >= ?)
      ORDER BY w.session_id LIMIT 101`);
        const since = now - config.lookbackDays * 86400_000;
        const sessions = [];
        this.#db.exec("BEGIN");
        try {
            while (sessions.length < 101) {
                const page = candidates.all(...config.chatTypes, after, since);
                for (const session of page) {
                    const snapshot = this.#transcripts.read(session.sessionId, { maxEvents: MAX_EVENTS, maxBytes: MAX_SESSION_BYTES });
                    // Saved unavailable sessions are reconciled separately by the caller.
                    if (snapshot.kind !== "ready")
                        continue;
                    const approved = snapshot.rows.some(row => {
                        if (row.createdAt < since)
                            return false;
                        let event;
                        try {
                            event = record(JSON.parse(row.eventJson));
                        }
                        catch {
                            return false;
                        }
                        const message = record(event?.message), meta = record(message?.__openclaw), sender = meta?.senderId;
                        return event?.type === "message" && message?.role === "user" && isHumanSender(meta) &&
                            typeof sender === "string" && isApprovedSender(config.senderIds, sender);
                    });
                    if (approved)
                        sessions.push(session);
                    if (sessions.length === 101)
                        break;
                }
                if (page.length < 101)
                    break;
                after = page.at(-1).sessionId;
            }
            return sessions;
        }
        finally {
            this.#db.exec("COMMIT");
        }
    }
    read(input, config, previousRevision) {
        this.#db.exec("BEGIN");
        try {
            const sessionId = typeof input === "string" ? input : input.sessionId;
            const window = this.#db.prepare(`SELECT w.chat_type chatType,COALESCE(w.channel,c.channel) provider,
        COALESCE(w.account_id,c.account_id,'') accountId,w.primary_conversation_id conversationId
        FROM session_windows w JOIN conversations c ON c.conversation_id=w.primary_conversation_id WHERE w.session_id=?`).get(sessionId);
            if (!window || window.provider !== "slack" || !config.chatTypes.some(type => type === window.chatType) ||
                (typeof input !== "string" && (window.accountId !== input.accountId ||
                    window.conversationId !== input.conversationId || window.chatType !== input.chatType)))
                return null;
            const session = { sessionId, accountId: String(window.accountId),
                conversationId: String(window.conversationId), chatType: String(window.chatType) };
            const snapshot = this.#transcripts.read(session.sessionId, { maxEvents: MAX_EVENTS, maxBytes: MAX_SESSION_BYTES });
            if (snapshot.kind !== "ready")
                return undefined;
            const rows = snapshot.rows;
            // Exact active content catches in-place edits and branch changes even when writer
            // watermarks are absent. Raw text is never retained in the checkpoint database.
            const revision = jsonHash([RESPONSE_EXTRACTOR_VERSION, session, config.historyMessages, [...config.senderIds].sort(), rows]);
            if (revision === previousRevision)
                return { unchanged: true, revision };
            return { ...responseEpisodes(session, rows, config), revision };
        }
        finally {
            this.#db.exec("COMMIT");
        }
    }
    close() { this.#db.close(); }
}
