import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "../src/config.js";
import { registerPeopleTools } from "../src/people-tools.js";
import { PeopleStores } from "../src/people-store.js";
import type { SlackDirectoryReader } from "../src/slack-directory.js";
import { createOpenClawSlackDirectory } from "../src/slack-directory.js";

const peopleConfig: UnblockMemoryConfig["people"] = {
  enabled: true,
  refinement: { maxPeoplePerRun: 2 },
  whisperer: { enabled: true, maxChars: 1200 },
  todos: { maxOpen: 10 },
};

type Tool = {
  execute(
    toolCallId: string,
    params: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
};

function resultJson(result: {
  content: Array<{ type: string; text: string }>;
}): Record<string, unknown> {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return JSON.parse(content!.text) as Record<string, unknown>;
}

async function harness(
  reader: SlackDirectoryReader = {
    async listUsers() {
      return [];
    },
  },
) {
  const root = await mkdtemp(join(tmpdir(), "unblock-memory-people-tools-"));
  const cfg = {} as OpenClawConfig;
  const stores = new PeopleStores({ stateRoot: root, maxOpenTodos: 10, maxBlurbChars: 1200 });
  const factories = new Map<string, OpenClawPluginToolFactory>();
  const options = new Map<string, { optional?: boolean }>();
  const api = {
    registerTool(
      factory: OpenClawPluginToolFactory,
      opts?: { names?: string[]; optional?: boolean },
    ) {
      for (const name of opts?.names ?? []) {
        factories.set(name, factory);
        options.set(name, opts ?? {});
      }
    },
  } as unknown as OpenClawPluginApi;
  registerPeopleTools(api, stores, peopleConfig, reader);
  const maybeTool = (name: string, owner = false) => {
    const factory = factories.get(name);
    assert.ok(factory);
    return factory({
      config: cfg,
      agentId: "bill",
      senderIsOwner: owner,
    } as OpenClawPluginToolContext) as Tool | null;
  };
  const tool = (name: string, owner = false) => {
    const created = maybeTool(name, owner);
    assert.ok(created);
    return created;
  };
  return { stores, options, maybeTool, tool };
}

const dossier = {
  schemaVersion: 1 as const,
  blurb: "Prefers concise decisions with explicit owners.",
  sections: [
    {
      category: "preferences" as const,
      claims: [
        {
          statement: "Prefers concise decisions.",
          evidence: [{ source: "manual" as const, locator: "operator note" }],
          epistemicType: "reported" as const,
        },
      ],
    },
  ],
};

test("people tools are optional and administrative updates use host owner authority", async () => {
  const testHarness = await harness();
  try {
    assert.deepEqual(
      [...testHarness.options.values()].map((entry) => entry.optional),
      [true, true, true],
    );
    for (const name of ["memory_people_inspect", "memory_people_update", "memory_people_sync"]) {
      assert.equal(testHarness.maybeTool(name), null);
    }
    const store = testHarness.stores.get("bill");
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U123",
      displayName: "Bek",
    });

    assert.equal(store.getPerson(person.id)?.refinementEnabled, false);

    const company = resultJson(
      await testHarness.tool("memory_people_update", true).execute("call", {
        action: "set_company",
        personId: person.id,
        companyName: "Unblock Labs",
        primaryDomain: "unblock.ai",
      }),
    );
    assert.equal(company.status, "ok");
    await testHarness.tool("memory_people_update", true).execute("call", {
      action: "set_policy",
      personId: person.id,
      refinementEnabled: true,
      injectionEnabled: true,
    });
    store.replaceDossier(person.id, dossier, undefined, { requireRefinementEnabled: true });

    const inspected = resultJson(
      await testHarness.tool("memory_people_inspect", true).execute("call", {
        view: "person",
        identity: { provider: "slack", accountScope: "workspace", externalId: "U123" },
      }),
    );
    assert.equal(inspected.status, "ok");
    assert.equal((inspected.company as { name: string }).name, "Unblock Labs");
    assert.equal(inspected.injectionEligible, true);
    assert.equal(inspected.contribution, dossier.blurb);
  } finally {
    testHarness.stores.closeAll();
  }
});

