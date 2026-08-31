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
    threadId?: string | number;
    messageId?: string;
    replyToId?: string;
    runId?: string;
    metadata?: Record<string, unknown>;
  },
  context: {
    channelId: string;
    accountId?: string;
    senderId?: string;
    conversationId?: string;
    sessionKey?: string;
    runId?: string;
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

type AgentEnd = (
  event: { messages: unknown[]; success: boolean; runId?: string },
  context: { runId?: string },
) => void;

const peopleConfig: UnblockMemoryConfig["people"] = {
  enabled: true,
  whisperer: { enabled: true, maxChars: 30 },
  todos: { maxOpen: 10 },
};

async function harness(config = peopleConfig, existingStateRoot?: string) {
  const stateRoot =
    existingStateRoot ?? (await mkdtemp(join(tmpdir(), "unblock-memory-people-hooks-")));
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
    agentEnd: hooks.get("agent_end") as AgentEnd | undefined,
  };
}

const slackContext = {
  channelId: "slack",
  accountId: "workspace-a",
  senderId: "U123",
  conversationId: "C123",
  sessionKey: "agent:bill:slack:channel:C123",
};

function promptContext(senderId: string, runId: string, sessionKey = slackContext.sessionKey) {
  return {
    trigger: "user",
    messageProvider: "slack",
    accountId: "workspace-a",
    senderId,
    sessionId: "session-1",
    sessionKey,
    runId,
  };
}

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
    assert.equal(person.injectionEnabled, true);
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
    { ...slackContext, channelId: "discord" },
  );
  testHarness.received(
    { from: "slack:C123", content: "ignored" },
    { ...slackContext, sessionKey: "main" },
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

test("deduplicates a person per Slack thread, replays retries, and injects in a new thread", async () => {
  const testHarness = await harness();
  try {
    const store = testHarness.stores.get("bill");
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    });
    store.replaceDossier(person.id, {
      schemaVersion: 1,
      blurb: "Prefers concise decisions with explicit owners and deadlines.",
      sections: [],
    });

    testHarness.received(
      { from: "slack:C123", content: "root", messageId: "100.0" },
      slackContext,
    );
    const first = testHarness.before?.(
      { prompt: "first attempt", messages: [] },
      promptContext("U123", "run-1"),
    );
    assert.equal(first?.prependContext, "Prefers concise decisions with");

    store.replaceDossier(person.id, {
      schemaVersion: 1,
      blurb: "This later dossier must not change a retry.",
      sections: [],
    });
    assert.deepEqual(
      testHarness.before?.(
        { prompt: "retry", messages: [] },
        promptContext("U123", "run-1"),
      ),
      first,
    );

    testHarness.received(
      {
        from: "slack:C123",
        content: "reply",
        threadId: "100.0",
        messageId: "101.0",
      },
      slackContext,
    );
    assert.equal(
      testHarness.before?.(
        { prompt: "later turn", messages: [] },
        promptContext("U123", "run-2"),
      ),
      undefined,
    );

    testHarness.received(
      { from: "slack:C123", content: "new root", messageId: "200.0" },
      slackContext,
    );
    assert.equal(
      testHarness.before?.(
        { prompt: "new thread", messages: [] },
        promptContext("U123", "run-3"),
      )?.prependContext,
      "This later dossier must not ch",
    );
  } finally {
    testHarness.stores.closeAll();
  }
});

