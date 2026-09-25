import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { queryConversation } from "../../src/mlx-query.js";
import { messageText } from "../../src/whisperer-context.js";
import { conversationUserText } from "../../src/response-text.js";

export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
type Row = { seq: number; eventJson: string; createdAt: number; activePosition: number };
export type SearchCase = {
  id: string; sessionId: string; sessionKey: string; chatType: string; eventSeq: number; callId: string;
  query: string; searchedAt: string; requestedCorpora?: string[]; originalMaxResults?: number;
  userEventSeq?: number; userTimestamp?: string; conversation?: ReturnType<typeof queryConversation>;
  truncated?: boolean; contextError?: string;
};

/** Freeze context at the human turn, never use this turn's later answer or tool output. */
export function searchesInSession(rows: Iterable<Row>, session: { sessionId: string; sessionKey: string; chatType: string }, historyMessages: number) {
  const results: SearchCase[] = [], history: { role: "user" | "assistant"; content: string }[] = [];
  let context: Pick<SearchCase, "userEventSeq" | "userTimestamp" | "conversation" | "truncated" | "contextError"> = { contextError: "no_user_context" };
  const seenCalls = new Set<string>(), mirrorTexts = new Set<string>();
  for (const row of rows) {
    let event: Record<string, unknown> | undefined;
    try { event = record(JSON.parse(row.eventJson)); } catch { history.length = 0; context = { contextError: "invalid_event" }; continue; }
    if (event?.type === "compaction") { history.length = 0; context = { contextError: "compaction_boundary" }; continue; }
    if (event?.type !== "message") continue;
    const message = record(event.message), meta = record(message?.__openclaw);
    if (!message) continue;
    if (message.role === "user") {
      mirrorTexts.clear();
      // The host stores canonical human text separately from the actual upstream
      // prompt, which can contain old whisperer prefixes/suffixes. Never grade those.
      const visible = messageText(message)?.text;
      const upstream = typeof meta?.upstreamUserText === "string" ? meta.upstreamUserText : undefined;
      const user = !message.provenance && record(meta?.senderIdentity)?.senderKind !== "bot"
        ? (visible ? conversationUserText(visible, meta?.senderId) : undefined) ??
          (upstream ? conversationUserText(upstream, meta?.senderId) : undefined) : undefined;
      if (!user || /^(?:\[OpenClaw heartbeat poll\]|\[Queued messages while agent was busy\]|\[Subagent Context\])/.test(user.text)) {
        context = { contextError: "ineligible_user_context" }; history.length = 0; continue;
      }
      const timestamp = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : row.createdAt;
      context = { userEventSeq: row.seq, userTimestamp: new Date(Number.isFinite(timestamp) ? Math.min(timestamp, row.createdAt) : row.createdAt).toISOString() };
      try {
        const conversation = queryConversation(user.text, history, historyMessages);
        context = { ...context, conversation, truncated: user.contextLimited || history.length > conversation.history.length };
      } catch { context.contextError = "query_context_unavailable_or_oversized"; }
      history.push({ role: "user", content: user.text });
      continue;
    }
    if (message.role !== "assistant" || message.provenance || ["error", "aborted"].includes(String(message.stopReason)) ||
        message.model === "gateway-injected" || message.model === "delivery-mirror") continue;
    for (const value of Array.isArray(message.content) ? message.content : []) {
      const call = record(value), args = record(call?.arguments) ?? record(call?.input);
      if (call?.type !== "toolCall" || call.name !== "memory_search" || typeof args?.query !== "string") continue;
      const callId = typeof call.id === "string" ? call.id : `${row.seq}:${results.length}`;
      if (seenCalls.has(callId)) continue;
      seenCalls.add(callId);
      results.push({ ...session, ...context, id: hash([session.sessionId, callId]), eventSeq: row.seq, callId,
        query: args.query, searchedAt: new Date(row.createdAt).toISOString(),
        ...(Array.isArray(args.corpora) && args.corpora.every(c => typeof c === "string") ? { requestedCorpora: args.corpora } : {}),
        ...(typeof args.maxResults === "number" ? { originalMaxResults: args.maxResults } : {}) });
    }
    const visible = message.channel !== "analysis" ? messageText(message)?.text : undefined;
    if (visible && !["NO_REPLY", "HEARTBEAT_OK"].includes(visible) && !mirrorTexts.has(visible)) {
      history.push({ role: "assistant", content: visible }); mirrorTexts.add(visible);
    }
  }
  return results;
}

/** Read only active root-chat calls. Stored tool results and archived branches are not searches. */
export function collectSearches(databasePath: string, agentId: string, count: number, historyMessages: number) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("n must be a positive integer");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    const meta = db.prepare("SELECT role,agent_id,schema_version FROM schema_meta WHERE meta_key='primary'").get();
    if (meta?.role !== "agent" || meta.agent_id !== agentId || ![17, 18, 19].includes(Number(meta.schema_version))) throw new Error("Unsupported agent transcript database");
    const columns = db.prepare("PRAGMA table_info(session_windows)").all().map(c => c.name);
    const lineage = ["parent_session_key", "spawned_by", "plugin_owner_id", "hook_external_content_source"]
      .filter(c => columns.includes(c)).map(c => `AND (w.${c} IS NULL OR w.${c}='')`).join(" ");
    const selected = db.prepare(`SELECT DISTINCT w.session_id sessionId,w.session_key sessionKey,w.chat_type chatType,
      MAX(e.created_at) latest FROM session_windows w JOIN session_transcript_active_events a ON a.session_id=w.session_id
      JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq
      WHERE w.chat_type IN ('direct','channel','group') ${lineage} AND e.event_json LIKE '%memory_search%'
      AND json_extract(e.event_json,'$.message.role')='assistant' GROUP BY w.session_id ORDER BY latest DESC`).all();
    let cases: SearchCase[] = [];
    for (const row of selected) {
      if (/:(?:cron|subagent|heartbeat|hook)(?::|$)/i.test(String(row.sessionKey))) continue;
      if (cases.length >= count && Number(row.latest) < Date.parse(cases[count - 1]!.searchedAt)) break;
      const events = db.prepare(`SELECT e.seq,e.created_at createdAt,e.event_json eventJson,a.active_position activePosition
        FROM session_transcript_active_events a JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq
        WHERE a.session_id=? ORDER BY a.active_position`).iterate(String(row.sessionId)) as Iterable<Row>;
      cases.push(...searchesInSession(events, { sessionId: String(row.sessionId), sessionKey: String(row.sessionKey), chatType: String(row.chatType) }, historyMessages));
      cases.sort((a, b) => b.searchedAt.localeCompare(a.searchedAt) || b.eventSeq - a.eventSeq || a.id.localeCompare(b.id));
      cases = cases.slice(0, count);
    }
    return cases;
  } finally { db.close(); }
}
