import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { UnblockMemoryConfig } from "./config.js";
import { renderPeopleWhisper } from "./people-hooks.js";
import type { PeopleStores } from "./people-store.js";
import {
  createOpenClawSlackDirectory,
  syncSlackDirectory,
  type SlackDirectoryReader,
} from "./slack-directory.js";

const nonEmpty = Type.String({ pattern: "\\S", maxLength: 1000 });
const inspectParameters = Type.Union([
  Type.Object(
    {
      view: Type.Literal("person"),
      personId: Type.String({
        pattern: "\\S",
        maxLength: 1000,
        description: "PeopleSQL person ID. Use identity when only Slack IDs are known.",
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      view: Type.Literal("person"),
      identity: Type.Object(
        {
          provider: Type.Literal("slack"),
          accountScope: Type.String({
            pattern: "\\S",
            maxLength: 1000,
            description: "Configured Slack account ID, for example default.",
          }),
          externalId: Type.String({
            pattern: "\\S",
            maxLength: 1000,
            description: "Exact Slack user ID.",
          }),
        },
        {
          additionalProperties: false,
          description: "Exact Slack identity for the person to inspect.",
        },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      view: Type.Literal("todos"),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "Maximum actionable todos to return.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
]);

const updateParameters = Type.Union([
  Type.Object(
    {
      action: Type.Literal("set_policy"),
      personId: nonEmpty,
      refinementEnabled: Type.Optional(Type.Boolean()),
      injectionEnabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("set_company"),
      personId: nonEmpty,
      companyName: Type.String({ pattern: "\\S", maxLength: 500 }),
      primaryDomain: Type.Optional(Type.String({ pattern: "\\S", maxLength: 500 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("resolve_todo"),
      deduplicationKey: nonEmpty,
      note: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("soft_delete_person"),
      personId: nonEmpty,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("restore_person"),
      personId: nonEmpty,
    },
    { additionalProperties: false },
  ),
]);

const syncParameters = Type.Object(
  {
    accountId: Type.String({ pattern: "\\S", maxLength: 200 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

function context(ctx: OpenClawPluginToolContext): { agentId: string } | undefined {
  const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
  return cfg && ctx.agentId ? { agentId: ctx.agentId } : undefined;
}

function personView(
  stores: PeopleStores,
  agentId: string,
  selector:
    | { view: "person"; personId: string }
    | {
        view: "person";
        identity: { provider: "slack"; accountScope: string; externalId: string };
      },
  maxChars: number,
) {
  const store = stores.get(agentId);
  const person =
    "personId" in selector
      ? store.getPerson(selector.personId)
      : store.findPersonByIdentity(
          selector.identity.provider,
          selector.identity.accountScope,
          selector.identity.externalId,
        );
  if (!person) return { status: "not_found" as const };
  const dossier = store.getDossier(person.id);
  const contribution =
    person.status === "active" && person.injectionEnabled && dossier
      ? renderPeopleWhisper(dossier.dossier.blurb, maxChars)
      : undefined;
  return {
    status: "ok" as const,
    person,
    company: person.companyId ? store.getCompany(person.companyId) : undefined,
    identities: store.listIdentities(person.id),
    dossier,
    injectionEligible: contribution !== undefined,
    contribution,
  };
}

function createInspectTool(
  stores: PeopleStores,
  config: UnblockMemoryConfig["people"],
  ctx: OpenClawPluginToolContext,
) {
  const active = context(ctx);
  if (!active || ctx.senderIsOwner !== true) return null;
  return {
    name: "memory_people_inspect",
    label: "Inspect People Memory",
    description:
      "Inspect one person by PeopleSQL personId or exact Slack identity, or list bounded actionable people todos.",
    parameters: inspectParameters,
    async execute(_toolCallId: string, raw: unknown) {
      const input = Value.Parse(inspectParameters, raw);
      if (input.view === "person") {
        return jsonResult(personView(stores, active.agentId, input, config.whisperer.maxChars));
      }
      return jsonResult({
        status: "ok",
        todos: stores.get(active.agentId).listTodos(input.limit ?? 20),
      });
    },
  };
}

function createUpdateTool(stores: PeopleStores, ctx: OpenClawPluginToolContext) {
  const active = context(ctx);
  if (!active || ctx.senderIsOwner !== true) return null;
  return {
    name: "memory_people_update",
    label: "Update People Memory",
    description:
      "Apply one validated people policy, company, todo, deletion, or restoration action.",
    parameters: updateParameters,
    async execute(_toolCallId: string, raw: unknown) {
      if (ctx.senderIsOwner !== true)
        return jsonResult({ status: "forbidden", error: "owner authorization required" });
      const input = Value.Parse(updateParameters, raw);
      const store = stores.get(active.agentId);
      if (input.action === "set_policy") {
        if (input.refinementEnabled === undefined && input.injectionEnabled === undefined) {
          return jsonResult({
            status: "invalid",
            error: "set_policy requires at least one policy value",
          });
        }
        const person = store.setPolicies(input.personId, input);
        return jsonResult(person ? { status: "ok", person } : { status: "not_found" });
      }
      if (input.action === "set_company") {
        const company = store.setCompany(input.personId, {
          name: input.companyName,
          primaryDomain: input.primaryDomain,
        });
        const person = store.getPerson(input.personId);
        return jsonResult(
          company && person ? { status: "ok", company, person } : { status: "not_found" },
        );
      }
      if (input.action === "resolve_todo") {
        const todo = store.resolveTodoByKey(input.deduplicationKey, input.note);
        return jsonResult(todo ? { status: "ok", todo } : { status: "not_found" });
      }
      if (input.action === "restore_person") {
        const person = store.restorePerson(input.personId);
        return jsonResult(person ? { status: "ok", person } : { status: "not_found" });
      }
      const person = store.softDeletePerson(input.personId);
      return jsonResult(person ? { status: "ok", person } : { status: "not_found" });
    },
  };
}

function createSyncTool(
  stores: PeopleStores,
  reader: SlackDirectoryReader,
  ctx: OpenClawPluginToolContext,
) {
  const active = context(ctx);
  if (!active || ctx.senderIsOwner !== true) return null;
  return {
    name: "memory_people_sync",
    label: "Sync Slack People",
    description:
      "Manually enrich this agent's people store from one OpenClaw-authenticated Slack directory account.",
    parameters: syncParameters,
    async execute(_toolCallId: string, raw: unknown) {
      const input = Value.Parse(syncParameters, raw);
      if (ctx.senderIsOwner !== true)
        return jsonResult({ status: "forbidden", error: "owner authorization required" });
      try {
        return jsonResult(
          await syncSlackDirectory({
            store: stores.get(active.agentId),
            reader,
            accountId: input.accountId.trim(),
            limit: input.limit ?? 200,
          }),
        );
      } catch (error) {
        return jsonResult({
          status: "unavailable",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function registerPeopleTools(
  api: OpenClawPluginApi,
  stores: PeopleStores,
  config: UnblockMemoryConfig["people"],
  directoryReader?: SlackDirectoryReader,
): void {
  api.registerTool((ctx) => createInspectTool(stores, config, ctx), {
    names: ["memory_people_inspect"],
    optional: true,
  });
  api.registerTool((ctx) => createUpdateTool(stores, ctx), {
    names: ["memory_people_update"],
    optional: true,
  });
  api.registerTool(
    (ctx) =>
      createSyncTool(
        stores,
        directoryReader ??
          createOpenClawSlackDirectory({
            getConfig: () => ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config,
          }),
        ctx,
      ),
    {
      names: ["memory_people_sync"],
      optional: true,
    },
  );
}
