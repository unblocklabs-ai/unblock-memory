import type { PersonDossier } from "./people-store.js";

/** Keep identity brief; interaction preferences are stored separately with evidence. */
export const PEOPLE_BACKGROUND_MAX_WORDS = 70;

export function backgroundWordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

export function renderPeopleDossier(dossier: PersonDossier, now = Date.now()): string {
  const preferences = dossier.sections.flatMap(section =>
    ["preferences", "workingStyle"].includes(section.category)
      ? section.claims.filter(claim => claim.scope && claim.reviewedAt && Number.isFinite(Date.parse(claim.reviewedAt)) && Date.parse(claim.reviewedAt) <= now &&
        (claim.epistemicType === "observed" || claim.epistemicType === "reported" ||
          (claim.epistemicType === "agent_assessment" && claim.expiresAt && Date.parse(claim.expiresAt) - Date.parse(claim.reviewedAt) <= 30 * 86400_000)) &&
        (!claim.expiresAt || Date.parse(claim.expiresAt) > now)).map(claim =>
        `- ${claim.epistemicType === "agent_assessment" ? "Provisional agent lesson: " : ""}${claim.statement}${claim.scope ? ` [Scope: ${claim.scope}]` : ""}`)
      : []);
  return [dossier.blurb.trim(), ...(preferences.length ? ["Interaction preferences and lessons:\n" + preferences.join("\n")] : [])].join("\n\n");
}
