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
import { resolveConfig, type UnblockMemoryConfig } from "../src/config.js";
import type { QmdMemoryRuntime } from "../src/runtime.js";
import { registerPeopleTools } from "../src/people-tools.js";
import { PeopleStores } from "../src/people-store.js";
import type { SlackDirectoryReader } from "../src/slack-directory.js";
import { reviewIndexedClaim } from "../src/evidence-review.js";
import { reviewFixture } from "./helpers/review-store.js";

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
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
};

type ObjectSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, ObjectSchema>;
  items?: ObjectSchema;
  enum?: string[];
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
  optionsOverride: { config?: UnblockMemoryConfig; runtime?: QmdMemoryRuntime } = {},
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
  registerPeopleTools(api, stores, optionsOverride.config ?? resolveConfig({ people: peopleConfig }),
    optionsOverride.runtime ?? { async getMemorySearchManager() { throw new Error("Unexpected memory access"); } } as unknown as QmdMemoryRuntime, reader);
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
  blurb: "Mira is the founder of ExampleCo.",
  sections: [
    {
      category: "role" as const,
      claims: [
        {
          statement: "Mira is the founder of ExampleCo.",
          evidence: [{ source: "manual" as const, locator: "operator note" }],
          epistemicType: "reported" as const,
        },
      ],
    },
  ],
};

const manualVerification = "Verified every assertion and background-only eligibility against Mira's explicit original operator note.";

async function writeHarness(t: test.TestContext) {
  const f = await reviewFixture(); t.after(f.close);
  const note = await f.insert("# Mira\nMira is the founder of ExampleCo.");
  const config = resolveConfig({ people: peopleConfig, typesafe: { apiKey: "test-key" },
    peoplePrimer: { enabled: true, corpora: ["memory"] } });
  const calls: Array<Parameters<typeof reviewIndexedClaim>[0]> = [];
  const runtime = { async getMemorySearchManager() { return { manager: {
    async reviewClaim(params: Parameters<typeof reviewIndexedClaim>[0]) {
      calls.push(params);
      return reviewIndexedClaim({ ...f.params, ...params });
    },
  } }; } } as unknown as QmdMemoryRuntime;
  const h = await harness(undefined, { config, runtime }); t.after(() => h.stores.closeAll());
  const store = h.stores.get("bill");
  const person = store.upsertIdentity({ provider: "slack", accountScope: "workspace", externalId: "U123", displayName: "Mira" }).person;
  store.replaceDossier(person.id, "Original", dossier);
  const proposed = structuredClone(dossier);
  proposed.sections[0]!.claims[0]!.evidence[0]!.locator = `${note.uri}#L2-L2`;
  const input = { action: "replace_dossier", personId: person.id, reason: "Verified identity", agentName: "Bill", dossier: proposed };
  const update = h.tool("memory_people_update");
  return { ...h, store, person, config, calls, input,
    write: (overrides: Record<string, unknown> = {}, signal?: AbortSignal) => update.execute("write", { ...input, ...overrides }, signal).then(resultJson) };
}

function backgroundResponse(needsReview = false) {
  return Response.json({ answers: {
    relation: { type: "choice", choice: "supports", confidence: 0.99,
      probabilities: { supports: 0.99, contradicts: 0.005, insufficient_evidence: 0.005 } },
    backgroundOnly: { type: "noul", noul: needsReview ? 0.05 : 0.99 },
    explicitSupport: { type: "noul", noul: 0.99 },
  } });
}

test("dossier update reviews indexed blurb and saves once only on a passing judgment", async t => {
  const h = await writeHarness(t);
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
    requests.push(JSON.parse(String(init?.body)));
    return backgroundResponse();
  });
  const result = await h.write();
  assert.equal(result.status, "ok");
  assert.equal(result.verification, "typesafe");
  assert.equal(requests.length, 1);
  assert.deepEqual(h.calls[0]?.personBackground, { name: "Mira", agentName: "Bill" });
  assert.deepEqual(h.calls[0]?.citations, [{ path: h.calls[0]!.citations[0]!.path, from: 2, lines: 1 }]);
  assert.equal(h.store.listDossierChanges(h.person.id).length, 2);
  assert.match(h.store.listDossierChanges(h.person.id)[0]!.reason, /TypeSafe background review passed/);
});

test("rejected, failed and unapproved reviews preserve dossier and history", async t => {
  const h = await writeHarness(t);
  const before = h.store.getDossier(h.person.id), history = h.store.listDossierChanges(h.person.id);
  let mode = "reject", requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    if (mode === "error") throw new Error("sensitive-provider-diagnostic");
    if (mode === "invalid") return Response.json({ unexpected: true });
    return backgroundResponse(true);
  });
  assert.equal((await h.write()).status, "needs_review");
  for (mode of ["error", "invalid"]) {
    const result = await h.write();
    assert.equal(result.status, "review_unavailable");
    assert.equal(JSON.stringify(result).includes("sensitive-provider-diagnostic"), false);
  }
  const bad = structuredClone(h.input.dossier);
  bad.sections[0]!.claims[0]!.evidence[0]!.locator = "qmd://unapproved/private.md#L1-L2";
  assert.equal((await h.write({ dossier: bad })).status, "review_unavailable");
  assert.equal(requests, 3, "unapproved evidence must never reach the provider");
  assert.deepEqual(h.store.getDossier(h.person.id), before);
  assert.deepEqual(h.store.listDossierChanges(h.person.id), history);
});

