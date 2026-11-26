import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type { UnblockMemoryConfig } from "./config.js";
import type { PeopleStores } from "./people-store.js";
import { nonBlank } from "./guards.js";
import { renderPeopleDossier } from "./people-background.js";
import type { WhispererPrompt } from "./whisperer-prompt.js";

const MAX_CORRELATION_ENTRIES = 1000;
const MAX_PENDING_PER_IDENTITY = 16;
const CORRELATION_TTL_MS = 10 * 60_000;

type TimedCorrelation<T> = { threadKey: T; messageId?: string; observedAt: number };

function identifier(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return nonBlank(value);
}

function promptIdentityKey(sessionKey: string, accountScope: string, externalId: string): string {
  return JSON.stringify([sessionKey, accountScope, externalId]);
}

function matchesPendingMessage(
  pending: TimedCorrelation<string>,
  threadKey: string,
  messageId: string | undefined,
): boolean {
  return (
    messageId !== undefined &&
    pending.threadKey === threadKey &&
    pending.messageId === messageId
  );
}

function resolveSlackThreadKey(
  event: { threadId?: unknown; replyToId?: unknown; messageId?: unknown },
  accountScope: string,
  conversationId: string,
  sessionKey: string,
): string | undefined {
  const threadRootId = identifier(event.threadId) ?? identifier(event.replyToId);
  const rootMessageId = threadRootId ?? identifier(event.messageId);
  if (conversationId.startsWith("D") && threadRootId === undefined) {
    return `slack:${accountScope}:${conversationId}:session:${sessionKey}`;
  }
  return rootMessageId ? `slack:${accountScope}:${conversationId}:${rootMessageId}` : undefined;
}

function getFreshCorrelation<T>(
  map: Map<string, TimedCorrelation<T>>,
  key: string,
  now: number,
): TimedCorrelation<T> | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (now - entry.observedAt > CORRELATION_TTL_MS) {
    map.delete(key);
    return undefined;
  }
  return entry;
}

