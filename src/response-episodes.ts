import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ACTIVE_EVENT_COUNT_SQL, ACTIVE_EVENT_ROWS_SQL, assertAgentTranscriptSchema } from "./agent-transcript.js";
import type { ResponseAuditConfig } from "./response-config.js";
import { messageText } from "./whisperer-context.js";
import { responseUserText } from "./response-text.js";

export const RESPONSE_EXTRACTOR_VERSION = 5;
const MAX_EVENTS = 2000, MAX_SESSION_BYTES = 2_000_000, MAX_EPISODE_CHARS = 24_000;
type Row = { seq: number; eventJson: string; createdAt: number };
export type ResponseSession = { sessionId: string; accountId: string; chatType: string; conversationId: string };
type Text = { seq: number; role: "user" | "assistant"; text: string };
export type ResponseEpisode = {
  id: string;
  inputHash: string;
  session: ResponseSession;
  senderId: string;
  thread: string;
  timestamp: number;
  model: string;
  before: Text[];
  request: Text[];
  answer: Text[];
  feedback: Text[];
  followup: { status: "pending" | "complete" | "partial" | "unavailable" | "oversized"; messages: Text[] };
  memorySearchCalls: number;
  contextLimited: boolean;
};
type ResponseCoverage = { completedResponses: number; eligible: number; noFeedback: number;
  pendingFeedback: number; oversized: number; filteredEvents: number };