test("owners can restore a soft-deleted person without re-enabling its policies", async () => {
  const testHarness = await harness();
  try {
    const store = testHarness.stores.get("bill");
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U123",
    });
    store.setPolicies(person.id, { refinementEnabled: true, injectionEnabled: true });
    store.softDeletePerson(person.id);

    const restored = resultJson(
      await testHarness.tool("memory_people_update", true).execute("call", {
        action: "restore_person",
        personId: person.id,
      }),
    );
    assert.equal(restored.status, "ok");
    assert.deepEqual(
      {
        status: store.getPerson(person.id)?.status,
        refinementEnabled: store.getPerson(person.id)?.refinementEnabled,
        injectionEnabled: store.getPerson(person.id)?.injectionEnabled,
      },
      { status: "active", refinementEnabled: false, injectionEnabled: false },
    );
  } finally {
    testHarness.stores.closeAll();
  }
});

test("manual Slack sync is owner-only, idempotent, normalized, and preserves the canonical name", async () => {
  let reads = 0;
  const reader: SlackDirectoryReader = {
    async listUsers() {
      reads += 1;
      return [
        {
          id: "U123",
          name: "Directory Name",
          handle: "bek",
          avatarUrl: "https://example.test/bek.png",
        },
        { id: "U456", name: "New Person" },
      ];
    },
  };
  const testHarness = await harness(reader);
  try {
    const store = testHarness.stores.get("bill");
    const existing = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U123",
      displayName: "Curated Name",
    });
    assert.equal(reads, 0);

    const first = resultJson(
      await testHarness.tool("memory_people_sync", true).execute("call", {
        accountId: "workspace",
        limit: 10,
      }),
    );
    assert.deepEqual(
      {
        created: first.created,
        updated: first.updated,
        unchanged: first.unchanged,
        failed: first.failed,
      },
      { created: 1, updated: 1, unchanged: 0, failed: 0 },
    );
    const second = resultJson(
      await testHarness.tool("memory_people_sync", true).execute("call", {
        accountId: "workspace",
        limit: 10,
      }),
    );
    assert.deepEqual(
      {
        created: second.created,
        updated: second.updated,
        unchanged: second.unchanged,
        failed: second.failed,
      },
      { created: 0, updated: 0, unchanged: 2, failed: 0 },
    );
    assert.equal(store.getPerson(existing.person.id)?.displayName, "Curated Name");
    assert.equal(store.findIdentity("slack", "workspace", "U123")?.displayName, "Directory Name");
    assert.equal(
      store.findPersonByIdentity("slack", "workspace", "U456")?.refinementEnabled,
      false,
    );
    const enrichmentTodo = store.listTodos().find((todo) => todo.kind === "needs_enrichment");
    assert.equal(enrichmentTodo?.status, "open");
    const resolved = resultJson(
      await testHarness.tool("memory_people_update", true).execute("call", {
        action: "resolve_todo",
        deduplicationKey: enrichmentTodo!.deduplicationKey,
        note: "directory sync reviewed",
      }),
    );
    assert.equal(resolved.status, "ok");
    assert.equal((resolved.todo as { status: string }).status, "resolved");
    assert.equal(
      store.listTodos().some((todo) => todo.id === enrichmentTodo?.id),
      false,
    );
  } finally {
    testHarness.stores.closeAll();
  }
});

test("production Slack reader delegates auth to the bounded OpenClaw directory CLI", async () => {
  const calls: Array<{ executable: string; args: readonly string[]; maxBuffer: number }> = [];
  const reader = createOpenClawSlackDirectory(async (executable, args, options) => {
    calls.push({ executable, args, maxBuffer: options.maxBuffer });
    return {
      stdout: JSON.stringify([
        {
          kind: "user",
          id: " user:U123 ",
          name: " Bek ",
          handle: " @bek ",
          raw: { token: "DO_NOT_COPY", profile: { title: "unsupported raw field" } },
        },
      ]),
    };
  });
  assert.deepEqual(await reader.listUsers({ accountId: "workspace", limit: 25 }), [
    {
      id: "U123",
      name: "Bek",
      handle: "bek",
    },
  ]);
  assert.deepEqual(calls, [
    {
      executable: "openclaw",
      args: [
        "directory",
        "peers",
        "list",
        "--channel",
        "slack",
        "--account",
        "workspace",
        "--limit",
        "25",
        "--json",
      ],
      maxBuffer: 1024 * 1024,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(await reader.listUsers({ accountId: "workspace", limit: 25 })),
    /DO_NOT_COPY/,
  );
});
