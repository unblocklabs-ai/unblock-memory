import assert from "node:assert/strict";
import { normalizeToolParameterSchema } from "@openclaw/ai/internal/openai";
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

const peopleConfig: UnblockMemoryConfig["people"] = {
  enabled: true,
  whisperer: { enabled: true, maxChars: 1200 },
  todos: { maxOpen: 10 },
};

type Tool = {
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
};

type ObjectSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
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
  const maybeTool = (name: string, owner?: boolean) => {
    const factory = factories.get(name);
    assert.ok(factory);
    return factory({
      config: cfg,
      agentId: "bill",
      ...(owner === undefined ? {} : { senderIsOwner: owner }),
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

test("people tools let the agent inspect and update dossiers without owner gating", async () => {
  const testHarness = await harness();
  try {
    assert.deepEqual(
      [...testHarness.options.values()].map((entry) => entry.optional),
      [undefined, undefined, true],
    );
    for (const owner of [undefined, false, true]) {
      for (const name of ["memory_people_inspect", "memory_people_update", "memory_people_sync"]) {
        assert.ok(testHarness.maybeTool(name, owner));
      }
    }
    const store = testHarness.stores.get("bill");
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U123",
      displayName: "Bek",
    });
    const other = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U456",
      displayName: "Other",
    }).person;

    assert.equal(store.getPerson(person.id)?.injectionEnabled, true);

    const company = resultJson(
      await testHarness.tool("memory_people_update").execute("call", {
        action: "set_company",
        personId: person.id,
        companyName: "Unblock Labs",
        primaryDomain: "unblock.ai",
      }),
    );
    assert.equal(company.status, "ok");
    await testHarness.tool("memory_people_update").execute("call", {
      action: "set_injection",
      personId: person.id,
      enabled: true,
    });
    assert.equal(
      resultJson(
        await testHarness.tool("memory_people_update").execute("call", {
          action: "replace_dossier",
          personId: person.id,
          dossier,
          reason: "Captured a durable preference",
        }),
      ).status,
      "ok",
    );

    const inspected = resultJson(
      await testHarness.tool("memory_people_inspect").execute("call", {
        view: "person",
        identity: { provider: "slack", accountScope: "workspace", externalId: "U123" },
      }),
    );
    assert.equal(inspected.status, "ok");
    assert.equal((inspected.company as { name: string }).name, "Unblock Labs");
    assert.equal(inspected.injectionEligible, true);
    assert.equal(inspected.contribution, dossier.blurb);

    await testHarness.tool("memory_people_update").execute("call", {
      action: "set_injection",
      personId: person.id,
      enabled: false,
    });
    assert.equal(store.getPerson(person.id)?.injectionEnabled, false);
    assert.equal(store.getPerson(other.id)?.injectionEnabled, true);

    const inspectedById = resultJson(
      await testHarness.tool("memory_people_inspect").execute("call", {
        view: "person",
        personId: person.id,
      }),
    );
    assert.equal(inspectedById.status, "ok");
    assert.equal(
      resultJson(
        await testHarness.tool("memory_people_update").execute("call", {
          action: "delete_dossier",
          personId: person.id,
          reason: "The dossier became unreliable",
        }),
      ).status,
      "ok",
    );
    assert.equal(store.getDossier(person.id), undefined);
    const history = resultJson(
      await testHarness.tool("memory_people_inspect").execute("call", {
        view: "dossier_changes",
        personId: person.id,
      }),
    );
    assert.deepEqual(
      (history.changes as Array<{ action: string; reason: string }>).map(
        ({ action, reason }) => ({ action, reason }),
      ),
      [
        { action: "delete", reason: "The dossier became unreliable" },
        { action: "replace", reason: "Captured a durable preference" },
      ],
    );
    const firstChange = (history.changes as Array<{ id: string }>)[0]!;
    const exactChange = resultJson(
      await testHarness.tool("memory_people_inspect").execute("call", {
        view: "dossier_change",
        personId: person.id,
        changeId: firstChange.id,
      }),
    );
    assert.equal(exactChange.status, "ok");
    assert.equal((exactChange.change as { action: string }).action, "delete");
  } finally {
    testHarness.stores.closeAll();
  }
});