test("disabled or missing-key review requires explicit manual verification without provider calls", async t => {
  const h = await writeHarness(t);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected provider call"); });
  h.config.peoplePrimer.enabled = false;
  assert.equal((await h.write()).status, "review_unavailable");
  h.config.peoplePrimer.enabled = true;
  h.config.typesafe.enabled = false;
  assert.equal((await h.write()).status, "review_unavailable");
  h.config.typesafe.enabled = true;
  h.config.typesafe.apiKey = undefined;
  h.config.typesafe.apiKeyFile = "/nonexistent/people-review-key";
  assert.equal((await h.write()).status, "review_unavailable");
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.listDossierChanges(h.person.id).length, 1);
  const result = await h.write({ dossier, manualVerification });
  assert.equal(result.status, "ok");
  assert.equal(result.verification, "manual");
  assert.match(h.store.listDossierChanges(h.person.id)[0]!.reason, /Manual verification: Verified every assertion/);
  assert.equal(h.calls.length, 0);
});

test("manual verification cannot bypass shape limits, and invalid inputs do not spend provider calls", async t => {
  const h = await writeHarness(t);
  for (const manual of [undefined, manualVerification]) {
    await assert.rejects(h.write({ manualVerification: manual, dossier: { ...dossier, blurb: "word ".repeat(71) } }), /70 words/);
    await assert.rejects(h.write({ manualVerification: manual, dossier: { ...dossier, sections: [{ ...dossier.sections[0], category: "preferences" }] } }));
  }
  await assert.rejects(h.write({ manualVerification: " " }));
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.listDossierChanges(h.person.id).length, 1);
});

test("malformed, missing and excessive citation ranges fail closed before review", async t => {
  const h = await writeHarness(t);
  const reference = h.input.dossier.sections[0]!.claims[0]!.evidence[0]!;
  for (const locators of [["operator note"], ["qmd://memory/mira.md#L8-L2"],
    ["qmd://memory/mira.md#L1-L121"], ["qmd://memory/mira.md#L9007199254740992"],
    [1, 2, 3, 4].map(n => `qmd://memory/mira.md#L${n}`)]) {
    const bad = structuredClone(h.input.dossier);
    bad.sections[0]!.claims[0]!.evidence = locators.map(locator => ({ ...reference, locator }));
    assert.equal((await h.write({ dossier: bad })).status, "review_unavailable");
  }
  assert.equal((await h.write({ dossier: { ...dossier, sections: [] } })).status, "review_unavailable");
  assert.equal(h.calls.length, 0);
});

test("in-flight review cannot overwrite concurrent writes, deletions or archived people", async t => {
  for (const mutation of ["replace", "delete", "replace_then_delete", "archive"]) {
    const h = await writeHarness(t);
    t.mock.method(globalThis, "fetch", async () => {
      if (mutation === "replace" || mutation === "replace_then_delete") h.store.replaceDossier(h.person.id, "Newer correction", dossier);
      if (mutation === "delete" || mutation === "replace_then_delete") h.store.deleteDossier(h.person.id, "Newer deletion");
      if (mutation === "archive") h.store.softDeletePerson(h.person.id);
      return backgroundResponse();
    });
    assert.equal((await h.write()).status, "conflict", mutation);
    assert.equal(h.store.listDossierChanges(h.person.id).some(change => change.reason.startsWith("Verified identity")), false);
    t.mock.restoreAll();
  }
});

test("cancelled reviews never save, including explicit manual writes", async t => {
  const h = await writeHarness(t);
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => { controller.abort(); return backgroundResponse(); });
  assert.equal((await h.write({}, controller.signal)).status, "review_unavailable");
  assert.equal((await h.write({ manualVerification }, controller.signal)).status, "review_unavailable");
  assert.equal(h.store.listDossierChanges(h.person.id).length, 1);
});

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
          reason: "Captured explicit background",
          manualVerification: "Verified the founder role in the original operator note.",
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
        { action: "replace", reason: "Captured explicit background\nManual verification: Verified the founder role in the original operator note." },
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

    const section = update.properties?.dossier?.properties?.sections?.items;
    assert.deepEqual(section?.properties?.category?.enum, ["role", "relationship"]);
    assert.deepEqual(section?.properties?.claims?.items?.properties?.epistemicType?.enum, ["observed", "reported"]);

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
