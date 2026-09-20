import { resolveTypeSafeApiKey } from "./typesafe-client.js";
import { extractWithLuna, validateExtractedMemory, EXTRACTION_VERSION } from "./extraction-model.js";
import { ExtractionStore } from "./extraction-store.js";
import { readExtractionPage } from "./extraction-source.js";
import { extractionHistory, readExtractionChunk } from "./extraction-chunk.js";
export async function runExtraction(params) {
    const config = params.config.extraction;
    if (!config.enabled)
        return { status: "disabled" };
    const apiKey = await resolveTypeSafeApiKey(params.config.typesafe);
    if (!apiKey)
        return { status: "unavailable", reason: "TypeSafe API key not configured" };
    const store = new ExtractionStore(params.storePath);
    const owner = store.claim(params.scheduled ?? false, config.intervalMinutes * 60_000);
    if (!owner) {
        store.close();
        return { status: "not_due_or_busy" };
    }
    const leaseAbort = new AbortController();
    const signal = AbortSignal.any([params.signal, leaseAbort.signal, AbortSignal.timeout(600_000)]);
    const heartbeat = setInterval(() => { try {
        store.renew(owner);
    }
    catch {
        leaseAbort.abort();
    } }, 30_000);
    heartbeat.unref();
    let processed = 0, acceptedCount = 0, rejectedCount = 0, unchanged = 0, failed = 0;
    const readPage = params.readPage ?? readExtractionPage;
    try {
        const sessions = params.sessions();
        const visible = new Set(sessions.map(s => s.sessionId));
        if (params.sessionId && !visible.has(params.sessionId))
            throw new Error("Unknown or unapproved extraction session");
        for (const memory of store.records())
            if (!visible.has(memory.sessionId))
                store.reset(memory.sessionId, null, owner);
        // Oldest last-checked first: bounded runs must not starve later sessions.
        const checked = new Map(store.db.prepare("SELECT session_id,updated_at FROM extraction_sessions").all()
            .map(r => [String(r.session_id), Number(r.updated_at)]));
        sessions.sort((a, b) => (checked.get(a.sessionId) ?? 0) - (checked.get(b.sessionId) ?? 0));
        for (const session of sessions) {
            signal.throwIfAborted();
            if (params.sessionId && params.sessionId !== session.sessionId)
                continue;
            if (!checked.has(session.sessionId) && (session.changedAt ?? Infinity) < (params.since ?? store.liveSince()))
                continue;
            if (processed >= config.maxBatches)
                break;
            const checkpoint = store.checkpoint(session, params.since);
            let stage = "read";
            try {
                const existing = store.records(session.sessionId);
                if (existing.length > 100 || JSON.stringify(existing.map(m => ({ id: m.id, text: m.text }))).length > 40_000) {
                    throw new Error("Existing memories exceed review budget");
                }
                const page = await readExtractionChunk({ agentId: params.agentId, agentName: params.agentName, session,
                    cursor: checkpoint.cursor, context: extractionHistory(checkpoint.context, config.historyMessages),
                    existing: existing.map(m => ({ id: m.id, text: m.text, observedAt: m.observedAt })), signal, readPage });
                if (page.kind === "unavailable") {
                    store.error(session.sessionId, "source_unavailable");
                    failed++;
                    processed++;
                    continue;
                }
                if (page.kind === "reset" || page.kind === "missing") {
                    store.reset(session.sessionId, page.kind === "reset" ? page.cursor : null, owner);
                    processed++;
                    continue;
                }
                if (!page.entryCount) {
                    store.db.prepare("UPDATE extraction_sessions SET updated_at=? WHERE session_id=?").run(Date.now(), session.sessionId);
                    unchanged++;
                    continue;
                }
                const since = checkpoint.since;
                const freshIds = new Set(page.newIds);
                const fresh = page.messages.filter(m => freshIds.has(m.id) && m.timestamp >= since);
                const messages = page.messages;
                const newIds = fresh.map(m => m.id);
                stage = "propose";
                const proposals = newIds.length ? await (params.extract ?? extractWithLuna)(params.runtime, params.agentId, messages, newIds, existing.map(m => ({ id: m.id, text: m.text, observedAt: m.observedAt })), signal) : [];
                const accepted = [];
                stage = "validate";
                for (const proposal of proposals) {
                    signal.throwIfAborted();
                    const judgment = await (params.validate ?? validateExtractedMemory)({ proposal, messages, newIds,
                        existing, apiKey, signal, thresholds: config });
                    const observedAt = judgment.accepted ? Math.max(...proposal.evidence.map(e => messages.find(m => m.id === e.messageId).timestamp)) : 0;
                    const prior = existing.find(m => m.id === proposal.replaces);
                    if (judgment.accepted && (!prior || prior.observedAt <= observedAt))
                        accepted.push({ proposal: { ...proposal,
                                evidence: proposal.evidence.map(e => ({ ...e, messageId: messages.find(m => m.id === e.messageId).sourceMessageId ?? e.messageId })) }, judgment, observedAt });
                    else
                        rejectedCount++;
                }
                // A branch rewrite during inference invalidates its proposals. Appends are safe and processed next time.
                const check = await readPage(params.agentId, params.agentName, session, page.fence);
                if (check.kind === "reset" || check.kind === "missing") {
                    store.reset(session.sessionId, check.kind === "reset" ? check.cursor : null, owner);
                    processed++;
                    continue;
                }
                if (check.kind === "unavailable")
                    throw new Error("Source changed during extraction");
                signal.throwIfAborted();
                const context = extractionHistory(messages, config.historyMessages);
                stage = "commit";
                const written = store.commit({ session, expected: checkpoint.cursor, cursor: page.cursor,
                    context, accepted, owner, version: EXTRACTION_VERSION });
                processed++;
                acceptedCount += written;
            }
            catch {
                signal.throwIfAborted();
                failed++;
                processed++;
                store.error(session.sessionId, `${stage}_failed`);
            }
        }
        return { status: "completed", processed, accepted: acceptedCount, rejected: rejectedCount, unchanged, failed };
    }
    finally {
        clearInterval(heartbeat);
        store.release(owner);
        store.close();
    }
}
