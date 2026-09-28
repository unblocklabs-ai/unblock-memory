import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ACTIVE_EVENT_COUNT_SQL, ACTIVE_EVENT_ROWS_SQL, assertAgentTranscriptSchema } from "./agent-transcript.js";
import { messageText } from "./whisperer-context.js";
import { conversationUserText } from "./response-text.js";
import { prepareQueryConversation, QUERY_CONTRACT, QueryInputBudgetError } from "./query-contract.js";
// Window/tokenizer changes must never reuse a previous recipe's checkpoints.
export const TRAINING_PREPARATION = `${QUERY_CONTRACT.version}-visible-history-${QUERY_CONTRACT.revision}`;
export const trainingHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
/** The following answer establishes eligibility, but is never part of that example's input. */
export function trainingExamples(rows, renew) {
    const examples = [];
    const review = [];
    const coverage = { users: 0, filtered: 0, oversized: 0, unanswered: 0 };
    let history = [], limited = false;
    const assistantTexts = new Map();
    let pending;
    let renewedAt = Date.now();
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
    };
    for (const row of rows) {
        if (renew && Date.now() - renewedAt >= 10_000) {
            renew();
            renewedAt = Date.now();
        }
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
            let prepared;
            try {
                prepared = prepareQueryConversation(history, visible.text);
            }
            catch (error) {
                if (!(error instanceof QueryInputBudgetError))
                    throw error;
                coverage.oversized++;
                review.push({ seq: row.seq, reason: "current-request-exceeds-context-budget" });
                boundary();
                continue;
            }
            const input = prepared.conversation;
            const contextLimited = limited || visible.contextLimited || prepared.contextLimited;
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
    return { examples, coverage, review };
}
/** Only active events; no Markdown projections, archived branches, or tool bodies. */
export class TrainingTranscriptReader {
    #db;
    #lineage;
    constructor(path, agentId) {
        this.#db = new DatabaseSync(path, { readOnly: true });
        try {
            this.#db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
            assertAgentTranscriptSchema(this.#db, agentId, "Unsupported training transcript schema or agent");
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
    read(sessionId, renew) {
        this.#db.exec("BEGIN");
        try {
            const session = this.#db.prepare(`SELECT session_key,chat_type ${this.#lineage ?
                ",parent_session_key,spawned_by,plugin_owner_id,hook_external_content_source" : ""}
        FROM session_windows WHERE session_id=?`).get(sessionId);
            if (!session || !["channel", "group", "direct"].includes(String(session.chat_type)) ||
                /:(?:cron|subagent|heartbeat|hook)(?::|$)/i.test(String(session.session_key)) ||
                session.parent_session_key || session.spawned_by || session.plugin_owner_id || session.hook_external_content_source)
                return null;
            const size = this.#db.prepare(ACTIVE_EVENT_COUNT_SQL).get(sessionId);
            if (Number(size.n) > 50_000 || Number(size.bytes) > 32_000_000)
                return { oversized: true };
            const rows = this.#db.prepare(ACTIVE_EVENT_ROWS_SQL).iterate(sessionId);
            return trainingExamples(rows, renew);
        }
        finally {
            this.#db.exec("COMMIT");
        }
    }
    close() { this.#db.close(); }
}
