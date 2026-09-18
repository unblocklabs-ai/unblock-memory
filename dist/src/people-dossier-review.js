import { resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import { abortable } from "./abortable.js";
import { resolveTypeSafeApiKey } from "./typesafe.js";
/** Review the injected blurb using only exact indexed references already on its claims. */
export async function reviewPersonDossier(params) {
    const unavailable = (reason) => ({ status: "unavailable", needsReview: true, reason });
    const { config, runtime, active, person, dossier } = params;
    if (!config.peoplePrimer.enabled || !config.typesafe.enabled) {
        return unavailable("TypeSafe background review is disabled; verify manually before saving");
    }
    const citations = new Map();
    for (const section of dossier.sections)
        for (const claim of section.claims)
            for (const ref of claim.evidence) {
                const match = /^(qmd:\/\/[^#]+)#L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(ref.locator);
                if (!match)
                    return unavailable("Evidence needs exact qmd://path#Lstart-Lend references or explicit manual verification");
                const from = Number(match[2]), end = Number(match[3] ?? match[2]);
                if (!Number.isSafeInteger(from) || !Number.isSafeInteger(end) || end < from || end - from >= 120) {
                    return unavailable("Evidence ranges must contain 1–120 lines");
                }
                const citation = { path: match[1], from, lines: end - from + 1 };
                citations.set(JSON.stringify(citation), citation);
            }
    if (!citations.size || citations.size > 3)
        return unavailable("Choose 1–3 distinct indexed evidence ranges or verify manually");
    const deadline = AbortSignal.timeout(120_000);
    const signal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline;
    try {
        signal.throwIfAborted();
        const apiKey = await abortable(resolveTypeSafeApiKey(config.typesafe), signal);
        if (!apiKey)
            return unavailable("TypeSafe API key not configured; verify manually before saving");
        const { manager } = await abortable(runtime.getMemorySearchManager(active), signal);
        if (!manager)
            return unavailable("Memory index unavailable; verify manually before saving");
        return await abortable(manager.reviewClaim({
            claim: dossier.blurb, citations: [...citations.values()],
            personBackground: { name: person.preferredName ?? person.displayName,
                agentName: resolveAgentIdentity(active.cfg, active.agentId)?.name?.trim() || params.agentName?.trim() || "the assistant" },
            corpora: config.peoplePrimer.corpora, apiKey, timeoutMs: config.peoplePrimer.timeoutMs, signal,
        }), signal);
    }
    catch {
        return unavailable("Background review failed or was cancelled; no dossier written");
    }
}
