import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { UnblockMemoryConfig } from "./config.js";
import { renderPeopleWhisper } from "./people-hooks.js";
import { renderPeopleDossier } from "./people-background.js";
import {
  DossierConflictError,
  PERSON_DOSSIER_WRITE_SCHEMA,
  type PeopleStore,
  type PeopleStores,
} from "./people-store.js";
import { getContext, runtimeConfig } from "./tool-context.js";
import type { QmdMemoryRuntime } from "./runtime.js";
import { reviewPersonDossier } from "./people-dossier-review.js";
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
      view: Type.Literal("people"),
      includeInactive: Type.Optional(Type.Boolean({ description: "Include unavailable/archived people for a complete dossier audit; never reactivate them." })),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "Maximum active people to return.",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "People to skip." }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      view: Type.Literal("dossier_changes"),
      personId: nonEmpty,
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: "Maximum dossier change summaries to return, newest first.",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Changes to skip." }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      view: Type.Literal("dossier_change"),
      personId: nonEmpty,
      changeId: nonEmpty,
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
      action: Type.Literal("set_injection"),
      personId: nonEmpty,
      enabled: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("replace_dossier"),
      personId: nonEmpty,
      dossier: PERSON_DOSSIER_WRITE_SCHEMA,
      reason: Type.String({ pattern: "\\S", maxLength: 500 }),
      agentName: Type.Optional(Type.String({ pattern: "\\S", maxLength: 100 })),
      manualVerification: Type.Optional(Type.String({ pattern: "\\S", maxLength: 400,
        description: "Source-specific attestation that you checked every saved claim, its scope and any newer corrections. Distinguish explicit preferences from provisional agent lessons. Skips automated review; recorded as manual. Never use as a blind retry switch." })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("delete_dossier"),
      personId: nonEmpty,
      reason: nonEmpty,
      expectedRevision: Type.Optional(Type.Union([nonEmpty, Type.Null()])),
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
      ? renderPeopleWhisper(renderPeopleDossier(dossier.dossier), maxChars)
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

type UpdateInput = Static<typeof updateParameters>;
type ReplaceDossierInput = Extract<UpdateInput, { action: "replace_dossier" }>;

function nextPageOffset(offset: number, count: number, limit: number): number | null {
  return count === limit ? offset + count : null;
}

async function handleReplaceDossier(params: {
  store: PeopleStore;
  config: UnblockMemoryConfig;
  runtime: QmdMemoryRuntime;
  active: NonNullable<ReturnType<typeof getContext>>;
  input: ReplaceDossierInput;
  signal?: AbortSignal;
}) {
  const { store, config, runtime, active, input, signal } = params;
  const person = store.getPerson(input.personId);
  if (!person || person.status !== "active") return jsonResult({ status: "not_found" });
  const proposed = store.validateDossier(input.dossier);
  const revision = store.getDossierRevision(input.personId);
  if (signal?.aborted) {
    return jsonResult({
      status: "review_unavailable",
      needsReview: true,
      reason: "Cancelled; no dossier written",
    });
  }
  const review = input.manualVerification
    ? { status: "manual" as const, needsReview: false, note: input.manualVerification }
    : await reviewPersonDossier({
        config,
        runtime,
        active,
        person,
        dossier: proposed,
        agentName: input.agentName,
        signal,
      });
  if (review.needsReview || signal?.aborted) {
    return jsonResult({
      status: review.status === "ok" && !signal?.aborted ? "needs_review" : "review_unavailable",
      needsReview: true,
      saved: false,
      review,
    });
  }
  const audit =
    review.status === "manual"
      ? `Manual verification: ${review.note}`
      : "Decision model review passed for every dossier assertion (person-interaction-v1)";
  try {
    const saved = store.replaceVerifiedDossier(
      input.personId,
      `${input.reason}\n${audit}`,
      proposed,
      audit,
      revision,
    );
    if (!saved) return jsonResult({ status: "not_found" });
    return jsonResult({
      status: "ok",
      saved: true,
      changeId: saved.changeId,
      verification: review.status === "manual" ? "manual" : "decision",
      dossier: saved.dossier,
      review,
    });
  } catch (error) {
    if (error instanceof DossierConflictError) {
      return jsonResult({ status: "conflict", saved: false, reason: error.message });
    }
    throw error;
  }
}

function createInspectTool(
  stores: PeopleStores,
  config: UnblockMemoryConfig["people"],
  ctx: OpenClawPluginToolContext,
) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_people_inspect",
    label: "Inspect People Memory",
    description:
      "List active people, inspect one person, read dossier change history, or list actionable people todos. injectionEligible is a record-level preview, not proof that global hooks or an already-served thread will inject.",
    parameters: inspectParameters,
    async execute(_toolCallId: string, raw: unknown) {
      const input = Value.Parse(inspectParameters, raw);
      if (input.view === "person") {
        return jsonResult(personView(stores, active.agentId, input, config.whisperer.maxChars));
      }
      const store = stores.get(active.agentId);
      switch (input.view) {
        case "people": {
          const limit = input.limit ?? 50;
          const offset = input.offset ?? 0;
          const people = store.listActivePeople(limit, offset, input.includeInactive ?? false).map((person) => {
            const dossierReviewedAt = store.getDossierReviewedAt(person.id);
            return {
              person,
              identities: store.listIdentities(person.id),
              hasDossier: dossierReviewedAt !== undefined,
              dossierReviewedAt: dossierReviewedAt ?? null,
            };
          });
          return jsonResult({
            status: "ok",
            people,
            nextOffset: nextPageOffset(offset, people.length, limit),
          });
        }
        case "dossier_changes": {
          const limit = input.limit ?? 20;
          const offset = input.offset ?? 0;
          const changes = store.listDossierChanges(input.personId, limit, offset);
          return jsonResult({
            status: "ok",
            changes,
            nextOffset: nextPageOffset(offset, changes.length, limit),
          });
        }
        case "dossier_change": {
          const change = store.getDossierChange(input.personId, input.changeId);
          return jsonResult(change ? { status: "ok", change } : { status: "not_found" });
        }
        case "todos":
          return jsonResult({
            status: "ok",
            todos: store.listTodos(input.limit ?? 20),
          });
      }
    },
  };
}

