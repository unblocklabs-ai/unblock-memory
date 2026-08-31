import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { renderPeopleWhisper } from "./people-hooks.js";
import { nextPeopleRefinement } from "./people-refinement.js";
import { PERSON_DOSSIER_SCHEMA } from "./people-store.js";
import { createOpenClawSlackDirectory, syncSlackDirectory, } from "./slack-directory.js";
const nonEmpty = Type.String({ pattern: "\\S", maxLength: 1000 });
const inspectParameters = Type.Union([
    Type.Object({
        view: Type.Literal("person"),
        personId: Type.String({
            pattern: "\\S",
            maxLength: 1000,
            description: "PeopleSQL person ID. Use identity when only Slack IDs are known.",
        }),
    }, { additionalProperties: false }),
    Type.Object({
        view: Type.Literal("person"),
        identity: Type.Object({
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
        }, {
            additionalProperties: false,
            description: "Exact Slack identity for the person to inspect.",
        }),
    }, { additionalProperties: false }),
    Type.Object({
        view: Type.Literal("todos"),
        limit: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: 100,
            description: "Maximum actionable todos to return.",
        })),
    }, { additionalProperties: false }),
    Type.Object({
        view: Type.Literal("refinement_next"),
        evidenceLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }, { additionalProperties: false }),
]);
const updateParameters = Type.Union([
    Type.Object({
        action: Type.Literal("set_injection"),
        personId: nonEmpty,
        enabled: Type.Boolean(),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("replace_dossier"),
        personId: nonEmpty,
        dossier: Type.Optional(PERSON_DOSSIER_SCHEMA),
        consumedEvidenceLocators: Type.Optional(Type.Array(Type.String({ pattern: "^session:.+:event:\\d+$", maxLength: 1000 }), {
            minItems: 1,
            maxItems: 50,
            uniqueItems: true,
        })),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("delete_dossier"),
        personId: nonEmpty,
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("set_company"),
        personId: nonEmpty,
        companyName: Type.String({ pattern: "\\S", maxLength: 500 }),
        primaryDomain: Type.Optional(Type.String({ pattern: "\\S", maxLength: 500 })),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("resolve_todo"),
        deduplicationKey: nonEmpty,
        note: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("soft_delete_person"),
        personId: nonEmpty,
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("restore_person"),
        personId: nonEmpty,
    }, { additionalProperties: false }),
]);
const syncParameters = Type.Object({
    accountId: Type.String({ pattern: "\\S", maxLength: 200 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
}, { additionalProperties: false });
function context(ctx) {
    const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
    return cfg && ctx.agentId ? { agentId: ctx.agentId, cfg } : undefined;
}
function personView(stores, agentId, selector, maxChars) {
    const store = stores.get(agentId);
    const person = "personId" in selector
        ? store.getPerson(selector.personId)
        : store.findPersonByIdentity(selector.identity.provider, selector.identity.accountScope, selector.identity.externalId);
    if (!person)
        return { status: "not_found" };
    const dossier = store.getDossier(person.id);
    const contribution = person.status === "active" && person.injectionEnabled && dossier
        ? renderPeopleWhisper(dossier.dossier.blurb, maxChars)
        : undefined;
    return {
        status: "ok",
        person,
        company: person.companyId ? store.getCompany(person.companyId) : undefined,
        identities: store.listIdentities(person.id),
        dossier,
        injectionEligible: contribution !== undefined,
        contribution,
    };
}
function createInspectTool(stores, config, ctx) {
    const active = context(ctx);
    if (!active)
        return null;
    return {
        name: "memory_people_inspect",
        label: "Inspect People Memory",
        description: "Inspect a person, list actionable people todos, or read the next person's unseen interaction evidence for dossier refinement.",
        parameters: inspectParameters,
        async execute(_toolCallId, raw) {
            const input = Value.Parse(inspectParameters, raw);
            if (input.view === "person") {
                return jsonResult(personView(stores, active.agentId, input, config.whisperer.maxChars));
            }
            if (input.view === "refinement_next") {
                try {
                    const refinement = nextPeopleRefinement({
                        store: stores.get(active.agentId),
                        agentId: active.agentId,
                        agentDatabasePath: `${resolveAgentDir(active.cfg, active.agentId)}/openclaw-agent.sqlite`,
                        evidenceLimit: input.evidenceLimit,
                    });
                    return jsonResult(refinement ? { status: "ok", refinement } : { status: "empty" });
                }
                catch (error) {
                    return jsonResult({
                        status: "unavailable",
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            return jsonResult({
                status: "ok",
                todos: stores.get(active.agentId).listTodos(input.limit ?? 20),
            });
        },
    };
}
function createUpdateTool(stores, ctx) {
    const active = context(ctx);
    if (!active)
        return null;
    return {
        name: "memory_people_update",
        label: "Update People Memory",
        description: "Update a dossier, one person's injection preference, company, todo, or person status.",
        parameters: updateParameters,
        async execute(_toolCallId, raw) {
            const input = Value.Parse(updateParameters, raw);
            const store = stores.get(active.agentId);
            if (input.action === "set_injection") {
                const person = store.setInjection(input.personId, input.enabled);
                return jsonResult(person ? { status: "ok", person } : { status: "not_found" });
            }
            if (input.action === "replace_dossier") {
                if (input.dossier === undefined && input.consumedEvidenceLocators === undefined) {
                    return jsonResult({
                        status: "invalid",
                        error: "replace_dossier requires a dossier or consumed evidence locators",
                    });
                }
                try {
                    const dossier = store.replaceDossier(input.personId, input.dossier, input.consumedEvidenceLocators);
                    return jsonResult({ status: "ok", dossier });
                }
                catch (error) {
                    if (error instanceof Error && error.message.startsWith("person not found:")) {
                        return jsonResult({ status: "not_found" });
                    }
                    throw error;
                }
            }
            if (input.action === "delete_dossier") {
                return jsonResult(store.deleteDossier(input.personId) ? { status: "ok" } : { status: "not_found" });
            }
            if (input.action === "set_company") {
                const company = store.setCompany(input.personId, {
                    name: input.companyName,
                    primaryDomain: input.primaryDomain,
                });
                const person = store.getPerson(input.personId);
                return jsonResult(company && person ? { status: "ok", company, person } : { status: "not_found" });
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
function createSyncTool(stores, reader, ctx) {
    const active = context(ctx);
    if (!active)
        return null;
    return {
        name: "memory_people_sync",
        label: "Sync Slack People",
        description: "Manually enrich this agent's people store from one OpenClaw-authenticated Slack directory account.",
        parameters: syncParameters,
        async execute(_toolCallId, raw) {
            const input = Value.Parse(syncParameters, raw);
            try {
                return jsonResult(await syncSlackDirectory({
                    store: stores.get(active.agentId),
                    reader,
                    accountId: input.accountId.trim(),
                    limit: input.limit ?? 200,
                }));
            }
            catch (error) {
                return jsonResult({
                    status: "unavailable",
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        },
    };
}
export function registerPeopleTools(api, stores, config, directoryReader) {
    api.registerTool((ctx) => createInspectTool(stores, config, ctx), {
        names: ["memory_people_inspect"],
    });
    api.registerTool((ctx) => createUpdateTool(stores, ctx), {
        names: ["memory_people_update"],
    });
    api.registerTool((ctx) => createSyncTool(stores, directoryReader ??
        createOpenClawSlackDirectory({
            getConfig: () => ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config,
        }), ctx), {
        names: ["memory_people_sync"],
        optional: true,
    });
}