test("injects three different people once each in one Slack thread", async () => {
  const testHarness = await harness();
  try {
    const store = testHarness.stores.get("bill");
    const people = [
      ["UA", "Person A context."],
      ["UB", "Person B context."],
      ["UC", "Person C context."],
    ] as const;

    for (const [senderId, blurb] of people) {
      const { person } = store.upsertIdentity({
        provider: "slack",
        accountScope: "workspace-a",
        externalId: senderId,
      });
      store.replaceDossier(person.id, { schemaVersion: 1, blurb, sections: [] });
    }

    const contributions: string[] = [];
    for (const [index, [senderId]] of people.entries()) {
      const runId = `run-${index}`;
      testHarness.received(
        {
          from: "slack:C123",
          content: "message",
          ...(index === 0 ? { messageId: "300.0" } : { threadId: "300.0" }),
        },
        { ...slackContext, senderId },
      );
      const contribution = testHarness.before?.(
        { prompt: "message", messages: [] },
        promptContext(senderId, runId),
      )?.prependContext;
      assert.ok(contribution);
      contributions.push(contribution);
    }

    assert.deepEqual(contributions, ["Person A context.", "Person B context.", "Person C context."]);
  } finally {
    testHarness.stores.closeAll();
  }
});

test("keeps pending thread correlation isolated by session and sender", async () => {
  const testHarness = await harness();
  try {
    const store = testHarness.stores.get("bill");
    for (const [externalId, blurb] of [
      ["UA", "Person A context."],
      ["UB", "Person B context."],
    ] as const) {
      const { person } = store.upsertIdentity({
        provider: "slack",
        accountScope: "workspace-a",
        externalId,
      });
      store.replaceDossier(person.id, { schemaVersion: 1, blurb, sections: [] });
    }

    const sessionA = "agent:bill:slack:channel:C123";
    const sessionB = "agent:bill:slack:channel:C456";
    testHarness.received(
      { from: "slack:C123", content: "first", messageId: "700.0" },
      { ...slackContext, senderId: "UA", sessionKey: sessionA },
    );
    testHarness.received(
      { from: "slack:C456", content: "second", messageId: "800.0" },
      { ...slackContext, senderId: "UB", conversationId: "C456", sessionKey: sessionB },
    );

    assert.equal(
      testHarness.before?.(
        { prompt: "second", messages: [] },
        promptContext("UB", "run-b", sessionB),
      )?.prependContext,
      "Person B context.",
    );
    assert.equal(
      testHarness.before?.(
        { prompt: "first", messages: [] },
        promptContext("UA", "run-a", sessionA),
      )?.prependContext,
      "Person A context.",
    );
  } finally {
    testHarness.stores.closeAll();
  }
});

test("durable receipts survive hook and store restart", async () => {
  const firstHarness = await harness();
  const store = firstHarness.stores.get("bill");
  const { person } = store.upsertIdentity({
    provider: "slack",
    accountScope: "workspace-a",
    externalId: "U123",
  });
  store.replaceDossier(person.id, {
    schemaVersion: 1,
    blurb: "Durable context.",
    sections: [],
  });
  firstHarness.received(
    { from: "slack:C123", content: "root", messageId: "400.0" },
    slackContext,
  );
  assert.equal(
    firstHarness.before?.(
      { prompt: "root", messages: [] },
      promptContext("U123", "run-before"),
    )?.prependContext,
    "Durable context.",
  );
  firstHarness.stores.closeAll();

  const restarted = await harness(peopleConfig, firstHarness.stateRoot);
  try {
    restarted.received(
      {
        from: "slack:C123",
        content: "reply",
        threadId: "400.0",
        messageId: "401.0",
      },
      slackContext,
    );
    assert.equal(
      restarted.before?.(
        { prompt: "reply", messages: [] },
        promptContext("U123", "run-after"),
      ),
      undefined,
    );
  } finally {
    restarted.stores.closeAll();
  }
});

