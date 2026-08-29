import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "../src/config.js";
import { registerPeopleHooks, renderPeopleWhisper } from "../src/people-hooks.js";
import { PeopleStores } from "../src/people-store.js";

type MessageReceived = (
  event: {
    from: string;
    content: string;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  },
  context: {
    channelId: string;
    accountId?: string;
    senderId?: string;
    conversationId?: string;
    sessionKey?: string;
  },
) => void;

type BeforePromptBuild = (
  event: { prompt: string; messages: unknown[] },
  context: {
    trigger?: string;
    messageProvider?: string;
    accountId?: string;
    senderId?: string;
    sessionId?: string;
    sessionKey?: string;
    runId?: string;
  },
) => { prependContext?: string } | void;

type SessionEnd = (
  event: { sessionId: string; sessionKey?: string },
  context: { sessionId: string; sessionKey?: string },
) => void;

const peopleConfig: UnblockMemoryConfig["people"] = {
  enabled: true,
  evidenceCorpora: ["memory", "sessions"],
  refinement: { maxPeoplePerRun: 10 },
  whisperer: { enabled: true, maxChars: 30 },
  todos: { maxOpen: 10 },
};

async function harness(config = peopleConfig) {
  const stateRoot = await mkdtemp(join(tmpdir(), "unblock-memory-people-hooks-"));
  const stores = new PeopleStores({ stateRoot, maxOpenTodos: 10, maxBlurbChars: 1200 });
  const hooks = new Map<string, unknown>();
  const warnings: string[] = [];
  const api = {
    logger: {
      warn(message: string) {
        warnings.push(message);
      },
    },
    on(name: string, handler: unknown) {
      hooks.set(name, handler);
    },
  } as unknown as OpenClawPluginApi;
  registerPeopleHooks(api, stores, config);
  return {
    stateRoot,
    stores,
    warnings,
    received: hooks.get("message_received") as MessageReceived,
    before: hooks.get("before_prompt_build") as BeforePromptBuild | undefined,
    end: hooks.get("session_end") as SessionEnd | undefined,
  };
}

const slackContext = {
  channelId: "slack",
  accountId: "workspace-a",
  senderId: "U123",
  conversationId: "C123",
  sessionKey: "agent:bill:slack:channel:C123",
};

test("observes exact Slack identities under the canonical session owner", async () => {
  const testHarness = await harness();
  try {
    testHarness.received(
      {
        from: "slack:C123",
        content: "DO_NOT_STORE_MESSAGE_CONTENT",
        timestamp: Date.parse("2026-08-28T12:00:00Z"),
        metadata: { senderName: " Bek ", senderUsername: " bek " },
      },
      slackContext,
    );
    testHarness.received(
      {
        from: "slack:C123",
        content: "another message",
        metadata: { senderName: "Bek Farryn", senderUsername: "bek" },
      },
      slackContext,
    );

    const store = testHarness.stores.get("bill");
    const person = store.findPersonByIdentity("slack", "workspace-a", "U123");
    const identity = store.findIdentity("slack", "workspace-a", "U123");
    assert.ok(person);
    assert.equal(person.refinementEnabled, false);
    assert.equal(person.injectionEnabled, false);
    assert.equal(identity?.personId, person.id);
    assert.equal(identity?.displayName, "Bek Farryn");
    assert.equal(identity?.handle, "bek");
    const todos = store.listTodos();
    assert.equal(todos.length, 1);
    assert.equal(todos[0]?.deduplicationKey, "needs-enrichment:slack:workspace-a:U123");
    assert.equal(todos[0]?.occurrenceCount, 1);
    assert.deepEqual(todos[0]?.context, {
      personId: person.id,
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    });
    assert.doesNotMatch(JSON.stringify({ person, identity, todos }), /DO_NOT_STORE/);
  } finally {
    testHarness.stores.closeAll();
  }
});

test("ignores non-Slack and noncanonical sessions without opening a store", async () => {
  const testHarness = await harness();
  const path = join(testHarness.stateRoot, "agents", "bill", "unblock-memory", "people.sqlite");
  testHarness.received(
    { from: "discord:user", content: "ignored" },
    {
      ...slackContext,
      channelId: "discord",
    },
  );
  testHarness.received(
    { from: "slack:C123", content: "ignored" },
    {
      ...slackContext,
      sessionKey: "main",
    },
  );
  await assert.rejects(access(path));
  testHarness.stores.closeAll();
});

test("deduplicates incomplete Slack identities without retaining message content", async () => {
  const testHarness = await harness();
  try {
    const context = { ...slackContext, senderId: undefined };
    testHarness.received({ from: "slack:C123", content: "SECRET_ONE" }, context);
    testHarness.received({ from: "slack:C123", content: "SECRET_TWO" }, context);

    const todos = testHarness.stores.get("bill").listTodos();
    assert.equal(todos.length, 1);
    assert.equal(todos[0]?.kind, "incomplete_slack_identity");
    assert.equal(todos[0]?.occurrenceCount, 2);
    assert.deepEqual(todos[0]?.context, {
      accountId: "workspace-a",
      senderId: null,
      conversationId: "C123",
    });
    assert.doesNotMatch(JSON.stringify(todos), /SECRET_/);
  } finally {
    testHarness.stores.closeAll();
  }
});

