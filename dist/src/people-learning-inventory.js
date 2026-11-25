import { DEFAULTS } from "./defaults.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, } from "node:fs";
import { join } from "node:path";
import { AgentTranscriptReader } from "./agent-transcript.js";
import { record, nonBlank } from "./guards.js";
import { jsonHash } from "./json-hash.js";
import { isInteractionCategory } from "./people-background.js";
import { messageText } from "./whisperer-context.js";
import { responseUserText } from "./response-text.js";
import { reviewWindow } from "./people-learning-time.js";
export function dossierAssertions(personId, dossier) {
    // The blurb is prose, not necessarily one statement. Enumerate sentences as well as section claims.
    const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(dossier.blurb)]
        .map(s => s.segment.trim()).filter(Boolean);
    const assertions = [
        ...sentences.map(statement => ({ personId, category: "blurb", statement })),
        ...dossier.sections.flatMap(section => section.claims.map(claim => ({
            personId, category: section.category, statement: claim.statement, claim,
        }))),
    ];
    const occurrences = new Map();
    return assertions.map(assertion => {
        const { reviewedAt: _reviewed, ...claim } = assertion.claim ?? {};
        const fingerprint = jsonHash([personId, assertion.category, assertion.statement, claim]);
        const occurrence = occurrences.get(fingerprint) ?? 0;
        occurrences.set(fingerprint, occurrence + 1);
        return { ...assertion, id: jsonHash([fingerprint, occurrence]) };
    });
}
function existingArtifactMatches(file, payload) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat)
        return false;
    if (!stat.isFile())
        throw new Error("Private review artifact must be a regular file, not a symlink");
    return stat.size === payload.length && readFileSync(file).equals(payload);
}
/** Atomically publishes a flushed 0o600 private JSON artifact; never accepts a truncated partial file. */
export function privateJson(root, name, value) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const file = join(root, name);
    const payload = Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
    const existing = lstatSync(file, { throwIfNoEntry: false });
    if (existing) {
        if (!existing.isFile())
            throw new Error("Private review artifact must be a regular file, not a symlink");
        if (existing.size === payload.length && readFileSync(file).equals(payload)) {
            chmodSync(file, 0o600);
            return file;
        }
    }
    const temp = join(root, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    let fd;
    try {
        fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        fchmodSync(fd, 0o600);
        let offset = 0;
        while (offset < payload.length) {
            offset += writeSync(fd, payload, offset, payload.length - offset);
        }
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        if (!existing) {
            try {
                linkSync(temp, file);
                unlinkSync(temp);
                return file;
            }
            catch (error) {
                const code = error?.code;
                if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") {
                    renameSync(temp, file);
                    return file;
                }
                if (code !== "EEXIST")
                    throw error;
                if (existingArtifactMatches(file, payload)) {
                    unlinkSync(temp);
                    return file;
                }
                renameSync(temp, file);
                return file;
            }
        }
        renameSync(temp, file);
        return file;
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch { }
        }
        try {
            unlinkSync(temp);
        }
        catch { }
        throw error;
    }
}
function loadRosterAndDossiers(people) {
    const roster = [];
    const dossiers = new Map();
    const byIdentity = new Map();
    // Page through every record; inactive people remain visible without being reactivated.
    for (let offset = 0;; offset += 100) {
        const page = people.listActivePeople(100, offset, true);
        for (const person of page) {
            const activeIdentities = people.listIdentities(person.id).filter(i => !i.isDeactivated && i.isBot !== true);
            const identities = activeIdentities.map(({ provider, accountScope, externalId }) => ({ provider, accountScope, externalId }));
            const reviewPerson = {
                personId: person.id,
                name: person.displayName,
                status: person.status,
                injectionEnabled: person.injectionEnabled,
                identities,
                sessionIds: [],
            };
            roster.push(reviewPerson);
            for (const identity of activeIdentities) {
                byIdentity.set(JSON.stringify([identity.provider, identity.accountScope, identity.externalId]), {
                    person: reviewPerson,
                    confirmedHuman: identity.isBot === false,
                });
            }
            const dossier = people.getDossier(person.id)?.dossier;
            if (dossier)
                dossiers.set(person.id, dossier);
        }
        if (page.length < 100)
            break;
    }
    return { roster, dossiers, byIdentity };
}
function inventorySessionTranscript(session, snapshot, window, byIdentity, exportRoot, gap) {
    const sessionId = String(session.sessionId);
    const participants = new Set();
    const messages = [];
    let currentPerson;
    let excludedExchange = false;
    for (const row of snapshot.rows) {
        const inWindow = row.createdAt >= window.since && row.createdAt < window.until;
        let event;
        try {
            event = record(JSON.parse(row.eventJson));
        }
        catch {
            gap(`Invalid event JSON at ${row.seq}`, sessionId);
            currentPerson = undefined;
            excludedExchange = false;
            continue;
        }
        if (event?.type !== "message")
            continue;
        const message = record(event.message), meta = record(message?.__openclaw);
        if (!message || (message.provenance !== undefined && record(message.provenance)?.kind !== "external_user")) {
            currentPerson = undefined;
            excludedExchange = true;
            continue;
        }
        if (message.role === "user") {
            const transport = record(meta?.transport), sender = nonBlank(meta?.senderId);
            const identity = record(meta?.senderIdentity);
            const provider = nonBlank(transport?.channel), account = nonBlank(transport?.accountId) ?? nonBlank(session.accountId);
            currentPerson = undefined;
            excludedExchange = false;
            if (identity?.senderKind === "bot") {
                excludedExchange = true;
                continue;
            }
            const resolved = sender && provider && account ? byIdentity.get(JSON.stringify([provider, account, sender])) : undefined;
            const person = resolved?.person;
            if (!person || (!resolved.confirmedHuman && identity?.senderKind !== "human") || provider !== session.provider || account !== session.accountId ||
                transport?.conversationRef !== session.conversationId || meta?.turnTainted === true) {
                excludedExchange = !!provider && !!account && (provider !== session.provider || account !== session.accountId);
                if (inWindow)
                    gap(`Unmapped or ambiguous exact identity at event ${row.seq}`, sessionId);
                messages.push({ seq: row.seq, role: "boundary", timestamp: row.createdAt });
                continue;
            }
            const raw = nonBlank(meta?.upstreamUserText) ?? messageText(message)?.text;
            const nonText = Array.isArray(message.content) ? message.content.map(record)
                .filter(part => part && part.type !== "text").map(part => ({ type: part.type, mimeType: part.mimeType })) : [];
            const media = Array.isArray(meta?.media) ? meta.media.map(record).map(part => ({
                path: part?.path, url: part?.url, kind: part?.kind, contentType: part?.contentType, fileName: part?.fileName,
            })) : [];
            if (nonText.length || media.length || (Array.isArray(message.attachments) && message.attachments.length)) {
                gap(`Non-text human content requires original-source review at event ${row.seq}`, sessionId);
            }
            const extracted = raw ? responseUserText(raw, sender) : undefined;
            currentPerson = person;
            if (inWindow)
                participants.add(person.personId);
            if (!extracted)
                gap(`Unreadable human request at event ${row.seq}`, sessionId);
            messages.push({
                seq: row.seq, timestamp: row.createdAt, role: "user", personId: person.personId,
                provider, accountScope: account, senderId: sender, threadId: transport?.threadId ?? null,
                text: extracted?.text ?? "Unreadable request; inspect the native original", nonText, media,
            });
        }
        else if (!currentPerson) {
            // A rejected user identity fences its entire exchange, not just the
            // request. Never export another account's replies or tool results.
            if (inWindow && !excludedExchange && ["assistant", "toolResult", "tool"].includes(String(message.role))) {
                gap(`Unattributed output at event ${row.seq}; relevant activity unknown`, sessionId);
            }
            continue;
        }
        else if (meta?.turnTainted === true || meta?.resultContentSource === "network") {
            if (inWindow)
                participants.add(currentPerson.personId);
            gap(`Untrusted ${String(message.role)} output requires original-source review at event ${row.seq}`, sessionId);
            if (message.role === "assistant" && ["error", "aborted", "cancelled"].includes(String(message.stopReason))) {
                messages.push({ seq: row.seq, role: "assistant_outcome", timestamp: row.createdAt, stopReason: message.stopReason, detailsWithheld: true });
            }
        }
        else if (message.role === "assistant") {
            if (message.provider === "openclaw" && ["delivery-mirror", "gateway-injected"].includes(String(message.model)))
                continue;
            const calls = Array.isArray(message.content) ? message.content.map(record).filter(part => part?.type === "toolCall") : [];
            if (calls.length) {
                if (inWindow)
                    participants.add(currentPerson.personId);
                messages.push({ seq: row.seq, role: "tool_calls", timestamp: row.createdAt, calls });
            }
            if (message.channel === "analysis")
                continue; // Never export hidden reasoning.
            const visibleContent = Array.isArray(message.openclawDisplayContent) ? message.openclawDisplayContent : message.content;
            const text = messageText({ ...message, content: visibleContent })?.text;
            if (message.errorMessage || ["error", "aborted", "cancelled"].includes(String(message.stopReason))) {
                if (inWindow)
                    participants.add(currentPerson.personId);
                messages.push({
                    seq: row.seq, role: "assistant_outcome", timestamp: row.createdAt,
                    stopReason: message.stopReason, errorMessage: message.errorMessage,
                });
            }
            const mediaUrls = record(message.openclawDelivery)?.mediaUrls;
            if ((Array.isArray(visibleContent) && visibleContent.map(record).some(part => !["text", "toolCall", "thinking"].includes(String(part?.type)))) ||
                (Array.isArray(mediaUrls) && mediaUrls.length > 0)) {
                gap(`Non-text assistant output requires original-source review at event ${row.seq}`, sessionId);
                if (inWindow)
                    participants.add(currentPerson.personId);
                messages.push({
                    seq: row.seq, role: "assistant_media", timestamp: row.createdAt,
                    mediaUrls: Array.isArray(mediaUrls) ? mediaUrls.filter(url => typeof url === "string") : [],
                });
            }
            if (!text || ["NO_REPLY", "HEARTBEAT_OK"].includes(text.trim()))
                continue;
            if (inWindow)
                participants.add(currentPerson.personId);
            messages.push({ seq: row.seq, role: "assistant", timestamp: row.createdAt, text });
        }
        else if (message.role === "toolResult" || message.role === "tool") {
            if (inWindow)
                participants.add(currentPerson.personId);
            const parts = Array.isArray(message.content) ? message.content.map(record) : undefined;
            const text = nonBlank(message.content) ?? (parts
                ? parts.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n").trim()
                : undefined);
            if (!text || (parts && parts.some(part => part?.type !== "text"))) {
                gap(`Non-text tool result requires original-source review at event ${row.seq}`, sessionId);
            }
            messages.push({
                seq: row.seq, role: "tool_result", timestamp: row.createdAt,
                toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError,
                text: text || "Non-text tool result; inspect the native original",
            });
        }
    }
    // Export the complete relevant session, including context and later repair.
    if (!participants.size)
        return undefined;
    const value = { ...session, window, messages, sourceRevision: jsonHash(snapshot.rows) };
    const revision = jsonHash(value);
    const file = privateJson(exportRoot, `${revision}.json`, value);
    return { exported: { sessionId, revision, file }, participants };
}
function collectManifestAssertions(manifest, dossiers, people, kind) {
    for (const person of manifest.roster) {
        const dossier = dossiers.get(person.personId);
        if (!dossier)
            continue;
        const unverified = !people.isDossierVerified(person.personId) || dossier.sections.some(s => isInteractionCategory(s.category) &&
            s.claims.some(c => !c.reviewedAt || !c.scope || c.epistemicType === "inferred" ||
                (c.epistemicType === "agent_assessment" && !c.expiresAt)));
        if (unverified)
            manifest.fullValidation = true;
        if (kind === "nightly" ? unverified : person.sessionIds.length > 0 || unverified) {
            manifest.assertions.push(...dossierAssertions(person.personId, dossier));
        }
    }
    // A source outage may hide weekly activity. Validate all dossiers conservatively.
    if (kind === "weekly" && manifest.sourceGaps.length) {
        manifest.assertions = [...dossiers].flatMap(([personId, dossier]) => dossierAssertions(personId, dossier));
    }
}
export function inventoryPeople(options) {
    const now = options.now ?? Date.now(), { people, agentId, kind } = options;
    const window = reviewWindow(now, options.timezone, kind, options.day);
    const id = `${kind}:${window.localDay}`;
    const { roster, dossiers, byIdentity } = loadRosterAndDossiers(people);
    const manifest = {
        id, agentId, kind, createdAt: new Date(now).toISOString(), window,
        fullValidation: kind === "weekly", roster, assertions: [], sourceGaps: [], sessions: [],
    };
    const gap = (reason, sessionId) => {
        const value = { reason, ...(sessionId ? { sessionId } : {}) };
        manifest.sourceGaps.push({ ...value, id: jsonHash(value) });
    };
    if (!byIdentity.size)
        gap("No authoritative local people identities; synchronize the host directory before claiming roster coverage");
    let db;
    try {
        db = new DatabaseSync(options.databasePath, { readOnly: true });
        db.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${DEFAULTS.sqlite.peopleInventoryBusyTimeoutMs}; BEGIN`);
        const reader = new AgentTranscriptReader(db, agentId);
        // Scan the catalog, not session start dates or audit's capped candidate window.
        // Cold/inaccessible history cannot be proven irrelevant and remains explicit work.
        const sessions = db.prepare(`SELECT w.session_id sessionId, w.session_key sessionKey,
      w.primary_conversation_id conversationId, COALESCE(w.account_id,c.account_id,'') accountId,
      COALESCE(w.channel,c.channel,'') provider, w.chat_type chatType
      FROM session_windows w LEFT JOIN conversations c ON c.conversation_id=w.primary_conversation_id
      ORDER BY w.session_id`).all();
        const orphaned = db.prepare(`SELECT DISTINCT e.session_id sessionId FROM transcript_events e
      LEFT JOIN session_windows w ON w.session_id=e.session_id
      WHERE w.session_id IS NULL AND e.created_at>=? AND e.created_at<?`).all(window.since, window.until);
        for (const orphan of orphaned)
            gap("Transcript events have no session catalog entry", String(orphan.sessionId));
        for (const session of sessions) {
            const sessionId = String(session.sessionId);
            if (typeof session.sessionKey === "string" && /^agent:[^:]+:(?:cron|subagent):/u.test(session.sessionKey))
                continue;
            const snapshot = reader.read(sessionId);
            if (snapshot.kind !== "ready") {
                gap(`Transcript ${snapshot.kind}; activity unknown`, sessionId);
                continue;
            }
            if (!snapshot.rows.some(row => row.createdAt >= window.since && row.createdAt < window.until))
                continue;
            if (!["direct", "group", "channel"].includes(String(session.chatType))) {
                gap("Missing or unsupported conversation type; relevance unknown", sessionId);
                continue;
            }
            const result = inventorySessionTranscript(session, snapshot, window, byIdentity, options.exportRoot, gap);
            if (!result)
                continue;
            manifest.sessions.push(result.exported);
            for (const person of manifest.roster)
                if (result.participants.has(person.personId))
                    person.sessionIds.push(sessionId);
        }
    }
    catch {
        gap("Native transcript source unavailable or unsupported; activity inventory incomplete");
    }
    finally {
        if (db?.isTransaction)
            db.exec("ROLLBACK");
        db?.close();
    }
    collectManifestAssertions(manifest, dossiers, people, kind);
    return manifest;
}
