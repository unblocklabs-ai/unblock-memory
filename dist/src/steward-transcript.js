import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AgentTranscriptReader } from "./agent-transcript.js";
import { DEFAULTS } from "./defaults.js";
import { redactSecrets } from "./expectations-store.js";
import { record } from "./guards.js";
import { classifySyntheticInput, isSyntheticEvidence, syntheticFamilyEnabled } from "./synthetic-input.js";
/**
 * Opens the live agent database read-only inside one snapshot transaction and iterates every session with active-branch
 * events in `[from, to]` whose chat type is not in `excludeChatTypes` (default `["direct"]`), oldest activity first.
 * Returns `empty` when no chat type remains or the database does not exist.
 */
export function readActiveSessionWindows(options, empty, read) {
    const excluded = options.excludeChatTypes ?? ["direct"];
    const chatTypes = ["channel", "group", "direct"].filter(type => !excluded.includes(type));
    if (!chatTypes.length)
        return empty;
    if (!statSync(options.databasePath, { throwIfNoEntry: false }))
        return empty;
    const db = new DatabaseSync(options.databasePath, { readOnly: true });
    try {
        db.exec(`PRAGMA query_only = ON; PRAGMA busy_timeout = ${DEFAULTS.sqlite.mainBusyTimeoutMs}; BEGIN`);
        const reader = new AgentTranscriptReader(db, options.agentId);
        const placeholders = chatTypes.map(() => "?").join(",");
        const identity = options.identity ? `
        COALESCE(w.channel, c.channel) AS provider,
        COALESCE(w.account_id, c.account_id) AS accountId, COALESCE(c.native_direct_user_id, c.peer_id) AS senderId,` : "";
        const windows = db.prepare(`SELECT w.session_id AS sessionId, w.session_key AS sessionKey, w.chat_type AS chatType,
        c.label AS conversationLabel, c.kind AS conversationKind, c.native_channel_id AS nativeChannelId,${identity}
        MAX(e.seq) AS latestSeq, MAX(e.created_at) AS latestAt
      FROM session_windows w
      JOIN session_transcript_active_events a ON a.session_id = w.session_id
      JOIN transcript_events e ON e.session_id = a.session_id AND e.seq = a.event_seq
      LEFT JOIN conversations c ON c.conversation_id = w.primary_conversation_id
      WHERE e.created_at BETWEEN ? AND ? AND w.chat_type IN (${placeholders})
        AND (c.kind IS NULL OR c.kind IN (${placeholders}))
      GROUP BY w.session_id ORDER BY latestAt, w.session_id`)
            .iterate(options.from, options.to, ...chatTypes, ...chatTypes);
        return read(windows, reader);
    }
    finally {
        db.close();
    }
}
/** A `cron` session key is an unattended run whenever the `cron_wrapper` family is filtered. */
export function isCronSessionKey(sessionKey, syntheticInput) {
    return syntheticFamilyEnabled("cron_wrapper", syntheticInput) && /(?:^|:)cron(?=:|$)/iu.test(sessionKey);
}
/**
 * The host-visible text of one parsed transcript event, classified for synthetic input. Only user and assistant messages:
 * never hidden reasoning, and an explicit empty assistant display (`[]`) shows nothing even when raw content exists.
 * `undefined` for anything else, empty text, or text opening with `injectedContext`.
 */
export function visibleTranscriptMessage(parsed, injectedContext, syntheticInput) {
    const event = record(parsed);
    const message = event?.type === "message" ? record(event.message) : undefined;
    if (message?.role !== "user" && message?.role !== "assistant")
        return undefined;
    if (message.role === "assistant" && message.channel === "analysis")
        return undefined;
    const content = message.role === "assistant" && Array.isArray(message.openclawDisplayContent)
        ? message.openclawDisplayContent : message.content;
    const text = (typeof content === "string" ? content : Array.isArray(content)
        ? content.flatMap(value => {
            const block = record(value);
            return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
        }).join("\n") : "").trim();
    if (!text || injectedContext.test(text))
        return undefined;
    const input = classifySyntheticInput({ text, role: message.role,
        inputProvenance: message.inputProvenance ?? message.provenance ?? event?.inputProvenance,
        display: message.display ?? event?.display,
    }, syntheticInput);
    return { role: message.role, input };
}
/**
 * Per-session unattended-turn tracking, fed every visible message in active order. A cron wrapper or a non-alias
 * heartbeat control opens an unattended turn; the next human (non-synthetic) user message closes it. Returns whether
 * the message belongs to an unattended turn.
 */
export function unattendedTurnTracker() {
    let unattended = false;
    return (role, input) => {
        if (role === "user") {
            if (input.family === "cron_wrapper" || (input.family === "heartbeat_control" && input.reason !== "exact_alias"))
                unattended = true;
            else if (!isSyntheticEvidence(input))
                unattended = false;
        }
        return unattended;
    };
}
function clip(text, chars) {
    return text.slice(0, chars).replace(/[\uD800-\uDBFF]$/u, "");
}
/**
 * Consumes a sequence prefix of `candidates` (sorted in place by `seq`) under a per-session character budget (`0` =
 * unlimited), so the watermark never skips a message the budget excluded. Each text is redacted, then clipped to the
 * remaining budget; an empty clip is consumed but not emitted. `maxSeq` is the last consumed sequence (else `seenSeq`).
 */
export function budgetSequencePrefix(candidates, maxChars, seenSeq) {
    const emitted = [];
    let chars = 0, maxSeq = seenSeq;
    for (const candidate of candidates.sort((a, b) => a.seq - b.seq)) {
        const safeText = redactSecrets(candidate.text);
        const remaining = maxChars - chars;
        if (maxChars > 0 && emitted.length && safeText.length > remaining)
            break;
        const text = maxChars > 0 ? clip(safeText, remaining) : safeText;
        if (text)
            emitted.push({ ...candidate, text });
        chars += Math.max(1, text.length);
        maxSeq = candidate.seq;
        if (maxChars > 0 && chars >= maxChars)
            break;
    }
    return { emitted, maxSeq };
}
const OPAQUE_CHANNEL_ID = /^(?:[cdg][0-9a-z]{8,}|\d+)$/iu;
/** A redacted, human-readable channel label (`#name` when present); never for DMs or opaque native ids. */
export function humanChannelLabel(chatType, rawLabel) {
    if (chatType === "direct" || typeof rawLabel !== "string")
        return undefined;
    const cleaned = redactSecrets(rawLabel).replace(/\s+/gu, " ").trim();
    if (!cleaned || cleaned.includes("[redacted]"))
        return undefined;
    const hashMatch = cleaned.match(/#[a-z0-9][a-z0-9._-]*/iu);
    if (hashMatch)
        return hashMatch[0];
    const stripped = cleaned.replace(/^[a-z0-9_-]+:(?:g-)?/iu, "").trim();
    if (!stripped || OPAQUE_CHANNEL_ID.test(stripped))
        return undefined;
    return stripped;
}