function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Never deduce human identity from text or the user role alone. */
export function responseEpisodes(session: ResponseSession, rows: readonly Row[], config: ResponseAuditConfig) {
  const coverage: ResponseCoverage = { completedResponses: 0, eligible: 0, noFeedback: 0,
    pendingFeedback: 0, oversized: 0, filteredEvents: 0 };
  const episodes: ResponseEpisode[] = [];
  let history: Text[] = [], historyDropped = false;
  let followupTarget: ResponseEpisode | undefined;
  const closeFollowup = (safe: boolean, partial = false) => {
    if (!followupTarget) return;
    if (!safe || !current?.answer.length || (!partial && !current.final)) followupTarget.followup = { status: "unavailable", messages: [] };
    else if (current.answer.length > 6 || JSON.stringify(current.answer).length > 12_000) {
      followupTarget.followup = { status: "oversized", messages: [] };
    } else followupTarget.followup = { status: partial ? "partial" : "complete", messages: [...current.answer] };
    followupTarget = undefined;
  };
  let current: { request: Text[]; before: Text[]; answer: Text[]; feedback: Text[];
    senderId: string; thread: string; final: boolean; timestamp: number; model: string;
    memorySearchCalls: number; contextLimited: boolean } | undefined;
  let pending: { text: Text; senderId: string; thread: string }[] = [];
  const finish = (closed: boolean) => {
    if (!current?.final) { current = undefined; return; }
    coverage.completedResponses++;
    if (!current.feedback.length) coverage.noFeedback++;
    else if (!closed) coverage.pendingFeedback++;
    else if (current.feedback.length > 6 || JSON.stringify(current).length > MAX_EPISODE_CHARS) coverage.oversized++;
    else {
      const { final: _final, ...content } = current;
      const id = hash([session.sessionId, current.answer.at(-1)!.seq]);
      const episode: ResponseEpisode = { id, inputHash: "", session, ...content, followup: { status: "pending", messages: [] } };
      episodes.push(episode);
      followupTarget = episode;
      coverage.eligible++;
    }
    current = undefined;
  };
  const boundary = () => { closeFollowup(false); finish(false); history = []; historyDropped = false; pending = []; };
  const remember = (text: Text) => {
    history.push(text);
    if (history.length > config.historyMessages) { history.shift(); historyDropped = true; }
  };
  for (const row of rows) {
    let e: Record<string, unknown> | undefined;
    try { e = record(JSON.parse(row.eventJson)); } catch { coverage.filteredEvents++; boundary(); continue; }
    if (e?.type !== "message") {
      // Compaction/context rewrites cannot silently join unrelated transcript segments.
      if (e?.type === "compaction") boundary();
      continue;
    }
    const m = record(e.message), meta = record(m?.__openclaw);
    if (!m) { boundary(); continue; }
    if (m.role === "toolResult") continue; // Tool bodies/thinking are never sent.
    if (m.role === "user") {
      const identity = record(meta?.senderIdentity), transport = record(meta?.transport);
      const senderId = meta?.senderId;
      const human = identity?.senderKind !== "bot" && (identity?.senderKind === "human" || meta?.senderIsOwner === true);
      if (m.provenance !== undefined || !human ||
          typeof senderId !== "string" || !config.senderIds.includes(senderId) ||
          transport?.channel !== "slack" || transport.conversationRef !== session.conversationId) {
        coverage.filteredEvents++; boundary(); continue;
      }
      const raw = typeof meta?.upstreamUserText === "string" ? meta.upstreamUserText : messageText(m)?.text;
      const visible = raw ? responseUserText(raw, senderId) : undefined;
      if (!visible) { coverage.filteredEvents++; boundary(); continue; }
      const thread = typeof transport.threadId === "string" ? transport.threadId : "";
      if ((current && (current.senderId !== senderId || current.thread !== thread)) ||
          pending.some(p => p.senderId !== senderId || p.thread !== thread)) boundary();
      closeFollowup(true);
      if (visible.contextLimited) historyDropped = true;
      const text: Text = { seq: row.seq, role: "user", text: visible.text };
      if (current) {
        if (!current.final) boundary();
        else current.feedback.push(text);
      }
      pending.push({ text, senderId, thread });
      continue;
    }
    if (m.role !== "assistant") { coverage.filteredEvents++; boundary(); continue; }
    if (m.provenance !== undefined || meta?.turnTainted === true) { coverage.filteredEvents++; boundary(); continue; }
    if (m.provider === "openclaw" && (m.model === "delivery-mirror" || m.model === "gateway-injected")) {
      // Preserve only preceding clean assistant evidence, never the synthetic notice.
      // This is not a completed response and cannot enter the original quality grade.
      closeFollowup(true, true);
      coverage.filteredEvents++; boundary(); continue;
    }
    if (pending.length) {
      const request = pending.map(p => p.text), identity = pending[0]!;
      finish(true);
      current = { request, before: [...history], answer: [], feedback: [], senderId: identity.senderId,
        thread: identity.thread, final: false, timestamp: row.createdAt, model: "unknown",
        memorySearchCalls: 0, contextLimited: historyDropped };
      pending = [];
      request.forEach(remember);
    }
    if (!current) continue;
    if (meta?.turnTainted === true || m.stopReason === "error" || m.stopReason === "aborted") { boundary(); continue; }
    if (Array.isArray(m.content)) {
      current.memorySearchCalls += m.content.filter(p => {
        const block = record(p);
        return block?.type === "toolCall" && (block.name === "memory_search" || block.name === "memory_get");
      }).length;
    }
    const text = messageText(m)?.text;
    if (!text || text === "NO_REPLY" || text === "HEARTBEAT_OK" || m.channel === "analysis") continue;
    const item: Text = { seq: row.seq, role: "assistant", text };
    current.answer.push(item);
    remember(item);
    current.model = typeof m.model === "string" ? m.model : "unknown";
    current.timestamp = row.createdAt;
    current.final = meta?.runTerminal === true || (m.stopReason === "stop" && m.channel !== "commentary");
  }
  if (current?.final) closeFollowup(true);
  finish(false); // No next assistant turn: the feedback block may still grow.
  for (const episode of episodes) {
    const { inputHash: _hash, session: s, ...content } = episode;
    episode.inputHash = hash([RESPONSE_EXTRACTOR_VERSION, s.sessionId, s.accountId, s.chatType, s.conversationId, content]);
  }
  return { episodes, coverage };
}

