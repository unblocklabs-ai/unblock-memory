import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ChatType } from "./config.js";
import type { ExtractionSession } from "./extraction-store.js";
import type { ExtractionMessage } from "./extraction-model.js";
import { projectMessage } from "./session-projector.js";

export function extractionSessions(databasePath: string, agentId: string, chatTypes: ChatType[]): ExtractionSession[] {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
    if (db.prepare("SELECT agent_id FROM schema_meta WHERE meta_key='primary'").get()?.agent_id !== agentId) {
      throw new Error("Wrong extraction source agent");
    }
    return db.prepare(`SELECT w.session_id,w.session_key,w.chat_type,COALESCE(w.channel,c.channel) AS provider,
      COALESCE(w.account_id,c.account_id) AS account_id,COALESCE(c.native_channel_id,c.native_direct_user_id,c.peer_id,w.primary_conversation_id) AS conversation_id,
      COALESCE(w.started_at,w.created_at) AS started_at, COALESCE(w.transcript_updated_at,w.updated_at,w.created_at) AS changed_at FROM session_windows w
      LEFT JOIN conversations c ON c.conversation_id=w.primary_conversation_id
      WHERE w.chat_type IN (${chatTypes.map(() => "?").join(",")}) ORDER BY w.created_at,w.session_id`)
      .all(...chatTypes).map(r => ({ sessionId: String(r.session_id), sessionKey: String(r.session_key),
        chatType: r.chat_type as ChatType, provider: r.provider === null ? undefined : String(r.provider),
        accountId: r.account_id === null ? undefined : String(r.account_id),
        conversationId: r.conversation_id === null ? undefined : String(r.conversation_id), startedAt: Number(r.started_at), changedAt: Number(r.changed_at) }));
  } finally { db.close(); }
}

const pageSchema = Type.Object({ kind: Type.Literal("page"), cursor: Type.String(), hasMore: Type.Boolean(),
  requiredBytes: Type.Optional(Type.Number()), entries: Type.Array(Type.Object({ entryId: Type.String(),
    message: Type.Unknown(), createdAt: Type.Optional(Type.String()) })) });
export type ExtractionPage = { kind: "page"; cursor: string; hasMore: boolean; messages: ExtractionMessage[]; entryCount: number } |
  { kind: "reset"; cursor: string } | { kind: "missing" } | { kind: "unavailable" };
export async function readExtractionPage(agentId: string, agentName: string, session: ExtractionSession,
  cursor: string | null, read?: (params: { agentId: string; sessionId: string; sessionKey: string;
    cursor?: string; maxMessages: number; maxBytes: number }) => Promise<unknown>): Promise<ExtractionPage> {
  // Runtime-only import: the supported host export ships JS without a declaration file.
  const sdkPath = "openclaw/plugin-sdk/session-transcript-runtime";
  const sdk = read ? undefined : await import(sdkPath) as { readSessionTranscriptVisibleMessageDelta?: (params: unknown) => Promise<unknown> };
  const readDelta = read ?? sdk?.readSessionTranscriptVisibleMessageDelta;
  if (!readDelta) throw new Error("Host visible transcript API unavailable");
  let maxBytes = 1_000_000;
  let result: unknown;
  for (;;) {
    result = await readDelta({ agentId, sessionId: session.sessionId,
      sessionKey: session.sessionKey, ...(cursor ? { cursor } : {}), maxMessages: 40, maxBytes });
    if (!Value.Check(pageSchema, result) || result.entries.length || !result.requiredBytes) break;
    // The host caps reads at 64 MiB. This is an allocation bound, not a model budget.
    if (!Number.isSafeInteger(result.requiredBytes) || result.requiredBytes <= maxBytes || result.requiredBytes > 64 * 1024 * 1024) {
      throw new Error("Transcript entry exceeds host read capacity");
    }
    maxBytes = result.requiredBytes;
  }
  if (Value.Check(pageSchema, result)) {
    const messages = result.entries.flatMap(entry => {
      const createdAt = Date.parse(entry.createdAt ?? "");
      if (!Number.isFinite(createdAt)) throw new Error("Extraction message has no source date");
      const projected = projectMessage({ eventJson: JSON.stringify({ type: "message", timestamp: entry.createdAt, message: entry.message }), createdAt },
        { ...session, agentName, timezone: "UTC", events: [] });
      return projected?.text ? [{ id: entry.entryId, speaker: projected.speaker, role: projected.role, text: projected.text, timestamp: projected.timestamp }] : [];
    });
    return { kind: "page", cursor: result.cursor, hasMore: result.hasMore, messages, entryCount: result.entries.length };
  }
  const resetSchema = Type.Object({ kind: Type.Literal("reset"), cursor: Type.String() });
  if (Value.Check(resetSchema, result)) return { kind: "reset", cursor: result.cursor };
  const missingSchema = Type.Object({ kind: Type.Union([Type.Literal("missing"), Type.Literal("unavailable")]) });
  if (Value.Check(missingSchema, result)) return { kind: result.kind };
  throw new Error("Invalid host transcript page");
}
