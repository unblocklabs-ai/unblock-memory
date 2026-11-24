import { resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import { abortable } from "./abortable.js";
import type { UnblockMemoryConfig } from "./config.js";
import type { EvidenceCitation } from "./evidence-review.js";
import { isInteractionCategory } from "./people-background.js";
import type { Person, PersonDossier } from "./people-store.js";
import type { QmdMemoryRuntime } from "./runtime.js";
import type { getContext } from "./tool-context.js";
import { resolveTypeSafeApiKey } from "./typesafe-client.js";

/** Review every saved assertion against its own evidence, including interaction lessons. */
export async function reviewPersonDossier(params: {
  config: UnblockMemoryConfig;
  runtime: QmdMemoryRuntime;
  active: NonNullable<ReturnType<typeof getContext>>;
  person: Person;
  dossier: PersonDossier;
  agentName?: string;
  signal?: AbortSignal;
}) {
  const unavailable = (reason: string) => ({ status: "unavailable" as const, needsReview: true, reason });
  const { config, runtime, active, person, dossier } = params;
  if (!config.peoplePrimer.enabled || !config.typesafe.enabled) {
    return unavailable("TypeSafe background review is disabled; verify manually before saving");
  }
  const checks = [
    { statement: dossier.blurb, kind: undefined, inferred: false,
      evidence: dossier.sections.filter(s => s.category === "role" || s.category === "relationship").flatMap(s => s.claims.flatMap(c => c.evidence)) },
    ...dossier.sections.flatMap(section => section.claims.map(claim => ({
      statement: claim.statement + (claim.scope ? ` [Scope: ${claim.scope}]` : ""),
      kind: isInteractionCategory(section.category) ? "interaction" as const : undefined,
      inferred: claim.epistemicType === "agent_assessment", evidence: claim.evidence,
    }))),
  ];
  const reviews = new Map<string, { statement: string; kind?: "interaction"; inferred: boolean; citations: EvidenceCitation[] }>();
  for (const check of checks) {
    const citations = new Map<string, EvidenceCitation>();
    for (const ref of check.evidence) {
      const match = /^(qmd:\/\/[^#]+)#L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(ref.locator);
      if (!match) return unavailable("Every assertion needs exact qmd://path#Lstart-Lend evidence or explicit manual verification");
      const from = Number(match[2]), end = Number(match[3] ?? match[2]);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(end) || end < from || end - from >= 120) return unavailable("Evidence ranges must contain 1–120 lines");
      const citation = { path: match[1]!, from, lines: end - from + 1 };
      citations.set(JSON.stringify(citation), citation);
    }
    if (!citations.size || citations.size > 3) return unavailable("Each assertion needs 1–3 distinct indexed evidence ranges or manual verification");
    const review = { statement: check.statement, kind: check.kind, inferred: check.inferred, citations: [...citations.values()] };
    reviews.set(JSON.stringify(review), review);
  }
  const deadline = AbortSignal.timeout(120_000);
  const signal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline;
  try {
    signal.throwIfAborted();
    const apiKey = await abortable(resolveTypeSafeApiKey(config.typesafe), signal);
    if (!apiKey) return unavailable("TypeSafe API key not configured; verify manually before saving");
    const { manager } = await abortable(runtime.getMemorySearchManager(active), signal);
    if (!manager) return unavailable("Memory index unavailable; verify manually before saving");
    const agentName = resolveAgentIdentity(active.cfg, active.agentId)?.name?.trim() || params.agentName?.trim() || "the assistant";
    for (const check of reviews.values()) {
      const review = await abortable(manager.reviewClaim({
        claim: check.statement, citations: check.citations,
        personBackground: { name: person.preferredName ?? person.displayName,
          agentName,
          ...(check.kind ? { kind: check.kind, inferred: check.inferred } : {}) },
        corpora: config.peoplePrimer.corpora, apiKey, endpoint: config.typesafe.endpoint, model: config.typesafe.model,
        timeoutMs: config.peoplePrimer.timeoutMs, signal,
      }), signal);
      if (review.status !== "ok" || review.needsReview) return review;
    }
    return { status: "ok" as const, needsReview: false, assertionsReviewed: reviews.size };
  } catch {
    return unavailable("Background review failed or was cancelled; no dossier written");
  }
}