test("injects one bounded exact-match dossier blurb per session", async () => {
  const testHarness = await harness();
  try {
    const store = testHarness.stores.get("bill");
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    });
    const context = {
      trigger: "user",
      messageProvider: "slack",
      accountId: "workspace-a",
      senderId: "U123",
      sessionId: "session-1",
      sessionKey: "agent:bill:slack:channel:C123",
      runId: "run-1",
    };
    assert.equal(testHarness.before?.({ prompt: "disabled", messages: [] }, context), undefined);
    store.setPolicies(person.id, { injectionEnabled: true });
    assert.equal(testHarness.before?.({ prompt: "no dossier", messages: [] }, context), undefined);
    store.replaceDossier(person.id, {
      schemaVersion: 1,
      blurb: "Prefers concise decisions with explicit owners and deadlines.",
      sections: [
        {
          category: "preferences",
          claims: [
            {
              statement: "Prefers concise decisions.",
              evidence: [{ source: "manual", locator: "operator note" }],
              epistemicType: "reported",
            },
          ],
        },
      ],
    });
    const first = testHarness.before?.({ prompt: "hello", messages: [] }, context);
    assert.equal(first?.prependContext, "Prefers concise decisions with");
    assert.equal(first?.prependContext?.length, 30);
    assert.equal(
      testHarness.before?.({ prompt: "next turn", messages: [] }, { ...context, runId: "run-2" }),
      undefined,
    );

    testHarness.end?.({ sessionId: "session-1", sessionKey: context.sessionKey }, context);
    assert.equal(
      testHarness.before?.({ prompt: "new session", messages: [] }, context)?.prependContext,
      "Prefers concise decisions with",
    );
  } finally {
    testHarness.stores.closeAll();
  }
});

test("replays the same dossier contribution on retries without injecting on later runs", async () => {
  const testHarness = await harness();
  try {
    const store = testHarness.stores.get("bill");
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    });
    store.setPolicies(person.id, { injectionEnabled: true });
    store.replaceDossier(person.id, {
      schemaVersion: 1,
      blurb: "Prefers concise decisions.",
      sections: [],
    });
    const context = {
      trigger: "user",
      messageProvider: "slack",
      accountId: "workspace-a",
      senderId: "U123",
      sessionId: "session-1",
      sessionKey: "agent:bill:slack:channel:C123",
      runId: "run-1",
    };

    const first = testHarness.before?.({ prompt: "first attempt", messages: [] }, context);
    assert.deepEqual(testHarness.before?.({ prompt: "retry", messages: [] }, context), first);
    assert.equal(
      testHarness.before?.({ prompt: "next turn", messages: [] }, { ...context, runId: "run-2" }),
      undefined,
    );
    assert.equal(
      testHarness.before?.(
        { prompt: "missing run", messages: [] },
        { ...context, runId: undefined },
      ),
      undefined,
    );
  } finally {
    testHarness.stores.closeAll();
  }
});

test("fails closed for missing prompt identity and unknown people", async () => {
  const testHarness = await harness();
  try {
    const store = testHarness.stores.get("bill");
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    });
    store.setPolicies(person.id, { injectionEnabled: true });
    store.replaceDossier(person.id, {
      schemaVersion: 1,
      blurb: "Eligible context.",
      sections: [],
    });
    const event = { prompt: "hello", messages: [] };
    const base = {
      trigger: "user",
      messageProvider: "slack",
      accountId: "workspace-a",
      senderId: "U123",
      sessionId: "session-1",
      sessionKey: "agent:bill:slack:channel:C123",
      runId: "run-1",
    };
    assert.equal(testHarness.before?.(event, { ...base, senderId: "unknown" }), undefined);
    assert.equal(testHarness.before?.(event, base)?.prependContext, "Eligible context.");
    assert.equal(testHarness.before?.(event, { ...base, accountId: undefined }), undefined);
    assert.equal(testHarness.before?.(event, { ...base, senderId: undefined }), undefined);
    assert.equal(testHarness.before?.(event, { ...base, sessionKey: "main" }), undefined);
    assert.equal(testHarness.before?.(event, { ...base, messageProvider: "discord" }), undefined);
  } finally {
    testHarness.stores.closeAll();
  }
});

test("registers only observation when People Whisperer is disabled", async () => {
  const testHarness = await harness({
    ...peopleConfig,
    whisperer: { ...peopleConfig.whisperer, enabled: false },
  });
  assert.ok(testHarness.received);
  assert.equal(testHarness.before, undefined);
  assert.equal(testHarness.end, undefined);
  testHarness.stores.closeAll();
});

test("renders only the bounded stored blurb", () => {
  assert.equal(renderPeopleWhisper("  useful context  ", 8), "useful c");
  assert.equal(renderPeopleWhisper("   ", 8), undefined);
});
