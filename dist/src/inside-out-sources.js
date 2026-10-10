import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createZstdDecompress, zstdDecompressSync } from "node:zlib";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AgentTranscriptReader } from "./agent-transcript.js";
/** Files contain branch trees; keep the selected leaf, not abandoned sibling conversations. */
function selectedBranch(events) {
    const nodes = new Map(events.filter(e => e.id).map(e => [e.id, e]));
    const leaf = events.findLast(e => e.type === "leaf");
    let id = leaf ? leaf.targetId : events.findLast(e => e.id && e.type !== "session")?.id;
    if (!events.some(e => e.parentId !== undefined))
        return events;
    const path = new Set();
    while (id && !path.has(id)) {
        path.add(id);
        id = nodes.get(id)?.parentId;
    }
    return events.filter(e => e.id && path.has(e.id));
}
function decode(bytes, compressed) {
    return (compressed ? zstdDecompressSync(bytes) : Buffer.from(bytes)).toString("utf8");
}
function parseLines(text) {
    return text.split("\n").filter(line => line.trim()).map((line, i) => ({ ...JSON.parse(line), seq: i + 1 }));
}
/** Legacy filenames may differ from the session ID; inspect only their header for scoped runs. */
async function fileSessionId(path, fallback) {
    const file = createReadStream(path);
    const input = new PassThrough();
    // Pipeline owns every stream's errors and teardown, including cancellation after the header.
    const copying = (path.endsWith(".zst") ? pipeline(file, createZstdDecompress(), input) : pipeline(file, input)).catch(() => { });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (!line.trim())
                continue;
            const header = JSON.parse(line);
            return header.type === "session" ? header.id ?? fallback : fallback;
        }
    }
    catch { /* Unidentifiable files use their filename; selected files report errors when loaded. */ }
    finally {
        lines.close();
        input.destroy();
        await copying;
    }
    return fallback;
}
/** No age cutoff. Each copy is read independently; stable message IDs deduplicate judgments. */
export async function* readInsideOutSources(paths, errors) {
    const metadata = new Map();
    const published = new Set();
    if (existsSync(paths.databasePath)) {
        const db = new DatabaseSync(paths.databasePath, { readOnly: true });
        try {
            db.exec("PRAGMA busy_timeout=1000");
            const transcripts = new AgentTranscriptReader(db, paths.agentId);
            const sessions = db.prepare(`SELECT w.session_id sessionId, COALESCE(w.channel,c.channel,'local') channel,
        COALESCE(w.account_id,c.account_id,'') account, COALESCE(r.generation,'') revision,
        COALESCE((SELECT MAX(seq) FROM transcript_events WHERE session_id=w.session_id),0) tail,
        ${transcripts.coldSql("w.session_id")} cold FROM session_windows w
        LEFT JOIN conversations c ON c.conversation_id=w.primary_conversation_id
        LEFT JOIN transcript_rewrite_watermarks r ON r.session_id=w.session_id
        WHERE (? IS NULL OR w.session_id=?) ORDER BY w.started_at,w.session_id`).all(paths.sessionId ?? null, paths.sessionId ?? null);
            for (const s of sessions)
                metadata.set(String(s.sessionId), { channel: String(s.channel), account: String(s.account) });
            if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='session_transcript_archives'").get()) {
                for (const archive of db.prepare(`SELECT session_id,session_key,generation,archive_name,created_at,length(archive_blob) bytes
          FROM session_transcript_archives WHERE (? IS NULL OR session_id=?)
          ORDER BY created_at,session_id,generation`).all(paths.sessionId ?? null, paths.sessionId ?? null)) {
                    const sessionId = String(archive.session_id), source = `archive:${sessionId}:${archive.generation}`;
                    published.add(String(archive.archive_name));
                    const signature = JSON.stringify(archive);
                    yield { source, sessionId, signature, revision: signature, read: () => {
                            const row = db.prepare("SELECT archive_blob,encoding FROM session_transcript_archives WHERE session_id=? AND generation=?")
                                .get(sessionId, archive.generation);
                            const events = selectedBranch(parseLines(decode(row.archive_blob, row.encoding === "zstd")));
                            return { sessionId, source, events, ...metadata.get(sessionId) ?? { channel: String(archive.session_key).split(":")[2] || "local", account: "" } };
                        } };
                }
            }
            for (const s of sessions) {
                const sessionId = String(s.sessionId), source = `live:${sessionId}`;
                yield { source, sessionId, revision: String(s.revision), signature: JSON.stringify([s.revision, s.tail, s.cold]), read: () => {
                        db.exec("BEGIN");
                        try {
                            const snapshot = transcripts.read(sessionId, { maxSeq: Number(s.tail) });
                            if (snapshot.kind !== "ready")
                                throw new Error(`Transcript unavailable: ${snapshot.kind}`);
                            const events = snapshot.rows.map(row => {
                                const event = JSON.parse(row.eventJson);
                                event.seq = row.seq;
                                event.timestamp ??= new Date(row.createdAt).toISOString();
                                return event;
                            });
                            return { sessionId, source, events, ...metadata.get(sessionId) };
                        }
                        finally {
                            db.exec("COMMIT");
                        }
                    } };
            }
        }
        finally {
            db.close();
        }
    }
    if (paths.sessionsDir && existsSync(paths.sessionsDir)) {
        for (const name of readdirSync(paths.sessionsDir).sort()) {
            if (!/\.jsonl(?:$|\.)/.test(name) || name.endsWith(".tmp") || published.has(name))
                continue;
            try {
                const path = join(paths.sessionsDir, name), filenameId = name.split(".jsonl")[0];
                if (paths.sessionId && filenameId !== paths.sessionId &&
                    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(filenameId))
                    continue;
                const sessionId = paths.sessionId && filenameId !== paths.sessionId ? await fileSessionId(path, filenameId) : filenameId;
                if (paths.sessionId && sessionId !== paths.sessionId)
                    continue;
                const stat = statSync(path), source = `file:${name}`;
                const signature = JSON.stringify([stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
                yield { source, sessionId: paths.sessionId ? sessionId : undefined, signature, revision: signature, read: () => {
                        const events = parseLines(decode(readFileSync(path), name.endsWith(".zst")));
                        const sessionId = events.find(e => e.type === "session")?.id ?? name.split(".jsonl")[0];
                        return { sessionId, source, events: selectedBranch(events), ...metadata.get(sessionId) ?? { channel: "local", account: "" } };
                    } };
            }
            catch {
                errors.push(`file:${name}: unreadable transcript`);
            }
        }
    }
}