function createUpdateTool(stores: PeopleStores, config: UnblockMemoryConfig, runtime: QmdMemoryRuntime, ctx: OpenClawPluginToolContext) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_people_update",
    label: "Update People Memory",
    description:
      "Curate ongoing interaction feedback during nightly dreaming for the exact person. Replace a complete dossier: identity blurb <=70 words; role/relationship, preferences and workingStyle sections. Cite original evidence for every claim; preserve verified existing claims and their scope. Agent-assessed lessons require reviewedAt and expiresAt within 30 days. Automatic review checks every statement; use source-specific manualVerification only after checking original sources yourself. Delete contradicted/stale claims with a reason. Context refreshes on the next user turn.",
    parameters: updateParameters,
    async execute(_toolCallId: string, raw: unknown, signal?: AbortSignal) {
      const input = Value.Parse(updateParameters, raw);
      const store = stores.get(active.agentId);
      switch (input.action) {
        case "set_injection": {
          const person = store.setInjection(input.personId, input.enabled);
          return jsonResult(person ? { status: "ok", person } : { status: "not_found" });
        }
        case "replace_dossier":
          return handleReplaceDossier({ store, config, runtime, active, input, signal });
        case "delete_dossier":
          try {
            return jsonResult(
              store.deleteDossier(input.personId, input.reason, input.expectedRevision)
                ? { status: "ok" }
                : { status: "not_found" },
            );
          } catch (error) {
            if (error instanceof DossierConflictError) {
              return jsonResult({ status: "conflict", saved: false, reason: error.message });
            }
            throw error;
          }
        case "set_company": {
          const company = store.setCompany(input.personId, {
            name: input.companyName,
            primaryDomain: input.primaryDomain,
          });
          const person = store.getPerson(input.personId);
          return jsonResult(
            company && person ? { status: "ok", company, person } : { status: "not_found" },
          );
        }
        case "resolve_todo": {
          const todo = store.resolveTodoByKey(input.deduplicationKey, input.note);
          return jsonResult(todo ? { status: "ok", todo } : { status: "not_found" });
        }
        case "restore_person": {
          const person = store.restorePerson(input.personId);
          return jsonResult(person ? { status: "ok", person } : { status: "not_found" });
        }
        case "soft_delete_person": {
          const person = store.softDeletePerson(input.personId);
          return jsonResult(person ? { status: "ok", person } : { status: "not_found" });
        }
      }
    },
  };
}

function createSyncTool(
  stores: PeopleStores,
  reader: SlackDirectoryReader,
  ctx: OpenClawPluginToolContext,
) {
  const active = getContext(ctx);
  if (!active) return null;
  return {
    name: "memory_people_sync",
    label: "Sync Slack People",
    description:
      "Manually enrich this agent's people store from one OpenClaw-authenticated Slack directory account (users:read). At most 200 entries from the directory start, without a continuation cursor. Skips unavailable people; deactivation disables the linked person and injection.",
    parameters: syncParameters,
    async execute(_toolCallId: string, raw: unknown) {
      const input = Value.Parse(syncParameters, raw);
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
  config: UnblockMemoryConfig,
  runtime: QmdMemoryRuntime,
  directoryReader?: SlackDirectoryReader,
): void {
  api.registerTool((ctx) => createInspectTool(stores, config.people, ctx), {
    names: ["memory_people_inspect"],
  });
  api.registerTool((ctx) => createUpdateTool(stores, config, runtime, ctx), {
    names: ["memory_people_update"],
  });
  api.registerTool(
    (ctx) =>
      createSyncTool(
        stores,
        directoryReader ??
          createOpenClawSlackDirectory({
            getConfig: () => runtimeConfig(ctx),
          }),
        ctx,
      ),
    {
      names: ["memory_people_sync"],
      optional: true,
    },
  );
}
