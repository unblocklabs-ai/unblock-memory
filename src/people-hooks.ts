import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type { UnblockMemoryConfig } from "./config.js";
import type { PeopleStores } from "./people-store.js";

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return nonBlank(value);
}

function promptIdentityKey(sessionKey: string, accountScope: string, externalId: string): string {
  return JSON.stringify([sessionKey, accountScope, externalId]);
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

export function registerPeopleHooks(
  api: OpenClawPluginApi,
  stores: PeopleStores,
  config: UnblockMemoryConfig["people"],
): void {
  const threadByRun = new Map<string, string>();
  const pendingThreadByIdentity = new Map<string, string>();

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
      const threadRootId = identifier(event.threadId) ?? nonBlank(event.replyToId);
      const rootMessageId = threadRootId ?? nonBlank(event.messageId);
      const threadKey =
        conversationId.startsWith("D") && threadRootId === undefined
          ? `slack:${accountScope}:${conversationId}:session:${sessionKey}`
          : rootMessageId
            ? `slack:${accountScope}:${conversationId}:${rootMessageId}`
            : undefined;
      if (threadKey) {
        const identityKey = promptIdentityKey(sessionKey, accountScope, externalId);
        if (runId) {
          pendingThreadByIdentity.delete(identityKey);
          threadByRun.set(runId, threadKey);
        } else {
          pendingThreadByIdentity.set(identityKey, threadKey);
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

  api.on("before_prompt_build", (_event, context) => {
    if (context.trigger !== "user" || context.messageProvider !== "slack") return;
    const sessionKey = nonBlank(context.sessionKey);
    const parsed = parseAgentSessionKey(sessionKey);
    const accountScope = nonBlank(context.accountId);
    const externalId = nonBlank(context.senderId);
    const runId = nonBlank(context.runId);
    if (!sessionKey || !parsed || !accountScope || !externalId || !runId) return;
    const identityKey = promptIdentityKey(sessionKey, accountScope, externalId);
    const pendingThreadKey = pendingThreadByIdentity.get(identityKey);
    const threadKey = threadByRun.get(runId) ?? pendingThreadKey;
    if (!threadKey) return;
    if (pendingThreadKey) {
      pendingThreadByIdentity.delete(identityKey);
      threadByRun.set(runId, pendingThreadKey);
    }

    try {
      const store = stores.get(parsed.agentId);
      const person = store.findPersonByIdentity("slack", accountScope, externalId);
      if (!person || person.status !== "active" || !person.injectionEnabled) return;
      const previous = store.getWhisperReceipt(threadKey, person.id);
      if (previous) {
        return previous.runId === runId ? { prependContext: previous.contribution } : undefined;
      }
      const blurb = store.getDossierBlurb(person.id);
      const prependContext = blurb
        ? renderPeopleWhisper(blurb, config.whisperer.maxChars)
        : undefined;
      if (!prependContext) return;
      const receipt = store.recordWhisperReceipt({
        threadKey,
        personId: person.id,
        runId,
        contribution: prependContext,
      });
      return receipt.runId === runId ? { prependContext: receipt.contribution } : undefined;
    } catch (error) {
      api.logger.warn(`unblock-memory people whisperer lookup failed: ${String(error)}`);
      return;
    }
  });

  api.on("agent_end", (event, context) => {
    const runId = nonBlank(event.runId) ?? nonBlank(context.runId);
    if (runId) threadByRun.delete(runId);
  });
}