/** Bounded, read-only active transcript snapshot; archived/deleted branches are excluded. */
export class ResponseTranscriptReader {
  readonly #db: DatabaseSync;
  constructor(path: string, agentId: string) {
    this.#db = new DatabaseSync(path, { readOnly: true });
    try {
      this.#db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
      assertAgentTranscriptSchema(this.#db, agentId, "Unsupported response-audit transcript schema or agent");
    } catch (error) { this.#db.close(); throw error; }
  }
  sessions(config: ResponseAuditConfig, now: number, after = "") {
    return this.#db.prepare(`SELECT w.session_id sessionId, COALESCE(w.account_id,c.account_id,'') accountId,
      w.chat_type chatType, w.primary_conversation_id conversationId
      FROM session_windows w JOIN conversations c ON c.conversation_id=w.primary_conversation_id
      WHERE COALESCE(w.channel,c.channel)='slack' AND w.chat_type IN (${config.chatTypes.map(() => "?").join(",")})
      AND w.session_id>?
      AND EXISTS (SELECT 1 FROM transcript_events e JOIN session_transcript_active_events a
        ON a.session_id=e.session_id AND a.event_seq=e.seq WHERE e.session_id=w.session_id AND e.created_at >= ?
        AND json_extract(e.event_json,'$.message.role')='user'
        AND json_extract(e.event_json,'$.message.__openclaw.senderId') IN (${config.senderIds.map(() => "?").join(",")}))
      ORDER BY w.session_id LIMIT 101`)
      .all(...config.chatTypes, after, now - config.lookbackDays * 86400_000, ...config.senderIds) as ResponseSession[];
  }
  /** null = confirmed absent/ineligible; undefined = over budget, not evidence of deletion. */
  read(input: ResponseSession | string, config: ResponseAuditConfig): (ReturnType<typeof responseEpisodes> & { revision: string }) | null | undefined;
  read(input: ResponseSession | string, config: ResponseAuditConfig, previousRevision: string | undefined):
    (ReturnType<typeof responseEpisodes> & { revision: string }) | { unchanged: true; revision: string } | null | undefined;
  read(input: ResponseSession | string, config: ResponseAuditConfig, previousRevision?: string) {
    this.#db.exec("BEGIN");
    try {
      const sessionId = typeof input === "string" ? input : input.sessionId;
      const window = this.#db.prepare(`SELECT w.chat_type chatType,COALESCE(w.channel,c.channel) provider,
        COALESCE(w.account_id,c.account_id,'') accountId,w.primary_conversation_id conversationId
        FROM session_windows w JOIN conversations c ON c.conversation_id=w.primary_conversation_id WHERE w.session_id=?`).get(sessionId);
      if (!window || window.provider !== "slack" || !config.chatTypes.some(type => type === window.chatType) ||
          (typeof input !== "string" && (window.accountId !== input.accountId ||
            window.conversationId !== input.conversationId || window.chatType !== input.chatType))) return null;
      const session: ResponseSession = { sessionId, accountId: String(window.accountId),
        conversationId: String(window.conversationId), chatType: String(window.chatType) };
      const count = this.#db.prepare(ACTIVE_EVENT_COUNT_SQL).get(session.sessionId)!;
      if (Number(count.n) > MAX_EVENTS || Number(count.bytes) > MAX_SESSION_BYTES) return undefined;
      const rows = this.#db.prepare(ACTIVE_EVENT_ROWS_SQL).all(session.sessionId) as Row[];
      // Exact active content catches in-place edits and branch changes even when writer
      // watermarks are absent. Raw text is never retained in the checkpoint database.
      const revision = hash([RESPONSE_EXTRACTOR_VERSION, session, config.historyMessages, [...config.senderIds].sort(), rows]);
      if (revision === previousRevision) return { unchanged: true as const, revision };
      return { ...responseEpisodes(session, rows, config), revision };
    } finally { this.#db.exec("COMMIT"); }
  }
  close() { this.#db.close(); }
}
