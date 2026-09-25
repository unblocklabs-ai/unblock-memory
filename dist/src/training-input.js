import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { messageText } from "./whisperer-context.js";
import { conversationUserText } from "./response-text.js";
// Identical serialized inputs keep their checkpoints when eligibility broadens.
export const TRAINING_PREPARATION = "visible-history-v1";
// A deliberately conservative byte budget, NOT a tokenizer or a 32k-token target.
const MAX_INPUT_BYTES = 24_000, MAX_HISTORY_MESSAGES = 32;
export const trainingHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
/** The following answer establishes eligibility, but is never part of that example's input. */
export function trainingExamples(rows) {
    const examples = [];
    const coverage = { users: 0, filtered: 0, oversized: 0, unanswered: 0 };
    let history = [], limited = false;
    const assistantTexts = new Map();
    let pending;
    const boundary = () => {
        if (pending)
            coverage.unanswered++;
        pending = undefined;
        history = [];
        limited = true;
        assistantTexts.clear();
    };
    const remember = (role, content) => {
        history.push({ role, content });
        while (history.length > MAX_HISTORY_MESSAGES || Buffer.byteLength(JSON.stringify(history)) > MAX_INPUT_BYTES) {
            history.shift();
            limited = true;
        }
    };
    for (const row of rows) {
        let event;
        try {
            event = record(JSON.parse(row.eventJson));
        }
        catch {
            coverage.filtered++;
            boundary();
            continue;
        }
        if (event?.type !== "message") {
            if (event?.type === "compaction")
                boundary();
            continue;
        }
        const message = record(event.message), meta = record(message?.__openclaw);
        if (!message) {
            boundary();
            continue;
        }
        if (message.role === "toolResult")
            continue;
        if (message.provenance !== undefined) {
            coverage.filtered++;
            boundary();
            continue;
        }
        if (message.role === "user") {
            coverage.users++;
            if (record(meta?.senderIdentity)?.senderKind === "bot") {
                coverage.filtered++;
                boundary();
                continue;
            }
            const raw = typeof meta?.upstreamUserText === "string" ? meta.upstreamUserText : messageText(message)?.text;
            const visible = raw ? conversationUserText(raw, meta?.senderId ?? message.senderId) : undefined;
            if (!visible || /^(?:\[OpenClaw heartbeat poll\]|\[Queued messages while agent was busy\]|\[Subagent Context\]|<relevant-memories>)/.test(visible.text)) {
                coverage.filtered++;
                boundary();
                continue;
            }
            if (pending)
                coverage.unanswered++;
            pending = undefined;
            assistantTexts.clear();
            const input = { history: [...history], currentRequest: visible.text };
            let contextLimited = limited || visible.contextLimited;
            while (input.history.length && Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) {
                input.history.shift();
                contextLimited = true;
            }
            if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) {
                coverage.oversized++;
                boundary();
                continue;
            }
            const eventTime = typeof event.timestamp === "string" ? Date.parse(event.timestamp) :
                typeof event.timestamp === "number" ? event.timestamp : NaN;
            // A delayed database append must not move the historical retrieval boundary forward.
            const timestamp = Number.isFinite(eventTime) ? Math.min(row.createdAt, eventTime) : row.createdAt;
            pending = { seq: row.seq, timestamp, input,
                inputHash: trainingHash([TRAINING_PREPARATION, input]), contextLimited };
            remember("user", visible.text);
            continue;
        }
        const mirror = message.provider === "openclaw" && message.model === "delivery-mirror";
        if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted" ||
            (message.provider === "openclaw" && message.model === "gateway-injected") ||
            (mirror && record(message.openclawDeliveryMirror)?.kind === "channel-final-suppressed")) {
            coverage.filtered++;
            continue;
        }
        const hasToolCall = Array.isArray(message.content) && message.content.some(part => record(part)?.type === "toolCall");
        const text = message.channel === "analysis" ? undefined : messageText(message)?.text;
        const visible = text && text !== "NO_REPLY" && text !== "HEARTBEAT_OK" ? text : undefined;
        if (!visible && !hasToolCall)
            continue;
        if (pending) {
            examples.push(pending);
            pending = undefined;
        }
        // A reply and its persisted delivery mirror are one visible history message.
        if (visible) {
            const previous = assistantTexts.get(visible);
            if (previous === undefined || (!mirror && !previous))
                remember("assistant", visible);
            assistantTexts.set(visible, mirror);
        }
    }
    if (pending)
        coverage.unanswered++;
    return { examples, coverage };
}
/** Only active events; no Markdown projections, archived branches, or tool bodies. */
export class TrainingTranscriptReader {
    #db;
    #lineage;
    constructor(path, agentId) {
        this.#db = new DatabaseSync(path, { readOnly: true });
        try {
            this.#db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
            const version = this.#db.prepare("PRAGMA user_version").get()?.user_version;
            const meta = this.#db.prepare("SELECT role,agent_id,schema_version FROM schema_meta WHERE meta_key='primary'").get();
            if (![17, 18, 19].includes(Number(version)) || meta?.role !== "agent" || meta.agent_id !== agentId || meta.schema_version !== version) {
                throw new Error("Unsupported training transcript schema or agent");
            }
            const columns = this.#db.prepare("PRAGMA table_info(session_windows)").all().map(c => c.name);
            this.#lineage = ["parent_session_key", "spawned_by", "plugin_owner_id", "hook_external_content_source"].every(c => columns.includes(c));
        }
        catch (error) {
            this.#db.close();
            throw error;
        }
    }
    sessions() {
        return this.#db.prepare("SELECT session_id FROM session_windows ORDER BY session_id").all().map(row => String(row.session_id));
    }
    /** null = absent/ineligible. Oversized sessions are not evidence of deletion. */
    read(sessionId) {
        this.#db.exec("BEGIN");
        try {
            const session = this.#db.prepare(`SELECT session_key,chat_type ${this.#lineage ?
                ",parent_session_key,spawned_by,plugin_owner_id,hook_external_content_source" : ""}
        FROM session_windows WHERE session_id=?`).get(sessionId);
            if (!session || !["channel", "group", "direct"].includes(String(session.chat_type)) ||
                /:(?:cron|subagent|heartbeat|hook)(?::|$)/i.test(String(session.session_key)) ||
                session.parent_session_key || session.spawned_by || session.plugin_owner_id || session.hook_external_content_source)
                return null;
            const size = this.#db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(length(e.event_json)),0) bytes
        FROM session_transcript_active_events a JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq
        WHERE a.session_id=?`).get(sessionId);
            if (Number(size.n) > 50_000 || Number(size.bytes) > 32_000_000)
                return { oversized: true };
            const rows = this.#db.prepare(`SELECT e.seq,e.event_json eventJson,e.created_at createdAt
        FROM session_transcript_active_events a JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq
        WHERE a.session_id=? ORDER BY a.active_position`).iterate(sessionId);
            return trainingExamples(rows);
        }
        finally {
            this.#db.exec("COMMIT");
        }
    }
    close() { this.#db.close(); }
}
