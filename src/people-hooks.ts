import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type { UnblockMemoryConfig } from "./config.js";
import type { PeopleStores } from "./people-store.js";

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  api.on("message_received", (event, context) => {
    if (context.channelId !== "slack") return;
    const agentId = parseAgentSessionKey(context.sessionKey)?.agentId;
    if (!agentId) return;

    const accountScope = nonBlank(context.accountId);
    const externalId = nonBlank(context.senderId);
    try {
      const store = stores.get(agentId);
      if (!accountScope || !externalId) {
        const conversationId = nonBlank(context.conversationId);
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
  const injectedBySession = new Map<
    string,
    Map<string, { runId: string; contribution: { prependContext: string } }>
  >();

  api.on("before_prompt_build", (_event, context) => {
    if (context.trigger !== "user" || context.messageProvider !== "slack") return;
    const parsed = parseAgentSessionKey(context.sessionKey);
    const accountScope = nonBlank(context.accountId);
    const externalId = nonBlank(context.senderId);
    const sessionScope = nonBlank(context.sessionId) ?? nonBlank(context.sessionKey);
    const runId = nonBlank(context.runId);
    if (!parsed || !accountScope || !externalId || !sessionScope || !runId) return;

    try {
      const store = stores.get(parsed.agentId);
      const person = store.findPersonByIdentity("slack", accountScope, externalId);
      if (!person || person.status !== "active" || !person.injectionEnabled) return;
      const injected = injectedBySession.get(sessionScope);
      const previous = injected?.get(person.id);
      if (previous) return previous.runId === runId ? previous.contribution : undefined;
      const blurb = store.getDossierBlurb(person.id);
      const prependContext = blurb
        ? renderPeopleWhisper(blurb, config.whisperer.maxChars)
        : undefined;
      if (!prependContext) return;
      const contribution = { prependContext };
      const state = { runId, contribution };
      if (injected) injected.set(person.id, state);
      else injectedBySession.set(sessionScope, new Map([[person.id, state]]));
      return contribution;
    } catch (error) {
      api.logger.warn(`unblock-memory people whisperer lookup failed: ${String(error)}`);
      return;
    }
  });

  api.on("session_end", (event, context) => {
    injectedBySession.delete(event.sessionId);
    if (event.sessionKey) injectedBySession.delete(event.sessionKey);
    if (context.sessionKey) injectedBySession.delete(context.sessionKey);
  });
}
