import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { nonBlank } from "./guards.js";
import { renderPeopleDossier } from "./people-background.js";
const MAX_CORRELATION_ENTRIES = 1000;
const CORRELATION_TTL_MS = 10 * 60_000;
function identifier(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    return nonBlank(value);
}
function promptIdentityKey(sessionKey, accountScope, externalId) {
    return JSON.stringify([sessionKey, accountScope, externalId]);
}
function resolveSlackThreadKey(event, accountScope, conversationId, sessionKey) {
    const threadRootId = identifier(event.threadId) ?? nonBlank(event.replyToId);
    const rootMessageId = threadRootId ?? nonBlank(event.messageId);
    if (conversationId.startsWith("D") && threadRootId === undefined) {
        return `slack:${accountScope}:${conversationId}:session:${sessionKey}`;
    }
    return rootMessageId ? `slack:${accountScope}:${conversationId}:${rootMessageId}` : undefined;
}
function getFreshCorrelation(map, key, now) {
    const entry = map.get(key);
    if (!entry)
        return undefined;
    if (now - entry.observedAt > CORRELATION_TTL_MS) {
        map.delete(key);
        return undefined;
    }
    return entry;
}
function setBoundedCorrelation(map, key, threadKey, now) {
    map.delete(key);
    for (const [existingKey, entry] of map) {
        if (now - entry.observedAt <= CORRELATION_TTL_MS)
            break;
        map.delete(existingKey);
    }
    map.set(key, { threadKey, observedAt: now });
    while (map.size > MAX_CORRELATION_ENTRIES) {
        const oldest = map.keys().next().value;
        if (oldest === undefined)
            break;
        map.delete(oldest);
    }
}
function observedAt(timestamp) {
    if (timestamp === undefined || !Number.isFinite(timestamp))
        return undefined;
    const date = new Date(timestamp);
    return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}
export function renderPeopleWhisper(blurb, maxChars) {
    const normalized = blurb.trim();
    return normalized ? normalized.slice(0, maxChars) : undefined;
}
function peopleContext(contribution) {
    // Escape only at output: durable receipts retain the original dossier text.
    const text = contribution.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
    return { appendContext: `<people>${text}</people>` };
}
export function registerPeopleHooks(api, stores, config) {
    const threadByRun = new Map();
    const pendingThreadByIdentity = new Map();
    api.on("message_received", (event, context) => {
        if (context.channelId !== "slack")
            return;
        const parsed = parseAgentSessionKey(context.sessionKey);
        if (!parsed)
            return;
        const accountScope = nonBlank(context.accountId);
        const externalId = nonBlank(context.senderId);
        const conversationId = nonBlank(context.conversationId);
        const runId = nonBlank(event.runId) ?? nonBlank(context.runId);
        const sessionKey = nonBlank(context.sessionKey);
        if (config.whisperer.enabled && accountScope && externalId && conversationId && sessionKey) {
            const threadKey = resolveSlackThreadKey(event, accountScope, conversationId, sessionKey);
            if (threadKey) {
                const now = Date.now();
                if (runId) {
                    setBoundedCorrelation(threadByRun, runId, threadKey, now);
                }
                else {
                    const identityKey = promptIdentityKey(sessionKey, accountScope, externalId);
                    const pending = getFreshCorrelation(pendingThreadByIdentity, identityKey, now);
                    const nextThreadKey = pending === undefined || pending.threadKey === threadKey ? threadKey : null;
                    setBoundedCorrelation(pendingThreadByIdentity, identityKey, nextThreadKey, now);
                }
            }
        }
        try {
            const store = stores.get(parsed.agentId);
            if (!accountScope || !externalId) {
                store.upsertTodo({
                    deduplicationKey: `incomplete-slack-identity:${accountScope ?? "missing"}:${externalId ?? "missing"}:` +
                        `${conversationId ?? "unknown"}`,
                    kind: "incomplete_slack_identity",
                    context: {
                        accountId: accountScope ?? null,
                        senderId: externalId ?? null,
                        conversationId: conversationId ?? null,
                    },
                });
                return;
            }
            store.upsertIdentity({
                provider: "slack",
                accountScope,
                externalId,
                displayName: nonBlank(event.metadata?.senderName),
                handle: nonBlank(event.metadata?.senderUsername),
                seenAt: observedAt(event.timestamp),
            });
        }
        catch (error) {
            api.logger.warn(`unblock-memory people observation failed: ${String(error)}`);
        }
    });
    if (!config.whisperer.enabled)
        return;
    const beforePrompt = (_event, context) => {
        if (context.trigger !== "user" || context.messageProvider !== "slack")
            return;
        const sessionKey = nonBlank(context.sessionKey);
        const parsed = parseAgentSessionKey(sessionKey);
        const accountScope = nonBlank(context.accountId);
        const externalId = nonBlank(context.senderId);
        const runId = nonBlank(context.runId);
        if (!sessionKey || !parsed || !accountScope || !externalId || !runId)
            return;
        const now = Date.now();
        const identityKey = promptIdentityKey(sessionKey, accountScope, externalId);
        const mapped = getFreshCorrelation(threadByRun, runId, now);
        let threadKey;
        if (mapped) {
            threadKey = mapped.threadKey;
            const pending = pendingThreadByIdentity.get(identityKey);
            if (pending &&
                (now - pending.observedAt > CORRELATION_TTL_MS || pending.threadKey === mapped.threadKey)) {
                pendingThreadByIdentity.delete(identityKey);
            }
        }
        else {
            const pending = getFreshCorrelation(pendingThreadByIdentity, identityKey, now);
            pendingThreadByIdentity.delete(identityKey);
            threadKey = pending?.threadKey;
            if (typeof threadKey === "string") {
                setBoundedCorrelation(threadByRun, runId, threadKey, now);
            }
        }
        if (!threadKey)
            return;
        try {
            const store = stores.get(parsed.agentId);
            const person = store.findPersonByIdentity("slack", accountScope, externalId);
            if (!person || person.status !== "active" || !person.injectionEnabled)
                return;
            // Refresh on every user turn, including reused/compacted Slack threads.
            // A retry of this exact run replays the same snapshot.
            const receiptKey = JSON.stringify([threadKey, runId]);
            const previous = store.getWhisperReceipt(receiptKey, person.id);
            if (previous) {
                return previous.runId === runId ? peopleContext(previous.contribution) : undefined;
            }
            const verified = store.getVerifiedDossier(person.id);
            if (!verified)
                return;
            const contribution = renderPeopleWhisper(renderPeopleDossier(verified.dossier), config.whisperer.maxChars);
            if (!contribution)
                return;
            const receipt = store.recordWhisperReceipt({
                threadKey: receiptKey,
                personId: person.id,
                runId,
                contribution,
            });
            return receipt.runId === runId ? peopleContext(receipt.contribution) : undefined;
        }
        catch (error) {
            api.logger.warn(`unblock-memory people whisperer lookup failed: ${String(error)}`);
            return;
        }
    };
    api.on("agent_end", (event, context) => {
        const runId = nonBlank(event.runId) ?? nonBlank(context.runId);
        if (runId)
            threadByRun.delete(runId);
    });
    api.on("gateway_stop", () => {
        threadByRun.clear();
        pendingThreadByIdentity.clear();
    });
    return beforePrompt;
}
