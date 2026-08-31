import { DatabaseSync } from "node:sqlite";

export type PersonSessionEvidence = {
  source: "session";
  locator: string;
  observedAt: string;
  text: string;
  context: Array<{
    locator: string;
    role: string;
    text: string;
    senderId?: string;
  }>;
};

type EvidenceRow = {
  session_id: string;
  active_position: number;
  event_seq: number;
  event_json: string;
  created_at: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((part) => {
      const block = record(part);
      return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function evidenceTimestamp(event: Record<string, unknown>, fallback: number): string {
  const raw = event.timestamp;
  const milliseconds =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : typeof raw === "string"
        ? Date.parse(raw)
        : fallback;
  return new Date(Number.isFinite(milliseconds) ? milliseconds : fallback).toISOString();
}

export function readPersonSessionEvidence(params: {
  databasePath: string;
  agentId: string;
  accountScope: string;
  externalId: string;
  limit?: number;
  maxMessageChars?: number;
  excludeLocators?: ReadonlySet<string>;
}): PersonSessionEvidence[] {
  const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 20)));
  const maxMessageChars = Math.max(1, Math.min(4000, Math.floor(params.maxMessageChars ?? 2000)));
  const db = new DatabaseSync(params.databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN");
    const version = db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    const meta = db
      .prepare("SELECT schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'")
      .get() as { schema_version?: number; agent_id?: string } | undefined;
    if (
      version?.user_version !== 17 ||
      meta?.schema_version !== 17 ||
      meta.agent_id !== params.agentId
    ) {
      throw new Error("unsupported or mismatched OpenClaw agent database");
    }
    const rows = db.prepare(`
      SELECT events.session_id, active.active_position, active.event_seq,
        events.event_json, events.created_at
      FROM session_transcript_active_events AS active
      JOIN transcript_events AS events
        ON events.session_id = active.session_id AND events.seq = active.event_seq
      JOIN session_windows AS sessions ON sessions.session_id = active.session_id
      LEFT JOIN conversations ON conversations.conversation_id = sessions.primary_conversation_id
      WHERE active.message_position IS NOT NULL
        AND COALESCE(sessions.channel, conversations.channel) = 'slack'
        AND COALESCE(sessions.account_id, conversations.account_id) = ?
        AND json_extract(events.event_json, '$.type') = 'message'
        AND json_extract(events.event_json, '$.message.role') = 'user'
        AND json_extract(events.event_json, '$.message.__openclaw.senderId') = ?
      ORDER BY events.created_at DESC, events.session_id, active.active_position DESC
    `);
    const contextStatement = db.prepare(`
      SELECT active.event_seq, events.event_json
      FROM session_transcript_active_events AS active
      JOIN transcript_events AS events
        ON events.session_id = active.session_id AND events.seq = active.event_seq
      WHERE active.session_id = ?
        AND active.message_position IS NOT NULL
        AND active.active_position BETWEEN ? AND ?
        AND json_extract(events.event_json, '$.type') = 'message'
      ORDER BY active.active_position
    `);
    const evidence: PersonSessionEvidence[] = [];
    for (const row of rows.iterate(params.accountScope, params.externalId) as Iterable<EvidenceRow>) {
      const locator = `session:${row.session_id}:event:${row.event_seq}`;
      if (params.excludeLocators?.has(locator)) continue;
      const event = record(JSON.parse(row.event_json));
      const message = record(event?.message);
      const text = messageText(message?.content);
      if (!event || !message || !text) continue;
      const context = contextStatement
        .all(row.session_id, row.active_position - 1, row.active_position + 2)
        .flatMap((contextRow) => {
          const candidate = contextRow as { event_seq: number; event_json: string };
          const contextEvent = record(JSON.parse(candidate.event_json));
          const contextMessage = record(contextEvent?.message);
          const contextText = messageText(contextMessage?.content);
          if (!contextMessage || !contextText || typeof contextMessage.role !== "string") return [];
          const metadata = record(contextMessage.__openclaw);
          return [
            {
              locator: `session:${row.session_id}:event:${candidate.event_seq}`,
              role: contextMessage.role,
              text: contextText.slice(0, maxMessageChars),
              ...(typeof metadata?.senderId === "string" ? { senderId: metadata.senderId } : {}),
            },
          ];
        });
      evidence.push({
        source: "session",
        locator,
        observedAt: evidenceTimestamp(event, row.created_at),
        text: text.slice(0, maxMessageChars),
        context,
      });
      if (evidence.length === limit) break;
    }
    db.exec("COMMIT");
    return evidence;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The read transaction may not have started if opening the schema failed.
    }
    throw error;
  } finally {
    db.close();
  }
}