test("uses the OpenClaw session for unthreaded Slack DMs across DM scopes", async () => {
  const testHarness = await harness();
  try {
    const store = testHarness.stores.get("bill");
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    });
    store.replaceDossier(person.id, { schemaVersion: 1, blurb: "DM context.", sections: [] });
    const dmSessions = [
      "agent:bill:main",
      "agent:bill:direct:U123",
      "agent:bill:slack:direct:U123",
      "agent:bill:slack:workspace-a:direct:U123",
    ];

    for (const [index, dmSession] of dmSessions.entries()) {
      const conversationId = `D12${index}`;
      testHarness.received(
        {
          from: "slack:U123",
          content: "first",
          messageId: `${index}00.0`,
        },
        { ...slackContext, conversationId, sessionKey: dmSession },
      );
      assert.equal(
        testHarness.before?.(
          { prompt: "first", messages: [] },
          promptContext("U123", `dm-${index}-1`, dmSession),
        )?.prependContext,
        "DM context.",
      );

      testHarness.received(
        {
          from: "slack:U123",
          content: "second",
          messageId: `${index}01.0`,
        },
        { ...slackContext, conversationId, sessionKey: dmSession },
      );
      assert.equal(
        testHarness.before?.(
          { prompt: "second", messages: [] },
          promptContext("U123", `dm-${index}-2`, dmSession),
        ),
        undefined,
      );
    }
  } finally {
    testHarness.stores.closeAll();
  }
});

test("deduplicates a Slack DM root and reply when only replyToId survives", async () => {
  const testHarness = await harness();
  try {
    const store = testHarness.stores.get("bill");
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    });
    store.replaceDossier(person.id, { schemaVersion: 1, blurb: "DM context.", sections: [] });
    const dmSession = "agent:bill:slack:direct:U123";

    testHarness.received(
      {
        from: "slack:U123",
        content: "thread root",
        threadId: "550.0",
        messageId: "550.0",
      },
      { ...slackContext, conversationId: "D123", sessionKey: dmSession },
    );
    assert.equal(
      testHarness.before?.(
        { prompt: "root", messages: [] },
        promptContext("U123", "dm-thread-root", dmSession),
      )?.prependContext,
      "DM context.",
    );

    testHarness.received(
      {
        from: "slack:U123",
        content: "thread reply",
        messageId: "551.0",
        replyToId: "550.0",
      },
      { ...slackContext, conversationId: "D123", sessionKey: dmSession },
    );
    assert.equal(
      testHarness.before?.(
        { prompt: "reply", messages: [] },
        promptContext("U123", "dm-thread-reply", dmSession),
      ),
      undefined,
    );
  } finally {
    testHarness.stores.closeAll();
  }
});

test("unknown, dossierless, and disabled people create no receipt", async () => {
  const testHarness = await harness();
  try {
    const store = testHarness.stores.get("bill");
    const { person: dossierless } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U123",
    });
    const { person: disabled } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace-a",
      externalId: "U456",
    });
    store.replaceDossier(disabled.id, {
      schemaVersion: 1,
      blurb: "Disabled context.",
      sections: [],
    });
    store.setInjection(disabled.id, false);

    testHarness.received(
      { from: "slack:C123", content: "message", messageId: "600.0" },
      { ...slackContext, senderId: undefined },
    );
    assert.equal(
      testHarness.before?.(
        { prompt: "message", messages: [] },
        promptContext("unknown", "unknown-run"),
      ),
      undefined,
    );

    const cases = [
      ["U123", "dossierless-run", "601.0"],
      ["U456", "disabled-run", "602.0"],
    ] as const;
    for (const [senderId, runId, messageId] of cases) {
      testHarness.received(
        { from: "slack:C123", content: "message", messageId },
        { ...slackContext, senderId },
      );
      assert.equal(
        testHarness.before?.({ prompt: "message", messages: [] }, promptContext(senderId, runId)),
        undefined,
      );
    }

    assert.equal(
      store.getWhisperReceipt("slack:workspace-a:C123:601.0", dossierless.id),
      undefined,
    );
    assert.equal(store.getWhisperReceipt("slack:workspace-a:C123:602.0", disabled.id), undefined);
    assert.equal(
      testHarness.before?.(
        { prompt: "missing identity", messages: [] },
        { ...promptContext("U123", "dossierless-run"), senderId: undefined },
      ),
      undefined,
    );
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
  assert.equal(testHarness.agentEnd, undefined);
  testHarness.stores.closeAll();
});

test("renders only the bounded stored blurb", () => {
  assert.equal(renderPeopleWhisper("  useful context  ", 8), "useful c");
  assert.equal(renderPeopleWhisper("   ", 8), undefined);
});
