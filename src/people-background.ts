import { DEFAULTS } from "./defaults.js";
import type { PersonDossier } from "./people-store.js";

/** Keep identity brief; interaction preferences are stored separately with evidence. */
export const PEOPLE_BACKGROUND_MAX_WORDS = DEFAULTS.people.backgroundMaxWords;

export const INTERACTION_DOSSIER_CATEGORIES = ["preferences", "workingStyle"] as const;

export const AGENT_LESSON_MAX_TTL_MS = 30 * 86400_000;

export function isInteractionCategory(
  category: string,
): category is (typeof INTERACTION_DOSSIER_CATEGORIES)[number] {
  return (INTERACTION_DOSSIER_CATEGORIES as readonly string[]).includes(category);
}

export function isRenderableInteractionClaim(
  claim: PersonDossier["sections"][number]["claims"][number],
  now = Date.now(),
): boolean {
  if (!claim.scope || !claim.reviewedAt) return false;
  const reviewedAtMs = Date.parse(claim.reviewedAt);
  if (!Number.isFinite(reviewedAtMs) || reviewedAtMs > now) return false;
  const expiresAtMs = claim.expiresAt ? Date.parse(claim.expiresAt) : undefined;
  if (expiresAtMs !== undefined && (!Number.isFinite(expiresAtMs) || expiresAtMs <= now)) {
    return false;
  }
  if (claim.epistemicType === "observed" || claim.epistemicType === "reported") return true;
  if (claim.epistemicType !== "agent_assessment") return false;
  return expiresAtMs !== undefined && expiresAtMs - reviewedAtMs <= AGENT_LESSON_MAX_TTL_MS;
}

export function backgroundWordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

export function renderPeopleDossier(dossier: PersonDossier, now = Date.now()): string {
  const preferences = dossier.sections.flatMap((section) =>
    isInteractionCategory(section.category)
      ? section.claims
          .filter((claim) => isRenderableInteractionClaim(claim, now))
          .map(
            (claim) =>
              `- ${claim.epistemicType === "agent_assessment" ? "Provisional agent lesson: " : ""}${claim.statement} [Scope: ${claim.scope}]`,
          )
      : [],
  );
  return [
    dossier.blurb.trim(),
    ...(preferences.length ? ["Interaction preferences and lessons:\n" + preferences.join("\n")] : []),
  ].join("\n\n");
}
