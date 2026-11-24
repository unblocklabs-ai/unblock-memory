import type { PersonDossier } from "./people-store.js";
/** Keep identity brief; interaction preferences are stored separately with evidence. */
export declare const PEOPLE_BACKGROUND_MAX_WORDS = 70;
export declare const INTERACTION_DOSSIER_CATEGORIES: readonly ["preferences", "workingStyle"];
export declare const AGENT_LESSON_MAX_TTL_MS: number;
export declare function isInteractionCategory(category: string): category is (typeof INTERACTION_DOSSIER_CATEGORIES)[number];
export declare function isRenderableInteractionClaim(claim: PersonDossier["sections"][number]["claims"][number], now?: number): boolean;
export declare function backgroundWordCount(text: string): number;
export declare function renderPeopleDossier(dossier: PersonDossier, now?: number): string;
