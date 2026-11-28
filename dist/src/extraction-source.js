import { DEFAULTS } from "./defaults.js";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { abortable } from "./abortable.js";
import { hostSessionCatalog } from "./agent-transcript.js";
import { projectDecodedMessage, projectMessage } from "./session-projector.js";
export function extractionSessions(databasePath, agentId, chatTypes) {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
        db.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${DEFAULTS.sqlite.mainBusyTimeoutMs}`);
        if (db.prepare("SELECT agent_id FROM schema_meta WHERE meta_key='primary'").get()?.agent_id !== agentId) {
            throw new Error("Wrong extraction source agent");
        }
        return db.prepare(`SELECT w.session_id,w.session_key,w.chat_type,${hostSessionCatalog.provider} AS provider,
      ${hostSessionCatalog.accountId} AS account_id,COALESCE(c.native_channel_id,c.native_direct_user_id,c.peer_id,w.primary_conversation_id) AS conversation_id,
      COALESCE(w.started_at,w.created_at) AS started_at, COALESCE(w.transcript_updated_at,w.updated_at,w.created_at) AS changed_at,
      r.generation,(SELECT MAX(seq) FROM transcript_events WHERE session_id=w.session_id) AS tail
      ${hostSessionCatalog.from}
      LEFT JOIN transcript_rewrite_watermarks r ON r.session_id=w.session_id
      WHERE w.chat_type IN (${chatTypes.map(() => "?").join(",")}) ORDER BY w.created_at,w.session_id`)
            .all(...chatTypes).map(r => ({ sessionId: String(r.session_id), sessionKey: String(r.session_key),
            chatType: r.chat_type, provider: r.provider === null ? undefined : String(r.provider),
            accountId: r.account_id === null ? undefined : String(r.account_id),
            conversationId: r.conversation_id === null ? undefined : String(r.conversation_id), startedAt: Number(r.started_at), changedAt: Number(r.changed_at),
            // The host uses this append-stable watermark for transcript cache validation.
            sourceRevision: r.generation === null ? undefined : JSON.stringify([r.generation, r.tail]) }));
    }
    finally {
        db.close();
    }
}
const pageSchema = Type.Object({ kind: Type.Literal("page"), cursor: Type.String(), hasMore: Type.Boolean(),
    requiredBytes: Type.Optional(Type.Number()), entries: Type.Array(Type.Object({ entryId: Type.String(),
        message: Type.Unknown(), createdAt: Type.Optional(Type.String()) })) });
const resetSchema = Type.Object({ kind: Type.Literal("reset"), cursor: Type.String() });
const missingSchema = Type.Object({ kind: Type.Union([Type.Literal("missing"), Type.Literal("unavailable")]) });
export function bindExtractionPageReader({ agentId, agentName, session, signal, readPage }) {
    const read = readPage ?? readExtractionPage;
    return async (cursor) => {
        signal.throwIfAborted();
        const page = await abortable(read(agentId, agentName, session, cursor, undefined, signal), signal);
        signal.throwIfAborted();
        return page;
    };
}
export async function readExtractionPage(agentId, agentName, session, cursor, read, signal, syntheticInput) {
    signal?.throwIfAborted();
    // Runtime-only import: the supported host export ships JS without a declaration file.
    const sdkPath = "openclaw/plugin-sdk/session-transcript-runtime";
    const sdk = read ? undefined : await import(sdkPath);
    const readDelta = read ?? sdk?.readSessionTranscriptVisibleMessageDelta;
    if (!readDelta)
        throw new Error("Host visible transcript API unavailable");
    let maxBytes = 1_000_000;
    let result;
    for (;;) {
        signal?.throwIfAborted();
        const pending = readDelta({ agentId, sessionId: session.sessionId,
            sessionKey: session.sessionKey, ...(cursor ? { cursor } : {}), maxMessages: 40, maxBytes });
        result = await abortable(pending, signal);
        signal?.throwIfAborted();
        if (!Value.Check(pageSchema, result))
            break;
        if (!result.entries.length && result.requiredBytes) {
            // The host caps reads at 64 MiB. This is an allocation bound, not a model budget.
            if (!Number.isSafeInteger(result.requiredBytes) || result.requiredBytes <= maxBytes || result.requiredBytes > 64 * 1024 * 1024) {
                throw new Error("Transcript entry exceeds host read capacity");
            }
            maxBytes = result.requiredBytes;
            continue;
        }
        const messages = result.entries.flatMap(entry => {
            const createdAt = Date.parse(entry.createdAt ?? "");
            if (!Number.isFinite(createdAt))
                throw new Error("Extraction message has no source date");
            // Injected readers retain the JSON boundary; SDK entries are already decoded from the transcript.
            const projected = read
                ? projectMessage({ eventJson: JSON.stringify({ type: "message", timestamp: entry.createdAt, message: entry.message }), createdAt }, { ...session, agentName, timezone: "UTC", events: [], syntheticInput })
                : projectDecodedMessage(entry.message, { createdAt }, { ...session, agentName, syntheticInput });
            return projected?.text ? [{ id: entry.entryId, speaker: projected.speaker, role: projected.role, text: projected.text, timestamp: projected.timestamp }] : [];
        });
        return { kind: "page", cursor: result.cursor, hasMore: result.hasMore, messages, entryCount: result.entries.length };
    }
    if (Value.Check(resetSchema, result))
        return { kind: "reset", cursor: result.cursor };
    if (Value.Check(missingSchema, result))
        return { kind: result.kind };
    throw new Error("Invalid host transcript page");
}
