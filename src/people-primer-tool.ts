import { Type } from "typebox";
import { Value } from "typebox/value";
import { jsonResult, resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { UnblockMemoryConfig } from "./config.js";
import type { PeopleStores } from "./people-store.js";
import type { QmdMemoryRuntime } from "./runtime.js";
import { getContext } from "./tool-context.js";
import { resolveDecisionCredential } from "./decision-client.js";
import { primePersonDossier } from "./people-primer.js";
import { abortable } from "./abortable.js";
import { backgroundWordCount, PEOPLE_BACKGROUND_MAX_WORDS } from "./people-background.js";

const parameters = Type.Object({
  personId: Type.String({ pattern: "\\S", maxLength: 1000 }),
  agentName: Type.Optional(Type.String({ pattern: "\\S", maxLength: 100,
    description: "Your human-facing name, e.g. Bill, when no agent identity name is configured. Never a person's name guessed from search results." })),
  draft: Type.Optional(Type.Object({
    blurb: Type.String({ pattern: "\\S", maxLength: 1200, description: "Final background-only snippet, at most 70 words. Supplying a draft reviews it instead of running searches." }),
    citations: Type.Array(Type.Object({
      path: Type.String({ pattern: "^qmd://", maxLength: 2000 }),
      from: Type.Integer({ minimum: 1 }), lines: Type.Integer({ minimum: 1, maximum: 120 }),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export function registerPeoplePrimerTool(api: OpenClawPluginApi, runtime: QmdMemoryRuntime, stores: PeopleStores, config: UnblockMemoryConfig) {
  const running = new Set<string>();
  api.registerTool(ctx => {
    const active = getContext(ctx);
    if (!active) return null;
    return {
      name: "memory_people_prime", label: "Prime Person Dossier",
      description: "Prepare evidence about identity, organization, agent relationship, explicit interaction preferences and working-style feedback, including newer corrections. Supply draft to review only an identity blurb <=70 words. Dossier writes review all preference claims separately. Requires peoplePrimer and approved corpora; never writes dossiers.",
      parameters,
      async execute(_id: string, params: unknown, signal?: AbortSignal) {
        const { personId, agentName: suppliedName, draft } = Value.Parse(parameters, params);
        if (!config.people.enabled || !config.peoplePrimer.enabled || !config.decisionModel.enabled) return jsonResult({ status: "disabled" });
        if (draft && backgroundWordCount(draft.blurb) > PEOPLE_BACKGROUND_MAX_WORDS) {
          return jsonResult({ status: "invalid", needsReview: true, reason: "Background snippet must not exceed 70 words" });
        }
        const key = JSON.stringify([active.agentId, personId]);
        if (running.has(key)) return jsonResult({ status: "busy" });
        running.add(key);
        const deadline = AbortSignal.timeout(120_000);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        try {
          combined.throwIfAborted();
          const apiKey = await abortable(resolveDecisionCredential(config.decisionModel), combined);
          if (!apiKey) return jsonResult({ status: "unavailable", reason: "Decision model API key not configured" });
          const store = stores.get(active.agentId);
          const person = store.getPerson(personId);
          if (!person || person.status !== "active") return jsonResult({ status: "not_found" });
          const identities = store.listIdentities(personId);
          if (identities.length && identities.every(i => i.isBot === true || i.isDeactivated)) return jsonResult({ status: "unavailable", reason: "No active human identity" });
          const { manager } = await abortable(runtime.getMemorySearchManager(active), combined);
          if (!manager) return jsonResult({ status: "unavailable", reason: "Memory unavailable" });
          const agentName = resolveAgentIdentity(active.cfg, active.agentId)?.name?.trim() || suppliedName?.trim() || "the assistant";
          if (draft) return jsonResult(await manager.reviewClaim({ claim: draft.blurb, citations: draft.citations,
            personBackground: { name: person.preferredName ?? person.displayName, agentName },
            corpora: config.peoplePrimer.corpora, apiKey, endpoint: config.decisionModel.endpoint, model: config.decisionModel.model,
            timeoutMs: config.peoplePrimer.timeoutMs, signal: combined }));
          return jsonResult(await primePersonDossier({ personId, agentName, store, config: config.peoplePrimer, apiKey,
            endpoint: config.decisionModel.endpoint, model: config.decisionModel.model, signal: combined,
            search: (query, options) => manager.search(query, { ...options, requestContext: active.requestContext }) }));
        } catch {
          return jsonResult({ status: "unavailable", needsReview: true, reason: "Primer failed or was cancelled; no dossier written" });
        } finally { running.delete(key); }
      },
    };
  }, { names: ["memory_people_prime"] });
}