function setBoundedCorrelation<T>(
  map: Map<string, TimedCorrelation<T>>,
  key: string,
  threadKey: T,
  now: number,
  messageId?: string,
): void {
  map.delete(key);
  for (const [existingKey, entry] of map) {
    if (now - entry.observedAt <= CORRELATION_TTL_MS) break;
    map.delete(existingKey);
  }
  map.set(key, { threadKey, messageId, observedAt: now });
  while (map.size > MAX_CORRELATION_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function enqueuePendingCorrelation(
  map: Map<string, TimedCorrelation<string>[]>,
  key: string,
  threadKey: string,
  now: number,
  messageId?: string,
): void {
  const existing = map.get(key) ?? [];
  map.delete(key);
  for (const [existingKey, entries] of map) {
    const latest = entries[entries.length - 1];
    if (latest && now - latest.observedAt <= CORRELATION_TTL_MS) break;
    map.delete(existingKey);
  }
  const fresh = existing.filter((entry) => now - entry.observedAt <= CORRELATION_TTL_MS);
  fresh.push({ threadKey, messageId, observedAt: now });
  if (fresh.length > MAX_PENDING_PER_IDENTITY) {
    fresh.splice(0, fresh.length - MAX_PENDING_PER_IDENTITY);
  }
  map.set(key, fresh);
  while (map.size > MAX_CORRELATION_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function removeMatchingPendingCorrelation(
  map: Map<string, TimedCorrelation<string>[]>,
  key: string,
  threadKey: string,
  messageId: string | undefined,
  now: number,
): void {
  const existing = map.get(key);
  if (!existing) return;
  const fresh = existing.filter((entry) => now - entry.observedAt <= CORRELATION_TTL_MS);
  if (messageId !== undefined) {
    const matchIndex = fresh.findIndex((entry) => matchesPendingMessage(entry, threadKey, messageId));
    if (matchIndex !== -1) fresh.splice(matchIndex, 1);
  }
  if (fresh.length === 0) map.delete(key);
  else map.set(key, fresh);
}

function consumeUnambiguousPendingCorrelation(
  map: Map<string, TimedCorrelation<string>[]>,
  key: string,
  now: number,
): TimedCorrelation<string> | undefined {
  const existing = map.get(key);
  if (!existing) return undefined;
  const fresh = existing.filter((entry) => now - entry.observedAt <= CORRELATION_TTL_MS);
  if (fresh.length === 0) {
    map.delete(key);
    return undefined;
  }
  const firstThreadKey = fresh[0]!.threadKey;
  if (fresh.some((entry) => entry.threadKey !== firstThreadKey)) {
    map.delete(key);
    return undefined;
  }
  const consumed = fresh.shift()!;
  if (fresh.length === 0) map.delete(key);
  else map.set(key, fresh);
  return consumed;
}

function observedAt(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export function renderPeopleWhisper(blurb: string, maxChars: number): string | undefined {
  const normalized = blurb.trim();
  return normalized ? normalized.slice(0, maxChars) : undefined;
}

function peopleContext(contribution: string): { appendContext: string } {
  // Escape only at output: durable receipts retain the original dossier text.
  const text = contribution.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  return { appendContext: `<people>${text}</people>` };
}

export function registerPeopleHooks(
  api: OpenClawPluginApi,
  stores: PeopleStores,
  config: UnblockMemoryConfig["people"],
): WhispererPrompt | undefined {
  const threadByRun = new Map<string, TimedCorrelation<string>>();
  const pendingThreadByIdentity = new Map<string, TimedCorrelation<string>[]>();

  api.on("message_received", (event, context) => {
    if (context.channelId !== "slack") return;
    const parsed = parseAgentSessionKey(context.sessionKey);
    if (!parsed) return;

    const accountScope = nonBlank(context.accountId);
    const externalId = nonBlank(context.senderId);
    const conversationId = nonBlank(context.conversationId);
    const runId = nonBlank(event.runId) ?? nonBlank(context.runId);
    const sessionKey = nonBlank(context.sessionKey);
    if (config.whisperer.enabled && accountScope && externalId && conversationId && sessionKey) {
      const threadKey = resolveSlackThreadKey(event, accountScope, conversationId, sessionKey);
      if (threadKey) {
        const now = Date.now();
        const messageId = identifier(event.messageId) ?? identifier(event.metadata?.messageId);
        const identityKey = promptIdentityKey(sessionKey, accountScope, externalId);
        if (runId) {
          setBoundedCorrelation(threadByRun, runId, threadKey, now, messageId);
          removeMatchingPendingCorrelation(
            pendingThreadByIdentity,
            identityKey,
            threadKey,
            messageId,
            now,
          );
        } else {
          enqueuePendingCorrelation(pendingThreadByIdentity, identityKey, threadKey, now, messageId);
        }
      }
    }

    try {
      const store = stores.get(parsed.agentId);
      if (!accountScope || !externalId) {
        store.upsertTodo({
          deduplicationKey:
            `incomplete-slack-identity:${accountScope ?? "missing"}:${externalId ?? "missing"}:` +
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
    } catch (error) {
      api.logger.warn(`unblock-memory people observation failed: ${String(error)}`);
    }
  });

  if (!config.whisperer.enabled) return;

  const beforePrompt: WhispererPrompt = (_event, context, surface) => {
    if ((!surface && context.trigger !== "user") || context.messageProvider !== "slack") return;
    const userSurface = (surface ?? context.trigger) === "user";
    const origin = context.inputProvenance?.kind;
    if ((!userSurface || origin !== undefined) && origin !== "external_user") return;
    const sessionKey = nonBlank(context.sessionKey);
    const parsed = parseAgentSessionKey(sessionKey);
    const accountScope = nonBlank(context.accountId);
    const externalId = nonBlank(context.senderId);
    const runId = nonBlank(context.runId);
    if (!sessionKey || !parsed || !accountScope || !externalId || !runId) return;
    const now = Date.now();
    const identityKey = promptIdentityKey(sessionKey, accountScope, externalId);
    const mapped = getFreshCorrelation(threadByRun, runId, now);
    let threadKey: string | undefined;
    if (mapped) {
      threadKey = mapped.threadKey;
      removeMatchingPendingCorrelation(
        pendingThreadByIdentity,
        identityKey,
        mapped.threadKey,
        mapped.messageId,
        now,
      );
    } else if (userSurface) {
      // Only primary user turns may claim a pending inbound message without a run match.
      const pending = consumeUnambiguousPendingCorrelation(pendingThreadByIdentity, identityKey, now);
      threadKey = pending?.threadKey;
      if (threadKey) {
        setBoundedCorrelation(threadByRun, runId, threadKey, now, pending?.messageId);
      }
    }
    if (!threadKey) return;

    try {
      const store = stores.get(parsed.agentId);
      const person = store.findPersonByIdentity("slack", accountScope, externalId);
      if (!person || person.status !== "active" || !person.injectionEnabled) return;
      // Refresh on every user turn, including reused/compacted Slack threads.
      // A retry of this exact run replays the same snapshot.
      const receiptKey = JSON.stringify([threadKey, runId]);
      const previous = store.getWhisperReceipt(receiptKey, person.id);
      if (previous) {
        return previous.runId === runId ? peopleContext(previous.contribution) : undefined;
      }
      const verified = store.getVerifiedDossier(person.id);
      if (!verified) return;
      const contribution = renderPeopleWhisper(
        renderPeopleDossier(verified.dossier),
        config.whisperer.maxChars,
      );
      if (!contribution) return;
      const receipt = store.recordWhisperReceipt({
        threadKey: receiptKey,
        personId: person.id,
        runId,
        contribution,
      });
      return receipt.runId === runId ? peopleContext(receipt.contribution) : undefined;
    } catch (error) {
      api.logger.warn(`unblock-memory people whisperer lookup failed: ${String(error)}`);
      return;
    }
  };

  api.on("agent_end", (event, context) => {
    const runId = nonBlank(event.runId) ?? nonBlank(context.runId);
    if (runId) threadByRun.delete(runId);
  });
  api.on("gateway_stop", () => {
    threadByRun.clear();
    pendingThreadByIdentity.clear();
  });
  return beforePrompt;
}
