import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { renderPeopleWhisper } from "./people-hooks.js";
import { DossierConflictError, PERSON_DOSSIER_SCHEMA } from "./people-store.js";
import { getContext } from "./tool-context.js";
import { reviewPersonDossier } from "./people-dossier-review.js";
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
        view: Type.Literal("people"),
        limit: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: 100,
            description: "Maximum active people to return.",
        })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "People to skip." })),
    }, { additionalProperties: false }),
    Type.Object({
        view: Type.Literal("dossier_changes"),
        personId: nonEmpty,
        limit: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: 100,
            description: "Maximum dossier change summaries to return, newest first.",
        })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Changes to skip." })),
    }, { additionalProperties: false }),
    Type.Object({
        view: Type.Literal("dossier_change"),
        personId: nonEmpty,
        changeId: nonEmpty,
    }, { additionalProperties: false }),
    Type.Object({
        view: Type.Literal("todos"),
        limit: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: 100,
            description: "Maximum actionable todos to return.",
        })),
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
        dossier: PERSON_DOSSIER_SCHEMA,
        reason: Type.String({ pattern: "\\S", maxLength: 500 }),
        agentName: Type.Optional(Type.String({ pattern: "\\S", maxLength: 100 })),
        manualVerification: Type.Optional(Type.String({ pattern: "\\S", maxLength: 400,
            description: "Explicit attestation that you verified every blurb assertion and background-only eligibility. Explain the original sources and any correction/override. Skips TypeSafe; recorded as manual, never a provider pass. Do not use merely to bypass a failed check." })),
    }, { additionalProperties: false }),
    Type.Object({
        action: Type.Literal("delete_dossier"),
        personId: nonEmpty,
        reason: nonEmpty,
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
    return cfg && ctx.agentId ? { agentId: ctx.agentId } : undefined;
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
        description: "List active people, inspect one person, read dossier change history, or list actionable people todos.",
        parameters: inspectParameters,
        async execute(_toolCallId, raw) {
            const input = Value.Parse(inspectParameters, raw);
            if (input.view === "person") {
                return jsonResult(personView(stores, active.agentId, input, config.whisperer.maxChars));
            }
            const store = stores.get(active.agentId);
            if (input.view === "people") {
                const limit = input.limit ?? 50;
                const offset = input.offset ?? 0;
                const people = store.listActivePeople(limit, offset).map((person) => {
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
                    nextOffset: people.length === limit ? offset + people.length : null,
                });
            }
            if (input.view === "dossier_changes") {
                const limit = input.limit ?? 20;
                const offset = input.offset ?? 0;
                const changes = store.listDossierChanges(input.personId, limit, offset);
                return jsonResult({
                    status: "ok",
                    changes,
                    nextOffset: changes.length === limit ? offset + changes.length : null,
                });
            }
            if (input.view === "dossier_change") {
                const change = store.getDossierChange(input.personId, input.changeId);
                return jsonResult(change ? { status: "ok", change } : { status: "not_found" });
            }
            return jsonResult({
                status: "ok",
                todos: store.listTodos(input.limit ?? 20),
            });
        },
    };
}
function createUpdateTool(stores, config, runtime, ctx) {
    const active = getContext(ctx);
    if (!active)
        return null;
    return {
        name: "memory_people_update",
        label: "Update People Memory",
        description: "Replace a background-only dossier (blurb <=70 words, role/relationship sections, observed/reported facts). Automatically reviews the blurb against claim evidence qmd://path#Lstart-Lend before saving; blocked/unavailable reviews leave it unchanged. Use explicit manualVerification only after verifying original sources yourself. Also deletes dossiers or updates injection, company, todo and person status.",
        parameters: updateParameters,
        async execute(_toolCallId, raw, signal) {
            const input = Value.Parse(updateParameters, raw);
            const store = stores.get(active.agentId);
            if (input.action === "set_injection") {
                const person = store.setInjection(input.personId, input.enabled);
                return jsonResult(person ? { status: "ok", person } : { status: "not_found" });
            }
            if (input.action === "replace_dossier") {
                const person = store.getPerson(input.personId);
                if (!person || person.status !== "active")
                    return jsonResult({ status: "not_found" });
                const proposed = store.validateDossier(input.dossier);
                const revision = store.getDossierRevision(input.personId);
                if (signal?.aborted)
                    return jsonResult({ status: "review_unavailable", needsReview: true, reason: "Cancelled; no dossier written" });
                const review = input.manualVerification
                    ? { status: "manual", needsReview: false, note: input.manualVerification }
                    : await reviewPersonDossier({ config, runtime, active, person, dossier: proposed, agentName: input.agentName, signal });
                if (review.needsReview || signal?.aborted) {
                    return jsonResult({ status: review.status === "ok" && !signal?.aborted ? "needs_review" : "review_unavailable",
                        needsReview: true, saved: false, review });
                }
                const audit = review.status === "manual"
                    ? `Manual verification: ${review.note}`
                    : "TypeSafe background review passed (person-background-v2)";
                try {
                    const dossier = store.replaceDossier(input.personId, `${input.reason}\n${audit}`, proposed, revision);
                    return jsonResult({ status: "ok", saved: true, verification: review.status === "manual" ? "manual" : "typesafe", dossier, review });
                }
                catch (error) {
                    if (error instanceof DossierConflictError)
                        return jsonResult({ status: "conflict", saved: false, reason: error.message });
                    if (error instanceof Error && error.message.startsWith("person not found:")) {
                        return jsonResult({ status: "not_found" });
                    }
                    throw error;
                }
            }
            if (input.action === "delete_dossier") {
                return jsonResult(store.deleteDossier(input.personId, input.reason)
                    ? { status: "ok" }
                    : { status: "not_found" });
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
export function registerPeopleTools(api, stores, config, runtime, directoryReader) {
    api.registerTool((ctx) => createInspectTool(stores, config.people, ctx), {
        names: ["memory_people_inspect"],
    });
    api.registerTool((ctx) => createUpdateTool(stores, config, runtime, ctx), {
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