test("person selectors survive OpenClaw model schema normalization", async () => {
  const testHarness = await harness();
  try {
    const inspect = testHarness.tool("memory_people_inspect");
    const normalized = normalizeToolParameterSchema(inspect.parameters) as ObjectSchema;
    const update = normalizeToolParameterSchema(
      testHarness.tool("memory_people_update").parameters,
    ) as ObjectSchema;

    assert.equal(normalized.type, "object");
    assert.deepEqual(normalized.required, ["view"]);
    assert.deepEqual(Object.keys(normalized.properties ?? {}).sort(), [
      "changeId",
      "identity",
      "limit",
      "offset",
      "personId",
      "view",
    ]);
    assert.deepEqual(
      (normalized.properties?.view as { enum?: string[] } | undefined)?.enum,
      ["person", "people", "dossier_changes", "dossier_change", "todos"],
    );
    assert.deepEqual(
      Object.keys(
        ((normalized.properties?.identity as ObjectSchema | undefined)?.properties ?? {}),
      ).sort(),
      ["accountScope", "externalId", "provider"],
    );
    assert.deepEqual(
      (update.properties?.action as { enum?: string[] } | undefined)?.enum,
      [
        "set_injection",
        "replace_dossier",
        "delete_dossier",
        "set_company",
        "resolve_todo",
        "soft_delete_person",
        "restore_person",
      ],
    );

    await assert.rejects(
      inspect.execute("call", {
        view: "person",
        id: "U123",
        accountId: "default",
      }),
    );
    await assert.rejects(
      testHarness.tool("memory_people_update").execute("call", {
        action: "replace_dossier",
        personId: "person-1",
        dossier,
      }),
    );
    await assert.rejects(
      testHarness.tool("memory_people_update").execute("call", {
        action: "delete_dossier",
        personId: "person-1",
        reason: "   ",
      }),
    );
  } finally {
    testHarness.stores.closeAll();
  }
});

test("agents can list a bounded set of active people without full dossiers", async () => {
  const testHarness = await harness();
  try {
    const store = testHarness.stores.get("bill");
    const older = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U123",
      displayName: "Older",
      seenAt: "2026-08-28T12:00:00.000Z",
    }).person;
    const newer = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U456",
      displayName: "Newer",
      seenAt: "2026-08-29T12:00:00.000Z",
    }).person;
    const unavailable = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U789",
      displayName: "Unavailable",
      seenAt: "2026-08-30T12:00:00.000Z",
    }).person;
    store.softDeletePerson(unavailable.id);
    store.replaceDossier(newer.id, "test setup", dossier);

    const result = resultJson(
      await testHarness.tool("memory_people_inspect").execute("call", {
        view: "people",
        limit: 2,
      }),
    );
    const people = result.people as Array<Record<string, unknown>>;
    assert.equal(result.status, "ok");
    assert.deepEqual(
      people.map((entry) => (entry.person as { id: string }).id),
      [newer.id, older.id],
    );
    assert.equal(people[0]?.hasDossier, true);
    assert.equal(typeof people[0]?.dossierReviewedAt, "string");
    assert.equal("dossier" in (people[0] ?? {}), false);
    assert.equal(people[1]?.hasDossier, false);
    assert.equal(people[1]?.dossierReviewedAt, null);
    assert.equal((people[0]?.identities as unknown[]).length, 1);
    assert.equal(result.nextOffset, 2);
    const exhausted = resultJson(
      await testHarness.tool("memory_people_inspect").execute("call", {
        view: "people",
        limit: 2,
        offset: result.nextOffset,
      }),
    );
    assert.deepEqual(exhausted.people, []);
    assert.equal(exhausted.nextOffset, null);
  } finally {
    testHarness.stores.closeAll();
  }
});

test("agents can restore a soft-deleted person without re-enabling injection", async () => {
  const testHarness = await harness();
  try {
    const store = testHarness.stores.get("bill");
    const { person } = store.upsertIdentity({
      provider: "slack",
      accountScope: "workspace",
      externalId: "U123",
    });
    store.setInjection(person.id, true);
    store.softDeletePerson(person.id);

    const restored = resultJson(
      await testHarness.tool("memory_people_update").execute("call", {
        action: "restore_person",
        personId: person.id,
      }),
    );
    assert.equal(restored.status, "ok");
    assert.deepEqual(
      {
        status: store.getPerson(person.id)?.status,
        injectionEnabled: store.getPerson(person.id)?.injectionEnabled,
      },
      { status: "active", injectionEnabled: false },
    );
  } finally {
    testHarness.stores.closeAll();
  }
});

test("manual Slack sync is ungated, idempotent, normalized, and preserves the canonical name", async () => {
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
      await testHarness.tool("memory_people_sync").execute("call", {
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
      await testHarness.tool("memory_people_sync").execute("call", {
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
      store.findPersonByIdentity("slack", "workspace", "U456")?.injectionEnabled,
      true,
    );
    const enrichmentTodo = store.listTodos().find((todo) => todo.kind === "needs_enrichment");
    assert.equal(enrichmentTodo?.status, "open");
    const resolved = resultJson(
      await testHarness.tool("memory_people_update").execute("call", {
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
